<?php
declare(strict_types=1);

/**
 * Server-side URL policy (SEC-2, SEC-3).
 *
 * The dashboard asks the PHP server to fetch two third-party URLs:
 *
 *   1. API recording playback (`api/recording.php`) — the browser may send the
 *      `src` URL it got from the PBX, the server fetches it and streams the
 *      audio back. `PbxClient::download()` attaches the PBX bearer token.
 *   2. The call-flow "prefilled trace API" (`api/call_flow.php`) — the CDR
 *      carries a PBX URL whose query the server reuses for the SIP-flow call.
 *
 * Both took the caller's string at face value, which allowed (a) the bearer
 * token to be sent to any host whose name merely contained `birns.net` or
 * whose path contained `/ns-api`, and (b) the caller to choose an arbitrary
 * PBX path/query and to reach internal addresses such as
 * `http://169.254.169.254/...`.
 *
 * This file is the single place that decides what is allowed. It is pure
 * (no curl, no session, no side effects) so it can be unit tested directly,
 * and every caller that builds a URL goes through it:
 *
 *   pbxRecordingUrl()        strict: configured PBX hosts only, /ns-api/ path,
 *                            token may be attached.
 *   pbxPublicRecordingUrl()  fallback for a PBX-supplied CDN URL: public host
 *                            only, never with a token.
 *   pbxSipflowPath()         rebuilds /ns-api/v2/sipflow?... from validated
 *                            values; the caller never controls the path.
 *
 * Allowlist rules
 *   exact   every host in PBX_SERVERS plus the entries in PBX_RECORDING_HOSTS
 *   suffix  the parent domain of a PBX host with three or more labels
 *           (nms1.birns.net -> birns.net), so a PBX that serves recordings
 *           from another sub-domain keeps working. Defining PBX_RECORDING_HOSTS
 *           turns the suffix rule off and pins the allowlist to those hosts.
 */

/** Anything longer than this is not a URL we need to fetch. */
const PBX_URL_MAX_LENGTH = 2048;
/** Longest value accepted in a reused SIP-flow query parameter. */
const PBX_SIPFLOW_VALUE_MAX_LENGTH = 300;
/** SIP-flow query parameters the PBX API accepts (everything else is dropped). */
const PBX_SIPFLOW_PARAMS = ['start_time', 'end_time', 'callids', 'servers', 'type'];
/** `type` values this application issues itself. */
const PBX_SIPFLOW_TYPES = ['cradle_to_grave'];

function pbxHasControlChars(string $value): bool
{
    return preg_match('/[\x00-\x1F\x7F]/', $value) === 1;
}

/**
 * The parent domain of a PBX host: `nms1.birns.net` -> `birns.net`.
 * Returns '' when there is nothing safe to derive (IP literals, two-label
 * hosts such as `pbx.example`, or single labels such as `localhost`).
 */
function pbxParentDomain(string $host): string
{
    $host = strtolower(trim($host));
    if ($host === '' || filter_var($host, FILTER_VALIDATE_IP) !== false) {
        return '';
    }
    $labels = array_values(array_filter(explode('.', $host), static fn(string $l): bool => $l !== ''));
    if (count($labels) < 3) {
        return '';
    }
    $parent = implode('.', array_slice($labels, 1));
    return substr_count($parent, '.') >= 1 ? $parent : '';
}

/** Scheme configured for the PBX (recordings must use the same one). */
function pbxScheme(): string
{
    foreach ((array)PBX_SERVERS as $base) {
        $scheme = strtolower((string)(parse_url((string)$base, PHP_URL_SCHEME) ?? ''));
        if ($scheme === 'http' || $scheme === 'https') {
            return $scheme;
        }
    }
    return 'https';
}

/** Port configured for the PBX, or the scheme default. */
function pbxPort(): int
{
    foreach ((array)PBX_SERVERS as $base) {
        $port = parse_url((string)$base, PHP_URL_PORT);
        if (is_int($port) && $port > 0) {
            return $port;
        }
    }
    return pbxScheme() === 'http' ? 80 : 443;
}

function pbxCompareHost(string $a, string $b): bool
{
    return $a !== '' && strcasecmp(rtrim($a, '.'), rtrim($b, '.')) === 0;
}

