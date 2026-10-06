<?php
declare(strict_types=1);
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/PbxClient.php';

function isClosedRange(string $end): bool { return $end < (new DateTimeImmutable('today', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d'); }
function cacheFile(string $domain, string $day): string { return CACHE_DIR . '/cdr-day-' . hash('sha256', implode('|', ['v7', $domain, $day, implode(',', array_keys(PBX_SERVERS))])) . '.json'; }
if (!defined('CDR_PAGE_SIZE')) {
    define('CDR_PAGE_SIZE', 250);
}
function cdrDayCacheTtl(string $date): int
{
    $today = (new DateTimeImmutable('today', reportingTimezone()))->format('Y-m-d');
    if ($date === $today) {
        return 90;
    }
    return defined('CACHE_TTL_SECONDS') ? (int)CACHE_TTL_SECONDS : 86400;
}

function readCdrDayCache(string $file): ?array
{
    if (!is_file($file)) {
        return null;
    }
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) {
        return null;
    }
    if (isset($data['records']) && is_array($data['records'])) {
        return [
            'complete' => !empty($data['complete']),
            'nextOffset' => (int)($data['nextOffset'] ?? 0),
            'records' => $data['records'],
        ];
    }
    if ($data === [] || isset($data[0])) {
        return [
            'complete' => true,
            'nextOffset' => 0,
            'records' => $data,
        ];
    }
    return null;
}

function writeCdrDayCache(string $file, array $records, bool $complete, int $nextOffset): void
{
    $ok = @file_put_contents(
        $file,
        json_encode(
            [
                'complete' => $complete,
                'nextOffset' => $nextOffset,
                'records' => $records,
            ],
            JSON_UNESCAPED_SLASHES
        ),
        LOCK_EX
    );
    if ($ok === false) {
        appLog("Could not write CDR cache {$file}");
    }
}
function reportingTimezone(): DateTimeZone
{
    $name = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    try {
        return new DateTimeZone($name);
    } catch (Throwable $e) {
        return new DateTimeZone('America/New_York');
    }
}

function easternDayWindow(string $date): array
{
    $date = substr(trim($date), 0, 10);
    $tz = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    return [
        $date . 'T00:00:00Z[' . $tz . ']',
        $date . 'T23:59:59Z[' . $tz . ']',
    ];
}


function parseEasternDateTime(string $value, ?DateTimeZone $tz = null): ?DateTimeImmutable
{
    $value = trim($value);
    if ($value === '') {
        return null;
    }
    if (!$tz instanceof DateTimeZone) {
        $tz = reportingTimezone();
    }

    try {
        if (preg_match('/^\d{10}$/', $value)) {
            return (new DateTimeImmutable('@' . $value))->setTimezone($tz);
        }
        if (preg_match('/^\d{13}$/', $value)) {
            return (new DateTimeImmutable('@' . substr($value, 0, 10)))->setTimezone($tz);
        }

        $hadNamedZone = (bool)preg_match('/\[[^\]]+\]$/', $value);
        $value = preg_replace('/\[[^\]]*\]$/', '', $value) ?? $value;
        $value = preg_replace('/\.\d+/', '', $value, 1) ?? $value;
        if ($hadNamedZone) {
            $value = preg_replace('/[zZ]$/', '', $value) ?? $value;
        }

        $hasOffset = (bool)preg_match('/[zZ]|[+-]\d{2}:?\d{2}$/', $value);

        if (
            !$hasOffset
            && preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/', $value, $m)
        ) {
            $clock = $m[2];
            if (strlen($clock) === 5) {
                $clock .= ':00';
            }
            $dt = DateTimeImmutable::createFromFormat(
                'Y-m-d H:i:s',
                $m[1] . ' ' . $clock,
                $tz
            );
            if ($dt instanceof DateTimeImmutable) {
                return $dt;
            }
        }

        $dt = new DateTimeImmutable($value);
        return $dt->setTimezone($tz);
    } catch (Throwable $e) {
        return null;
    }
}

function ringSeconds(array $row): int
{
    $talk = seconds($row, 'call-talking-duration-seconds');
    $hold = seconds($row, 'call-batch-on-hold-duration-seconds');
    $batch = seconds($row, 'call-batch-total-duration-seconds');
    if ($batch > 0) {
        return max(0, $batch - ($hold + $talk));
    }

    $total = seconds($row, 'call-total-duration-seconds');
    if ($total > 0) {
        return max(0, $total - ($hold + $talk));
    }

    $ringAt = parseEasternDateTime((string)($row['call-ringing-datetime'] ?? ''));
    $startAt = parseEasternDateTime((string)(
        $row['call-start-datetime']
        ?? $row['call-batch-start-datetime']
        ?? ''
    ));
    $answerAt = parseEasternDateTime((string)(
        $row['call-answer-datetime']
        ?? $row['call-batch-answer-datetime']
        ?? ''
    ));
    $endAt = parseEasternDateTime((string)($row['call-disconnect-datetime'] ?? ''));

    $begin = $ringAt instanceof DateTimeImmutable ? $ringAt : $startAt;
    $end = $answerAt instanceof DateTimeImmutable ? $answerAt : $endAt;
    if ($begin instanceof DateTimeImmutable && $end instanceof DateTimeImmutable) {
        return max(0, $end->getTimestamp() - $begin->getTimestamp());
    }

    return 0;
}

function callDisconnectReason(array $row): string
{
    $preferred = [];
    $fallback = [];

    foreach ($row as $key => $value) {
        if (!is_string($key) || !is_scalar($value)) {
            continue;
        }
        if (!preg_match('/disconnect|release|hangup/i', $key)) {
            continue;
        }
        if (preg_match('/datetime|duration|seconds|stamp/i', $key)) {
            continue;
        }
        $text = trim((string)$value);
        if ($text === '') {
            continue;
        }
        if (preg_match('/text|reason/i', $key)) {
            $preferred[] = $text;
        } else {
            $fallback[] = $text;
        }
    }

    if ($preferred !== []) {
        return $preferred[0];
    }
    if ($fallback !== []) {
        return $fallback[0];
    }

    return '';
}

function callWentQueueOrAa(array $row, array $directory = [], array $queueIds = []): bool
{
    $through = trim((string)($row['call-through-user'] ?? ''));
    $term = trim((string)($row['call-term-user'] ?? ''));
    if ($through !== '' && isset($queueIds[$through])) {
        return true;
    }
    $throughCode = (string)($directory[$through]['serviceCode'] ?? '');
    $termCode = (string)($directory[$term]['serviceCode'] ?? '');
    if ($throughCode === 'system-queue' || $termCode === 'system-queue') {
        return true;
    }
    if ($throughCode === 'system-aa' || $termCode === 'system-aa') {
        return true;
    }
    $app = strtolower((string)($row['dial-rule-application'] ?? $row['call-orig-to-uri'] ?? ''));
    if (str_contains($app, 'callqueue') || str_contains($app, 'to-callqueue')) {
        return true;
    }
    if (preg_match('/auto-?attend|system-aa|to-aa|ivr/', $app)) {
        return true;
    }
    return false;
}

function missedKind(array $row, array $directory = [], array $queueIds = []): string
{
    $talk = (int)($row['call-talking-duration-seconds'] ?? 0);
    if ($talk > 0) {
        return 'noanswer';
    }
    if (callWentQueueOrAa($row, $directory, $queueIds)) {
        return 'abandon';
    }
    if (function_exists('cdrLooksLikeVoicemail') && cdrLooksLikeVoicemail($row)) {
        return 'voicemail';
    }
    $direction = (int)($row['call-direction'] ?? $row['direction'] ?? -1);
    if ($direction === 2) {
        return 'voicemail';
    }
    return 'noanswer';
}

function percentileInt(array $values, float $p): int
{
    if ($values === []) {
        return 0;
    }
    sort($values, SORT_NUMERIC);
    $n = count($values);
    $idx = (int)round(($p / 100) * ($n - 1));
    if ($idx < 0) {
        $idx = 0;
    }
    if ($idx > $n - 1) {
        $idx = $n - 1;
    }
    return (int)$values[$idx];
}

function callLocalDate(array $call): string
{
    $raw = trim((string)(
        $call['startedAt']
        ?? $call['call-start-datetime']
        ?? ''
    ));

    if ($raw === '') {
        return '';
    }

    $dt = parseEasternDateTime($raw);
    return $dt instanceof DateTimeImmutable ? $dt->format('Y-m-d') : '';
}

function filterCallsByLocalDate(array $calls, string $start, string $end): array
{
    if ($start === '' || $end === '') {
        return $calls;
    }

    $out = [];
    foreach ($calls as $call) {
        if (!is_array($call)) {
            continue;
        }
        $day = callLocalDate($call);
        if ($day === '' || $day < $start || $day > $end) {
            continue;
        }
        $out[] = $call;
    }
    return $out;
}

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

function appExceptionLog(string $context, Throwable $e): void
{
    $code = $e->getCode();
    appLog(sprintf(
        '%s code=%s file=%s line=%d %s',
        $context,
        $code === 0 ? '0' : (string)$code,
        $e->getFile(),
        $e->getLine(),
        $e->getMessage()
    ));
}

function nodeCdrDir(): string
{
    if (defined('NODE_CDR_DIR') && NODE_CDR_DIR !== '') {
        return rtrim(str_replace('\\', '/', (string)NODE_CDR_DIR), '/');
    }
    $guess = dirname(__DIR__) . '/pbx-client/cdr-out';
    return rtrim(str_replace('\\', '/', $guess), '/');
}

function readNodeDayJsonl(string $date): ?array
{
    $file = nodeCdrDir() . '/cdr-' . $date . '.jsonl';
    if (!is_file($file) || !is_readable($file)) {
        return null;
    }

    $rows = [];
    $fh = fopen($file, 'rb');
    if ($fh === false) {
        return null;
    }
    try {
        while (($line = fgets($fh)) !== false) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $row = json_decode($line, true);
            if (is_array($row)) {
                $rows[] = $row;
            }
        }
    } finally {
        fclose($fh);
    }

    return $rows;
}

function loadRawCdrs(array $user, array $filters): array {
    $client = new PbxClient($_SESSION['token']);
    $merged = [];
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';

    for (
        $day = new DateTimeImmutable($filters['start']);
        $day <= new DateTimeImmutable($filters['end']);
        $day = $day->modify('+1 day')
    ) {
        $date = $day->format('Y-m-d');
        $file = cacheFile($user['domain'], $date . '|' . $tzName);
        $ttl = cdrDayCacheTtl($date);
        $cached = readCdrDayCache($file);
        $age = is_file($file) ? (time() - (int)filemtime($file)) : PHP_INT_MAX;

        $records = [];
        $fromNode = isClosedRange($date) ? readNodeDayJsonl($date) : null;
        if (is_array($fromNode)) {
            $records = $fromNode;
        } elseif (
            is_array($cached)
            && !empty($cached['complete'])
            && $age < $ttl
        ) {
            $records = $cached['records'];
        } else {
            $existing = [];
            $offset = 0;
            if (
                is_array($cached)
                && empty($cached['complete'])
                && is_array($cached['records'])
            ) {
                $existing = $cached['records'];
                $offset = (int)$cached['nextOffset'];
            }

            [$windowStart, $windowEnd] = easternDayWindow($date);
            try {
                $result = $client->fetchCdrs(
                    $user['domain'],
                    $windowStart,
                    $windowEnd,
                    $offset,
                    $existing,
                    static function (
                        array $rows,
                        int $nextOffset,
                        bool $complete
                    ) use ($file): void {
                        writeCdrDayCache($file, $rows, $complete, $nextOffset);
                    }
                );
                $records = $result['records'];
                writeCdrDayCache(
                    $file,
                    $records,
                    (bool)$result['complete'],
                    (int)$result['nextOffset']
                );
            } catch (Throwable $e) {
                appExceptionLog("CDR day {$date}", $e);
                if ($existing !== []) {
                    $records = $existing;
                } else {
                    throw $e;
                }
            }
        }

        foreach ($records as $record) {
            if (!is_array($record)) {
                continue;
            }
            $merged[cdrCacheKey($record, count($merged))] = $record;
        }
    }

    return array_values($merged);
}

function reportingDateList(string $start, string $end): array
{
    $out = [];
    try {
        $from = new DateTimeImmutable(substr($start, 0, 10));
        $to = new DateTimeImmutable(substr($end, 0, 10));
    } catch (Throwable $e) {
        return [];
    }
    if ($to < $from) {
        return [];
    }
    for ($day = $from; $day <= $to; $day = $day->modify('+1 day')) {
        $out[] = $day->format('Y-m-d');
    }
    return $out;
}

function cdrDayIsCached(array $user, string $date): bool
{
    $date = substr($date, 0, 10);
    if (isClosedRange($date) && is_array(readNodeDayJsonl($date))) {
        return true;
    }
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $file = cacheFile((string)$user['domain'], $date . '|' . $tzName);
    $cached = readCdrDayCache($file);
    if (!is_array($cached) || empty($cached['complete'])) {
        return false;
    }
    $ttl = cdrDayCacheTtl($date);
    $age = is_file($file) ? (time() - (int)filemtime($file)) : PHP_INT_MAX;
    return $age < $ttl;
}

function cdrRangeCacheStatus(array $user, string $start, string $end): array
{
    $days = reportingDateList($start, $end);
    $ready = 0;
    $next = null;
    foreach ($days as $date) {
        if (cdrDayIsCached($user, $date)) {
            $ready++;
        } elseif ($next === null) {
            $next = $date;
        }
    }
    $total = count($days);
    return [
        'total' => $total,
        'ready' => $ready,
        'pending' => max(0, $total - $ready),
        'percent' => $total ? (int)round(($ready / $total) * 100) : 100,
        'next' => $next,
        'complete' => $total === 0 || $ready >= $total,
    ];
}

function warmCdrDay(array $user, string $date): array
{
    $date = substr(trim($date), 0, 10);
    if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return ['date' => $date, 'complete' => false];
    }
    if (cdrDayIsCached($user, $date)) {
        return ['date' => $date, 'complete' => true];
    }

    $client = new PbxClient((string)($_SESSION['token'] ?? ''));
    $tzName = defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York';
    $file = cacheFile((string)$user['domain'], $date . '|' . $tzName);
    $cached = readCdrDayCache($file);
    $existing = [];
    $offset = 0;
    if (is_array($cached) && empty($cached['complete']) && is_array($cached['records'])) {
        $existing = $cached['records'];
        $offset = (int)$cached['nextOffset'];
    }
    [$windowStart, $windowEnd] = easternDayWindow($date);
    $result = $client->fetchCdrs(
        (string)$user['domain'],
        $windowStart,
        $windowEnd,
        $offset,
        $existing,
        static function (array $rows, int $nextOffset, bool $complete) use ($file): void {
            writeCdrDayCache($file, $rows, $complete, $nextOffset);
        }
    );
    $records = is_array($result['records'] ?? null) ? $result['records'] : [];
    writeCdrDayCache(
        $file,
        $records,
        (bool)($result['complete'] ?? false),
        (int)($result['nextOffset'] ?? 0)
    );
    return [
        'date' => $date,
        'complete' => !empty($result['complete']),
        'records' => count($records),
    ];
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

function cdrLooksLikeVoicemail(array $row): bool
{
    $hay = strtolower(implode(' ', [
        (string)($row['call-term-user'] ?? ''),
        (string)($row['call-term-to-uri'] ?? ''),
        (string)($row['call-orig-to-uri'] ?? ''),
        (string)($row['call-through-user'] ?? ''),
        (string)($row['dial-rule-application'] ?? ''),
        (string)($row['call-disconnect-reason-text'] ?? ''),
    ]));

    return (bool)preg_match(
        '/voicemail|voice\\s*mail|to-voicemail|vmail|vmbox|\\bvm\\d|\\/vm[\\/-]/',
        $hay
    );
}

function cdrDigits(string $value): string
{
    $digits = preg_replace('/\D+/', '', $value);
    return is_string($digits) ? $digits : '';
}

function cdrLooksExternalNumber(string $value): bool
{
    $digits = cdrDigits($value);
    if (strlen($digits) === 11 && str_starts_with($digits, '1')) {
        $digits = substr($digits, 1);
    }
    return strlen($digits) >= 10;
}

/**
 * Classify a CDR without using call-direction as the primary signal.
 *
 * Sample outbound (agent 6080 -> 3476882219) has call-direction 0, which
 * we previously mapped to on-net and dropped from inbound/outbound filters.
 */

function cdrExtractExt(string $value): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
    if (str_contains($value, '@')) {
        $value = explode('@', $value, 2)[0];
    }
    $value = trim($value, "<> 	");
    if (str_contains($value, ':')) {
        $value = explode(':', $value, 2)[0];
    }
    return $value;
}

