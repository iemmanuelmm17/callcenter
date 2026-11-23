<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';

header('Cache-Control: private, no-store, max-age=0');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow, noarchive');
$method = (string)($_SERVER['REQUEST_METHOD'] ?? '');
if ($method === 'GET') {
    // The email capability is in the fragment, so it is never in the HTTP URL.
    // Move it into a POST before resolving the legacy link; never log the secret.
    $script = "(function(){var t=location.hash.slice(1),m=document.getElementById('message');try{history.replaceState(null,'',location.pathname);}catch(e){}if(!/^[0-9a-f]{72}$/.test(t)){m.textContent='This recording link is invalid.';return;}document.getElementById('token').value=t;document.getElementById('download').submit();})();";
    header("Content-Security-Policy: default-src 'none'; script-src 'sha256-" . base64_encode(hash('sha256', $script, true)) . "'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'");
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Download recording</title></head><body>';
    echo '<p id="message">Preparing your recording download…</p><noscript>JavaScript is required to download this recording.</noscript>';
    echo '<form id="download" method="post"><input id="token" type="hidden" name="token"></form><script>' . $script . '</script></body></html>';
    exit;
}
if ($method !== 'POST') { http_response_code(405); header('Allow: GET, POST'); exit; }
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
try {
    $token = $_POST['token'] ?? '';
    $reference = is_string($token) ? intelligenceRecordingResolve($token) : null;
    if ($reference === null) { http_response_code(404); header('Content-Type: text/plain; charset=utf-8'); echo 'Recording link is invalid or expired.'; exit; }
    if (!monitorServiceReady()) { http_response_code(503); header('Content-Type: text/plain; charset=utf-8'); echo 'Recording service is unavailable.'; exit; }
    $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
    $url = intelligenceRecordingSource($client, $reference);
    if ($url === null) { http_response_code(404); header('Content-Type: text/plain; charset=utf-8'); echo 'A recording link is not available for this call.'; exit; }
    auditView(['username' => 'alert-link', 'role' => 'bearer-link'], ['domain' => $reference['domain'], 'callId' => $reference['callId']], 'intelligence-recording-link');
    // A 303 changes the token-bearing POST to a GET at the PBX destination.
    // Never download or proxy the recording and never forward the service key.
    header('Location: ' . $url, true, 303);
} catch (Throwable $e) {
    appExceptionLog('Alert recording download', $e);
    http_response_code(502); header('Content-Type: text/plain; charset=utf-8'); echo 'Unable to retrieve the recording.';
}
