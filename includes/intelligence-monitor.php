<?php
declare(strict_types=1);
require_once __DIR__ . '/intelligence-recording-links.php';

/* Scheduled intelligence alerts. All persistent files are server-only and
 * keyed by domain; the task and web requests share CACHE_DIR and file locks. */
function monitorDirectory(): string {
    $dir = CACHE_DIR . '/intelligence-monitor';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Cannot create monitor directory');
    return $dir;
}
function monitorDomainId(string $domain): string { return hash('sha256', $domain); }
function monitorStateFile(string $domain): string { return monitorDirectory() . '/domain-' . monitorDomainId($domain) . '.json'; }
function monitorReadFile(string $path): array {
    if (!is_file($path)) return [];
    $data = json_decode((string)file_get_contents($path), true);
    if (!is_array($data)) throw new RuntimeException('Cannot read monitor state');
    return $data;
}
function monitorWriteFile(string $path, array $data): void {
    $temp = tempnam(monitorDirectory(), 'tmp-');
    if ($temp === false) throw new RuntimeException('Cannot prepare monitor state');
    try {
        if (file_put_contents($temp, json_encode($data, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE), LOCK_EX) === false || !rename($temp, $path)) throw new RuntimeException('Cannot write monitor state');
        @chmod($path, 0600);
    } finally { if (is_file($temp)) @unlink($temp); }
}
function monitorLocked(string $name, callable $callback): mixed {
    $lock = fopen(monitorDirectory() . '/' . $name . '.lock', 'c');
    if (!$lock) throw new RuntimeException('Cannot open monitor lock');
    try {
        if (!flock($lock, LOCK_EX)) throw new RuntimeException('Cannot lock monitor state');
        return $callback();
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
function monitorState(string $domain): array {
    return monitorLocked('domain-' . monitorDomainId($domain), static function () use ($domain): array {
        $state = monitorReadFile(monitorStateFile($domain));
        return $state ?: ['domain' => $domain, 'enabled' => false];
    });
}
function monitorUpdate(string $domain, callable $change): array {
    return monitorLocked('domain-' . monitorDomainId($domain), static function () use ($domain, $change): array {
        $file = monitorStateFile($domain);
        $state = monitorReadFile($file) ?: ['domain' => $domain, 'enabled' => false];
        $state = $change($state);
        monitorWriteFile($file, $state);
        return $state;
    });
}
/** A domain's saved list. Invalid or absent lists fail closed, never globally. */
function monitorRecipients(array $state): array {
    $values = $state['recipients'] ?? [];
    if (!is_array($values) || count($values) > 10) return [];
    $out = [];
    foreach ($values as $value) {
        if (!is_string($value) || strlen($value) > 254 || preg_match('/[\x00-\x1f\x7f]/', $value) || !filter_var($value, FILTER_VALIDATE_EMAIL)) return [];
        $out[strtolower($value)] = $value;
    }
    return array_values($out);
}
function monitorSaveRecipients(string $domain, string $input): array {
    if (strlen($input) > 3000 || preg_match('/[\x00-\x1f\x7f]/', $input)) throw new InvalidArgumentException('Enter valid email addresses separated by semicolons.');
    $values = [];
    foreach (explode(';', $input) as $part) {
        $address = trim($part);
        if ($address === '') continue;
        if (strlen($address) > 254 || !filter_var($address, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Enter valid email addresses separated by semicolons.');
        $values[strtolower($address)] = $address;
    }
    if (count($values) > 10) throw new InvalidArgumentException('Enter at most 10 email addresses.');
    return monitorUpdate($domain, static function (array $state) use ($values): array {
        $state['recipients'] = array_values($values);
        return $state;
    });
}
/** Server-configured discovery window. Invalid configuration fails closed. */
function monitorLookbackMinutes(): ?int {
    $value = defined('INTELLIGENCE_CDR_LOOKBACK_MINUTES') ? INTELLIGENCE_CDR_LOOKBACK_MINUTES : 10;
    if (!(is_int($value) || (is_string($value) && ctype_digit($value)))) return null;
    $value = (int)$value;
    return $value >= 1 && $value <= 1440 ? $value : null;
}
function monitorServiceReady(): bool {
    if (!defined('INTELLIGENCE_MONITOR_API_KEY') || !is_string(INTELLIGENCE_MONITOR_API_KEY) || trim(INTELLIGENCE_MONITOR_API_KEY) === '') return false;
    $configured = false;
    foreach (PBX_SERVERS as $base) {
        if (!is_string($base) || trim($base) === '') continue;
        $parts = parse_url($base);
        if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) return false;
        $configured = true;
    }
    return $configured;
}
function monitorReady(): bool {
    return intelligenceSmtpConfigured() && monitorServiceReady() && monitorLookbackMinutes() !== null;
}
function monitorSetEnabled(string $domain, bool $enabled): array {
    if ($enabled && !monitorReady()) throw new InvalidArgumentException('Configure SMTP, PBX key, HTTPS PBX servers and a valid CDR lookback first.');
    if ($enabled && intelligenceWatches($domain) === []) throw new InvalidArgumentException('Save at least one watched phrase before enabling alerts.');
    return monitorUpdate($domain, static function (array $state) use ($domain, $enabled): array {
        if ($enabled && monitorRecipients($state) === []) throw new InvalidArgumentException('Save at least one alert recipient for this domain before enabling alerts.');
        if ($enabled && (empty($state['enabled']) || empty($state['generation']))) {
            $state['since'] = time(); $state['generation'] = bin2hex(random_bytes(16)); $state['lastRun'] = null;
            $state['discoveryCursor'] = max(0, $state['since'] - 86400);
        }
        // Existing PBX subscriptions are deliberately left for manual removal.
        unset($state['subscriptionPending'], $state['activationToken']);
        $state['enabled'] = $enabled; $state['domain'] = $domain; return $state;
    });
}
/** Latest SMTP acceptance recorded for a CDR. Absence is not proof of no email. */
function monitorEmailStatus(string $domain, string $id): ?array {
    if ($id === '') return null;
    $key = hash('sha256', $domain . "\0" . $id);
    $data = monitorReadFile(monitorDirectory() . '/mail-' . monitorDomainId($domain) . '-' . $key . '.json');
    return $data ?: null;
}
function monitorRecordEmail(string $domain, string $id, array $recipients, string $kind, ?int $when = null): void {
    if ($id === '') return;
    $key = hash('sha256', $domain . "\0" . $id);
    monitorLocked('mail-' . monitorDomainId($domain) . '-' . substr($key, 0, 2), static function () use ($domain, $key, $recipients, $kind, $when): void {
        $file = monitorDirectory() . '/mail-' . monitorDomainId($domain) . '-' . $key . '.json';
        $now = $when ?? time();
        $old = monitorReadFile($file);
        if ((int)($old['time'] ?? 0) > $now) return;
        monitorWriteFile($file, ['time' => $now, 'recipients' => array_values($recipients), 'kind' => $kind]);
    });
}
function monitorJobKey(array $ref): string { return hash('sha256', (string)$ref['id'] . '|' . (string)$ref['callid']); }
function monitorJob(string $domain, array $ref, callable $operation): mixed {
    $prefix = 'job-' . monitorDomainId($domain) . '-' . monitorJobKey($ref);
    $stripe = 'jobs-' . monitorDomainId($domain) . '-' . substr(monitorJobKey($ref), 0, 2);
    return monitorLocked($stripe, static function () use ($prefix, $operation): mixed {
        $file = monitorDirectory() . '/' . $prefix . '.json';
        $state = monitorReadFile($file);
        $result = $operation($state);
        if ($result !== null) monitorWriteFile($file, $result);
        return $result;
    });
}
function monitorMarkReport(string $domain, array $ref): void {
    $state = monitorState($domain);
    if (empty($state['enabled'])) return;
    $completed = parseEasternDateTime((string)($ref['completedAt'] ?? ''));
    if (!$completed || $completed->getTimestamp() < (int)($state['since'] ?? PHP_INT_MAX)) return;
    monitorJob($domain, $ref, static function (array $job) use ($domain, $state): ?array {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($state['generation'] ?? null)) return null;
        if ($job !== []) return null; // sending/sent/previously checked must never be reset
        return ['status' => 'report_checked', 'time' => time()];
    });
}
/** Review reasons are deliberately limited to non-sensitive diagnostic categories. */
function monitorPendingDescription(string $code): string {
    return match ($code) {
        'jobId' => 'The CDR did not contain a transcription job ID.',
        'server' => 'The CDR did not identify a usable PBX server.',
        'callId' => 'The CDR did not contain a usable transcription call ID.',
        'month' => 'The transcription lookup month could not be determined.',
        'processing' => 'The transcription was not finished when last checked.',
        'partial' => 'The transcription or summary was incomplete when last checked.',
        'topics' => 'The finished transcription did not contain any topics when last checked.',
        'lookup' => 'The transcription lookup failed or its identity could not be verified.',
        'cdr' => 'The CDR could not be found in the retry window.',
        'time' => 'The CDR completion time was missing or not valid when last checked.',
        default => 'The specific cause was not recorded.',
    };
}
function monitorSmtpErrorDescription(int $code): string {
    return match ($code) {
        6 => 'SMTP host name resolution failed.',
        7 => 'The SMTP connection failed.',
        28 => 'The SMTP operation timed out.',
        35 => 'SMTP TLS negotiation failed.',
        51, 60 => 'SMTP certificate verification failed.',
        67 => 'SMTP authentication was rejected.',
        55, 56 => 'The SMTP connection failed while sending or receiving.',
        default => '',
    };
}
function monitorExpiryReason(string $code): string {
    return 'No automatic email was sent: the call could not be fully checked within 24 hours. Last known issue: ' . monitorPendingDescription($code);
}
/** Store the call instant, not the time at which review was created. */
function monitorCallStartedAt(array $call): string {
    $start = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
    return $start ? gmdate('c', $start->getTimestamp()) : '';
}
/** Recover an older call date only from its own retained CDR queue record. */
function monitorQueueStartedAt(string $domain, string $cdrId): string {
    if ($cdrId === '') return '';
    $key = hash('sha256', $domain . "\0" . $cdrId);
    $dir = monitorDirectory() . '/queue/' . monitorDomainId($domain);
    foreach (['done', 'pending'] as $kind) {
        $record = monitorReadFile($dir . '/' . $kind . '/' . $key . '.json');
        if (($record['domain'] ?? null) === $domain && ($record['id'] ?? null) === $cdrId && (int)($record['start'] ?? 0) > 0) return gmdate('c', (int)$record['start']);
    }
    return '';
}
/** Reviews are retained until an operator handles them; no SMTP retry is automatic. */
function monitorReviewCdr(string $domain, array $call, string $reason): void {
    $display = (string)($call['id'] ?? $call['call-id'] ?? $call['call-orig-call-id'] ?? '');
    $identity = $display . '|' . (string)($call['call-start-datetime'] ?? '') . '|' . (string)($call['call-disconnect-datetime'] ?? '');
    $name = 'review-' . monitorDomainId($domain) . '-' . hash('sha256', $identity);
    monitorLocked('reviews-' . monitorDomainId($domain) . '-' . substr(hash('sha256', $identity), 0, 2), static function () use ($name, $display, $reason, $call): void {
        $file = monitorDirectory() . '/' . $name . '.json';
        if (!is_file($file)) monitorWriteFile($file, ['status' => 'review', 'time' => time(), 'callid' => substr($display, 0, 512), 'cdrId' => (string)($call['id'] ?? ''), 'startedAt' => monitorCallStartedAt($call), 'reason' => $reason]);
    });
}
/** Recover old expiry identity only when the retained queue record proves it. */
function monitorLegacyReviewCdrId(string $domain, string $name, string $display): string {
    if ($display === '' || !str_starts_with($name, 'review-')) return '';
    $domainId = monitorDomainId($domain);
    $path = monitorDirectory() . '/queue/' . $domainId . '/done/' . hash('sha256', $domain . "\0" . $display) . '.json';
    $queue = monitorReadFile($path);
    if (($queue['id'] ?? null) !== $display || ($queue['status'] ?? null) !== 'review' || (int)($queue['start'] ?? 0) <= 0) return '';
    $identity = $display . '|' . gmdate('c', (int)$queue['start']) . '|';
    return $name === 'review-' . $domainId . '-' . hash('sha256', $identity) ? $display : '';
}
/** Include historical records without inventing details that were not saved. */
function monitorReviewItems(string $domain): array {
    $id = monitorDomainId($domain); $items = [];
    $files = array_merge(glob(monitorDirectory() . '/job-' . $id . '-*.json') ?: [], glob(monitorDirectory() . '/review-' . $id . '-*.json') ?: []);
    sort($files, SORT_STRING);
    foreach ($files as $path) {
        $item = monitorReadFile($path);
        if (!in_array($item['status'] ?? '', ['review', 'sending'], true)) continue;
        $name = basename($path, '.json');
        $reason = (string)($item['reason'] ?? '');
        if (($item['status'] ?? '') === 'sending') $reason = 'Sending was interrupted or is still in progress. Delivery may have succeeded; verify with the recipient or SMTP logs before retrying.';
        elseif ($reason === 'SMTP delivery uncertain; verify before retrying') $reason = 'SMTP did not confirm acceptance. Delivery may have succeeded; verify with the recipient or SMTP logs before retrying. The original error detail was not recorded.';
        elseif ($reason === 'Intelligence or CDR unavailable within 24 hours' || $reason === 'Intelligence not ready within 24 hours') $reason = monitorExpiryReason('');
        elseif (str_starts_with($reason, 'Transcription reference unavailable after 24 hours (')) {
            $code = substr($reason, strlen('Transcription reference unavailable after 24 hours ('), -1);
            $reason = monitorExpiryReason($code);
        } elseif ($reason === 'Call completion time unavailable after 24 hours') $reason = monitorExpiryReason('time');
        if ($reason === '') $reason = 'The reason was not recorded. Verify delivery before retrying.';
        $display = (string)($item['callid'] ?? '');
        $cdrId = (string)($item['cdrId'] ?? '');
        if ($cdrId === '') $cdrId = monitorLegacyReviewCdrId($domain, $name, $display);
        $startedAt = is_string($item['startedAt'] ?? null) ? $item['startedAt'] : '';
        if ($startedAt === '') $startedAt = monitorQueueStartedAt($domain, $cdrId);
        $items[] = ['id' => $name, 'callid' => $display, 'cdrId' => $cdrId, 'startedAt' => $startedAt, 'time' => (int)($item['time'] ?? 0), 'reason' => $reason];
    }
    return $items;
}
function monitorReviews(string $domain, int $offset = 0): array {
    $all = monitorReviewItems($domain); $total = count($all);
    $offset = min(max(0, $offset), $total ? intdiv($total - 1, 50) * 50 : 0);
    return ['total' => $total, 'offset' => $offset, 'items' => array_slice($all, $offset, 50)];
}
/** Index by trusted CDR id or exact job hash, never by a possibly shared call id. */
function monitorReviewIndex(string $domain): array {
    $items = monitorReviewItems($domain);
    $index = ['cdr' => [], 'job' => [], 'all' => $items];
    foreach ($items as $item) {
        if ($item['cdrId'] !== '') $index['cdr'][$item['cdrId']][] = $item;
        if (str_starts_with($item['id'], 'job-')) $index['job'][$item['id']][] = $item;
    }
    return $index;
}
function monitorReviewsForCall(string $domain, array $index, string $cdrId, ?array $ref): array {
    $reviews = $cdrId !== '' ? ($index['cdr'][$cdrId] ?? []) : [];
    if ($ref !== null) {
        $name = 'job-' . monitorDomainId($domain) . '-' . monitorJobKey($ref);
        foreach ($index['job'][$name] ?? [] as $review) if ($review['cdrId'] === '' || $review['cdrId'] === $cdrId) $reviews[] = $review;
    }
    $unique = []; foreach ($reviews as $review) $unique[$review['id']] = $review;
    return array_values($unique);
}
function monitorAcknowledge(string $domain, string $id): void {
    $domainId = monitorDomainId($domain);
    if (!preg_match('/^(job|review)-' . $domainId . '-([0-9a-f]{64})$/', $id, $m)) throw new InvalidArgumentException('Invalid review.');
    $stripe = ($m[1] === 'job' ? 'jobs-' : 'reviews-') . $domainId . '-' . substr($m[2], 0, 2);
    monitorLocked($stripe, static function () use ($id): void {
        $file = monitorDirectory() . '/' . $id . '.json';
        $item = monitorReadFile($file);
        if (!in_array($item['status'] ?? '', ['review', 'sending'], true)) throw new InvalidArgumentException('Review is not available for acknowledgement.');
        $item['status'] = 'reviewed';
        $item['reviewedAt'] = time();
        monitorWriteFile($file, $item);
    });
}
/** One complete CDR from the live PBX, not from the report's cache. */
function monitorProcessCall(PbxClient $client, string $domain, array $call, array $settings, array &$counts, ?string &$pendingReason = null): void {
    $live = monitorState($domain);
    if (!empty($live['enabled']) && ($live['generation'] ?? null) === ($settings['generation'] ?? null) && monitorRecipients($live) === []) { $counts['pending']++; return; }
    $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
    if (!$end) {
        $counts['missingTime']++;
        $started = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
        if ($started && $started->getTimestamp() >= (int)$settings['since']) {
            if (time() - $started->getTimestamp() >= 86400) {
                monitorReviewCdr($domain, $call, 'Call completion time unavailable after 24 hours');
            } else { $counts['pending']++; $pendingReason = 'time'; }
        }
        return;
    }
    $ended = $end->getTimestamp();
    if ($ended < (int)$settings['since'] || $ended > time()) return;
    $reason = null;
    try { $ref = intelligenceReference($call, $domain, '', $reason); }
    catch (Throwable $e) { $ref = null; $reason = 'month'; }
    if (!$ref) {
        if (time() - $ended >= 86400) {
            $counts['unresolved']++;
            monitorReviewCdr($domain, $call, 'Transcription reference unavailable after 24 hours (' . ($reason ?: 'unknown') . ')');
        } else { $counts['pending']++; $pendingReason = in_array($reason, ['jobId', 'server', 'callId', 'month'], true) ? $reason : 'lookup'; }
        return;
    }
    monitorJob($domain, $ref, static function (array $job) use ($client, $domain, $call, $ref, $ended, $settings, &$counts, &$pendingReason): ?array {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($settings['generation'] ?? null)) return null;
        if (monitorRecipients($current) === []) { $counts['pending']++; return null; }
        if ($job !== []) {
            if (in_array($job['status'] ?? '', ['review', 'sending'], true)) $counts['review']++;
            return null;
        }
        if (time() - $ended >= 86400) { $counts['review']++; return ['status' => 'review', 'time' => time(), 'reason' => monitorExpiryReason(''), 'callid' => $ref['callid'], 'cdrId' => (string)($call['id'] ?? ''), 'startedAt' => monitorCallStartedAt($call)]; }
        try {
            $result = intelligenceReadJob($client, $domain, $ref, intelligenceWatches($domain));
            if (($result['status'] ?? '') !== 'finished' || empty($result['topics'])) {
                $pendingReason = ($result['status'] ?? '') === 'pending' ? 'processing' : (($result['status'] ?? '') === 'partial' ? 'partial' : 'topics');
                $counts['pending']++; return null;
            }
        } catch (Throwable $e) { $pendingReason = 'lookup'; $counts['pending']++; return null; }
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($settings['generation'] ?? null)) return null;
        $recipients = monitorRecipients($current);
        if ($recipients === []) { $counts['pending']++; return null; }
        if (empty($result['matches'])) { $counts['checked']++; return ['status' => 'checked', 'time' => time()]; }
        $recordingUrl = null;
        try { $recordingUrl = intelligenceRecordingLink($client, $domain, $call); }
        catch (Throwable $e) { appExceptionLog('Alert recording link', $e); }
        $message = intelligenceAutomaticMessage($domain, $call, $ref, $result, $recordingUrl);
        /* Persist the ambiguous state BEFORE SMTP. A crash or timeout may mean
         * the message was accepted; never automatically resend it. */
        $sending = ['status' => 'sending', 'time' => time(), 'callid' => $ref['callid'], 'cdrId' => (string)($call['id'] ?? ''), 'startedAt' => monitorCallStartedAt($call)];
        $file = monitorDirectory() . '/job-' . monitorDomainId($domain) . '-' . monitorJobKey($ref) . '.json';
        monitorWriteFile($file, $sending);
        try {
            intelligenceSendMail($recipients, $message['text'], 'CallScope keyword alert', $message['html']);
            $accepted = time();
            try { monitorRecordEmail($domain, (string)($call['id'] ?? ''), $recipients, 'automatic', $accepted); }
            catch (Throwable $e) { appExceptionLog('Intelligence email status', $e); }
            $counts['sent']++;
            return ['status' => 'sent', 'time' => $accepted];
        } catch (Throwable $e) {
            $counts['review']++;
            $detail = '';
            if (preg_match('/^SMTP delivery failed \(cURL error ([0-9]{1,3})\)\.$/', $e->getMessage(), $m) && (int)$m[1] > 0) {
                $detail = ' cURL error ' . $m[1] . '.';
                $description = monitorSmtpErrorDescription((int)$m[1]);
                if ($description !== '') $detail .= ' ' . $description;
            }
            return ['status' => 'review', 'time' => time(), 'callid' => $ref['callid'], 'cdrId' => (string)($call['id'] ?? ''), 'startedAt' => monitorCallStartedAt($call), 'reason' => 'SMTP did not confirm acceptance.' . $detail . ' Delivery is uncertain; check the recipient or SMTP logs before retrying.'];
        }
    });
}
