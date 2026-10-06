<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

function nsSipTime(string $raw): string
{
    $raw = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $raw = str_replace('T', ' ', $raw);
    if (preg_match('/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/', $raw, $m)) {
        return $m[1];
    }
    return $raw;
}

function flowClean(string $value): string
{
    $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $value = strip_tags($value);
    $value = preg_replace('/\s+/', ' ', $value) ?? $value;
    return trim($value);
}

function flowParty(string $value): string
{
    $value = flowClean($value);
    $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
    $value = trim($value, "<>\"' ");
    if (preg_match('/^"([^"]+)"\s*<?([^>]*)>?/', $value, $m)) {
        $name = trim($m[1]);
        $rest = $m[2];
        if (str_contains($rest, '@')) {
            $rest = explode('@', $rest, 2)[0];
        }
        $digits = preg_replace('/\D+/', '', $rest) ?? '';
        if (strlen($digits) === 11 && str_starts_with($digits, '1')) {
            $digits = substr($digits, 1);
        }
        if (strlen($digits) === 10) {
            $pretty = '(' . substr($digits, 0, 3) . ') ' . substr($digits, 3, 3) . '-' . substr($digits, 6);
            return $name !== '' ? $name . ' ' . $pretty : $pretty;
        }
        return $name !== '' ? ($rest !== '' ? $name . ' (' . $rest . ')' : $name) : $rest;
    }
    if (str_contains($value, '@')) {
        $value = explode('@', $value, 2)[0];
    }
    $digits = preg_replace('/\D+/', '', $value) ?? '';
    if (strlen($digits) === 11 && str_starts_with($digits, '1')) {
        $digits = substr($digits, 1);
    }
    if (strlen($digits) === 10 && preg_match('/^\+?1?\d{10}$/', preg_replace('/\D+/', '', $value) ?? '')) {
        return '(' . substr($digits, 0, 3) . ') ' . substr($digits, 3, 3) . '-' . substr($digits, 6);
    }
    return $value;
}

function flowExt(string $value): string
{
    if (function_exists('cradleExtractExt')) {
        return cradleExtractExt($value);
    }
    $value = flowClean($value);
    $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
    if (str_contains($value, '@')) {
        $value = explode('@', $value, 2)[0];
    }
    return trim($value, "<>\"' ");
}

function flowMs(array $ev): int
{
    foreach (['msts', 'ts', 'timestamp'] as $key) {
        $v = trim((string)($ev[$key] ?? ''));
        if ($v === '') {
            continue;
        }
        if (preg_match('/^\d{13}$/', $v)) {
            return (int)$v;
        }
        if (preg_match('/^\d{10}$/', $v)) {
            return (int)$v * 1000;
        }
    }
    return 0;
}

function flowClock(array $ev, int $ms): string
{
    $ts = trim((string)($ev['ts'] ?? ''));
    if ($ts !== '' && !preg_match('/^\d+$/', $ts)) {
        return $ts;
    }
    if ($ms <= 0) {
        return '';
    }
    $dt = (new DateTimeImmutable('@' . (int)floor($ms / 1000)))->setTimezone(reportingTimezone());
    return $dt->format('g:i:s A');
}

function flowDiff(int $prev, int $cur, string $given): string
{
    if ($given !== '') {
        return $given;
    }
    if ($prev <= 0 || $cur <= 0 || $cur < $prev) {
        return '';
    }
    $d = $cur - $prev;
    if ($d < 1000) {
        return $d . 'ms';
    }
    $sec = (int)round($d / 1000);
    if ($sec < 60) {
        return $sec . 's';
    }
    return intdiv($sec, 60) . 'm ' . ($sec % 60) . 's';
}

