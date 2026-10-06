<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/cache.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

function isClosedRange(string $end): bool { return $end < (new DateTimeImmutable('today', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d'); }

function cacheFile(string $domain, string $day): string { return CACHE_DIR . '/cdr-day-' . hash('sha256', implode('|', ['v7', $domain, $day, implode(',', array_keys(PBX_SERVERS))])) . '.json'; }

function cdrDayCacheTtl(string $date): int
{
    $today = (new DateTimeImmutable('today', reportingTimezone()))->format('Y-m-d');
    if ($date === $today) {
        return 90;
    }
    return defined('CACHE_TTL_SECONDS') ? (int)CACHE_TTL_SECONDS : 86400;
}

function readCdrDayCache(string $file): ?array
{
    if (!is_file($file)) {
        return null;
    }
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) {
        return null;
    }
    if (isset($data['records']) && is_array($data['records'])) {
        return [
            'complete' => !empty($data['complete']),
            'nextOffset' => (int)($data['nextOffset'] ?? 0),
            'records' => $data['records'],
        ];
    }
    if ($data === [] || isset($data[0])) {
        return [
            'complete' => true,
            'nextOffset' => 0,
            'records' => $data,
        ];
    }
    return null;
}

function writeCdrDayCache(string $file, array $records, bool $complete, int $nextOffset): void
{
    $ok = @file_put_contents(
        $file,
        json_encode(
            [
                'complete' => $complete,
                'nextOffset' => $nextOffset,
                'records' => $records,
            ],
            JSON_UNESCAPED_SLASHES
        ),
        LOCK_EX
    );
    if ($ok === false) {
        appLog("Could not write CDR cache {$file}");
    }
}

function nodeCdrDir(): string
{
    if (defined('NODE_CDR_DIR') && NODE_CDR_DIR !== '') {
        return rtrim(str_replace('\\', '/', (string)NODE_CDR_DIR), '/');
    }
    $guess = dirname(__DIR__) . '/pbx-client/cdr-out';
    return rtrim(str_replace('\\', '/', $guess), '/');
}

function readNodeDayJsonl(string $date): ?array
{
    $file = nodeCdrDir() . '/cdr-' . $date . '.jsonl';
    if (!is_file($file) || !is_readable($file)) {
        return null;
    }

    $rows = [];
    $fh = fopen($file, 'rb');
    if ($fh === false) {
        return null;
    }
    try {
        while (($line = fgets($fh)) !== false) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $row = json_decode($line, true);
            if (is_array($row)) {
                $rows[] = $row;
            }
        }
    } finally {
        fclose($fh);
    }

    return $rows;
}

function loadRawCdrs(array $user, array $filters): array {
    $client = new PbxClient($_SESSION['token']);
    $merged = [];
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';

    for (
        $day = new DateTimeImmutable($filters['start']);
        $day <= new DateTimeImmutable($filters['end']);
        $day = $day->modify('+1 day')
    ) {
        $date = $day->format('Y-m-d');
        $file = cacheFile($user['domain'], $date . '|' . $tzName);
        $ttl = cdrDayCacheTtl($date);
        $cached = readCdrDayCache($file);
        $age = is_file($file) ? (time() - (int)filemtime($file)) : PHP_INT_MAX;

        $records = [];
        $fromNode = isClosedRange($date) ? readNodeDayJsonl($date) : null;
        if (is_array($fromNode)) {
            $records = $fromNode;
        } elseif (
            is_array($cached)
            && !empty($cached['complete'])
            && $age < $ttl
        ) {
            $records = $cached['records'];
        } else {
            $existing = [];
            $offset = 0;
            if (
                is_array($cached)
                && empty($cached['complete'])
                && is_array($cached['records'])
            ) {
                $existing = $cached['records'];
                $offset = (int)$cached['nextOffset'];
            }

            [$windowStart, $windowEnd] = easternDayWindow($date);
            try {
                $result = $client->fetchCdrs(
                    $user['domain'],
                    $windowStart,
                    $windowEnd,
                    $offset,
                    $existing,
                    static function (
                        array $rows,
                        int $nextOffset,
                        bool $complete
                    ) use ($file): void {
                        writeCdrDayCache($file, $rows, $complete, $nextOffset);
                    }
                );
                $records = $result['records'];
                writeCdrDayCache(
                    $file,
                    $records,
                    (bool)$result['complete'],
                    (int)$result['nextOffset']
                );
            } catch (Throwable $e) {
                appExceptionLog("CDR day {$date}", $e);
                if ($existing !== []) {
                    $records = $existing;
                } else {
                    throw $e;
                }
            }
        }

        foreach ($records as $record) {
            if (!is_array($record)) {
                continue;
            }
            $merged[cdrCacheKey($record, count($merged))] = $record;
        }
    }

    return array_values($merged);
}

function reportingDateList(string $start, string $end): array
{
    $out = [];
    try {
        $from = new DateTimeImmutable(substr($start, 0, 10));
        $to = new DateTimeImmutable(substr($end, 0, 10));
    } catch (Throwable $e) {
        return [];
    }
    if ($to < $from) {
        return [];
    }
    for ($day = $from; $day <= $to; $day = $day->modify('+1 day')) {
        $out[] = $day->format('Y-m-d');
    }
    return $out;
}

function cdrDayIsCached(array $user, string $date): bool
{
    $date = substr($date, 0, 10);
    if (isClosedRange($date) && is_array(readNodeDayJsonl($date))) {
        return true;
    }
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $file = cacheFile((string)$user['domain'], $date . '|' . $tzName);
    $cached = readCdrDayCache($file);
    if (!is_array($cached) || empty($cached['complete'])) {
        return false;
    }
    $ttl = cdrDayCacheTtl($date);
    $age = is_file($file) ? (time() - (int)filemtime($file)) : PHP_INT_MAX;
    return $age < $ttl;
}

function cdrRangeCacheStatus(array $user, string $start, string $end): array
{
    $days = reportingDateList($start, $end);
    $ready = 0;
    $next = null;
    foreach ($days as $date) {
        if (cdrDayIsCached($user, $date)) {
            $ready++;
        } elseif ($next === null) {
            $next = $date;
        }
    }
    $total = count($days);
    return [
        'total' => $total,
        'ready' => $ready,
        'pending' => max(0, $total - $ready),
        'percent' => $total ? (int)round(($ready / $total) * 100) : 100,
        'next' => $next,
        'complete' => $total === 0 || $ready >= $total,
    ];
}

function warmCdrDay(array $user, string $date): array
{
    $date = substr(trim($date), 0, 10);
    if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return ['date' => $date, 'complete' => false];
    }
    if (cdrDayIsCached($user, $date)) {
        return ['date' => $date, 'complete' => true];
    }

    $client = new PbxClient((string)($_SESSION['token'] ?? ''));
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $file = cacheFile((string)$user['domain'], $date . '|' . $tzName);
    $cached = readCdrDayCache($file);
    $existing = [];
    $offset = 0;
    if (is_array($cached) && empty($cached['complete']) && is_array($cached['records'])) {
        $existing = $cached['records'];
        $offset = (int)$cached['nextOffset'];
    }
    [$windowStart, $windowEnd] = easternDayWindow($date);
    $result = $client->fetchCdrs(
        (string)$user['domain'],
        $windowStart,
        $windowEnd,
        $offset,
        $existing,
        static function (array $rows, int $nextOffset, bool $complete) use ($file): void {
            writeCdrDayCache($file, $rows, $complete, $nextOffset);
        }
    );
    $records = is_array($result['records'] ?? null) ? $result['records'] : [];
    writeCdrDayCache(
        $file,
        $records,
        (bool)($result['complete'] ?? false),
        (int)($result['nextOffset'] ?? 0)
    );
    return [
        'date' => $date,
        'complete' => !empty($result['complete']),
        'records' => count($records),
    ];
}

function cdrCacheKey(array $record, int $fallback): string {
    if (!empty($record['id'])) {
        return (string)$record['id'];
    }
    foreach (['call-orig-call-id', 'call-term-call-id'] as $field) {
        if (!empty($record[$field])) {
            return (string)$record[$field] . ':' . (string)($record['call-term-user'] ?? $fallback);
        }
    }
    return hash('sha256', implode('|', [$record['call-start-datetime'] ?? '', $record['call-orig-from-name'] ?? '', $record['call-orig-to-user'] ?? '', $record['call-term-user'] ?? '', (string)$fallback]));
}
