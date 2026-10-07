<?php
declare(strict_types=1);

/**
 * PBX throughput bench.
 *
 *   php tools/pbx-bench.php [domain] [server] --token=<bearer> [--pages=4]
 *
 * Answers the two questions that decide how fast a COLD range can possibly be
 * fetched - and neither can be answered from the code, only from the server:
 *
 *   1. Does the PBX honour a page bigger than 250 records? The fetch loop
 *      treats any short page as "the day ended", so asking for 1000 against a
 *      server that caps at 250 would SILENTLY TRUNCATE a day. This proves the
 *      answer by fetching page 0 twice (once at 250, once at the requested
 *      size) and comparing the ids: the same records for both means capped.
 *
 *   2. How many requests per second does the server actually sustain? It
 *      paces itself at the configured PBX_REQUESTS_PER_SECOND and then at
 *      double, and reports 429s (or any error) so the operator sees the
 *      ceiling instead of being told about it by a timeout later.
 *
 * It prints the config lines for includes/config.local.php at the end.
 *
 * The TOKEN is yours to supply: this is a CLI process with no session, and the
 * PBX only answers a bearer token. Copy the `Authorization: Bearer ...` header
 * of any request the app makes (browser devtools -> Network -> any /ns-api/
 * call), or pass it as PBX_BENCH_TOKEN in the environment so it stays out of
 * the shell history:
 *   set PBX_BENCH_TOKEN=eyJ...
 *   php tools/pbx-bench.php example.com nms1
 *
 * Read-only: it fetches CDR pages and never writes to the cache. It DOES spend
 * real PBX requests, so run it off-peak or on a quiet domain.
 */
if (!defined('STDOUT')) {
    define('STDOUT', fopen('php://stdout', 'wb'));
}
if (!defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}
if (!in_array(PHP_SAPI, ['cli', 'embed', 'phpdbg'], true)) {
    fwrite(STDERR, 'This tool only runs from the command line (SAPI: ' . PHP_SAPI . ").\n");
    exit(2);
}

require_once __DIR__ . '/../includes/reporting.php';

function benchOut(string $line = ''): void
{
    fwrite(STDOUT, $line . "\n");
}

/**
 * Did the server honour the bigger page?
 *
 * Pure so it can be tested without a PBX: same records for both requests means
 * the server capped the page, and a bigger page count means it did not.
 */
function benchPageVerdict(int $requested, int $smallCount, int $largeCount, array $smallIds, array $largeIds): string
{
    if ($requested <= 250) {
        return 'default';
    }
    if ($largeCount > $smallCount) {
        return 'honoured';
    }
    if ($smallCount > 0 && $largeCount === $smallCount && $smallIds === $largeIds) {
        return 'capped';
    }
    return 'inconclusive';
}

$args = [];
$flags = [];
foreach (array_slice($_SERVER['argv'] ?? [], 1) as $arg) {
    $arg = (string)$arg;
    if (str_starts_with($arg, '--')) {
        $flag = substr($arg, 2);
        $value = null;
        if (str_contains($flag, '=')) {
            [$flag, $value] = explode('=', $flag, 2);
        }
        $flags[$flag] = $value;
        continue;
    }
    $args[] = $arg;
}

$servers = defined('PBX_SERVERS') && is_array(PBX_SERVERS) ? PBX_SERVERS : [];
$domain = trim((string)($args[0] ?? ''));
if ($domain === '') {
    $configured = defined('PBX_DOMAIN') ? trim((string)PBX_DOMAIN) : '';
    $domain = $configured !== '' ? $configured : trim((string)(array_key_first($servers) ?? ''));
}
$server = trim((string)($args[1] ?? ''));
$token = trim((string)($flags['token'] ?? getenv('PBX_BENCH_TOKEN') ?: ''));
$pages = (int)($flags['pages'] ?? 4);
if ($pages < 2) {
    $pages = 2;
}
if ($pages > 20) {
    $pages = 20;
}

/* --selftest: the verdict table, with no PBX and no curl - this is what the
 * test suite drives, and it documents the decision without spending requests. */
