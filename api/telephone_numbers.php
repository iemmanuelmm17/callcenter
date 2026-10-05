<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

if (!defined('APP_TZ')) {
    define(
        'APP_TZ',
        defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York'
    );
}

try {

    $user = currentUser();

    /*
     * SEC-6 FIX: the Telephone Numbers page is office-manager-only in the UI
     * (ROLE_ROUTES), and the DID inventory it serves is domain-wide. Enforce
     * the role here too — UI hiding is not access control.
     */
    requirePageRoles($user, ['office_manager']);

    $domain = trim(
        (string)(
            $user['domain']
            ?? $user['Domain']
            ?? $user['tenant']
            ?? ''
        )
    );

    if ($domain === '') {
        jsonResponse(
            ['error' => 'No PBX domain is associated with this session.'],
            422
        );
    }

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $input = $_GET;

    if ($method === 'POST' || $method === 'PUT') {
        /*
         * FUNC-17: malformed JSON body is a 422. (Before: a bad body
         * silently fell back to the (empty) query string and the endpoint
         * answered 200.)
         */
        $input = readJsonBody();
    }

    if ($method !== 'GET' && $method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed.'], 405);
    }

    handleGet($domain, $user, $input);

} catch (Throwable $e) {
    appExceptionLog('telephone_numbers.php', $e);
    jsonResponse(
        ['error' => 'Unable to load telephone numbers.'],
        500
    );
}


function handleGet(
    string $domain,
    array $user,
    array $input = []
) {

    $start = trim((string)($input['start'] ?? ''));
    $end = trim((string)($input['end'] ?? ''));
    $department = trim((string)($input['department'] ?? ''));
    $site = trim((string)($input['site'] ?? ''));
    $search = trim((string)($input['search'] ?? ''));
    $timezone = trim((string)($input['timezone'] ?? APP_TZ));
    $datetimeStart = trim((string)($input['datetimeStart'] ?? ''));
    $datetimeEnd = trim((string)($input['datetimeEnd'] ?? ''));

    if ($timezone === '') {
        $timezone = APP_TZ;
    }

    if ($start !== '' && !validDate($start)) {
        throw new RuntimeException('Invalid start date.');
    }

    if ($end !== '' && !validDate($end)) {
        throw new RuntimeException('Invalid end date.');
    }

    if ($start !== '' && $end !== '' && $end < $start) {
        throw new RuntimeException(
            'End date must be greater than or equal to start date.'
        );
    }

    $phoneNumbers = loadCachedInventory($domain, $user);
    $directory = userDirectory($user);

    $cdrs = [];

    if ($start !== '' && $end !== '') {
        $filters = function_exists('authorizedFilters')
            ? authorizedFilters($input, $user)
            : [
                'start' => $start,
                'end' => $end,
                'department' => $department,
                'site' => $site,
                'agents' => [],
            ];

        $cdrs = reportingCdrRows($user, $filters, $directory);
    }

    $inventoryKeys = [];
    foreach ($phoneNumbers as $phone) {
        if (!is_array($phone)) {
            continue;
        }
        $rawNumber = (string)(
            $phone['phonenumber']
            ?? $phone['phone-number']
            ?? $phone['number']
            ?? ''
        );
        $key = statsKey($rawNumber);
        if ($key !== '') {
            $inventoryKeys[$key] = true;
        }
    }

    $cdrStats = buildNumberStats($cdrs, $inventoryKeys);
    $charts = buildTelephoneCharts($cdrs, $start, $end, $timezone);

    $numbers = [];
    $departmentMap = [];
    $siteMap = [];

    $summary = [
        'totalNumbers' => 0,
        'enabledNumbers' => 0,
        'totalCalls' => 0,
        'totalInbound' => 0,
        'totalMissed' => 0,
        'totalTalkSeconds' => 0
    ];

    foreach ($phoneNumbers as $phone) {

        if (!is_array($phone)) {
            continue;
        }

        $row = normalizePhoneNumber2(
            $phone,
            $directory,
            $domain
        );

        if ($row['number'] === '') {
            continue;
        }

        $statsKey = statsKey($row['number']);

        if ($statsKey !== '' && isset($cdrStats[$statsKey])) {
            $row['calls'] = $cdrStats[$statsKey];
        }

        if (
            $department !== '' &&
            strcasecmp(
                (string)($row['destination']['department'] ?? ''),
                $department
            ) !== 0
        ) {
            continue;
        }

        if (
            $site !== '' &&
            strcasecmp(
                (string)($row['destination']['site'] ?? ''),
                $site
            ) !== 0
        ) {
            continue;
        }

        if (
            $search !== '' &&
            !telephoneNumberMatchesSearch($row, $search)
        ) {
            continue;
        }

        $numbers[] = $row;
        $summary['totalNumbers']++;

        if (!empty($row['enabled'])) {
            $summary['enabledNumbers']++;
        }

        $summary['totalTalkSeconds'] += (int)($row['calls']['talkSeconds'] ?? 0);

        $dept = trim((string)($row['destination']['department'] ?? ''));
        if ($dept !== '') {
            $departmentMap[$dept] = true;
        }

        $siteName = trim((string)($row['destination']['site'] ?? ''));
        if ($siteName !== '') {
            $siteMap[$siteName] = true;
        }
    }

    $departments = array_keys($departmentMap);
    natcasesort($departments);
    $departments = array_values($departments);

    $sites = array_keys($siteMap);
    natcasesort($sites);
    $sites = array_values($sites);

    if (function_exists('summary')) {
        $counts = summary($cdrs)['counts'] ?? [];
        $summary['totalInbound'] = (int)($counts['inbound'] ?? 0);
        $summary['totalMissed'] = (int)($counts['missed'] ?? 0);
        $summary['totalCalls'] = $summary['totalInbound'];
    } else {
        foreach ($cdrs as $call) {
            if (!is_array($call)) {
                continue;
            }
            $type = inferCallType($call);
            if ($type === 'inbound') {
                $summary['totalInbound']++;
                $summary['totalCalls']++;
            } elseif ($type === 'missed') {
                $summary['totalMissed']++;
            }
        }
    }

    $topNumbers = [];
    foreach ($numbers as $row) {
        $inbound = (int)($row['calls']['inbound'] ?? 0)
            + (int)($row['calls']['missed'] ?? 0);
        if ($inbound <= 0) {
            continue;
        }
        $topNumbers[] = [
            'number' => (string)($row['number'] ?? ''),
            'calls' => $inbound,
        ];
    }
    usort($topNumbers, static function ($a, $b) {
        return $b['calls'] <=> $a['calls'];
    });
    $charts['top'] = array_values(array_slice($topNumbers, 0, 10));

    $repeatCallers = buildRepeatCallers($cdrs, $inventoryKeys);

    jsonResponse(
        [
            'success' => true,
            'data' => [
                'numbers' => $numbers,
                'summary' => $summary,
                'charts' => $charts,
                'repeatCallers' => $repeatCallers,
                'departments' => $departments,
                'sites' => $sites,
                'filters' => [
                    'start' => $start,
                    'end' => $end,
                    'department' => $department,
                    'site' => $site,
                    'search' => $search,
                    'timezone' => $timezone
                ]
            ]
        ]
    );
}


