<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/support.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

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
        if ($end->getTimestamp() >= $begin->getTimestamp()) {
            return $end->getTimestamp() - $begin->getTimestamp();
        }
        /*
         * The two timestamps belong to different legs: a transfer, a re-queue
         * or a hunt-group leg means this row's ringing began after the answer
         * was already recorded elsewhere. The naive pair then reports a
         * zero-second ring for a call that obviously waited, which is the
         * worst kind of wrong - a real wait silently published as "instant".
         *
         * When this row's own leg started before it was answered, that
         * start-to-answer gap is the honest wait. (When both timestamps come
         * from one leg this branch is never taken, so every value that was
         * right before is unchanged.)
         */
        if ($startAt instanceof DateTimeImmutable && $answerAt instanceof DateTimeImmutable
            && $answerAt->getTimestamp() > $startAt->getTimestamp()) {
            return $answerAt->getTimestamp() - $startAt->getTimestamp();
        }
        return 0;
    }

    return 0;
}

/**
 * How long the caller waited.
 *
 * For an answered call that is the time to answer (the ring); for an
 * unanswered one it is the time before the caller gave up or the leg ended,
 * which is what makes "<5s abandons" (a misdial) distinguishable from ">30s
 * abandons" (a staffing failure) - the manager review's Sprint A requirement.
 * It is deliberately ringSeconds(): one definition, so a bucket and the average
 * beside it can never disagree.
 */
function waitSeconds(array $row): int
{
    return ringSeconds($row);
}

/** Hold time on a call: time the caller spent parked while the leg lasted. */
function holdSeconds(array $row): int
{
    return seconds($row, 'call-batch-on-hold-duration-seconds');
}

/**
 * The p-th percentile, rounded to whole seconds.
 *
 * This used to pick the element at round(p/100 * (n-1)) and publish it as the
 * percentile. For an even count that is not the median: over six rings of
 * 10, 20, 45, 100, 125 and 150 seconds it reported 100 s where the median is
 * 72.5 s - a 38 % overstatement of the wait the desk actually made people
 * endure, in the one number the review says is quoted at the daily huddle.
 *
 * It now interpolates between the two nearest values, which is the method every
 * spreadsheet uses (Excel/LibreOffice PERCENTILE.INC, R's type 7), so a manager
 * can reproduce the figure from an exported CSV without trusting us.
 */
function percentileInt(array $values, float $p): int
{
    if ($values === []) {
        return 0;
    }
    sort($values, SORT_NUMERIC);
    $n = count($values);
    if ($n === 1) {
        return (int)$values[0];
    }
    $p = max(0.0, min(100.0, $p));
    $rank = ($p / 100) * ($n - 1);
    $lower = (int)floor($rank);
    $upper = (int)ceil($rank);
    if ($lower === $upper) {
        return (int)round((float)$values[$lower]);
    }
    $weight = $rank - $lower;
    return (int)round((float)$values[$lower] + $weight * ((float)$values[$upper] - (float)$values[$lower]));
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

/**
 * The moment a call started, as the screen should print it: "2026-08-19 09:04"
 * in US/Eastern, or '' when the row carries no usable timestamp.
 *
 * The repeat-caller list needs it per call ("show me the number and the times
 * they called"), and a repeated spelling of the same parse in three places is
 * how two screens start disagreeing about which day a call belongs to.
 */
function callStartStamp(array $call): string {
    $raw = trim((string)(
        $call['startedAt']
        ?? $call['call-start-datetime']
        ?? $call['call-batch-start-datetime']
        ?? ''
    ));

    if ($raw === '') {
        return '';
    }

    $dt = parseEasternDateTime($raw);
    return $dt instanceof DateTimeImmutable ? $dt->format('Y-m-d H:i') : '';
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

/**
 * The one way this codebase turns a printed phone number into a key.
 *
 * Digits only, and a leading country code 1 dropped for 11-digit values, so
 * "+1 (800) 555-1212", "18005551212" and "8005551212" are the same DID. It
 * lives here (not in api/telephone_numbers.php, where it started) because the
 * report's per-number rows must group numbers exactly the way the Telephone
 * Numbers screen does - two normalisers is how one DID becomes two rows.
 */
function numberKey(string $number): string {
    $digits = preg_replace('/\D+/', '', $number);

    if ($digits === null || $digits === '') {
        return '';
    }

    if (strlen($digits) === 11 && $digits[0] === '1') {
        $digits = substr($digits, 1);
    }

    return $digits;
}

/**
 * Is this DID live? The PBX spells the flag several ways ("yes", 1, true) and
 * ABSENT means enabled, so this is an allow-list, never a deny-list: an
 * unrecognised value (a typo, a new spelling) must not silently disable a
 * number on the report. Shares its home with numberKey() for the same reason -
 * one rule, one place.
 */
function numberIsEnabled($value): bool {
    if ($value === true || $value === 1 || $value === '1' || $value === null) {
        return true;
    }
    $text = strtolower(trim((string)$value));
    return $text === 'yes' || $text === 'true';
}

function seconds(array $row, string $field): int { return max(0, (int)($row[$field] ?? 0)); }

/**
 * 'H:MM' / 'HH:MM' (24-hour wall clock) to minutes past midnight, or null when
 * the value is not a clock time at all.
 *
 * The drill-down window filter uses it so a 15-minute interval stays a
 * 15-minute list; anything unparseable means "no window", never "no calls".
 */
function parseClockMinutes(?string $value): ?int
{
    $raw = trim((string)$value);
    if (!preg_match('/^([0-9]{1,2}):([0-9]{2})$/', $raw, $m)) {
        return null;
    }
    $hour = (int)$m[1];
    $minute = (int)$m[2];
    if ($hour > 23 || $minute > 59) {
        return null;
    }
    return ($hour * 60) + $minute;
}
