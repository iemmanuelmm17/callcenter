<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/rows.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

/**
 * Canonical call list for report, TN, and call modal:
 * one NetSapiens CDR row after normalize + agent/dept/site scope.
 * Classification: call-direction 0 outbound, 1 inbound (answered) /
 * missed (unanswered), 2 voicemail→missed, 3 onnet.
 */
function reportingCdrRows(
    array $user,
    array $filters,
    array $directory,
    array $callTypes = []
): array {
    $calls = scopedCdrs(
        normalizeCdrs(
            loadRawCdrs($user, $filters),
            $directory
        ),
        $filters,
        $directory
    );

    if ($callTypes !== []) {
        $calls = filterCallTypes($calls, $callTypes);
    }

    return array_values($calls);
}

function loadAaCdrs(array $user, array $filters): array
{
    return loadRawCdrs($user, $filters);
}

function reportingInventory(array $user, array $directory, array $calls): array
{
    $aaExt = [];
    $agentCount = 0;
    $aaCount = 0;

    foreach ($directory as $ext => $person) {
        if (!is_array($person)) {
            continue;
        }
        $code = trim((string)($person['serviceCode'] ?? ''));
        if ($code === 'system-aa') {
            $aaCount++;
            $aaExt[(string)$ext] = true;
            continue;
        }
        if ($code === '') {
            $agentCount++;
        }
    }

    $phones = cachedPhoneNumbers($user);
    $totalNumbers = 0;
    $enabledNumbers = 0;
    foreach ($phones as $phone) {
        if (!is_array($phone)) {
            continue;
        }
        $totalNumbers++;
        $enabledValue = $phone['enabled'] ?? true;
        $enabled =
            $enabledValue === true ||
            $enabledValue === 1 ||
            $enabledValue === '1' ||
            strtolower((string)$enabledValue) === 'yes' ||
            strtolower((string)$enabledValue) === 'true';
        if ($enabled) {
            $enabledNumbers++;
        }
    }

    $aaCalls = 0;
    foreach ($calls as $call) {
        if (!is_array($call)) {
            continue;
        }
        $through = trim((string)($call['call-through-user'] ?? ''));
        if ($through !== '' && isset($aaExt[$through])) {
            $aaCalls++;
        }
    }

    $queueCount = 0;
    try {
        $queueCount = count(cachedCallQueues($user));
    } catch (Throwable $e) {
        $queueCount = 0;
    }
    if ($queueCount < 1) {
        foreach ($directory as $person) {
            if (!is_array($person)) {
                continue;
            }
            if (trim((string)($person['serviceCode'] ?? '')) === 'system-queue') {
                $queueCount++;
            }
        }
    }

    return [
        'agents' => $agentCount,
        'totalNumbers' => $totalNumbers,
        'enabledNumbers' => $enabledNumbers,
        'autoAttendants' => $aaCount,
        'aaCalls' => $aaCalls,
        'queues' => $queueCount,
    ];
}

function scopedCdrs(array $raw, array $filters, array $directory = []): array {
    /*
     * Opening-hours scoping lives here, in the one function every reporting
     * endpoint already funnels through (report rows, calls, call history, the
     * queue and cradle screens, the exports). That is deliberate: a filter that
     * only applied to one endpoint is how a dashboard and its own drill-down
     * come to disagree.
     */
    $hours = (string)($filters['hours'] ?? 'all');
    $settings = null;
    if ($hours !== 'all') {
        $settings = loadDomainSettings((string)($filters['domain'] ?? ''));
        if (!businessHoursConfigured($settings)) {
            $hours = 'all';
        }
    }
    return array_values(array_filter($raw, static function(array $row) use ($filters, $directory, $hours, $settings): bool {
        $agent = callAgent($row); $directoryEntry = $directory[$agent] ?? [];
        $department = callDepartment($row) ?: (string)($directoryEntry['department'] ?? '');
        $site = callSite($row) ?: (string)($directoryEntry['site'] ?? '');
        if ($filters['department'] !== '' && $department !== $filters['department']) return false;
        if (($filters['site'] ?? '') !== '' && $site !== $filters['site']) return false;
        if ($hours !== 'all' && $settings !== null) {
            $inside = callWithinBusinessHours($row, $settings);
            if ($hours === 'business' && !$inside) return false;
            if ($hours === 'after' && $inside) return false;
        }
        return !$filters['agents'] || in_array(callAgent($row), $filters['agents'], true);
    }));
}

