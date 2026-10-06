<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/export.php';

requireMethod('POST');

function histDisplayOutcome(array $c, array $directory = [], array $queueIds = []): string
{
    /*
     * Three-way display label, derived from the canonical outcome so it can
     * never drift from the Dashboard / Agents / Queues numbers.
     */
    return match (callOutcome($c, $directory, $queueIds)) {
        'answered' => 'answered',
        'abandoned' => 'abandoned',
        default => 'missed',
    };
}

/**
 * One call-history row, exactly as the JSON page returns it. The CSV export
 * uses the same function, so a column can never drift between the table and
 * the file it produces.
 */
function histRow(array $c, array $directory, array $queueIds): array
{
    $term = trim((string)($c['call-term-user'] ?? ''));
    $orig = trim((string)($c['call-orig-user'] ?? ''));
    $agentExt = trim((string)callAgent($c));
    $hosts = [];
    foreach ([
        'call-orig-by-hostname',
        'call-term-by-hostname',
        'call-action-by-hostname',
        'call-via-hostname',
        'call-orig-from-host',
        'call-term-to-host',
    ] as $hk) {
        $h = trim((string)($c[$hk] ?? ''));
        if ($h !== '' && !in_array($h, $hosts, true)) {
            $hosts[] = $h;
        }
    }
    return [
        'id' => (string)($c['id'] ?? $c['call-parent-cdr-id'] ?? ''),
        'startedAt' => $c['call-start-datetime'] ?? null,
        'disconnectedAt' => $c['call-disconnect-datetime'] ?? null,
        'from' => callFromName($c),
        'fromNumber' => (callFromNumber($c) !== '' ? callFromNumber($c) : callFrom($c)),
        'dialed' => callDialed($c),
        'to' => callTo($c),
        'ringing' => ringSeconds($c),
        /* DATA-1 FIX: talking duration (was total = ring + talk + hold). */
        'talking' => seconds($c, 'call-talking-duration-seconds'),
        'disconnectReason' => callDisconnectReason($c),
        'outcome' => histDisplayOutcome($c, $directory, $queueIds),
        'type' => callType($c),
        'agent' => $agentExt,
        'agentName' => (string)($directory[$agentExt]['name'] ?? ''),
        'origCallId' => (string)($c['call-orig-call-id'] ?? ''),
        'termCallId' => (string)($c['call-term-call-id'] ?? ''),
        'termUser' => $term,
        'origUser' => $orig,
        'recordingCallId' => (static function (array $row, string $type, string $origId, string $termId): string {
            if ($type === 'outbound' || $type === 'onnet') {
                return $origId !== '' ? $origId : $termId;
            }
            return $termId !== '' ? $termId : $origId;
        })($c, callType($c), (string)($c['call-orig-call-id'] ?? ''), (string)($c['call-term-call-id'] ?? '')),
        'recordingUser' => (static function (string $type, string $origU, string $termU): string {
            if ($type === 'outbound' || $type === 'onnet') {
                return $origU !== '' ? $origU : $termU;
            }
            return $termU !== '' ? $termU : $origU;
        })(callType($c), $orig, $term),
        'throughUser' => (string)($c['call-through-user'] ?? ''),
        'servers' => implode(',', $hosts),
        'traceApi' => html_entity_decode(
            (string)($c['prefilled-trace-api'] ?? $c['prefilled_trace_api'] ?? ''),
            ENT_QUOTES | ENT_HTML5,
            'UTF-8'
        ),
        'hasRecordingHint' => (
            (callType($c) === 'outbound' || callType($c) === 'onnet')
                ? trim((string)($c['call-orig-call-id'] ?? '')) !== ''
                : trim((string)($c['call-term-call-id'] ?? '')) !== ''
        ) && ($term !== '' || $orig !== ''),
    ];
}


