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
            ?? ''
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

    $metric = trim(
        (string)($requested['metric'] ?? 'total')
    );

    $hour = $requested['hour'] ?? null;

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
        csvRow($out, ['date', 'time', 'type', 'from_name', 'from', 'dialed', 'to', 'agent', 'talk', 'ring', 'reason', 'total']);

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