function cdrOnnetFlag(array $row): bool
{
    foreach (['onnet', 'call-onnet', 'on-net', 'call-on-net'] as $key) {
        if (!array_key_exists($key, $row)) {
            continue;
        }
        $v = $row[$key];
        if ($v === true || $v === 1 || $v === '1' || $v === 'true' || $v === 'yes') {
            return true;
        }
        if (is_numeric($v) && (int)$v === 1) {
            return true;
        }
    }
    return (int)($row['call-direction'] ?? -1) === 3;
}

/**
 * Queue id for a CDR. Always uses call-through-user when it is a known queue.
 * Also includes inbound / on-net (onnet=1) legs that dialed a queue extension
 * even when call-through-user is empty.
 */
function cdrQueueMatch(array $row, array $queueIds): string
{
    if ($queueIds === []) {
        return '';
    }
    $through = cdrExtractExt((string)($row['call-through-user'] ?? ''));
    if ($through !== '' && isset($queueIds[$through])) {
        return $through;
    }
    $direction = (int)($row['call-direction'] ?? -1);
    $inbound = $direction === 1 || $direction === 2 || $direction === 3 || cdrOnnetFlag($row);
    if (!$inbound || $direction === 0) {
        return '';
    }
    foreach ([
        'call-orig-to-user',
        'call-orig-request-user',
        'call-orig-to-uri',
        'call-through-uri',
        'dialed',
        'to',
    ] as $field) {
        $ext = cdrExtractExt((string)($row[$field] ?? ''));
        if ($ext !== '' && isset($queueIds[$ext])) {
            return $ext;
        }
    }
    return '';
}

