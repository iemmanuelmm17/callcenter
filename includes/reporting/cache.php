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

/**
 * Read one day, streaming when the file is in the current format.
 *
 * FORMAT
 * ------
 * v2 (what this writes now) is JSONL: a one-line header, then one record per
 * line. A wide day is 20,000 records; as a single JSON document that is a
 * ~35 MB string handed to json_decode, which materialises the whole day at
 * once. Streamed, the peak is one record plus the day being built - and the
 * day is the unit the caller works in, so nothing is held twice.
 *
 * v1 (a single JSON document, the shape every cache written before this
 * change has) still reads, and is rewritten as v2 on the way out: the records
 * are already decoded and in hand, so the promotion is I/O only, and the next
 * request streams. That matters because the alternative - leaving the deployed
 * cache in v1 - would leave every day paying the old cost for ever.
 */
function readCdrDayCache(string $file): ?array
{
    if (!is_file($file) || !is_readable($file)) {
        return null;
    }

    $handle = @fopen($file, 'rb');
    if ($handle === false) {
        return null;
    }
    $head = null;
    $records = [];
    $streamed = false;
    try {
        $first = fgets($handle);
        if ($first === false) {
            return null;
        }
        $head = json_decode(trim($first), true);
        if (is_array($head) && (int)($head['v'] ?? 0) === 2) {
            $streamed = true;
            while (($line = fgets($handle)) !== false) {
                $line = trim($line);
                if ($line === '') {
                    continue;
                }
                $row = json_decode($line, true);
                if (is_array($row)) {
                    $records[] = cdrTrimRecord($row);
                }
            }
        }
    } finally {
        fclose($handle);
    }

    if ($streamed) {
        return [
            'complete' => !empty($head['complete']),
            'nextOffset' => (int)($head['nextOffset'] ?? 0),
            'records' => $records,
            'fetchedAt' => (int)filemtime($file),
            'format' => 2,
        ];
    }

    /* v1: the whole file is one JSON document. */
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) {
        return null;
    }
    if (isset($data['records']) && is_array($data['records'])) {
        $out = [
            'complete' => !empty($data['complete']),
            'nextOffset' => (int)($data['nextOffset'] ?? 0),
            /* Day files written before the trim existed hold every PBX field;
             * trimming here is what keeps a legacy cache from costing the old
             * (fatal) amount of memory. It is idempotent. */
            'records' => cdrTrimRecords($data['records']),
        ];
    } elseif ($data === [] || isset($data[0])) {
        $out = [
            'complete' => true,
            'nextOffset' => 0,
            'records' => cdrTrimRecords($data),
        ];
    } else {
        return null;
    }

    /* Promote: the records are in hand, so this only costs the write. */
    cdrDayCachePromote($file, $out['records'], $out['complete'], $out['nextOffset']);
    $out['fetchedAt'] = (int)filemtime($file);
    $out['format'] = 2;
    return $out;
}

/**
 * The header line of a v2 day file. Its `records` count is what lets
 * cdrDayCacheMeta() answer without decoding a single record - the callers that
 * only want "how many, complete?" (the cache status, the data-quality appendix)
 * used to decode the whole day for it, four times per request between them.
 */
function cdrDayCacheHeaderLine(bool $complete, int $nextOffset, int $records): string
{
    return json_encode([
        'v' => 2,
        'complete' => $complete,
        'nextOffset' => $nextOffset,
        'records' => $records,
    ], JSON_UNESCAPED_SLASHES) . "\n";
}

/**
 * Rewrite a v1 day file as v2. Best effort on purpose: a read-only cache
 * directory (or a full disk) must not break a request that has already got its
 * data - it just keeps paying the v1 cost.
 *
 * @param list<array> $records
 */
function cdrDayCachePromote(string $file, array $records, bool $complete, int $nextOffset): bool
{
    $written = writeCdrDayCache($file, $records, $complete, $nextOffset);
    if ($written) {
        appLog('CDR day cache promoted to v2: ' . basename($file));
    }
    return $written;
}

