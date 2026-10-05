<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
if (empty($_SESSION['user']) || empty($_SESSION['last_activity'])) {
    jsonResponse(['authenticated' => false]);
}
$user = currentUser(false);
jsonResponse([
    'user' => $user,
    'remaining' => max(0, SESSION_IDLE_SECONDS - (time() - (int)$_SESSION['last_activity'])),
    'warningAt' => SESSION_WARNING_SECONDS,
    'tokenRemaining' => max(0, (int)($_SESSION['token_expires_at'] ?? 0) - time()),
]);
