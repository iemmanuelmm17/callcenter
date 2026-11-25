<?php
declare(strict_types=1);
/* Invoke from Windows Task Scheduler at the desired interval; never over HTTP. */
if (!in_array(PHP_SAPI, ['cli', 'phpdbg'], true) && !(PHP_SAPI === 'embed' && defined('TEST_TMP'))) { http_response_code(403); exit; }
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
require_once __DIR__ . '/../includes/intelligence-queue.php';
/** Work due before discovery is attempted first, so a slow scan cannot starve retries. */
function monitorRunDue(PbxClient $client, string $domain, array $state, array &$counts, array &$attempted, bool &$retryFailed): void {
    foreach (monitorQueueDue($domain, $state) as $bucket => $items) {
        foreach ($items as $id => $_) {
            if (isset($attempted[$id])) unset($items[$id]); else $attempted[$id] = true;
        }
        if (!$items) continue;
        $live = monitorState($domain);
        if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null) || monitorRecipients($live) === []) break;
        // Expire even if the CDR no longer appears in the PBX.
        foreach ($items as $id => $item) {
            $live = monitorState($domain);
            if (empty($live['enabled']) || ($live['generation'] ?? null) !== ($state['generation'] ?? null) || monitorRecipients($live) === []) break 2;
            if (time() - (int)$item['ended'] < 86400) continue;
            monitorReviewCdr($domain, ['id' => $id, 'call-start-datetime' => gmdate('c', (int)$item['start'])], monitorExpiryReason((string)($item['lastReason'] ?? '')));
            monitorQueueFinish($domain, $item, 'review'); $counts['review']++; unset($items[$id]);
        }
        if (!$items) continue;
        // Group due calls into bounded call-start windows for fresh CDRs.
        $records = [];
        try {
            $batch = $client->fetchCdrs($domain, gmdate('Y-m-d\\TH:i:s\\Z', (int)$bucket), gmdate('Y-m-d\\TH:i:s\\Z', (int)$bucket + 299), 0, [], null, 1);
            if (empty($batch['complete'])) throw new RuntimeException('PBX returned an incomplete retry window');
        } catch (Throwable $e) {
            appExceptionLog('Intelligence retry window', $e); $retryFailed = true; continue;
        }
        foreach ($batch['records'] as $row) {
            if (!is_array($row)) continue;
            $rowId = (string)($row['id'] ?? '');
            if (isset($items[$rowId]) && (!isset($row['domain']) || (string)$row['domain'] === $domain)) $records[$rowId] = $row;
        }
        $found = [];
        foreach ($records as $call) {
            $id = (string)($call['id'] ?? '');
            if (!isset($items[$id]) || isset($found[$id])) continue;
            $found[$id] = true;
            $before = $counts['pending'];
            $end = parseEasternDateTime((string)($call['call-disconnect-datetime'] ?? ''));
            if (!$end || $end->getTimestamp() > time() || $end->getTimestamp() < (int)$state['since']) {
                $counts['pending']++; monitorQueueFinish($domain, $items[$id], 'pending', 'time'); continue;
            }
            $pendingReason = null;
            monitorProcessCall($client, $domain, $call, $state, $counts, $pendingReason);
            monitorQueueFinish($domain, $items[$id], $counts['pending'] > $before ? 'pending' : 'done', $pendingReason ?? '');
        }
        foreach ($items as $id => $item) if (!isset($found[$id])) { $counts['pending']++; monitorQueueFinish($domain, $item, 'pending', 'cdr'); }
    }
}
if (intelligenceSmtpTimeout() === null) { fwrite(STDERR, "INTELLIGENCE_SMTP_TIMEOUT must be an integer from 1 to 300 seconds.\n"); exit(1); }
if (!monitorReady()) { fwrite(STDERR, "Monitor is not configured.\n"); exit(1); }
$lock = fopen(monitorDirectory() . '/worker.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { fwrite(STDERR, "Monitor is already running.\n"); exit(2); }
$failed = false;
try {
    try { intelligenceRecordingPrune(); } catch (Throwable $e) { appExceptionLog('Expired recording link cleanup', $e); }
    $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
    foreach (glob(monitorDirectory() . '/domain-*.json') ?: [] as $path) {
        $domain = '';
        try {
            $stored = monitorReadFile($path);
            $domain = (string)($stored['domain'] ?? '');
            if ($domain === '' || basename($path) !== basename(monitorStateFile($domain))) continue;
            $state = monitorState($domain);
            if (empty($state['enabled'])) continue;
            if (empty($state['since']) || empty($state['generation'])) throw new RuntimeException('Invalid monitor state');
            setReportingTimezone(loadDomainSettings($domain)['timezone'] ?? null);
            $counts = ['checked' => 0, 'sent' => 0, 'pending' => 0, 'review' => 0, 'unresolved' => 0, 'missingTime' => 0, 'unidentified' => 0];
            $now = time();
            $discoveryFailed = false; $retryFailed = false; $attempted = [];
            if (monitorRecipients($state) !== [] && intelligenceWatches($domain)) {
                monitorRunDue($client, $domain, $state, $counts, $attempted, $retryFailed);
                if ($retryFailed) $failed = true;
            }
            // Always scan the recent configured window first, then the rest of
            // the 24-hour overlap in one-hour pieces. Checkpoint catch-up is
            // separately bounded to four older one-hour windows per run.
            $recentStart = $now - 86400;
            $edge = $now;
            $step = monitorLookbackMinutes() * 60;
            while ($edge > $recentStart) {
                $from = max($recentStart, $edge - $step);
                try {
                    if (!monitorDiscoverWindow($client, $domain, $state, $from, $edge, $now, $counts)) throw new RuntimeException('PBX returned an incomplete discovery window');
                } catch (Throwable $e) {
                    appExceptionLog('Intelligence discovery', $e); $discoveryFailed = true; break;
                }
                $edge = $from;
                $step = 3600;
            }
            $cursor = isset($state['discoveryCursor']) && is_int($state['discoveryCursor'])
                ? $state['discoveryCursor'] : max(0, (int)$state['since'] - 86400);
            $cursor = min($now, max(0, $cursor));
            if (!$discoveryFailed) {
                for ($i = 0; $i < 4 && $cursor < $recentStart; $i++) {
                    $next = min($recentStart, $cursor + 3600);
                    try {
                        if (!monitorDiscoverWindow($client, $domain, $state, $cursor, $next, $now, $counts)) throw new RuntimeException('PBX returned an incomplete catch-up window');
                    } catch (Throwable $e) {
                        appExceptionLog('Intelligence catch-up', $e); $discoveryFailed = true; break;
                    }
                    $cursor = $next;
                    // Commit each completed window, so a crash never skips work.
                    monitorUpdate($domain, static function (array $current) use ($state, $cursor): array {
                        if (!empty($current['enabled']) && ($current['generation'] ?? null) === ($state['generation'] ?? null)) $current['discoveryCursor'] = $cursor;
                        return $current;
                    });
                }
                if (!$discoveryFailed && $cursor >= $recentStart) $cursor = $recentStart;
                monitorUpdate($domain, static function (array $current) use ($state, $cursor): array {
                    if (!empty($current['enabled']) && ($current['generation'] ?? null) === ($state['generation'] ?? null)) $current['discoveryCursor'] = $cursor;
                    return $current;
                });
            }
            if ($discoveryFailed) $failed = true;
            monitorReviewOpenCdrs($domain, $state, $now);
            if (monitorRecipients($state) === []) {
                monitorUpdate($domain, static function (array $current) use ($state, $counts, $discoveryFailed, $cursor, $recentStart): array {
                    if (($current['generation'] ?? null) === ($state['generation'] ?? null) && monitorRecipients($current) === []) $current['lastRun'] = ['time' => time(), 'counts' => $counts, 'catchupSeconds' => max(0, $recentStart - $cursor), 'error' => $discoveryFailed ? 'CDR discovery failed; check server logs. Paused: save alert recipients.' : 'Paused: save alert recipients for this domain.'];
                    return $current;
                });
                echo "Monitor paused: domain alert recipients are not configured.\n";
                continue;
            }
            if (!intelligenceWatches($domain)) throw new RuntimeException('No watched phrases; monitoring paused');
            monitorRunDue($client, $domain, $state, $counts, $attempted, $retryFailed);
            if ($retryFailed) $failed = true;
            monitorUpdate($domain, static function (array $current) use ($counts, $state, $discoveryFailed, $retryFailed, $cursor, $recentStart): array {
                if (($current['generation'] ?? null) === ($state['generation'] ?? null)) $current['lastRun'] = ['time' => time(), 'counts' => $counts, 'catchupSeconds' => max(0, $recentStart - $cursor), 'error' => $discoveryFailed ? ('CDR discovery failed; pending retries were attempted.' . ($retryFailed ? ' Some retry windows also failed.' : '') . ' Check server logs.') : ($retryFailed ? 'Some CDR retry windows failed; check server logs.' : '')];
                return $current;
            });
            echo "Completed monitor scan.\n";
        } catch (Throwable $e) {
            $failed = true;
            appExceptionLog('Intelligence monitor', $e);
            if ($domain !== '') monitorUpdate($domain, static function (array $current): array { $current['lastRun'] = ['time' => time(), 'error' => 'CDR scan failed; check server logs.']; return $current; });
            fwrite(STDERR, "Monitor scan failed; check server logs.\n");
        }
    }
} finally { flock($lock, LOCK_UN); fclose($lock); }
exit($failed ? 1 : 0);