/**
 * Write one day as v2 (JSONL): header line, then one record per line.
 *
 * Streamed in chunks (so a wide day is never one giant string in memory) to a
 * temporary file, then moved into place, so a reader never sees a half-written
 * day. Returns whether the day is on disk in the new format.
 */
function writeCdrDayCache(string $file, array $records, bool $complete, int $nextOffset): bool
{
    /* Trim on the way out as well as on the way in: the JSON driver is also
     * written by tools/cdr-cache.php's import, which reads legacy files. */
    $header = cdrDayCacheHeaderLine($complete, $nextOffset, count($records));

    $temporary = $file . '.tmp-' . getmypid() . '-' . bin2hex(random_bytes(4));
    $handle = @fopen($temporary, 'wb');
    if ($handle === false) {
        appLog("Could not open CDR cache for writing: {$temporary}");
        return false;
    }

    $ok = true;
    $buffer = '';
    try {
        if (fwrite($handle, $header) === false) {
            $ok = false;
        }
        foreach ($records as $record) {
            if (!is_array($record)) {
                continue;
            }
            $line = json_encode(cdrTrimRecord($record), JSON_UNESCAPED_SLASHES);
            if (!is_string($line)) {
                continue;
            }
            $buffer .= $line . "\n";
            if (strlen($buffer) >= 1048576) {
                if (fwrite($handle, $buffer) === false) {
                    $ok = false;
                    break;
                }
                $buffer = '';
            }
        }
        if ($ok && $buffer !== '' && fwrite($handle, $buffer) === false) {
            $ok = false;
        }
    } finally {
        fclose($handle);
    }

    if (!$ok) {
        @unlink($temporary);
        appLog("Could not write CDR cache {$file}");
        return false;
    }

    if (!@rename($temporary, $file)) {
        /* Windows can refuse to replace an open file; unlinking first is the
         * documented way round it, and the day is rewritten in full either
         * way (the temp file is complete). */
        @unlink($file);
        if (!@rename($temporary, $file)) {
            /* Last resort: write in place, as the v1 writer did. */
            $ok = @file_put_contents($file, file_get_contents($temporary), LOCK_EX) !== false;
            @unlink($temporary);
            if (!$ok) {
                appLog("Could not move CDR cache into place: {$file}");
            }
        }
    }

    if ($ok) {
        /* The file was replaced, so its mtime is the fetch time - which is what
         * cdrDayCacheTtl() and cdrDayIsCached() compare against. */
        @touch($file);
    }
    return $ok;
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
                $rows[] = cdrTrimRecord($row);
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
    $empty = [
        'exists' => false,
        'complete' => false,
        'nextOffset' => 0,
        'records' => 0,
        'fetchedAt' => is_file($file) ? (int)filemtime($file) : 0,
    ];

    /* v2: the header line carries the whole answer, so none of the day's
     * records are decoded. This is the difference between the data-quality
     * appendix costing a few kilobytes per day and costing a full decode of
     * every day - which is what made a wide range die while the payload was
     * being assembled (long after the metrics were computed). */
    $head = cdrDayCacheReadHeader($file);
    if (is_array($head)) {
        return [
            'exists' => true,
            'complete' => !empty($head['complete']),
            'nextOffset' => (int)($head['nextOffset'] ?? 0),
            'records' => (int)($head['records'] ?? 0),
            'fetchedAt' => $empty['fetchedAt'],
        ];
    }

    /* v1 or unknown: read the day (which may promote it to v2). */
    $cached = readCdrDayCache($file);
    return [
        'exists' => is_array($cached),
        'complete' => is_array($cached) ? !empty($cached['complete']) : false,
        'nextOffset' => is_array($cached) ? (int)$cached['nextOffset'] : 0,
        'records' => is_array($cached) ? count($cached['records']) : 0,
        'fetchedAt' => $empty['fetchedAt'],
    ];
}

/**
 * The v2 header of a day file, or null when the file is absent/empty/legacy.
 * Reads a bounded prefix of the file and never touches a record.
 */
