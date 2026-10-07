<?php
declare(strict_types=1);

/**
 * Report capacity: how much CDR data one request can be asked to hold.
 *
 * WHY
 * ---
 * The reports layer loads a range of raw CDRs into PHP arrays (the day cache
 * hands them over, the metrics walk them). Trimming records to the fields the
 * app can read (includes/reporting/cdr_trim.php) cut that cost several-fold,
 * but the cost still grows with the range, and the presets now offer Last 90
 * days, QTD and YTD. When the range does not fit, PHP does not raise an error
 * the endpoint can catch - it prints "Fatal error: Allowed memory size ...
 * exhausted" and dies (this happened in production at cache.php:299).
 *
 * So the range is measured before and during the walk, and a range that cannot
 * fit raises ReportingLimitException with a message an operator can act on:
 * how big it is, what it would need, what the server allows, and how much
 * would fit. The endpoints turn that into a 413 with the same text.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It is a guard rail, not a fix: it never silently truncates a range (a
 * report that quietly drops days is worse than one that refuses), and it never
 * raises PHP's memory_limit behind the operator's back. The estimate is
 * deliberately conservative - it uses a trimmed-record guess for the pre-check
 * and the measured bytes-per-record for the in-loop check - so it errs towards
 * allowing a range rather than refusing one that would have fit.
 */

/** A range that cannot be held in memory. Endpoints answer 413 with the message. */
class ReportingLimitException extends RuntimeException
{
}

/** The share of memory_limit a report may use before it refuses to start. */
const REPORTING_MEMORY_FRACTION = 0.6;

/**
 * Bytes per record assumed before any record has been measured.
 *
 * MEASURED, not guessed: the "cdr memory" suite loads 160,000 realistic
 * records (536 MB of day files) inside php-wasm's 128 MB limit and passes, and
 * the report payload is built from them in the same request - so the
 * all-in cost of a record held by a report is well under 1 kB once records are
 * trimmed and days are streamed. The pre-check only has to catch a range that
 * is obviously impossible (a year of a busy centre), so it errs towards
 * allowing the range: a refusal is a user-visible failure, and the in-loop
 * measurement below is the authority on what actually fits.
 */
const REPORTING_RECORD_BYTES_GUESS = 1024;

/** memory_limit in bytes; 0 means unlimited (which is not a safe budget). */
function reportingMemoryLimitBytes(): int
{
    $raw = trim((string)ini_get('memory_limit'));
    if ($raw === '' || $raw === '-1') {
        return 0;
    }
    $unit = strtolower(substr($raw, -1));
    $value = (float)$raw;
    if ($unit === 'g') {
        $value *= 1024 * 1024 * 1024;
    } elseif ($unit === 'm') {
        $value *= 1024 * 1024;
    } elseif ($unit === 'k') {
        $value *= 1024;
    }
    /* Clamped, not cast blindly: '-1' is "unlimited" and is handled above, and
     * a 32-bit PHP cannot represent a limit above PHP_INT_MAX anyway. */
    return (int)max(0.0, min($value, (float)PHP_INT_MAX));
}

/**
 * What a report may use. 0 when the server sets no limit (nothing to check).
 *
 * A deployment may pin its own budget with REPORTING_MEMORY_HEADROOM_BYTES
 * (config.local.php): a host that runs other heavy PHP alongside this app may
 * want a tighter number than 60% of memory_limit. Tests use the same hook to
 * exercise the guard without depending on the runner's php.ini.
 */
function reportingMemoryHeadroomBytes(): int
{
    /*
     * Compared as a float: on a 32-bit PHP (php-wasm, some Windows builds) an
     * (int) cast of a value above 2 GB overflows to 0 or negative, and the
     * override would then be silently ignored - a budget that says 60% when
     * the operator asked for something else.
     */
    if (defined('REPORTING_MEMORY_HEADROOM_BYTES') && (float)REPORTING_MEMORY_HEADROOM_BYTES > 0) {
        return (int)min((float)REPORTING_MEMORY_HEADROOM_BYTES, (float)PHP_INT_MAX);
    }
    $limit = reportingMemoryLimitBytes();
    if ($limit <= 0) {
        return 0;
    }
    return (int)floor($limit * REPORTING_MEMORY_FRACTION);
}

/** "512 MB", for a message a human reads. */
function reportingBytesLabel(int $bytes): string
{
    if ($bytes >= 1024 * 1024 * 1024) {
        return round($bytes / (1024 * 1024 * 1024), 1) . ' GB';
    }
    if ($bytes >= 1024 * 1024) {
        return round($bytes / (1024 * 1024)) . ' MB';
    }
    return round($bytes / 1024) . ' KB';
}

