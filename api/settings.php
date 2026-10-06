<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

try {
    $user = currentUser();
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $domain = (string)($user['domain'] ?? '');
    if ($domain === '') {
        jsonResponse(['error' => 'Missing domain'], 422);
    }

    /*
     * QA-5: the thresholds decide what counts as red on every screen in the
     * tenant, so reading them is a manager/supervisor action and writing them
     * is a manager one. Agents and basic users do not fetch this endpoint at
     * all — they get the *effective* thresholds with the dashboard payload
     * (api/report.php -> `settings`), so their colours still match.
     */
    requirePageRoles($user, ['office_manager', 'supervisor']);

    if ($method === 'GET') {
        jsonResponse([
            'data' => loadDomainSettings($domain),
            /* The client hides Save for anyone who is not an office manager;
             * this flag is the server saying the same thing. */
            'canEdit' => $user['role'] === 'office_manager'
        ]);
    }

    if ($method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }

    requirePageRoles($user, ['office_manager']);
    $requested = readJsonBody();
    $saved = saveDomainSettings($domain, is_array($requested) ? $requested : []);
    auditView($user, ['domain' => $domain], 'settings');
    jsonResponse(['data' => $saved]);
} catch (Throwable $e) {
    appExceptionLog('Settings', $e);
    jsonResponse(['error' => 'Unable to load settings.'], 502);
}