/**
 * FUNC-16 / FUNC-27 FIX: single source of truth for the SLA window across
 * the reporting endpoints (calls, report, queue, cradle).
 *
 * Before: each endpoint hard-coded its own default/floor (20 in calls.php /
 * report.php, 30 in queue.php / cradle.php) and none had an upper bound.
 *
 * Now:
 *  - the default comes from the domain settings (saveDomainSettings clamps
 *    slaSeconds to 5..120, so the API default always matches what was saved)
 *  - a missing / <= 0 request value falls back to the configured value
 *  - any value is clamped to 1..120 (same bounds as the settings UI)
 */
function resolveSlaSeconds($requested, array $user): int {
    $configured = (int)(loadDomainSettings((string)($user['domain'] ?? ''))['slaSeconds'] ?? 20);
    if ($configured < 1) {
        $configured = 20;
    }
    $requestedSla = is_array($requested) ? ($requested['slaSeconds'] ?? null) : null;
    $sla = ($requestedSla === null || $requestedSla === '') ? $configured : (int)$requestedSla;
    if ($sla < 1) {
        $sla = $configured;
    }
    return max(1, min(120, $sla));
}

/**
 * The period totals every screen reads.
 *
 * $settings is optional and, when given, turns on per-queue SLA: each inbound
 * call is judged against its own queue's target (with the request's target as
 * the fallback and the domain default behind that). Without it the behaviour is
 * exactly what it always was - one target for everything.
 */
