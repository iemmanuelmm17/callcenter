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
        $offered = ($type === 'inbound' || $type === 'missed');
        $missed = ($type === 'missed');
        $abandon = $missed && missedKind($c, $directory, $queueIds) === 'abandon';
        $answered = $talk > 0 && $type === 'inbound';

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
            if ($talk <= 0) {
                $queues[$through]['missed']++;
            }
            if ($talk <= 0 && missedKind($c, $directory, $queueIds) === 'abandon') {
                $queues[$through]['abandon']++;
            }
            if ($talk > 0) {
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
            if ($talk <= 0) {
                $aas[$aaExt]['missed']++;
            }
            if ($abandon || ($talk <= 0 && missedKind($c) === 'abandon')) {
                $aas[$aaExt]['abandon']++;
            }
            if ($talk > 0) {
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
    jsonResponse(['error' => 'Unable to load alerts.'], 502);
}
