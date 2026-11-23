<?php
declare(strict_types=1);

/* Persist discovered CDRs for retries and durable notification deduplication. */
function monitorQueueKey(string $domain, string $cdrId): string { return hash('sha256', $domain . "\0" . $cdrId); }
function monitorQueueDirectory(string $domain, string $kind): string {
    if (!in_array($kind, ['pending', 'done'], true)) throw new InvalidArgumentException('Invalid queue directory');
    $path = monitorDirectory() . '/queue/' . monitorDomainId($domain) . '/' . $kind;
    if (!is_dir($path) && !@mkdir($path, 0700, true) && !is_dir($path)) throw new RuntimeException('Cannot create queue directory');
    return $path;
}
function monitorQueueFile(string $domain, string $cdrId): string {
    return monitorQueueDirectory($domain, 'pending') . '/' . monitorQueueKey($domain, $cdrId) . '.json';
}
function monitorQueueDoneFile(string $domain, string $cdrId): string {
    return monitorQueueDirectory($domain, 'done') . '/' . monitorQueueKey($domain, $cdrId) . '.json';
}
function monitorQueueLock(string $domain, string $cdrId): string {
    return 'queue-' . monitorDomainId($domain) . '-' . substr(monitorQueueKey($domain, $cdrId), 0, 2);
}
/** Persist only calls discovered from a completed, authenticated PBX CDR. */
function monitorQueueCdr(string $domain, string $id, int $start, int $release, array $state): void {
    if (trim($id) === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id)
        || $start <= 0 || $release < $start || $release > time() + 300) throw new InvalidArgumentException('Invalid CDR.');
    if ($release < (int)($state['since'] ?? PHP_INT_MAX)) return;
    if (is_file(monitorQueueFile($domain, $id)) || is_file(monitorQueueDoneFile($domain, $id))) return;
    monitorLocked(monitorQueueLock($domain, $id), static function () use ($domain, $id, $start, $release, $state): void {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($state['generation'] ?? null)) return;
        $file = monitorQueueFile($domain, $id);
        if (is_file($file) || is_file(monitorQueueDoneFile($domain, $id))) return;
        monitorWriteFile($file, ['domain' => $domain, 'id' => $id, 'start' => $start, 'ended' => $release,
            'generation' => $state['generation'], 'status' => 'pending', 'attempts' => 0, 'next' => $release + 300]);
    });
}
function monitorQueueDue(string $domain, array $state): array {
    $groups = [];
    foreach (glob(monitorQueueDirectory($domain, 'pending') . '/*.json') ?: [] as $path) {
        $item = monitorReadFile($path);
        if (($item['status'] ?? '') !== 'pending') continue;
        if (($item['generation'] ?? null) !== ($state['generation'] ?? null) || is_file(monitorQueueDoneFile($domain, (string)$item['id']))) {
            monitorQueueFinish($domain, $item, 'cancelled'); continue;
        }
        if ((int)($item['next'] ?? 0) > time()) continue;
        $bucket = intdiv((int)$item['start'], 300) * 300;
        $groups[$bucket][(string)$item['id']] = $item;
    }
    ksort($groups, SORT_NUMERIC);
    return $groups;
}
function monitorQueueFinish(string $domain, array $item, string $status, string $pendingReason = ''): void {
    monitorLocked(monitorQueueLock($domain, $item['id']), static function () use ($domain, $item, $status, $pendingReason): void {
        $file = monitorQueueFile($domain, $item['id']);
        $current = monitorReadFile($file);
        if (($current['status'] ?? '') !== 'pending' || ($current['generation'] ?? null) !== $item['generation']) return;
        if ($status === 'pending') {
            $attempt = (int)($current['attempts'] ?? 0) + 1;
            $current['attempts'] = $attempt;
            if (in_array($pendingReason, ['jobId', 'server', 'callId', 'month', 'processing', 'partial', 'topics', 'lookup', 'cdr', 'time'], true)) $current['lastReason'] = $pendingReason;
            else unset($current['lastReason']);
            $current['next'] = time() + ($attempt === 1 ? 300 : ($attempt === 2 ? 600 : 1800));
            monitorWriteFile($file, $current);
        } else {
            $current['status'] = $status; $current['finished'] = time();
            $done = monitorQueueDoneFile($domain, $item['id']);
            if (!is_file($done)) monitorWriteFile($done, $current);
            if (is_file($file) && !unlink($file)) throw new RuntimeException('Cannot finish queued event');
        }
    });
}

