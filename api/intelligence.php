<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
function intelligenceMonitorStatus(string $domain, array $state): array {
    $recipients = monitorRecipients($state);
    return ['enabled' => !empty($state['enabled']), 'configured' => monitorReady(),
        'lookbackMinutes' => monitorLookbackMinutes(),
        'recipients' => $recipients, 'paused' => !empty($state['enabled']) && $recipients === [],
        'lastRun' => $state['lastRun'] ?? null, 'reviews' => monitorReviews($domain)];
}
requireMethod('POST');
try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager']);
    $domain = (string)($user['domain'] ?? '');
    if ($domain === '') jsonResponse(['error' => 'Missing domain.'], 422);
    $input = readJsonBody();
    $action = (string)($input['action'] ?? '');
    if ($action === 'smtp_diagnostic') {
        if (!intelligenceSmtpConfigured()) jsonResponse(['error' => 'SMTP is not configured on the server.'], 503);
        if (function_exists('set_time_limit')) set_time_limit(60);
        $result = intelligenceSmtpDiagnostic();
        $result['description'] = $result['ok'] ? '' : monitorSmtpErrorDescription($result['code']);
        auditView($user, ['domain' => $domain, 'ok' => $result['ok'], 'code' => $result['code']], 'intelligence-smtp-diagnostic');
        jsonResponse($result);
    }
    if ($action === 'smtp_test_email') {
        $recipient = $input['recipient'] ?? null;
        if (!is_string($recipient) || strlen($recipient) > 254 || preg_match('/[\r\n]/', $recipient) || !filter_var($recipient, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Enter one valid test email address.');
        if (!intelligenceSmtpConfigured()) jsonResponse(['error' => 'SMTP is not configured on the server.'], 503);
        if (function_exists('set_time_limit')) set_time_limit(60);
        try {
            intelligenceSendMail([$recipient], "This is a CallScope SMTP test message. It contains no call data.\n\nIf you received it, the configured SMTP server accepted and delivered this test.\n", 'CallScope SMTP test');
        } catch (RuntimeException $e) {
            if (!preg_match('/^SMTP delivery failed \(cURL error ([0-9]{1,3})\)\.$/', $e->getMessage(), $match)) throw $e;
            $code = (int)$match[1];
            auditView($user, ['domain' => $domain, 'ok' => false, 'code' => $code], 'intelligence-smtp-test');
            jsonResponse(['ok' => false, 'code' => $code, 'description' => monitorSmtpErrorDescription($code)]);
        }
        auditView($user, ['domain' => $domain, 'ok' => true], 'intelligence-smtp-test');
        jsonResponse(['ok' => true]);
    }
    if ($action === 'monitor_status') {
        $state = monitorState($domain);
        jsonResponse(intelligenceMonitorStatus($domain, $state));
    }
    if ($action === 'monitor_reviews') {
        $offset = $input['offset'] ?? 0;
        if (!is_int($offset) || $offset < 0) throw new InvalidArgumentException('Invalid review page.');
        jsonResponse(monitorReviews($domain, $offset));
    }
    if ($action === 'monitor_recipients') {
        if (!is_string($input['recipients'] ?? null)) throw new InvalidArgumentException('Enter email addresses separated by semicolons.');
        $state = monitorSaveRecipients($domain, $input['recipients']);
        auditView($user, ['domain' => $domain, 'recipients' => count(monitorRecipients($state))], 'intelligence-monitor-recipients');
        jsonResponse(intelligenceMonitorStatus($domain, $state));
    }
    if ($action === 'monitor_reviewed') {
        $offset = $input['offset'] ?? 0;
        if (!is_int($offset) || $offset < 0) throw new InvalidArgumentException('Invalid review page.');
        if (!is_string($input['id'] ?? null)) throw new InvalidArgumentException('A review is required.');
        monitorAcknowledge($domain, $input['id']);
        auditView($user, ['domain' => $domain], 'intelligence-monitor-review');
        jsonResponse(['reviews' => monitorReviews($domain, $offset)]);
    }
    if ($action === 'monitor_enable') {
        if (!is_bool($input['enabled'] ?? null)) throw new InvalidArgumentException('An enabled setting is required.');
        $state = monitorSetEnabled($domain, $input['enabled']);
        auditView($user, ['domain' => $domain, 'enabled' => $input['enabled']], 'intelligence-monitor-settings');
        jsonResponse(intelligenceMonitorStatus($domain, $state));
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
        $reviewIndex = monitorReviewIndex($domain);
        foreach ($calls as $index => $call) {
            $parties = intelligencePartyDetails($call);
            $cdrId = is_string($call['id'] ?? null) ? $call['id'] : '';
            $parties['cdrId'] = $cdrId;
            $emailStatus = monitorEmailStatus($domain, $cdrId);
            $topicsHint = intelligenceCdrTopics($call);
            $matchesHint = $topicsHint ? intelligenceMatches(['call-intelligence-topics-top' => $topicsHint], $watches) : [];
            $reason = null;
            try { $ref = intelligenceReference($call, $domain, $month, $reason); }
            catch (InvalidArgumentException $e) { $ref = null; $reason = 'month'; }
            if (!$ref) {
                $missing++; $missingReasons[$reason]++;
                $callReviews = monitorReviewsForCall($domain, $reviewIndex, $cdrId, null);
                // CDR topics are still useful even if the transcription cannot
                // be looked up. Keep the incomplete state explicit and never
                // make this row eligible for email.
                if ($topicsHint !== [] || $callReviews !== []) {
                    $field = 'id';
                    $display = trim((string)($call['id'] ?? ''));
                    foreach (['call-orig-call-id', 'call-term-call-id'] as $candidate) {
                        if (trim((string)($call[$candidate] ?? '')) !== '') { $field = $candidate; $display = trim((string)$call[$candidate]); break; }
                    }
                    if ($display === '') $display = 'CDR ' . ($index + 1);
                    $emailRef = intelligenceEmailReference(null, $display, $field, (string)($call['call-start-datetime'] ?? ''), $topicsHint, (string)$reason, $domain, $parties);
                    $rows[] = ['rowKey' => 'cdr-' . hash('sha256', cdrCacheKey($call, $index)), 'reference' => null, 'emailReference' => $emailRef,
                        'callId' => $display, 'callIdField' => $field, 'startedAt' => (string)($call['call-start-datetime'] ?? ''),
                        'emailStatus' => $emailStatus, 'reviews' => $callReviews, 'callerNumber' => $parties['callerNumber'], 'dialedNumber' => $parties['dialedNumber'], 'destinationNumber' => $parties['destinationNumber'],
                        'topicsHint' => $topicsHint, 'matchesHint' => $matchesHint, 'status' => 'unavailable', 'detail' => 'Transcription lookup unavailable (' . $reason . ')'];
                }
                continue;
            }
            $ref['completedAt'] = (string)($call['call-disconnect-datetime'] ?? '');
            $key = $ref['id'] . '|' . $ref['callid'];
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $emailRef = intelligenceEmailReference($ref, $ref['callid'], $ref['displayField'], (string)($call['call-start-datetime'] ?? ''), $topicsHint, '', $domain, $parties);
            $rows[] = ['reference' => intelligenceSign($ref, $domain), 'emailReference' => $emailRef, 'callId' => $ref['callid'], 'callIdField' => $ref['displayField'],
                'startedAt' => (string)($call['call-start-datetime'] ?? ''), 'month' => $ref['month'],
                'emailStatus' => $emailStatus, 'reviews' => monitorReviewsForCall($domain, $reviewIndex, $cdrId, $ref), 'callerNumber' => $parties['callerNumber'], 'dialedNumber' => $parties['dialedNumber'], 'destinationNumber' => $parties['destinationNumber'], 'topicsHint' => $topicsHint, 'matchesHint' => $matchesHint];
        }
        // Reviews whose CDR is unavailable are represented as limited-detail
        // rows, never as selectable/signed calls or as a guessed identity.
        $attached = [];
        foreach ($rows as $row) foreach ($row['reviews'] ?? [] as $review) $attached[$review['id']] = true;
        $scopeLimited = $filters['department'] !== '' || $filters['site'] !== '' || $filters['agents'] !== [] || $filters['hours'] !== 'all';
        $unscopedReviews = 0;
        foreach ($reviewIndex['all'] as $review) {
            if (isset($attached[$review['id']])) continue;
            $started = parseEasternDateTime((string)($review['startedAt'] ?? ''));
            if ($started && ($started->format('Y-m-d') < $filters['start'] || $started->format('Y-m-d') > $filters['end'])) continue;
            if ($scopeLimited) { $unscopedReviews++; continue; }
            $cdrId = (string)($review['cdrId'] ?? '');
            $rows[] = ['rowKey' => 'review-' . $review['id'], 'reference' => null, 'emailReference' => null, 'reviewOnly' => true,
                'callId' => $review['callid'] !== '' ? $review['callid'] : 'Unknown call', 'callIdField' => $cdrId !== '' ? 'CDR ID' : 'Recorded reference',
                'startedAt' => $started ? $started->format('c') : '', 'emailStatus' => monitorEmailStatus($domain, $cdrId), 'reviews' => [$review],
                'callerNumber' => 'Unknown', 'dialedNumber' => 'Unknown', 'destinationNumber' => 'Unknown',
                'topicsHint' => [], 'matchesHint' => [], 'status' => 'unavailable', 'detail' => 'Limited review record; original call details unavailable.'];
        }
        auditView($user, ['start' => $filters['start'], 'end' => $filters['end']], 'intelligence-report');
        jsonResponse(['unscopedReviews' => $unscopedReviews, 'calls' => $rows, 'intelligenceWorkers' => loadDomainSettings($domain)['intelligenceWorkers'], 'missing' => $missing, 'missingReasons' => $missingReasons, 'hours' => $filters['hours'], 'cacheStatus' => cdrRangeCacheStatus($user, $filters['start'], $filters['end']), 'timezone' => reportingTimezoneName()]);
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
        setReportingTimezone(loadDomainSettings($domain)['timezone'] ?? null);
        $body = intelligenceEmailBody($calls, $client, $domain, $watches);
        intelligenceSendMail(array_keys($addresses), $body);
        $accepted = time();
        foreach ($calls as $call) monitorRecordEmail($domain, $call['cdrId'], array_keys($addresses), 'manual', $accepted);
        auditView($user, ['domain' => $domain, 'calls' => count($calls), 'recipients' => count($addresses)], 'intelligence-email');
        jsonResponse(['sent' => true, 'emailStatus' => ['time' => $accepted, 'recipients' => array_keys($addresses), 'kind' => 'manual']]);
    }
    throw new InvalidArgumentException('Unknown action.');
} catch (InvalidArgumentException $e) {
    jsonResponse(['error' => $e->getMessage()], 422);
} catch (Throwable $e) {
    appExceptionLog('Intelligence report', $e);
    jsonResponseThrowable($e, 'Unable to complete intelligence request.');
}
