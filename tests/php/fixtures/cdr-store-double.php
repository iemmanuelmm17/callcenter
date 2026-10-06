<?php
declare(strict_types=1);

/**
 * A recording stand-in for the SQLite connection (test fixture).
 *
 * The PHP runtime in CI has no pdo_sqlite, so this double lets the REAL
 * includes/reporting/cdr_store.php + includes/reporting/cache.php run end to
 * end: it answers the store's own statements (which are the strings the store
 * builds, not rewritten SQL) and records everything it is asked to do.
 *
 * It is not an SQL engine. It pattern-matches the handful of statements the
 * store issues and keeps the same keys, so the PHP-side plumbing — read
 * through, resume pointer, completeness, replace-on-refresh — is exercised
 * for real. The SQL itself is proven against real SQLite in
 * tests/php/cdr-store.mjs (node:sqlite).
 */
final class CdrStoreDoubleStatement
{
    /** @var array<int, array{kind: string, params: array}> */
    public static array $journal = [];
    private array $rows = [];
    private int $cursor = 0;
    private int $affected = 0;

    public function __construct(private string $sql, private CdrStoreDoubleConnection $connection) {}

    public function execute(array $params = []): bool
    {
        $sql = preg_replace('/\s+/', ' ', trim($this->sql)) ?? $this->sql;
        $this->connection->record($sql, $params);
        $this->cursor = 0;

        if (str_starts_with($sql, 'INSERT INTO cdr_records')) {
            /* params: domain, tz, day, seq, key, start_ts, kind, agent, dept, site, raw */
            $this->connection->putRecord(
                (string)$params[0], (string)$params[1], (string)$params[2],
                [
                    'seq' => (int)$params[3],
                    'cdr_key' => (string)$params[4],
                    'start_ts' => $params[5],
                    'kind' => $params[6],
                    'agent' => $params[7],
                    'department' => $params[8],
                    'site' => $params[9],
                    'raw' => (string)$params[10]
                ]
            );
            $this->affected = 1;
            return true;
        }

        if (str_starts_with($sql, 'DELETE FROM cdr_records')) {
            $this->affected = str_contains($sql, 'day <')
                ? $this->connection->deleteRecordsBefore((string)$params[0], (string)$params[1], (string)$params[2])
                : $this->connection->deleteRecords((string)$params[0], (string)$params[1], (string)$params[2]);
            return true;
        }

        if (str_starts_with($sql, 'DELETE FROM cdr_days')) {
            $this->affected = str_contains($sql, 'day <')
                ? $this->connection->deleteDaysBefore((string)$params[0], (string)$params[1], (string)$params[2])
                : $this->connection->deleteDay((string)$params[0], (string)$params[1], (string)$params[2]);
            return true;
        }

        if (str_starts_with($sql, 'INSERT INTO cdr_days')) {
            /* params: domain, tz, day, complete, next_offset, domain, tz, day, fetched_at */
            $this->connection->putDay((string)$params[0], (string)$params[1], (string)$params[2], [
                'complete' => (int)$params[3],
                'next_offset' => (int)$params[4],
                'fetched_at' => (int)$params[8]
            ]);
            $this->affected = 1;
            return true;
        }

        if (str_starts_with($sql, 'SELECT complete, next_offset, record_count, fetched_at FROM cdr_days')) {
            $day = $this->connection->getDay((string)$params[0], (string)$params[1], (string)$params[2]);
            $this->rows = $day === null ? [] : [$day];
            return true;
        }

        if (str_starts_with($sql, 'SELECT raw FROM cdr_records')) {
            $this->rows = $this->connection->records((string)$params[0], (string)$params[1], (string)$params[2]);
            return true;
        }

        if (str_starts_with($sql, 'SELECT COUNT(*) AS days')) {
            $this->rows = [$this->connection->summary()];
            return true;
        }

        if (str_starts_with($sql, 'SELECT day, complete, next_offset, record_count, fetched_at FROM cdr_days')) {
            $this->rows = $this->connection->allDays();
            return true;
        }

        $this->rows = [];
        return true;
    }

    public function fetch(): mixed
    {
        if (!isset($this->rows[$this->cursor])) {
            return false;
        }
        return $this->rows[$this->cursor++];
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = $this->fetch();
        if (!is_array($row)) {
            return false;
        }
        $values = array_values($row);
        return $values[$column] ?? false;
    }

    public function rowCount(): int
    {
        return $this->affected;
    }

    /** Test helper: seed rows for a PRAGMA-style answer. */
    public function seedRows(array $rows): void
    {
        $this->rows = $rows;
        $this->cursor = 0;
    }
}

final class CdrStoreDoubleConnection
{
    /** @var array<string, array<string, array>> dayKey -> cdr_key -> row */
    private array $records = [];
    /** @var array<string, array> dayKey -> day row */
    private array $days = [];
    public bool $inTransaction = false;
    public int $commits = 0;
    public int $rollbacks = 0;

    public static function journal(): array
    {
        return CdrStoreDoubleStatement::$journal;
    }

    public static function resetJournal(): void
    {
        CdrStoreDoubleStatement::$journal = [];
    }

