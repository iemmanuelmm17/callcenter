<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

if (!defined('APP_TZ')) {
    define(
        'APP_TZ',
        defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York'
    );
}

/*
 * =============================================================
 * SIMULTANEOUS CALLS (CONCURRENCY)
 * =============================================================
 *
 * Answers "how many inbound calls were in flight at the same time?"
 * for the current date range / department / site scope.
 *
 * Lives under the Telephone Numbers page (its own "Simultaneous" tab),
 * so it uses the same data source and the same scoping as that page:
 *
 *   loadRawCdrs() -> normalizeCdrs() -> scopedCdrs()   [= reportingCdrRows]
 *
 * A call occupies capacity from the moment it starts ringing until it
 * is disconnected, so a call that never gets answered still blocks a
 * DID / channel while it rings. Counted types are therefore
 * inbound + missed; outbound and on-net legs are excluded.
 *
 * Concurrency itself is an exact sweep-line over start/end events
 * (one shared active counter), never an estimate taken from call
 * counts per bucket — a 4-minute call straddling two 15-minute
 * buckets is one concurrent call in both of them, not one call each.
 *
 * Range handling: calls that start before `start` (or end after `end`)
 * are clipped to the range, because only CDR days inside the range are
 * loaded from the PBX (same as every other report here).
 */

/* Bucket sizes offered by the UI; anything else snaps to the nearest. */
const SIM_INTERVAL_CHOICES = [5, 10, 15, 30, 60];
const SIM_DEFAULT_INTERVAL = 15;
/* Safety valve: widen the bucket size until the payload fits this. */
const SIM_MAX_BUCKETS = 5000;
const SIM_MAX_INTERVAL = 60;

try {
    $user = currentUser();

    /*
     * SEC-6 pattern: the page is office-manager-only in the UI
     * (ROLE_ROUTES) and the concurrency series is domain-wide inventory
     * data, so the API enforces the same role instead of trusting the UI.
     */
    requirePageRoles($user, ['office_manager']);

    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method !== 'GET' && $method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed.'], 405);
    }

    /*
     * FUNC-17: a malformed JSON body is a 422, never a silent full-range
     * sweep. GET callers are also supported for bookmarked links.
     */
    $input = $method === 'POST' ? readJsonBody() : $_GET;

    handleGet($user, $input);

} catch (Throwable $e) {
    appExceptionLog('simultaneous_calls.php', $e);
    jsonResponse(
        ['error' => 'Unable to load simultaneous call data.'],
        500
    );
}


function handleGet(array $user, array $input): void
{
    $filters = authorizedFilters($input, $user);

    if ($filters['end'] < $filters['start']) {
        jsonResponse(['error' => 'Invalid date range'], 422);
    }

    /*
     * Same audit trail the other CDR-serving view endpoints write
     * (calls, call_history, report, agents, aa).
     */
    auditView($user, $filters, 'simultaneous_calls');

    $timezone = trim((string)($input['timezone'] ?? APP_TZ));
    if ($timezone === '') {
        $timezone = APP_TZ;
    }

    try {
        $tz = new DateTimeZone($timezone);
    } catch (Throwable $e) {
        $tz = new DateTimeZone(APP_TZ);
        $timezone = APP_TZ;
    }

    /*
     * Same pipeline the Telephone Numbers page uses, so the department /
     * site / agent scope from authorizedFilters() is applied identically.
     */
    $directory = userDirectory($user);
    $cdrs = reportingCdrRows($user, $filters, $directory);

    $intervalMinutes = resolveSimultaneousInterval(
        $input['interval'] ?? null,
        $filters['start'],
        $filters['end'],
        $tz
    );

    $series = buildSimultaneousSeries(
        $cdrs,
        (string)$filters['start'],
        (string)$filters['end'],
        $tz,
        $intervalMinutes
    );

    $summary = $series['summary'];
    $summary['timezone'] = $timezone;
    $summary['start'] = (string)$filters['start'];
    $summary['end'] = (string)$filters['end'];
    $summary['department'] = (string)($filters['department'] ?? '');
    $summary['site'] = (string)($filters['site'] ?? '');
    $summary['agents'] = array_values((array)($filters['agents'] ?? []));

    /*
     * Headline insight, phrased server-side so the client never has to
     * re-derive the peak from the bucket list.
     */
    $insight = '';
    if ((int)$summary['peak'] > 0) {
        $insight = sprintf(
            'Busiest moment: %d simultaneous inbound calls on %s at %s.',
            (int)$summary['peak'],
            (string)$summary['peakDate'],
            (string)$summary['peakTime']
        );
    }

    jsonResponse(
        [
            'success' => true,
            'data' => [
                'summary' => $summary,
                'intervals' => $series['intervals'],
                'byHour' => $series['byHour'],
                'byDay' => $series['byDay'],
                'insight' => $insight,
                'filters' => [
                    'start' => (string)$filters['start'],
                    'end' => (string)$filters['end'],
                    'department' => (string)($filters['department'] ?? ''),
                    'site' => (string)($filters['site'] ?? ''),
                    'timezone' => $timezone
                ]
            ]
        ]
    );
}


