<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

function recordingUserPart(string $value): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    if (strncasecmp($value, 'sip:', 4) === 0) {
        $value = substr($value, 4);
    }
    $at = strpos($value, '@');
    if ($at !== false) {
        $value = substr($value, 0, $at);
    }
    $value = trim($value);
    if ($value === '' || strcasecmp($value, 'NotFound') === 0) {
        return '';
    }
    return $value;
}

function recordingLookup(PbxClient $client, string $domain, array $extensions, array $callIds): array
{
    foreach ($callIds as $callId) {
        $callId = trim((string)$callId);
        if ($callId === '') {
            continue;
        }
        foreach ($extensions as $ext) {
            $ext = trim((string)$ext);
            try {
                $info = $client->recording($domain, $ext, $callId);
            } catch (Throwable $e) {
                $info = [];
            }
            if (!is_array($info) || $info === []) {
                continue;
            }
            $url = html_entity_decode(
                trim((string)($info['file-access-url'] ?? '')),
                ENT_QUOTES | ENT_HTML5,
                'UTF-8'
            );
            if ($url !== '') {
                $info['file-access-url'] = $url;
                return $info;
            }
        }
    }
    return [];
}

try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager', 'supervisor']);

    $isStream = ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET'
        && (isset($_GET['stream']) || isset($_GET['callId']) || isset($_GET['origCallId']));

    if (!$isStream) {
        requireMethod('POST');
        $requested = readJsonBody();
    } else {
        $requested = $_GET;
    }

    $domain = trim((string)($user['domain'] ?? ''));
    $extensions = array_values(array_unique(array_filter([
        recordingUserPart((string)($requested['extension'] ?? '')),
        recordingUserPart((string)($requested['termUser'] ?? '')),
        recordingUserPart((string)($requested['origUser'] ?? '')),
        recordingUserPart((string)($requested['agent'] ?? '')),
    ])));
    if ($extensions === []) {
        $extensions[] = '';
    }
    $callIds = array_values(array_unique(array_filter([
        trim((string)($requested['callId'] ?? '')),
        trim((string)($requested['termCallId'] ?? '')),
        trim((string)($requested['origCallId'] ?? '')),
    ])));

    if ($domain === '') {
        if ($isStream) {
            http_response_code(422);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Missing domain';
            exit;
        }
        jsonResponse(['error' => 'Missing recording identifiers'], 422);
    }

    $client = new PbxClient((string)($_SESSION['token'] ?? ''));
    $src = html_entity_decode(trim((string)($requested['src'] ?? '')), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $info = [];
    $url = '';
    if ($src !== '') {
        $host = strtolower((string)(parse_url($src, PHP_URL_HOST) ?? ''));
        $okHost = $host !== '' && (
            str_contains($host, 'birns.net')
            || str_contains($src, '/ns-api')
        );
        if ($okHost) {
            $url = $src;
        }
    }
    if ($url === '') {
        $info = recordingLookup($client, $domain, $extensions, $callIds);
        $url = is_array($info) ? trim((string)($info['file-access-url'] ?? '')) : '';
    }

    if ($isStream) {
        if ($url === '') {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'No recording';
            exit;
        }
        $file = $client->download($url);
        if (!$file['ok']) {
            http_response_code($file['status'] > 0 ? $file['status'] : 502);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Unable to fetch recording';
            exit;
        }
        $type = $file['contentType'];
        if ($type === '' || str_contains(strtolower($type), 'json') || str_contains(strtolower($type), 'text/html')) {
            $type = 'audio/mpeg';
        }
        header('Content-Type: ' . $type);
        header('Cache-Control: private, no-store');
        header('Content-Length: ' . (string)strlen($file['body']));
        echo $file['body'];
        exit;
    }

    jsonResponse([
        'data' => [
            'url' => $url,
            'duration' => (int)($info['file-duration-seconds'] ?? 0),
            'status' => (string)($info['call-recording-status'] ?? ''),
            'callId' => (string)($info['call-id'] ?? ($requested['callId'] ?? '')),
        ],
    ]);
} catch (Throwable $e) {
    appExceptionLog('Recording', $e);
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Unable to load recording.';
        exit;
    }
    jsonResponse(['error' => 'Unable to load recording.'], 502);
}
