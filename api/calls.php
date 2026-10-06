<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/export.php';

requireMethod('POST');

/**
 * One call-detail row, exactly as the JSON page returns it. The CSV export
 * uses the same function so the table and the file cannot drift apart.
 */
function callsRow(array $c): array
{
    $row = [

        /*
         * One stable identity per call, the same expression Call history uses
         * (call_history.php). Rows can be opened individually — an agent's
         * recent-call list passes this back as the `callId` filter — and the
         * flow dialog keys off the call ids, so it has to be present here too.
         */
        'id' =>
            (string)($c['id'] ?? $c['call-parent-cdr-id'] ?? ''),

        'startedAt' =>
            $c['call-start-datetime']
            ?? null,

        'date' => (static function (array $call): string {
            $dt = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
            return $dt instanceof DateTimeImmutable ? $dt->format('Y-m-d') : '';
        })($c),

        'time' => (static function (array $call): string {
            $dt = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
            return $dt instanceof DateTimeImmutable ? $dt->format('g:i A') : '';
        })($c),

        'type' =>
            callType($c),

        'agent' =>
            callAgent($c),

        'queue' =>
            (string)($c['call-through-user'] ?? ''),

        'department' =>
            callDepartment($c),

        'site' =>
            callSite($c),

        'from' =>
            callFromName($c),

        'fromNumber' =>
            (callFromNumber($c) !== '' ? callFromNumber($c) : callFrom($c)),

        'dialed' =>
            callDialed($c),

        'to' =>
            callTo($c),

        'talking' =>
            seconds(
                $c,
                'call-talking-duration-seconds'
            ),

        'ringing' =>
            ringSeconds($c),

        'disconnectReason' =>
            callDisconnectReason($c),

        'total' =>
            seconds(
                $c,
                'call-total-duration-seconds'
            ),

        'id' =>
            $c['id']
            ?? $c['call-parent-cdr-id']
            ?? '',

        /*
         * Recording and sip-flow affordances.
         *
         * Both are hints: the call ids and users the PBX would look a recording
         * up by (callRecordingCallId() / callRecordingUser(), shared with
         * call_history.php), the prefilled trace URL for the sip flow, and the
         * same one-line booleans the server keeps separate from the resolution
         * cost. Resolving either one is a PBX walk, so the table gets the
         * booleans and asks only when the user clicks.
         */
        'disconnectedAt' =>
            $c['call-disconnect-datetime'] ?? null,

        'origCallId' =>
            (string)($c['call-orig-call-id'] ?? ''),

        'termCallId' =>
            (string)($c['call-term-call-id'] ?? ''),

        'termUser' =>
            (string)($c['call-term-user'] ?? ''),

        'origUser' =>
            (string)($c['call-orig-user'] ?? ''),

        'recordingCallId' =>
            callRecordingCallId($c),

        'recordingUser' =>
            callRecordingUser($c),

        'servers' => implode(',', (static function (array $call): array {
            $hosts = [];
            foreach ([
                'call-orig-by-hostname',
                'call-term-by-hostname',
                'call-action-by-hostname',
                'call-via-hostname',
                'call-orig-from-host',
                'call-term-to-host',
            ] as $key) {
                $host = trim((string)($call[$key] ?? ''));
                if ($host !== '' && !in_array($host, $hosts, true)) {
                    $hosts[] = $host;
                }
            }
            return $hosts;
        })($c)),

        'traceApi' =>
            callTraceApi($c),

        'hasRecordingHint' =>
            callHasRecordingHint($c),

        'hasFlowHint' =>
            callHasFlowHint($c)
    ];

    return $row;
}


