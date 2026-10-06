<?php
declare(strict_types=1);

/**
 * CSV exports.
 *
 * Every export endpoint streams a real CSV download instead of shipping the
 * rows as JSON for the browser to re-serialise:
 *
 *   apiDownload('call_history', {...filters, export: true})
 *      -> api/call_history.php streams Content-Type: text/csv
 *
 * Why streaming rather than "return everything as JSON":
 *   - a page of call history already costs one full CDR scan, so an export
 *     that paginated would repeat that scan per page. One scan, one stream.
 *   - a month of history is tens of thousands of rows; encoding them to JSON
 *     and parsing them back in the browser wastes memory on both sides, and a
 *     CSV of the same data is roughly a tenth of the size.
 *   - row values are written as they are produced, so nothing is buffered.
 *
 * The formatters below mirror their JavaScript counterparts in
 * assets/js/src/app.js exactly (fmt -> csvDuration, formatMmss -> csvMmss,
 * formatPhoneNumber -> csvPhone, nsTimestampParts -> csvStamp,
 * formatHistDate -> csvHistStamp). tests/php/export.mjs checks them against
 * the same inputs the UI uses.
 */

/** Refuse to stream more than this many rows in one export (runaway ranges). */
const CSV_EXPORT_MAX_ROWS = 200000;

/** True when a request asked for a CSV download. */
function wantsCsvExport(array $requested): bool
{
    $flag = $requested['export'] ?? false;
    if (is_bool($flag)) {
        return $flag;
    }
    if (is_string($flag)) {
        return in_array(strtolower(trim($flag)), ['1', 'true', 'yes', 'csv'], true);
    }
    return is_int($flag) ? $flag === 1 : false;
}

/**
 * Send the download headers. Called before the first row is written; the
 * filename is sanitised because it lands in a response header.
 */
function csvBegin(string $filename): void
{
    /* Same guard as jsonResponse(): a warning printed before the export would
     * otherwise land inside the CSV, in the middle of a customer's data. */
    if (function_exists('discardBufferedOutput')) {
        discardBufferedOutput();
    }
    $safe = preg_replace('/[^A-Za-z0-9._-]+/', '-', $filename) ?? 'export.csv';
    $safe = trim($safe, '-');
    if ($safe === '' || !str_ends_with(strtolower($safe), '.csv')) {
        $safe .= '.csv';
    }
    if (!headers_sent()) {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $safe . '"');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
    }
}

/** Open the output stream with a UTF-8 BOM (Excel needs it for accents). */
function csvOpen()
{
    $out = fopen('php://output', 'wb');
    if ($out === false) {
        throw new RuntimeException('Unable to open CSV output');
    }
    fwrite($out, "\xEF\xBB\xBF");
    return $out;
}

/**
 * One CSV cell.
 *
 * Neutralises spreadsheet formula injection: caller ID names come from the
 * PBX and are attacker-controlled, and a cell starting with `=`, `@` or a
 * control character is executed as a formula by Excel / Sheets. `+` and `-`
 * are left alone because legitimate values (+1 country codes, negative
 * deltas) are far more common than the risky case, and Excel renders them as
 * numbers.
 */
function csvCell(mixed $value): string
{
    $text = (string)($value ?? '');
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    if ($text === '') {
        return '';
    }
    if (preg_match('/^[=@\t]/', $text) === 1) {
        return "'" . $text;
    }
    return $text;
}

/** Write one row of already-ordered values. */
function csvRow($handle, array $cells): void
{
    fputcsv($handle, array_map('csvCell', $cells), ',', '"', '\\');
}

/** Flush and end the request. */
function csvEnd($handle): never
{
    fclose($handle);
    exit;
}

/**
 * HH:MM:SS — mirrors the JS `fmt()` helper (hours zero-padded, at least two
 * digits).
 */
function csvDuration(mixed $seconds): string
{
    $total = max(0, (int)floor((float)($seconds ?? 0)));
    $hours = intdiv($total, 3600);
    $minutes = intdiv($total % 3600, 60);
    $secs = $total % 60;
    return sprintf('%02d:%02d:%02d', $hours, $minutes, $secs);
}

/** MM:SS — mirrors the JS `formatMmss()` helper. */
function csvMmss(mixed $seconds): string
{
    $total = max(0, (int)floor((float)($seconds ?? 0)));
    return sprintf('%02d:%02d', intdiv($total, 60), $total % 60);
}

/** (845) 425-9810 — mirrors the JS `formatPhoneNumber()` helper. */
function csvPhone(mixed $value): string
{
    $raw = (string)($value ?? '');
    $digits = preg_replace('/\D+/', '', $raw) ?? '';
    if (strlen($digits) === 10) {
        return '(' . substr($digits, 0, 3) . ') ' . substr($digits, 3, 3) . '-' . substr($digits, 6);
    }
    if (strlen($digits) === 11 && str_starts_with($digits, '1')) {
        return '(' . substr($digits, 1, 3) . ') ' . substr($digits, 4, 3) . '-' . substr($digits, 7);
    }
    return $raw;
}

/**
 * Split a PBX timestamp into the date and time the UI shows (US/Eastern).
 * Mirrors `nsTimestampParts()`: `['date' => '2026-08-02', 'time' => '6:15 PM']`.
 *
 * @return array{date:string,time:string}
 */
function csvStamp(string $raw): array
{
    $dt = function_exists('parseEasternDateTime') ? parseEasternDateTime($raw) : null;
    if ($dt instanceof DateTimeImmutable) {
        return ['date' => $dt->format('Y-m-d'), 'time' => $dt->format('g:i A')];
    }
    /* Fall back to the naive wall-clock shape the PBX sometimes sends. */
    if (preg_match('/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/', $raw, $m) === 1) {
        $hour = (int)$m[4];
        $ampm = $hour >= 12 ? 'PM' : 'AM';
        $hour = $hour % 12 ?: 12;
        return ['date' => $m[1] . '-' . $m[2] . '-' . $m[3], 'time' => $hour . ':' . $m[5] . ' ' . $ampm];
    }
    return ['date' => '', 'time' => ''];
}

/**
 * "Aug 2, 6:15 PM" — mirrors the JS `formatHistDate()` helper used by the call
 * history table. Returns '' when the value cannot be parsed.
 */
function csvHistStamp(string $raw): string
{
    $parts = csvStamp($raw);
    if ($parts['date'] === '') {
        return '';
    }
    $months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    [$year, $month, $day] = array_map('intval', explode('-', $parts['date']));
    if ($month < 1 || $month > 12) {
        return $parts['date'];
    }
    return $months[$month - 1] . ' ' . $day . ', ' . $parts['time'];
}