try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager', 'supervisor']);

    $requested = readJsonBody();
    $filters = authorizedFilters($requested, $user);

    $callerQ = strtolower(trim((string)($requested['caller'] ?? '')));
    $calledQ = strtolower(trim((string)($requested['called'] ?? '')));
    $agentQ = strtolower(trim((string)($requested['agent'] ?? '')));
    $outcomeQ = strtolower(trim((string)($requested['outcome'] ?? '')));
    $page = max(1, (int)($requested['page'] ?? 1));
    $size = (int)($requested['size'] ?? 25);
    if (!in_array($size, [25, 50, 100], true)) {
        $size = 25;
    }

    $directory = userDirectory($user);
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
    $callTypes = is_array($requested['callTypes'] ?? null) ? $requested['callTypes'] : [];
    $calls = reportingCdrRows($user, $filters, $directory, $callTypes);

    if ($callerQ !== '') {
        $calls = array_values(array_filter($calls, static function (array $c) use ($callerQ): bool {
            $blob = strtolower(callFromName($c) . ' ' . callFrom($c) . ' ' . callFromNumber($c));
            return str_contains($blob, $callerQ);
        }));
    }
    if ($calledQ !== '') {
        $calls = array_values(array_filter($calls, static function (array $c) use ($calledQ): bool {
            $blob = strtolower(callDialed($c) . ' ' . callTo($c));
            return str_contains($blob, $calledQ);
        }));
    }
    if ($agentQ !== '') {
        $calls = array_values(array_filter($calls, static function (array $c) use ($agentQ, $directory): bool {
            $ext = strtolower(trim((string)callAgent($c)));
            $name = strtolower((string)($directory[$ext]['name'] ?? $directory[callAgent($c)]['name'] ?? ''));
            $queue = strtolower(trim((string)($c['call-through-user'] ?? '')));
            return str_contains($ext, $agentQ) || str_contains($name, $agentQ) || str_contains($queue, $agentQ);
        }));
    }
    if (in_array($outcomeQ, ['answered', 'missed', 'voicemail', 'abandoned'], true)) {
        $calls = array_values(array_filter($calls, static function (array $c) use ($outcomeQ, $directory, $queueIds): bool {
            return histDisplayOutcome($c, $directory, $queueIds) === $outcomeQ;
        }));
    }

    usort($calls, static function (array $a, array $b): int {
        return strcmp((string)($b['call-start-datetime'] ?? ''), (string)($a['call-start-datetime'] ?? ''));
    });

    /*
     * CSV EXPORT
     * ----------
     * Streams EVERY row matching the current view: the search terms, the
     * outcome filter, the call-type toggles and the page-wide range / site /
     * department filters. The previous button wrote only the page that
     * happened to be loaded (25 rows) to the file.
     */
    if (wantsCsvExport($requested)) {
        auditView($user, $filters + ['export' => 'call_history'], 'call_history_export');

        csvBegin('call-history-' . ($filters['start'] ?? '') . '-' . ($filters['end'] ?? '') . '.csv');
        $out = csvOpen();
        csvRow($out, ['Date', 'From name', 'From', 'Dialed', 'To', 'Agent', 'Queue', 'Outcome', 'Ring', 'Talk', 'Disconnect']);

        $written = 0;
        foreach ($calls as $c) {
            if ($written >= CSV_EXPORT_MAX_ROWS) {
                break;
            }
            $r = histRow($c, $directory, $queueIds);
            csvRow($out, [
                csvHistStamp((string)($r['startedAt'] ?? '')),
                $r['from'],
                $r['fromNumber'],
                $r['dialed'],
                $r['to'],
                $r['agentName'] !== '' ? $r['agentName'] : $r['agent'],
                $r['throughUser'],
                $r['outcome'],
                csvMmss($r['ringing']),
                csvMmss($r['talking']),
                $r['disconnectReason'],
            ]);
            $written++;
        }
        csvEnd($out);
    }

    $stats = [
        'total' => 0,
        'answered' => 0,
        'missed' => 0,
        'abandoned' => 0,
        'voicemail' => 0,
        'ringSum' => 0,
        'talkSum' => 0,
        'shortTalk' => 0,
    ];
    foreach ($calls as $c) {
        $stats['total']++;
        $out = histDisplayOutcome($c, $directory, $queueIds);
        if (isset($stats[$out])) {
            $stats[$out]++;
        }
        /*
         * DATA-1 FIX: "Avg talk" and the short-talk counter use TALKING
         * duration, not total duration (ring + talk + hold). The old
         * call-total-duration-seconds made avgTalk inflate by the whole
         * ring time and disagree with the call-details modal.
         */
        $talk = seconds($c, 'call-talking-duration-seconds');
        $ring = ringSeconds($c);
        $stats['ringSum'] += $ring;
        $stats['talkSum'] += $talk;
        if ($talk > 0 && $talk < 5) {
            $stats['shortTalk']++;
        }
    }
    $n = max(1, $stats['total']);
    $stats['avgRing'] = $stats['total'] ? (int)round($stats['ringSum'] / $n) : 0;
    $stats['avgTalk'] = $stats['total'] ? (int)round($stats['talkSum'] / $n) : 0;
    unset($stats['ringSum'], $stats['talkSum']);

    $insight = null;
    if ($stats['total'] >= 8) {
        $missRate = ($stats['missed'] + $stats['abandoned']) / $stats['total'];
        $shortRate = $stats['shortTalk'] / $stats['total'];
        if ($missRate >= 0.25 && ($stats['missed'] + $stats['abandoned']) >= 3) {
            $insight = [
                'tone' => 'bad',
                'text' => ($stats['missed'] + $stats['abandoned']) . ' missed/abandoned of ' . $stats['total'] . ' in this view (' . round($missRate * 100) . '%).',
            ];
        } elseif ($shortRate >= 0.2 && $stats['shortTalk'] >= 4) {
            $insight = [
                'tone' => 'warn',
                'text' => $stats['shortTalk'] . ' answered calls under 5 seconds in this view.',
            ];
        }
    }

    $total = count($calls);
    $lastPage = max(1, (int)ceil($total / $size));
    $page = min($page, $lastPage);
    $slice = array_slice($calls, ($page - 1) * $size, $size);

    $rows = [];
    foreach ($slice as $c) {
        $rows[] = histRow($c, $directory, $queueIds);
    }

    auditView($user, $filters, 'call_history');

    jsonResponse([
        'data' => $rows,
        'total' => $total,
        'page' => $page,
        'size' => $size,
        'last_page' => $lastPage,
        'stats' => $stats,
        'insight' => $insight,
    ]);
} catch (Throwable $e) {
    appExceptionLog('Call history', $e);
    jsonResponse(['error' => 'Unable to load call history.'], 502);
}