function collectCradleEvents(mixed $raw): array
{
    $out = [];
    $walk = static function ($node) use (&$out, &$walk): void {
        if (!is_array($node)) {
            return;
        }
        if (isset($node['cradle']) && is_array($node['cradle'])) {
            foreach ($node['cradle'] as $row) {
                if (is_array($row)) {
                    $out[] = $row;
                }
            }
            return;
        }
        $hasType = isset($node['type']) || isset($node['str']) || isset($node['data']);
        $looksList = isset($node[0]) && is_array($node[0]);
        if ($hasType && !$looksList && !isset($node['sql'])) {
            $out[] = $node;
            return;
        }
        foreach ($node as $value) {
            if (is_array($value)) {
                $walk($value);
            }
        }
    };
    $walk($raw);
    return $out;
}

function mapCradleStep(array $ev): ?array
{
    if (!empty($ev['hidden'])) {
        return null;
    }
    $data = is_array($ev['data'] ?? null) ? $ev['data'] : [];
    if (!empty($data['hidden'])) {
        return null;
    }

    $str = flowClean((string)($ev['str'] ?? ''));
    $classes = trim((string)($ev['classes'] ?? ''));
    $type = strtoupper(trim((string)($ev['type'] ?? $data['type'] ?? '')));
    $dataType = strtolower(trim((string)($data['type'] ?? '')));

    if (in_array($type, ['APPLY_DIALPLAN', 'DIALPOLICY', 'FAILED_TO_MATCH'], true)) {
        return null;
    }
    if (in_array($type, ['100', '183', 'TRYING', 'SESSION PROGRESS'], true)
        || in_array($dataType, ['100', '183'], true)) {
        return null;
    }

    $from = flowParty((string)($data['from'] ?? $data['from_uri'] ?? ''));
    $to = flowParty((string)($data['to'] ?? $data['orig'] ?? ''));
    $name = flowClean((string)($data['from_name'] ?? $data['to_name'] ?? $data['name'] ?? ''));
    $ext = flowExt((string)($data['from'] ?? $data['aor'] ?? $data['at'] ?? $data['to'] ?? ''));
    $who = $name !== '' ? ($ext !== '' ? $name . ' (' . $ext . ')' : $name)
        : ($ext !== '' ? $ext : $from);

    if ($str === '') {
        if ($type === 'CALLBACK' || $type === 'CALLBACK_SOURCE' || $type === 'CALL') {
            $str = trim('Call from ' . $from . ' to ' . $to);
            $classes = $classes !== '' ? $classes : 'ctg-call';
        } elseif ($type === 'CALL_ANSWERED' || $dataType === '200' || str_contains(strtolower($classes), 'answer')) {
            $str = 'Call answered by ' . $who;
            $classes = $classes !== '' ? $classes : 'ctg-answer';
        } elseif ($dataType === 'system-queue' || str_contains(strtolower($classes), 'queue') || str_contains(strtolower((string)($data['apps'] ?? '')), 'call-queuing')) {
            $q = flowClean((string)($data['name'] ?? $data['at'] ?? ''));
            $qext = flowExt($q);
            $str = 'Connected to CallQueue ' . ($q !== '' ? $q : $qext) . ($qext !== '' ? ' (' . $qext . ')' : '');
            $classes = $classes !== '' ? $classes : 'ctg-queue';
        } elseif ($dataType === '180' || str_contains(strtolower($classes), 'ring') || $type === '180') {
            $str = $who . ' is ringing';
            $classes = $classes !== '' ? $classes : 'ctg-ringing';
        } elseif ($dataType === 'bye' || $type === 'BYE' || str_contains(strtolower($classes), 'hang')) {
            $str = $who . ' hung up';
            $classes = $classes !== '' ? $classes : 'ctg-hang-up';
        } elseif (str_contains(strtolower($classes), 'hold') || str_contains(strtolower((string)($data['text'] ?? '')), 'hold')) {
            $str = 'Remote side is on hold requested by ' . ($ext !== '' ? $ext : $who);
            $classes = $classes !== '' ? $classes : 'ctg-hold';
        } elseif (preg_match('/vmail|voicemail/i', $classes . ' ' . (string)($data['apps'] ?? '') . ' ' . (string)($data['text'] ?? ''))) {
            $str = str_contains(strtolower((string)($data['text'] ?? '')), 'record')
                ? 'Recording Voicemail'
                : ('Connected to VMail ' . $ext);
            $classes = $classes !== '' ? $classes : 'ctg-vmail';
        } elseif (in_array($dataType, ['486', '487', '480', '503', '404'], true) || in_array($type, ['486', '487', '480', '503', '404'], true)) {
            $str = $who . ' device responded that it was unable to process this call';
            $classes = $classes !== '' ? $classes : 'ctg-dashed';
        } else {
            return null;
        }
    }

    $str = flowClean($str);
    if ($str === '' || $str === 'Call from  to' || $str === 'Call answered by' || $str === ' is ringing' || $str === ' hung up') {
        return null;
    }

    return [
        'str' => $str,
        'classes' => $classes,
        'ts' => '',
        'diff_ts' => trim((string)($ev['diff_ts'] ?? $ev['diff-ts'] ?? '')),
        '_ms' => flowMs($ev),
        '_clock' => flowClock($ev, flowMs($ev)),
    ];
}

