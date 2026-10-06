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
        return max(0, $end->getTimestamp() - $begin->getTimestamp());
    }

    return 0;
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

function seconds(array $row, string $field): int { return max(0, (int)($row[$field] ?? 0)); }