/** A discovery defect is recorded only when we can identify it without guessing
 * a CDR association. A missing end time may be an active call, not a defect yet. */
function monitorDiscoveryReview(string $domain, array $call, array $state, int $now): bool {
    $start = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
    $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
    $startTime = $start ? $start->getTimestamp() : 0;
    $endTime = $end ? $end->getTimestamp() : 0;
    $since = (int)$state['since'];
    // A known pre-activation completion is out of scope. Missing completion
    // dates are flagged as unknown, never used to send an automatic alert.
    if ($endTime > 0 && ($endTime < $since || $endTime > $now)) return false;
    if ($endTime <= 0 && $startTime > 0 && $startTime > $now - 86400) return false;
    $id = is_string($call['id'] ?? null) ? trim($call['id']) : '';
    $valid = static fn(string $v): bool => $v !== '' && strlen($v) <= 512 && !preg_match('/[\x00-\x1f\x7f]/', $v);
    $cdrId = $valid($id) ? $id : '';
    $field = 'id'; $reference = $cdrId;
    if ($reference === '') {
        foreach (['call-id', 'call-orig-call-id', 'call-term-call-id'] as $candidate) {
            $value = is_string($call[$candidate] ?? null) ? trim($call[$candidate]) : '';
            if ($valid($value)) { $field = $candidate; $reference = $value; break; }
        }
    }
    if ($reference === '' || ($cdrId === '' && $startTime <= 0 && $endTime <= 0)) return false;
    // A fallback call ID is never treated as a CDR ID; it may be shared by legs.
    $identity = $cdrId !== '' ? 'cdr|' . $cdrId : $field . '|' . $reference . '|' . $startTime . '|' . $endTime;
    $hash = hash('sha256', 'discovery|' . $identity);
    $name = 'review-' . monitorDomainId($domain) . '-' . $hash;
    $reason = $cdrId === '' ? 'The PBX CDR has no usable CDR ID.' : 'The PBX CDR has missing or inconsistent call timestamps.';
    $reason .= ' Automatic checking could not safely identify or schedule this call; investigate the PBX record.';
    if ($endTime <= 0) $reason .= ' Completion time is unknown; eligibility after enablement cannot be confirmed.';
    return monitorLocked('reviews-' . monitorDomainId($domain) . '-' . substr($hash, 0, 2), static function () use ($domain, $state, $name, $reference, $cdrId, $startTime, $reason): bool {
        $live = monitorState($domain);
        if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null)) return false;
        $file = monitorDirectory() . '/' . $name . '.json';
        if (is_file($file)) return true;
        monitorWriteFile($file, ['status' => 'review', 'time' => time(), 'callid' => $reference, 'cdrId' => $cdrId,
            'startedAt' => $startTime > 0 ? gmdate('c', $startTime) : '', 'reason' => $reason]);
        return true;
    });
}

/** Complete one bounded CDR window. Returned rows from an incomplete page are
 * still queued, but the checkpoint must not advance until the whole window is complete. */
function monitorDiscoverWindow(PbxClient $client, string $domain, array $state, int $from, int $to, int $now, array &$counts): bool {
    $scan = $client->fetchCdrs($domain, gmdate('Y-m-d\\TH:i:s\\Z', $from), gmdate('Y-m-d\\TH:i:s\\Z', $to), 0, [], null, 1);
    $live = monitorState($domain);
    if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null)) return false;
    foreach ($scan['records'] as $call) {
        if (!is_array($call) || (isset($call['domain']) && (string)$call['domain'] !== $domain)) continue;
        $id = $call['id'] ?? null;
        $start = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
        $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
        if (!is_string($id) || trim($id) === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id) || !$start || !$end
            || $start->getTimestamp() <= 0 || $end->getTimestamp() < $start->getTimestamp()) {
            $counts['missingTime']++;
            if (!$end && $start && monitorRememberOpenCdr($domain, $call, $state, $now)) continue;
            if (!monitorDiscoveryReview($domain, $call, $state, $now)) $counts['unidentified']++;
            continue;
        }
        if ($end->getTimestamp() > $now) continue;
        // A known completion before enablement also resolves a previously
        // observed open CDR, but must never be queued for an alert.
        monitorResolveOpenCdr($domain, $id, $start->getTimestamp(), $state);
        if ($end->getTimestamp() < (int)$state['since']) continue;
        monitorQueueCdr($domain, $id, $start->getTimestamp(), $end->getTimestamp(), $state);
    }
    return !empty($scan['complete']);
}