try {

    /*
     * =========================================================
     * REQUEST
     * =========================================================
     */

    $user = currentUser();

    /* FUNC-17: malformed JSON bodies are a 422, never a silent "no filters". */
    $requested = readJsonBody();


    /*
     * =========================================================
     * BASIC FILTERS
     * =========================================================
     */

    $phoneNumber = trim(
        (string)($requested['phoneNumber'] ?? '')
    );

    $callerNumber = trim(
        (string)($requested['callerNumber'] ?? '')
    );

    $agent = trim(
        (string)($requested['agent'] ?? '')
    );

    $queue = trim(
        (string)($requested['queue'] ?? '')
    );

    $queuesOnly = !empty($requested['queuesOnly']);

    /*
     * FUNC-16/FUNC-27: SLA window resolved by the shared helper
     * (domain settings default, clamped 1..120).
     */
    $slaSeconds = resolveSlaSeconds($requested, $user);

    /*
     * QA-8: the metric is validated against the catalog
     * (includes/reporting/metrics.php) instead of silently matching nothing.
     * An empty value keeps its old meaning — no metric filter — so existing
     * callers that omit it are unaffected.
     */
    $metric = trim(
        (string)($requested['metric'] ?? 'total')
    );

    if ($metric === '') {
        $metric = 'total';
    }

    if (!isKnownCallMetric($metric)) {
        jsonResponse(
            ['error' => 'Unknown call metric.'],
            422
        );
    }

    $hour = $requested['hour'] ?? null;

    /*
     * Part-of-an-hour window ('HH:MM' Eastern clock times). The Simultaneous
     * tab counts calls in flight per interval; its rows are 5–60 minutes, so
     * the hour filter alone would list up to four times what was clicked.
     */
    $timeFrom = trim(
        (string)($requested['timeFrom'] ?? '')
    );

    $timeTo = trim(
        (string)($requested['timeTo'] ?? '')
    );

    /*
     * Exact call lookup. The Agents overview's "Recent calls" rows (and
     * anything else that stands for one specific call) open the drill-down on
     * that call instead of on "every call of that type for that agent".
     * Matches any id the CDR carries for the call — its own, its parent's, or
     * either leg's — so a row picked from one screen resolves on the other.
     */
    $callId = trim(
        (string)($requested['callId'] ?? '')
    );

    $callTypes = [
        'inbound'  => true,
        'outbound' => true,
        'missed'   => true,
        'onnet'    => true,
    ];
    if (isset($requested['callTypes']) && is_array($requested['callTypes'])) {
        foreach ($callTypes as $key => $default) {
            if (array_key_exists($key, $requested['callTypes'])) {
                $callTypes[$key] = (bool)$requested['callTypes'][$key];
            }
        }
    }


    /*
     * =========================================================
     * AUTHORIZED FILTERS
     * =========================================================
     */

    $filters = authorizedFilters(
        $requested,
        $user
    );


    /*
     * =========================================================
     * LOAD DIRECTORY
     * =========================================================
     */

    $directory = userDirectory(
        $user
    );
    $queueIdsAll = [];
    foreach (cachedCallQueues($user) as $qrow) {
        if (!is_array($qrow)) {
            continue;
        }
        $id = trim((string)($qrow['callqueue'] ?? ''));
        if ($id !== '') {
            $queueIdsAll[$id] = true;
        }
    }


    /*
     * =========================================================
     * LOAD + NORMALIZE + SCOPE
     * =========================================================
     */

    $calls = reportingCdrRows(
        $user,
        $filters,
        $directory,
        ($queue !== '' || $queuesOnly)
            ? ['inbound' => true, 'outbound' => true, 'missed' => true, 'onnet' => true]
            : $callTypes
    );


    /*
     * =========================================================
     * QUEUE FILTER
     * call-through-user equals the queue extension
     * =========================================================
     */

    if ($queue !== '' || $queuesOnly) {
        $queueIds = [];
        if ($queue !== '') {
            $queueIds[$queue] = true;
        } else {
            foreach (cachedCallQueues($user) as $qrow) {
                if (!is_array($qrow)) {
                    continue;
                }
                $id = trim((string)($qrow['callqueue'] ?? ''));
                if ($id !== '') {
                    $queueIds[$id] = true;
                }
            }
        }
        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($queueIds): bool {
                    return cdrQueueMatch($call, $queueIds) !== '';
                }
            )
        );
    }


    /*
     * =========================================================
     * QUEUE-STAGE SCOPE
     * =========================================================
     *
     * Queue abandoned / offered are QUEUE metrics: api/queue.php counts them
     * over the calls that actually reached a queue, and a missed call that
     * never touched one (a direct ring to an extension, an unanswered AA leg)
     * is not part of either figure. Without this the drill-down added up to
     * more than the cell that was clicked, because the metric filter below
     * would happily accept a non-queue abandon.
     *
     * Scoped here, after the queue filter and before the metric filter, so it
     * applies to both the rows and the CSV export (both read `$calls`).
     */

    if (in_array($metric, ['queue_abandoned', 'queue_offered'], true)) {
        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($queueIdsAll): bool {
                    return cdrQueueMatch($call, $queueIdsAll) !== '';
                }
            )
        );
    }


    /*
     * =========================================================
     * METRIC FILTER
     * =========================================================
     */

    if ($metric !== '' && $metric !== 'total') {

        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($metric, $slaSeconds, $directory, $queueIdsAll, $queue, $queuesOnly): bool {

                    $type = callType($call);
                    $queueScope = $queue !== '' || $queuesOnly;
                    $answeredCall = callAnswered($call);
                    /*
                     * Canonical outcome (includes/reporting/outcomes.php):
                     * a missed call that reached a queue or the auto attendant
                     * and was never answered — the queue's batch leg or the
                     * queue/AA that the CDR went through, whichever the PBX
                     * recorded.
                     */
                    $queueAbandoned = callOutcome($call, $directory, $queueIdsAll, $answeredCall) === 'abandoned';
                    if ($metric === 'incoming' || $metric === 'offered') {
                        return $type === 'inbound' || $type === 'missed';
                    }
                    if ($metric === 'missed_voicemail') {
                        return $type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) === 'voicemail';
                    }
                    if ($metric === 'missed_abandon') {
                        return $type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) === 'abandon';
                    }
                    if ($metric === 'missed_noanswer') {
                        return $type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) === 'noanswer';
                    }
                    if ($metric === 'missed_no_abandon') {
                        /*
                         * The Agents table's Missed column: every missed call
                         * that was NOT abandoned (no answer + voicemail), i.e.
                         * exactly the branch includes/reporting/rows.php puts
                         * in `mc`. Without it the cell opened a list that also
                         * contained the abandoned calls.
                         */
                        return $type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) !== 'abandon';
                    }
                    if ($metric === 'answered') {
                        return $answeredCall;
                    }
                    if ($metric === 'abandoned' || $metric === 'queue_abandoned') {
                        if ($queueScope) {
                            return $queueAbandoned;
                        }
                        return $type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) === 'abandon';
                    }
                    if ($metric === 'queue_offered') {
                        if ($queueScope) {
                            return $answeredCall || $queueAbandoned;
                        }
                        return $answeredCall || ($type === 'missed' && callMissedReason($call, $directory, $queueIdsAll) === 'abandon');
                    }
                    if ($metric === 'sla_missed') {
                        return $answeredCall && ringSeconds($call) > $slaSeconds;
                    }
                    if ($metric === 'sla') {
                        return $answeredCall && ringSeconds($call) <= $slaSeconds;
                    }

                    return $type === $metric;
                }
            )
        );
    }


    /*
     * =========================================================
     * CALL FILTER (one specific call)
     * =========================================================
     */

    if ($callId !== '') {

        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($callId): bool {
                    return in_array($callId, callCallIds($call), true);
                }
            )
        );
    }


    /*
     * =========================================================
     * AGENT FILTER
     * =========================================================
     */

    if ($agent !== '') {

        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($agent): bool {

                    return (string)callAgent($call) === $agent;
                }
            )
        );
    }


    /*
     * =========================================================
     * PHONE NUMBER FILTER
     * =========================================================
     */

    if ($phoneNumber !== '') {

        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($phoneNumber): bool {

                    return cdrMatchesPhoneNumber(
                        $call,
                        $phoneNumber
                    );
                }
            )
        );
    }

    if ($callerNumber !== '') {
        $callerKey = preg_replace('/\\D+/', '', $callerNumber) ?? '';
        if (strlen($callerKey) === 11 && str_starts_with($callerKey, '1')) {
            $callerKey = substr($callerKey, 1);
        }
        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($callerKey): bool {
                    $from = preg_replace('/\\D+/', '', callFromNumber($call)) ?? '';
                    if (strlen($from) === 11 && str_starts_with($from, '1')) {
                        $from = substr($from, 1);
                    }
                    return $from !== '' && $from === $callerKey;
                }
            )
        );
    }


    /*
     * =========================================================
     * HOUR FILTER
     * =========================================================
     */

    if (
        $hour !== null &&
        $hour !== ''
    ) {

        $hour = (int)$hour;

        if ($hour >= 0 && $hour <= 23) {

            $timezone = new DateTimeZone(
                DEFAULT_TIMEZONE
            );

            $calls = array_values(
                array_filter(
                    $calls,
                    static function (array $call) use (
                        $hour,
                        $timezone
                    ): bool {

                        $value =
                            $call['call-start-datetime']
                            ?? '';

                        if ($value === '') {
                            return false;
                        }

                        try {

                            $started = parseEasternDateTime(
                                (string)$value,
                                $timezone
                            );
                            if (!$started instanceof DateTimeImmutable) {
                                return false;
                            }

                            return
                                (int)$started->format('G')
                                === $hour;

                        } catch (Throwable $e) {

                            return false;
                        }
                    }
                )
            );
        }
    }


    /*
     * =========================================================
     * WINDOW FILTER (part of an hour)
     * =========================================================
     *
     * Half-open [timeFrom, timeTo) in Eastern wall-clock minutes, and it wraps
     * past midnight (23:45 → 00:00) exactly like the interval that produced it.
     * Both ends must parse: a malformed window is ignored rather than turned
     * into an empty list, which is what a half-typed filter would otherwise do.
     */

    $windowFrom = parseClockMinutes($timeFrom);
    $windowTo = parseClockMinutes($timeTo);

    if ($windowFrom !== null && $windowTo !== null && $windowFrom !== $windowTo) {

        $timezone = reportingTimezone();

        $calls = array_values(
            array_filter(
                $calls,
                static function (array $call) use ($windowFrom, $windowTo, $timezone): bool {

                    $started = parseEasternDateTime(
                        (string)($call['call-start-datetime'] ?? ''),
                        $timezone
                    );
                    if (!$started instanceof DateTimeImmutable) {
                        return false;
                    }

                    $minuteOfDay = ((int)$started->format('G') * 60) + (int)$started->format('i');

                    return $windowFrom <= $windowTo
                        ? ($minuteOfDay >= $windowFrom && $minuteOfDay < $windowTo)
                        : ($minuteOfDay >= $windowFrom || $minuteOfDay < $windowTo);
                }
            )
        );
    }


    /*
     * =========================================================
     * SORT
     * =========================================================
     */

    usort(
        $calls,
        static function (
            array $a,
            array $b
        ): int {

            return strcmp(
                (string)(
                    $b['call-start-datetime']
                    ?? ''
                ),
                (string)(
                    $a['call-start-datetime']
                    ?? ''
                )
            );
        }
    );


    /*
     * CSV EXPORT
     * ----------
     * The modal's export button used to re-request every page (100 rows at a
     * time) and rebuild the CSV in the browser, which repeated the full CDR
     * scan once per page. It now streams the same rows from a single request.
     */
    if (wantsCsvExport($requested)) {
        auditView($user, $filters + ['export' => 'call-details:' . $metric], 'calls_export:' . $metric);

        csvBegin('calls-' . $metric . '-' . ($filters['start'] ?? '') . '-' . ($filters['end'] ?? '') . '.csv');
        $out = csvOpen();
        csvRow($out, ['date', 'time', 'type', 'from_name', 'from', 'dialed', 'to', 'agent', 'talk', 'ring', 'reason', 'total', 'recording', 'sip_flow']);

        $written = 0;
        foreach ($calls as $c) {
            if ($written >= CSV_EXPORT_MAX_ROWS) {
                break;
            }
            $r = callsRow($c);
            $stamp = csvStamp((string)($r['startedAt'] ?? ''));
            csvRow($out, [
                $stamp['date'] !== '' ? $stamp['date'] : (string)($r['date'] ?? ''),
                $stamp['time'] !== '' ? $stamp['time'] : (string)($r['time'] ?? ''),
                $r['type'],
                $r['from'],
                csvPhone($r['fromNumber']),
                csvPhone($r['dialed']),
                csvPhone($r['to']),
                $r['agent'],
                csvDuration($r['talking']),
                csvDuration($r['ringing']),
                $r['disconnectReason'],
                csvDuration($r['total']),
                /*
                 * The two columns the table gained. They say whether a
                 * recording / sip flow EXISTS for the call, not whether one
                 * was fetched — a spreadsheet cannot play either.
                 */
                !empty($r['hasRecordingHint']) ? 'yes' : 'no',
                !empty($r['hasFlowHint']) ? 'yes' : 'no',
            ]);
            $written++;
        }
        csvEnd($out);
    }

    /*
     * =========================================================
     * PAGINATION
     * =========================================================
     */

    $page = max(
        1,
        (int)($requested['page'] ?? 1)
    );

    $size = (int)($requested['size'] ?? 25);
    if ($size < 10) {
        $size = 10;
    }
    if ($size > 100) {
        $size = 100;
    }

    $total =
        count($calls);

    $lastPage =
        max(
            1,
            (int)ceil(
                $total / $size
            )
        );

    $slice =
        array_slice(
            $calls,
            ($page - 1) * $size,
            $size
        );


    /*
     * =========================================================
     * BUILD RESPONSE
     * =========================================================
     */

    $rows = array_map('callsRow', $slice);


    /*
     * =========================================================
     * AUDIT
     * =========================================================
     */

    auditView(
        $user,
        $filters,
        'call-details:' . $metric
    );


    /*
     * =========================================================
     * RESPONSE
     * =========================================================
     */

    jsonResponse([
        'data' =>
            $rows,

        'last_page' =>
            $lastPage,

        'total' =>
            $total
    ]);

} catch (Throwable $e) {

    appExceptionLog('Calls', $e);

    jsonResponse(
        [
            'error' =>
                'Unable to load call details.'
        ],
        502
    );
}