<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/security.php';
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

function jsonResponse(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
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
