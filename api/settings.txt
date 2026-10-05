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

    if ($method === 'GET') {
        jsonResponse(['data' => loadDomainSettings($domain)]);
    }

    if ($method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }

    requirePageRoles($user, ['office_manager', 'supervisor']);
    $requested = readJsonBody();
    $saved = saveDomainSettings($domain, is_array($requested) ? $requested : []);
    auditView($user, ['domain' => $domain], 'settings');
    jsonResponse(['data' => $saved]);
} catch (Throwable $e) {
    appExceptionLog('Settings', $e);
    jsonResponse(['error' => 'Unable to load settings.'], 502);
}
