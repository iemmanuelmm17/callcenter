<?php
declare(strict_types=1);

/**
 * SQLite CDR store — the day cache behind includes/reporting/cache.php.
 *
 * Why: the JSON day cache rewrote a whole day (up to a few MB) on every page
 * of a fetch, had no way to answer "is this day complete?" without reading the
 * whole file, and could not be queried at all. This store keeps the same
 * per-day completeness contract in a real database:
 *
 *   cdr_days     one row per (domain, timezone, day): complete, next_offset,
 *                record_count, fetched_at
 *   cdr_records  one row per CDR: the raw JSON exactly as the PBX returned it,
 *                plus the columns the UI filters on (start_ts, kind, agent,
 *                department, site) and the position inside the day (seq)
 *
 * Guarantees
 *   - Writes are atomic per page: the records of a page and the day's
 *     completeness fields land in one transaction, so a killed request cannot
 *     leave a day marked complete without its records.
 *   - Upserts are idempotent on (domain, timezone, day, cdr_key). When a fetch
 *     is resumed, only the rows that are not stored yet are sent (the tail of
 *     the accumulated list), so a 100k-record day costs 400 small transactions
 *     instead of 400 full rewrites.
 *   - `raw` is the source of truth. The derived columns are a snapshot taken
 *     when the row was written, computed WITHOUT the PBX user directory, and
 *     they are only used for indexing/statistics — the reporting layer still
 *     classifies each row with the live directory (normalizeCdrs()), because
 *     `_type`, `_agent`, `_department` and `_site` depend on it.
 *   - The timezone is part of the key, exactly like the JSON filenames hash it
 *     in: changing DEFAULT_TIMEZONE invalidates the cache instead of silently
 *     mixing two definitions of "a day".
 *
 * Driver selection lives in cdrCacheDriver(): 'auto' uses this store when
 * pdo_sqlite is available and falls back to the JSON day cache otherwise, and
 * CDR_CACHE_DRIVER forces one of the two.
 */

if (!defined('CDR_STORE_SCHEMA_VERSION')) {
    define('CDR_STORE_SCHEMA_VERSION', 1);
}

/**
 * Which day-cache storage is in use: 'sqlite' or 'json'.
 *
 * 'auto' (the default) prefers SQLite and falls back to the JSON files when
 * the runtime has no pdo_sqlite driver, so the same code runs on a host that
 * cannot do SQLite. Forcing 'sqlite' without the extension logs why it fell
 * back rather than failing the request.
 */
function cdrCacheDriver(): string
{
    $configured = defined('CDR_CACHE_DRIVER') ? strtolower(trim((string)CDR_CACHE_DRIVER)) : 'auto';
    if ($configured === 'json') {
        return 'json';
    }
    if (!cdrStoreAvailable()) {
        if ($configured === 'sqlite') {
            appLog('CDR store: CDR_CACHE_DRIVER is "sqlite" but pdo_sqlite is not available — using the JSON day cache');
        }
        return 'json';
    }
    return 'sqlite';
}

/**
 * Is a SQLite connection possible here?
 *
 * The test seam (CDR_STORE_CONNECTION_FACTORY) counts as available: it lets the
 * PHP suite exercise the store's statement handling on a runtime without
 * pdo_sqlite, against a recording connection.
 */
function cdrStoreAvailable(): bool
{
    if (cdrStoreFactory() !== null) {
        return true;
    }
    return extension_loaded('pdo_sqlite') && in_array('sqlite', PDO::getAvailableDrivers(), true);
}

/** The store file; CDR_STORE_FILE overrides the default inside CACHE_DIR. */
function cdrStoreFile(): string
{
    if (defined('CDR_STORE_FILE') && trim((string)CDR_STORE_FILE) !== '') {
        return (string)CDR_STORE_FILE;
    }
    return CACHE_DIR . '/cdrs.sqlite';
}

/**
 * Optional connection factory: the name of a callable returning an object with
 * prepare / exec / beginTransaction / commit / rollBack / query. A deployment
 * never defines this; the PHP test suite uses it to drive the store without a
 * SQLite driver (see tests/php/cdr-store.mjs).
 */
function cdrStoreFactory(): ?callable
{
    if (!defined('CDR_STORE_CONNECTION_FACTORY')) {
        return null;
    }
    $name = CDR_STORE_CONNECTION_FACTORY;
    return is_string($name) && $name !== '' && is_callable($name) ? $name : null;
}