function summary(array $calls, int $slaSeconds = 20, array $directory = [], array $queueIds = [], ?array $settings = null): array {
    if ($slaSeconds < 1) {
        $slaSeconds = 20;
    }
    if ($settings !== null) {
        /* The report's requested target beats the stored default, but a queue's
         * own override still beats both. */
        $settings = array_merge($settings, ['slaSeconds' => $slaSeconds]);
    }
    $perQueueSla = $settings !== null && !empty($settings['queueSla']);
    $sets = ['inbound'=>[], 'outbound'=>[]];
    $counts = ['total'=>0,'inbound'=>0,'outbound'=>0,'missed'=>0,'onnet'=>0];
    $hours = array_fill(0, 24, 0);
    /*
     * Per-hour detail, keyed by the same hour index as $hours: a count answers
     * "when is it busy", and the review needs the two follow-ups - "how long do
     * calls take at 09:00" (AHT by hour, and the base of the Sprint C staffing
     * estimate) and "how many were missed at 09:00". Only inbound answered calls
     * carry talk time into AHT; an outbound leg's talk belongs to the campaign,
     * not to the desk's answering speed.
     */
    $hourInbound = array_fill(0, 24, 0);
    $hourMissed = array_fill(0, 24, 0);
    $hourTalk = array_fill(0, 24, 0);
    $days = [];
    $missedBreakdown = ['noanswer'=>0,'voicemail'=>0,'abandon'=>0];
    $inboundRings = [];
    $answeredInSla = 0;
    $slaTargetSum = 0;
    $slaTargets = [];
    /*
     * Wait buckets, in the two shapes the review asks for: answered calls banded
     * at the SLA-style thresholds (30/60/120s) so the coaching list is "who
     * waited over two minutes", and unanswered calls banded at 5/30s, where the
     * <5s bucket is overwhelmingly misdials and the >30s bucket is a real
     * staffing failure. Both use waitSeconds() - the same number as the average
     * beside them.
     */
    $waitBuckets = ['0-30'=>0,'31-60'=>0,'61-120'=>0,'120+'=>0];
    $missedWaitBuckets = ['lt5'=>0,'5-30'=>0,'gt30'=>0];
    $abandonWaitBuckets = ['lt5'=>0,'5-30'=>0,'gt30'=>0];
    $holdTotal = 0;
    $holdCalls = 0;

    foreach ($calls as $call) {
        $type = callType($call);
        if (!isset($counts[$type])) {
            continue;
        }
        $counts[$type]++;
        $counts['total']++;
        if (isset($sets[$type])) {
            $sets[$type][] = $call;
        }

        $hold = holdSeconds($call);
        if ($hold > 0) {
            $holdTotal += $hold;
            $holdCalls++;
        }

        if ($type === 'missed') {
            $bucket = callMissedBucket($call, $directory, $queueIds);
            $missedBreakdown[$bucket]++;
            $waited = waitSeconds($call);
            $band = $waited < 5 ? 'lt5' : ($waited <= 30 ? '5-30' : 'gt30');
            $missedWaitBuckets[$band]++;
            if ($bucket === 'abandon') {
                $abandonWaitBuckets[$band]++;
            }
        }

        if ($type === 'inbound') {
            $ring = ringSeconds($call);
            $inboundRings[] = $ring;
            if ($ring <= 30) { $waitBuckets['0-30']++; }
            elseif ($ring <= 60) { $waitBuckets['31-60']++; }
            elseif ($ring <= 120) { $waitBuckets['61-120']++; }
            else { $waitBuckets['120+']++; }
            /* The target this call is actually judged against: its queue's
             * override when one is configured, otherwise the report's target. */
            $target = $slaSeconds;
            if ($perQueueSla) {
                $target = resolveQueueSlaSeconds($settings, cdrQueueMatch($call, $queueIds));
            }
            $slaTargetSum += $target;
            $slaTargets[$target] = true;
            if ($ring <= $target) {
                $answeredInSla++;
            }
        }

        $raw = (string)($call['call-start-datetime'] ?? $call['startedAt'] ?? '');
        $at = parseEasternDateTime($raw);
        if ($at instanceof DateTimeImmutable) {
            $hourIndex = (int)$at->format('G');
            $hours[$hourIndex]++;
            if ($type === 'inbound') {
                $hourInbound[$hourIndex]++;
                $hourTalk[$hourIndex] += seconds($call, 'call-talking-duration-seconds');
            } elseif ($type === 'missed') {
                $hourMissed[$hourIndex]++;
            }
            $day = $at->format('Y-m-d');
            $days[$day] = ($days[$day] ?? 0) + 1;
        }
    }

    $offered = $counts['inbound'] + $counts['missed'];
    $answeredInbound = $counts['inbound'];
    /*
     * DATA-2 FIX: service level is now "answered within X" =
     * answered-in-time / ANSWERED inbound (counts.inbound). The old
     * denominator (inbound + missed) mixed missed-call volume into an
     * answer-speed metric, so the dashboard ring could never be
     * reconciled with the queue screens (queue.php: slaHit / answered).
     * `sla20` / `answeredIn20` are kept as deprecated aliases for
     * other consumers; `sla` / `answeredInSla` are canonical.
     */
    $serviceLevel = [
        'p50Ring' => percentileInt($inboundRings, 50),
        'p90Ring' => percentileInt($inboundRings, 90),
        /* Same numbers, named for the wait the caller felt: on the dashboard
         * "wait" is the word a manager uses for an answered call's ring. */
        'p50Wait' => percentileInt($inboundRings, 50),
        'p90Wait' => percentileInt($inboundRings, 90),
        'answeredInSla' => $answeredInSla,
        'answeredIn20' => $answeredInSla,
        'answered' => $answeredInbound,
        'offered' => $offered,
        'slaSeconds' => $slaSeconds,
        'sla' => $answeredInbound > 0 ? round(($answeredInSla / $answeredInbound) * 100, 1) : 0.0,
        'sla20' => $answeredInbound > 0 ? round(($answeredInSla / $answeredInbound) * 100, 1) : 0.0,
        /*
         * Per-queue targets: when several targets were in play for one period,
         * a single "answered within X" label would be a half-truth, so the
         * payload carries the mean target actually applied and how many
         * distinct targets were used. The UI prints "within 24s (avg, per
         * queue)" instead of naming one number that only half the calls faced.
         */
        'perQueue' => $perQueueSla,
        'avgTargetSeconds' => $answeredInbound > 0 ? (int)round($slaTargetSum / $answeredInbound) : $slaSeconds,
        'targetsUsed' => count($slaTargets),
    ];

    $panel = static function(array $group, string $kind): array {
        $count = count($group);
        $talk = array_sum(array_map(fn($c) => seconds($c, 'call-talking-duration-seconds'), $group));
        $rings = array_map(fn($c) => ringSeconds($c), $group);
        /*
         * Sprint B: connects ÷ attempts for the outbound panel, so the contact
         * rate is available where the outbound AHT already was (the Settings
         * live chip reads this block) without a second definition of
         * "answered" living in the client. The test is callAnswered(), the same
         * one the agents endpoint and the type classifier use.
         */
        $connected = 0;
        foreach ($group as $member) {
            if (callAnswered($member)) {
                $connected++;
            }
        }
        return [
            'count' => $count,
            'avgHandling' => $count ? (int)round($talk / $count) : 0,
            'avgAnswer' => $count ? (int)round(array_sum($rings) / $count) : 0,
            'avgRing' => $count ? (int)round(array_sum($rings) / $count) : 0,
            'longestTalk' => $group ? max(array_map(fn($c) => seconds($c, 'call-talking-duration-seconds'), $group)) : 0,
            'totalTalk' => $talk,
            'connected' => $connected,
            'connectPct' => $count ? round(($connected / $count) * 100, 1) : 0.0,
        ];
    };
    return [
        'counts' => $counts,
        'inbound' => $panel($sets['inbound'], 'inbound'),
        'outbound' => $panel($sets['outbound'], 'outbound'),
        'hours' => $hours,
        /*
         * The same 24 hours with their detail, so a totals row under the hourly
         * grid adds up the numbers a manager can see rather than re-deriving
         * them per screen. `calls` counts every call in scope (the $hours series
         * unchanged); `answered` is inbound answered, which is AHT's denominator.
         */
        'hourly' => array_map(
            static fn(int $h): array => [
                'hour' => $h,
                'calls' => $hours[$h],
                'answered' => $hourInbound[$h],
                'missed' => $hourMissed[$h],
                'talkSeconds' => $hourTalk[$h],
                'aht' => $hourInbound[$h] > 0 ? (int)round($hourTalk[$h] / $hourInbound[$h]) : 0,
            ],
            range(0, 23)
        ),
        'days' => $days,
        'missedBreakdown' => $missedBreakdown,
        'serviceLevel' => $serviceLevel,
        'waitBuckets' => $waitBuckets,
        'missedWaitBuckets' => $missedWaitBuckets,
        'abandonWaitBuckets' => $abandonWaitBuckets,
        'hold' => [
            'totalSeconds' => $holdTotal,
            'calls' => $holdCalls,
            'avgSeconds' => $holdCalls > 0 ? (int)round($holdTotal / $holdCalls) : 0,
        ],
    ];
}

