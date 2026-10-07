/**
 * CDR speed: the behaviours that make a wide range load quickly.
 *
 * This is the suite for "15 days and up takes too long". It covers the things
 * that made it slow, so they cannot come back:
 *
 *   1. THE NODE JSONL TRAP. A node-client cdr-out file used to WIN over the
 *      day cache and be re-read, re-decoded and re-trimmed on every request -
 *      and because cdrDayIsCached() answered "ready" for it, the warm loop
 *      never imported it. A day is now imported to the cache once.
 *   2. ONE FETCHER PER DAY. The report request and the UI's warm loop both
 *      fetch missing days, at the same time, for the same records.
 *   3. DERIVED VALUES COMPUTED ONCE. ring/wait, the local date and the
 *      disconnect scan are per-row, pure, and were recomputed by every stage.
 *      The parity check here is the guard: the memo must EQUAL a fresh
 *      computation, or a report would publish a stale number.
 *   4. THE THROUGHPUT KNOBS. Page size and requests/second come from config,
 *      clamped, with 250 / 5 as the defaults - and tools/pbx-bench.php is what
 *      proves a bigger page is honoured before anyone raises it.
 *
 *   node tests/php/cdr-speed.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT, USERS } from './php.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

const asJson = (raw, label) => {
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    check(`${label}: PHP answered JSON`, false, String(raw).slice(0, 400));
    return {};
  }
};

const CACHE = readFileSync(path.join(ROOT, 'includes/reporting/cache.php'), 'utf8');
const PBX = readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8');
const FIELDS = readFileSync(path.join(ROOT, 'includes/reporting/cdr_fields.php'), 'utf8');

const harness = await new PhpHarness();
await harness.boot();
await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('REPORTING_MEMORY_HEADROOM_BYTES', 1073741824);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);

/* Three records with every derivation in play: a duration-based ring, a
 * timestamp-based one (no durations - the expensive branch), an unanswered
 * call, and a disconnect reason that only the runtime key scan can find. */
const RECORDS = [
  {
    id: 'sp-1', 'call-direction': 1, 'call-start-datetime': '2026-09-21T09:00:00.000Z',
    'call-answer-datetime': '2026-09-21T09:00:07.000Z', 'call-disconnect-datetime': '2026-09-21T09:04:00.000Z',
    'call-total-duration-seconds': 240, 'call-talking-duration-seconds': 200,
    'call-term-user': '6080', 'call-through-user': '700', 'call-orig-to-user': '700',
    'call-orig-from-user': '+18454259810', 'call-disconnect-reason-text': 'Normal Clearing'
  },
  {
    id: 'sp-2', 'call-direction': 1, 'call-start-datetime': '2026-09-21T10:00:00.000Z',
    'call-ringing-datetime': '2026-09-21T10:00:01.000Z', 'call-answer-datetime': '2026-09-21T10:00:34.000Z',
    'call-disconnect-datetime': '2026-09-21T10:05:00.000Z',
    'call-term-user': '6081', 'call-through-user': '700', 'call-orig-to-user': '700',
    'call-weird-release-blob': 'OVERLOAD'
  },
  {
    id: 'sp-3', 'call-direction': 1, 'call-start-datetime': '2026-09-21T11:00:00.000Z',
    'call-disconnect-datetime': '2026-09-21T11:00:20.000Z',
    'call-term-user': '6080', 'call-through-user': '700', 'call-orig-to-user': '700',
    'call-orig-from-user': '+18454259810'
  }
];