/** Connection pragmas, applied on every open. Exposed for the SQL contract test. */
function cdrStorePragmas(): array
{
    return [
        /* Readers never block the writer and a killed request cannot corrupt
         * the file. NORMAL is the documented WAL pairing: the last transaction
         * can be lost in a power cut, but the cache is rebuildable from the
         * PBX, so durability of a cache write is not worth a full fsync. */
        'PRAGMA journal_mode = WAL',
        'PRAGMA synchronous = NORMAL',
        'PRAGMA busy_timeout = 5000',
        'PRAGMA temp_store = MEMORY',
        /* Keep the file from growing forever after day rewrites; VACUUM (the
         * CLI "vacuum" command) reclaims what the freelist holds. */
        'PRAGMA auto_vacuum = INCREMENTAL'
    ];
}

/** Schema statements. Exposed so the SQL contract test applies exactly these. */
function cdrStoreSchemaSql(): array
{
    return [
        'CREATE TABLE IF NOT EXISTS cdr_days (
            domain       TEXT    NOT NULL,
            tz           TEXT    NOT NULL,
            day          TEXT    NOT NULL,
            complete     INTEGER NOT NULL DEFAULT 0,
            next_offset  INTEGER NOT NULL DEFAULT 0,
            record_count INTEGER NOT NULL DEFAULT 0,
            fetched_at   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (domain, tz, day)
        ) WITHOUT ROWID',
        'CREATE TABLE IF NOT EXISTS cdr_records (
            domain     TEXT    NOT NULL,
            tz         TEXT    NOT NULL,
            day        TEXT    NOT NULL,
            seq        INTEGER NOT NULL DEFAULT 0,
            cdr_key    TEXT    NOT NULL,
            start_ts   INTEGER,
            kind       TEXT,
            agent      TEXT,
            department TEXT,
            site       TEXT,
            raw        TEXT    NOT NULL,
            PRIMARY KEY (domain, tz, day, cdr_key)
        ) WITHOUT ROWID',
        /* The range read: one day, in PBX order. */
        'CREATE INDEX IF NOT EXISTS cdr_records_day_seq ON cdr_records (domain, tz, day, seq)',
        /* The dimensions the UI filters on. department/site are deliberately
         * left unindexed: they are low-cardinality free text that a covering
         * scan of one day answers just as fast, and every extra index costs
         * write time on the insert path. */
        'CREATE INDEX IF NOT EXISTS cdr_records_kind ON cdr_records (domain, tz, kind, start_ts)',
        'CREATE INDEX IF NOT EXISTS cdr_records_agent ON cdr_records (domain, tz, agent, start_ts)',
        'CREATE INDEX IF NOT EXISTS cdr_records_start ON cdr_records (domain, tz, start_ts)',
        'PRAGMA user_version = ' . CDR_STORE_SCHEMA_VERSION
    ];
}

/** The raw-record upsert. One prepared statement per write call. */
function cdrStoreInsertSql(): string
{
    return 'INSERT INTO cdr_records (domain, tz, day, seq, cdr_key, start_ts, kind, agent, department, site, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (domain, tz, day, cdr_key) DO UPDATE SET
            seq = excluded.seq,
            start_ts = excluded.start_ts,
            kind = excluded.kind,
            agent = excluded.agent,
            department = excluded.department,
            site = excluded.site,
            raw = excluded.raw';
}

/** The per-day completeness upsert; record_count is computed from the records. */
function cdrStoreDaySql(): string
{
    return 'INSERT INTO cdr_days (domain, tz, day, complete, next_offset, record_count, fetched_at)
        VALUES (?, ?, ?, ?, ?, (SELECT COUNT(*) FROM cdr_records WHERE domain = ? AND tz = ? AND day = ?), ?)
        ON CONFLICT (domain, tz, day) DO UPDATE SET
            complete = excluded.complete,
            next_offset = excluded.next_offset,
            record_count = excluded.record_count,
            fetched_at = excluded.fetched_at';
}

/**
 * The store connection, or null when SQLite is unavailable or the file cannot
 * be opened. Cached per request: the schema check runs once per connection.
 */
function cdrStore(): ?object
{
    static $store = null;
    static $attempted = false;
    if ($attempted) {
        return $store;
    }
    $attempted = true;

    $factory = cdrStoreFactory();
    if ($factory !== null) {
        $candidate = $factory();
        if (!is_object($candidate)) {
            appLog('CDR store: CDR_STORE_CONNECTION_FACTORY did not return an object');
            return null;
        }
        try {
            cdrStoreEnsureSchema($candidate);
        } catch (Throwable $e) {
            appExceptionLog('CDR store schema', $e);
            return null;
        }
        $store = $candidate;
        return $store;
    }

    if (!cdrStoreAvailable()) {
        return null;
    }

    $file = cdrStoreFile();
    $directory = dirname($file);
    if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {
        appLog("CDR store: cannot create {$directory}");
        return null;
    }

    try {
        $pdo = new PDO('sqlite:' . $file, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
        ]);
        foreach (cdrStorePragmas() as $pragma) {
            $pdo->exec($pragma);
        }
        cdrStoreEnsureSchema($pdo);
        $store = $pdo;
        cdrStoreLogJournalMode($pdo);
    } catch (Throwable $e) {
        appExceptionLog('CDR store open', $e);
        $store = null;
    }

    return $store;
}

