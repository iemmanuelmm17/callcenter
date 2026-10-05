<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
requireMethod('POST');
$user = currentUser();
if ($user['role'] !== 'office_manager') jsonResponse(['error' => 'Not authorized'], 403);
$cleared = clearCache();
auditView($user, [], 'cache-clear');
jsonResponse(['ok' => true, 'cleared' => $cleared]);