function handleUpdate(
    string $domain,
    array $user
) {

    throw new RuntimeException(
        'Telephone-number updates require a public update method in PbxClient. ' .
        'The current PbxClient only exposes phonenumbers(), users(), and cdrs().'
    );
}


/**
 * Keep only CDRs whose start time falls on an
 * America/New_York calendar date in [start, end].
 *
 * Naive PBX timestamps are treated as Eastern wall clock,
 * matching the dashboard date filter.
 */
function filterCdrsByTimezoneRange(
    array $cdrs,
    string $start,
    string $end,
    string $timezone
): array {

    if ($start === '' || $end === '' || $cdrs === []) {
        return $cdrs;
    }

    try {
        $tz = new DateTimeZone($timezone);
    } catch (Throwable $e) {
        $tz = new DateTimeZone(APP_TZ);
    }

    $out = [];

    foreach ($cdrs as $call) {

        if (!is_array($call)) {
            continue;
        }

        $raw = (string)(
            $call['startedAt']
            ?? $call['call-start-datetime']
            ?? $call['start']
            ?? ''
        );

        if ($raw === '') {
            continue;
        }

        $day = easternCalendarDate($raw, $tz);

        if ($day === '') {
            continue;
        }

        if ($day < $start || $day > $end) {
            continue;
        }

        $out[] = $call;
    }

    return $out;
}


