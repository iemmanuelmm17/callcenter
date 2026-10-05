<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
requireMethod('POST');
$user = currentUser(true);
jsonResponse(['user' => $user, 'remaining' => SESSION_IDLE_SECONDS]);