/*
 * ==========================================================================
 * SPRINT A ROW-SET FILTERS
 * ==========================================================================
 *
 * api/calls.php and api/report.php both offer these now (the dashboard KPIs
 * have to move with the filter bar, or a manager filters to "abandoned" and
 * reads an unchanged page). They live here, once, for the same reason the
 * outcome classifier does: two copies of a filter drift, and a drift between
 * the dashboard and its drill-down is the bug this sprint exists to remove.
 */

/** The canonical outcome filter (answered / abandoned / voicemail / noanswer). */
function filterCallsByOutcome(array $calls, string $outcome, array $directory = [], array $queueIds = []): array
{
    if (!in_array($outcome, callOutcomeKinds(), true)) {
        return array_values($calls);
    }
    return array_values(array_filter(
        $calls,
        static fn(array $call): bool => callOutcome($call, $directory, $queueIds) === $outcome
    ));
}

/**
 * The wait bucket filter, with the SAME band edges summary() counts:
 * 0-30, 31-60, 61-120, 120+. Only answered inbound calls are banded, like the
 * card; `waitedOver` is direction-agnostic (a caller who gave up after 70 s
 * waited too).
 */
function filterCallsByWait(array $calls, string $bucket = '', ?int $waitedOver = null): array
{
    if ($bucket === '' && $waitedOver === null) {
        return array_values($calls);
    }
    return array_values(array_filter(
        $calls,
        static function (array $call) use ($bucket, $waitedOver): bool {
            $waited = waitSeconds($call);
            if ($waitedOver !== null && $waited < $waitedOver) {
                return false;
            }
            if ($bucket === '') {
                return true;
            }
            if (callType($call) !== 'inbound') {
                return false;
            }
            return match ($bucket) {
                '0-30' => $waited <= 30,
                '31-60' => $waited > 30 && $waited <= 60,
                '61-120' => $waited > 60 && $waited <= 120,
                '120+' => $waited > 120,
                default => true,
            };
        }
    ));
}

/**
 * The returned-call filter, over the whole set it is given (so combining it
 * with a queue or agent filter still finds the calls that were returned).
 * Matching itself is the links layer's - one definition.
 *
 * Both sets are needed, and this is subtle: "unreturned" is NOT "everything
 * that is not returned". Every answered call and every outbound leg is also
 * "not returned", so filtering on the complement alone turned a two-row
 * worklist into the whole day. `unreturnedRoots` is the set of MISSED
 * conversations nobody called back - that, and only that, is the worklist.
 */