/** @return array{exact:list<string>,suffix:list<string>} */
function pbxAllowedHosts(): array
{
    $exact = [];
    $suffix = [];

    foreach ((array)PBX_SERVERS as $base) {
        $host = strtolower(trim((string)(parse_url((string)$base, PHP_URL_HOST) ?? '')));
        if ($host === '') {
            continue;
        }
        $exact[$host] = true;
    }

    $configured = [];
    if (defined('PBX_RECORDING_HOSTS')) {
        foreach (explode(',', (string)PBX_RECORDING_HOSTS) as $entry) {
            $entry = strtolower(trim((string)(parse_url(trim($entry), PHP_URL_HOST) ?? trim($entry))));
            if ($entry !== '') {
                $configured[$entry] = true;
                $exact[$entry] = true;
            }
        }
    }

    /* The wildcard only applies while no explicit host list is configured. */
    if ($configured === []) {
        foreach (array_keys($exact) as $host) {
            $parent = pbxParentDomain($host);
            if ($parent !== '') {
                $suffix[$parent] = true;
            }
        }
    }

    return ['exact' => array_keys($exact), 'suffix' => array_keys($suffix)];
}

function pbxHostAllowed(string $host): bool
{
    $host = strtolower(trim($host));
    if ($host === '' || filter_var($host, FILTER_VALIDATE_IP) !== false) {
        /* IP literals are only ever accepted when configured explicitly. */
        $allowed = pbxAllowedHosts();
        foreach ($allowed['exact'] as $exact) {
            if (pbxCompareHost($host, $exact)) {
                return true;
            }
        }
        return false;
    }
    if (!str_contains($host, '.')) {
        return false; /* single-label names are internal by definition */
    }
    if (preg_match('/(^|\.)(local|localhost|internal|intranet|lan|corp|home\.arpa)$/', $host) === 1) {
        return false;
    }

    $allowed = pbxAllowedHosts();
    foreach ($allowed['exact'] as $exact) {
        if (pbxCompareHost($host, $exact)) {
            return true;
        }
    }
    foreach ($allowed['suffix'] as $suffix) {
        if (str_ends_with($host, '.' . $suffix)) {
            return true;
        }
    }
    return false;
}

/**
 * True when every address a host resolves to is public (SSRF guard for hosts
 * that are not on the PBX allowlist). Fails closed: no DNS, no problem — the
 * URL is refused.
 */
function pbxHostIsPublic(string $host): bool
{
    $host = strtolower(trim($host));
    if ($host === '' || pbxHasControlChars($host)) {
        return false;
    }
    if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
        return pbxIpIsPublic($host);
    }
    if (!str_contains($host, '.') || preg_match('/(^|\.)(local|localhost|internal|intranet|lan|corp|home\.arpa)$/', $host) === 1) {
        return false;
    }
    $addresses = function_exists('gethostbynamel') ? @gethostbynamel($host) : false;
    if (!is_array($addresses) || $addresses === []) {
        return false;
    }
    foreach ($addresses as $address) {
        if (!pbxIpIsPublic((string)$address)) {
            return false;
        }
    }
    return true;
}

function pbxIpIsPublic(string $ip): bool
{
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        return false;
    }
    return filter_var(
        $ip,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) !== false;
}

/**
 * Split and validate a URL. Returns null when the URL must not be fetched.
 *
 * @param array{hosts:bool,pathPrefix:?string,ports:list<int>,schemes:list<string>,publicOnly:bool} $policy
 * @return array{scheme:string,host:string,port:int,path:string,url:string}|null
 */
function pbxUrlParts(string $url, array $policy): ?array
{
    $url = trim($url);
    if ($url === '' || strlen($url) > PBX_URL_MAX_LENGTH || pbxHasControlChars($url)) {
        return null;
    }
    /* Raw spaces are legal in a Location header but not in a request line. */
    $url = str_replace(' ', '%20', $url);
    if (preg_match('/[\s]/', $url) === 1 || str_contains($url, '\\')) {
        return null;
    }

    $parts = parse_url($url);
    if (!is_array($parts)) {
        return null;
    }
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if ($scheme === '' || $host === '' || $path === '') {
        return null;
    }
    if (isset($parts['user']) || isset($parts['pass'])) {
        return null; /* credentials in the URL are never legitimate here */
    }
    if (!in_array($scheme, $policy['schemes'], true)) {
        return null;
    }
    if (str_contains($path, '..')) {
        return null;
    }
    $prefix = $policy['pathPrefix'];
    if ($prefix !== null && !str_starts_with($path, $prefix)) {
        return null;
    }

    $port = isset($parts['port']) ? (int)$parts['port'] : ($scheme === 'http' ? 80 : 443);
    if ($policy['ports'] !== [] && !in_array($port, $policy['ports'], true)) {
        return null;
    }

    if (!empty($policy['hosts'])) {
        if (!pbxHostAllowed($host)) {
            return null;
        }
    } elseif (empty($policy['publicOnly']) || !pbxHostIsPublic($host)) {
        return null;
    }

    return ['scheme' => $scheme, 'host' => $host, 'port' => $port, 'path' => $path, 'url' => $url];
}

