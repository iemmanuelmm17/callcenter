<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/cdr_fields.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

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
    /*
     * "Unanswered" is the canonical test (includes/reporting/outcomes.php): no
     * answer timestamp on either leg, no talking seconds, and — because a
     * mailbox is not a person — a voicemail call is unanswered whatever it
     * recorded. It used to be just call-answer-datetime, so answered queue
     * calls whose only timestamp was the batch leg, or that simply had talk
     * seconds, were classified missed here and answered on the Queues screen.
     */
    $unanswered = callUnansweredForType($row);

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

/**
 * The call id a recording is looked up by: the leg that carries the media.
 * Outbound and on-net calls record on the origination leg, everything else on
 * the terminating leg. Was inlined (twice, differently) in call_history.php and
 * the call modal — one definition now.
 */
function callRecordingCallId(array $row): string
{
    $type = callType($row);
    $origId = trim((string)($row['call-orig-call-id'] ?? ''));
    $termId = trim((string)($row['call-term-call-id'] ?? ''));
    if ($type === 'outbound' || $type === 'onnet') {
        return $origId !== '' ? $origId : $termId;
    }
    return $termId !== '' ? $termId : $origId;
}

/** The extension a recording is filed under, chosen the same way as the id. */
function callRecordingUser(array $row): string
{
    $type = callType($row);
    $orig = trim((string)($row['call-orig-user'] ?? ''));
    $term = trim((string)($row['call-term-user'] ?? ''));
    if ($type === 'outbound' || $type === 'onnet') {
        return $orig !== '' ? $orig : $term;
    }
    return $term !== '' ? $term : $orig;
}

/**
 * Cheap "a recording might exist" hint — a call id on the right leg and a user
 * to file it under. Resolving for real costs a PBX walk per candidate (see
 * api/recording.php), so callers use this before asking.
 */
function callHasRecordingHint(array $row): bool
{
    if (callRecordingCallId($row) === '') {
        return false;
    }
    return trim((string)($row['call-term-user'] ?? '')) !== ''
        || trim((string)($row['call-orig-user'] ?? '')) !== '';
}

/**
 * The PBX prefills a trace URL for a call; it is the preferred way to ask for
 * the sip flow (it carries the search window the PBX itself used).
 */
function callTraceApi(array $row): string
{
    return html_entity_decode(
        trim((string)($row['prefilled-trace-api'] ?? $row['prefilled_trace_api'] ?? '')),
        ENT_QUOTES | ENT_HTML5,
        'UTF-8'
    );
}

/** Can a sip flow be requested for this call at all? */
function callHasFlowHint(array $row): bool
{
    return callRecordingCallId($row) !== '' || callTraceApi($row) !== '';
}

/** Every id that identifies this call, for an exact call lookup. */
function callCallIds(array $row): array
{
    $ids = [];
    foreach ([
        'id',
        'call-id',
        'call-parent-cdr-id',
        'call-orig-call-id',
        'call-term-call-id',
    ] as $field) {
        $value = trim((string)($row[$field] ?? ''));
        if ($value !== '') {
            $ids[$value] = true;
        }
    }
    return array_keys($ids);
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
