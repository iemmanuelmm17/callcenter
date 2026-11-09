<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
$user = currentUser();
$departments = [];
$sites = [];
/*
 * The agent list rides along for the Settings screens (roster, per-queue
 * targets): every role already fetches this endpoint on every load, and the
 * directory is cached server-side, so listing it here is one array copy rather
 * than an extra round trip. `extension` first, because that is what a CDR and a
 * roster row join on.
 */
$agents = [];
$isManager = $user['role'] === 'office_manager';
if ($isManager) {
    foreach (cachedUsers($user) as $person) {
        $department = trim((string)($person['department'] ?? ''));
        if ($department !== '') $departments[$department] = true;
        $site = trim((string)($person['site'] ?? ''));
        if ($site !== '') $sites[$site] = true;
        $extension = trim((string)($person['user'] ?? ''));
        if ($extension !== '') {
            $agents[$extension] = [
                'extension' => $extension,
                'name' => trim((string)($person['name-first-name'] ?? '') . ' ' . (string)($person['name-last-name'] ?? '')),
                'department' => $department,
                'site' => $site,
            ];
        }
    }
} else {
    if ($user['department'] !== '') $departments[$user['department']] = true;
    if (($user['site'] ?? '') !== '') $sites[$user['site']] = true;
}
/*
 * The queues, for the per-queue service targets screen: id + description is all
 * that editor needs to offer a row per queue.
 */
$queues = [];
foreach (cachedCallQueues($user) as $queue) {
    if (!is_array($queue)) continue;
    $id = trim((string)($queue['callqueue'] ?? ''));
    if ($id === '') continue;
    $queues[] = [
        'id' => $id,
        'description' => trim((string)($queue['description'] ?? '')) ?: $id,
    ];
}
$settings = loadDomainSettings((string)($user['domain'] ?? ''));
$hours = businessHours($settings);
/*
 * The metric catalog rides along: the filter bar is the only call every role
 * makes on every load, so it is the cheapest place to hand the drill-down its
 * vocabulary (QA-8). Keys are metric ids, values carry label/title.
 */
jsonResponse([
    /* PHP converts numeric string array keys to integers; expose names as strings. */
    'departments' => array_map('strval', array_keys($departments)),
    'sites' => array_map('strval', array_keys($sites)),
    'agents' => array_values($agents),
    'queues' => $queues,
    'metrics' => callMetricCatalog(),
    /*
     * Opening hours: the filter bar needs to know whether a calendar exists
     * before it can offer the scope, and the Settings screen needs the stored
     * grid. Both are small, and neither is a secret (the dashboard payload
     * already ships the whole settings object to every role).
     */
    'businessHours' => [
        'enabled' => !empty($hours['enabled']),
        'configured' => businessHoursConfigured($settings),
        'days' => $hours['days'],
        'holidays' => $hours['holidays'],
    ],
]);
