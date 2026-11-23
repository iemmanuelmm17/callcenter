<?php
declare(strict_types=1);

/** The configured HTTPS endpoint recipients can reach, never taken from Host. */
function intelligenceRecordingPublicUrl(): string {
    $url = defined('INTELLIGENCE_RECORDING_URL') && is_string(INTELLIGENCE_RECORDING_URL) ? trim(INTELLIGENCE_RECORDING_URL) : '';
    if ($url === '' || strlen($url) > 2048 || preg_match('/[\x00-\x20\x7f\\\\]/', $url) || filter_var($url, FILTER_VALIDATE_URL) === false) return '';
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https' || empty($parts['host'])
        || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
        || !str_ends_with((string)($parts['path'] ?? ''), '/api/intelligence-recording.php')) return '';
    return $url;
}
function intelligenceRecordingDirectory(): string {
    $dir = monitorDirectory() . '/recording-links';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Cannot create recording link directory');
    return $dir;
}
function intelligenceRecordingTokenFile(string $token): ?string {
    if (!preg_match('/^[0-9a-f]{72}$/D', $token)) return null;
    $created = hexdec(substr($token, 0, 8));
    if ($created <= 0 || $created > time() + 300 || time() >= $created + 30 * 86400) return null;
    return intelligenceRecordingDirectory() . '/' . gmdate('Ymd', (int)$created) . '/' . hash('sha256', $token) . '.json';
}
function intelligenceRecordingUser(string $user): string {
    $user = trim($user);
    if (strncasecmp($user, 'sip:', 4) === 0) $user = substr($user, 4);
    $at = strpos($user, '@');
    if ($at !== false) $user = substr($user, 0, $at);
    $user = trim($user);
    if (strcasecmp($user, 'NotFound') === 0) return '';
    return $user;
}
/** Store no bearer key or PBX download URL in the email or link file. */
function intelligenceRecordingIssue(PbxClient $client, string $domain, array $call): ?string {
    $url = intelligenceRecordingPublicUrl();
    if ($url === '') return null;
    $id = callRecordingCallId($call);
    $user = intelligenceRecordingUser(callRecordingUser($call));
    if ($domain === '' || strlen($domain) > 64 || preg_match('/[\x00-\x1f\x7f]/', $domain)
        || $id === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id)
        || $user === '' || strlen($user) > 128 || preg_match('/[\x00-\x1f\x7f]/', $user)) return null;
    if (intelligenceRecordingSource($client, ['domain' => $domain, 'user' => $user, 'callId' => $id]) === null) return null;
    $created = time();
    $token = sprintf('%08x', $created) . bin2hex(random_bytes(32));
    $file = intelligenceRecordingTokenFile($token);
    if ($file === null) throw new RuntimeException('Cannot create recording link');
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Cannot create recording link bucket');
    monitorWriteFile($file, ['created' => $created, 'domain' => $domain, 'user' => $user, 'callId' => $id]);
    // The capability is in the fragment: ordinary HTTP access logs do not get it.
    return $url . '#' . $token;
}
/** Invalid, unknown or expired tokens all fail closed. */
function intelligenceRecordingResolve(string $token): ?array {
    $file = intelligenceRecordingTokenFile($token);
    if ($file === null || !is_file($file)) return null;
    $row = monitorReadFile($file);
    if (($row['created'] ?? null) !== (int)hexdec(substr($token, 0, 8))) return null;
    foreach (['domain' => 64, 'user' => 128, 'callId' => 512] as $key => $max) {
        if (!is_string($row[$key] ?? null) || $row[$key] === '' || strlen($row[$key]) > $max || preg_match('/[\x00-\x1f\x7f]/', $row[$key])) return null;
    }
    return $row;
}
/** Validate the PBX-supplied location before offering a link and again at download. */
function intelligenceRecordingSource(PbxClient $client, array $reference): ?string {
    $info = $client->recording($reference['domain'], $reference['user'], $reference['callId']);
    $url = html_entity_decode(trim((string)($info['file-access-url'] ?? '')), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if ($url === '' || parse_url($url, PHP_URL_FRAGMENT) !== null) return null;
    return pbxRecordingUrl($url) ?? pbxPublicRecordingUrl($url);
}
/** Use the existing PBX / public-host validation and never send a key to a CDN. */
function intelligenceRecordingDownload(PbxClient $client, array $reference): ?string {
    $url = intelligenceRecordingSource($client, $reference);
    if ($url === null) return null;
    $pbx = pbxRecordingUrl($url);
    if ($pbx !== null) {
        // Same wav16 conversion used by the recording player. Preserve other
        // query parameters and drop a conflicting existing convert parameter.
        $parts = explode('?', $pbx, 2);
        $query = isset($parts[1]) ? explode('&', $parts[1]) : [];
        $query = array_values(array_filter($query, static function (string $param): bool {
            return $param !== '' && strcasecmp(rawurldecode(explode('=', $param, 2)[0]), 'convert') !== 0;
        }));
        $query[] = 'convert=wav16';
        $file = $client->download($parts[0] . '?' . implode('&', $query));
    } else {
        $public = pbxPublicRecordingUrl($url);
        if ($public === null) return null;
        // Do not alter signed object-storage URLs or attach the PBX key.
        $file = $client->downloadPublic($public);
    }
    $body = $file['body'] ?? '';
    if (empty($file['ok']) || !is_string($body) || strlen($body) < 12
        || !in_array(substr($body, 0, 4), ['RIFF', 'RF64', 'RIFX'], true) || substr($body, 8, 4) !== 'WAVE') return null;
    return $body;
}
/** Clear only buckets that cannot contain valid 30-day tokens. */
function intelligenceRecordingPrune(): void {
    monitorLocked('recording-prune', static function (): void {
        $dir = intelligenceRecordingDirectory();
        $marker = $dir . '/pruned.json';
        $today = gmdate('Ymd');
        if ((monitorReadFile($marker)['date'] ?? '') === $today) return;
        $cutoff = gmdate('Ymd', time() - 31 * 86400);
        foreach (glob($dir . '/*', GLOB_ONLYDIR) ?: [] as $bucket) {
            $day = basename($bucket);
            if (!preg_match('/^\d{8}$/', $day) || $day >= $cutoff) continue;
            foreach (glob($bucket . '/*.json') ?: [] as $file) if (!@unlink($file)) return;
            if (!@rmdir($bucket)) return;
        }
        monitorWriteFile($marker, ['date' => $today]);
    });
}