/**
 * Strict: a recording URL on the configured PBX, safe to fetch with the token.
 * Returns the URL to fetch, or null when it must be refused.
 */
function pbxRecordingUrl(string $url): ?string
{
    $parts = pbxUrlParts($url, [
        'hosts' => true,
        'pathPrefix' => '/ns-api/',
        'ports' => [pbxPort()],
        'schemes' => [pbxScheme()],
        'publicOnly' => false
    ]);
    return $parts === null ? null : $parts['url'];
}

/**
 * Fallback for a URL the PBX itself handed us (CDN / object storage): public
 * host, standard port, https whenever the PBX uses https — and NEVER fetched
 * with the bearer token.
 */
function pbxPublicRecordingUrl(string $url): ?string
{
    $parts = pbxUrlParts($url, [
        'hosts' => false,
        'pathPrefix' => null,
        'ports' => [80, 443],
        'schemes' => pbxScheme() === 'http' ? ['http', 'https'] : ['https'],
        'publicOnly' => true
    ]);
    return $parts === null ? null : $parts['url'];
}

/** Resolve a (possibly relative) Location header against the URL that sent it. */
function pbxResolveUrl(string $base, string $location): string
{
    $location = trim($location);
    if ($location === '' || pbxHasControlChars($location)) {
        return '';
    }
    if (preg_match('#^[a-z][a-z0-9+.\-]*://#i', $location) === 1) {
        return $location;
    }
    if (str_starts_with($location, '//')) {
        $scheme = strtolower((string)(parse_url($base, PHP_URL_SCHEME) ?? 'https'));
        return $scheme . ':' . $location;
    }
    $parts = parse_url($base);
    if (!is_array($parts) || empty($parts['host'])) {
        return '';
    }
    $origin = strtolower((string)$parts['scheme']) . '://' . $parts['host']
        . (isset($parts['port']) ? ':' . (int)$parts['port'] : '');
    if (str_starts_with($location, '/')) {
        return $origin . $location;
    }
    $path = (string)($parts['path'] ?? '/');
    $path = substr($path, 0, (int)(strrpos($path, '/') ?: 0) + 1);
    return $origin . $path . $location;
}

/** True when the call-flow endpoint may reuse this trace value. */
function pbxTraceApiIsAcceptable(string $traceApi): bool
{
    $traceApi = trim($traceApi);
    if ($traceApi === '') {
        return true; /* optional */
    }
    if (strlen($traceApi) > PBX_URL_MAX_LENGTH || pbxHasControlChars($traceApi)) {
        return false;
    }
    return pbxSipflowTraceQuery($traceApi) !== null;
}

/**
 * Extract the query from a PBX trace URL, keeping only the parameters this
 * application issues. Returns null when the value must be refused outright
 * (unknown path, bad host, malformed query), or an array of clean parameters.
 *
 * @return array<string,string>|null
 */
