<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
$user = currentUser();
$departments = [];
if ($user['role'] === 'office_manager') {
    foreach (cachedUsers($user) as $person) {
        $department = trim((string)($person['department'] ?? ''));
        if ($department !== '') $departments[$department] = true;
    }
} elseif ($user['department'] !== '') $departments[$user['department']] = true;
/*
 * The metric catalog rides along: the filter bar is the only call every role
 * makes on every load, so it is the cheapest place to hand the drill-down its
 * vocabulary (QA-8). Keys are metric ids, values carry label/title.
 */
jsonResponse([
    'departments' => array_keys($departments),
    'metrics' => callMetricCatalog(),
]);
