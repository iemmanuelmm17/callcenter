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
jsonResponse(['departments' => array_keys($departments)]);
