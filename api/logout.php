<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap.php';
requireMethod('POST'); session_unset(); session_destroy(); jsonResponse(['ok' => true]);
