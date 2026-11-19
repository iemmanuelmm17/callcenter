<?php
declare(strict_types=1);
/* Invoke from Windows Task Scheduler at the desired interval; never over HTTP. */
if (!in_array(PHP_SAPI, ['cli', 'phpdbg'], true) && !(PHP_SAPI === 'embed' && defined('TEST_TMP'))) { http_response_code(403); exit; }
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
require_once __DIR__ . '/../includes/intelligence-queue.php';
if (!monitorReady()) { fwrite(STDERR, "Monitor is not configured.\n"); exit(1); }
$lock = fopen(monitorDirectory() . '/worker.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { fwrite(STDERR, "Monitor is already running.\n"); exit(2); }
$failed = false;
try {
    $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
    foreach (glob(monitorDirectory() . '/domain-*.json') ?: [] as $path) {
        $domain = '';
        try {
            $stored = monitorReadFile($path);
            $domain = (string)($stored['domain'] ?? '');
            if ($domain === '' || basename($path) !== basename(monitorStateFile($domain))) continue;
            $state = monitorState($domain);
            if (empty($state['enabled']) || empty($state['subscriptionId'])) continue;
            if (empty($state['since']) || empty($state['generation'])) throw new RuntimeException('Invalid monitor state');
            if (monitorRecipients($state) === []) {
                monitorUpdate($domain, static function (array $current) use ($state): array {
                    if (($current['generation'] ?? null) === ($state['generation'] ?? null) && monitorRecipients($current) === []) $current['lastRun'] = ['time' => time(), 'error' => 'Paused: save alert recipients for this domain.'];
                    return $current;
                });
                echo "Monitor paused: domain alert recipients are not configured.\n";
                continue;
            }
            if (!intelligenceWatches($domain)) throw new RuntimeException('No watched phrases; monitoring paused');
            setReportingTimezone(loadDomainSettings($domain)['timezone'] ?? null);
            $counts = ['checked' => 0, 'sent' => 0, 'pending' => 0, 'review' => 0, 'unresolved' => 0, 'missingTime' => 0];
            foreach (monitorQueueDue($domain, $state) as $bucket => $items) {
                $live = monitorState($domain);
                if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null) || monitorRecipients($live) === []) break;
                // Expire even if the CDR no longer appears in the PBX.
                foreach ($items as $id => $item) {
                    $live = monitorState($domain);
                    if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null) || monitorRecipients($live) === []) break 2;
                    if (time() - (int)$item['ended'] < 86400) continue;
                    monitorReviewCdr($domain, ['id' => $id, 'call-start-datetime' => gmdate('c', (int)$item['start'])], 'Intelligence or CDR unavailable within 24 hours');
                    monitorQueueFinish($domain, $item, 'review'); $counts['review']++; unset($items[$id]);
                }
                if (!$items) continue;
                // Coalesce queued CDRs into five-minute call-start windows. No
                // report cache and no historical reconciliation scans are used.
                $batch = $client->fetchCdrs($domain, gmdate('Y-m-d\\TH:i:s\\Z', (int)$bucket), gmdate('Y-m-d\\TH:i:s\\Z', (int)$bucket + 299), 0, [], null, 1);
                if (empty($batch['complete'])) throw new RuntimeException('PBX returned an incomplete CDR window');
                $found = [];
                foreach ($batch['records'] as $call) {
                    $id = (string)($call['id'] ?? '');
                    if (!isset($items[$id]) || isset($found[$id])) continue;
                    $found[$id] = true;
                    $before = $counts['pending'];
                    $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
                    if (!$end || $end->getTimestamp() > time() || $end->getTimestamp() < (int)$state['since']) {
                        $counts['pending']++; monitorQueueFinish($domain, $items[$id], 'pending'); continue;
                    }
                    monitorProcessCall($client, $domain, $call, $state, $counts);
                    monitorQueueFinish($domain, $items[$id], $counts['pending'] > $before ? 'pending' : 'done');
                }
                foreach ($items as $id => $item) if (!isset($found[$id])) { $counts['pending']++; monitorQueueFinish($domain, $item, 'pending'); }
            }
            monitorUpdate($domain, static function (array $current) use ($counts, $state): array {
                if (($current['generation'] ?? null) === ($state['generation'] ?? null)) $current['lastRun'] = ['time' => time(), 'counts' => $counts, 'error' => ''];
                return $current;
            });
            echo "Completed monitor queue.\n";
        } catch (Throwable $e) {
            $failed = true;
            appExceptionLog('Intelligence monitor', $e);
            if ($domain !== '') monitorUpdate($domain, static function (array $current): array { $current['lastRun'] = ['time' => time(), 'error' => 'Queue processing failed; check server logs.']; return $current; });
            fwrite(STDERR, "Monitor queue failed; check server logs.\n");
        }
    }
} finally { flock($lock, LOCK_UN); fclose($lock); }
exit($failed ? 1 : 0);