/**
 * Warn once when the journal mode is not WAL: on a filesystem that cannot do
 * WAL (some network mounts) SQLite silently keeps the previous mode, and the
 * symptom would otherwise be mysterious "database is locked" errors later.
 */
function cdrStoreLogJournalMode(object $store): void
{
    try {
        $mode = strtolower((string)$store->query('PRAGMA journal_mode')->fetchColumn());
    } catch (Throwable $e) {
        return;
    }
    if ($mode !== '' && $mode !== 'wal') {
        appLog("CDR store: journal_mode is {$mode}, not WAL — the cache directory may not support it");
    }
}

/** Create or upgrade the schema, once per connection. */
function cdrStoreEnsureSchema(object $store): void
{
    static $done = [];
    $id = spl_object_id($store);
    if (isset($done[$id])) {
        return;
    }

    $version = 0;
    try {
        $version = (int)$store->query('PRAGMA user_version')->fetchColumn();
    } catch (Throwable $e) {
        /* A fresh file, or a connection that cannot answer PRAGMA yet. */
    }

    if ($version < CDR_STORE_SCHEMA_VERSION) {
        foreach (cdrStoreSchemaSql() as $sql) {
            try {
                $store->exec($sql);
            } catch (Throwable $e) {
                /* Two requests can race on CREATE TABLE; the loser only needs
                 * to wait for the winner's lock (busy_timeout) and retry once. */
                usleep(200000);
                $store->exec($sql);
            }
        }
    } elseif ($version > CDR_STORE_SCHEMA_VERSION) {
        appLog("CDR store: file has schema {$version}, this build knows " . CDR_STORE_SCHEMA_VERSION);
    }

    $done[$id] = true;
}

/**
 * The indexed columns for one CDR. Directory-free on purpose (see the file
 * header): $fallback is the row's position inside the day, used to key records
 * that carry no id of their own — the same rule as cdrCacheKey().
 */
function cdrStoreRow(array $record, int $fallback): array
{
    $start = parseEasternDateTime((string)(
        $record['call-start-datetime']
        ?? $record['call-batch-start-datetime']
        ?? ''
    ));

    return [
        'key' => cdrCacheKey($record, $fallback),
        'start_ts' => $start instanceof DateTimeImmutable ? $start->getTimestamp() : null,
        'kind' => classifyCdrType($record, []),
        'agent' => callAgent($record),
        'department' => callDepartment($record),
        'site' => callSite($record)
    ];
}

/** Metadata for one cached day, without reading a single record. */
function cdrStoreDayMeta(string $domain, string $day): array
{
    $empty = ['exists' => false, 'complete' => false, 'nextOffset' => 0, 'records' => 0, 'fetchedAt' => 0];
    $store = cdrStore();
    if ($store === null) {
        return $empty;
    }
    try {
        $statement = $store->prepare(
            'SELECT complete, next_offset, record_count, fetched_at FROM cdr_days WHERE domain = ? AND tz = ? AND day = ?'
        );
        $statement->execute([(string)$domain, cdrStoreTimezone(), substr($day, 0, 10)]);
        $row = $statement->fetch();
    } catch (Throwable $e) {
        appExceptionLog('CDR store meta', $e);
        return $empty;
    }
    if (!is_array($row)) {
        return $empty;
    }

    return [
        'exists' => true,
        'complete' => !empty($row['complete']),
        'nextOffset' => (int)($row['next_offset'] ?? 0),
        'records' => (int)($row['record_count'] ?? 0),
        'fetchedAt' => (int)($row['fetched_at'] ?? 0)
    ];
}

/** Rows stored for one day. */
function cdrStoreDayCount(string $domain, string $day): int
{
    return cdrStoreDayMeta($domain, $day)['records'];
}

/**
 * One cached day in the same shape the JSON reader returns, or null when the
 * day is not in the store at all.
 *
 *   ['complete' => bool, 'nextOffset' => int, 'records' => array, 'fetchedAt' => int]
 */
