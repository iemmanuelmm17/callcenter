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

/**
 * Last line of defence for an API request: a PHP fatal (an exhausted
 * memory_limit being the one that happened in production) is not catchable,
 * so PHP prints an HTML fatal and the browser gets no JSON at all. This
 * registers a shutdown check that turns that into the JSON error shape the
 * client already handles - only for api/*.php, only when nothing has gone out
 * yet, and never over a download or a recording (those have their own
 * Content-Type by then).
 */
function installApiFatalHandler(): void
{
    static $installed = false;
    if ($installed || PHP_SAPI === 'cli') {
        return;
    }
    $installed = true;
    $script = (string)($_SERVER['SCRIPT_NAME'] ?? ($_SERVER['PHP_SELF'] ?? ''));
    if (!str_contains(str_replace('\\', '/', $script), '/api/')) {
        return;
    }
    register_shutdown_function(static function (): void {
        $error = error_get_last();
        if (!is_array($error)) {
            return;
        }
        $fatal = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR];
        if (!in_array((int)$error['type'], $fatal, true)) {
            return;
        }
        foreach (headers_list() as $header) {
            if (stripos($header, 'content-type: application/json') === 0) {
                return;
            }
            if (stripos($header, 'content-type:') === 0 && stripos($header, 'json') === false) {
                return;
            }
        }
        $detail = (string)($error['message'] ?? '');
        $isMemory = stripos($detail, 'memory') !== false && stripos($detail, 'exhausted') !== false;
        appLog('FATAL ' . $detail . ' in ' . (string)($error['file'] ?? '') . ':' . (int)($error['line'] ?? 0));
        if (headers_sent()) {
            return;
        }
        discardBufferedOutput();
        http_response_code($isMemory ? 413 : 500);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode([
            'error' => $isMemory
                ? 'This report needs more memory than this server allows (PHP memory_limit). Narrow the range, or raise memory_limit in php.ini. The size that failed is in logs/app-*.log.'
                : 'The report stopped before it could finish. The detail is in logs/app-*.log.',
            'code' => $isMemory ? 'out_of_memory' : 'fatal',
        ], JSON_INVALID_UTF8_SUBSTITUTE);
    });
}

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
 * The failure response for an endpoint catch block.
 *
 * A ReportingLimitException is not a server fault: the request was answered
 * correctly, the answer is "that range does not fit" (413), and its message is
 * written for the person reading the screen - how big the range is, what the
 * server allows and what to do. Everything else keeps the endpoint's own
 * wording and a 502, so an unexpected error is still an unexpected error.
 */
function jsonResponseThrowable(Throwable $e, string $fallback): never {
    if ($e instanceof ReportingLimitException) {
        appLog('Report capacity: ' . $e->getMessage());
        jsonResponse(['error' => $e->getMessage(), 'code' => 'range_too_large'], 413);
    }
    jsonResponse(['error' => $fallback], 502);
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

installApiFatalHandler();
