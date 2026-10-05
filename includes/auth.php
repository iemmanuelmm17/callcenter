<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

function currentUser(bool $touch = true): array {
    $user = $_SESSION['user'] ?? null;
    if (!$user || empty($_SESSION['last_activity'])) jsonResponse(['error' => 'Authentication required'], 401);
    if (time() - (int) $_SESSION['last_activity'] > SESSION_IDLE_SECONDS) {
        session_unset(); session_destroy(); jsonResponse(['error' => 'Session expired'], 401);
    }
    if ($touch) $_SESSION['last_activity'] = time();
    ensurePbxToken();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    return $user;
}

function normalizedRole(string $scope): string {
    return match (strtolower(trim($scope))) {
        'office manager' => 'office_manager',
        'call center supervisor' => 'supervisor',
        'call center agent' => 'agent',
        default => 'basic_user',
    };
}

function routesForRole(string $role): array {
    if ($role === 'office_manager') {
        return ['dashboard', 'agents', 'queues', 'telephone_numbers', 'attendants', 'call_history'];
    }
    if ($role === 'supervisor') {
        return ['dashboard', 'agents', 'queues', 'call_history'];
    }
    return ['dashboard'];
}

function requirePageRoles(array $user, array $roles): void {
    if (!in_array((string)($user['role'] ?? ''), $roles, true)) {
        jsonResponse(['error' => 'Forbidden'], 403);
    }
}

/**
 * FUNC-7 FIX (server): strict Y-m-d validation with a safe fallback.
 * Invalid/empty values resolve to $fallback instead of propagating into
 * loadRawCdrs() and dying as a 502 deep in the request.
 */
function filterYmd(?string $value, string $fallback): string {
    $value = trim((string)$value);
    if ($value !== '' && preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) && checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
        return $value;
    }
    return $fallback;
}

function authorizedFilters(array $requested, array $user): array {
    $role = $user['role'];
    /*
     * FUNC-7 FIX (server): validate start/end as real calendar dates and
     * clamp the span to the same 31 days the UI date picker enforces.
     * A bookmarked 60-day range now loads the most recent 31 days
     * (anchor = start) instead of driving a multi-month PBX fetch storm;
     * end < start is deliberately NOT swapped — endpoints that check it
     * still answer 422 as before.
     */
    $start = filterYmd($requested['start'] ?? null, date('Y-m-d'));
    $end = filterYmd($requested['end'] ?? null, $start);
    $maxSpanDays = 31;
    $dStart = new DateTimeImmutable($start);
    $dEnd = new DateTimeImmutable($end);
    if ($dEnd > $dStart && $dStart->diff($dEnd)->days >= $maxSpanDays) {
        $end = $dStart->modify('+' . ($maxSpanDays - 1) . ' days')->format('Y-m-d');
    }
    $result = ['start' => $start, 'end' => $end];
    if ($role === 'office_manager') {
        $result['department'] = trim((string)($requested['department'] ?? ''));
        $result['site'] = trim((string)($requested['site'] ?? ''));
        $result['agents'] = array_values(array_filter(array_map('strval', (array)($requested['agents'] ?? []))));
    } elseif ($role === 'supervisor') {
        $result['department'] = (string)($user['department'] ?? '');
        $result['site'] = trim((string)($requested['site'] ?? ''));
        $result['agents'] = array_values(array_filter(array_map('strval', (array)($requested['agents'] ?? []))));
    } else {
        $result['department'] = (string)($user['department'] ?? '');
        $result['agents'] = [(string)$user['extension']];
    }
    return $result;
}

function auditView(array $user, array $filters, string $resource): void {
    $entry = ['at' => gmdate('c'), 'user' => $user['username'], 'role' => $user['role'], 'resource' => $resource, 'filters' => $filters];
    @file_put_contents(LOG_DIR . '/audit-' . gmdate('Y-m') . '.jsonl', json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
}

function pbxTokenSkewSeconds(): int
{
    if (defined('PBX_TOKEN_REFRESH_SKEW')) {
        return max(30, (int)PBX_TOKEN_REFRESH_SKEW);
    }
    return 120;
}

function storePbxToken(array $token, ?string $clientId = null): void
{
    $access = trim((string)($token['access_token'] ?? ''));
    if ($access === '') {
        return;
    }
    $_SESSION['token'] = $access;
    $refresh = trim((string)($token['refresh_token'] ?? ''));
    if ($refresh !== '') {
        $_SESSION['refresh_token'] = $refresh;
    }
    $ttl = (int)($token['expires_in'] ?? 3600);
    if ($ttl < 60) {
        $ttl = 3600;
    }
    $_SESSION['token_expires_at'] = time() + $ttl;
    if ($clientId !== null && $clientId !== '') {
        $_SESSION['pbx_client_id'] = $clientId;
    }
}

function ensurePbxToken(): bool
{
    $access = trim((string)($_SESSION['token'] ?? ''));
    if ($access === '') {
        return false;
    }
    $expires = (int)($_SESSION['token_expires_at'] ?? 0);
    if ($expires > 0 && $expires - time() > pbxTokenSkewSeconds()) {
        return true;
    }
    return refreshPbxToken();
}

function refreshPbxToken(): bool
{
    $refresh = trim((string)($_SESSION['refresh_token'] ?? ''));
    if ($refresh === '') {
        return false;
    }

    static $busy = false;
    if ($busy) {
        return !empty($_SESSION['token']);
    }
    $busy = true;

    try {
        $clientId = trim((string)(
            $_SESSION['pbx_client_id']
            ?? (defined('PBX_CLIENT_ID') ? PBX_CLIENT_ID : '')
            ?? ''
        ));
        $clientSecret = (string)(defined('PBX_CLIENT_SECRET') ? PBX_CLIENT_SECRET : '');
        $base = '';
        if (defined('PBX_SERVERS') && is_array(PBX_SERVERS) && isset(PBX_SERVERS['nms1'])) {
            $base = rtrim((string)PBX_SERVERS['nms1'], '/');
        }
        if ($base === '' || $clientId === '' || $clientSecret === '') {
            appLog('PBX token refresh skipped: missing client or server');
            return false;
        }

        $ch = curl_init($base . '/ns-api/v2/tokens');
        if ($ch === false) {
            return false;
        }
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'Content-Type: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'grant_type' => 'refresh_token',
                'refresh_token' => $refresh,
                'client_id' => $clientId,
                'client_secret' => $clientSecret,
            ]),
        ]);
        $raw = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($raw === false || $status >= 400) {
            appLog('PBX token refresh failed: HTTP ' . $status);
            return false;
        }
        $token = json_decode((string)$raw, true);
        if (!is_array($token) || empty($token['access_token'])) {
            appLog('PBX token refresh returned invalid JSON');
            return false;
        }
        storePbxToken($token, $clientId);
        return true;
    } finally {
        $busy = false;
    }
}
