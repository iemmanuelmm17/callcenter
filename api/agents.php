<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

try {

    $user = currentUser();

    $requested = readJsonBody();

    $filters = authorizedFilters(
        $requested,
        $user
    );

    $users = cachedUsers($user);
    $directory = userDirectory($user);

    /*
     * Queue ids, exactly like api/report.php. They are needed to classify a
     * missed call the same way the Dashboard does: a call that went through a
     * queue and was never answered is abandoned, not missed. Without them this
     * endpoint could only see the `call-batch-start-datetime` signal, so
     * aggregate-only queue abandons and auto attendant abandons landed in the
     * Missed column of the Agents table.
     */
    $queueIds = [];
    foreach (cachedCallQueues($user) as $qrow) {
        if (!is_array($qrow)) {
            continue;
        }
        $qid = trim((string)($qrow['callqueue'] ?? ''));
        if ($qid !== '') {
            $queueIds[$qid] = true;
        }
    }
	
	appLog(
    'AGENTS DEBUG: cachedUsers count = ' .
    count($users)
);
	

    /*
     * Load calls using the existing
     * authorization/filtering logic.
     */
    $allCalls = scopedCdrs(
        normalizeCdrs(
            loadRawCdrs(
                $user,
                $filters
            ),
            $directory
        ),
        $filters,
        $directory
    );


    /*
     * Group calls by agent.
     */
    $agentCalls = [];

    foreach ($allCalls as $call) {

        $agent = callAgent($call);

        if ($agent === '') {
            continue;
        }

        if (!isset($agentCalls[$agent])) {
            $agentCalls[$agent] = [];
        }

        $agentCalls[$agent][] = $call;
    }


    /*
     * Build agent records.
     */
    $rows = [];

    foreach ($users as $item) {

        $extension = (string)($item['user'] ?? '');

        if ($extension === '') {
            continue;
        }


        /*
         * Only include normal users.
         *
         * Service code must be blank.
         *
         * system-aa
         * system-queue
         * system-tod
         * system-flowbot
         * system-conf
         *
         * and all other service users are excluded.
         */
        $serviceCode = trim(
            (string)($item['service-code'] ?? '')
        );

        if ($serviceCode !== '') {
            continue;
        }


        /*
         * Respect user authorization.
         */
        if (
            $user['role'] !== 'office_manager' &&
            ($item['department'] ?? '') !== $user['department']
        ) {
            continue;
        }

        if (
            in_array(
                $user['role'],
                ['agent', 'basic_user'],
                true
            ) &&
            $extension !== $user['extension']
        ) {
            continue;
        }


        $calls = $agentCalls[$extension] ?? [];


        /*
         * Separate call types.
         */
        $inbound = [];
        $outbound = [];

        $total = count($calls);
        $missed = 0;
        $abandoned = 0;
        $onnet = 0;

        foreach ($calls as $call) {

            $type = callType($call);

            if ($type === 'inbound') {
                $inbound[] = $call;
            }

            elseif ($type === 'outbound') {
                $outbound[] = $call;
            }

            elseif ($type === 'missed') {

                /*
                 * Same definition as includes/reporting/rows.php and the
                 * Queues screen (includes/reporting/outcomes.php):
                 * `mc` is missed-and-not-abandoned, `ab` is abandoned, and
                 * mc + ab is every missed call the agent was involved in.
                 * This endpoint used to count every missed call — queue
                 * abandons included — into `mc`, and had no `ab` at all, so
                 * the Agents screen disagreed with the Dashboard and Queues.
                 */
                if (callIsAbandoned($call, $directory, $queueIds)) {
                    $abandoned++;
                } else {
                    $missed++;
                }
            }

            elseif ($type === 'onnet') {
                $onnet++;
            }
        }


        /*
         * Inbound metrics.
         */
        $ibCount = count($inbound);

        $ibTalk = array_sum(
            array_map(
                fn($call) =>
                    seconds(
                        $call,
                        'call-talking-duration-seconds'
                    ),
                $inbound
            )
        );

        $ibRing = array_map(
            fn($call) =>
                max(
                    0,
                    seconds(
                        $call,
                        'call-total-duration-seconds'
                    ) -
                    seconds(
                        $call,
                        'call-talking-duration-seconds'
                    )
                ),
            $inbound
        );

        $ibAht = $ibCount
            ? (int) round($ibTalk / $ibCount)
            : 0;

        $ibAat = $ibCount
            ? (int) round(array_sum($ibRing) / $ibCount)
            : 0;

        $ibLtt = $inbound
            ? max(
                array_map(
                    fn($call) =>
                        seconds(
                            $call,
                            'call-talking-duration-seconds'
                        ),
                    $inbound
                )
            )
            : 0;

        $ibTct = $ibTalk;


        /*
         * Outbound metrics.
         */
        $obCount = count($outbound);

        $obTalk = array_sum(
            array_map(
                fn($call) =>
                    seconds(
                        $call,
                        'call-talking-duration-seconds'
                    ),
                $outbound
            )
        );

        $obRing = array_map(
            fn($call) =>
                max(
                    0,
                    seconds(
                        $call,
                        'call-total-duration-seconds'
                    ) -
                    seconds(
                        $call,
                        'call-talking-duration-seconds'
                    )
                ),
            $outbound
        );

        $obArt = $obCount
            ? (int) round(array_sum($obRing) / $obCount)
            : 0;

        $obAat = $obCount
            ? (int) round(array_sum($obRing) / $obCount)
            : 0;

        $obLtt = $outbound
            ? max(
                array_map(
                    fn($call) =>
                        seconds(
                            $call,
                            'call-talking-duration-seconds'
                        ),
                    $outbound
                )
            )
            : 0;

        $obTct = $obTalk;


        /*
         * Agent name.
         */
        $name = trim(
            ($item['name-first-name'] ?? '') .
            ' ' .
            ($item['name-last-name'] ?? '')
        );

        if ($name === '') {
            $name = $extension;
        }


        /*
         * Build agent row.
         */
        $rows[] = [

            'extension' => $extension,

            'name' => $name,

            'department' =>
                $item['department'] ?? '',

            'site' =>
                $item['site'] ?? '',

            /*
             * Left Agents selector.
             */
            'totalCalls' => $total,

            /*
             * Agent Performance table.
             */
            'total' => $total,

            'ib' => $ibCount,
            'ob' => $obCount,
            'mc' => $missed,
            'ab' => $abandoned,
            'onnet' => $onnet,

            'ibAht' => $ibAht,
            'ibAat' => $ibAat,
            'ibLtt' => $ibLtt,
            'ibTct' => $ibTct,

            'obArt' => $obArt,
            'obAat' => $obAat,
            'obLtt' => $obLtt,
            'obTct' => $obTct
        ];
    }


    /*
     * IMPORTANT:
     * These must be AFTER the users loop.
     */
    auditView(
        $user,
        $filters,
        'agents'
    );

    jsonResponse([
        'data' => $rows
    ]);

} catch (Throwable $e) {

    appLog(
        'Agents: ' .
        $e->getMessage()
    );

    jsonResponse(
        [
            'error' =>
                'Unable to load agents.'
        ],
        502
    );
}