function cdrDayCacheReadHeader(string $file): ?array
{
    if (!is_file($file) || !is_readable($file)) {
        return null;
    }
    $handle = @fopen($file, 'rb');
    if ($handle === false) {
        return null;
    }
    try {
        $line = fgets($handle, 4096);
    } finally {
        fclose($handle);
    }
    if ($line === false) {
        return null;
    }
    $head = json_decode(trim($line), true);
    if (!is_array($head) || (int)($head['v'] ?? 0) !== 2) {
        return null;
    }
    return $head;
}

/**
 * One fetcher per day, process-wide.
 *
 * WHY
 * ---
 * Two things fetch the same day at the same time: the report request (which
 * fetches any day it is missing) and the client's warm loop, which starts as
 * soon as a range is a week or more. Both paid for the day - twice the PBX
 * requests for the same 20,000 records - and because the PBX client is
 * rate-limited (PBX_REQUESTS_PER_SECOND), each one made the other wait. The
 * lock makes the second caller wait for the first and then read what it wrote.
 *
 * The lock is a file created with 'x' (atomic on every filesystem this app
 * runs on), and it is STOLEN when it is older than $staleSeconds: a request
 * killed mid-fetch must not block a day for ever.
 */
function cdrDayFetchLock(string $domain, string $day, int $staleSeconds = 300): ?string
{
    $file = CACHE_DIR . '/cdr-fetch-' . hash('sha256', $domain . '|' . $day) . '.lock';
    $handle = @fopen($file, 'x');
    if ($handle === false) {
        $age = is_file($file) ? (time() - (int)@filemtime($file)) : PHP_INT_MAX;
        if ($age < $staleSeconds) {
            return null;
        }
        /* Stale: the fetcher died. Take it over. */
        @unlink($file);
        $handle = @fopen($file, 'x');
        if ($handle === false) {
            return null;
        }
    }
    fwrite($handle, (string)getmypid());
    fclose($handle);
    return $file;
}

function cdrDayFetchUnlock(?string $file): void
{
    if (is_string($file) && $file !== '') {
        @unlink($file);
    }
}

/**
 * Wait for another process to finish fetching a day, then read it back.
 * Returns the day when it appeared, null when it did not (the caller then
 * fetches it itself - correctness first, never a silently missing day).
 *
 * @return array{complete:bool,nextOffset:int,records:list<array>}|null
 */
function cdrDayWaitForFetcher(array $user, string $day, int $waitMs = 2000): ?array
{
    $deadline = microtime(true) + ($waitMs / 1000);
    do {
        usleep(100000);
        $cached = cdrDayCacheRead((string)$user['domain'], $day, cdrDayCacheTtl($day));
        if (is_array($cached) && !empty($cached['complete']) && ($cached['records'] ?? []) !== []) {
            return $cached;
        }
    } while (microtime(true) < $deadline);
    return null;
}

