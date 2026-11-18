<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
requireMethod('POST');
try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager']);
    $domain = (string)($user['domain'] ?? '');
    if ($domain === '') jsonResponse(['error' => 'Missing domain.'], 422);
    $input = readJsonBody();
    $action = (string)($input['action'] ?? '');
    if ($action === 'monitor_status') {
        $state = monitorState($domain);
        jsonResponse(['enabled' => !empty($state['enabled']), 'configured' => monitorReady(), 'lastRun' => $state['lastRun'] ?? null, 'reviews' => monitorReviews($domain)]);
    }
    if ($action === 'monitor_reviewed') {
        if (!is_string($input['id'] ?? null)) throw new InvalidArgumentException('A review is required.');
        monitorAcknowledge($domain, $input['id']);
        auditView($user, ['domain' => $domain], 'intelligence-monitor-review');
        jsonResponse(['reviews' => monitorReviews($domain)]);
    }
    if ($action === 'monitor_enable') {
        if (!is_bool($input['enabled'] ?? null)) throw new InvalidArgumentException('An enabled setting is required.');
        $state = monitorSetEnabled($domain, $input['enabled']);
        auditView($user, ['domain' => $domain, 'enabled' => $input['enabled']], 'intelligence-monitor-settings');
        jsonResponse(['enabled' => !empty($state['enabled']), 'configured' => monitorReady(), 'lastRun' => $state['lastRun'] ?? null, 'reviews' => monitorReviews($domain)]);
    }
    if ($action === 'watches') {
        jsonResponse(['watches' => intelligenceWatches($domain)]);
    }
    if ($action === 'save_watches') {
        if (!is_array($input['watches'] ?? null)) throw new InvalidArgumentException('A list of watched phrases is required.');
        $watches = intelligenceSaveWatches($domain, $input['watches']);
        auditView($user, ['domain' => $domain], 'intelligence-watch-settings');
        jsonResponse(['watches' => $watches]);
    }
    if ($action === 'list') {
        $filters = authorizedFilters($input, $user);
        if ($filters['end'] < $filters['start']) throw new InvalidArgumentException('Invalid date range.');
        $month = trim((string)($input['month'] ?? ''));
        if ($month !== '') intelligenceMonth('', $month);
        $directory = userDirectory($user);
        $calls = filterCallsByLocalDate(reportingCdrRows($user, $filters, $directory), $filters['start'], $filters['end']);
        $rows = []; $missing = 0; $seen = [];
        $missingReasons = ['jobId' => 0, 'server' => 0, 'callId' => 0, 'month' => 0];
        $watches = intelligenceWatches($domain);
        foreach ($calls as $index => $call) {
            $topicsHint = intelligenceCdrTopics($call);
            $matchesHint = $topicsHint ? intelligenceMatches(['call-intelligence-topics-top' => $topicsHint], $watches) : [];
            $reason = null;
            try { $ref = intelligenceReference($call, $domain, $month, $reason); }
            catch (InvalidArgumentException $e) { $ref = null; $reason = 'month'; }
            if (!$ref) {
                $missing++; $missingReasons[$reason]++;
                // CDR topics are still useful even if the transcription cannot
                // be looked up. Keep the incomplete state explicit and never
                // make this row eligible for email.
                if ($topicsHint !== []) {
                    $field = 'id';
                    $display = trim((string)($call['id'] ?? ''));
                    foreach (['call-orig-call-id', 'call-term-call-id'] as $candidate) {
                        if (trim((string)($call[$candidate] ?? '')) !== '') { $field = $candidate; $display = trim((string)$call[$candidate]); break; }
                    }
                    if ($display === '') $display = 'CDR ' . ($index + 1);
                    $emailRef = intelligenceEmailReference(null, $display, $field, (string)($call['call-start-datetime'] ?? ''), $topicsHint, (string)$reason, $domain);
                    $rows[] = ['rowKey' => 'cdr-' . hash('sha256', cdrCacheKey($call, $index)), 'reference' => null, 'emailReference' => $emailRef,
                        'callId' => $display, 'callIdField' => $field, 'startedAt' => (string)($call['call-start-datetime'] ?? ''),
                        'topicsHint' => $topicsHint, 'matchesHint' => $matchesHint, 'status' => 'unavailable', 'detail' => 'Transcription lookup unavailable (' . $reason . ')'];
                }
                continue;
            }
            $ref['completedAt'] = (string)($call['call-disconnect-datetime'] ?? '');
            $key = $ref['id'] . '|' . $ref['callid'];
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $emailRef = intelligenceEmailReference($ref, $ref['callid'], $ref['displayField'], (string)($call['call-start-datetime'] ?? ''), $topicsHint, '', $domain);
            $rows[] = ['reference' => intelligenceSign($ref, $domain), 'emailReference' => $emailRef, 'callId' => $ref['callid'], 'callIdField' => $ref['displayField'],
                'startedAt' => (string)($call['call-start-datetime'] ?? ''), 'month' => $ref['month'], 'topicsHint' => $topicsHint, 'matchesHint' => $matchesHint];
        }
        auditView($user, ['start' => $filters['start'], 'end' => $filters['end']], 'intelligence-report');
        jsonResponse(['calls' => $rows, 'intelligenceWorkers' => loadDomainSettings($domain)['intelligenceWorkers'], 'missing' => $missing, 'missingReasons' => $missingReasons, 'hours' => $filters['hours'], 'cacheStatus' => cdrRangeCacheStatus($user, $filters['start'], $filters['end']), 'timezone' => reportingTimezoneName()]);
    }
    if ($action === 'lookup') {
        $ref = intelligenceVerify((string)($input['reference'] ?? ''), $domain);
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        setReportingTimezone(loadDomainSettings($domain)['timezone'] ?? null);
        $job = intelligenceReadJob($client, $domain, $ref, intelligenceWatches($domain));
        if ($job['status'] === 'finished') {
            try { monitorMarkReport($domain, $ref); } catch (Throwable $e) {
                appExceptionLog('Intelligence report check tracking', $e);
                $job['status'] = 'partial';
                $job['detail'] = 'Unable to record this report check for automatic alerts; review before relying on suppression.';
            }
        }
        jsonResponse($job);
    }
    if ($action === 'send') {
        $recipients = $input['recipients'] ?? null;
        $refs = $input['references'] ?? null;
        if (!is_array($recipients) || count($recipients) < 1 || count($recipients) > 10) throw new InvalidArgumentException('Enter 1–10 recipient email addresses.');
        $addresses = [];
        foreach ($recipients as $address) {
            if (!is_string($address) || strlen($address) > 254 || !filter_var($address, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $address)) throw new InvalidArgumentException('Invalid recipient email address.');
            $addresses[$address] = true;
        }
        if (!is_array($refs) || count($refs) < 1 || count($refs) > 10) throw new InvalidArgumentException('Select 1–10 calls per email batch.');
        foreach ($refs as $token) if (!is_string($token)) throw new InvalidArgumentException('Invalid call reference.');
        $calls = [];
        foreach (array_unique($refs) as $token) {
            $calls[] = intelligenceVerifyEmail($token, $domain);
        }
        if (!intelligenceSmtpConfigured()) jsonResponse(['error' => 'Email is unavailable: SMTP is not configured on the server.'], 503);
        if (function_exists('set_time_limit')) set_time_limit(360);
        $watches = intelligenceWatches($domain);
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        $body = intelligenceEmailBody($calls, $client, $domain, $watches);
        intelligenceSendMail(array_keys($addresses), $body);
        auditView($user, ['domain' => $domain, 'calls' => count($calls), 'recipients' => count($addresses)], 'intelligence-email');
        jsonResponse(['sent' => true]);
    }
    throw new InvalidArgumentException('Unknown action.');
} catch (InvalidArgumentException $e) {
    jsonResponse(['error' => $e->getMessage()], 422);
} catch (Throwable $e) {
    appExceptionLog('Intelligence report', $e);
    jsonResponseThrowable($e, 'Unable to complete intelligence request.');
}
