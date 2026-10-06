<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/security.php';
require_once __DIR__ . '/export.php';
date_default_timezone_set(DEFAULT_TIMEZONE);
foreach ([CACHE_DIR, LOG_DIR] as $directory) {
    if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {
        error_log("Call reporting dashboard cannot create {$directory}");
    }
}
session_name('call_reporting');
session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax',
    'cookie_secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
]);

function appLog(string $message, ?Throwable $e = null): void {
    if ($e instanceof Throwable) {
        $code = $e->getCode();
        $message .= sprintf(
            ' code=%s file=%s line=%d %s',
            $code === 0 ? '0' : (string)$code,
            $e->getFile(),
            $e->getLine(),
            $e->getMessage()
        );
    }
    @file_put_contents(
        LOG_DIR . '/app-' . gmdate('Y-m-d') . '.log',
        gmdate('c') . " {$message}\n",
        FILE_APPEND | LOCK_EX
    );
}

/**
 * Every JSON answer leaves through here.
 *
 * `discardBufferedOutput()` first: a PHP notice or warning that printed before
 * the payload (an undefined key on one tenant's data, a deprecation the host's
 * php.ini surfaces) turns a perfectly good response into "Server returned
 * invalid JSON" in the browser, because the body is no longer JSON. The
 * endpoints never write output of their own before answering, so anything
 * sitting in the buffer at this point is a diagnostic - it is dropped from the
 * RESPONSE and left to the error log, where it belongs.
 */
function jsonResponse(array $data, int $status = 200): never {
    discardBufferedOutput();
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

/**
 * Throw away anything a diagnostic wrote before the real response.
 *
 * Returns the discarded text so a caller can log it; the CSV path uses that to
 * keep a warning out of the file while still recording it.
 */
function discardBufferedOutput(): string {
    $discarded = '';
    while (ob_get_level() > 0) {
        $chunk = (string)ob_get_clean();
        if ($chunk !== '') {
            $discarded = $chunk . $discarded;
        }
    }
    if ($discarded !== '') {
        appLog('discarded stray output before the response: ' . substr(trim($discarded), 0, 500));
    }
    return $discarded;
}

function requireMethod(string $method): void {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== $method) jsonResponse(['error' => 'Method not allowed'], 405);
}

/**
 * FUNC-17 FIX: decode a JSON request body with an explicit failure.
 *
 * Before, endpoints used `json_decode(file_get_contents('php://input'),
 * true) ?: []` — a MALFORMED body silently became "no filters" and the
 * endpoint answered 200 with the full (scoped) dataset. Now:
 *   - empty body     -> [] (legitimate: some endpoints take no params)
 *   - invalid JSON   -> 422 (response sent; the function does not return)
 *   - valid JSON obj -> the decoded array
 * $raw may be passed explicitly for testability; production callers use
 * the php://input default.
 */
function readJsonBody(?string $raw = null): array {
    $raw = $raw ?? (string)file_get_contents('php://input');
    if (trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        jsonResponse(['error' => 'Invalid JSON body.'], 422);
    }
    return $data;
}
