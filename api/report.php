<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

try {

    $user = currentUser();

    /* FUNC-17: malformed JSON bodies are a 422, never a silent "no filters". */
    $requested = readJsonBody();

	/*
 * Call type filters.
 *
 * Default is everything enabled.
 */
$callTypes = [
    'inbound'  => true,
    'outbound' => true,
    'missed'   => true,
    'onnet'    => true,
];

if (
    isset($requested['callTypes']) &&
    is_array($requested['callTypes'])
) {
    foreach ($callTypes as $key => $default) {

        if (
            array_key_exists(
                $key,
                $requested['callTypes']
            )
        ) {
            $callTypes[$key] =
                (bool)$requested['callTypes'][$key];
        }
    }
}

    /*
     * Apply authorized filters.
     *
     * This includes:
     * - start
     * - end
     * - department
     * - site
     * - agents where applicable
     */
    $filters = authorizedFilters(
        $requested,
        $user
    );

    if ($filters['end'] < $filters['start']) {
        jsonResponse(
            ['error' => 'Invalid date range'],
            422
        );
    }

    /*
     * Load directory / CDR data.
     */
    $directory = userDirectory($user);
    $queueIds = [];
    $queueLabels = [];
    foreach (cachedCallQueues($user) as $qrow) {
        if (!is_array($qrow)) {
            continue;
        }
        $qid = trim((string)($qrow['callqueue'] ?? ''));
        if ($qid !== '') {
            $queueIds[$qid] = true;
            $label = trim((string)($qrow['description'] ?? ''));
            $queueLabels[$qid] = $label !== '' ? $label : $qid;
        }
    }

    /*
     * =========================================================
     * COMPARISON-ONLY REQUEST
     * =========================================================
     *
     * Serves the lazy second pass. Fetches ONLY the previous period and
     * returns early, so it never pays for the current period a second
     * time. Deliberately mirrors the same slaSeconds / directory /
     * queueIds as the main request (FUNC-23) so the two halves stay
     * comparable.
     */
    /*
     * F3: which baseline the comparison uses. `compare` is optional and an
     * unknown value falls back to the previous equal-length period, so an old
     * bookmarked URL behaves exactly as it did.
     */
    $compareMode = normalizeCompareMode($requested['compare'] ?? 'previous');

    if (!empty($requested['previousOnly'])) {
        $slaSeconds = resolveSlaSeconds($requested, $user);
        /* Per-queue targets apply to the comparison period too, otherwise the
         * two halves of the dashboard would be judged by different rules. */
        $settings = loadDomainSettings((string)($user['domain'] ?? ''));
        $compare = comparePeriodFilters($filters, $compareMode);
        $previousFilters = $filters;
        $previousFilters['start'] = $compare['start'];
        $previousFilters['end'] = $compare['end'];

        $previousCalls = filterCallsByLocalDate(
            reportingCdrRows($user, $previousFilters, $directory, $callTypes),
            (string)$previousFilters['start'],
            (string)$previousFilters['end']
        );

        $previous = summary($previousCalls, $slaSeconds, $directory, $queueIds, $settings);

        jsonResponse([
            'comparison' => [
                /* Which baseline this is, stated so the client can label it. */
                'mode' => $compare['mode'],
                'label' => $compare['label'],
                'days' => $compare['days'],
                'previous' => [
                    'start'  => $previousFilters['start'],
                    'end'    => $previousFilters['end'],
                    'counts' => $previous['counts'],
                    /*
                     * Same breakdown as the current period, so the client can
                     * compute a previous abandon rate instead of guessing one
                     * (the Agent overview previously divided the whole previous
                     * missed count as if it were abandons).
                     */
                    'missedBreakdown' => $previous['missedBreakdown'] ?? [],
                    'hours'  => $previous['hours'] ?? [],
                ],
            ],
            'timezone' => DEFAULT_TIMEZONE,
        ]);
    }

    $calls = reportingCdrRows(
        $user,
        $filters,
        $directory,
        $callTypes
    );

    /*
     * FUNC-24 FIX: drop rows whose start datetime cannot be parsed — on BOTH
     * periods. Previously only the previous period was filtered, so a
     * malformed timestamp would silently flatter "vs last period" numbers.
     */
    $calls = filterCallsByLocalDate(
        $calls,
        (string)$filters['start'],
        (string)$filters['end']
    );

    /*
     * The Sprint A narrowing filters, applied to the SAME row set every figure
     * below is computed from. A filter bar that changes the colour of a card but
     * not its number is worse than no filter, so these run before any aggregate
     * - and through the shared helpers in rows.php, so the drill-down list and
     * these KPIs cannot disagree about which calls are in scope.
     */
    $requestedOutcome = strtolower(trim((string)($requested['outcome'] ?? '')));
    $calls = filterCallsByOutcome($calls, $requestedOutcome, $directory, $queueIds);

    $requestedWaitBucket = strtolower(trim((string)($requested['waitBucket'] ?? '')));
    if (!in_array($requestedWaitBucket, callWaitBuckets(), true)) {
        $requestedWaitBucket = '';
    }
    $requestedWaitedOver = $requested['waitedOver'] ?? null;
    $requestedWaitedOver = ($requestedWaitedOver === null || $requestedWaitedOver === '')
        ? null
        : max(0, min(86400, (int)$requestedWaitedOver));
    $calls = filterCallsByWait($calls, $requestedWaitBucket, $requestedWaitedOver);

    /*
     * Sprint B: the sentiment filter, applied to the same row set as every
     * other narrowing filter, so "negative only" numbers and the list behind
     * them are the same calls.
     */
    $requestedSentiment = strtolower(trim((string)($requested['sentiment'] ?? '')));
    $calls = filterCallsBySentiment($calls, $requestedSentiment);

    $requestedCallbackState = strtolower(trim((string)($requested['callbackState'] ?? '')));
    if (!in_array($requestedCallbackState, callCallbackStates(), true)) {
        $requestedCallbackState = '';
    }
    if ($requestedCallbackState !== '' || !empty($requested['callbackOnly'])) {
        $links = cdrCallbacks($calls, 86400);
        $legIndexForCallback = cdrLegIndex($calls);
        $calls = filterCallsByCallback(
            $calls,
            $requestedCallbackState,
            $links['returned'],
            $links['unreturned'],
            $legIndexForCallback
        );
        if ($requestedCallbackState === '' && !empty($requested['callbackOnly'])) {
            $callbackRoots = array_merge($links['returned'], $links['unreturned']);
            $calls = array_values(array_filter(
                $calls,
                static fn(array $call): bool => isset($callbackRoots[cdrRootKey($call, $legIndexForCallback)])
            ));
        }
    }

	$agentPerformance = agentPerformance(
		$calls,
		$directory,
		$queueIds
	);


    /*
     * Current report summary.
     *
     * FUNC-16/FUNC-27: SLA window resolved by the shared helper (domain
     * settings default, clamped 1..120) — same as calls/queue/cradle.
     */
    $slaSeconds = resolveSlaSeconds($requested, $user);
    $settings = loadDomainSettings((string)($user['domain'] ?? ''));

    $current = summary($calls, $slaSeconds, $directory, $queueIds, $settings);

    /*
     * How complete the underlying data is. cdrRangeCacheStatus() says whether
     * every day in the range is cached; the per-day detail adds the two facts a
     * reader needs before quoting a number: how many records each day holds, and
     * whether the fetch that filled it finished (a partial day is short).
     */
    $cacheStatus = cdrRangeCacheStatus(
        $user,
        (string)$filters['start'],
        (string)$filters['end']
    );
    $dataQualityDays = [];
    $incompleteDays = 0;
    $emptyDays = 0;
    foreach (reportingDateList((string)$filters['start'], (string)$filters['end']) as $date) {
        $meta = cdrDayCacheMeta((string)($user['domain'] ?? ''), $date);
        $complete = !empty($meta['complete']);
        $records = (int)($meta['records'] ?? 0);
        if (!$complete) {
            $incompleteDays++;
        }
        if ($complete && $records === 0) {
            $emptyDays++;
        }
        $dataQualityDays[$date] = [
            'records' => $records,
            'complete' => $complete,
            'cached' => !empty($meta['exists']),
        ];
    }
    $dataQuality = [
        'days' => $dataQualityDays,
        'incompleteDays' => $incompleteDays,
        'emptyDays' => $emptyDays,
        /* The scope the numbers were computed over, restated where a reader can
         * see it without opening the filter bar. */
        'hours' => (string)($filters['hours'] ?? 'all'),
        'businessHoursConfigured' => businessHoursConfigured($settings),
    ];

    /*
     * Sprint A: the links layer. Transfers, the returned-call worklist and the
     * repeat callers are derived from the SAME scoped row set as every other
     * number in this payload, so the hours filter, the department filter and the
     * site filter move them together with the counts beside them.
     */
    $links = callLinkReport($calls, $directory);

    /*
     * Previous period.
     *
     * PERF: this is a SECOND full CDR fetch. On a wide date range it can
     * easily cost as much as the current period, and because it ran
     * unconditionally the caller waited for both before seeing anything
     * — the progress bar completed while the request was still fetching
     * history nobody had asked to see yet.
     *
     * The client now requests the current period with skipPrevious=1 and
     * fetches comparison separately (previousOnly=1) once the dashboard
     * is on screen. Both flags are optional, so any caller that does not
     * send them keeps the original single-request behaviour.
     */
    $compare = comparePeriodFilters($filters, $compareMode);
    $previousFilters = $filters;
    $previousFilters['start'] = $compare['start'];
    $previousFilters['end'] = $compare['end'];
    $skipPrevious = !empty($requested['skipPrevious']);

    if ($skipPrevious) {
        $previous = ['counts' => []];
    } else {
        $previousCalls = reportingCdrRows(
            $user,
            $previousFilters,
            $directory,
            $callTypes
        );

        $previousCalls = filterCallsByLocalDate(
            $previousCalls,
            (string)$previousFilters['start'],
            (string)$previousFilters['end']
        );

        /*
         * FUNC-23 FIX: previous period computed with the SAME slaSeconds,
         * directory and queueIds as the current one (was: default 20 s and
         * empty directory/queueIds — silently different semantics).
         */
        $previous = summary(
            $previousCalls,
            $slaSeconds,
            $directory,
            $queueIds,
            $settings
        );

        /*
         * Release the comparison range here, not at the end of the script: it
         * is a second full period of raw calls, and the baseline pass at the
         * bottom of this file loads a third. Without this the peak of a
         * month-vs-month pack with a baseline was three ranges at once - the
         * production out-of-memory (cache.php:299) was measured while the
         * report was assembling its payload with all three still alive.
         */
        unset($previousCalls);
    }

    /*
     * Calculate trends.
     */
    $trends = [];

    foreach ($current['counts'] as $key => $value) {

        $old = $previous['counts'][$key] ?? 0;

        /*
         * FUNC-26 FIX: a previous period of zero has no meaningful delta —
         * report null (UI renders "n/a") instead of a fake +100%.
         */
        $pct = $old
            ? (($value - $old) / $old) * 100
            : ($value > 0 ? null : 0);

        $trends[$key] = [
            'percent' => $pct === null ? null : round($pct, 1),

            'state' =>
                $pct === null
                    ? 'up'
                    : (
                        abs($pct) < TREND_NOISE_THRESHOLD
                            ? 'flat'
                            : (
                                $pct > 0
                                    ? 'up'
                                    : 'down'
                            )
                    )
        ];
    }



/*
 * ============================================================
 * Top Agents
 * ============================================================
 *
 * Keep the existing compact Top Agents widget.
 */
$topAgents = [];

/*
 * ============================================================
 * Comparison information
 * ============================================================
 *
 * Used by the frontend trend tooltip.
 *
 * Example:
 * Current: 150 calls (Aug 24–26)
 * Previous: 120 calls (Aug 21–23)
 */
$comparison = [
    'current' => [
        'start' => $filters['start'],
        'end'   => $filters['end'],

        'counts' => $current['counts'],
    ],

    /*
     * The baseline, stated: which period it is and how long it is (review §5.3
     * - "vs previous 7 days", with the length visible on monthly views).
     */
    'mode' => $compare['mode'],
    'label' => $compare['label'],
    'days' => $compare['days'],

    'previous' => [
        'start' => $previousFilters['start'],
        'end'   => $previousFilters['end'],

        'counts' => $previous['counts'],
        'missedBreakdown' => $previous['missedBreakdown'] ?? [],
        'hours'  => $previous['hours'] ?? [],
    ],

    /*
     * Lets the client tell "comparison not fetched yet" apart from
     * "comparison fetched and genuinely zero" — without it a skipped
     * period renders as a real -100% swing.
     */
    'pending' => $skipPrevious,
];

foreach (
    $agentPerformance as $agent
) {

    $topAgents[] = [
        'extension' =>
            $agent['extension'],

        'name' =>
            $agent['name'],

        'totalCalls' =>
            $agent['total'],

        /*
         * Inbound volume and inbound-only AHT.
         *
         * The dashboard Top Agents card ranks by these, and they were
         * missing here — the card silently rendered 0 inbound for every
         * agent and an empty "lowest AHT" list, because topAgents only
         * carried blended totals. Same field names as agentPerformance()
         * so both consumers read one vocabulary.
         */
        'ib' =>
            (int)$agent['ib'],

        'ibAht' =>
            (int)$agent['ibAht'],

        'totalTalk' =>
            $agent['ibTct'] +
            $agent['obTct'],

        /*
         * FUNC-25 FIX: AHT = total talk / HANDLED calls (answered inbound
         * + outbound), not / total calls. The old denominator diluted AHT
         * with zero-talk missed/abandoned/on-net calls and disagreed with
         * the Agents screen's per-type average handling time.
         */
        'aht' =>
            ((int)$agent['ib'] + (int)$agent['ob']) > 0
                ? (int)round(
                    (
                        $agent['ibTct'] +
                        $agent['obTct']
                    ) /
                    ((int)$agent['ib'] + (int)$agent['ob'])
                )
                : 0
    ];
}

$topAgents = array_slice(
    $topAgents,
    0,
    10
);


/*
 * Add Top Agents to summary.
 */
$current['topAgents'] = $topAgents;


    /*
     * Sprint C: the month-end pack's two row sets. Built here, from the same
     * scoped $calls and through the same helpers as every figure above, so the
     * printed page cannot disagree with the dashboard it came from. The
     * inventory is passed in so a queue or number that saw NO traffic in the
     * scope still gets a row (zeros are findings too), and so "zero traffic" is
     * only ever claimed about a line the caller actually has.
     */
    $packInventory = reportingInventory($user, $directory, $calls);
    $knownNumbers = [];
    foreach (cachedPhoneNumbers($user) as $nrow) {
        if (!is_array($nrow)) {
            continue;
        }
        $number = trim((string)(
            $nrow['phonenumber']
            ?? $nrow['phone-number']
            ?? $nrow['number']
            ?? ''
        ));
        if ($number === '') {
            continue;
        }
        /* Only live numbers are listed: a disabled-and-silent line is not a
         * finding, and "zero traffic" must keep meaning "nobody called it". */
        if (!numberIsEnabled($nrow['enabled'] ?? true)) {
            continue;
        }
        $knownNumbers[$number] = true;
    }
    $packRows = [
        'queues' => packQueueRows($calls, $directory, $queueIds, $settings, $queueLabels),
        'numbers' => packNumberRows($calls, $directory, $queueIds, array_keys($knownNumbers)),
        /* F7: trust the month before quoting it. Computed over the same scoped
         * rows as every figure above, so the appendix describes the data behind
         * these numbers and not another month's. */
        'quality' => packQuality($calls),
        /* The staffing estimate, with the occupancy assumption it used printed
         * inside it (there is no roster in this system, so it is an assumption,
         * not a measurement). */
        'staffing' => packStaffing($current['hourly'] ?? []),
    ];

    /*
     * The 4-week same-weekday baseline. It is a SECOND fetch (the prior 28
     * days) and the review asked for it only on the pack, so it is computed when
     * the caller asks for it (`baseline=1`) rather than on every dashboard load.
     * Same scope as the period: a baseline built without the site/hours filters
     * would compare two different businesses.
     */
    if (!empty($requested['baseline'])) {
        $baselineEnd = date('Y-m-d', strtotime((string)$filters['start'] . ' 12:00:00 -1 day'));
        $baselineStart = date('Y-m-d', strtotime($baselineEnd . ' 12:00:00 -27 days'));
        $baselineFilters = $filters;
        $baselineFilters['start'] = $baselineStart;
        $baselineFilters['end'] = $baselineEnd;
        $baselineCalls = filterCallsByLocalDate(
            reportingCdrRows($user, $baselineFilters, $directory, $callTypes),
            $baselineStart,
            $baselineEnd
        );
        $packRows['baseline'] = packBaseline($calls, $baselineCalls, $baselineStart, $baselineEnd);
        unset($baselineCalls);
    }

    /*
     * Everything the payload carries is derived data from here on, so the raw
     * rows can go before the response is encoded: json_encode() builds the
     * whole body as a string, and holding the rows through that is another
     * full copy of the period at the peak.
     */
    unset($calls);

    /*
     * Audit and return.
     */
    auditView(
        $user,
        $filters,
        'dashboard'
    );

    jsonResponse([
		'filters' => $filters,
		'callTypes' => $callTypes,
		'summary' => $current,
		'comparison' => $comparison,
		'trends' => $trends,
		'topAgents' => $topAgents,
		'agentPerformance' => $agentPerformance,
		'links' => $links,
		'inventory' => $packInventory,
		/* The month-end pack's per-queue and per-number lines (Sprint C). */
		'pack' => $packRows,
		/*
		 * QA-5: the effective domain thresholds ride along for EVERY role, so a
		 * screen's red/green is the same red/green the manager sees without
		 * handing non-privileged users the settings endpoint.
		 */
		/* The settings actually used for the numbers above, not a second read:
		 * a file written between the two reads would have shipped a threshold
		 * that did not colour these figures. */
		/*
		 * Data quality (the review's F7). Every published figure is only as good
		 * as the day files behind it, and a day whose fetch stopped at the page
		 * cap is silently short: the numbers understate and nothing on screen
		 * says so. The appendix in Sprint C prints this; it ships here so the
		 * fact is available wherever the numbers are.
		 */
		/*
		 * The narrowing filters this response was actually computed with, so a
		 * reader (or a saved link) can see why the numbers are what they are.
		 */
		'appliedFilters' => [
			'outcome' => $requestedOutcome,
			'waitBucket' => $requestedWaitBucket,
			'waitedOver' => $requestedWaitedOver,
			'callbackState' => $requestedCallbackState,
			'sentiment' => in_array($requestedSentiment, callSentimentFilterKinds(), true) ? $requestedSentiment : '',
		],
		'cacheStatus' => $cacheStatus,
		'dataQuality' => $dataQuality,
		'settings' => $settings,
		'timezone' => DEFAULT_TIMEZONE
	]);

} catch (Throwable $e) {

    appExceptionLog('Report', $e);

    jsonResponseThrowable($e, 'Unable to load reporting data.');
}