<?php
declare(strict_types=1);

/*
 * Centralized deployment configuration.
 *
 * Resolution order, first match wins:
 *
 *   1. includes/config.local.php   — optional, server-side, git-ignored, may
 *                                    define() any constant below.
 *   2. environment variables       — PBX_SERVERS (JSON object), PBX_SERVER_<NAME>,
 *                                    PBX_CLIENT_ID, PBX_CLIENT_SECRET,
 *                                    PBX_SIP_TOKEN, PBX_RECORDING_HOSTS.
 *   3. the defaults in this file   — which intentionally contain no credentials.
 *
 * Every constant is defined only when nothing above defined it, so a local
 * file can override a single value without restating the rest.
 */

$callScopeLocalConfig = __DIR__ . '/config.local.php';
if (is_file($callScopeLocalConfig)) {
    require_once $callScopeLocalConfig;
}
unset($callScopeLocalConfig);

if (!defined('APP_ROOT')) {
    define('APP_ROOT', dirname(__DIR__));
}
if (!defined('API_DIR')) {
    define('API_DIR', APP_ROOT . '/api');
}
if (!defined('ASSETS_DIR')) {
    define('ASSETS_DIR', APP_ROOT . '/assets');
}
if (!defined('CACHE_DIR')) {
    define('CACHE_DIR', APP_ROOT . '/cache');
}
if (!defined('LOG_DIR')) {
    define('LOG_DIR', APP_ROOT . '/logs');
}
if (!defined('DEFAULT_TIMEZONE')) {
    define('DEFAULT_TIMEZONE', 'US/Eastern');
}
/** Closed CDR days are immutable; expire after one year as a safety net. */
if (!defined('CACHE_TTL_SECONDS')) {
    define('CACHE_TTL_SECONDS', 31536000);
}
if (!defined('SESSION_IDLE_SECONDS')) {
    define('SESSION_IDLE_SECONDS', 1800);
}
if (!defined('SESSION_WARNING_SECONDS')) {
    define('SESSION_WARNING_SECONDS', 900);
}
if (!defined('CDR_PAGE_SIZE')) {
    define('CDR_PAGE_SIZE', 250);
}
if (!defined('TREND_NOISE_THRESHOLD')) {
    define('TREND_NOISE_THRESHOLD', 2.0);
}
/**
 * CDR day-cache backend.
 *
 *   'auto'   SQLite when pdo_sqlite is available, otherwise the JSON day files
 *            (default: a host without the extension keeps working unchanged)
 *   'sqlite' force the store (logs and falls back when the driver is missing)
 *   'json'   force the original cdr-day-*.json files
 *
 * Move an existing deployment over with:
 *   php tools/cdr-cache.php status
 *   php tools/cdr-cache.php import <domain> [first-day] [last-day] --delete-json
 *   php tools/cdr-cache.php verify <domain>
 */
if (!defined('CDR_CACHE_DRIVER')) {
    define('CDR_CACHE_DRIVER', strtolower(trim((string)(getenv('CDR_CACHE_DRIVER') !== false ? getenv('CDR_CACHE_DRIVER') : 'auto'))) ?: 'auto');
}
/** The SQLite file; inside CACHE_DIR by default. */
if (!defined('CDR_STORE_FILE')) {
    define('CDR_STORE_FILE', trim((string)getenv('CDR_STORE_FILE')) !== '' ? trim((string)getenv('CDR_STORE_FILE')) : '');
}

/** First date the tenant retained CDRs; historical days are cached raw. */
if (!defined('HISTORICAL_CDR_START_DATE')) {
    define('HISTORICAL_CDR_START_DATE', '2021-01-01');
}

/**
 * PBX endpoints, keyed by the short name used in log lines and rate limits.
 * `PBX_SERVERS='{"nms1":"https://nms1.example.com","nms2":"https://nms2.example.com"}'`
 * in the environment, or `PBX_SERVER_NMS1=...` per server.
 */
if (!defined('PBX_SERVERS')) {
    $callScopeServers = json_decode((string)getenv('PBX_SERVERS'), true);
    if (!is_array($callScopeServers)) {
        $callScopeServers = ['nms1' => '', 'nms2' => ''];
    }
    foreach (array_keys($callScopeServers) as $callScopeName) {
        $callScopeEnvKey = 'PBX_SERVER_' . strtoupper((string)preg_replace('/[^A-Za-z0-9]/', '_', (string)$callScopeName));
        $callScopeValue = getenv($callScopeEnvKey);
        if (is_string($callScopeValue) && trim($callScopeValue) !== '') {
            $callScopeServers[$callScopeName] = trim($callScopeValue);
        }
    }
    define('PBX_SERVERS', $callScopeServers);
}
unset($callScopeServers, $callScopeName, $callScopeEnvKey, $callScopeValue);

if (!defined('PBX_CLIENT_ID')) {
    define('PBX_CLIENT_ID', trim((string)getenv('PBX_CLIENT_ID')));
}
if (!defined('PBX_CLIENT_SECRET')) {
    define('PBX_CLIENT_SECRET', trim((string)getenv('PBX_CLIENT_SECRET')));
}
if (!defined('PBX_SIP_TOKEN')) {
    define('PBX_SIP_TOKEN', trim((string)getenv('PBX_SIP_TOKEN')));
}
/**
 * Optional hard allowlist of extra hosts the recording proxy may fetch from
 * (a CDN or object-storage host). Comma separated. Defining it turns off the
 * `*.parent-domain` wildcard for recording URLs.
 */
if (!defined('PBX_RECORDING_HOSTS')) {
    define('PBX_RECORDING_HOSTS', trim((string)getenv('PBX_RECORDING_HOSTS')));
}

if (!defined('PBX_RATE_LIMIT_REQUESTS')) {
    define('PBX_RATE_LIMIT_REQUESTS', 5);
}
if (!defined('PBX_RATE_LIMIT_WINDOW')) {
    define('PBX_RATE_LIMIT_WINDOW', 1.0);
}
