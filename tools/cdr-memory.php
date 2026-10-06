<?php
declare(strict_types=1);

/**
 * CDR memory meter.
 *
 *   php tools/cdr-memory.php [domain] [days]
 *
 * Answers one question an operator asks after a report dies with "Allowed
 * memory size ... exhausted": how much of the CDR cache's cost is the fields
 * nobody reads, and how wide a range can this server actually load?
 *
 * It prints:
 *   - PHP's memory_limit and the share a report may use (the guard's budget);
 *   - per cached day: records, average stored bytes per record, how many of a
 *     record's fields the application keeps, and how many it drops;
 *   - what that means for a request: calls (and days at this traffic) that fit.
 *
 * It reads ONE day's records (the most recent with data) to measure the shape,
 * and takes the counts of the other days from the cache metadata - reading the
 * range is the thing under investigation, so the meter must not do it.
 *
 * Read-only: it never writes to the cache and never calls the PBX.
 */
if (!defined('STDOUT')) {
    define('STDOUT', fopen('php://stdout', 'wb'));
}
if (!defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}

if (!in_array(PHP_SAPI, ['cli', 'embed', 'phpdbg'], true)) {
    fwrite(STDERR, "This tool only runs from the command line (SAPI: " . PHP_SAPI . ").\n");
    exit(2);
}

require_once __DIR__ . '/../includes/reporting.php';

$argvList = $_SERVER['argv'] ?? [];
$args = array_values(array_filter(
    array_slice($argvList, 1),
    static fn($arg) => !str_starts_with((string)$arg, '--')
));
$domain = trim((string)($args[0] ?? ''));
$days = (int)($args[1] ?? 30);
if ($days < 1) {
    $days = 30;
}
if ($days > 366) {
    $days = 366;
}
if ($domain === '') {
    /* Same domain the endpoints are scoped to: the configured PBX domain, or
     * the only domain the PBX servers list knows about. */
    $servers = defined('PBX_SERVERS') && is_array(PBX_SERVERS) ? PBX_SERVERS : [];
    $configured = defined('PBX_DOMAIN') ? trim((string)PBX_DOMAIN) : '';
    $domain = $configured !== '' ? $configured : trim((string)(array_key_first($servers) ?? ''));
}
if ($domain === '') {
    fwrite(STDERR, "error: no domain given and none configured — usage: php tools/cdr-memory.php <domain> [days]\n");
    exit(1);
}

function meterOut(string $line = ''): void
{
    fwrite(STDOUT, $line . "\n");
}

function meterBytes(float $bytes): string
{
    $units = ['B', 'kB', 'MB', 'GB'];
    $value = $bytes;
    $unit = 0;
    while ($value >= 1024 && $unit < count($units) - 1) {
        $value /= 1024;
        $unit++;
    }
    return number_format($value, $unit === 0 ? 0 : 1) . ' ' . $units[$unit];
}

/** Bytes of live PHP memory one record costs: serialize() is the honest proxy. */
function meterRecordBytes(array $record): int
{
    return strlen(serialize($record));
}

$limit = reportingMemoryLimitBytes();
$headroom = reportingMemoryHeadroomBytes();

meterOut('CDR memory meter — ' . $domain);
meterOut('driver: ' . cdrCacheDriver());
meterOut('PHP memory_limit: ' . ($limit > 0 ? meterBytes($limit) : 'unlimited'));
meterOut('a report may use: ' . ($headroom > 0 ? meterBytes($headroom) : 'nothing is checked (unlimited)'));

$user = ['domain' => $domain];
$today = (new DateTimeImmutable('today', new DateTimeZone(defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York')))->format('Y-m-d');
$start = (new DateTimeImmutable($today))->modify('-' . ($days - 1) . ' days')->format('Y-m-d');

$list = reportingDateList($start, $today);
/*
 * Per-day counts from the cache's own metadata. The JSON backend can only
 * count a day by decoding it, which is the cost the meter is investigating -
 * but this is a one-off diagnostic on a CLI with its own memory, and a wrong
 * (empty) answer here would be worse than the read. One day at a time, and
 * nothing is kept.
 */
$counts = [];
$totalRecords = 0;
$cachedDays = 0;
foreach ($list as $date) {
    $meta = cdrDayCacheMeta($domain, $date);
    if (empty($meta['exists'])) {
        continue;
    }
    $records = (int)($meta['records'] ?? 0);
    $counts[$date] = $records;
    if ($records > 0) {
        $cachedDays++;
        $totalRecords += $records;
    }
}
meterOut('');
meterOut(sprintf('cache over the last %d days: %d day(s) with data, %s calls', $days, $cachedDays, number_format($totalRecords)));

/* Measure one day, the most recent with data: the shape of a record. */
$measureDay = null;
foreach (array_reverse($list) as $date) {
    if ((int)($counts[$date] ?? 0) > 0) {
        $measureDay = $date;
        break;
    }
}
$keptFields = 0;
$droppedFields = [];
$storedBytes = 0;
$measured = 0;
$recordsInDay = 0;
if ($measureDay !== null) {
    $day = cdrDayCacheRead($domain, $measureDay, cdrDayCacheTtl($measureDay));
    if (is_array($day) && is_array($day['records'] ?? null)) {
        $rows = $day['records'];
        $recordsInDay = count($rows);
        $fields = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $measured++;
            $storedBytes += meterRecordBytes($row);
            foreach ($row as $key => $value) {
                $name = (string)$key;
                if (cdrFieldIsKept($name)) {
                    $fields[$name] = true;
                } else {
                    $droppedFields[$name] = true;
                }
            }
        }
        $keptFields = count($fields);
    }
}

if ($measured > 0) {
    $perRecord = (int)round($storedBytes / $measured);
    $dropped = array_keys($droppedFields);
    sort($dropped);
    meterOut('');
    meterOut(sprintf('measured day %s: %s records, %s per record as stored', $measureDay, number_format($recordsInDay), meterBytes($perRecord)));
    meterOut(sprintf('  fields the app keeps: %d', $keptFields));
    meterOut(sprintf('  fields dropped: %d', count($dropped)));
    if ($dropped === []) {
        meterOut('  (this cache is already trimmed — nothing left to drop)');
    } else {
        meterOut('  dropped names: ' . implode(', ', array_slice($dropped, 0, 12)) . (count($dropped) > 12 ? ', …' : ''));
    }
    if ($headroom > 0) {
        /* PHP holds more than the serialized bytes (hash tables, zvals, and the
         * copies the metrics make), so the meter divides by a measured factor:
         * 2.5x is what the "cdr memory" suite measured for a loaded day. */
        $live = (int)round($perRecord * 2.5);
        $fits = intdiv($headroom, max(1, $live));
        meterOut('');
        meterOut(sprintf('estimate: ~%s of live memory per record, so about %s calls fit per request', meterBytes($live), number_format($fits)));
        if ($cachedDays > 0 && $totalRecords > 0) {
            $perDay = (int)round($totalRecords / $cachedDays);
            meterOut(sprintf('          that is about %d day(s) at this traffic (%s calls/day)', intdiv($fits, max(1, $perDay)), number_format($perDay)));
        }
        $needs = (int)round($totalRecords * $live);
        meterOut('');
        meterOut(sprintf('the whole %d-day window would need ~%s: %s', $days, meterBytes($needs), $needs > $headroom ? 'TOO BIG — narrow the range or raise memory_limit' : 'fits'));
    }
} else {
    meterOut('');
    meterOut('no cached day could be measured (nothing cached in the window, or the read failed).');
}

fflush(STDOUT);
