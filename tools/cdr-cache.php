<?php
declare(strict_types=1);

/**
 * CDR cache CLI.
 *
 *   php tools/cdr-cache.php status [domain]
 *   php tools/cdr-cache.php days   <domain> [limit]
 *   php tools/cdr-cache.php import <domain> <first-day> [last-day] [--delete-json]
 *   php tools/cdr-cache.php prune  <domain> <before-day> [--vacuum]
 *   php tools/cdr-cache.php verify <domain> [limit]
 *   php tools/cdr-cache.php promote [limit]
 *
 * Only the operator runs this. It is not part of the web application and is not
 * deployed; it is here because moving a live cache between backends (JSON day
 * files → SQLite) needs a tool that can be read before it is run and that
 * reports what it did for every day.
 *
 * Every command is idempotent: import re-reads a day file and upserts it, so
 * running the whole thing twice changes nothing the second time.
 *
 * The CLI runs from the repository root with the same includes as the web app,
 * but without a session. It refuses to touch a database when the configured
 * driver is json, unless --force says the operator really means it.
 */
/* A real CLI SAPI defines these; an embedded one (php-wasm, which the test
 * suite uses) does not, so define what is missing rather than failing. */
if (!defined('STDOUT')) {
    define('STDOUT', fopen('php://stdout', 'wb'));
}
if (!defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}
/**
 * Where diagnostics go.
 *
 * On a real CLI that is STDERR, as one would expect. An embedded SAPI has no
 * stderr stream the caller can see (php-wasm's build writes it into the void),
 * so there the message goes to STDOUT: an operator running the tool through a
 * wrapper must still see why it refused.
 */
function cliDiag()
{
    if (PHP_SAPI === 'cli' && is_resource(STDERR)) {
        return STDERR;
    }
    return STDOUT;
}
/* Refuse to run under a web SAPI: this tool rewrites the cache and must not be
 * reachable from a request. The CLI variants are all fine ('embed' is what an
 * embedded PHP such as php-wasm reports, and is how the test suite drives it). */
if (!in_array(PHP_SAPI, ['cli', 'embed', 'phpdbg'], true)) {
    fwrite(cliDiag(), "This tool only runs from the command line (SAPI: " . PHP_SAPI . ").\n");
    exit(2);
}

require_once __DIR__ . '/../includes/reporting.php';

$argvList = $_SERVER['argv'] ?? [];
$rawArgs = array_slice($argvList, 1);
$flags = array_values(array_filter($rawArgs, fn($arg) => str_starts_with($arg, '--')));
$args = array_values(array_filter($rawArgs, fn($arg) => !str_starts_with($arg, '--')));
$command = $args[0] ?? 'help';
$force = in_array('--force', $flags, true);
$deleteJson = in_array('--delete-json', $flags, true);
$vacuumAfter = in_array('--vacuum', $flags, true);

function cliOut(string $line = ''): void
{
    fwrite(STDOUT, $line . "\n");
}

function cliFail(string $message): never
{
    fwrite(cliDiag(), "error: {$message}\n");
    /* Flush before exiting: an embedded SAPI drops an unflushed stream. */
    if (defined('STDERR') && is_resource(STDERR)) {
        fflush(STDERR);
    }
    fflush(STDOUT);
    exit(1);
}

function cliBytes(int $bytes): string
{
    $units = ['B', 'kB', 'MB', 'GB'];
    $value = (float)$bytes;
    $unit = 0;
    while ($value >= 1024 && $unit < count($units) - 1) {
        $value /= 1024;
        $unit++;
    }
    return number_format($value, $unit === 0 ? 0 : 1) . ' ' . $units[$unit];
}

function cliRequireStore(): void
{
    if (!cdrStoreAvailable()) {
        cliFail('this PHP has no pdo_sqlite driver — nothing to do');
    }
    if (cdrStore() === null) {
        cliFail('could not open ' . cdrStoreFile());
    }
}

function cliDriverNotice(): void
{
    if (cdrCacheDriver() !== 'sqlite') {
        cliOut('note: CDR_CACHE_DRIVER is not "sqlite", so the web app keeps using the JSON day cache.');
        cliOut('      Set CDR_CACHE_DRIVER=sqlite (config.local.php or environment) to switch it over.');
    }
}

/** Day files in CACHE_DIR, oldest name order, as ['file' => absolute, 'mtime' => int]. */
function cliDayCacheFiles(): array
{
    $files = glob(CACHE_DIR . '/cdr-day-*.json');
    if (!is_array($files)) {
        return [];
    }
    $out = [];
    foreach ($files as $file) {
        $out[] = ['file' => $file, 'mtime' => (int)filemtime($file)];
    }
    usort($out, static fn(array $a, array $b) => $a['mtime'] <=> $b['mtime']);
    return $out;
}

