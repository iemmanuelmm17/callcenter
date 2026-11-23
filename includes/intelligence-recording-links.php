<?php
declare(strict_types=1);

/** Compatibility for previously emailed 30-day app links. New alerts use the PBX URL directly. */
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
/** Look up a URL for new automatic alerts without downloading or storing audio. */
function intelligenceRecordingLink(PbxClient $client, string $domain, array $call): ?string {
    $id = callRecordingCallId($call);
    $user = intelligenceRecordingUser(callRecordingUser($call));
    if ($domain === '' || strlen($domain) > 64 || preg_match('/[\x00-\x1f\x7f]/', $domain)
        || $id === '' || strlen($id) > 512 || preg_match('/[\x00-\x1f\x7f]/', $id)
        || $user === '' || strlen($user) > 128 || preg_match('/[\x00-\x1f\x7f]/', $user)) return null;
    return intelligenceRecordingSource($client, ['domain' => $domain, 'user' => $user, 'callId' => $id]);
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
/** The destination comes only from the authenticated PBX response, never a request parameter.
 * No server-side fetch or DNS resolution is needed; reject unsafe URL syntax.
 * Preserve signed query parameters and fragments exactly as returned. */
function intelligenceRecordingSource(PbxClient $client, array $reference): ?string {
    $info = $client->recording($reference['domain'], $reference['user'], $reference['callId']);
    $url = $info['file-access-url'] ?? null;
    if (!is_string($url) || $url === '' || strlen($url) > 8192 || preg_match('/[\x00-\x20\x7f\\\\]/', $url)
        || filter_var($url, FILTER_VALIDATE_URL) === false) return null;
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https' || empty($parts['host'])
        || isset($parts['user']) || isset($parts['pass'])) return null;
    return $url;
}
/** Clear only buckets that cannot contain valid 30-day tokens. */
function intelligenceRecordingPrune(): void {
    if (!is_dir(monitorDirectory() . '/recording-links')) return; // no legacy links on a new installation
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