/**
 * Snap the requested bucket size to a supported one, then widen it if
 * the range would produce more buckets than the payload budget allows.
 * The effective value is echoed back in summary.intervalMinutes.
 */
function resolveSimultaneousInterval(
    $requested,
    string $start,
    string $end,
    DateTimeZone $tz
): int {

    $interval = SIM_DEFAULT_INTERVAL;

    if ($requested !== null && $requested !== '' && is_numeric($requested)) {
        $want = (int)$requested;
        $best = SIM_DEFAULT_INTERVAL;
        $bestGap = PHP_INT_MAX;
        foreach (SIM_INTERVAL_CHOICES as $choice) {
            $gap = abs($choice - $want);
            if ($gap < $bestGap) {
                $bestGap = $gap;
                $best = $choice;
            }
        }
        $interval = $best;
    }

    $spanSeconds = simultaneousSpanSeconds($start, $end, $tz);
    $guard = 0;
    while (
        $guard < 16
        && $interval < SIM_MAX_INTERVAL
        && (int)ceil($spanSeconds / ($interval * 60)) > SIM_MAX_BUCKETS
    ) {
        $next = SIM_MAX_INTERVAL;
        foreach (SIM_INTERVAL_CHOICES as $choice) {
            if ($choice > $interval) {
                $next = $choice;
                break;
            }
        }
        if ($next <= $interval) {
            break;
        }
        $interval = $next;
        $guard++;
    }

    return $interval;
}


function simultaneousSpanSeconds(
    string $start,
    string $end,
    DateTimeZone $tz
): int {

    try {
        $from = new DateTimeImmutable($start . ' 00:00:00', $tz);
        $to = (new DateTimeImmutable($end . ' 00:00:00', $tz))->modify('+1 day');
    } catch (Throwable $e) {
        return 86400;
    }

    return max(60, $to->getTimestamp() - $from->getTimestamp());
}


/**
 * Exact concurrency series for one range.
 *
 * @return array{
 *   summary: array<string,mixed>,
 *   intervals: list<array<string,mixed>>,
 *   byHour: list<array<string,mixed>>,
 *   byDay: list<array<string,mixed>>
 * }
 */