function pbxSipflowTraceQuery(string $traceApi): ?array
{
    $trace = html_entity_decode(trim($traceApi), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if ($trace === '') {
        return [];
    }
    if (strlen($trace) > PBX_URL_MAX_LENGTH || pbxHasControlChars($trace)) {
        return null;
    }
    $trace = preg_replace('/#.*$/', '', $trace) ?? $trace;

    if (preg_match('#^[a-z][a-z0-9+.\-]*://#i', $trace) === 1) {
        $parts = parse_url($trace);
        if (!is_array($parts) || empty($parts['host'])) {
            return null;
        }
        if (!pbxHostAllowed(strtolower((string)$parts['host']))) {
            return null;
        }
        $trace = (string)($parts['path'] ?? '') . (isset($parts['query']) ? '?' . $parts['query'] : '');
    }

    $path = $trace;
    $query = '';
    $question = strpos($trace, '?');
    if ($question !== false) {
        $path = substr($trace, 0, $question);
        $query = substr($trace, $question + 1);
    } elseif (str_contains($trace, '=')) {
        /* A bare query string, no path at all. */
        $query = $trace;
        $path = '';
    }

    $path = trim($path, '/');
    if ($path !== '' && strcasecmp($path, 'ns-api/v2/sipflow') !== 0 && strcasecmp($path, 'sipflow') !== 0) {
        return null; /* some other PBX endpoint — never reused */
    }

    $clean = [];
    foreach (explode('&', $query) as $pair) {
        if ($pair === '' || count($clean) >= count(PBX_SIPFLOW_PARAMS)) {
            continue;
        }
        $eq = strpos($pair, '=');
        $key = strtolower(rawurldecode($eq === false ? $pair : substr($pair, 0, $eq)));
        $value = $eq === false ? '' : rawurldecode(substr($pair, $eq + 1));
        if (!in_array($key, PBX_SIPFLOW_PARAMS, true) || isset($clean[$key])) {
            continue;
        }
        if (strlen($value) > PBX_SIPFLOW_VALUE_MAX_LENGTH || pbxHasControlChars($value)) {
            continue;
        }
        $value = pbxSipflowValue($key, $value);
        if ($value !== '') {
            $clean[$key] = $value;
        }
    }
    return $clean;
}

/** Normalise one reused SIP-flow value; '' means "drop this parameter". */
function pbxSipflowValue(string $key, string $value): string
{
    $value = trim($value);
    switch ($key) {
        case 'start_time':
        case 'end_time':
            return pbxSipflowTime($value);
        case 'callids':
            return preg_match('/^[A-Za-z0-9_.:@,\-]{1,300}$/', $value) === 1 ? $value : '';
        case 'servers':
            return pbxSipflowHostname($value);
        case 'type':
            return in_array(strtolower($value), PBX_SIPFLOW_TYPES, true) ? strtolower($value) : '';
    }
    return '';
}

function pbxSipflowTime(string $raw): string
{
    $raw = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $raw = str_replace('T', ' ', $raw);
    if (preg_match('/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/', $raw, $m) === 1) {
        return $m[1];
    }
    if (preg_match('/^\d{9,13}$/', $raw) === 1) {
        return $raw;
    }
    return '';
}

function pbxSipflowHostname(string $raw): string
{
    $raw = html_entity_decode(trim($raw), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $raw = preg_replace('/\[([^\]]+)\]\([^)]+\)/', '$1', $raw) ?? $raw;
    $raw = preg_replace('#^[a-z][a-z0-9+.\-]*://#i', '', $raw) ?? $raw;
    $raw = explode('/', $raw)[0];
    $raw = explode(',', $raw)[0];
    $raw = trim($raw);
    return preg_match('/^[A-Za-z0-9_.\-]{1,253}$/', $raw) === 1 ? $raw : '';
}

function pbxSipflowCallids(string $raw): string
{
    $raw = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $raw = preg_replace('/^callids=/i', '', $raw) ?? $raw;
    return preg_match('/^[A-Za-z0-9_.:@,\-]{1,300}$/', $raw) === 1 ? $raw : '';
}

/**
 * The SIP-flow path+query the server will request. Explicit values win; a
 * caller-supplied trace only ever contributes allowlisted query parameters,
 * never the path and never a host.
 */
function pbxSipflowPath(
    string $traceApi,
    string $startTime,
    string $endTime,
    string $callids,
    string $servers
): string {
    $params = [];
    $start = pbxSipflowTime($startTime);
    $end = pbxSipflowTime($endTime !== '' ? $endTime : $startTime);
    if ($start !== '') {
        $params['start_time'] = $start;
    }
    if ($end !== '') {
        $params['end_time'] = $end;
    }
    $ids = pbxSipflowCallids($callids);
    if ($ids !== '') {
        $params['callids'] = $ids;
    }
    $host = pbxSipflowHostname($servers);
    if ($host !== '') {
        $params['servers'] = $host;
    }

    $trace = pbxSipflowTraceQuery($traceApi) ?? [];
    foreach ($trace as $key => $value) {
        $params[$key] = $value;
    }
    if (!isset($params['type']) || $params['type'] === '') {
        $params['type'] = 'cradle_to_grave';
    }

    return '/ns-api/v2/sipflow?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
}
