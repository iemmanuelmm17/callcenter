<?php
declare(strict_types=1);
/* Interactive server administrator recovery for an ambiguous create. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
$domain = $argv[1] ?? '';
if (!is_string($domain) || !preg_match('/^[A-Za-z0-9._-]{1,64}$/', $domain) || !monitorReady()) {
    fwrite(STDERR, "Usage: php tools/intelligence-subscription-recover.php DOMAIN (monitor configuration required)\n"); exit(1);
}
$state = monitorState($domain);
if (empty($state['subscriptionPending'])) { fwrite(STDERR, "No ambiguous subscription creation for this domain.\n"); exit(1); }
echo "Inspect PBX subscriptions first. Enter the matching subscription ID, or type NONE only after confirming there is no subscription: ";
$id = trim((string)fgets(STDIN));
if ($id === '') { fwrite(STDERR, "No change made.\n"); exit(1); }
try {
    if ($id !== 'NONE') {
        $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
        monitorValidateSubscription($client->readCdrSubscription(monitorSubscriptionServer(), $id), $domain, $id);
    }
    monitorUpdate($domain, static function (array $state) use ($id): array {
        if (empty($state['subscriptionPending'])) throw new RuntimeException('State changed; no action taken');
        $state['enabled'] = false; unset($state['subscriptionPending'], $state['activationToken']);
        if ($id !== 'NONE') $state['subscriptionId'] = $id; else unset($state['subscriptionId']);
        return $state;
    });
    echo "Recovery recorded. Enable alerts in the domain report.\n";
} catch (Throwable $e) {
    appExceptionLog('Subscription recovery', $e);
    fwrite(STDERR, "Recovery failed; check server logs. No change was made.\n"); exit(1);
}