if (array_key_exists('selftest', $flags)) {
    $cases = [
        ['250 default', 250, 250, 250, ['a'], ['a']],
        ['bigger page honoured', 1000, 250, 1000, ['a'], ['a', 'b']],
        ['server caps at 250', 1000, 250, 250, ['a', 'b'], ['a', 'b']],
        ['inconclusive', 1000, 250, 250, ['a'], ['b']],
    ];
    foreach ($cases as [$label, $requested, $smallCount, $largeCount, $smallIds, $largeIds]) {
        benchOut($label . ': ' . benchPageVerdict($requested, $smallCount, $largeCount, $smallIds, $largeIds));
    }
    exit(0);
}

if (!function_exists('curl_init')) {
    fwrite(STDERR, "error: this PHP has no cURL extension, so the bench cannot talk to the PBX.\n");
    fwrite(STDERR, "       Enable extension=curl in php.ini (XAMPP: C:\\\\xampp\\\\php\\\\php.ini).\n");
    exit(3);
}

if ($domain === '' || $servers === []) {
    fwrite(STDERR, "error: no domain and/or no PBX_SERVERS configured.\n");
    fwrite(STDERR, "usage: php tools/pbx-bench.php <domain> [server] --token=<bearer>\n");
    exit(1);
}
if ($server !== '' && !isset($servers[$server])) {
    fwrite(STDERR, "error: unknown server '{$server}'. Configured: " . implode(', ', array_keys($servers)) . "\n");
    exit(1);
}
if ($token === '') {
    fwrite(STDERR, "error: no bearer token given, so the PBX cannot be asked.\n");
    fwrite(STDERR, "       Copy the Authorization header of any /ns-api/ request the app makes\n");
    fwrite(STDERR, "       (browser devtools -> Network), then either:\n");
    fwrite(STDERR, "         set PBX_BENCH_TOKEN=<token>   (keeps it out of the shell history)\n");
    fwrite(STDERR, "         php tools/pbx-bench.php <domain> [server]\n");
    fwrite(STDERR, "       or pass it directly:\n");
    fwrite(STDERR, "         php tools/pbx-bench.php <domain> [server] --token=<token>\n");
    exit(2);
}

/* The window: yesterday, so it is a closed day with real traffic. */
$date = (new DateTimeImmutable('yesterday', new DateTimeZone(defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'America/New_York')))->format('Y-m-d');
$windowStart = $date . 'T00:00:00Z';
$windowEnd = $date . 'T23:59:59Z';

$requested = PbxClient::pageSize();
$rate = PbxClient::requestsPerSecond();

benchOut('PBX bench — ' . $domain . ' — ' . $date);
benchOut('configured: page size ' . $requested . ', requests/second ' . $rate);
benchOut('');

/*
 * One raw CDR page, timed. The URL, query keys and headers are the same ones
 * PbxClient::fetchCdrs() sends (includes/PbxClient.php) - page 0 of the window
 * is what both sides compare.
 *
 * @return array{ok:bool,count:int,ids:list<string>,ms:int,error:string,server:string}
 */
$page = static function (int $offset, int $limit) use ($servers, $server, $domain, $windowStart, $windowEnd, $token): array {
    $targets = $server !== '' ? [$server => $servers[$server]] : $servers;
    $errors = [];
    foreach ($targets as $name => $base) {
        $url = rtrim((string)$base, '/')
            . '/ns-api/v2/domains/' . rawurlencode($domain) . '/cdrs?'
            . http_build_query([
                'datetime-start' => $windowStart,
                'datetime-end' => $windowEnd,
                'start' => $offset,
                'limit' => $limit,
                'raw' => 'yes',
            ]);
        $started = microtime(true);
        $curl = curl_init($url);
        if ($curl === false) {
            $errors[] = $name . ': curl_init failed';
            continue;
        }
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 60,
            CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'Accept: application/json'],
        ]);
        $body = curl_exec($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        $ms = (int)round((microtime(true) - $started) * 1000);
        if ($body === false || $status >= 400) {
            $errors[] = $name . ': ' . ($error !== '' ? $error : 'HTTP ' . $status);
            continue;
        }
        $data = json_decode((string)$body, true);
        $rows = [];
        if (is_array($data)) {
            foreach ($data as $key => $value) {
                if (is_array($value) && isset($value['id'])) {
                    $rows[] = (string)$value['id'];
                } elseif ($key === 'data' && is_array($value)) {
                    foreach ($value as $inner) {
                        if (is_array($inner) && isset($inner['id'])) {
                            $rows[] = (string)$inner['id'];
                        }
                    }
                }
            }
        }
        if ($rows === []) {
            $errors[] = $name . ': no records parsed (HTTP ' . $status . ')';
            continue;
        }
        return ['ok' => true, 'count' => count($rows), 'ids' => array_slice($rows, 0, 10), 'ms' => $ms, 'error' => '', 'server' => $name];
    }
    return ['ok' => false, 'count' => 0, 'ids' => [], 'ms' => 0, 'error' => implode(' | ', $errors), 'server' => ''];
};