function filterCallsByCallback(
    array $calls,
    string $state,
    array $returnedRoots,
    array $unreturnedRoots,
    array $legIndex
): array {
    if ($state === '') {
        return array_values($calls);
    }
    return array_values(array_filter(
        $calls,
        static function (array $call) use ($state, $returnedRoots, $unreturnedRoots, $legIndex): bool {
            $root = cdrRootKey($call, $legIndex);
            return $state === 'returned'
                ? isset($returnedRoots[$root])
                : isset($unreturnedRoots[$root]);
        }
    ));
}

/** The valid values, for endpoints that validate a request parameter. */
function callWaitBuckets(): array
{
    return ['0-30', '31-60', '61-120', '120+'];
}

function callCallbackStates(): array
{
    return ['returned', 'unreturned'];
}

/*
 * ==========================================================================
 * COMPARISON MODES (manager review, F3)
 * ==========================================================================
 *
 * The dashboard had one baseline: the previous period of equal length. That is
 * the wrong baseline for the two questions the review actually asks -
 * "yesterday is the wrong baseline for a Wednesday huddle, and last month is
 * the wrong baseline for a monthly review that has a different number of
 * business days in it".
 *
 * Every mode below shifts the requested range to another range and the caller
 * runs the SAME pipeline over it, so a comparison can never be computed with
 * different semantics than the period it is compared against.
 */

/** The valid comparison modes, for endpoints that validate a request value. */
function compareModes(): array
{
    return ['previous', 'weekday', 'month', 'mtd', 'year'];
}

function normalizeCompareMode($requested): string
{
    $mode = strtolower(trim((string)$requested));
    return in_array($mode, compareModes(), true) ? $mode : 'previous';
}

/**
 * Shift a Y-m-d by whole months (or years) without PHP's month-end surprise.
 *
 * `(new DateTimeImmutable('2026-03-31'))->modify('-1 month')` is 2026-03-03 -
 * PHP overflows the 31st into the next month. A comparison baseline that
 * silently points at the wrong month is worse than no baseline, so the day is
 * clamped to the last day of the target month instead.
 */
function shiftMonthsClamped(string $date, int $months): string
{
    try {
        $at = new DateTimeImmutable($date);
    } catch (Throwable $e) {
        return $date;
    }
    $day = (int)$at->format('j');
    $firstOfTarget = $at->modify('first day of this month')->modify(($months >= 0 ? '+' : '') . $months . ' months');
    $lastDay = (int)$firstOfTarget->format('t');
    return $firstOfTarget->setDate(
        (int)$firstOfTarget->format('Y'),
        (int)$firstOfTarget->format('n'),
        min($day, $lastDay)
    )->format('Y-m-d');
}

/**
 * The comparison range for a mode, with a label that states the baseline AND
 * the period length (review §5.3: "vs previous 7 days", not "vs previous").
 *
 *   previous  the equal-length period immediately before (the old behaviour)
 *   weekday   the same dates one week earlier - for a daily huddle, yesterday
 *             last week is the honest baseline: same weekday, same hours
 *   mtd       the same dates one month earlier, clamped to that month's length
 *             (month-to-date against the same point last month)
 *   month     identical to mtd when the range is one calendar month; kept as
 *             its own mode because that is the name a reader looks for
 *   year      the same dates one year earlier (month-end and 29 February are
 *             clamped), which is what "how does this compare to last year"
 *             means for a report that is a calendar month
 */