function buildSimultaneousSeries(
    array $cdrs,
    string $start,
    string $end,
    DateTimeZone $tz,
    int $intervalMinutes
): array {

    if ($intervalMinutes < 1) {
        $intervalMinutes = SIM_DEFAULT_INTERVAL;
    }

    $rangeStart = new DateTimeImmutable($start . ' 00:00:00', $tz);
    $rangeEnd = (new DateTimeImmutable($end . ' 00:00:00', $tz))->modify('+1 day');

    $rangeStartTs = $rangeStart->getTimestamp();
    $rangeEndTs = $rangeEnd->getTimestamp();
    if ($rangeEndTs <= $rangeStartTs) {
        $rangeEndTs = $rangeStartTs + 86400;
    }

    $bucketSeconds = $intervalMinutes * 60;
    $spanSeconds = $rangeEndTs - $rangeStartTs;
    $bucketCount = (int)max(1, (int)ceil($spanSeconds / $bucketSeconds));

    $peak = array_fill(0, $bucketCount, 0);
    $activeSeconds = array_fill(0, $bucketCount, 0);
    $startedByBucket = array_fill(0, $bucketCount, 0);

    /* Sweep-line events: +1 at ring start, -1 at disconnect. */
    $times = [];
    $deltas = [];

    $counts = [
        'inbound' => 0,
        'missed' => 0,
        'onnet' => 0,
        'outbound' => 0,
        'other' => 0,
        'counted' => 0
    ];

    foreach ($cdrs as $row) {
        if (!is_array($row)) {
            continue;
        }

        $type = callType($row);
        if (isset($counts[$type])) {
            $counts[$type]++;
        } else {
            $counts['other']++;
        }

        /* Inbound attempts (answered or not) are what hold capacity. */
        if ($type !== 'inbound' && $type !== 'missed') {
            continue;
        }

        $startAt = parseEasternDateTime(
            (string)(
                $row['call-start-datetime']
                ?? $row['call-batch-start-datetime']
                ?? ''
            ),
            $tz
        );

        if (!$startAt instanceof DateTimeImmutable) {
            continue;
        }

        $endAt = parseEasternDateTime(
            (string)($row['call-disconnect-datetime'] ?? ''),
            $tz
        );

        if (!$endAt instanceof DateTimeImmutable) {
            /*
             * No disconnect stamp: fall back to the longest duration the
             * CDR reports, ringing included, so a truncated record still
             * occupies the line for a realistic window.
             */
            $fallbackSeconds = max(
                seconds($row, 'call-total-duration-seconds'),
                seconds($row, 'call-batch-total-duration-seconds'),
                seconds($row, 'call-talking-duration-seconds') + ringSeconds($row)
            );
            $endAt = $startAt->modify('+' . max(1, $fallbackSeconds) . ' seconds');
        }

        $startTs = $startAt->getTimestamp();
        $endTs = $endAt->getTimestamp();

        if ($endTs <= $startTs) {
            $endTs = $startTs + 1;
        }

        /* Clipped to the loaded range (see file header). */
        if ($endTs <= $rangeStartTs || $startTs >= $rangeEndTs) {
            continue;
        }

        $startTs = max($startTs, $rangeStartTs);
        $endTs = min($endTs, $rangeEndTs);

        $index = (int)intdiv($startTs - $rangeStartTs, $bucketSeconds);
        if ($index < 0) {
            $index = 0;
        }
        if ($index >= $bucketCount) {
            $index = $bucketCount - 1;
        }
        $startedByBucket[$index]++;

        $times[] = $startTs;
        $deltas[] = 1;
        $times[] = $endTs;
        $deltas[] = -1;

        $counts['counted']++;
    }

    if ($times !== []) {
        /*
         * SORT_NUMERIC on the delta keeps -1 ahead of +1 at equal
         * timestamps: a call that ends the same second another starts is
         * a handoff, not a spike.
         */
        array_multisort(
            $times,
            SORT_ASC,
            SORT_NUMERIC,
            $deltas,
            SORT_ASC,
            SORT_NUMERIC
        );
    }

    $active = 0;
    $previous = $rangeStartTs;

    foreach ($times as $i => $ts) {
        if ($ts > $previous && $active > 0) {
            accumulateConcurrency(
                $peak,
                $activeSeconds,
                $previous,
                $ts,
                $active,
                $rangeStartTs,
                $bucketSeconds,
                $bucketCount
            );
        }

        $active += $deltas[$i];
        if ($active < 0) {
            $active = 0;
        }
        if ($ts > $previous) {
            $previous = $ts;
        }
    }

    if ($previous < $rangeEndTs && $active > 0) {
        accumulateConcurrency(
            $peak,
            $activeSeconds,
            $previous,
            $rangeEndTs,
            $active,
            $rangeStartTs,
            $bucketSeconds,
            $bucketCount
        );
    }

    /* ---- buckets -------------------------------------------------- */

    $intervals = [];
    $byHour = [];
    for ($hour = 0; $hour < 24; $hour++) {
        $byHour[$hour] = [
            'hour' => $hour,
            'label' => sprintf('%02d:00', $hour),
            'peak' => 0,
            'activeSeconds' => 0,
            'seconds' => 0,
            'started' => 0
        ];
    }

    $byDay = [];
    $peakValue = 0;
    $peakRow = null;
    $zeroIntervals = 0;

    for ($i = 0; $i < $bucketCount; $i++) {
        $bucketStartTs = $rangeStartTs + $i * $bucketSeconds;
        $length = (int)min($bucketSeconds, $rangeEndTs - $bucketStartTs);
        if ($length < 1) {
            $length = $bucketSeconds;
        }

        $bucketAt = (new DateTimeImmutable('@' . $bucketStartTs))->setTimezone($tz);
        $date = $bucketAt->format('Y-m-d');
        $time = $bucketAt->format('H:i');
        $endTime = $bucketAt
            ->modify('+' . $bucketSeconds . ' seconds')
            ->format('H:i');
        $hour = (int)$bucketAt->format('G');

        $value = $peak[$i];
        $average = round($activeSeconds[$i] / $length, 2);
        $started = $startedByBucket[$i];

        $intervals[] = [
            'date' => $date,
            'time' => $time,
            'endTime' => $endTime,
            'label' => $bucketAt->format('M j, H:i'),
            'hour' => $hour,
            'simultaneous' => $value,
            'average' => $average,
            'started' => $started
        ];

        if ($value === 0) {
            $zeroIntervals++;
        }

        if ($value > $byHour[$hour]['peak']) {
            $byHour[$hour]['peak'] = $value;
        }
        $byHour[$hour]['activeSeconds'] += $activeSeconds[$i];
        $byHour[$hour]['seconds'] += $length;
        $byHour[$hour]['started'] += $started;

        if (!isset($byDay[$date])) {
            $byDay[$date] = [
                'date' => $date,
                'peak' => 0,
                'time' => '',
                'endTime' => '',
                'activeSeconds' => 0,
                'seconds' => 0,
                'started' => 0
            ];
        }
        if ($value > $byDay[$date]['peak']) {
            $byDay[$date]['peak'] = $value;
            $byDay[$date]['time'] = $time;
            $byDay[$date]['endTime'] = $endTime;
        }
        $byDay[$date]['activeSeconds'] += $activeSeconds[$i];
        $byDay[$date]['seconds'] += $length;
        $byDay[$date]['started'] += $started;

        if ($value > $peakValue) {
            $peakValue = $value;
            $peakRow = [
                'date' => $date,
                'time' => $time,
                'endTime' => $endTime
            ];
        }
    }

    $hourRows = [];
    $busiestHour = null;
    foreach ($byHour as $row) {
        $row['average'] = $row['seconds'] > 0
            ? round($row['activeSeconds'] / $row['seconds'], 2)
            : 0.0;
        unset($row['activeSeconds'], $row['seconds']);
        $hourRows[] = $row;

        if (
            $busiestHour === null
            || $row['peak'] > $busiestHour['peak']
        ) {
            $busiestHour = $row;
        }
    }

    $dayRows = [];
    $busiestDay = null;
    foreach ($byDay as $row) {
        $row['average'] = $row['seconds'] > 0
            ? round($row['activeSeconds'] / $row['seconds'], 2)
            : 0.0;
        unset($row['activeSeconds'], $row['seconds']);
        $dayRows[] = $row;

        if (
            $busiestDay === null
            || $row['peak'] > $busiestDay['peak']
            || (
                $row['peak'] === $busiestDay['peak']
                && strcmp((string)$row['date'], (string)$busiestDay['date']) < 0
            )
        ) {
            $busiestDay = $row;
        }
    }

    $totalActiveSeconds = array_sum($activeSeconds);

    return [
        'summary' => [
            'peak' => $peakValue,
            'peakDate' => $peakRow['date'] ?? '',
            'peakTime' => $peakRow['time'] ?? '',
            'peakEndTime' => $peakRow['endTime'] ?? '',
            'average' => $spanSeconds > 0
                ? round($totalActiveSeconds / $spanSeconds, 2)
                : 0.0,
            'averageActiveSeconds' => $totalActiveSeconds,
            'inbound' => $counts['inbound'],
            'missed' => $counts['missed'],
            'totalCalls' => $counts['inbound'] + $counts['missed'],
            'excludedOnnet' => $counts['onnet'],
            'excludedOutbound' => $counts['outbound'],
            'intervalMinutes' => $intervalMinutes,
            'intervalCount' => $bucketCount,
            'zeroIntervals' => $zeroIntervals,
            'busiestDay' => $busiestDay,
            'busiestHour' => $busiestHour
        ],
        'intervals' => $intervals,
        'byHour' => $hourRows,
        'byDay' => $dayRows
    ];
}


/**
 * Spread a constant-concurrency segment across every bucket it touches:
 * raise the bucket's peak and add its active call-seconds (so a bucket
 * average stays weighted by real elapsed time).
 */
function accumulateConcurrency(
    array &$peak,
    array &$activeSeconds,
    int $from,
    int $to,
    int $active,
    int $rangeStartTs,
    int $bucketSeconds,
    int $bucketCount
): void {

    if ($to <= $from || $active <= 0 || $bucketCount < 1) {
        return;
    }

    $index = (int)intdiv($from - $rangeStartTs, $bucketSeconds);
    if ($index < 0) {
        $index = 0;
    }

    $cursor = $from;

    while ($cursor < $to && $index < $bucketCount) {
        $bucketEnd = $rangeStartTs + ($index + 1) * $bucketSeconds;
        $segmentEnd = $to < $bucketEnd ? $to : $bucketEnd;

        if ($peak[$index] < $active) {
            $peak[$index] = $active;
        }
        $activeSeconds[$index] += ($segmentEnd - $cursor) * $active;

        $cursor = $segmentEnd;
        if ($cursor >= $to) {
            break;
        }
        $index++;
    }
}
