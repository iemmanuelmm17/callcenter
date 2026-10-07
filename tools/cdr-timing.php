<?php
declare(strict_types=1);

/**
 * CDR range timing meter.
 *
 *   php tools/cdr-timing.php [domain] [start] [end] [--runs=2] [--days=15]
 *
 * Times the REAL reporting path for a range on THIS server, stage by stage, so
 * "a 15-day report takes too long" becomes numbers you can compare: before and
 * after a cache warm-up, after raising CDR_PAGE_SIZE or PBX_REQUESTS_PER_SECOND,
 * or after an upgrade.
 *
 * The stages are the ones the browser pays, in order:
 *   cache status   which days are in the day cache (the cold/warm question)
 *   loadRawCdrs    reading the cached days and merging them (no PBX here)
 *   normalizeCdrs  the per-row derived values (ring/wait, local date, type)
 *   scopedCdrs     the permission/filter scope
 *   filter         the local-date cut
 *   summary        the headline numbers
 *   packQueues / packNumbers / packQuality   the three row sets
 *   json_encode    turning it into the response
 *
 * It runs the whole sequence `--runs` times: the FIRST run says what a cold
 * request costs, the LAST says what the user feels on every refresh after it.
 * Peak memory (the process high-water mark) is printed once, after the runs -
 * native PHP returns a real number here (php-wasm, the test harness, 0).
 *
 * A range that is not fully cached is refused, because warming is the UI's job
 * (api/cache_job.php owns the session and the PBX token); the message names the
 * days to warm. The tool never writes the cache, and prints timings and counts
 * only - never a caller, a number or a row.
 */

if (!defined('STDOUT')) {
    define('STDOUT', fopen('php://stdout', 'wb'));
}
if (!defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}

if (!in_array(PHP_SAPI, ['cli', 'embed', 'phpdbg'], true)) {
    fwrite(STDERR, 'This tool only runs from the command line (SAPI: ' . PHP_SAPI . ").\n");
    exit(2);
}

require_once __DIR__ . '/../includes/reporting.php';

$argvList = $_SERVER['argv'] ?? [];
$args = [];
$flags = [];
foreach (array_slice($argvList, 1) as $arg) {
    $arg = (string)$arg;
    if (str_starts_with($arg, '--')) {
        $flag = substr($arg, 2);
        $value = null;
        if (str_contains($flag, '=')) {
            [$flag, $value] = explode('=', $flag, 2);
        }
        $flags[$flag] = $value;
        continue;
    }
    $args[] = $arg;
}

$toInt = static function (?string $value, int $default, int $min, int $max): int {
    if ($value === null || !is_numeric($value)) {
        return $default;
    }
    return max($min, min($max, (int)$value));
};

$domain = trim((string)($args[0] ?? ''));
if ($domain === '') {
    /* Same fallback the endpoints use: the configured PBX domain, else the
     * only domain the PBX_SERVERS map knows. */
    $servers = defined('PBX_SERVERS') && is_array(PBX_SERVERS) ? PBX_SERVERS : [];
    $configured = defined('PBX_DOMAIN') ? trim((string)PBX_DOMAIN) : '';
    $domain = $configured !== '' ? $configured : trim((string)(array_key_first($servers) ?? ''));
}
if ($domain === '') {
    fwrite(STDERR, "error: no domain given and none configured — usage: php tools/cdr-timing.php <domain> [start] [end]\n");
    exit(2);
}

$runs = $toInt($flags['runs'] ?? null, 2, 1, 5);
$days = $toInt($flags['days'] ?? null, 15, 1, 366);

