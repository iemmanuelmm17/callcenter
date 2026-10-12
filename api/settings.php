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
        $settings = loadDomainSettings($domain);
        jsonResponse([
            'data' => loadDomainSettings($domain),
            /* The zone this tenant is measured in, applied to the request and
             * echoed for the client's clock (finding C7). */
            'timezone' => setReportingTimezone($settings['timezone'] ?? null),
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
    /*
     * `timezone` is what the server kept, not what was posted: an id the runtime
     * does not know is replaced by the deployment default, and the dialog reads
     * this back so it shows the stored truth instead of the typo. The same value
     * re-seats the client clock (lib/api.js), so a manager who moves the desk to
     * another zone sees the next click ask for the right day - no reload.
     */
    jsonResponse([
        'data' => $saved,
        'timezone' => setReportingTimezone($saved['timezone'] ?? null)
    ]);
} catch (Throwable $e) {
    appExceptionLog('Settings', $e);
    jsonResponse(['error' => 'Unable to load settings.'], 502);
}
