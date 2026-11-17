<?php
declare(strict_types=1);

/** Domain-wide watch settings are separate from the service-desk settings. */
function intelligenceWatchFile(string $domain): string {
    return CACHE_DIR . '/intelligence-watch-' . hash('sha256', $domain) . '.json';
}
function intelligenceWatches(string $domain): array {
    $file = intelligenceWatchFile($domain);
    if (!is_file($file)) return [];
    $data = @file_get_contents($file);
    $decoded = is_string($data) ? json_decode($data, true) : null;
    if (!is_array($decoded) || count(array_filter($decoded, 'is_string')) !== count($decoded)) throw new RuntimeException('Cannot read watch settings');
    return array_values($decoded);
}
function intelligenceSaveWatches(string $domain, array $input): array {
    if (count($input) > 100) throw new InvalidArgumentException('At most 100 watched phrases are allowed.');
    $out = [];
    foreach ($input as $value) {
        if (!is_string($value)) throw new InvalidArgumentException('Watched phrases must be text.');
        $value = trim($value);
        if ($value === '') continue;
        if (strlen($value) > 200 || preg_match('/[\x00-\x1f\x7f]/', $value)) throw new InvalidArgumentException('Each phrase must be at most 200 bytes and contain no control characters.');
        $out[strtolower($value)] = $value;
    }
    $out = array_values($out);
    $file = intelligenceWatchFile($domain);
    $temp = tempnam(CACHE_DIR, 'watch-');
    if ($temp === false) throw new RuntimeException('Cannot create watch settings');
    try {
        if (file_put_contents($temp, json_encode($out, JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($temp, $file)) throw new RuntimeException('Cannot save watch settings');
        @chmod($file, 0600);
    } finally { if (is_file($temp)) @unlink($temp); }
    return $out;
}
/** A server-only key makes call references unforgeable even by their holder. */
function intelligenceSigningKey(): string {
    $file = CACHE_DIR . '/.intelligence-signing-key';
    $handle = @fopen($file, 'c+b');
    if (!$handle) throw new RuntimeException('Cannot access signing key');
    try {
        if (!flock($handle, LOCK_EX)) throw new RuntimeException('Cannot lock signing key');
        @chmod($file, 0600);
        $key = stream_get_contents($handle);
        if ($key === '') {
            $key = random_bytes(32);
            rewind($handle);
            if (fwrite($handle, $key) !== 32 || !fflush($handle)) throw new RuntimeException('Cannot persist signing key');
        }
        if (!is_string($key) || strlen($key) !== 32) throw new RuntimeException('Invalid signing key');
        return $key;
    } finally { flock($handle, LOCK_UN); fclose($handle); }
}
/** References are scoped to the authenticated browser session and domain. */
function intelligenceSign(array $data, string $domain): string {
    if (session_id() === '') throw new RuntimeException('Missing session');
    $encoded = rtrim(strtr(base64_encode(json_encode($data, JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
    return $encoded . '.' . hash_hmac('sha256', session_id() . '|' . $domain . '|' . $encoded, intelligenceSigningKey());
}
function intelligenceVerify(string $token, string $domain): array {
    if (strlen($token) > 4096 || session_id() === '') throw new InvalidArgumentException('Invalid call reference.');
    $parts = explode('.', $token);
    if (count($parts) !== 2 || !hash_equals(hash_hmac('sha256', session_id() . '|' . $domain . '|' . $parts[0], intelligenceSigningKey()), $parts[1])) throw new InvalidArgumentException('Invalid call reference.');
    $data = json_decode((string)base64_decode(strtr($parts[0], '-_', '+/'), true), true);
    if (!is_array($data) || !isset($data['server'], $data['id'], $data['month'], $data['callid'], $data['identifiers']) || !is_array($data['identifiers'])) throw new InvalidArgumentException('Invalid call reference.');
    return $data;
}
function intelligenceMonth(string $start, string $override): string {
    if ($override !== '') {
        if (!preg_match('/^\d{4}(0[1-9]|1[0-2])$/', $override)) throw new InvalidArgumentException('Month must be YYYYMM.');
        return $override;
    }
    $zone = defined('INTELLIGENCE_MONTH_TIMEZONE') ? trim((string)INTELLIGENCE_MONTH_TIMEZONE) : '';
    if ($zone === '') throw new InvalidArgumentException('Configure INTELLIGENCE_MONTH_TIMEZONE or enter a lookup month.');
    try { $tz = new DateTimeZone($zone); } catch (Throwable $e) { throw new InvalidArgumentException('Invalid configured transcription month timezone.'); }
    // Offset-less CDR timestamps are interpreted in the desk timezone, as in other reports.
    $dt = parseEasternDateTime($start);
    if (!$dt) throw new InvalidArgumentException('Call start time is unavailable.');
    return $dt->setTimezone($tz)->format('Ym');
}
/** Use only query values from the PBX-provided link; never fetch its host. */
function intelligenceReference(array $call, string $domain, string $override, ?string &$reason = null): ?array {
    $id = trim((string)($call['call-intelligence-job-id'] ?? ''));
    $server = (string)($call['_server'] ?? '');
    if ($server === '' && defined('INTELLIGENCE_PBX_SERVER')) $server = trim((string)INTELLIGENCE_PBX_SERVER);
    $reason = null;
    if (!preg_match('/^\d+$/', $id) || $id === '0') { $reason = 'jobId'; return null; }
    if (!isset(PBX_SERVERS[$server])) { $reason = 'server'; return null; }
    $identifiers = [];
    $prefilledMonth = '';
    $link = html_entity_decode((string)($call['prefilled-transcription-api'] ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $parts = parse_url($link);
    if (is_array($parts) && rawurldecode((string)($parts['path'] ?? '')) === '/ns-api/v2/domains/' . $domain . '/transcriptions') {
        parse_str((string)($parts['query'] ?? ''), $query);
        if (is_string($query['id'] ?? null) && $query['id'] === $id) {
            foreach (['callid', 'orig_callid', 'term_callid', 'by_callid'] as $name) {
                if (!array_key_exists($name, $query)) continue;
                if (!is_string($query[$name])) { $reason = 'callId'; return null; }
                $value = trim($query[$name]);
                if ($value === '' || strlen($value) > 512 || preg_match('/[\x00-\x1f\x7f]/', $value)) { $reason = 'callId'; return null; }
                $identifiers[$name] = $value;
            }
            if ($identifiers !== [] && is_string($query['date'] ?? null) && preg_match('/^\d{4}(0[1-9]|1[0-2])$/', $query['date'])) $prefilledMonth = $query['date'];
        }
    }
    if ($identifiers === []) {
        $callid = trim((string)($call['call-id'] ?? ''));
        if ($callid === '' && defined('INTELLIGENCE_CALL_ID_FIELD')) {
            $field = (string)INTELLIGENCE_CALL_ID_FIELD;
            $callid = trim((string)($call[$field] ?? ''));
        }
        if ($callid === '' || strlen($callid) > 512 || preg_match('/[\x00-\x1f\x7f]/', $callid)) { $reason = 'callId'; return null; }
        $identifiers['callid'] = $callid;
    }
    $month = $override !== '' ? intelligenceMonth('', $override) : ($prefilledMonth !== '' ? $prefilledMonth : intelligenceMonth((string)($call['call-start-datetime'] ?? ''), ''));
    // Display the PBX's by-call reference when present, without treating it as callid.
    $displayField = isset($identifiers['by_callid']) ? 'by_callid' : (isset($identifiers['callid']) ? 'callid' : (isset($identifiers['term_callid']) ? 'term_callid' : 'orig_callid'));
    return ['id' => $id, 'callid' => $identifiers[$displayField], 'displayField' => $displayField, 'identifiers' => $identifiers, 'server' => $server, 'month' => $month];
}

/** Topics already present on a CDR, before a transcription is retrieved. */
function intelligenceCdrTopics(array $call): array {
    $topics = $call['call-intelligence-topics-top'] ?? [];
    if (is_string($topics)) $topics = explode(',', $topics);
    if (!is_array($topics)) return [];
    return array_values(array_unique(array_filter(array_map('trim', array_filter($topics, 'is_string')), static fn(string $topic): bool => $topic !== '')));
}

/** Case-insensitive substring matches, retaining one excerpt per phrase. */
function intelligenceMatches(array $job, array $watches): array {
    $texts = [];
    $summary = $job['call-intelligence-summary'] ?? '';
    if (is_string($summary)) $texts[] = ['source' => 'Summary', 'text' => $summary];
    foreach (['call-intelligence-topics-top', 'call-intelligence-topics-all'] as $key) {
        $topics = $job[$key] ?? [];
        if (is_string($topics)) $topics = explode(',', $topics);
        foreach ((array)$topics as $topic) if (is_string($topic)) $texts[] = ['source' => 'Topic', 'text' => $topic];
    }
    foreach ((array)($job['call-intelligence-segments'] ?? []) as $segment) {
        if (is_array($segment) && is_string($segment['comment'] ?? null)) $texts[] = ['source' => 'Transcript', 'text' => $segment['comment']];
    }
    $matches = [];
    foreach ($watches as $watch) {
        if (!is_string($watch) || $watch === '') continue;
        foreach ($texts as $text) {
            if (preg_match('/' . preg_quote($watch, '/') . '/iu', $text['text'], $found, PREG_OFFSET_CAPTURE) !== 1) continue;
            $pos = $found[0][1];
            preg_match('/.{0,80}$/us', substr($text['text'], 0, $pos), $prefix);
            preg_match('/^.{0,240}/us', substr($text['text'], $pos), $suffix);
            $matches[] = ['keyword' => $watch, 'source' => $text['source'], 'excerpt' => ($prefix[0] ?? '') . ($suffix[0] ?? '')];
            break;
        }
    }
    return $matches;
}
function intelligenceReadJob(PbxClient $client, string $domain, array $ref, array $watches): array {
    $identifiers = $ref['identifiers'];
    $job = $client->transcription((string)$ref['server'], $domain, (string)$ref['id'], (string)$ref['month'], $identifiers);
    if (isset($job['call-intelligence-job-id']) && (string)$job['call-intelligence-job-id'] !== (string)$ref['id']) throw new RuntimeException('Transcription identity mismatch');
    // Only a direct callid lookup gives us a call-id response value to compare.
    if (count($identifiers) === 1 && isset($identifiers['callid'], $job['call-id']) && (string)$job['call-id'] !== (string)$identifiers['callid']) throw new RuntimeException('Transcription identity mismatch');
    $status = strtolower((string)($job['call-intelligence-processing-status'] ?? ''));
    if ($status !== 'finished') return ['status' => 'pending', 'detail' => $status ?: 'unknown'];
    $topics = [];
    foreach (['call-intelligence-topics-all', 'call-intelligence-topics-top'] as $field) {
        $entries = $job[$field] ?? [];
        if (is_string($entries)) $entries = explode(',', $entries);
        if (!is_array($entries)) continue;
        foreach ($entries as $entry) if (is_string($entry) && trim($entry) !== '') $topics[] = trim($entry);
    }
    $topics = array_values(array_unique($topics));
    $incomplete = !empty($job['errors']) || !is_array($job['call-intelligence-segments'] ?? null)
        || !is_string($job['call-intelligence-summary'] ?? null) || (($job['call-intelligence-summary-status'] ?? '') !== 'success')
        || (!is_array($job['call-intelligence-topics-all'] ?? null) && !is_string($job['call-intelligence-topics-all'] ?? null)
            && !is_array($job['call-intelligence-topics-top'] ?? null) && !is_string($job['call-intelligence-topics-top'] ?? null));
    return ['status' => $incomplete ? 'partial' : 'finished', 'detail' => $incomplete ? 'Some intelligence text is unavailable; matches may be incomplete' : '', 'topics' => array_values(array_unique($topics)), 'summary' => (string)($job['call-intelligence-summary'] ?? ''), 'matches' => intelligenceMatches($job, $watches), 'summaryStatus' => (string)($job['call-intelligence-summary-status'] ?? '')];
}
function intelligenceSmtpConfigured(): bool {
    $host = defined('INTELLIGENCE_SMTP_HOST') ? (string)INTELLIGENCE_SMTP_HOST : '';
    $port = defined('INTELLIGENCE_SMTP_PORT') ? (int)INTELLIGENCE_SMTP_PORT : 0;
    $user = defined('INTELLIGENCE_SMTP_USERNAME') ? (string)INTELLIGENCE_SMTP_USERNAME : '';
    $password = defined('INTELLIGENCE_SMTP_PASSWORD') ? (string)INTELLIGENCE_SMTP_PASSWORD : '';
    $from = defined('INTELLIGENCE_SMTP_FROM') ? (string)INTELLIGENCE_SMTP_FROM : '';
    return $host !== '' && preg_match('/^[a-zA-Z0-9.-]+$/', $host) === 1 && $port > 0 && $port <= 65535 && $user !== '' && $password !== '' && filter_var($from, FILTER_VALIDATE_EMAIL) !== false;
}
/** SMTP via libcurl; STARTTLS and certificate verification are mandatory. */
function intelligenceSendMail(array $recipients, string $body): void {
    $host = defined('INTELLIGENCE_SMTP_HOST') ? (string)INTELLIGENCE_SMTP_HOST : '';
    $port = defined('INTELLIGENCE_SMTP_PORT') ? (int)INTELLIGENCE_SMTP_PORT : 0;
    $username = defined('INTELLIGENCE_SMTP_USERNAME') ? (string)INTELLIGENCE_SMTP_USERNAME : '';
    $password = defined('INTELLIGENCE_SMTP_PASSWORD') ? (string)INTELLIGENCE_SMTP_PASSWORD : '';
    $from = defined('INTELLIGENCE_SMTP_FROM') ? (string)INTELLIGENCE_SMTP_FROM : '';
    if (!intelligenceSmtpConfigured()) throw new RuntimeException('SMTP is not configured.');
    $payload = 'From: ' . $from . "\r\nTo: " . implode(', ', $recipients) . "\r\nSubject: CallScope keyword matches\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($body), 76, "\r\n");
    $stream = fopen('php://temp', 'w+');
    if (!$stream) throw new RuntimeException('Unable to prepare email.');
    fwrite($stream, $payload); rewind($stream);
    $curl = curl_init('smtp://' . $host . ':' . $port);
    if (!$curl) { fclose($stream); throw new RuntimeException('Unable to initialize SMTP.'); }
    try {
        curl_setopt_array($curl, [CURLOPT_USERNAME => $username, CURLOPT_PASSWORD => $password, CURLOPT_USE_SSL => CURLUSESSL_ALL,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_MAIL_FROM => '<' . $from . '>',
            CURLOPT_MAIL_RCPT => array_map(static fn($x) => '<' . $x . '>', $recipients), CURLOPT_UPLOAD => true,
            CURLOPT_INFILE => $stream, CURLOPT_INFILESIZE => strlen($payload), CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10]);
        if (curl_exec($curl) !== true) throw new RuntimeException('SMTP delivery failed.');
    } finally { curl_close($curl); fclose($stream); }
}
