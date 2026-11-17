<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
requireMethod('POST');
try {
    $user = currentUser();
    requirePageRoles($user, ['office_manager']);
    $domain = (string)($user['domain'] ?? '');
    if ($domain === '') jsonResponse(['error' => 'Missing domain.'], 422);
    $input = readJsonBody();
    $action = (string)($input['action'] ?? '');
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
        foreach ($calls as $call) {
            $reason = null;
            try { $ref = intelligenceReference($call, $domain, $month, $reason); }
            catch (InvalidArgumentException $e) { $missing++; $missingReasons['month']++; continue; }
            if (!$ref) { $missing++; $missingReasons[$reason]++; continue; }
            $key = $ref['id'] . '|' . $ref['callid'];
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $rows[] = ['reference' => intelligenceSign($ref, $domain), 'callId' => $ref['callid'], 'callIdField' => $ref['displayField'], 'startedAt' => (string)($call['call-start-datetime'] ?? ''), 'month' => $ref['month']];
        }
        auditView($user, ['start' => $filters['start'], 'end' => $filters['end']], 'intelligence-report');
        jsonResponse(['calls' => $rows, 'missing' => $missing, 'missingReasons' => $missingReasons, 'hours' => $filters['hours'], 'cacheStatus' => cdrRangeCacheStatus($user, $filters['start'], $filters['end']), 'timezone' => reportingTimezoneName()]);
    }
    if ($action === 'lookup') {
        $ref = intelligenceVerify((string)($input['reference'] ?? ''), $domain);
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        jsonResponse(intelligenceReadJob($client, $domain, $ref, intelligenceWatches($domain)));
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
        if (!is_array($refs) || count($refs) < 1 || count($refs) > 10) throw new InvalidArgumentException('Select 1–10 matching calls per email.');
        foreach ($refs as $token) if (!is_string($token)) throw new InvalidArgumentException('Invalid call reference.');
        if (!intelligenceSmtpConfigured()) jsonResponse(['error' => 'Email is unavailable: SMTP is not configured on the server.'], 503);
        if (function_exists('set_time_limit')) set_time_limit(360);
        $watches = intelligenceWatches($domain);
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        $body = "CallScope watched keyword matches\n\n";
        foreach (array_unique($refs) as $token) {
            if (!is_string($token)) throw new InvalidArgumentException('Invalid call reference.');
            $ref = intelligenceVerify($token, $domain);
            $job = intelligenceReadJob($client, $domain, $ref, $watches);
            if (($job['status'] ?? '') !== 'finished' || empty($job['matches'])) throw new InvalidArgumentException('A selected call no longer matches or is not available. Refresh the report.');
            $body .= 'Call (' . $ref['displayField'] . '): ' . $ref['callid'] . "\nJob: " . $ref['id'] . "\n";
            foreach ($job['matches'] as $match) $body .= $match['keyword'] . ' (' . $match['source'] . '): ' . $match['excerpt'] . "\n";
            $body .= "\n";
        }
        intelligenceSendMail(array_keys($addresses), $body);
        auditView($user, ['domain' => $domain, 'calls' => count($refs), 'recipients' => count($addresses)], 'intelligence-email');
        jsonResponse(['sent' => true]);
    }
    throw new InvalidArgumentException('Unknown action.');
} catch (InvalidArgumentException $e) {
    jsonResponse(['error' => $e->getMessage()], 422);
} catch (Throwable $e) {
    appExceptionLog('Intelligence report', $e);
    jsonResponseThrowable($e, 'Unable to complete intelligence request.');
}
