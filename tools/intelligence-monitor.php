<?php
declare(strict_types=1);
/* Invoke from Windows Task Scheduler at the desired interval; never over HTTP. */
if (!in_array(PHP_SAPI, ['cli', 'phpdbg'], true) && !(PHP_SAPI === 'embed' && defined('TEST_TMP'))) { http_response_code(403); exit; }
require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/intelligence.php';
require_once __DIR__ . '/../includes/intelligence-monitor.php';
if (!monitorReady()) { fwrite(STDERR, "Monitor is not configured: check API key, SMTP and recipients.\n"); exit(1); }
$lock = fopen(monitorDirectory() . '/worker.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { fwrite(STDERR, "Monitor is already running.\n"); exit(2); }
$failed = false;
try {
    $client = new PbxClient(trim(INTELLIGENCE_MONITOR_API_KEY), true);
    foreach (glob(monitorDirectory() . '/domain-*.json') ?: [] as $path) {
        try {
            $stored = monitorReadFile($path);
            $domain = (string)($stored['domain'] ?? '');
            if ($domain === '' || basename($path) !== basename(monitorStateFile($domain))) continue;
            $state = monitorState($domain);
            if (empty($state['enabled'])) continue;
            if (empty($state['since']) || empty($state['generation'])) throw new RuntimeException('Invalid monitor state');
            if (!intelligenceWatches($domain)) throw new RuntimeException('No watched phrases; monitoring paused');
            setReportingTimezone(loadDomainSettings($domain)['timezone'] ?? null);
            $tz = reportingTimezone();
            $today = (new DateTimeImmutable('now', $tz))->setTime(0, 0);
            $since = (new DateTimeImmutable('@' . (int)$state['since']))->setTimezone($tz)->setTime(0, 0);
            $cursor = !empty($state['cursor']) ? DateTimeImmutable::createFromFormat('!Y-m-d', (string)$state['cursor'], $tz) : false;
            // Re-read two prior days for late CDRs and the 24-hour retry window.
            $first = ($cursor ?: $since)->modify('-2 days');
            $counts = ['checked' => 0, 'sent' => 0, 'pending' => 0, 'review' => 0, 'unresolved' => 0, 'missingTime' => 0];
            for ($day = $first; $day <= $today; $day = $day->modify('+1 day')) {
                if (empty(monitorState($domain)['enabled'])) break;
                $date = $day->format('Y-m-d');
                [$start, $end] = easternDayWindow($date);
                $batch = $client->fetchCdrs($domain, $start, $end, 0, [], static function (array $rows) use ($client, $domain, $state, &$counts): void {
                    foreach ($rows as $row) monitorProcessCall($client, $domain, $row, $state, $counts);
                });
                if (empty($batch['complete'])) throw new RuntimeException('PBX returned an incomplete CDR page for ' . $date);
                monitorUpdate($domain, static function (array $current) use ($date, $state): array {
                    if (!empty($current['enabled']) && ($current['generation'] ?? null) === ($state['generation'] ?? null) && $date > (string)($current['cursor'] ?? '')) $current['cursor'] = $date;
                    return $current;
                });
            }
            monitorUpdate($domain, static function (array $current) use ($counts, $state): array {
                if (($current['generation'] ?? null) === ($state['generation'] ?? null)) $current['lastRun'] = ['time' => time(), 'counts' => $counts, 'error' => ''];
                return $current;
            });
            echo "Completed monitor scan.\n";
        } catch (Throwable $e) {
            $failed = true;
            appExceptionLog('Intelligence monitor', $e);
            if (!empty($domain)) monitorUpdate($domain, static function (array $current): array { $current['lastRun'] = ['time' => time(), 'error' => 'Scan failed; check server logs.']; return $current; });
            fwrite(STDERR, "Monitor scan failed; check server logs.\n");
        }
    }
} finally { flock($lock, LOCK_UN); fclose($lock); }
exit($failed ? 1 : 0);