function comparePeriodFilters(array $filters, string $mode = 'previous'): array
{
    $mode = normalizeCompareMode($mode);
    $start = new DateTimeImmutable((string)$filters['start']);
    $end = new DateTimeImmutable((string)$filters['end']);
    $days = (int)$start->diff($end)->days + 1;

    if ($mode === 'weekday') {
        $compareStart = $start->modify('-7 days')->format('Y-m-d');
        $compareEnd = $end->modify('-7 days')->format('Y-m-d');
    } elseif ($mode === 'month' || $mode === 'mtd') {
        $compareStart = shiftMonthsClamped((string)$filters['start'], -1);
        $compareEnd = shiftMonthsClamped((string)$filters['end'], -1);
    } elseif ($mode === 'year') {
        $compareStart = shiftMonthsClamped((string)$filters['start'], -12);
        $compareEnd = shiftMonthsClamped((string)$filters['end'], -12);
    } else {
        /* previous: default, and the fallback and the old behaviour. */
        $compareEnd = $start->modify('-1 day')->format('Y-m-d');
        $compareStart = (new DateTimeImmutable($compareEnd))->modify('-' . ($days - 1) . ' days')->format('Y-m-d');
    }

    $startAt = new DateTimeImmutable($compareStart);
    $endAt = new DateTimeImmutable($compareEnd);
    $compareDays = (int)$startAt->diff($endAt)->days + 1;
    $dayWord = $compareDays === 1 ? 'day' : 'days';

    $labels = [
        'previous' => 'previous ' . $compareDays . ' ' . $dayWord,
        'weekday' => 'same weekday last week',
        'month' => 'same ' . $compareDays . ' ' . $dayWord . ' last month',
        'mtd' => 'same point last month',
        'year' => 'same ' . $compareDays . ' ' . $dayWord . ' last year',
    ];

    return [
        'mode' => $mode,
        'label' => $labels[$mode],
        'days' => $compareDays,
        'start' => $compareStart,
        'end' => $compareEnd,
    ];
}

/**
 * The previous equal-length period, as a filters array.
 *
 * Kept because callers outside report.php use it; it is now a thin wrapper so
 * there is only one implementation of the date arithmetic.
 */
function previousFilters(array $filters): array {
    $compare = comparePeriodFilters($filters, 'previous');
    $filters['start'] = $compare['start'];
    $filters['end'] = $compare['end'];
    return $filters;
}

function filterCallTypes(
    array $calls,
    array $callTypes
): array {

    /*
     * Default:
     * Everything enabled.
     */
    $enabled = [
        'inbound'  => !isset($callTypes['inbound'])
            || (bool)$callTypes['inbound'],

        'outbound' => !isset($callTypes['outbound'])
            || (bool)$callTypes['outbound'],

        'missed'   => !isset($callTypes['missed'])
            || (bool)$callTypes['missed'],

        'onnet'    => !isset($callTypes['onnet'])
            || (bool)$callTypes['onnet'],
    ];

    /*
     * If everything is enabled,
     * return the original array.
     */
    if (
        $enabled['inbound'] &&
        $enabled['outbound'] &&
        $enabled['missed'] &&
        $enabled['onnet']
    ) {
        return $calls;
    }

    return array_values(
        array_filter(
            $calls,
            static function (array $call) use ($enabled): bool {

                /*
                 * IMPORTANT:
                 *
                 * normalizeCdrs() stores the classification
                 * in $_type.
                 *
                 * callType() is the single source of truth.
                 */
                $type = callType($call);

                return match ($type) {

                    'inbound' =>
                        $enabled['inbound'],

                    'outbound' =>
                        $enabled['outbound'],

                    'missed' =>
                        $enabled['missed'],

                    'onnet' =>
                        $enabled['onnet'],

                    default =>
                        false
                };
            }
        )
    );
}