function cdrStoreDayLoad(string $domain, string $day): ?array
{
    $store = cdrStore();
    if ($store === null) {
        return null;
    }
    $meta = cdrStoreDayMeta($domain, $day);
    if (!$meta['exists']) {
        return null;
    }

    $records = [];
    try {
        $statement = $store->prepare(
            'SELECT raw FROM cdr_records WHERE domain = ? AND tz = ? AND day = ? ORDER BY seq'
        );
        $statement->execute([(string)$domain, cdrStoreTimezone(), substr($day, 0, 10)]);
        while (($row = $statement->fetch()) !== false) {
            if (!is_array($row) || !isset($row['raw'])) {
                continue;
            }
            $record = json_decode((string)$row['raw'], true);
            if (is_array($record)) {
                /* Rows stored before the trim carry every PBX field. Trimming
                 * on the way out is what makes an existing cache cheap; new
                 * rows are stored trimmed already (includes/PbxClient.php). */
                $records[] = cdrTrimRecord($record);
            }
        }
    } catch (Throwable $e) {
        appExceptionLog('CDR store read', $e);
        return null;
    }

    return [
        'complete' => $meta['complete'],
        'nextOffset' => $meta['nextOffset'],
        'records' => $records,
        'fetchedAt' => $meta['fetchedAt']
    ];
}

/**
 * Write the records of one fetch page.
 *
 * $records is the accumulated day (the PBX list so far), exactly what the JSON
 * writer receives. Only the rows that are not stored yet are inserted, so a
 * resumed fetch appends instead of rewriting the day. $replace is passed by the
 * caller for the first page of a fresh fetch — it deletes the day's rows first,
 * which is how a day that the PBX has since corrected stops keeping stale rows.
 */
function cdrStoreDayWrite(string $domain, string $day, array $records, bool $complete, int $nextOffset, bool $replace = false): void
{
    $store = cdrStore();
    if ($store === null) {
        return;
    }
    $day = substr($day, 0, 10);
    $tz = cdrStoreTimezone();

    $rows = [];
    foreach ($records as $record) {
        if (is_array($record)) {
            $rows[] = $record;
        }
    }

    $stored = $replace ? 0 : cdrStoreDayCount($domain, $day);
    if ($stored > count($rows)) {
        /* The store holds more than the fetch handed us (a re-fetch that came
         * back shorter): rewrite the known range instead of guessing. */
        $stored = 0;
    }
    $tail = array_slice($rows, $stored);

    try {
        $store->beginTransaction();
        if ($replace) {
            $delete = $store->prepare('DELETE FROM cdr_records WHERE domain = ? AND tz = ? AND day = ?');
            $delete->execute([(string)$domain, $tz, $day]);
        }
        if ($tail !== []) {
            $insert = $store->prepare(cdrStoreInsertSql());
            foreach ($tail as $offset => $record) {
                $row = cdrStoreRow($record, $stored + (int)$offset);
                $insert->execute([
                    (string)$domain,
                    $tz,
                    $day,
                    $stored + (int)$offset,
                    $row['key'],
                    $row['start_ts'],
                    $row['kind'],
                    $row['agent'],
                    $row['department'],
                    $row['site'],
                    json_encode($record, JSON_UNESCAPED_SLASHES)
                ]);
            }
        }
        $mark = $store->prepare(cdrStoreDaySql());
        $mark->execute([
            (string)$domain,
            $tz,
            $day,
            $complete ? 1 : 0,
            max(0, $nextOffset),
            (string)$domain,
            $tz,
            $day,
            time()
        ]);
        $store->commit();
    } catch (Throwable $e) {
        try {
            $store->rollBack();
        } catch (Throwable $ignored) {
            /* Already rolled back, or the connection died. */
        }
        /* The request must still return its data: a cache that cannot be
         * written is a slow request, not a failed one. */
        appExceptionLog("CDR store write {$domain} {$day}", $e);
    }
}

/** Drop one cached day. Returns the number of records removed. */
function cdrStoreDayDelete(string $domain, string $day): int
{
    $store = cdrStore();
    if ($store === null) {
        return 0;
    }
    $tz = cdrStoreTimezone();
    $day = substr($day, 0, 10);
    try {
        $statement = $store->prepare('DELETE FROM cdr_records WHERE domain = ? AND tz = ? AND day = ?');
        $statement->execute([(string)$domain, $tz, $day]);
        $removed = $statement->rowCount();
        $store->prepare('DELETE FROM cdr_days WHERE domain = ? AND tz = ? AND day = ?')
            ->execute([(string)$domain, $tz, $day]);
    } catch (Throwable $e) {
        appExceptionLog('CDR store delete', $e);
        return 0;
    }
    return max(0, $removed);
}