$start = trim((string)($args[1] ?? ''));
$end = trim((string)($args[2] ?? ''));
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $end)) {
    $end = (new DateTimeImmutable('today', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d');
    $start = (new DateTimeImmutable($end))->modify('-' . ($days - 1) . ' days')->format('Y-m-d');
}

/* The meter has no session, so it uses the role that sees the whole desk: the
 * office manager. `authorizedFilters()` is CLI-safe and supplies exactly the
 * filter shape the endpoints would. */
$user = [
    'id' => 'cli-timing',
    'name' => 'CLI timing meter',
    'role' => 'office_manager',
    'domain' => $domain,
    'extension' => '',
    'department' => '',
    'site' => '',
];
$_SESSION['user'] = $user;
$_SESSION['token'] = '';

$filters = authorizedFilters(['start' => $start, 'end' => $end], $user);

function timingOut(string $line = ''): void
{
    fwrite(STDOUT, $line . "\n");
}

function timingMs(float $start, float $end): int
{
    return (int)round(($end - $start) * 1000);
}

timingOut('CDR range timing');
timingOut('  domain:  ' . $domain);
timingOut('  range:   ' . $filters['start'] . ' .. ' . $filters['end'] . '  (' . count(reportingDateList($filters['start'], $filters['end'])) . ' days)');
timingOut('  filters: hours=' . $filters['hours'] . ', driver=' . cdrCacheDriver());
timingOut('  runs:    ' . $runs);

$status = cdrRangeCacheStatus($user, $filters['start'], $filters['end']);
timingOut('  cache:   ' . $status['ready'] . '/' . $status['total'] . ' days ready (' . $status['percent'] . '%)');
if (empty($status['complete'])) {
    $missing = [];
    foreach (reportingDateList($filters['start'], $filters['end']) as $date) {
        if (!cdrDayIsCached($user, $date)) {
            $missing[] = $date;
        }
    }
    timingOut('');
    timingOut('Not fully cached, so there is nothing to time yet. Open the report for this');
    timingOut('range once (the page warms the cache as it loads), then run the meter again.');
    timingOut('Days still to warm (' . count($missing) . '): ' . implode(', ', array_slice($missing, 0, 12)) . (count($missing) > 12 ? ', ...' : ''));
    exit(2);
}

/* The same roster/queue/settings the endpoint would resolve, resolved ONCE so
 * the PBX is not asked mid-measurement (userDirectory/cachedCallQueues may
 * refresh their cache here - that is the only network this tool does). */
$directory = userDirectory($user);
$queueIds = [];
foreach (cachedCallQueues($user) as $qrow) {
    if (is_array($qrow)) {
        $qid = trim((string)($qrow['callqueue'] ?? ''));
        if ($qid !== '') {
            $queueIds[$qid] = true;
        }
    }
}
$settings = loadDomainSettings((string)($user['domain'] ?? ''));
$slaSeconds = (int)($settings['slaSeconds'] ?? 20);
timingOut('  roster:  ' . count($directory) . ' extensions, ' . count($queueIds) . ' queues known');
timingOut('');

$labels = ['load', 'normalize', 'scope', 'filter', 'summary', 'packQueues', 'packNumbers', 'packQuality', 'encode'];
$allRows = [];
$firstRow = null;
$lastRow = null;

$runOnce = static function (int $run) use ($user, $filters, $directory, $queueIds, $settings, $slaSeconds): array {
    $marks = [];
    $step = static function (string $label, callable $work) use (&$marks) {
        $started = microtime(true);
        $value = $work();
        $marks[$label] = timingMs($started, microtime(true));
        return $value;
    };

    $raw = $step('load', static fn() => loadRawCdrs($user, $filters));
    $normalized = $step('normalize', static fn() => normalizeCdrs($raw, $directory));
    unset($raw);
    $calls = $step('scope', static fn() => scopedCdrs($normalized, $filters, $directory));
    $calls = $step('filter', static fn() => filterCallsByLocalDate($calls, $filters['start'], $filters['end']));

    $summary = $step('summary', static fn() => summary($calls, $slaSeconds, $directory, $queueIds, $settings));
    $queues = $step('packQueues', static fn() => packQueueRows($calls, $directory, $queueIds, $settings, []));
    $numbers = $step('packNumbers', static fn() => packNumberRows($calls, $directory, $queueIds, []));
    $quality = $step('packQuality', static fn() => packQuality($calls));

    $payload = $step('encode', static fn() => json_encode([
        'summary' => $summary,
        'queues' => $queues,
        'numbers' => $numbers,
        'quality' => $quality,
    ]));
    unset($summary, $queues, $numbers, $quality);

    return [
        'run' => $run,
        'calls' => count($calls),
        'ms' => $marks,
        'totalMs' => array_sum($marks),
        'payloadKB' => (int)round(strlen((string)$payload) / 1024),
        /* The process high-water mark, so the LAST run reports the worst case. */
        'peakMB' => (int)round(memory_get_peak_usage(true) / 1048576),
    ];
};

for ($run = 1; $run <= $runs; $run++) {
    try {
        $row = $runOnce($run);
    } catch (Throwable $e) {
        fwrite(STDERR, 'error: ' . $e->getMessage() . "\n");
        fwrite(STDERR, "       A day can expire from the cache mid-run (only today has a short\n");
        fwrite(STDERR, "       TTL), and this process has no session to fetch it with. Warm the\n");
        fwrite(STDERR, "       range in the browser once, or measure a range that ends yesterday.\n");
        exit(4);
    }
    if ($firstRow === null) {
        $firstRow = $row;
    }
    $lastRow = $row;
    $allRows[] = $row;
}

/* The per-run stage table: one column per run, so a cold run and a warm run sit
 * next to each other and the difference is visible. */
$header = str_pad('stage', 14) . str_pad('ms/run', 10);
foreach ($labels as $label) {
    $header .= str_pad(substr($label, 0, 9), 11);
}
timingOut($header);
foreach ($allRows as $row) {
    $line = str_pad('run ' . $row['run'], 14) . str_pad((string)$row['totalMs'], 10);
    foreach ($labels as $label) {
        $line .= str_pad((string)($row['ms'][$label] ?? 0), 11);
    }
    timingOut(rtrim($line));
}
timingOut('');
timingOut('  calls:      ' . $lastRow['calls']);
timingOut('  response:   ' . $lastRow['payloadKB'] . ' KB');
timingOut('  peak:       ' . $lastRow['peakMB'] . ' MB');
timingOut('');

$cold = (int)$firstRow['totalMs'];
$warm = (int)$lastRow['totalMs'];
if ($runs > 1) {
    timingOut('  run 1 (cold): ' . $cold . ' ms');
    timingOut('  run ' . $runs . ' (warm): ' . $warm . ' ms');
    if ($warm > 0) {
        timingOut('  change:       ' . ($cold === $warm ? 'no change' : (($warm < $cold ? 'faster' : 'slower'))) . ' by ' . abs($cold - $warm) . ' ms (' . round(abs($cold - $warm) / max(1, $cold) * 100) . '%)');
    }
}

$slowest = $lastRow['ms'];
arsort($slowest);
$top = array_slice($slowest, 0, 3, true);
$parts = [];
foreach ($top as $label => $ms) {
    $parts[] = $label . ' ' . $ms . ' ms';
}
timingOut('  slowest:      ' . implode(', ', $parts));
timingOut('');
timingOut('A cold range (run 1 much slower than the last) is a cache problem: open the');
timingOut('report once so the days are fetched. A warm range dominated by `load` is');
timingOut('disk + JSON decode; raise nothing - that is the price of the range. A cold');
timingOut('range dominated by PBX waiting is a fetch problem: measure the server with');
timingOut('php tools/pbx-bench.php, then set CDR_PAGE_SIZE / PBX_REQUESTS_PER_SECOND.');