/** Remember identifiable unfinished CDRs so they do not silently disappear when
 * their start leaves the 24-hour overlap. Only store non-sensitive references. */
function monitorRememberOpenCdr(string $domain, array $call, array $state, int $now): bool {
    $start = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
    if (!$start || $start->getTimestamp() <= 0 || $start->getTimestamp() > $now) return false;
    $id = is_string($call['id'] ?? null) ? trim($call['id']) : '';
    $valid = static fn(string $v): bool => $v !== '' && strlen($v) <= 512 && !preg_match('/[\x00-\x1f\x7f]/', $v);
    $field = $valid($id) ? 'id' : '';
    if ($field === '') foreach (['call-id', 'call-orig-call-id', 'call-term-call-id'] as $candidate) {
        $id = is_string($call[$candidate] ?? null) ? trim($call[$candidate]) : '';
        if ($valid($id)) { $field = $candidate; break; }
    }
    if ($field === '') return false;
    $key = hash('sha256', $field . '|' . $id . '|' . $start->getTimestamp());
    $prefix = 'open-' . monitorDomainId($domain) . '-' . $key;
    monitorLocked('open-' . monitorDomainId($domain) . '-' . substr($key, 0, 2), static function () use ($domain, $state, $prefix, $field, $id, $start): void {
        $live = monitorState($domain);
        if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null)) return;
        $file = monitorDirectory() . '/' . $prefix . '.json';
        if (!is_file($file) || (monitorReadFile($file)['generation'] ?? null) !== $state['generation']) monitorWriteFile($file, ['generation' => $state['generation'], 'field' => $field, 'reference' => $id, 'start' => $start->getTimestamp(), 'status' => 'pending']);
    });
    return true;
}
/** A completed CDR with a real CDR ID resolves its own earlier open record. */
function monitorResolveOpenCdr(string $domain, string $id, int $start, array $state): void {
    $key = hash('sha256', 'id|' . $id . '|' . $start);
    $file = monitorDirectory() . '/open-' . monitorDomainId($domain) . '-' . $key . '.json';
    if (!is_file($file)) return;
    monitorLocked('open-' . monitorDomainId($domain) . '-' . substr($key, 0, 2), static function () use ($file, $domain, $state): void {
        $live = monitorState($domain);
        if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null)) return;
        if (is_file($file) && !unlink($file)) throw new RuntimeException('Cannot resolve incomplete CDR');
    });
}
function monitorReviewOpenCdrs(string $domain, array $state, int $now): void {
    foreach (glob(monitorDirectory() . '/open-' . monitorDomainId($domain) . '-*.json') ?: [] as $path) {
        $item = monitorReadFile($path);
        if (($item['generation'] ?? null) !== ($state['generation'] ?? null) || ($item['status'] ?? '') !== 'pending' || (int)($item['start'] ?? 0) > $now - 86400) continue;
        $field = (string)($item['field'] ?? ''); $reference = (string)($item['reference'] ?? '');
        if (!in_array($field, ['id', 'call-id', 'call-orig-call-id', 'call-term-call-id'], true)) continue;
        $call = [$field => $reference, 'call-start-datetime' => gmdate('c', (int)$item['start'])];
        if (monitorDiscoveryReview($domain, $call, $state, $now)) {
            // Keep a tombstone so repeated discovery does not recreate this review.
            $item['status'] = 'review'; monitorWriteFile($path, $item);
        }
    }
}