function classifyCdrType(array $row, array $directory = []): string
{
    $direction = (int)($row['call-direction'] ?? $row['direction'] ?? -1);
    $unanswered = empty($row['call-answer-datetime']);

    if ($direction === 0) {
        return 'outbound';
    }
    if ($direction === 3) {
        return 'onnet';
    }
    if ($direction === 2) {
        return 'missed';
    }
    if ($direction === 1) {
        return $unanswered ? 'missed' : 'inbound';
    }

    $origin = trim((string)($row['call-orig-user'] ?? $row['call-orig-from-user'] ?? ''));
    $terminus = trim((string)($row['call-term-user'] ?? ''));
    $to = trim((string)($row['call-orig-to-user'] ?? $row['call-orig-request-user'] ?? ''));
    $originInternal = $origin !== '' && isset($directory[$origin]);
    $termInternal = $terminus !== '' && isset($directory[$terminus]);
    $toExternal = cdrLooksExternalNumber($to);

    if ($originInternal && $termInternal && !$toExternal) {
        return 'onnet';
    }
    if ($originInternal) {
        return 'outbound';
    }
    if ($toExternal || cdrLooksExternalNumber($origin) === false) {
        return $unanswered ? 'missed' : 'inbound';
    }

    return 'other';
}

function callType(array $row): string {
    if (!empty($row['_type'])) {
        return (string)$row['_type'];
    }

    return classifyCdrType($row, []);
}
function callAgent(array $row): string { return (string)($row['_agent'] ?? $row['call-term-user'] ?? $row['call-orig-user'] ?? $row['call-through-user'] ?? ''); }
function callDepartment(array $row): string { return (string)($row['_department'] ?? $row['call-term-department'] ?? $row['call-orig-department'] ?? $row['call-through-department'] ?? ''); }
function callSite(array $row): string { return (string)($row['_site'] ?? $row['call-term-site'] ?? $row['call-orig-site'] ?? $row['call-through-site'] ?? ''); }

