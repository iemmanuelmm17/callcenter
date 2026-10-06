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
    $start = (string)($filters['start'] ?? '');
    $end = (string)($filters['end'] ?? '');
    return array_values(array_filter($raw, static function(array $row) use ($filters, $directory): bool {
        $agent = callAgent($row); $directoryEntry = $directory[$agent] ?? [];
        $department = callDepartment($row) ?: (string)($directoryEntry['department'] ?? '');
        $site = callSite($row) ?: (string)($directoryEntry['site'] ?? '');
        if ($filters['department'] !== '' && $department !== $filters['department']) return false;
        if (($filters['site'] ?? '') !== '' && $site !== $filters['site']) return false;
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

function summary(array $calls, int $slaSeconds = 20, array $directory = [], array $queueIds = []): array {
    if ($slaSeconds < 1) {
        $slaSeconds = 20;
    }
    $sets = ['inbound'=>[], 'outbound'=>[]];
    $counts = ['total'=>0,'inbound'=>0,'outbound'=>0,'missed'=>0,'onnet'=>0];
    $hours = array_fill(0, 24, 0);
    $days = [];
    $missedBreakdown = ['noanswer'=>0,'voicemail'=>0,'abandon'=>0];
    $inboundRings = [];
    $answeredInSla = 0;

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

        if ($type === 'missed') {
            $kind = missedKind($call, $directory, $queueIds);
            if (!isset($missedBreakdown[$kind])) {
                $kind = 'noanswer';
            }
            $missedBreakdown[$kind]++;
        }

        if ($type === 'inbound') {
            $ring = ringSeconds($call);
            $inboundRings[] = $ring;
            if ($ring <= $slaSeconds) {
                $answeredInSla++;
            }
        }

        $raw = (string)($call['call-start-datetime'] ?? $call['startedAt'] ?? '');
        $at = parseEasternDateTime($raw);
        if ($at instanceof DateTimeImmutable) {
            $hours[(int)$at->format('G')]++;
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
        'answeredInSla' => $answeredInSla,
        'answeredIn20' => $answeredInSla,
        'answered' => $answeredInbound,
        'offered' => $offered,
        'slaSeconds' => $slaSeconds,
        'sla' => $answeredInbound > 0 ? round(($answeredInSla / $answeredInbound) * 100, 1) : 0.0,
        'sla20' => $answeredInbound > 0 ? round(($answeredInSla / $answeredInbound) * 100, 1) : 0.0,
    ];

    $panel = static function(array $group, string $kind): array {
        $count = count($group);
        $talk = array_sum(array_map(fn($c) => seconds($c, 'call-talking-duration-seconds'), $group));
        $rings = array_map(fn($c) => ringSeconds($c), $group);
        return [
            'count' => $count,
            'avgHandling' => $count ? (int)round($talk / $count) : 0,
            'avgAnswer' => $count ? (int)round(array_sum($rings) / $count) : 0,
            'avgRing' => $count ? (int)round(array_sum($rings) / $count) : 0,
            'longestTalk' => $group ? max(array_map(fn($c) => seconds($c, 'call-talking-duration-seconds'), $group)) : 0,
            'totalTalk' => $talk,
        ];
    };
    return [
        'counts' => $counts,
        'inbound' => $panel($sets['inbound'], 'inbound'),
        'outbound' => $panel($sets['outbound'], 'outbound'),
        'hours' => $hours,
        'days' => $days,
        'missedBreakdown' => $missedBreakdown,
        'serviceLevel' => $serviceLevel,
    ];
}

function previousFilters(array $filters): array {
    $start = new DateTimeImmutable($filters['start']); $end = new DateTimeImmutable($filters['end']); $days = $start->diff($end)->days + 1;
    $previousEnd = $start->modify('-1 day'); $previousStart = $previousEnd->modify('-' . ($days - 1) . ' days');
    $filters['start'] = $previousStart->format('Y-m-d'); $filters['end'] = $previousEnd->format('Y-m-d'); return $filters;
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

                if (missedKind($call, $directory, $queueIds) !== 'abandon') {
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
        $agent['mcRate'] = $offered > 0
            ? round(100 * (int)$agent['mc'] / $offered, 1)
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

    $ids = [];

    foreach ([
        'id',
        'call-orig-call-id',
        'call-parent-call-id',
        'call-parent-cdr-id',
        'call-through-call-id',
        'call-term-call-id'
    ] as $field) {

        $value = trim(
            (string)($cdr[$field] ?? '')
        );

        if ($value !== '') {
            $ids[$value] = true;
        }
    }

    if (!$ids) {
        return [];
    }

    $related = [];

    foreach ($allCdrs as $item) {

        if (!is_array($item)) {
            continue;
        }

        foreach ([
            'id',
            'call-orig-call-id',
            'call-parent-call-id',
            'call-parent-cdr-id',
            'call-through-call-id',
            'call-term-call-id'
        ] as $field) {

            $value = trim(
                (string)($item[$field] ?? '')
            );

            if (
                $value !== '' &&
                isset($ids[$value])
            ) {

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
