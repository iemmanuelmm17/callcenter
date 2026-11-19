<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
require_once __DIR__ . '/../includes/intelligence-queue.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); echo '{"error":"Method not allowed"}'; exit; }
try {
    $raw = file_get_contents('php://input', false, null, 0, 1048577);
    if (!is_string($raw) || strlen($raw) > 1048576) throw new InvalidArgumentException('Invalid event batch');
    $events = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($events)) throw new InvalidArgumentException('Invalid event batch');
    monitorWebhookEvents((string)($_SERVER['REMOTE_ADDR'] ?? ''), (string)($_SERVER['HTTP_X_CORRELATION_ID'] ?? ''), $events);
    echo '{"accepted":true}';
} catch (DomainException $e) {
    http_response_code(403); echo '{"error":"Event not accepted"}';
} catch (InvalidArgumentException|JsonException $e) {
    http_response_code(400); echo '{"error":"Invalid event batch"}';
} catch (Throwable $e) {
    // Fail closed without exposing subscription details. Storage errors must not
    // be acknowledged as successful; the PBX may retry the batch.
    appExceptionLog('Intelligence webhook', $e);
    http_response_code(503); echo '{"error":"Event not accepted"}';
}
