<?php
declare(strict_types=1);

/**
 * Raw-CDR field trimming.
 *
 * WHY
 * ---
 * A CDR from the ns-api is a wide flat record: well over a hundred fields per
 * call, most of them empty strings, and the application reads a few dozen. The
 * day cache used to keep every field of every call in the requested range, and
 * the reports layer now asks for wide windows (last 90 days, QTD, YTD, MoM and
 * a 4-week baseline), so the array of raw rows became the largest thing in the
 * process: on the production host the merge loop in includes/reporting/cache.php
 * exhausted PHP's 512 MB limit ("Fatal error: Allowed memory size ... exhausted"
 * at cache.php:299).
 *
 * The fix is to stop carrying fields nobody can read. A trimmed record keeps:
 *
 *   1. every name in the generated allowlist (includes/reporting/cdr_keep_fields.php),
 *      which is derived from the string literals of every production file - see
 *      tools/cdr-fields.mjs for the completeness argument and the "cdr fields"
 *      suite for the guard that a new field read cannot be forgotten;
 *   2. any name matching the keep patterns below - the runtime key scans that
 *      cannot be expressed as a list;
 *   3. any name starting with "_", which is how this application tags rows it
 *      has already decorated (_server, _agent, _queue, _type, ...).
 *
 * Everything else is dropped, and so is any EMPTY value whose key is not in
 * cdrKeepEmptyFields() - on a real CDR most fields are empty strings, and an
 * absent key and an empty one answer every reader in this application the same
 * way (they are read with `?? ''`, with `empty()`, or with a numeric default
 * that coerces '' the same as it coerces null). The two exceptions are the
 * direction keys, which are read with a `?? -1` default: there, present-but-
 * empty and absent are different answers, so an empty direction is kept.
 *
 * Trimming happens where records ENTER the process
 * (the PBX page in includes/PbxClient.php, the day cache and the legacy JSONL
 * reader), so the wide shapes are never accumulated, and it is idempotent, so
 * re-trimming an already-trimmed row costs nothing.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not change any number the app publishes: every field a reader can
 * name is kept, and the only unnameable reader (callDisconnectReason(), which
 * scans keys for /disconnect|release|hangup/i) is covered by pattern 1. The
 * "cdr memory" suite asserts a trimmed record still produces identical metrics
 * to an untrimmed one on a wide fixture.
 */

/**
 * Keys whose EMPTY value is not the same as an absent key.
 *
 * These are read as `$row['call-direction'] ?? -1` (cdr_fields.php:143/160/183,
 * outcomes.php:159): present-but-empty coerces to 0, which means "outbound",
 * while absent falls back to -1, which means "work it out from the other
 * fields". Every other reader uses `?? ''`, `empty()` or a default that an
 * empty string coerces to - so keeping these two is the whole exception list,
 * and the "cdr memory" suite pins that list.
 */
function cdrKeepEmptyFields(): array
{
    return ['call-direction', 'direction'];
}

/** Keys that a runtime scan - not a list - can reach. Mirrors callDisconnectReason(). */
function cdrKeepFieldPatterns(): array
{
    return [
        '/disconnect|release|hangup/i',
        ...(defined('INTELLIGENCE_CALL_ID_FIELD') && (string)INTELLIGENCE_CALL_ID_FIELD !== '' ? ['/^' . preg_quote((string)INTELLIGENCE_CALL_ID_FIELD, '/') . '$/'] : []),
    ];
}

/** The generated allowlist, loaded once per process. */
function cdrKeepFieldList(): array
{
    static $list = null;
    if ($list === null) {
        $list = require __DIR__ . '/cdr_keep_fields.php';
        if (!is_array($list)) {
            $list = [];
        }
    }
    return $list;
}

/** The allowlist as a lookup map. Built once per process; ~1,300 names. */
function cdrKeepFieldMap(): array
{
    static $map = null;
    if ($map === null) {
        $map = [];
        foreach (cdrKeepFieldList() as $name) {
            $map[(string)$name] = true;
        }
    }
    return $map;
}

/**
 * Is this key kept?
 *
 * MEMOIZED per NAME, not per record. A CDR has the same ~100 field names on
 * every record, so the answer is the same for every row: without this, a
 * 20,000-record day ran the pattern match and the map lookups 2,000,000 times
 * (measured: 2.25 s per 20,000 records, against 0.33 s memoized - 7x, and it
 * is paid on every read, write and fetch).
 *
 * The map is bounded by the number of distinct field names the PBX sends, and
 * a marker on the empty-key case keeps the array from growing ('' is never a
 * real field).
 */
function cdrFieldIsKept(string $key): bool
{
    static $decided = [];
    if ($key === '') {
        return false;
    }
    if (isset($decided[$key])) {
        return $decided[$key];
    }
    /* Application-added tags survive any trim. */
    $keep = $key[0] === '_';
    if (!$keep && isset(cdrKeepFieldMap()[$key])) {
        $keep = true;
    }
    if (!$keep) {
        foreach (cdrKeepFieldPatterns() as $pattern) {
            if (preg_match($pattern, $key) === 1) {
                $keep = true;
                break;
            }
        }
    }
    $decided[$key] = $keep;
    return $keep;
}

/**
 * One record, trimmed. Returns the same array when nothing had to go, so the
 * common case (an already-trimmed cache) copies nothing.
 */
function cdrTrimRecord(array $row): array
{
    static $keepEmpty = null;
    if ($keepEmpty === null) {
        $keepEmpty = [];
        foreach (cdrKeepEmptyFields() as $name) {
            $keepEmpty[$name] = true;
        }
    }
    $drop = [];
    foreach ($row as $key => $value) {
        $name = (string)$key;
        if (!cdrFieldIsKept($name)) {
            $drop[] = $key;
            continue;
        }
        /* An empty value is dropped too - unless an empty value MEANS
         * something for that key (see cdrKeepEmptyFields()). */
        if ($value === '' && !isset($keepEmpty[$name])) {
            $drop[] = $key;
        }
    }
    if ($drop === []) {
        return $row;
    }
    foreach ($drop as $key) {
        unset($row[$key]);
    }
    return $row;
}

/** @param list<array> $rows */
function cdrTrimRecords(array $rows): array
{
    foreach ($rows as $index => $row) {
        if (is_array($row)) {
            $rows[$index] = cdrTrimRecord($row);
        }
    }
    return $rows;
}

/**
 * What a trim would remove, for the log line and the CLI. Field names only -
 * never values, which are caller data.
 *
 * @return array{records:int,fields:int,keptFields:int,dropped:list<string>,droppedFields:int,emptied:int}
 */
function cdrTrimReport(array $rows): array
{
    $fields = [];
    $kept = [];
    $dropped = [];
    $emptied = 0;
    $records = 0;
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        $records++;
        foreach ($row as $key => $value) {
            $name = (string)$key;
            $fields[$name] = true;
            if (!cdrFieldIsKept($name)) {
                $dropped[$name] = true;
                continue;
            }
            if ($value === '' && !in_array($name, cdrKeepEmptyFields(), true)) {
                $emptied++;
                continue;
            }
            $kept[$name] = true;
        }
    }
    $names = array_keys($dropped);
    sort($names);
    return [
        'records' => $records,
        'fields' => count($fields),
        'keptFields' => count($kept),
        'dropped' => $names,
        'droppedFields' => count($names),
        'emptied' => $emptied,
    ];
}