function agentPerformance(
    array $calls,
    array $directory,
    array $queueIds = []
): array {

    $agents = [];

    foreach ($calls as $call) {

        /*
         * Determine agent.
         */
        $extension = trim(
            callAgent($call)
        );

        if ($extension === '') {
            continue;
        }

        /*
         * Get directory information.
         */
        $directoryEntry =
            $directory[$extension] ?? [];

        /*
         * Ignore system/service users.
         *
         * Same behavior as Top Agents.
         */
        if (
            ($directoryEntry['serviceCode'] ?? '') !== ''
        ) {
            continue;
        }

        /*
         * Create agent record.
         */
        if (!isset($agents[$extension])) {

            $agents[$extension] = [

                'extension' =>
                    $extension,

                'department' =>
                    callDepartment($call)
                    ?: (string)(
                        $directoryEntry['department']
                        ?? ''
                    ),

                'site' =>
                    callSite($call)
                    ?: (string)(
                        $directoryEntry['site']
                        ?? ''
                    ),

                'name' =>
                    (string)(
                        $directoryEntry['name']
                        ?? $extension
                    ),

                /*
                 * Call counts.
                 */
                'total' => 0,
                'ib' => 0,
                'ob' => 0,
                'mc' => 0,
                'ab' => 0,
                'onnet' => 0,

                /*
                 * Inbound accumulators.
                 */
                '_ibTalk' => 0,
                '_ibAnswer' => 0,
                '_ibLongestTalk' => 0,
                '_ibTotal' => 0,

                /*
                 * Outbound accumulators.
                 */
                '_obRing' => 0,
                '_obAnswer' => 0,
                '_obLongestTalk' => 0,
                '_obTotal' => 0
            ];
        }

        /*
         * Classify the call using the SAME
         * classification as summary().
         */
        $type = callType($call);

        /*
         * Duration values.
         */
        $talking =
            seconds(
                $call,
                'call-talking-duration-seconds'
            );

        $total =
            seconds(
                $call,
                'call-total-duration-seconds'
            );

        /*
         * Ring / answer duration.
         *
         * Existing summary() defines this as:
         *
         * total duration - talking duration
         */
        $answer =
            max(
                0,
                $total - $talking
            );

        /*
         * Total call count.
         */
        $agents[$extension]['total']++;

        /*
         * Call classification.
         */
        switch ($type) {

            case 'inbound':

                $agents[$extension]['ib']++;

                $agents[$extension]['_ibTalk']
                    += $talking;

                $agents[$extension]['_ibAnswer']
                    += $answer;

                $agents[$extension]['_ibTotal']
                    += $talking;

                if (
                    $talking >
                    $agents[$extension]['_ibLongestTalk']
                ) {
                    $agents[$extension]['_ibLongestTalk']
                        = $talking;
                }

                break;


            case 'outbound':

                $agents[$extension]['ob']++;

                $obRing = ringSeconds($call);
                if ($obRing <= 0) {
                    $obRing = $answer;
                }

                $agents[$extension]['_obRing']
                    += $obRing;

                $agents[$extension]['_obAnswer']
                    += $obRing;

                $agents[$extension]['_obTotal']
                    += $talking;

                if (
                    $talking >
                    $agents[$extension]['_obLongestTalk']
                ) {
                    $agents[$extension]['_obLongestTalk']
                        = $talking;
                }

                break;


            case 'missed':

                /*
                 * mc + ab is every missed call this agent was involved in.
                 * `ab` used to be declared and never incremented, so abandoned
                 * calls were dropped from BOTH columns and the Agents table's
                 * Abandoned column read 0 for every agent.
                 */
                if (callIsAbandoned($call, $directory, $queueIds)) {
                    $agents[$extension]['ab']++;
                } else {
                    $agents[$extension]['mc']++;
                }

                break;


            case 'onnet':

                $agents[$extension]['onnet']++;

                break;
        }
    }


    /*
     * Convert accumulated values into
     * the exact fields expected by React.
     */
    foreach ($agents as &$agent) {

        /*
         * Inbound.
         */
        $ibCount =
            $agent['ib'];

        $agent['ibAht'] =
            $ibCount > 0
                ? (int)round(
                    $agent['_ibTalk'] /
                    $ibCount
                )
                : 0;

        $agent['ibAat'] =
            $ibCount > 0
                ? (int)round(
                    $agent['_ibAnswer'] /
                    $ibCount
                )
                : 0;

        $agent['ibLtt'] =
            $agent['_ibLongestTalk'];

        $agent['ibTct'] =
            $agent['_ibTotal'];


        /*
         * Outbound.
         */
        $obCount =
            $agent['ob'];

        $agent['obArt'] =
            $obCount > 0
                ? (int)round(
                    $agent['_obRing'] /
                    $obCount
                )
                : 0;

        $agent['obAat'] =
            $obCount > 0
                ? (int)round(
                    $agent['_obAnswer'] /
                    $obCount
                )
                : 0;

        $agent['obLtt'] =
            $agent['_obLongestTalk'];

        $agent['obTct'] =
            $agent['_obTotal'];

        $offered = (int)$agent['ib'] + (int)$agent['mc'] + (int)$agent['ab'];
        $agent['offered'] = $offered;
        /*
         * Missed rate counts every missed call — abandoned ones included —
         * over offered inbound, the same definition the Dashboard and the
         * Alerts screen use. (mc alone would be the no-answer share and would
         * make the Agents table disagree with the Dashboard for one label.)
         */
        $agent['mcRate'] = $offered > 0
            ? round(100 * ((int)$agent['mc'] + (int)$agent['ab']) / $offered, 1)
            : 0.0;
        $agent['abRate'] = $offered > 0
            ? round(100 * (int)$agent['ab'] / $offered, 1)
            : 0.0;

        /*
         * Remove internal accumulator fields.
         */
        unset(
            $agent['_ibTalk'],
            $agent['_ibAnswer'],
            $agent['_ibLongestTalk'],
            $agent['_ibTotal'],
            $agent['_obRing'],
            $agent['_obAnswer'],
            $agent['_obLongestTalk'],
            $agent['_obTotal']
        );
    }

    unset($agent);


    /*
     * Sort by total calls descending.
     *
     * This makes the busiest agents appear first.
     */
    usort(
        $agents,
        static function (
            array $a,
            array $b
        ): int {

            if (
                $a['total'] ===
                $b['total']
            ) {
                return strcasecmp(
                    $a['name'],
                    $b['name']
                );
            }

            return
                $b['total']
                <=>
                $a['total'];
        }
    );


    return array_values($agents);
}

