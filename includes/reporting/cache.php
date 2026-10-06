<?php
declare(strict_types=1);

/**
 * Day cache for raw PBX CDRs.
 *
 * Two storage backends behind one interface, chosen by cdrCacheDriver()
 * (includes/reporting/cdr_store.php):
 *
 *   sqlite  cdr_days / cdr_records — atomic per-page writes, indexed columns,
 *           queries like "is this day complete?" answered without reading the
 *           day itself (DEFAULT; falls back to json when pdo_sqlite is absent)
 *   json    cdr-day-<sha256>.json  — the original format, one file per day
 *
 * The contract both backends keep:
 *   - a day is keyed by domain, timezone and date;
 *   - a day is either complete (the PBX list ended) or partial, in which case
 *     nextOffset says where to resume;
 *   - reads return ['complete' => bool, 'nextOffset' => int, 'records' => list].
 *
 * Extracted from includes/reporting.php — includes/reporting/cache.php.
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require.
 */

function isClosedRange(string $end): bool { return $end < (new DateTimeImmutable('today', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d'); }

/**
 * The JSON day-cache filename. Kept (with its exact hash input) because the
 * deployed cache/ directories are full of these files and the CLI can import
 * them into the store.
 */
function cdrDayCacheFile(string $domain, string $day): string { return CACHE_DIR . '/cdr-day-' . hash('sha256', implode('|', ['v7', $domain, $day, implode(',', array_keys(PBX_SERVERS))])) . '.json'; }

function cacheFile(string $domain, string $day): string { return cdrDayCacheFile($domain, $day); }

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

/**
 * Read one day from the active backend.
 *
 * $ttlSeconds applies to the JSON backend only: a file has no "is this day
 * still good?" answer other than its mtime, while the store tracks completeness
 * explicitly. `partialIsFine` is what callers use to accept a half-fetched day
 * (the store and the JSON reader return it either way; the caller decides).
 */
function cdrDayCacheRead(string $domain, string $day, int $ttlSeconds = 0): ?array
{
    if (cdrCacheDriver() === 'sqlite') {
        $cached = cdrStoreDayLoad($domain, $day);
        if (is_array($cached)) {
            return $cached;
        }
    }

    $file = cdrDayCacheFile($domain, $day);
    $cached = readCdrDayCache($file);
    if (!is_array($cached)) {
        return null;
    }
    $ttl = $ttlSeconds > 0 ? $ttlSeconds : cdrDayCacheTtl($day);
    $age = is_file($file) ? (time() - (int)filemtime($file)) : PHP_INT_MAX;
    $cached['fresh'] = !empty($cached['complete']) && $age < $ttl;
    $cached['fetchedAt'] = is_file($file) ? (int)filemtime($file) : 0;
    return $cached;
}

/**
 * Write one fetch page to the active backend.
 *
 * $replace is true for the first page of a fresh fetch: the day is rewritten
 * (records deleted first) instead of appended to, so a day the PBX has since
 * corrected cannot keep stale rows. Later pages append only what is new.
 */
function cdrDayCacheWrite(string $domain, string $day, array $records, bool $complete, int $nextOffset, bool $replace = false): void
{
    /* One backend per deployment: the point of the store is to stop rewriting
     * a whole day file per fetch page, so the JSON copy is not kept in sync
     * (and reads fall back to it only until a day has been imported). */
    if (cdrCacheDriver() === 'sqlite') {
        cdrStoreDayWrite($domain, $day, $records, $complete, $nextOffset, $replace);
        return;
    }
    writeCdrDayCache(cdrDayCacheFile($domain, $day), $records, $complete, $nextOffset);
}

/** Day metadata (complete / nextOffset / record count), backend agnostic. */
function cdrDayCacheMeta(string $domain, string $day): array
{
    if (cdrCacheDriver() === 'sqlite') {
        $meta = cdrStoreDayMeta($domain, $day);
        if (!empty($meta['exists'])) {
            return $meta;
        }
    }

    $file = cdrDayCacheFile($domain, $day);
    $cached = readCdrDayCache($file);
    return [
        'exists' => is_array($cached),
        'complete' => is_array($cached) ? !empty($cached['complete']) : false,
        'nextOffset' => is_array($cached) ? (int)$cached['nextOffset'] : 0,
        'records' => is_array($cached) ? count($cached['records']) : 0,
        'fetchedAt' => is_file($file) ? (int)filemtime($file) : 0
    ];
}

function loadRawCdrs(array $user, array $filters): array {
    $client = new PbxClient($_SESSION['token']);
    $merged = [];
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $driver = cdrCacheDriver();

    for (
        $day = new DateTimeImmutable($filters['start']);
        $day <= new DateTimeImmutable($filters['end']);
        $day = $day->modify('+1 day')
    ) {
        $date = $day->format('Y-m-d');
        $file = cacheFile($user['domain'], $date . '|' . $tzName);
        $ttl = cdrDayCacheTtl($date);
        $cached = cdrDayCacheRead((string)$user['domain'], $date, $ttl);
        $meta = cdrDayCacheMeta((string)$user['domain'], $date);
        $fresh = is_array($cached) && !empty($cached['complete']) && $meta['fetchedAt'] > 0
            && (time() - (int)$meta['fetchedAt']) < $ttl;

        $records = [];
        $fromNode = isClosedRange($date) ? readNodeDayJsonl($date) : null;
        if (is_array($fromNode)) {
            $records = $fromNode;
        } elseif ($fresh) {
            $records = $cached['records'];
        } else {
            /* Nothing usable is stored: fetch the day from the PBX. A partial
             * day (killed mid-fetch) is resumed from its nextOffset. */
            $existing = [];
            $offset = 0;
            if (is_array($cached) && empty($cached['complete']) && is_array($cached['records'])) {
                $existing = $cached['records'];
                $offset = (int)$cached['nextOffset'];
            }
            /* First page of a fresh fetch: replace the day instead of merging
             * into whatever a previous fetch left behind. */
            $replace = $existing === [];

            [$windowStart, $windowEnd] = easternDayWindow($date);
            /* PbxClient::fetchCdrs() hands the accumulated list to this
             * callback once per page and returns the same list, so storing the
             * page and then storing the result again would write every record
             * twice (and, for a fresh day, wipe and re-insert the day on every
             * page). The flag keeps the single write. */
            $pageStored = false;
            /* A fresh day is replaced once, by the first page; every later page
             * appends only the rows the store does not have yet. Passing
             * `$replace` to each page would delete and re-insert the whole day
             * per page (a 100k-record day is 400 pages). */
            $firstPage = true;
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
                    ) use ($user, $date, $replace, &$pageStored, &$firstPage): void {
                        $pageStored = true;
                        cdrDayCacheWrite(
                            (string)$user['domain'],
                            $date,
                            $rows,
                            $complete,
                            $nextOffset,
                            $firstPage && $replace
                        );
                        $firstPage = false;
                    }
                );
                $records = $result['records'];
                /* Without the callback this is the only write; with it, the
                 * records are already stored and this updates the day's
                 * completeness and resume offset (append-only). */
                cdrDayCacheWrite(
                    (string)$user['domain'],
                    $date,
                    $records,
                    (bool)$result['complete'],
                    (int)$result['nextOffset'],
                    $pageStored ? false : $replace
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
    $meta = cdrDayCacheMeta((string)$user['domain'], $date);
    if (empty($meta['exists']) || empty($meta['complete'])) {
        return false;
    }
    $ttl = cdrDayCacheTtl($date);
    $age = $meta['fetchedAt'] > 0 ? (time() - (int)$meta['fetchedAt']) : PHP_INT_MAX;
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
        'driver' => cdrCacheDriver(),
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
    $ttl = cdrDayCacheTtl($date);
    $cached = cdrDayCacheRead((string)$user['domain'], $date, $ttl);
    $existing = [];
    $offset = 0;
    if (is_array($cached) && empty($cached['complete']) && is_array($cached['records'])) {
        $existing = $cached['records'];
        $offset = (int)$cached['nextOffset'];
    }
    $replace = $existing === [];
    [$windowStart, $windowEnd] = easternDayWindow($date);
    $pageStored = false;
    $firstPage = true;
    $result = $client->fetchCdrs(
        (string)$user['domain'],
        $windowStart,
        $windowEnd,
        $offset,
        $existing,
        static function (array $rows, int $nextOffset, bool $complete) use ($user, $date, $replace, &$pageStored, &$firstPage): void {
            $pageStored = true;
            cdrDayCacheWrite((string)$user['domain'], $date, $rows, $complete, $nextOffset, $firstPage && $replace);
            $firstPage = false;
        }
    );
    $records = is_array($result['records'] ?? null) ? $result['records'] : [];
    cdrDayCacheWrite(
        (string)$user['domain'],
        $date,
        $records,
        (bool)($result['complete'] ?? false),
        (int)($result['nextOffset'] ?? 0),
        $pageStored ? false : $replace
    );
    return [
        'date' => $date,
        'complete' => !empty($result['complete']),
        'records' => count($records),
        'driver' => cdrCacheDriver(),
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