    public function record(string $sql, array $params): void
    {
        CdrStoreDoubleStatement::$journal[] = ['sql' => $sql, 'params' => $params];
    }

    public function prepare(string $sql): CdrStoreDoubleStatement
    {
        return new CdrStoreDoubleStatement($sql, $this);
    }

    public function exec(string $sql): int
    {
        $this->record((string)(preg_replace('/\s+/', ' ', trim($sql)) ?? $sql), []);
        return 0;
    }

    public function query(string $sql): CdrStoreDoubleStatement
    {
        $statement = new CdrStoreDoubleStatement($sql, $this);
        if (stripos($sql, 'user_version') !== false) {
            /* Fresh file: the store must create its schema. */
            $statement->execute([]);
            $statement->seedRows([['user_version' => 0]]);
        }
        return $statement;
    }

    public function beginTransaction(): bool
    {
        $this->inTransaction = true;
        return true;
    }

    public function commit(): bool
    {
        $this->inTransaction = false;
        $this->commits++;
        return true;
    }

    public function rollBack(): bool
    {
        $this->inTransaction = false;
        $this->rollbacks++;
        return true;
    }

    private static function dayKey(string $domain, string $tz, string $day): string
    {
        return $domain . '|' . $tz . '|' . $day;
    }

    public function putRecord(string $domain, string $tz, string $day, array $row): void
    {
        $key = self::dayKey($domain, $tz, $day);
        $existing = $this->records[$key][$row['cdr_key']] ?? [];
        $this->records[$key][$row['cdr_key']] = $row + $existing;
        /* record_count is maintained by the day statement, exactly like the
         * SQL subquery does it. */
        if (isset($this->days[$key])) {
            $this->days[$key]['record_count'] = count($this->records[$key]);
        }
    }

    public function deleteRecords(string $domain, string $tz, string $day): int
    {
        $key = self::dayKey($domain, $tz, $day);
        $removed = count($this->records[$key] ?? []);
        unset($this->records[$key]);
        return $removed;
    }

    /** `DELETE ... WHERE domain = ? AND tz = ? AND day < ?` (prune). */
    public function deleteRecordsBefore(string $domain, string $tz, string $beforeDay): int
    {
        $removed = 0;
        foreach (array_keys($this->records) as $key) {
            [$rowDomain, $rowTz, $rowDay] = explode('|', $key);
            if ($rowDomain === $domain && $rowTz === $tz && $rowDay < $beforeDay) {
                $removed += count($this->records[$key]);
                unset($this->records[$key]);
            }
        }
        return $removed;
    }

    public function deleteDaysBefore(string $domain, string $tz, string $beforeDay): int
    {
        $removed = 0;
        foreach (array_keys($this->days) as $key) {
            [$rowDomain, $rowTz, $rowDay] = explode('|', $key);
            if ($rowDomain === $domain && $rowTz === $tz && $rowDay < $beforeDay) {
                unset($this->days[$key]);
                $removed++;
            }
        }
        return $removed;
    }

    public function deleteDay(string $domain, string $tz, string $day): int
    {
        $key = self::dayKey($domain, $tz, $day);
        $existed = isset($this->days[$key]) ? 1 : 0;
        unset($this->days[$key]);
        return $existed;
    }

    public function putDay(string $domain, string $tz, string $day, array $row): void
    {
        $key = self::dayKey($domain, $tz, $day);
        $row['record_count'] = count($this->records[$key] ?? []);
        $this->days[$key] = $row;
    }

    public function getDay(string $domain, string $tz, string $day): ?array
    {
        return $this->days[self::dayKey($domain, $tz, $day)] ?? null;
    }

    /** Rows of one day, ordered by seq — what the SELECT ... ORDER BY seq returns. */
    public function records(string $domain, string $tz, string $day): array
    {
        $rows = array_values($this->records[self::dayKey($domain, $tz, $day)] ?? []);
        usort($rows, static fn(array $a, array $b) => $a['seq'] <=> $b['seq']);
        return array_map(static fn(array $row) => ['raw' => $row['raw']], $rows);
    }

    public function allDays(): array
    {
        return array_values($this->days);
    }

    public function summary(): array
    {
        $records = 0;
        $first = '';
        $last = '';
        foreach ($this->days as $key => $row) {
            $records += (int)$row['record_count'];
            [, , $day] = explode('|', $key);
            $first = $first === '' || $day < $first ? $day : $first;
            $last = $last === '' || $day > $last ? $day : $last;
        }
        return [
            'days' => count($this->days),
            'records' => $records,
            'first_day' => $first,
            'last_day' => $last
        ];
    }

    /** Test helper: how many times was a statement of this family executed? */
    public static function countStatements(string $prefix): int
    {
        $count = 0;
        foreach (CdrStoreDoubleStatement::$journal as $entry) {
            if (str_starts_with($entry['sql'], $prefix)) {
                $count++;
            }
        }
        return $count;
    }
}

/** The factory the store picks up through CDR_STORE_CONNECTION_FACTORY. */
function cdrStoreDoubleFactory(): CdrStoreDoubleConnection
{
    static $connection = null;
    if (!$connection instanceof CdrStoreDoubleConnection) {
        $connection = new CdrStoreDoubleConnection();
    }
    return $connection;
}