/** Store-wide statistics for the CLI and for operational logs. */
function cdrStoreStatus(?string $domain = null): array
{
    $status = [
        'driver' => cdrCacheDriver(),
        'file' => cdrStoreFile(),
        'available' => cdrStoreAvailable(),
        'schemaVersion' => CDR_STORE_SCHEMA_VERSION,
        'size' => is_file(cdrStoreFile()) ? (int)filesize(cdrStoreFile()) : 0,
        'journalMode' => '',
        'days' => 0,
        'records' => 0,
        'firstDay' => '',
        'lastDay' => ''
    ];

    $store = cdrStore();
    if ($store === null) {
        return $status;
    }

    try {
        $status['journalMode'] = strtolower((string)$store->query('PRAGMA journal_mode')->fetchColumn());
        $sql = 'SELECT COUNT(*) AS days, COALESCE(SUM(record_count), 0) AS records, MIN(day) AS first_day, MAX(day) AS last_day FROM cdr_days';
        $params = [];
        if ($domain !== null && $domain !== '') {
            $sql .= ' WHERE domain = ?';
            $params[] = $domain;
        }
        $statement = $store->prepare($sql);
        $statement->execute($params);
        $row = $statement->fetch();
        if (is_array($row)) {
            $status['days'] = (int)($row['days'] ?? 0);
            $status['records'] = (int)($row['records'] ?? 0);
            $status['firstDay'] = (string)($row['first_day'] ?? '');
            $status['lastDay'] = (string)($row['last_day'] ?? '');
        }
    } catch (Throwable $e) {
        appExceptionLog('CDR store status', $e);
    }

    return $status;
}

/** Remove every cached day before $beforeDay. Returns [days, records]. */
function cdrStorePrune(string $domain, string $beforeDay): array
{
    $store = cdrStore();
    if ($store === null) {
        return ['days' => 0, 'records' => 0];
    }
    $tz = cdrStoreTimezone();
    $beforeDay = substr($beforeDay, 0, 10);
    try {
        $records = $store->prepare('DELETE FROM cdr_records WHERE domain = ? AND tz = ? AND day < ?');
        $records->execute([$domain, $tz, $beforeDay]);
        $days = $store->prepare('DELETE FROM cdr_days WHERE domain = ? AND tz = ? AND day < ?');
        $days->execute([$domain, $tz, $beforeDay]);
    } catch (Throwable $e) {
        appExceptionLog('CDR store prune', $e);
        return ['days' => 0, 'records' => 0];
    }
    return ['days' => max(0, $days->rowCount()), 'records' => max(0, $records->rowCount())];
}

/** Reclaim free pages after a prune. VACUUM cannot run inside a transaction. */
function cdrStoreVacuum(): bool
{
    $store = cdrStore();
    if ($store === null) {
        return false;
    }
    try {
        $store->exec('VACUUM');
        return true;
    } catch (Throwable $e) {
        appExceptionLog('CDR store vacuum', $e);
        return false;
    }
}

/**
 * Compare a JSON day cache with the store, for the CLI "verify" command:
 * same number of records, same keys, same completeness. Pure — the caller
 * loads both sides, so this has no database dependency and is unit tested.
 */
function cdrStoreCompareDay(array $jsonDay, array $storeDay): array
{
    $keys = static function (array $records): array {
        $out = [];
        foreach (array_values($records) as $index => $record) {
            if (!is_array($record)) {
                continue;
            }
            $out[cdrCacheKey($record, $index)] = true;
        }
        return $out;
    };

    $jsonKeys = $keys($jsonDay['records'] ?? []);
    $storeKeys = $keys($storeDay['records'] ?? []);
    $missing = array_keys(array_diff_key($jsonKeys, $storeKeys));
    $extra = array_keys(array_diff_key($storeKeys, $jsonKeys));

    return [
        'same' => $missing === [] && $extra === []
            && count($jsonKeys) === count($storeKeys)
            && (bool)($jsonDay['complete'] ?? false) === (bool)($storeDay['complete'] ?? false),
        'json' => count($jsonKeys),
        'store' => count($storeKeys),
        'missing' => array_slice($missing, 0, 5),
        'extra' => array_slice($extra, 0, 5),
        'jsonComplete' => (bool)($jsonDay['complete'] ?? false),
        'storeComplete' => (bool)($storeDay['complete'] ?? false)
    ];
}

/** The timezone name that is part of every store key. */
function cdrStoreTimezone(): string
{
    return reportingTimezone()->getName();
}