function buildTelephoneCharts(
    array $cdrs,
    string $start,
    string $end,
    string $timezone
): array {

    try {
        $tz = new DateTimeZone($timezone !== '' ? $timezone : APP_TZ);
    } catch (Throwable $e) {
        $tz = new DateTimeZone(APP_TZ);
    }

    $hours = array_fill(0, 24, 0);
    $days = [];
    $heatmap = [];
    for ($d = 0; $d < 7; $d++) {
        $heatmap[$d] = array_fill(0, 24, 0);
    }

    if ($start !== '' && $end !== '') {
        try {
            $cursor = new DateTimeImmutable($start . ' 12:00:00', $tz);
            $last = new DateTimeImmutable($end . ' 12:00:00', $tz);
            while ($cursor <= $last) {
                $days[$cursor->format('Y-m-d')] = 0;
                $cursor = $cursor->modify('+1 day');
            }
        } catch (Throwable $e) {
        }
    }

    $outcomes = [
        'answered' => 0,
        'missed' => 0,
        'busy' => 0,
        'failed' => 0,
    ];

    $duration = [
        '0–30s' => 0,
        '30–60s' => 0,
        '1–3m' => 0,
        '3–10m' => 0,
        '10m+' => 0,
    ];

    foreach ($cdrs as $call) {
        if (!is_array($call)) {
            continue;
        }

        $type = function_exists('callType')
            ? (string)callType($call)
            : inferCallType($call);
        if ($type !== 'inbound' && $type !== 'missed') {
            continue;
        }

        $raw = (string)(
            $call['startedAt']
            ?? $call['call-start-datetime']
            ?? $call['start']
            ?? ''
        );
        $parts = easternDateTimeParts($raw, $tz);
        if ($parts['date'] !== '') {
            if (!isset($days[$parts['date']])) {
                $days[$parts['date']] = 0;
            }
            $days[$parts['date']]++;
            $hours[$parts['hour']]++;
            $heatmap[$parts['dow']][$parts['hour']]++;
        }

        $reason = strtolower((string)(
            $call['call-disconnect-reason-text']
            ?? $call['disconnectReason']
            ?? ''
        ));

        if (preg_match('/busy/', $reason)) {
            $outcomes['busy']++;
        } elseif (preg_match('/fail|error|reject|forbidden|unavailable/', $reason)) {
            $outcomes['failed']++;
        } elseif ($type === 'missed') {
            $outcomes['missed']++;
        } else {
            $outcomes['answered']++;
        }

        if (function_exists('seconds')) {
            $talk = seconds($call, 'call-talking-duration-seconds');
        } else {
            $talk = (int)($call['call-talking-duration-seconds'] ?? $call['talkSeconds'] ?? 0);
        }
        if ($talk < 30) {
            $duration['0–30s']++;
        } elseif ($talk < 60) {
            $duration['30–60s']++;
        } elseif ($talk < 180) {
            $duration['1–3m']++;
        } elseif ($talk < 600) {
            $duration['3–10m']++;
        } else {
            $duration['10m+']++;
        }
    }

    ksort($days);

    $durationRows = [];
    foreach ($duration as $label => $count) {
        $durationRows[] = ['label' => $label, 'count' => $count];
    }

    return [
        'hours' => array_values($hours),
        'days' => $days,
        'outcomes' => $outcomes,
        'duration' => $durationRows,
        'heatmap' => array_map('array_values', $heatmap),
    ];
}


function easternDateTimeParts(
    string $value,
    DateTimeZone $tz
): array {

    $empty = ['date' => '', 'hour' => 0, 'dow' => 0];
    $dt = parseEasternDateTime($value, $tz);
    if (!$dt instanceof DateTimeImmutable) {
        return $empty;
    }

    return [
        'date' => $dt->format('Y-m-d'),
        'hour' => (int)$dt->format('G'),
        'dow' => (int)$dt->format('w'),
    ];
}


function easternCalendarDate(
    string $value,
    DateTimeZone $tz
): string {

    $dt = parseEasternDateTime($value, $tz);
    return $dt instanceof DateTimeImmutable ? $dt->format('Y-m-d') : '';
}