function normalizeCdrs(array $calls, array $directory): array {
    foreach ($calls as &$row) {
        $origin = (string)($row['call-orig-user'] ?? '');
        $terminus = (string)($row['call-term-user'] ?? '');
        $through = (string)($row['call-through-user'] ?? '');
        $originInternal = isset($directory[$origin]);
        $termInternal = isset($directory[$terminus]);
        $throughInternal = isset($directory[$through]);
        $agent = $termInternal ? $terminus : ($originInternal ? $origin : ($throughInternal ? $through : $terminus));
        $row['_type'] = classifyCdrType($row, $directory);
        if ($row['_type'] === 'outbound' && $originInternal) {
            $agent = $origin;
        }
        $row['_agent'] = $agent;
        $row['_department'] = callDepartment($row) ?: (string)($directory[$agent]['department'] ?? '');
        $row['_site'] = callSite($row) ?: (string)($directory[$agent]['site'] ?? '');
    }
    unset($row);
    return $calls;
}
function cachedUsers(array $user): array {
    $file = CACHE_DIR . '/users-' . hash('sha256', 'v3|' . $user['domain']) . '.json';
    if (is_file($file) && (time() - filemtime($file)) < 3600) $users = json_decode((string)file_get_contents($file), true);
    if (empty($users) || !is_array($users)) {
        $users = (new PbxClient($_SESSION['token']))->users($user['domain']);
        if (@file_put_contents($file, json_encode($users), LOCK_EX) === false) appLog("Could not write user cache {$file}");
    }
    return $users;
}