try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager', 'supervisor']);

    $requested = readJsonBody();
    $client = new PbxClient((string)($_SESSION['token'] ?? ''));

    $orig = trim((string)($requested['origCallId'] ?? $requested['orig'] ?? ''));
    $term = trim((string)($requested['termCallId'] ?? $requested['term'] ?? ''));
    $start = nsSipTime((string)($requested['startTime'] ?? $requested['startedAt'] ?? $requested['startAt'] ?? ''));
    $end = nsSipTime((string)($requested['endTime'] ?? $requested['disconnectedAt'] ?? $requested['endAt'] ?? ''));
    if ($end === '') {
        $end = $start;
    }
    $ids = [];
    if ($orig !== '') {
        $ids[] = $orig;
    }
    if ($term !== '' && $term !== $orig) {
        $ids[] = $term;
    }
    $callids = $ids === [] ? '' : implode(',', $ids);
    $servers = trim((string)($requested['servers'] ?? ''));
    $trace = trim((string)($requested['traceApi'] ?? $requested['prefilled-trace-api'] ?? ''));

    /* SEC-3: the trace URL is only a source of query values. Reject anything
     * that is not the PBX sipflow endpoint on a configured host, and never
     * let it choose the request path (PbxClient::sipflowCradle re-validates). */
    if (!pbxTraceApiIsAcceptable($trace)) {
        appLog('CallFlow refused traceApi: ' . substr($trace, 0, 200));
        jsonResponse(['error' => 'Invalid trace API URL.'], 400);
    }

    appLog('CallFlow request orig=' . $orig . ' term=' . $term . ' trace=' . substr($trace, 0, 160));

    $raw = $client->sipflowCradle($start, $end, $callids, $servers, $trace);
    $events = collectCradleEvents($raw);
    appLog(
        'CallFlow sipflow count=' . (is_array($raw) ? count($raw) : 0) .
        ' cradleEvents=' . count($events) .
        ' firstType=' . (string)($events[0]['type'] ?? '')
    );

    $steps = [];
    $prevMs = 0;
    foreach ($events as $ev) {
        if (!is_array($ev)) {
            continue;
        }
        $step = mapCradleStep($ev);
        if ($step === null) {
            continue;
        }
        $ms = (int)$step['_ms'];
        $step['ts'] = $step['_clock'];
        $step['diff_ts'] = flowDiff($prevMs, $ms, (string)$step['diff_ts']);
        if ($ms > 0) {
            $prevMs = $ms;
        }
        unset($step['_ms'], $step['_clock']);
        $steps[] = $step;
    }

    appLog('CallFlow steps=' . count($steps));

    jsonResponse([
        'data' => [
            'steps' => $steps,
            'count' => count($steps),
        ],
        'steps' => $steps,
        'count' => count($steps),
    ]);
} catch (Throwable $e) {
    appExceptionLog('Call flow', $e);
    jsonResponse(['error' => 'Unable to load call flow.'], 502);
}