function normalizePhoneNumber2(
    array $phone,
    array $directory,
    string $domain
): array {

    $number = normalizeTelephoneNumber(
        (string)(
            $phone['phonenumber']
            ?? $phone['phone-number']
            ?? $phone['number']
            ?? ''
        )
    );

    $enabledValue = $phone['enabled'] ?? true;

    $enabled =
        $enabledValue === true ||
        $enabledValue === 1 ||
        $enabledValue === '1' ||
        strtolower((string)$enabledValue) === 'yes' ||
        strtolower((string)$enabledValue) === 'true';

    $application = trim((string)(
        $phone['dial-rule-application'] ?? $phone['application'] ?? ''
    ));

    $parameter = trim((string)(
        $phone['dial-rule-parameter'] ?? $phone['parameter'] ?? ''
    ));

    $destinationUser = trim((string)(
        $phone['dial-rule-translation-destination-user']
        ?? $phone['destination-user']
        ?? ''
    ));

    $destinationHost = trim((string)(
        $phone['dial-rule-translation-destination-host']
        ?? $phone['destination-host']
        ?? ''
    ));

    $sourceName = trim((string)(
        $phone['dial-rule-translation-source-name']
        ?? $phone['source-name']
        ?? ''
    ));

    $description = trim((string)(
        $phone['dial-rule-description'] ?? $phone['description'] ?? ''
    ));

    $directoryEntry = $directory[$destinationUser] ?? null;

    return [
        'id' => $number,
        'number' => $number,
        'enabled' => $enabled,
        'type' => telephoneNumberType($number),
        'routing' => [
            'application' => $application,
            'parameter' => $parameter,
            'destinationUser' => $destinationUser,
            'destinationHost' => $destinationHost,
            'sourceName' => $sourceName,
            'description' => $description
        ],
        'destination' => [
            'name' => $directoryEntry['name']
                ?? ($destinationUser !== '' ? $destinationUser : ''),
            'extension' => $directoryEntry['extension'] ?? $destinationUser,
            'department' => $directoryEntry['department'] ?? '',
            'site' => $directoryEntry['site'] ?? ''
        ],
        'calls' => [
            'total' => 0,
            'inbound' => 0,
            'outbound' => 0,
            'missed' => 0,
            'onnet' => 0,
            'talkSeconds' => 0,
            'lastCall' => null
        ]
    ];
}


function didCandidatesFromCdr(array $call): array
{
    $fields = [
        'call-orig-to-user',
        'call-orig-request-user',
        'call-orig-request-uri',
        'call-orig-to-uri',
        'call-term-to-uri',
        'dialed',
        'to',
        'call-term-to-user',
    ];

    $out = [];

    foreach ($fields as $field) {

        $raw = (string)($call[$field] ?? '');

        if ($raw === '') {
            continue;
        }

        if (function_exists('normalizePhoneNumber')) {
            $digits = normalizePhoneNumber($raw);
        } else {
            $digits = preg_replace('/\D+/', '', $raw) ?? '';

            if (
                strlen($digits) === 11 &&
                $digits[0] === '1'
            ) {
                $digits = substr($digits, 1);
            }
        }

        $key = statsKey((string)$digits);

        if (strlen($key) >= 10) {
            $out[$key] = true;
        }
    }

    return array_map(
        static fn($key): string => (string)$key,
        array_keys($out)
    );
}


function resolveDidKey(array $call, array $inventoryKeys): string
{
    $candidates = didCandidatesFromCdr($call);

    foreach ($candidates as $candidate) {

        $candidate = (string)$candidate;

        if (
            $candidate !== '' &&
            isset($inventoryKeys[$candidate])
        ) {
            return $candidate;
        }
    }

    if ($candidates !== []) {
        return (string)$candidates[0];
    }

    $fallback = function_exists('phoneNumberFromCdr')
        ? phoneNumberFromCdr($call)
        : firstDidFromCdr($call);

    return statsKey((string)$fallback);
}