function findRelatedCdrs(
    array $allCdrs,
    array $cdr
): array {

    /*
     * The id vocabulary lives in links.php. This function used to read six
     * fields where api/queue.php read eight (`call-id`, `cdr-id` were missing),
     * so the same call could be one interaction here and two there - exactly the
     * kind of drift that makes two screens disagree about one call.
     */
    $ids = [];
    foreach (cdrIdBag($cdr) as $id) {
        $ids[$id] = true;
    }

    if (!$ids) {
        return [];
    }

    $related = [];

    foreach ($allCdrs as $item) {

        if (!is_array($item)) {
            continue;
        }

        foreach (cdrIdBag($item) as $value) {

            if (isset($ids[$value])) {

                $related[] = $item;

                break;
            }
        }
    }

    usort(
        $related,
        static function (
            array $a,
            array $b
        ): int {

            return strcmp(
                (string)(
                    $a['call-start-datetime'] ?? ''
                ),
                (string)(
                    $b['call-start-datetime'] ?? ''
                )
            );
        }
    );

    return $related;
}

function extractDtmfCase(array $cdr): string
{
    $reason = trim(
        (string)(
            $cdr['call-disconnect-reason-text'] ?? ''
        )
    );

    $preRouting = trim(
        (string)(
            $cdr['call-term-pre-routing-uri'] ?? ''
        )
    );

    if (
        $preRouting === '' ||
        stripos($preRouting, 'sip:NotFound@') !== 0
    ) {
        return '';
    }

    if (
        preg_match(
            '/DTMF\s*<(\d+)>/i',
            $reason,
            $matches
        )
    ) {
        return (string)$matches[1];
    }

    return '';
}

function resolveAaAdditionalTier(
    array $aaCache,
    string $extension,
    string $additionalTier
): array {

    $result = [
        'prompt' => '',
        'description' => '',
        'destinationApplication' => '',
        'destinationUser' => ''
    ];

    if (
        $extension === '' ||
        $additionalTier === ''
    ) {
        return $result;
    }

    foreach (
        ($aaCache['byPrompt'] ?? []) as $prompt => $config
    ) {

        if (!is_array($config)) {
            continue;
        }

        $configExtension =
            (string)(
                $config['_extension']
                ?? $config['extension']
                ?? $config['user']
                ?? ''
            );

        if ($configExtension !== $extension) {
            continue;
        }

        $parentPrompt =
            trim((string)(
                $config['parent-prompt']
                ?? $config['parentPrompt']
                ?? ''
            ));

        $parentCase =
            trim((string)(
                $config['parent-option']
                ?? $config['parentCase']
                ?? ''
            ));

        if ($parentCase !== $additionalTier) {
            continue;
        }

        $nestedPrompt =
            trim((string)(
                $config['_prompt']
                ?? $config['prompt']
                ?? $prompt
            ));

        if ($nestedPrompt === '') {
            continue;
        }

        $result['prompt'] = $nestedPrompt;

        /*
         * The description belongs to the option
         * that sent the caller into this nested AA.
         */
        if (
            $parentPrompt !== '' &&
            isset($aaCache['byPrompt'][$parentPrompt])
        ) {
            $parentConfig =
                $aaCache['byPrompt'][$parentPrompt];

            $options =
                $parentConfig['options'] ?? [];

            if (isset($options[$additionalTier])) {
                $option = $options[$additionalTier];

                $result['description'] =
                    trim((string)(
                        $option['description'] ?? ''
                    ));
            }
        }

        /*
         * We already resolved the exact nested prompt.
         * Therefore derive the destination from that
         * resolved prompt instead of guessing it.
         */
        $result['destinationApplication'] = 'Prompt';

        $result['destinationUser'] =
            preg_replace(
                '/^Prompt_/',
                '',
                $nestedPrompt
            );

        return $result;
    }

    return $result;
}
