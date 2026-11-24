<?php
declare(strict_types=1);
/* Installer prerequisite check; never accepts or prints credentials. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
if (PHP_VERSION_ID < 80100) { fwrite(STDERR, "PHP 8.1 or newer is required.\n"); exit(1); }
if (!extension_loaded('curl')) { fwrite(STDERR, "The PHP CLI cURL extension is required.\n"); exit(1); }
if (!extension_loaded('json')) { fwrite(STDERR, "The PHP CLI JSON extension is required.\n"); exit(1); }
echo 'PHP CLI ' . PHP_VERSION . " with cURL and JSON is ready.\n";