function buildNumberStats(array $cdrs, array $inventoryKeys = []): array
{
    $stats = [];

    foreach ($cdrs as $call) {

        if (!is_array($call)) {
            continue;
        }

        $key = resolveDidKey($call, $inventoryKeys);

        if ($key === '') {
            continue;
        }

        if (!isset($stats[$key])) {

            $stats[$key] = [
                'total' => 0,
                'inbound' => 0,
                'outbound' => 0,
                'missed' => 0,
                'onnet' => 0,
                'talkSeconds' => 0,
                'firstCall' => null,
                'lastCall' => null
            ];
        }

        /*
         * Same buckets as dashboard report.summary.counts:
         * inbound / outbound / missed / onnet are exclusive.
         */
        $type = function_exists('callType')
            ? callType($call)
            : inferCallType($call);

        if ($type === 'missed') {
            $stats[$key]['missed']++;
        } elseif ($type === 'inbound') {
            $stats[$key]['inbound']++;
        } elseif ($type === 'outbound') {
            $stats[$key]['outbound']++;
        } elseif ($type === 'onnet') {
            $stats[$key]['onnet']++;
        }

        $stats[$key]['total']++;

        if (function_exists('seconds')) {
            $talkSeconds = seconds($call, 'call-talking-duration-seconds');
        } else {
            $talkSeconds = (int)($call['call-talking-duration-seconds'] ?? 0);
        }

        $stats[$key]['talkSeconds'] += $talkSeconds;

        $timestamp = (string)(
            $call['startedAt']
            ?? $call['call-start-datetime']
            ?? ''
        );

        if ($timestamp !== '') {

            if (
                $stats[$key]['firstCall'] === null ||
                safeTimestamp($timestamp) < safeTimestamp($stats[$key]['firstCall'])
            ) {
                $stats[$key]['firstCall'] = $timestamp;
            }

            if (
                $stats[$key]['lastCall'] === null ||
                safeTimestamp($timestamp) > safeTimestamp($stats[$key]['lastCall'])
            ) {
                $stats[$key]['lastCall'] = $timestamp;
            }
        }
    }

    return $stats;
}


function repeatCallerKey(array $call): string
{
    $fields = [
        function_exists('callFromNumber') ? callFromNumber($call) : '',
        $call['call-orig-caller-id'] ?? '',
        $call['call-orig-from-user'] ?? '',
        $call['call-orig-from-uri'] ?? '',
        $call['call-orig-user'] ?? '',
        $call['fromNumber'] ?? '',
        $call['from'] ?? '',
    ];

    foreach ($fields as $raw) {
        $raw = (string)$raw;
        if ($raw === '') {
            continue;
        }
        if (function_exists('normalizePhoneNumber')) {
            $key = statsKey(normalizePhoneNumber($raw));
        } else {
            $value = preg_replace('/^(?:sip:|tel:)/i', '', $raw) ?? $raw;
            if (str_contains($value, '@')) {
                $value = explode('@', $value, 2)[0];
            }
            $key = statsKey($value);
        }
        if (strlen($key) >= 10) {
            return $key;
        }
    }

    return '';
}

function buildRepeatCallers(array $cdrs, array $inventoryKeys = []): array
{
    $callers = [];

    foreach ($cdrs as $call) {
        if (!is_array($call)) {
            continue;
        }

        $type = function_exists('callType')
            ? (string)callType($call)
            : inferCallType($call);

        if ($type !== 'inbound' && $type !== 'missed') {
            continue;
        }

        $caller = repeatCallerKey($call);
        if (strlen($caller) < 10) {
            continue;
        }

        $did = resolveDidKey($call, $inventoryKeys);

        if (!isset($callers[$caller])) {
            $callers[$caller] = [
                'caller' => $caller,
                'calls' => 0,
                'answered' => 0,
                'missed' => 0,
                'dids' => [],
            ];
        }

        $callers[$caller]['calls']++;
        if ($type === 'missed') {
            $callers[$caller]['missed']++;
        } else {
            $callers[$caller]['answered']++;
        }

        if ($did === '') {
            continue;
        }

        if (!isset($callers[$caller]['dids'][$did])) {
            $callers[$caller]['dids'][$did] = [
                'number' => $did,
                'calls' => 0,
                'answered' => 0,
                'missed' => 0,
            ];
        }

        $callers[$caller]['dids'][$did]['calls']++;
        if ($type === 'missed') {
            $callers[$caller]['dids'][$did]['missed']++;
        } else {
            $callers[$caller]['dids'][$did]['answered']++;
        }
    }

    $out = [];
    foreach ($callers as $row) {
        if ($row['calls'] < 2) {
            continue;
        }
        $dids = array_values($row['dids']);
        usort($dids, static function ($a, $b) {
            return $b['calls'] <=> $a['calls'];
        });
        $row['dids'] = $dids;
        $out[] = $row;
    }

    usort($out, static function ($a, $b) {
        return $b['calls'] <=> $a['calls'];
    });

    return $out;
}


function firstDidFromCdr(array $call): string
{
    $values = [
        $call['call-orig-to-user'] ?? '',
        $call['call-orig-request-user'] ?? '',
        $call['call-orig-request-uri'] ?? '',
        $call['call-orig-to-uri'] ?? '',
        $call['dialed'] ?? '',
        $call['to'] ?? '',
        $call['call-term-to-user'] ?? '',
    ];

    foreach ($values as $value) {

        $digits = preg_replace('/\D+/', '', (string)$value);

        if ($digits === null || strlen($digits) < 10) {
            continue;
        }

        return $digits;
    }

    return '';
}


