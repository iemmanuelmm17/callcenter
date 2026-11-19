<?php
declare(strict_types=1);

/* Scheduled intelligence alerts. All persistent files are server-only and
 * keyed by domain; the task and web requests share CACHE_DIR and file locks. */
function monitorDirectory(): string {
    $dir = CACHE_DIR . '/intelligence-monitor';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Cannot create monitor directory');
    return $dir;
}
function monitorDomainId(string $domain): string { return hash('sha256', $domain); }
function monitorStateFile(string $domain): string { return monitorDirectory() . '/domain-' . monitorDomainId($domain) . '.json'; }
function monitorReadFile(string $path): array {
    if (!is_file($path)) return [];
    $data = json_decode((string)file_get_contents($path), true);
    if (!is_array($data)) throw new RuntimeException('Cannot read monitor state');
    return $data;
}
function monitorWriteFile(string $path, array $data): void {
    $temp = tempnam(monitorDirectory(), 'tmp-');
    if ($temp === false) throw new RuntimeException('Cannot prepare monitor state');
    try {
        if (file_put_contents($temp, json_encode($data, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE), LOCK_EX) === false || !rename($temp, $path)) throw new RuntimeException('Cannot write monitor state');
        @chmod($path, 0600);
    } finally { if (is_file($temp)) @unlink($temp); }
}
function monitorLocked(string $name, callable $callback): mixed {
    $lock = fopen(monitorDirectory() . '/' . $name . '.lock', 'c');
    if (!$lock) throw new RuntimeException('Cannot open monitor lock');
    try {
        if (!flock($lock, LOCK_EX)) throw new RuntimeException('Cannot lock monitor state');
        return $callback();
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
function monitorState(string $domain): array {
    return monitorLocked('domain-' . monitorDomainId($domain), static function () use ($domain): array {
        $state = monitorReadFile(monitorStateFile($domain));
        return $state ?: ['domain' => $domain, 'enabled' => false];
    });
}
function monitorUpdate(string $domain, callable $change): array {
    return monitorLocked('domain-' . monitorDomainId($domain), static function () use ($domain, $change): array {
        $file = monitorStateFile($domain);
        $state = monitorReadFile($file) ?: ['domain' => $domain, 'enabled' => false];
        $state = $change($state);
        monitorWriteFile($file, $state);
        return $state;
    });
}
function monitorRecipients(): array {
    $values = defined('INTELLIGENCE_ALERT_RECIPIENTS') ? INTELLIGENCE_ALERT_RECIPIENTS : [];
    if (!is_array($values) || !$values || count($values) > 10) return [];
    $out = [];
    foreach ($values as $value) {
        if (!is_string($value) || strlen($value) > 254 || !filter_var($value, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $value)) return [];
        $out[strtolower($value)] = $value;
    }
    return array_values($out);
}
function monitorWebhookConfig(): bool {
    $url = defined('INTELLIGENCE_WEBHOOK_URL') && is_string(INTELLIGENCE_WEBHOOK_URL) ? INTELLIGENCE_WEBHOOK_URL : '';
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https' || empty($parts['host'])
        || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) return false;
    if (!defined('INTELLIGENCE_WEBHOOK_ALLOWED_IPS') || !is_array(INTELLIGENCE_WEBHOOK_ALLOWED_IPS) || !INTELLIGENCE_WEBHOOK_ALLOWED_IPS) return false;
    foreach (INTELLIGENCE_WEBHOOK_ALLOWED_IPS as $ip) if (!is_string($ip) || !filter_var($ip, FILTER_VALIDATE_IP)) return false;
    return monitorSubscriptionServer() !== '';
}
function monitorSubscriptionServer(): string {
    $key = defined('INTELLIGENCE_MONITOR_PBX_SERVER') ? trim((string)INTELLIGENCE_MONITOR_PBX_SERVER) : '';
    if ($key === '' && count(PBX_SERVERS) === 1) $key = (string)array_key_first(PBX_SERVERS);
    return isset(PBX_SERVERS[$key]) ? $key : '';
}
function monitorReady(): bool {
    if (!intelligenceSmtpConfigured() || monitorRecipients() === []
        || !defined('INTELLIGENCE_MONITOR_API_KEY') || !is_string(INTELLIGENCE_MONITOR_API_KEY)
        || trim(INTELLIGENCE_MONITOR_API_KEY) === '') return false;
    // Never send the long-lived service key to a plaintext or unconfigured PBX.
    $configured = false;
    foreach (PBX_SERVERS as $base) {
        if (!is_string($base) || trim($base) === '') continue;
        $parts = parse_url($base);
        if (!is_array($parts) || strtolower((string)($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) return false;
        $configured = true;
    }
    return $configured && monitorWebhookConfig();
}
function monitorValidateSubscription(array $result, string $domain, ?string $expectedId = null): string {
    $id = $result['id'] ?? null;
    if (!is_string($id) || $id === '' || strlen($id) > 256 || preg_match('/[\x00-\x20\x7f]/', $id)
        || ($expectedId !== null && !hash_equals($expectedId, $id)) || ($result['domain'] ?? null) !== $domain
        || ($result['model'] ?? null) !== 'cdr' || ($result['post-url'] ?? null) !== INTELLIGENCE_WEBHOOK_URL
        || ($result['user'] ?? null) !== '*') throw new RuntimeException('PBX subscription response invalid; administrator review required');
    return $id;
}
function monitorSetEnabled(string $domain, bool $enabled): array {
    if ($enabled && !monitorReady()) throw new InvalidArgumentException('Configure SMTP, recipients, PBX key, webhook URL, allowed IPs and subscription server first.');
    if ($enabled && intelligenceWatches($domain) === []) throw new InvalidArgumentException('Save at least one watched phrase before enabling alerts.');
    if (!$enabled) return monitorUpdate($domain, static function (array $state): array { $state['enabled'] = false; unset($state['activationToken']); return $state; });
    $token = bin2hex(random_bytes(16));
    $state = monitorUpdate($domain, static function (array $state) use ($token): array {
        if (!empty($state['subscriptionPending'])) throw new InvalidArgumentException('Subscription creation needs administrator review before retrying.');
        if (empty($state['subscriptionId'])) $state['subscriptionPending'] = true;
        $state['activationToken'] = $token;
        return $state;
    });
    if (!empty($state['subscriptionPending'])) {
        // Do not retry a POST automatically: timeout/409 may mean it was created.
        $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
        $result = $client->createCdrSubscription(monitorSubscriptionServer(), $domain, INTELLIGENCE_WEBHOOK_URL);
        $id = monitorValidateSubscription($result, $domain);
        $state = monitorUpdate($domain, static function (array $state) use ($id): array {
            $state['subscriptionId'] = $id; unset($state['subscriptionPending']); return $state;
        });
    } else {
        // Re-enabling must not silently use a deleted or reconfigured subscription.
        $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
        $existing = (string)$state['subscriptionId'];
        monitorValidateSubscription($client->readCdrSubscription(monitorSubscriptionServer(), $existing), $domain, $existing);
    }
    return monitorUpdate($domain, static function (array $state) use ($domain, $token): array {
        if (($state['activationToken'] ?? '') !== $token) return $state;
        unset($state['activationToken']);
        if (empty($state['enabled']) || empty($state['generation'])) {
            $state['since'] = time(); $state['generation'] = bin2hex(random_bytes(16)); $state['lastRun'] = null;
        }
        $state['enabled'] = true; $state['domain'] = $domain; return $state;
    });
}
/** Latest SMTP acceptance recorded for a CDR. Absence is not proof of no email. */
function monitorEmailStatus(string $domain, string $id): ?array {
    if ($id === '') return null;
    $key = hash('sha256', $domain . "\0" . $id);
    $data = monitorReadFile(monitorDirectory() . '/mail-' . monitorDomainId($domain) . '-' . $key . '.json');
    return $data ?: null;
}
function monitorRecordEmail(string $domain, string $id, array $recipients, string $kind, ?int $when = null): void {
    if ($id === '') return;
    $key = hash('sha256', $domain . "\0" . $id);
    monitorLocked('mail-' . monitorDomainId($domain) . '-' . substr($key, 0, 2), static function () use ($domain, $key, $recipients, $kind, $when): void {
        $file = monitorDirectory() . '/mail-' . monitorDomainId($domain) . '-' . $key . '.json';
        $now = $when ?? time();
        $old = monitorReadFile($file);
        if ((int)($old['time'] ?? 0) > $now) return;
        monitorWriteFile($file, ['time' => $now, 'recipients' => array_values($recipients), 'kind' => $kind]);
    });
}
function monitorJobKey(array $ref): string { return hash('sha256', (string)$ref['id'] . '|' . (string)$ref['callid']); }
function monitorJob(string $domain, array $ref, callable $operation): mixed {
    $prefix = 'job-' . monitorDomainId($domain) . '-' . monitorJobKey($ref);
    $stripe = 'jobs-' . monitorDomainId($domain) . '-' . substr(monitorJobKey($ref), 0, 2);
    return monitorLocked($stripe, static function () use ($prefix, $operation): mixed {
        $file = monitorDirectory() . '/' . $prefix . '.json';
        $state = monitorReadFile($file);
        $result = $operation($state);
        if ($result !== null) monitorWriteFile($file, $result);
        return $result;
    });
}
function monitorMarkReport(string $domain, array $ref): void {
    $state = monitorState($domain);
    if (empty($state['enabled'])) return;
    $completed = parseEasternDateTime((string)($ref['completedAt'] ?? ''));
    if (!$completed || $completed->getTimestamp() < (int)($state['since'] ?? PHP_INT_MAX)) return;
    monitorJob($domain, $ref, static function (array $job) use ($domain, $state): ?array {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($state['generation'] ?? null)) return null;
        if ($job !== []) return null; // sending/sent/previously checked must never be reset
        return ['status' => 'report_checked', 'time' => time()];
    });
}
/** Reviews are retained until an operator handles them; no SMTP retry is automatic. */
function monitorReviewCdr(string $domain, array $call, string $reason): void {
    $display = (string)($call['id'] ?? $call['call-id'] ?? $call['call-orig-call-id'] ?? '');
    $identity = $display . '|' . (string)($call['call-start-datetime'] ?? '') . '|' . (string)($call['call-disconnect-datetime'] ?? '');
    $name = 'review-' . monitorDomainId($domain) . '-' . hash('sha256', $identity);
    monitorLocked('reviews-' . monitorDomainId($domain) . '-' . substr(hash('sha256', $identity), 0, 2), static function () use ($name, $display, $reason): void {
        $file = monitorDirectory() . '/' . $name . '.json';
        if (!is_file($file)) monitorWriteFile($file, ['status' => 'review', 'time' => time(), 'callid' => substr($display, 0, 512), 'reason' => $reason]);
    });
}
function monitorReviews(string $domain): array {
    $id = monitorDomainId($domain); $items = []; $total = 0;
    $files = array_merge(glob(monitorDirectory() . '/job-' . $id . '-*.json') ?: [], glob(monitorDirectory() . '/review-' . $id . '-*.json') ?: []);
    foreach ($files as $path) {
        $item = monitorReadFile($path);
        if (!in_array($item['status'] ?? '', ['review', 'sending'], true)) continue;
        $total++;
        if (count($items) < 50) $items[] = ['id' => basename($path, '.json'), 'callid' => (string)($item['callid'] ?? ''), 'time' => (int)($item['time'] ?? 0), 'reason' => (string)($item['reason'] ?? 'Delivery may be uncertain; verify before retrying')];
    }
    return ['total' => $total, 'items' => $items];
}
function monitorAcknowledge(string $domain, string $id): void {
    $domainId = monitorDomainId($domain);
    if (!preg_match('/^(job|review)-' . $domainId . '-([0-9a-f]{64})$/', $id, $m)) throw new InvalidArgumentException('Invalid review.');
    $stripe = ($m[1] === 'job' ? 'jobs-' : 'reviews-') . $domainId . '-' . substr($m[2], 0, 2);
    monitorLocked($stripe, static function () use ($id): void {
        $file = monitorDirectory() . '/' . $id . '.json';
        $item = monitorReadFile($file);
        if (!in_array($item['status'] ?? '', ['review', 'sending'], true)) throw new InvalidArgumentException('Review is not available for acknowledgement.');
        $item['status'] = 'reviewed';
        $item['reviewedAt'] = time();
        monitorWriteFile($file, $item);
    });
}
/** One complete CDR from the live PBX, not from the report's cache. */
function monitorProcessCall(PbxClient $client, string $domain, array $call, array $settings, array &$counts): void {
    $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
    if (!$end) {
        $counts['missingTime']++;
        $started = parseEasternDateTime((string)($call['call-start-datetime'] ?? ''));
        if ($started && $started->getTimestamp() >= (int)$settings['since']) {
            if (time() - $started->getTimestamp() >= 86400) {
                monitorReviewCdr($domain, $call, 'Call completion time unavailable after 24 hours');
            } else $counts['pending']++;
        }
        return;
    }
    $ended = $end->getTimestamp();
    if ($ended < (int)$settings['since'] || $ended > time()) return;
    $reason = null;
    try { $ref = intelligenceReference($call, $domain, '', $reason); }
    catch (Throwable $e) { $ref = null; $reason = 'month'; }
    if (!$ref) {
        if (time() - $ended >= 86400) {
            $counts['unresolved']++;
            monitorReviewCdr($domain, $call, 'Transcription reference unavailable after 24 hours (' . ($reason ?: 'unknown') . ')');
        } else $counts['pending']++;
        return;
    }
    monitorJob($domain, $ref, static function (array $job) use ($client, $domain, $call, $ref, $ended, $settings, &$counts): ?array {
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($settings['generation'] ?? null)) return null;
        if ($job !== []) {
            if (in_array($job['status'] ?? '', ['review', 'sending'], true)) $counts['review']++;
            return null;
        }
        if (time() - $ended >= 86400) { $counts['review']++; return ['status' => 'review', 'time' => time(), 'reason' => 'Intelligence not ready within 24 hours', 'callid' => $ref['callid']]; }
        try {
            $result = intelligenceReadJob($client, $domain, $ref, intelligenceWatches($domain));
            if (($result['status'] ?? '') !== 'finished' || empty($result['topics'])) { $counts['pending']++; return null; }
        } catch (Throwable $e) { $counts['pending']++; return null; }
        if (empty($result['matches'])) { $counts['checked']++; return ['status' => 'checked', 'time' => time()]; }
        $current = monitorState($domain);
        if (empty($current['enabled']) || ($current['generation'] ?? null) !== ($settings['generation'] ?? null)) return null;
        /* Persist the ambiguous state BEFORE SMTP. A crash or timeout may mean
         * the message was accepted; never automatically resend it. */
        $sending = ['status' => 'sending', 'time' => time(), 'callid' => $ref['callid']];
        $file = monitorDirectory() . '/job-' . monitorDomainId($domain) . '-' . monitorJobKey($ref) . '.json';
        monitorWriteFile($file, $sending);
        $body = "CallScope automatic keyword alert\n\nDomain: " . $domain . "\nCall: " . $ref['callid'] . "\n";
        $body .= intelligenceEmailCallDetails((string)($call['call-start-datetime'] ?? ''), intelligencePartyDetails($call));
        $body .= "Summary: " . $result['summary'] . "\nTopics: " . implode(', ', $result['topics']) . "\n\n";
        foreach ($result['matches'] as $match) $body .= $match['keyword'] . ' (' . $match['source'] . '): ' . $match['excerpt'] . "\n";
        try {
            intelligenceSendMail(monitorRecipients(), $body, 'CallScope keyword alert');
            $accepted = time();
            try { monitorRecordEmail($domain, (string)($call['id'] ?? ''), monitorRecipients(), 'automatic', $accepted); }
            catch (Throwable $e) { appExceptionLog('Intelligence email status', $e); }
            $counts['sent']++;
            return ['status' => 'sent', 'time' => $accepted];
        } catch (Throwable $e) {
            $counts['review']++;
            return ['status' => 'review', 'time' => time(), 'callid' => $ref['callid'], 'reason' => 'SMTP delivery uncertain; verify before retrying'];
        }
    });
}