console.log('== a node JSONL day is imported once, then served from the cache ==');
{
  const lines = RECORDS.map(r => JSON.stringify(r)).join('\n') + '\n';
  await harness.write('cdr-out/cdr-2026-09-21.jsonl', lines);
  await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
echo 'ok';
`);

  /* Before: the day is NOT reported as cached (it must not be skipped). */
  const before = asJson(await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
echo json_encode([
  'isCached' => cdrDayIsCached(['domain' => 'test.example'], '2026-09-21'),
  'nodeFileExists' => is_file(nodeCdrDir() . '/cdr-2026-09-21.jsonl'),
]);`), 'before import');
  check('a node-only day is NOT called cached (so the warm loop imports it)',
    before.isCached === false && before.nodeFileExists === true, before);

  /* Warm it: warmCdrDay() imports the file into the day cache. */
  const warmed = asJson(await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$result = warmCdrDay(['domain' => 'test.example'], '2026-09-21');
echo json_encode([
  'result' => $result,
  'isCached' => cdrDayIsCached(['domain' => 'test.example'], '2026-09-21'),
  'cacheFile' => basename(cdrDayCacheFile('test.example', '2026-09-21')),
  'header' => cdrDayCacheReadHeader(cdrDayCacheFile('test.example', '2026-09-21')),
]);`), 'warm');
  check('warming imports the node file instead of declaring the day ready',
    warmed.result?.source === 'node-jsonl' && warmed.result?.records === 3, warmed.result);
  check('the day is in the cache afterwards', warmed.isCached === true, warmed.isCached);
  check('the cache header carries the imported count', warmed.header?.records === 3, warmed.header);

  /* Now remove the node file: the day must still load (proving the request
   * path reads the cache, not the node file). */
  await harness.script(`<?php @unlink(nodeCdrDir() . '/cdr-2026-09-21.jsonl'); echo 'gone';`);
  const after = asJson(await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$rows = loadRawCdrs(['domain' => 'test.example'], ['start' => '2026-09-21', 'end' => '2026-09-21']);
echo json_encode(['loaded' => count($rows), 'ids' => array_column($rows, 'id')]);`), 'after');
  check('the day still loads with the node file gone', after.loaded === 3, after);
  check('and the records are the ones from the node file',
    JSON.stringify((after.ids || []).slice().sort()) === JSON.stringify(['sp-1', 'sp-2', 'sp-3']),
    after.ids);

  /* A report request must not re-parse a node file for a FRESH cached day. */
  await harness.write('cdr-out/cdr-2026-09-21.jsonl', '{ this is not json at all\n');
  const broken = asJson(await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$rows = loadRawCdrs(['domain' => 'test.example'], ['start' => '2026-09-21', 'end' => '2026-09-21']);
echo json_encode(['loaded' => count($rows)]);`), 'broken node file');
  check('a fresh cached day wins over the node file (a broken file cannot break a report)',
    broken.loaded === 3, broken);
}

console.log('\n== one fetcher per day ==');
{
  const out = asJson(await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$out = [];
$first = cdrDayFetchLock('test.example', '2026-09-22');
$out['firstAcquired'] = is_string($first);
$second = cdrDayFetchLock('test.example', '2026-09-22');
$out['secondBlocked'] = $second === null;
cdrDayFetchUnlock($first);
$third = cdrDayFetchLock('test.example', '2026-09-22');
$out['afterRelease'] = is_string($third);
cdrDayFetchUnlock($third);

/* A lock left behind by a request that was killed must not block a day for
 * ever: an old lock is stolen. */
$stale = CACHE_DIR . '/cdr-fetch-' . hash('sha256', 'test.example|2026-09-23') . '.lock';
file_put_contents($stale, '999999');
touch($stale, time() - 3600);
$stolen = cdrDayFetchLock('test.example', '2026-09-23');
$out['staleStolen'] = is_string($stolen);
cdrDayFetchUnlock($stolen);
$out['lockGoneAfterUnlock'] = !is_file($stale);

/* A waiter picks up what the winner stored, instead of fetching it again. */
$_SESSION['token'] = 'test-token';
cdrDayCacheWrite('test.example', '2026-09-24', [['id' => 'w-1', 'call-direction' => 1]], true, 1, true);
$waited = cdrDayWaitForFetcher(['domain' => 'test.example'], '2026-09-24', 500);
$out['waiterGotDay'] = is_array($waited) && count($waited['records'] ?? []) === 1;
$none = cdrDayWaitForFetcher(['domain' => 'test.example'], '2026-09-25', 300);
$out['waiterGivesUp'] = $none === null;
echo json_encode($out);`), 'lock');
  check('the first caller takes the lock', out.firstAcquired === true, out);
  check('a second caller does not get it (it waits or fetches once)', out.secondBlocked === true, out);
  check('releasing makes it available again', out.afterRelease === true, out);
  check('a lock left by a killed request is stolen', out.staleStolen === true, out);
  check('the lock file is gone after an unlock', out.lockGoneAfterUnlock === true, out);
  check('a waiter picks up the day the winner stored', out.waiterGotDay === true, out);
  check('a waiter gives up rather than hang', out.waiterGivesUp === true, out);

  const source = CACHE.slice(CACHE.indexOf('function loadRawCdrs'), CACHE.indexOf('function reportingDateList'));
  check('the range loader takes the lock before fetching a day', /cdrDayFetchLock\(/.test(source), 'no lock in the loader');
  check('the warm path takes the same lock', /cdrDayFetchLock\(/.test(CACHE.slice(CACHE.indexOf('function warmCdrDay'))), 'no lock in warmCdrDay');
}

console.log('\n== derived values are computed once - and equal a fresh computation ==');
{
  const raw = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$rows = json_decode(base64_decode('${Buffer.from(JSON.stringify(RECORDS)).toString('base64')}'), true);
$directory = ['6080' => ['name' => 'Ada', 'serviceCode' => 'user'], '6081' => ['name' => 'Alan', 'serviceCode' => 'user'], '700' => ['name' => 'Support', 'serviceCode' => 'system-queue']];
$queueIds = ['700' => true];

$normalized = normalizeCdrs($rows, $directory);
$out = ['memoKeys' => [], 'parity' => []];
foreach ($normalized as $i => $row) {
    $out['memoKeys'][] = array_values(array_filter(array_keys($row), static fn($k) => in_array($k, ['_localDate', '_ring', '_disconnect'], true)));

    /* The fresh computation: the same row with the memos stripped. */
    $fresh = $row;
    unset($fresh['_localDate'], $fresh['_ring'], $fresh['_disconnect'], $fresh['_type'], $fresh['_agent'], $fresh['_department'], $fresh['_site']);
    $same = [
        'localDate' => callLocalDate($row) === callLocalDate($fresh),
        'ring' => ringSeconds($row) === ringSeconds($fresh),
        'wait' => waitSeconds($row) === waitSeconds($fresh),
        'disconnect' => callDisconnectReason($row) === callDisconnectReason($fresh),
        'type' => callType($row) === callType($fresh),
        'agent' => callAgent($row) === callAgent($fresh),
    ];
    $out['parity'][] = $same;
}
/* The two expensive branches: a duration ring (sp-1) and a timestamp ring
 * (sp-2), plus the unanswered call (sp-3). */
$out['rings'] = array_map(static fn($r) => ringSeconds($r), $normalized);
$out['dates'] = array_map(static fn($r) => callLocalDate($r), $normalized);
$out['disconnects'] = array_map(static fn($r) => callDisconnectReason($r), $normalized);
/* The runtime key scan has to survive the trim AND the memo. */
$trimmed = cdrTrimRecord($normalized[1]);
$out['scanAfterTrim'] = callDisconnectReason($trimmed);
$out['disconnectMemoWasTrimmed'] = isset($trimmed['_disconnect']);
echo json_encode($out);`);
  const out = asJson(raw, 'derive') || {};
  check('every row carries the three derived keys',
    (out.memoKeys || []).length === 3 && out.memoKeys.every(keys => keys.length === 3),
    out.memoKeys);
  check('the memo equals a fresh computation on every row and every accessor',
    (out.parity || []).length === 3 && out.parity.every(p => Object.values(p).every(Boolean)),
    out.parity);
  check('a duration-based ring is derived', out.rings?.[0] === 40, out.rings);
  check('a timestamp-based ring is derived', out.rings?.[1] === 33, out.rings);
  /* An unanswered call has no talk time: its wait is start -> disconnect, the
   * number the abandon buckets are built from. */
  check('an unanswered call waits until the leg ends', out.rings?.[2] === 20, out.rings);
  check('the local date is the Eastern day', (out.dates || []).every(d => d === '2026-09-21'), out.dates);
  check('the disconnect scan still finds a field only the pattern knows',
    out.disconnects?.[1] === 'OVERLOAD', out.disconnects);
  check('and it still finds it after a trim', out.scanAfterTrim === 'OVERLOAD', out.scanAfterTrim);
  check('the disconnect memo survives the trim (it is an "_" key)',
    out.disconnectMemoWasTrimmed === true, out.disconnectMemoWasTrimmed);

  check('normalizeCdrs is where the derivation happens',
    /callDerivedFields\(\$row\)/.test(FIELDS) && /'_disconnect' => callDisconnectReason/.test(FIELDS),
    'derivation is not in normalizeCdrs');
  check('the accessors read the memo first',
    /isset\(\$row\['_disconnect'\]\)/.test(FIELDS)
      && /isset\(\$row\['_ring'\]\)/.test(readFileSync(path.join(ROOT, 'includes/reporting/support.php'), 'utf8')),
    'an accessor ignores the memo');
}

console.log('\n== the throughput knobs are configurable and clamped ==');
{
  /*
   * The endpoint harness swaps PbxClient.php for a recording double, so the
   * REAL class is loaded here under its own name: these two static helpers are
   * pure config reads and must be measured where they actually live.
   */
  await harness.write('includes/pbx-under-test.php', readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8'));
  const knobs = `<?php
require_once TEST_TMP . '/includes/pbx-under-test.php';
echo json_encode([
  'pageSize' => PbxClient::pageSize(),
  'rate' => PbxClient::requestsPerSecond(),
  'configDefault' => defined('CDR_PAGE_SIZE') ? CDR_PAGE_SIZE : null,
]);`;
  const out = asJson(await harness.script(knobs), 'knobs default');
  check('the default page size is 250', out.pageSize === 250, out.pageSize);
  check('the default rate is 5 per second', out.rate === 5.0, out.rate);

  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_PAGE_SIZE', 1000);
define('PBX_REQUESTS_PER_SECOND', 12);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);
  const raised = asJson(await harness.script(knobs), 'knobs raised');
  check('a raised page size is used', raised.pageSize === 1000, raised.pageSize);
  check('a raised rate is used', raised.rate === 12.0, raised.rate);

  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_PAGE_SIZE', 999999);
define('PBX_REQUESTS_PER_SECOND', 500);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);
  const clamped = asJson(await harness.script(knobs), 'knobs clamped');
  check('an absurd page size is clamped', clamped.pageSize === 5000, clamped.pageSize);
  check('an absurd rate is clamped', clamped.rate === 50.0, clamped.rate);

  check('the fetch loop asks for the configured size', /\$pageSize = self::pageSize\(\)/.test(PBX), 'fetchCdrs does not use pageSize()');
  check('the rate limiter uses the configured rate', /1\.0 \/ self::requestsPerSecond\(\)/.test(PBX), 'limiter does not use the configured rate');

  const bench = readFileSync(path.join(ROOT, 'tools/pbx-bench.php'), 'utf8');
  check('the bench refuses web SAPIs', /only runs from the command line/.test(bench));
  check('the bench suggests config lines', /config\.local\.php/.test(bench) && /PBX_REQUESTS_PER_SECOND/.test(bench));
  check('the bench says how to supply the token',
    /PBX_BENCH_TOKEN/.test(bench) && /Authorization/.test(bench), 'no token instructions');
  await harness.write('tools/pbx-bench.php', bench);

  /* The tool writes its diagnosis to STDERR, which php-wasm does not surface
   * to the harness: a guard firing is observable as "no stdout at all", and
   * the message itself is asserted against the source below. */
  const benchRun = (argv, body = '') => harness.script(`<?php
${body.replace(/^\s*<\?php/, '')}
$_SERVER['argv'] = ${JSON.stringify(['pbx-bench.php', ...argv])};
$_SERVER['argc'] = ${argv.length + 1};
require TEST_TMP . '/tools/pbx-bench.php';
`);

  const selftest = String(await benchRun(['--selftest']));
  check('the bench verdict table is right',
    /250 default: default/.test(selftest)
      && /bigger page honoured: honoured/.test(selftest)
      && /server caps at 250: capped/.test(selftest)
      && /inconclusive: inconclusive/.test(selftest),
    selftest);

  const noCurl = String(await benchRun(['test.example', '--token=x']));
  check('without cURL the bench stops before any PBX call instead of fataling',
    !/Fatal error/.test(noCurl) && noCurl.trim() === '' && /has no cURL extension/.test(bench), noCurl.slice(0, 300));

  /* A recording cURL double: the URL it is handed decides the page it returns,
   * so the whole tool runs end to end with no PBX. CAP decides how many records
   * a page holds, whatever the requested limit. */
  const fakeCurl = (cap) => `<?php
function curl_init(string $url) { return ['url' => $url]; }
function curl_setopt_array($h, array $o) { return true; }
function curl_exec(array $h) {
    $query = [];
    parse_str((string)parse_url($h['url'], PHP_URL_QUERY), $query);
    $limit = (int)($query['limit'] ?? 250);
    $count = max(1, min($limit, ${cap}));
    return json_encode(array_map(static fn($i) => ['id' => 'call-' . $i], range(1, $count)));
}
function curl_getinfo(array $h, int $what = 0) { return 200; }
function curl_error(array $h) { return ''; }
function curl_close(array $h) {}
define('CURLOPT_RETURNTRANSFER', 1);
define('CURLOPT_CONNECTTIMEOUT', 2);
define('CURLOPT_TIMEOUT', 3);
define('CURLOPT_ENCODING', 4);
define('CURLOPT_HTTPHEADER', 5);
define('CURLINFO_RESPONSE_CODE', 6);
`;

  const noToken = String(await benchRun(['test.example', 'nms1'], fakeCurl(1000)));
  check('the bench asks for a token rather than guessing one',
    noToken.trim() === '' && /no bearer token given/.test(bench) && /devtools/.test(bench), noToken.slice(0, 300));

  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('REPORTING_MEMORY_HEADROOM_BYTES', 1073741824);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);
}

console.log('\n== the operator timing meter runs ==');
{
  /* The tool the operator runs to measure a slow range on their own server
   * (php tools/cdr-timing.php): it must refuse an un-cached range with the
   * instruction to warm it, and time a cached one stage by stage. */
  await harness.write('tools/cdr-timing.php', readFileSync(path.join(ROOT, 'tools/cdr-timing.php'), 'utf8'));

  const refusal = String(await harness.script(`<?php
$_SERVER['argv'] = ['cdr-timing.php', 'test.example', '2026-09-01', '2026-09-02', '--runs=1'];
$_SERVER['argc'] = 5;
require TEST_TMP . '/tools/cdr-timing.php';
`));
  check('the meter refuses a range that is not cached',
    /Not fully cached/.test(refusal) && /warm/i.test(refusal), refusal.slice(0, 300));
  check('and it names the days to warm', /2026-09-01/.test(refusal), refusal.slice(0, 300));

  const timed = String(await harness.script(`<?php
/* Two cached days, so the meter has something to measure. */
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['user'] = ['id' => '1', 'name' => 'OM', 'role' => 'office_manager', 'domain' => 'test.example'];
cdrDayCacheWrite('test.example', '2026-09-21', json_decode(base64_decode('${Buffer.from(JSON.stringify(RECORDS)).toString('base64')}'), true), true, 3, true);
cdrDayCacheWrite('test.example', '2026-09-22', json_decode(base64_decode('${Buffer.from(JSON.stringify(RECORDS)).toString('base64')}'), true), true, 3, true);
$_SERVER['argv'] = ['cdr-timing.php', 'test.example', '2026-09-21', '2026-09-22', '--runs=2'];
$_SERVER['argc'] = 6;
require TEST_TMP . '/tools/cdr-timing.php';
`));
  check('the meter reports the cache state', /cache:\s+2\/2 days ready/.test(timed), timed.slice(0, 300));
  check('it prints the stage table', /stage/.test(timed) && /run 1/.test(timed) && /run 2/.test(timed), timed.slice(0, 400));
  check('every stage the report runs is timed',
    ['load', 'normalize', 'scope', 'filter', 'summary', 'packQueue', 'packNumbe', 'packQuali', 'encode']
      .every(label => timed.includes(label)), timed.slice(0, 900));
  /* The same call ids on both days are one call: the merge dedupes by identity. */
  check('it reports the calls and the response size', /calls:\s+3/.test(timed) && /response:\s+\d+ KB/.test(timed), timed.slice(-600));
  check('it compares the cold and warm runs', /\(cold\)/.test(timed) && /\(warm\)/.test(timed), timed.slice(-500));
  check('it names the slowest stages', /slowest:/.test(timed), timed.slice(-400));
  check('and it never prints a caller', !/\+18454259810/.test(timed), timed.slice(-400));
}

console.log('\n== a report request over the imported days ==');
{
  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('REPORTING_MEMORY_HEADROOM_BYTES', 1073741824);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);
  const result = await harness.request('report.php', {
    body: { start: '2026-09-21', end: '2026-09-21' },
    user: USERS.office_manager
  });
  const body = result.body?.data ?? result.body ?? {};
  check('the report answers over a day that came from the node file', result.status === 200,
    { status: result.status, body: JSON.stringify(body).slice(0, 300) });
  check('the day is counted once', body.summary?.counts?.total === 3, body.summary?.counts);
  check('two answered inbound and one missed',
    body.summary?.counts?.inbound === 2 && body.summary?.counts?.missed === 1, body.summary?.counts);
  check('the cache status reports the imported day',
    (body.cacheStatus?.ready ?? 0) === 1 && body.cacheStatus?.complete === true, body.cacheStatus);
}

console.log('\n== the bench end to end, against a recording cURL double ==');
{
  /* The endpoint harness swaps PbxClient for a recording double, and the
   * bench needs the real one (pageSize/requestsPerSecond) - so this runs
   * last, with the real class in place. */
  await harness.write('includes/PbxClient.php', readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8'));
  const benchFake = (cap) => `<?php
function curl_init(string $url) { return ['url' => $url]; }
function curl_setopt_array($h, array $o) { return true; }
function curl_exec(array $h) {
    $query = [];
    parse_str((string)parse_url($h['url'], PHP_URL_QUERY), $query);
    $limit = (int)($query['limit'] ?? 250);
    $count = max(1, min($limit, CAP));
    return json_encode(array_map(static fn($i) => ['id' => 'call-' . $i], range(1, $count)));
}
function curl_getinfo(array $h, int $what = 0) { return 200; }
function curl_error(array $h) { return ''; }
function curl_close(array $h) {}
define('CURLOPT_RETURNTRANSFER', 1);
define('CURLOPT_CONNECTTIMEOUT', 2);
define('CURLOPT_TIMEOUT', 3);
define('CURLOPT_ENCODING', 4);
define('CURLOPT_HTTPHEADER', 5);
define('CURLINFO_RESPONSE_CODE', 6);
`;
  const benchWith = (cap, argv) => harness.script(`<?php
${benchFake(cap).replace('CAP', String(cap)).replace(/^\s*<\?php/, '')}
$_SERVER['argv'] = ${JSON.stringify(['pbx-bench.php', ...argv])};
$_SERVER['argc'] = ${argv.length + 1};
require TEST_TMP . '/tools/pbx-bench.php';
`);

  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_PAGE_SIZE', 1000);
define('NODE_CDR_DIR', __DIR__ . '/../cdr-out');
`);
  const capped = String(await benchWith(250, ['test.example', 'nms1', '--token=t']));
  check('a server that caps the page is detected as capped',
    /CAPS the page at 250/.test(capped) && /silently truncated day/.test(capped), capped.slice(0, 600));
  check('and the advice is to keep 250 on such a server',
    /define\('CDR_PAGE_SIZE', 250\)/.test(capped), capped.slice(-400));

  const honoured = String(await benchWith(1000, ['test.example', 'nms1', '--token=t', '--pages=2']));
  check('a server that honours 1000-record pages is detected as honoured',
    /honours 1000-record pages/.test(honoured), honoured.slice(0, 600));
  check('and the advice is to keep 1000 on such a server',
    /define\('CDR_PAGE_SIZE', 1000\)/.test(honoured), honoured.slice(-400));
  check('the bench measures the sustained rate at 1x and 2x with no failures',
    /configured rate/.test(honoured) && /2x the configured rate/.test(honoured)
      && /0 failed/.test(honoured), honoured.slice(-800));
}

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('CDR SPEED OK');