function inferCallType(array $call): string
{
    if (function_exists('callType')) {
        return callType($call);
    }

    $direction = (int)($call['call-direction'] ?? -1);
    $missed = empty($call['call-answer-datetime']);

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
        return $missed ? 'missed' : 'inbound';
    }
    return $missed ? 'missed' : 'other';
}


function statsKey(string $number): string
{
    $digits = preg_replace('/\D+/', '', $number);

    if ($digits === null || $digits === '') {
        return '';
    }

    if (strlen($digits) === 11 && $digits[0] === '1') {
        $digits = substr($digits, 1);
    }

    return $digits;
}


function normalizeTelephoneNumber(string $value): string
{
    $value = trim($value);

    if ($value === '') {
        return '';
    }

    $digits = preg_replace('/\D+/', '', $value);

    return $digits ?? '';
}


function telephoneNumberType(string $number): string
{
    $digits = normalizeTelephoneNumber($number);

    if ($digits === '') {
        return 'Telephone';
    }

    if (strlen($digits) === 11 && $digits[0] === '1') {

        $area = substr($digits, 1, 3);

        if (in_array($area, ['800', '833', '844', '855', '866', '877', '888'], true)) {
            return 'Toll-Free';
        }

        return 'Local DID';
    }

    if (strlen($digits) > 11) {
        return 'International';
    }

    return 'Telephone';
}


function telephoneNumberMatchesSearch(array $row, string $search): bool
{
    $search = strtolower(trim($search));

    if ($search === '') {
        return true;
    }

    $values = [
        $row['number'] ?? '',
        $row['type'] ?? '',
        $row['routing']['application'] ?? '',
        $row['routing']['parameter'] ?? '',
        $row['routing']['destinationUser'] ?? '',
        $row['routing']['destinationHost'] ?? '',
        $row['routing']['sourceName'] ?? '',
        $row['routing']['description'] ?? '',
        $row['destination']['name'] ?? '',
        $row['destination']['extension'] ?? '',
        $row['destination']['department'] ?? '',
        $row['destination']['site'] ?? ''
    ];

    foreach ($values as $value) {

        if (str_contains(strtolower((string)$value), $search)) {
            return true;
        }
    }

    return false;
}


function validDate(string $date): bool
{
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);

    return $parsed !== false && $parsed->format('Y-m-d') === $date;
}


function safeTimestamp(string $value): int
{
    $timestamp = strtotime($value);

    return $timestamp === false ? 0 : $timestamp;
}


function telephoneNumbersCacheDir(): string
{
    $dir = __DIR__ . '/../cache/telephone_numbers';

    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }

    return $dir;
}


function telephoneNumbersCacheFile(
    string $domain,
    string $type,
    string $start = '',
    string $end = ''
): string {

    $key = hash(
        'sha256',
        implode('|', [$domain, $type, $start, $end])
    );

    return telephoneNumbersCacheDir() . '/' . $type . '-' . $key . '.json';
}


function loadTelephoneNumbersCache(string $domain): ?array
{
    $file = telephoneNumbersCacheFile($domain, 'numbers');

    if (
        !is_file($file) ||
        filemtime($file) === false ||
        (time() - filemtime($file)) > 300
    ) {
        return null;
    }

    $raw = file_get_contents($file);

    if ($raw === false || $raw === '') {
        return null;
    }

    $data = json_decode($raw, true);

    return is_array($data) ? $data : null;
}


function saveTelephoneNumbersCache(string $domain, array $numbers): void
{
    $file = telephoneNumbersCacheFile($domain, 'numbers');

    file_put_contents(
        $file,
        json_encode(
            $numbers,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        ),
        LOCK_EX
    );
}


function loadCachedInventory(string $domain, array $user): array
{
    $cached = loadTelephoneNumbersCache($domain);

    if (is_array($cached) && $cached !== []) {
        return $cached;
    }

    $numbers = cachedPhoneNumbers($user);

    if (!is_array($numbers)) {
        $numbers = [];
    }

    if ($numbers !== []) {
        saveTelephoneNumbersCache($domain, $numbers);
    }

    return $numbers;
}