/**
 * Import needs to know which day a file holds, but the filename is a hash of
 * domain + day + servers, so the day is read from the records themselves. That
 * is also a check: a file whose records disagree with the requested range is
 * reported instead of silently imported under the wrong day.
 */
function cliDaysInFile(string $file): array
{
    $cached = readCdrDayCache($file);
    if (!is_array($cached)) {
        return [];
    }
    $days = [];
    foreach ($cached['records'] as $index => $record) {
        if (!is_array($record)) {
            continue;
        }
        $day = callLocalDate($record);
        if ($day === '') {
            continue;
        }
        $days[$day] = true;
    }
    return array_keys($days);
}

function cliImportDay(string $domain, string $file, bool $deleteJson, array &$totals): void
{
    $cached = readCdrDayCache($file);
    if (!is_array($cached)) {
        $totals['skipped']++;
        cliOut('  skip   unreadable ' . basename($file));
        return;
    }
    $days = cliDaysInFile($file);
    if ($days === []) {
        $totals['skipped']++;
        cliOut('  skip   no readable date in ' . basename($file));
        return;
    }
    foreach ($days as $day) {
        $records = [];
        foreach ($cached['records'] as $record) {
            if (is_array($record) && callLocalDate($record) === $day) {
                $records[] = $record;
            }
        }
        cdrStoreDayWrite($domain, $day, $records, !empty($cached['complete']), (int)$cached['nextOffset'], true);
        $meta = cdrStoreDayMeta($domain, $day);
        $totals['days']++;
        $totals['records'] += (int)$meta['records'];
        cliOut(sprintf(
            '  import %s  %5d records  %s',
            $day,
            (int)$meta['records'],
            !empty($meta['complete']) ? 'complete' : 'partial'
        ));
    }
    if ($deleteJson) {
        if (@unlink($file)) {
            $totals['deleted']++;
        } else {
            $totals['deleteFailed']++;
        }
    }
}

