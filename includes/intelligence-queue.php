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
    if ($id === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id)
        || $start <= 0 || $release < $start || $release > time() + 300) throw new InvalidArgumentException('Invalid CDR.');
    if ($release < (int)($state['since'] ?? PHP_INT_MAX)) return;
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
