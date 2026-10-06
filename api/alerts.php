<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

try {
    $user = currentUser();
    $requested = readJsonBody();
    $filters = authorizedFilters($requested, $user);
    $settings = loadDomainSettings((string)($user['domain'] ?? ''));
    $directory = userDirectory($user);

    $queueIds = [];
    $queueNames = [];
    foreach (cachedCallQueues($user) as $qrow) {
        if (!is_array($qrow)) {
            continue;
        }
        $id = trim((string)($qrow['callqueue'] ?? ''));
        if ($id === '') {
            continue;
        }
        $queueIds[$id] = true;
        $queueNames[$id] = trim((string)($qrow['description'] ?? $id));
    }

    $aaIds = [];
    foreach ($directory as $ext => $person) {
        if (!is_array($person)) {
            continue;
        }
        if (($person['serviceCode'] ?? '') === 'system-aa') {
            $aaIds[(string)$ext] = (string)($person['name'] ?? $ext);
        }
    }

    $calls = reportingCdrRows($user, $filters, $directory, [
        'inbound' => true,
        'outbound' => true,
        'missed' => true,
        'onnet' => true,
    ]);

    $init = static function (string $id, string $name, string $kind): array {
        return [
            'id' => $id,
            'name' => $name,
            'kind' => $kind,
            'offered' => 0,
            'missed' => 0,
            'abandon' => 0,
            'answered' => 0,
            'talk' => 0,
        ];
    };

    $agents = [];
    $queues = [];
    $aas = [];

    foreach ($calls as $c) {
        if (!is_array($c)) {
            continue;
        }
        $type = callType($c);
        $talk = seconds($c, 'call-talking-duration-seconds');
        /*
         * Canonical outcome (includes/reporting/outcomes.php) — the same
         * missed / abandoned definitions the Dashboard, Agents, Queues, Auto
         * Attendants and Call history report, so a limit breach here means the
         * same thing it means on the screen the number came from.
         *
         * These used to be `$talk <= 0` tests, which called an answered call
         * with zero talking seconds (an agent picked up and hung up) missed,
         * and only saw an abandon when the directory happened to be passed in.
         */
        $offered = ($type === 'inbound' || $type === 'missed');
        $missed = ($type === 'missed');
        $abandon = ($missed && callMissedReason($c, $directory, $queueIds) === 'abandon');
        /*
         * "Answered" is the type, not `talk > 0`: an agent who picks up and
         * hangs up immediately is answered with zero talking seconds, and
         * counting it as missed (as this did) both inflated the missed rate and
         * left a call that was neither answered nor missed in the totals. With
         * this, offered = answered + missed for every entity.
         */
        $answered = ($type === 'inbound');

        $agentExt = trim((string)callAgent($c));
        $agentCode = (string)($directory[$agentExt]['serviceCode'] ?? '');
        if ($agentExt !== '' && $agentCode === '') {
            if (!isset($agents[$agentExt])) {
                $agents[$agentExt] = $init($agentExt, (string)($directory[$agentExt]['name'] ?? $agentExt), 'user');
            }
            if ($offered) {
                $agents[$agentExt]['offered']++;
            }
            if ($missed) {
                $agents[$agentExt]['missed']++;
            }
            if ($abandon) {
                $agents[$agentExt]['abandon']++;
            }
            if ($answered) {
                $agents[$agentExt]['answered']++;
                $agents[$agentExt]['talk'] += $talk;
            }
        }

        $through = trim((string)($c['call-through-user'] ?? ''));
        if ($through !== '' && isset($queueIds[$through])) {
            if (!isset($queues[$through])) {
                $queues[$through] = $init($through, $queueNames[$through] ?? $through, 'queue');
            }
            $queues[$through]['offered']++;
            if ($missed) {
                $queues[$through]['missed']++;
            }
            if ($abandon) {
                $queues[$through]['abandon']++;
            }
            if ($answered) {
                $queues[$through]['answered']++;
                $queues[$through]['talk'] += $talk;
            }
        }

        $aaExt = '';
        if ($through !== '' && isset($aaIds[$through])) {
            $aaExt = $through;
        } elseif (isset($aaIds[trim((string)($c['call-term-user'] ?? ''))])) {
            $aaExt = trim((string)($c['call-term-user'] ?? ''));
        }
        if ($aaExt !== '') {
            if (!isset($aas[$aaExt])) {
                $aas[$aaExt] = $init($aaExt, $aaIds[$aaExt] ?? $aaExt, 'aa');
            }
            $aas[$aaExt]['offered']++;
            if ($missed) {
                $aas[$aaExt]['missed']++;
            }
            /*
             * Was missedKind($c) with no directory / queue list and an extra
             * `$talk <= 0` clause of its own, so an auto attendant abandon
             * detected through the directory's service code was never counted
             * here and an answered zero-talk call was. One rule now.
             */
            if ($abandon) {
                $aas[$aaExt]['abandon']++;
            }
            if ($answered) {
                $aas[$aaExt]['answered']++;
                $aas[$aaExt]['talk'] += $talk;
            }
        }
    }

    $missedLim = (float)$settings['missedPct'];
    $abandonLim = (float)$settings['abandonPct'];
    $ahtLim = (int)round(((float)$settings['ahtMinutes']) * 60);

    $failures = [];
    $scan = static function (array $rows) use (&$failures, $missedLim, $abandonLim, $ahtLim): void {
        foreach ($rows as $row) {
            $offered = (int)$row['offered'];
            if ($offered < 3) {
                continue;
            }
            $missedPct = $offered ? round(($row['missed'] / $offered) * 100, 1) : 0.0;
            $abandonPct = $offered ? round(($row['abandon'] / $offered) * 100, 1) : 0.0;
            $aht = $row['answered'] > 0 ? (int)round($row['talk'] / $row['answered']) : 0;
            $reasons = [];
            if ($missedPct > $missedLim) {
                $reasons[] = 'Missed ' . $missedPct . '% (limit ' . $missedLim . '%)';
            }
            if ($abandonPct > $abandonLim) {
                $reasons[] = 'Abandoned ' . $abandonPct . '% (limit ' . $abandonLim . '%)';
            }
            if ($aht > 0 && $aht > $ahtLim) {
                $reasons[] = 'AHT ' . sprintf('%d:%02d', intdiv($aht, 60), $aht % 60) . ' (limit ' . intdiv($ahtLim, 60) . 'm)';
            }
            if ($reasons === []) {
                continue;
            }
            $failures[] = [
                'kind' => $row['kind'],
                'id' => $row['id'],
                'name' => $row['name'],
                'reasons' => $reasons,
                'missedPct' => $missedPct,
                'abandonPct' => $abandonPct,
                'aht' => $aht,
            ];
        }
    };

    $scan($agents);
    $scan($queues);
    $scan($aas);

    usort($failures, static function (array $a, array $b): int {
        return strcmp((string)$a['kind'], (string)$b['kind']) ?: strcasecmp((string)$a['name'], (string)$b['name']);
    });

    jsonResponse([
        'data' => [
            'settings' => $settings,
            'items' => $failures,
            'count' => count($failures),
        ],
        'items' => $failures,
        'count' => count($failures),
        'settings' => $settings,
    ]);
} catch (Throwable $e) {
    appExceptionLog('Alerts', $e);
    jsonResponseThrowable($e, 'Unable to load alerts.');
}
