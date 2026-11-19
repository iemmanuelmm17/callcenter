<?php
declare(strict_types=1);

/* The webhook is only a trigger. No summary or job ID from it is trusted. */
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
function monitorQueueEvent(string $domain, array $event, array $state): void {
    $id = $event['cdr_id'] ?? null;
    $start = $event['time_start'] ?? null;
    $release = $event['time_release'] ?? null;
    if (!is_string($id) || $id === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id)
        || !is_numeric($start) || !is_numeric($release) || (int)$start <= 0 || (int)$release < (int)$start || (int)$release > time() + 300) {
        throw new InvalidArgumentException('Invalid CDR event.');
    }
    if ((int)$release < (int)($state['since'] ?? PHP_INT_MAX)) return;
    monitorLocked(monitorQueueLock($domain, $id), static function () use ($domain, $id, $start, $release, $state): void {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($state['generation'] ?? null)) return;
        $file = monitorQueueFile($domain, $id);
        if (is_file($file) || is_file(monitorQueueDoneFile($domain, $id))) return; // durable dedup, including after a completed job
        monitorWriteFile($file, ['domain' => $domain, 'id' => $id, 'start' => (int)$start, 'ended' => (int)$release,
            'generation' => $state['generation'], 'status' => 'pending', 'attempts' => 0, 'next' => (int)$release + 300]);
    });
}
function monitorWebhookEvents(string $remote, string $correlation, array $events): void {
    if (!monitorWebhookConfig() || !in_array($remote, INTELLIGENCE_WEBHOOK_ALLOWED_IPS, true) || $correlation === '' || strlen($correlation) > 256) throw new DomainException('Unauthorized webhook');
    if (!array_is_list($events) || count($events) < 1 || count($events) > 1000) throw new InvalidArgumentException('Invalid event batch');
    // Authenticate every item before persisting any; correlation ID is per subscription.
    $states = [];
    foreach ($events as $event) {
        if (!is_array($event) || !is_string($event['domain'] ?? null) || $event['domain'] === '' || strlen($event['domain']) > 64) throw new InvalidArgumentException('Invalid CDR event');
        $domain = $event['domain'];
        if (!isset($states[$domain])) $states[$domain] = monitorState($domain);
        $state = $states[$domain];
        if (empty($state['subscriptionId']) || !hash_equals((string)$state['subscriptionId'], $correlation)) throw new DomainException('Unauthorized webhook');
    }
    foreach ($events as $event) {
        $state = $states[$event['domain']];
        if (!empty($state['enabled'])) monitorQueueEvent($event['domain'], $event, $state);
    }
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
function monitorQueueFinish(string $domain, array $item, string $status): void {
    monitorLocked(monitorQueueLock($domain, $item['id']), static function () use ($domain, $item, $status): void {
        $file = monitorQueueFile($domain, $item['id']);
        $current = monitorReadFile($file);
        if (($current['status'] ?? '') !== 'pending' || ($current['generation'] ?? null) !== $item['generation']) return;
        if ($status === 'pending') {
            $attempt = (int)($current['attempts'] ?? 0) + 1;
            $current['attempts'] = $attempt;
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