switch ($command) {
    case 'status':
        $domain = $args[1] ?? null;
        $status = cdrStoreStatus($domain);
        cliOut('CDR cache');
        cliOut('  driver          ' . $status['driver'] . ($status['available'] ? '' : '  (pdo_sqlite not available)'));
        cliOut('  store file      ' . $status['file'] . '  (' . cliBytes((int)$status['size']) . ')');
        cliOut('  journal mode    ' . ($status['journalMode'] !== '' ? $status['journalMode'] : 'n/a'));
        cliOut('  schema version  ' . $status['schemaVersion']);
        cliOut('  days            ' . $status['days']);
        cliOut('  records         ' . number_format((int)$status['records']));
        if ($status['firstDay'] !== '') {
            cliOut('  days covered    ' . $status['firstDay'] . ' … ' . $status['lastDay']);
        }
        cliOut('  json day files  ' . count(cliDayCacheFiles()));
        cliDriverNotice();
        break;

    case 'days':
        cliRequireStore();
        $domain = $args[1] ?? cliFail('days needs a domain');
        $limit = (int)($args[2] ?? 20);
        $store = cdrStore();
        $statement = $store->prepare(
            'SELECT day, complete, next_offset, record_count, fetched_at FROM cdr_days WHERE domain = ? ORDER BY day DESC LIMIT ?'
        );
        $statement->execute([(string)$domain, max(1, $limit)]);
        cliOut("days for {$domain}");
        while (($row = $statement->fetch()) !== false) {
            cliOut(sprintf(
                '  %s  %7d records  %-8s next_offset=%-8d fetched %s',
                (string)$row['day'],
                (int)$row['record_count'],
                !empty($row['complete']) ? 'complete' : 'partial',
                (int)$row['next_offset'],
                gmdate('Y-m-d H:i', (int)$row['fetched_at'])
            ));
        }
        break;

    case 'import':
        /* Driver first: an operator who forgot the switch should hear about
         * that, not about a missing driver. */
        if (!$force && cdrCacheDriver() !== 'sqlite') {
            cliFail('CDR_CACHE_DRIVER is not "sqlite"; pass --force to import anyway');
        }
        cliRequireStore();
        $domain = $args[1] ?? cliFail('import needs a domain');
        $first = $args[2] ?? '';
        $last = $args[3] ?? '';
        $totals = ['days' => 0, 'records' => 0, 'skipped' => 0, 'deleted' => 0, 'deleteFailed' => 0];
        $files = cliDayCacheFiles();
        cliOut('importing ' . count($files) . ' day file(s) into ' . cdrStoreFile());
        foreach ($files as $entry) {
            $days = cliDaysInFile($entry['file']);
            if ($first !== '' && $last !== '') {
                $days = array_values(array_filter(
                    $days,
                    static fn(string $day) => $day >= substr($first, 0, 10) && $day <= substr($last, 0, 10)
                ));
                if ($days === []) {
                    continue;
                }
            }
            cliImportDay((string)$domain, $entry['file'], $deleteJson, $totals);
        }
        cliOut(sprintf(
            'imported %d day(s), %d record(s); skipped %d file(s)',
            $totals['days'],
            $totals['records'],
            $totals['skipped']
        ));
        if ($deleteJson) {
            cliOut('deleted ' . $totals['deleted'] . ' json file(s)' . ($totals['deleteFailed'] ? ", {$totals['deleteFailed']} could not be removed" : ''));
        }
        if ($vacuumAfter) {
            cliOut(cdrStoreVacuum() ? 'vacuum done' : 'vacuum failed (see logs/app-*.log)');
        }
        break;

    case 'prune':
        cliRequireStore();
        $domain = $args[1] ?? cliFail('prune needs a domain');
        $before = $args[2] ?? cliFail('prune needs a before-day');
        $removed = cdrStorePrune((string)$domain, (string)$before);
        cliOut(sprintf('pruned %d day(s), %d record(s) older than %s', $removed['days'], $removed['records'], substr($before, 0, 10)));
        if ($vacuumAfter || $removed['days'] > 0) {
            cliOut(cdrStoreVacuum() ? 'vacuum done' : 'vacuum failed (see logs/app-*.log)');
        }
        break;

    /*
     * Convert v1 day files (one JSON document each) to v2 (a header line plus
     * one record per line). Reads inside the app already promote a day on the
     * way past, so this is for doing it deliberately - after an upgrade, in
     * one pass, without a user waiting for a request that touches 90 days.
     * One day at a time: the peak is the largest day, not the cache.
     */
    case 'promote':
        $limit = (int)($args[1] ?? 0);
        $converted = 0;
        $already = 0;
        $failed = 0;
        $skipped = 0;
        foreach (cliDayCacheFiles() as $entry) {
            if ($limit > 0 && $converted + $already + $skipped >= $limit) {
                break;
            }
            if (cdrDayCacheReadHeader($entry['file']) !== null) {
                $already++;
                continue;
            }
            $cached = readCdrDayCache($entry['file']);
            if (!is_array($cached)) {
                $skipped++;
                continue;
            }
            if (cdrDayCacheReadHeader($entry['file']) !== null) {
                $converted++;
                continue;
            }
            $failed++;
        }
        cliOut(sprintf('promoted %d day file(s); %d already in the new format, %d unreadable, %d failed', $converted, $already, $skipped, $failed));
        break;

    case 'verify':
        cliRequireStore();
        $domain = $args[1] ?? cliFail('verify needs a domain');
        $limit = (int)($args[2] ?? 5);
        $checked = 0;
        $mismatched = 0;
        foreach (cliDayCacheFiles() as $entry) {
            if ($checked >= $limit) {
                break;
            }
            $cached = readCdrDayCache($entry['file']);
            $days = cliDaysInFile($entry['file']);
            if (!is_array($cached) || $days === []) {
                continue;
            }
            $checked++;
            foreach ($days as $day) {
                $storeDay = cdrStoreDayLoad($domain, $day);
                if ($storeDay === null) {
                    cliOut("  {$day}  not in the store");
                    $mismatched++;
                    continue;
                }
                $records = [];
                foreach ($cached['records'] as $record) {
                    if (is_array($record) && callLocalDate($record) === $day) {
                        $records[] = $record;
                    }
                }
                $comparison = cdrStoreCompareDay(
                    ['complete' => !empty($cached['complete']), 'records' => $records],
                    $storeDay
                );
                if ($comparison['same']) {
                    cliOut("  {$day}  ok ({$comparison['store']} records)");
                } else {
                    $mismatched++;
                    cliOut(sprintf(
                        '  %s  MISMATCH json=%d store=%d missing=%d extra=%d complete=%s/%s',
                        $day,
                        $comparison['json'],
                        $comparison['store'],
                        count($comparison['missing']),
                        count($comparison['extra']),
                        $comparison['jsonComplete'] ? 'yes' : 'no',
                        $comparison['storeComplete'] ? 'yes' : 'no'
                    ));
                }
            }
        }
        cliOut($mismatched === 0 ? "verified {$checked} file(s): json and store agree" : "{$mismatched} mismatch(es) — investigate before deleting json files");
        break;

    default:
        cliOut('usage:');
        cliOut('  php tools/cdr-cache.php status [domain]');
        cliOut('  php tools/cdr-cache.php days   <domain> [limit]');
        cliOut('  php tools/cdr-cache.php import <domain> [first-day] [last-day] [--delete-json] [--vacuum] [--force]');
        cliOut('  php tools/cdr-cache.php prune  <domain> <before-day> [--vacuum]');
        cliOut('  php tools/cdr-cache.php verify <domain> [limit]');
        break;
}