/**
 * The message the operator (and the manager, on screen) sees. It names the
 * range, the size, the limit and the way out - the three things a 500 never said.
 */
function reportingCapacityMessage(int $records, int $needsBytes, int $headroomBytes, string $start, string $end): string
{
    $limit = reportingMemoryLimitBytes();
    $fits = $needsBytes > 0 ? (int)floor($headroomBytes / ($needsBytes / max(1, $records))) : 0;
    return sprintf(
        'This range is too large for this server: about %s calls (%s to %s) need roughly %s of memory, '
        . 'but a report may use about %s (PHP memory_limit is %s). Narrow the range - about %s calls fit '
        . 'per request - or raise memory_limit in php.ini.',
        number_format($records),
        $start,
        $end,
        reportingBytesLabel($needsBytes),
        reportingBytesLabel($headroomBytes),
        $limit > 0 ? reportingBytesLabel($limit) : 'unlimited',
        number_format(max(0, $fits))
    );
}

/**
 * Record counts per day for the range, from whichever backend can answer
 * cheaply. The JSON day files can only be counted by decoding them, and the
 * point of this call is to avoid decoding them, so the JSON driver answers
 * with an empty map and the in-loop check does the work instead.
 *
 * @return array<string,int> date => records
 */
function reportingDayRecordEstimates(array $user, string $start, string $end): array
{
    if (cdrCacheDriver() !== 'sqlite') {
        return [];
    }
    $out = [];
    foreach (reportingDateList($start, $end) as $date) {
        $meta = cdrDayCacheMeta((string)$user['domain'], $date);
        if (!empty($meta['exists'])) {
            $out[$date] = (int)($meta['records'] ?? 0);
        }
    }
    return $out;
}

/**
 * Refuse a range that provably cannot fit, before a single day is loaded.
 *
 * Returns the per-day counts so the caller can project while it walks (the
 * store answer), or an empty map when nothing could be counted.
 *
 * @return array<string,int>
 */
function reportingRangeGuard(array $user, array $filters): array
{
    $headroom = reportingMemoryHeadroomBytes();
    $counts = reportingDayRecordEstimates($user, (string)$filters['start'], (string)$filters['end']);
    if ($headroom <= 0 || $counts === []) {
        return $counts;
    }
    $records = array_sum($counts);
    if ($records <= 0) {
        return $counts;
    }
    $needs = $records * REPORTING_RECORD_BYTES_GUESS;
    if ($needs > $headroom) {
        throw new ReportingLimitException(
            reportingCapacityMessage(
                $records,
                $needs,
                $headroom,
                (string)$filters['start'],
                (string)$filters['end']
            )
        );
    }
    return $counts;
}

/**
 * The in-loop check: what has been loaded, measured, projected over the days
 * still to come. Called by loadRawCdrs() after each day, so a range that only
 * turns out to be too big once real records are in hand still stops with a
 * message instead of a fatal.
 *
 * @param array<string,int> $counts date => records (may be empty)
 * @param list<string>      $remaining days still to load
 */
function reportingProjectedOverflow(int $loadedRecords, int $baselineBytes, int $processedDays, array $counts, array $remaining): ?string
{
    $headroom = reportingMemoryHeadroomBytes();
    if ($headroom <= 0 || $loadedRecords <= 0 || $processedDays <= 0) {
        return null;
    }
    /*
     * Self-calibrating when PHP can measure memory; the conservative guess
     * when it cannot (some embedded SAPIs answer 0 from memory_get_usage()).
     * Either way the projection is a floor on the real cost, never a promise
     * that a range will fit - the pre-check is what refuses a range outright.
     */
    $used = memory_get_usage(true) - $baselineBytes;
    $perRecord = $used > 0
        ? (int)max(1, intdiv($used, $loadedRecords))
        : REPORTING_RECORD_BYTES_GUESS;
    $averageDay = (int)round($loadedRecords / $processedDays);
    $projected = $loadedRecords;
    foreach ($remaining as $date) {
        $projected += $counts[$date] ?? $averageDay;
    }
    $needs = $projected * $perRecord;
    if ($needs <= $headroom) {
        return null;
    }
    return reportingCapacityMessage($projected, $needs, $headroom, (string)($remaining[0] ?? ''), (string)end($remaining));
}