function loadRawCdrs(array $user, array $filters): array {
    $client = new PbxClient($_SESSION['token']);
    $merged = [];
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $driver = cdrCacheDriver();

    /*
     * How many calls this range is about to hold, and whether that can fit.
     * A range that provably cannot fit is refused here with a message naming
     * the range and the limit, rather than left to exhaust PHP's memory_limit
     * halfway through (the production fatal this guards against).
     */
    $dayCounts = reportingRangeGuard($user, $filters);
    $baselineBytes = memory_get_usage(true);
    $processedDays = 0;
    $remainingDays = reportingDateList((string)$filters['start'], (string)$filters['end']);

    for (
        $day = new DateTimeImmutable($filters['start']);
        $day <= new DateTimeImmutable($filters['end']);
        $day = $day->modify('+1 day')
    ) {
        $date = $day->format('Y-m-d');
        $file = cacheFile($user['domain'], $date . '|' . $tzName);
        $ttl = cdrDayCacheTtl($date);
        $cached = cdrDayCacheRead((string)$user['domain'], $date, $ttl);
        /*
         * Freshness comes from the read that just happened, not from a second
         * cdrDayCacheMeta() call: on the JSON driver that call decoded the
         * same day file a second time, which doubled the cost of every day in
         * the range at the worst possible moment (while the range was being
         * merged and the day itself was still alive).
         */
        $fetchedAt = is_array($cached) ? (int)($cached['fetchedAt'] ?? 0) : 0;
        $fresh = is_array($cached) && !empty($cached['complete']) && $fetchedAt > 0
            && (time() - $fetchedAt) < $ttl;

        $records = [];
        /*
         * A node-client JSONL file used to WIN over the day cache and be
         * re-read, re-decoded and re-trimmed on every single request - no
         * cache, no TTL, and because cdrDayIsCached() says such a day is
         * ready, the warm loop never imported it either. A 15-day range with
         * those files present paid a full parse of every day, every time.
         * Now the day cache is preferred when it is fresh, and a node file is
         * IMPORTED into it once (the parse the request was going to do anyway,
         * plus a write) so the next request streams.
         */
        /* Fresh cache first; the node file is a source of last resort. */
        $fromNode = (!$fresh && isClosedRange($date)) ? readNodeDayJsonl($date) : null;
        if (is_array($fromNode)) {
            $records = $fromNode;
            cdrDayCacheWrite(
                (string)$user['domain'],
                $date,
                $fromNode,
                true,
                count($fromNode),
                true
            );
            appLog("CDR day imported from node JSONL into the day cache: {$date} (" . count($fromNode) . ' records)');
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
            /*
             * One fetcher per day: if another request is already fetching this
             * day (the report and the warm loop overlap constantly), wait for
             * it and use what it stored instead of paying for the same pages
             * twice.
             */
            $lock = cdrDayFetchLock((string)$user['domain'], $date);
            if ($lock === null) {
                $waited = cdrDayWaitForFetcher($user, $date);
                if (is_array($waited)) {
                    $records = $waited['records'];
                    foreach ($records as $record) {
                        if (!is_array($record)) {
                            continue;
                        }
                        $merged[cdrCacheKey($record, count($merged))] = $record;
                    }
                    $records = [];
                    unset($cached, $fromNode);
                    $processedDays++;
                    if ($remainingDays !== [] && $remainingDays[0] === $date) {
                        array_shift($remainingDays);
                    }
                    $overflow = reportingProjectedOverflow(count($merged), $baselineBytes, $processedDays, $dayCounts, $remainingDays);
                    if ($overflow !== null) {
                        throw new ReportingLimitException($overflow);
                    }
                    continue;
                }
                /* Nothing arrived in time: fetch it ourselves rather than
                 * serve a short range. */
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
                    cdrDayFetchUnlock($lock ?? null);
                    throw $e;
                }
            }
            cdrDayFetchUnlock($lock ?? null);
        }

        foreach ($records as $record) {
            if (!is_array($record)) {
                continue;
            }
            $merged[cdrCacheKey($record, count($merged))] = $record;
        }

        /*
         * The day is in $merged now; the day's own array is the biggest
         * temporary in the loop, so let it go before the next one is loaded.
         */
        $records = [];
        unset($cached, $fromNode);
        $processedDays++;
        if ($remainingDays !== [] && $remainingDays[0] === $date) {
            array_shift($remainingDays);
        }
        $overflow = reportingProjectedOverflow(count($merged), $baselineBytes, $processedDays, $dayCounts, $remainingDays);
        if ($overflow !== null) {
            throw new ReportingLimitException($overflow);
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
    /*
     * "Cached" means the DAY CACHE has it fresh - not "a node-client JSONL
     * file happens to exist somewhere". The old check answered true for a node
     * file, so such a day was never imported (the warm loop skipped it,
     * warmCdrDay() returned early) and every request re-parsed the file from
     * scratch. The import now happens once - in warmCdrDay() or on the first
     * read - and this reports the truth afterwards.
     */
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
    /*
     * "Is it ready?" must mean "will a report find it in the CACHE", not "is
     * there a file somewhere". It used to answer yes for a node JSONL file,
     * which is how those days were never imported and every request re-parsed
     * them.
     */
    $ttl = cdrDayCacheTtl($date);
    $cachedReady = cdrDayCacheRead((string)$user['domain'], $date, $ttl);
    $ready = is_array($cachedReady) && !empty($cachedReady['complete'])
        && (int)($cachedReady['fetchedAt'] ?? 0) > 0
        && (time() - (int)$cachedReady['fetchedAt']) < $ttl;
    if (!$ready && isClosedRange($date)) {
        $nodeRows = readNodeDayJsonl($date);
        if (is_array($nodeRows)) {
            /* Import once: a report would have re-parsed this file on every
             * request; now it is read once here and served from the cache. */
            cdrDayCacheWrite((string)$user['domain'], $date, $nodeRows, true, count($nodeRows), true);
            return [
                'date' => $date,
                'complete' => true,
                'records' => count($nodeRows),
                'driver' => cdrCacheDriver(),
                'source' => 'node-jsonl',
            ];
        }
    }
    if ($ready) {
        return ['date' => $date, 'complete' => true, 'records' => count($cachedReady['records'] ?? [])];
    }

    /*
     * One fetcher per day: the loop below is driven by the UI while the report
     * request is doing its own fetches, so without this the same day was paid
     * for twice.
     */
    $lock = cdrDayFetchLock((string)$user['domain'], $date);
    if ($lock === null) {
        $waited = cdrDayWaitForFetcher($user, $date, 3000);
        if (is_array($waited)) {
            return [
                'date' => $date,
                'complete' => true,
                'records' => count($waited['records'] ?? []),
                'driver' => cdrCacheDriver(),
                'source' => 'waited',
            ];
        }
    }

    $client = new PbxClient((string)($_SESSION['token'] ?? ''));
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
    cdrDayFetchUnlock($lock);
    return [
        'date' => $date,
        'complete' => !empty($result['complete']),
        'records' => count($records),
        'driver' => cdrCacheDriver(),
    ];
}

/*
 * F2: warming a range longer than the 31-day supervisor window.
 *
 * One day per request is right for a week or a month, and wrong for the
 * manager's year-to-date range: 366 round-trips at ~600 ms each is minutes of a
 * progress bar, and the browser tab is the thing doing the pacing. This warms a
 * BATCH per request instead - days in date order, so the reader's most recent
 * (and most likely wanted) days land first - and stops on whichever of the
 * limits comes first: the day budget, or the time budget.
 *
 * The time budget is what keeps a request inside the gateway's own timeout; when
 * it trips, the response says so and the next request picks up at the same
 * `next` day, so the loop is resumable and never repeats a finished day
 * (warmCdrDay() is a no-op for a cached day).
 */
function warmCdrBatch(array $user, string $start, string $end, int $maxDays = 5, int $timeBudgetSeconds = 20): array
{
    $maxDays = max(1, min(31, $maxDays));
    $budget = max(1, $timeBudgetSeconds);
    $deadline = microtime(true) + $budget;
    $status = cdrRangeCacheStatus($user, $start, $end);
    $warmed = [];
    $attempted = 0;
    $reason = '';
    while (count($warmed) < $maxDays) {
        $status = cdrRangeCacheStatus($user, $start, $end);
        if (!empty($status['complete']) || empty($status['next'])) {
            break;
        }
        if (microtime(true) >= $deadline) {
            $reason = 'time';
            break;
        }
        $attempted++;
        $day = warmCdrDay($user, (string)$status['next']);
        if (!empty($day['complete'])) {
            $warmed[] = (string)$day['date'];
        } else {
            /* The upstream fetch did not finish the day; stop rather than spin
             * on it, and let the next request retry from its stored offset. */
            $reason = 'partial';
            break;
        }
    }
    $status = cdrRangeCacheStatus($user, $start, $end);
    if (!empty($status['complete'])) {
        $stopped = 'complete';
    } elseif ($reason !== '') {
        $stopped = $reason;
    } else {
        /* The loop ran out of its day budget with work still pending. */
        $stopped = 'days';
    }
    return [
        'attempted' => $attempted,
        'warmed' => count($warmed),
        'days' => $warmed,
        'stopped' => $stopped,
        'seconds' => round(microtime(true) - ($deadline - $budget), 2),
        'status' => $status,
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