function cachedCallQueues(array $user): array
{
    $domain = (string)($user['domain'] ?? '');
    $file = CACHE_DIR . '/callqueues-' . hash('sha256', 'v1|' . $domain) . '.json';

    if (is_file($file) && (time() - filemtime($file)) < 3600) {
        $queues = json_decode((string)file_get_contents($file), true);
        if (is_array($queues) && $queues !== []) {
            return $queues;
        }
        @unlink($file);
    }

    try {
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        $rows = $client->callqueues($domain);
    } catch (Throwable $e) {
        appLog('cachedCallQueues list: ' . $e->getMessage());
        return [];
    }

    $queues = [];
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        $id = trim((string)($row['callqueue'] ?? ''));
        if ($id === '') {
            continue;
        }
        $queues[] = $row;
    }

    if ($queues !== []) {
        if (@file_put_contents($file, json_encode($queues, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
            appLog("Could not write call queue cache {$file}");
        }
    }

    return $queues;
}

function cachedCallQueueAgents(array $user, string $queue): array
{
    $queue = trim($queue);
    if ($queue === '') {
        return [];
    }
    $domain = (string)($user['domain'] ?? '');
    $file = CACHE_DIR . '/callqueue-agents-' . hash('sha256', 'v1|' . $domain . '|' . $queue) . '.json';
    if (is_file($file) && (time() - filemtime($file)) < 3600) {
        $agents = json_decode((string)file_get_contents($file), true);
        if (is_array($agents)) {
            return $agents;
        }
    }
    try {
        $agents = (new PbxClient((string)($_SESSION['token'] ?? '')))
            ->callqueueAgents($domain, $queue);
    } catch (Throwable $e) {
        appLog('cachedCallQueueAgents ' . $queue . ': ' . $e->getMessage());
        return [];
    }
    if (!is_array($agents)) {
        return [];
    }
    if (@file_put_contents($file, json_encode($agents, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        appLog("Could not write call queue agent cache {$file}");
    }
    return $agents;
}

function phoneNumberCacheFile(string $domain): string {


    return CACHE_DIR .
        '/phonenumbers-' .
        hash(
            'sha256',
            'v1|' . $domain
        ) .
        '.json';
}

function cachedPhoneNumbers(array $user): array
{
    $file = phoneNumberCacheFile(
        $user['domain']
    );

    /*
     * -------------------------------------------------------------
     * USE CACHE
     * -------------------------------------------------------------
     *
     * Only accept the cache when it contains actual numbers.
     * An empty array is NOT considered a valid cache.
     */

    if (
        is_file($file) &&
        (time() - filemtime($file)) < 3600
    ) {

        $numbers = json_decode(
            (string)file_get_contents($file),
            true
        );

        if (
            is_array($numbers) &&
            count($numbers) > 0
        ) {
            return $numbers;
        }

        /*
         * Cache exists but is empty/invalid.
         * Delete it so the PBX is queried again.
         */
        @unlink($file);
    }


    /*
     * -------------------------------------------------------------
     * CACHE MISS
     * -------------------------------------------------------------
     */

    $numbers =
        (new PbxClient($_SESSION['token']))
        ->phonenumbers(
            $user['domain']
        );


    /*
     * -------------------------------------------------------------
     * VALIDATE API RESPONSE
     * -------------------------------------------------------------
     */

    if (
        !is_array($numbers)
    ) {
        appLog(
            'Telephone number API returned a non-array response.'
        );

        return [];
    }


    if (
        count($numbers) > 0
    ) {

        if (
            @file_put_contents(
                $file,
                json_encode(
                    $numbers,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE
                ),
                LOCK_EX
            ) === false
        ) {

            appLog(
                "Could not write phone number cache {$file}"
            );
        }
    }


    return $numbers;
}

function normalizePhoneNumber(string $value): string {
	$value = trim($value);

    if ($value === '') {
        return '';
    }

    /*
     * Remove SIP / TEL prefixes.
     */
    $value = preg_replace(
        '/^(?:sip:|tel:)/i',
        '',
        $value
    );

    /*
     * Remove anything after @.
     *
     * Example:
     * sip:18773962546@7261.DynaCloud
     */
    if (str_contains($value, '@')) {
        $value = explode('@', $value, 2)[0];
    }

    /*
     * Keep digits only.
     */
    $digits = preg_replace(
        '/\D+/',
        '',
        $value
    );

    if ($digits === '') {
        return '';
    }

    /*
     * US 11-digit number:
     *
     * 18773962546
     *
     * becomes:
     *
     * 8773962546
     */
    if (
        strlen($digits) === 11 &&
        str_starts_with($digits, '1')
    ) {
        $digits = substr($digits, 1);
    }

    return $digits;
}

function phoneNumberFromCdr(
    array $call
): string {

    $type = callType($call);

    /*
     * -------------------------------------------------------------
     * INBOUND
     * -------------------------------------------------------------
     *
     * External caller -> DID -> agent
     *
     * The DID is normally:
     *
     * call-orig-to-user
     * call-orig-request-user
     */
    if ($type === 'inbound' || $type === 'missed') {

        $fields = [
            'call-orig-to-user',
            'call-orig-request-user',
            'call-orig-request-uri',
            'call-orig-to-uri'
        ];
    }

    /*
     * -------------------------------------------------------------
     * OUTBOUND
     * -------------------------------------------------------------
     *
     * Agent -> external number
     */
    elseif ($type === 'outbound') {

        $fields = [
            'call-orig-to-user',
            'call-orig-request-user',
            'call-orig-request-uri',
            'call-orig-to-uri'
        ];
    }

    /*
     * -------------------------------------------------------------
     * ONNET / OTHER
     * -------------------------------------------------------------
     */
    else {

        $fields = [
            'call-orig-to-user',
            'call-orig-request-user',
            'call-term-to-uri'
        ];
    }

    foreach ($fields as $field) {

        if (
            !isset($call[$field]) ||
            $call[$field] === ''
        ) {
            continue;
        }

        $number =
            normalizePhoneNumber(
                (string)$call[$field]
            );

        if (
            strlen($number) >= 10
        ) {
            return $number;
        }
    }

    return '';
}


function cdrMatchesPhoneNumber(
    array $call,
    string $phoneNumber
): bool
{
    $target =
        normalizePhoneNumber($phoneNumber);

    if ($target === '') {
        return false;
    }

    $fields = [
        'call-orig-request-user',
        'call-orig-to-user',
        'call-orig-request-uri',
        'call-orig-to-uri',
        'call-term-to-uri',
        'call-term-user'
    ];

    foreach ($fields as $field) {

        if (
            !isset($call[$field]) ||
            $call[$field] === ''
        ) {
            continue;
        }

        $candidate =
            normalizePhoneNumber(
                (string)$call[$field]
            );

        if (
            $candidate !== '' &&
            $candidate === $target
        ) {
            return true;
        }
    }

    return false;
}


function userDirectory(array $user): array
{
    $directory = [];

    foreach (cachedUsers($user) as $person) {

        if (!is_array($person)) {
            continue;
        }

        $extension = trim(
            (string)($person['user'] ?? '')
        );

        if ($extension === '') {
            continue;
        }

        $firstName = trim(
            (string)($person['name-first-name'] ?? '')
        );

        $lastName = trim(
            (string)($person['name-last-name'] ?? '')
        );

        $name = trim(
            $firstName . ' ' . $lastName
        );

        if ($name === '') {
            $name = $extension;
        }

        $directory[$extension] = [

            'extension' => $extension,

            'name' => $name,

            'firstName' => $firstName,

            'lastName' => $lastName,

            'department' =>
                trim((string)($person['department'] ?? '')),

            'site' =>
                trim((string)($person['site'] ?? '')),

            'serviceCode' =>
                trim((string)($person['service-code'] ?? ''))
        ];
    }

    return $directory;
}

function cdrCacheKey(array $record, int $fallback): string {
    if (!empty($record['id'])) {
        return (string)$record['id'];
    }
    foreach (['call-orig-call-id', 'call-term-call-id'] as $field) {
        if (!empty($record[$field])) {
            return (string)$record[$field] . ':' . (string)($record['call-term-user'] ?? $fallback);
        }
    }
    return hash('sha256', implode('|', [$record['call-start-datetime'] ?? '', $record['call-orig-from-name'] ?? '', $record['call-orig-to-user'] ?? '', $record['call-term-user'] ?? '', (string)$fallback]));
}
function cdrFirstField(array $row, array $keys): string
{
    foreach ($keys as $key) {
        $v = trim((string)($row[$key] ?? ''));
        if ($v !== '') {
            return $v;
        }
    }
    return '';
}

function callPartyIsOutbound(array $row): bool
{
    $type = callType($row);
    return $type === 'outbound' || $type === 'onnet';
}

function callFromName(array $row): string
{
    return cdrFirstField($row, ['call-orig-from-name']);
}

function callFrom(array $row): string
{
    if (callPartyIsOutbound($row)) {
        return cdrFirstField($row, ['call-orig-user']) ?: 'Unknown';
    }
    return cdrFirstField($row, ['call-orig-from-user', 'call-orig-caller-id']) ?: 'Unknown';
}

function callFromNumber(array $row): string
{
    $number = callPartyIsOutbound($row)
        ? cdrFirstField($row, ['call-orig-user'])
        : cdrFirstField($row, ['call-orig-from-user', 'call-orig-caller-id']);

    if ($number === '') {
        return '';
    }

    if (str_contains($number, '@')) {
        $number = preg_replace('/^sip:/i', '', $number) ?? $number;
        $number = explode('@', $number, 2)[0];
    }

    $number = preg_replace('/^(?:tel:|sip:)/i', '', $number) ?? $number;
    $digits = preg_replace('/\D+/', '', $number) ?? '';

    return $digits !== '' ? $digits : $number;
}

function callDialed(array $row): string
{
    return cdrFirstField($row, ['call-orig-to-user']) ?: 'Unknown';
}

function callTo(array $row): string
{
    if (callPartyIsOutbound($row)) {
        return cdrFirstField($row, ['call-orig-to-user', 'call-orig-request-user']) ?: 'Unknown';
    }
    return cdrFirstField($row, ['call-term-user', 'call-term-caller-id']) ?: 'Unknown';
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
function seconds(array $row, string $field): int { return max(0, (int)($row[$field] ?? 0)); }
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
if (!function_exists('cradleExtractExt')) {
    function cradleExtractExt(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
        if (str_contains($value, '@')) {
            $value = explode('@', $value, 2)[0];
        }
        $value = trim($value, "<> \t\"'");
        if (preg_match('/(\d+[a-zA-Z]?)\s*$/', $value, $m)) {
            return $m[1];
        }
        return $value;
    }
}

if (!function_exists('cradleUnix10')) {
    function cradleUnix10(string $value): string
    {
        $dt = parseEasternDateTime($value);
        if (!$dt instanceof DateTimeImmutable) {
            return '';
        }
        return substr((string)((int)$dt->getTimestamp() * 1000), 0, 10);
    }
}

if (!function_exists('cradleKeyFromCdr')) {
    function cradleKeyFromCdr(array $row): array
    {
        $orig = trim((string)($row['call-orig-call-id'] ?? $row['call-parent-call-id'] ?? ''));
        $term = trim((string)($row['call-term-call-id'] ?? ''));
        $startSrc = (string)($row['call-batch-answer-datetime'] ?? $row['call-batch-start-datetime'] ?? $row['call-start-datetime'] ?? '');
        $endSrc = (string)($row['call-disconnect-datetime'] ?? '');
        return [
            'orig' => $orig,
            'term' => $term,
            'start' => cradleUnix10($startSrc),
            'end' => cradleUnix10($endSrc),
        ];
    }
}

if (!function_exists('cradlePortalPath')) {
    function cradlePortalPath(array $key): string
    {
        $orig = (string)($key['orig'] ?? '');
        $term = (string)($key['term'] ?? '');
        $start = (string)($key['start'] ?? '');
        $end = (string)($key['end'] ?? '');
        if ($orig === '' || $term === '' || $start === '' || $end === '') {
            return '';
        }
        return '/portal/callhistory/cradle/' . $orig . '/' . $term . '/' . $start . '/' . $end;
    }
}

if (!function_exists('cradleHopsFromEvents')) {
    function cradleHopsFromEvents(array $events): array
    {
        $hops = [];
        $seen = [];
        $lastAgent = null;
        foreach ($events as $event) {
            if (!is_array($event)) {
                continue;
            }
            $str = trim((string)($event['str'] ?? ''));
            $classes = ' ' . strtolower((string)($event['classes'] ?? '')) . ' ';
            $data = is_array($event['data'] ?? null) ? $event['data'] : [];
            $type = strtolower((string)($data['type'] ?? ''));
            $isQueue = str_contains($classes, ' ctg-queue ')
                || $type === 'system-queue'
                || (bool)preg_match('/connected to callqueue/i', $str);
            if ($isQueue) {
                $ext = cradleExtractExt((string)($data['at'] ?? ''));
                if ($ext === '' && preg_match('/\((\d+[a-zA-Z]?)\)\s*$/', $str, $m)) {
                    $ext = $m[1];
                }
                if ($ext === '' || isset($seen['q:' . $ext])) {
                    continue;
                }
                $seen['q:' . $ext] = true;
                $name = trim((string)($data['name'] ?? ''));
                $label = 'Queue ' . $ext;
                if ($name !== '' && $name !== $ext && !str_starts_with($name, $ext . '@')) {
                    $label .= ' · ' . $name;
                }
                $hops[] = [
                    'kind' => 'queue',
                    'id' => $ext,
                    'label' => $label,
                    'name' => $name,
                    'at' => (string)($data['at'] ?? ''),
                ];
                continue;
            }
            $isAnswer = str_contains($classes, ' ctg-answer ')
                || (bool)preg_match('/call answered by/i', $str);
            if ($isAnswer) {
                $ext = cradleExtractExt((string)($data['from'] ?? $data['aor'] ?? ''));
                if ($ext === '' && preg_match('/\((\d+[a-zA-Z]?)\)\s*$/', $str, $m)) {
                    $ext = $m[1];
                }
                $name = trim((string)($data['from_name'] ?? ''));
                if ($name === '' && preg_match('/call answered by\s+(.+?)\s*\(/i', $str, $m)) {
                    $name = trim($m[1]);
                }
                if ($ext !== '') {
                    $lastAgent = [
                        'kind' => 'agent',
                        'id' => $ext,
                        'label' => 'Agent ' . ($name !== '' ? $name . ' (' . $ext . ')' : $ext),
                        'name' => $name,
                    ];
                }
            }
        }
        if (is_array($lastAgent)) {
            $hops[] = $lastAgent;
        }
        return $hops;
    }
}

function domainSettingsFile(string $domain): string {
    return CACHE_DIR . '/settings-' . hash('sha256', 'v1|' . $domain) . '.json';
}
function defaultDomainSettings(): array {
    return [
        'slaSeconds' => 20,
        'slaPct' => 80.0,
        'missedPct' => 20.0,
        'abandonPct' => 10.0,
        'ahtMinutes' => 5.0,
        'ahtOutboundMinutes' => 5.0,
        /*
         * Top-agent qualification, used by the "Lowest AHT" ranking on
         * the operations overview. An agent only earns a medal when
         * their inbound AHT is UNDER topAgentAhtMinutes AND they handled
         * MORE than topAgentMinCalls inbound calls.
         *
         * The volume floor matters: without it a single lucky 12-second
         * call outranks an agent who handled three hundred.
         */
        'topAgentAhtMinutes' => 5.0,
        'topAgentMinCalls' => 20,
    ];
}
function loadDomainSettings(string $domain): array {
    $base = defaultDomainSettings();
    if ($domain === '') {
        return $base;
    }
    $file = domainSettingsFile($domain);
    if (!is_file($file)) {
        return $base;
    }
    $raw = json_decode((string)@file_get_contents($file), true);
    if (!is_array($raw)) {
        return $base;
    }
    return array_merge($base, array_intersect_key($raw, $base));
}
function saveDomainSettings(string $domain, array $in): array {
    $cur = defaultDomainSettings();

    /*
     * Fall back to the CURRENT stored value rather than the hard default
     * when a key is absent from the request.
     *
     * BUGFIX: every clamp below used a literal default, so a payload
     * that omitted a key silently reset it. 'ahtOutboundMinutes' was
     * never assigned at all, which meant it was wiped back to 5.0 on
     * every single save even though the UI collected it.
     */
    $existing = loadDomainSettings($domain);

    $pick = static function (string $key, $fallback) use ($in, $existing) {
        if (array_key_exists($key, $in) && $in[$key] !== null && $in[$key] !== '') {
            return $in[$key];
        }
        return $existing[$key] ?? $fallback;
    };

    $cur['slaSeconds'] = max(5, min(120, (int)$pick('slaSeconds', 20)));
    $cur['slaPct'] = max(1, min(100, (float)$pick('slaPct', 80)));
    $cur['missedPct'] = max(1, min(100, (float)$pick('missedPct', 20)));
    $cur['abandonPct'] = max(1, min(100, (float)$pick('abandonPct', 10)));
    $cur['ahtMinutes'] = max(1, min(120, (float)$pick('ahtMinutes', 5)));
    $cur['ahtOutboundMinutes'] = max(1, min(120, (float)$pick('ahtOutboundMinutes', 5)));

    /*
     * Qualifying AHT is allowed below one minute (0.5 min = 30 s) —
     * unlike the alert thresholds, a fast-handling target of well under
     * a minute is legitimate for short transactional queues.
     */
    $cur['topAgentAhtMinutes'] = max(0.5, min(120, (float)$pick('topAgentAhtMinutes', 5)));

    /*
     * Zero is meaningful here: it means "no minimum", so the floor is 0
     * rather than 1.
     */
    $cur['topAgentMinCalls'] = max(0, min(10000, (int)$pick('topAgentMinCalls', 20)));

    $json = json_encode($cur);

    if ($json === false) {
        appLog('SETTINGS: json_encode failed for ' . $domain . ': ' . json_last_error_msg());
        return $cur;
    }

    /*
     * Report a failed write instead of swallowing it — the endpoint
     * returns 200 with the new values either way, so a silent failure
     * looks exactly like a successful save until the next page load.
     */
    if (@file_put_contents(domainSettingsFile($domain), $json, LOCK_EX) === false) {
        appLog('SETTINGS: write FAILED for ' . $domain . ' -> ' . domainSettingsFile($domain));
        throw new RuntimeException('Unable to write settings file.');
    }

    return $cur;
}