benchOut('== 1. does the server honour a page bigger than 250? ==');
$small = $page(0, 250);
if (!$small['ok']) {
    fwrite(STDERR, 'error: the PBX did not answer the 250-record page: ' . $small['error'] . "\n");
    exit(1);
}
benchOut(sprintf('  250  -> %d records in %d ms', $small['count'], $small['ms']));

$large = $requested > 250 ? $page(0, $requested) : $small;
if ($requested > 250) {
    benchOut(sprintf('  %d -> %d records in %d ms', $requested, $large['count'], $large['ms']));
}

$verdict = benchPageVerdict($requested, $small['count'], $large['count'], $small['ids'], $large['ids']);
benchOut('');
if ($verdict === 'default') {
    benchOut('  CDR_PAGE_SIZE is 250 (the default); raise it in config.local.php and re-run to test a bigger page.');
} elseif ($verdict === 'honoured') {
    benchOut(sprintf('  RESULT: the server honours %d-record pages (%.1fx fewer round trips).', $requested, $large['count'] / max(1, $small['count'])));
} elseif ($verdict === 'capped') {
    benchOut('  RESULT: the server CAPS the page at 250 - it returned the same records for both requests.');
    benchOut('          Leave CDR_PAGE_SIZE at 250: asking for more would look like a short page');
    benchOut('          and end the day early (a silently truncated day).');
} else {
    benchOut('  RESULT: inconclusive (the two pages differ but the larger did not grow).');
    benchOut('          Leave CDR_PAGE_SIZE at 250 unless you can watch a full day import.');
}

benchOut('');
benchOut('== 2. sustained request rate ==');
/*
 * The limiter inside PbxClient paces the app; the bench paces ITSELF instead,
 * so what it measures is the server, not our own limiter.
 */
foreach ([1.0, 2.0] as $factor) {
    $ratePerSecond = $rate * $factor;
    $label = $factor === 1.0 ? 'configured rate' : round($factor, 1) . 'x the configured rate';
    $interval = 1.0 / max(0.5, $ratePerSecond);
    $requests = (int)round($ratePerSecond * $pages);
    $ok = 0;
    $failed = 0;
    $errors = [];
    $started = microtime(true);
    for ($i = 0; $i < $requests; $i++) {
        $target = $started + ($i * $interval);
        $now = microtime(true);
        if ($now < $target) {
            usleep((int)round(($target - $now) * 1000000));
        }
        $result = $page($i * 250, 250);
        if ($result['ok']) {
            $ok++;
        } else {
            $failed++;
            $errors[] = $result['error'];
        }
    }
    $seconds = round(microtime(true) - $started, 2);
    benchOut(sprintf(
        '  %s (%.1f req/s): %d requests in %ss - %d ok, %d failed',
        $label,
        $ratePerSecond,
        $requests,
        $seconds,
        $ok,
        $failed
    ));
    if ($failed > 0) {
        benchOut('    first error: ' . (string)($errors[0] ?? ''));
        benchOut('    -> the server did not sustain this rate; keep PBX_REQUESTS_PER_SECOND at the last clean value.');
        break;
    }
}

benchOut('');
benchOut('== what to put in includes/config.local.php ==');
benchOut(sprintf("define('CDR_PAGE_SIZE', %d);%s", $verdict === 'honoured' ? $requested : 250, $verdict === 'honoured' ? '' : '   // proven to be honoured'));
benchOut("define('PBX_REQUESTS_PER_SECOND', " . (int)$rate . '); // raise only if the burst above stayed clean');
benchOut('');
benchOut('After changing them, import the range you care about once in the browser (the cache');
benchOut('keeps it) and measure the result with: php tools/cdr-timing.php ' . $domain);

fflush(STDOUT);
