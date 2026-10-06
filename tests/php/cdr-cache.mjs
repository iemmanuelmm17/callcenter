/**
 * CDR cache backends, end to end through the real PHP.
 *
 * The point of this suite is the switch in includes/config.php: the same
 * endpoints, the same reporting layer, two day-cache backends. It runs the
 * real includes/reporting/cache.php against
 *
 *   - CDR_CACHE_DRIVER='sqlite' with a recording connection double
 *     (tests/php/fixtures/cdr-store-double.php — the runtime here has no
 *     pdo_sqlite, and the SQL itself is proven against real SQLite in
 *     tests/php/cdr-store.mjs), and
 *   - CDR_CACHE_DRIVER='json' with the original day files.
 *
 * What must hold for both:
 *   - the first request fetches the day from the PBX and stores it,
 *   - the second request answers from the cache without touching the PBX,
 *   - a day that is stored incomplete resumes from its nextOffset.
 *
 *   node tests/php/cdr-cache.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT, USERS } from './php.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 500));
  }
};

const FIXTURE = readFileSync(path.join(ROOT, 'tests/php/fixtures/cdr-store-double.php'), 'utf8');
const CLI = readFileSync(path.join(ROOT, 'tools/cdr-cache.php'), 'utf8');
const CDRS = [
  { id: 'call-1', 'call-direction': 1, 'call-start-datetime': '2026-08-02T14:00:00.000Z', 'call-answer-datetime': '2026-08-02T14:00:05.000Z', 'call-term-user': '6080', 'call-orig-from-name': 'Ada Lovelace', 'call-orig-from-user': '+12025550100', 'call-orig-to-user': '6080' },
  { id: 'call-2', 'call-direction': 0, 'call-start-datetime': '2026-08-02T15:30:00.000Z', 'call-term-user': '6081', 'call-orig-user': '6081', 'call-orig-to-user': '+12025550111' },
  { id: 'call-3', 'call-direction': 1, 'call-start-datetime': '2026-08-02T16:45:00.000Z', 'call-term-user': '6080', 'call-orig-from-user': '+12025550122', 'call-orig-to-user': '6080' }
];

const harness = await new PhpHarness();
await harness.boot();
await harness.seedPbx('users', [
  { user: '1000', 'name-first-name': 'Test', 'name-last-name': 'Manager', 'user-scope': 'Office Manager', department: '', site: '', 'login-username': '1000@test.example' },
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6080@test.example' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', 'user-scope': 'User', department: 'Support', site: 'HQ', 'login-username': '6081@test.example' }
]);
await harness.seedPbx('fetchCdrs', CDRS);
await harness.write('includes/cdr-store-double.php', FIXTURE);
/* The CLI lives in tools/ (not deployed, not mirrored), so it is copied into
 * the harness tree to run against the same includes the endpoints load. */
await harness.write('tools/cdr-cache.php', CLI);

/* Which backend the next PHP run uses. The harness reads config.local.php on
 * every request, so this is the switch under test. */
const useDriver = (driver, extra = '') => harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_CACHE_DRIVER', '${driver}');
${extra}
${driver === 'sqlite' ? "require_once __DIR__ . '/cdr-store-double.php';\ndefine('CDR_STORE_CONNECTION_FACTORY', 'cdrStoreDoubleFactory');" : ''}
`);

const phpSnippet = (body) => `<?php
/* The reporting layer is what the endpoints load; the snippet needs it too. */
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$_SESSION['user'] = ['id' => '1', 'name' => 'Test Manager', 'role' => 'office_manager', 'domain' => 'acme.example'];
$user = $_SESSION['user'];
$filters = ['start' => '2026-08-02', 'end' => '2026-08-02'];
function fetchCount(): int {
    $file = TEST_TMP . '/pbx-calls.jsonl';
    if (!is_file($file)) return 0;
    $count = 0;
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (str_contains($line, '"fetchCdrs"')) $count++;
    }
    return $count;
}
$out = [];
${body}
echo json_encode($out);
`;

const run = async (body) => {
  const raw = await harness.script(phpSnippet(body));
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch (error) {
    check('PHP snippet answered JSON', false, raw.slice(0, 600));
    return null;
  }
};

/* ------------------------------------------------------------------ sqlite */
console.log('== sqlite driver (recording connection) ==');
await useDriver('sqlite');
const sqlite = await run(`
$out['driver'] = cdrCacheDriver();
$out['store_available'] = cdrStoreAvailable();
$before = fetchCount();
$rows1 = loadRawCdrs($user, $filters);
$out['fetched'] = fetchCount() - $before;
$out['records_first'] = count($rows1);
$out['journal_inserts'] = CdrStoreDoubleConnection::countStatements('INSERT INTO cdr_records');
$out['journal_days'] = CdrStoreDoubleConnection::countStatements('INSERT INTO cdr_days');
$meta = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['meta'] = $meta;
$out['is_cached'] = cdrDayIsCached($user, '2026-08-02');
$before2 = fetchCount();
$rows2 = loadRawCdrs($user, $filters);
$out['fetched_second_time'] = fetchCount() - $before2;
$out['records_second'] = count($rows2);
$out['second_is_cache_hit'] = array_keys($rows1) === array_keys($rows2) || count($rows2) === count($rows1);

/* A partial day must resume from its nextOffset, appending only the new rows. */
$partial = array_slice($rows1, 0, 2);
cdrDayCacheWrite('acme.example', '2026-08-02', $partial, false, 750, true);
$out['partial_meta'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['partial_read_count'] = count(cdrDayCacheRead('acme.example', '2026-08-02')['records'] ?? []);
$before3 = CdrStoreDoubleConnection::countStatements('INSERT INTO cdr_records');
cdrDayCacheWrite('acme.example', '2026-08-02', $rows1, true, 1500, false);
$out['appended_rows'] = CdrStoreDoubleConnection::countStatements('INSERT INTO cdr_records') - $before3;
$out['resumed_meta'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['range_status'] = cdrRangeCacheStatus($user, '2026-08-02', '2026-08-02');
$out['store_status'] = cdrStoreStatus('acme.example');
$out['json_files'] = count(glob(CACHE_DIR . '/cdr-day-*.json') ?: []);
$out['commits'] = cdrStoreDoubleFactory()->commits;
$out['rollbacks'] = cdrStoreDoubleFactory()->rollbacks;
$out['in_transaction'] = cdrStoreDoubleFactory()->inTransaction;
`);

if (sqlite) {
  check('the sqlite driver is selected when the connection is available', sqlite.driver === 'sqlite' && sqlite.store_available === true);
  check('the first request fetches the day from the PBX', sqlite.fetched === 1 && sqlite.records_first === 3, JSON.stringify({ fetched: sqlite.fetched, records: sqlite.records_first }));
  /* Exactly one insert per record: the page callback stores the day and the
   * final write only refreshes completeness/offset, so a fresh day is never
   * wiped and re-inserted. */
  check('every record is written exactly once', sqlite.journal_inserts === 3, sqlite.journal_inserts);
  check('the day row is written', sqlite.journal_days >= 1, sqlite.journal_days);
  check('the day is stored complete with its record count', sqlite.meta.exists && sqlite.meta.complete && sqlite.meta.records === 3, JSON.stringify(sqlite.meta));
  check('the day counts as cached', sqlite.is_cached === true);
  check('the second request does NOT touch the PBX', sqlite.fetched_second_time === 0, sqlite.fetched_second_time);
  check('the second request returns the same rows', sqlite.records_second === 3, sqlite.records_second);
  check('a partial day is stored as incomplete with its resume offset',
    sqlite.partial_meta.complete === false && sqlite.partial_meta.nextOffset === 750 && sqlite.partial_meta.records === 2,
    JSON.stringify(sqlite.partial_meta));
  check('the partial day is readable', sqlite.partial_read_count === 2, sqlite.partial_read_count);
  check('resuming appends only the new records', sqlite.appended_rows === 1, sqlite.appended_rows);
  check('the resumed day ends complete with every record', sqlite.resumed_meta.complete && sqlite.resumed_meta.records === 3, JSON.stringify(sqlite.resumed_meta));
  check('the range status reports the day ready', sqlite.range_status.ready === 1 && sqlite.range_status.complete === true, JSON.stringify(sqlite.range_status));
  check('the range status names the backend', sqlite.range_status.driver === 'sqlite');
  check('the store summary counts days and records', sqlite.store_status.days === 1 && sqlite.store_status.records === 3, JSON.stringify(sqlite.store_status));
  check('no JSON day file is written while the store is active', sqlite.json_files === 0, sqlite.json_files);
  check('writes are transactional and committed', sqlite.commits >= 3 && sqlite.rollbacks === 0 && sqlite.in_transaction === false, JSON.stringify({ commits: sqlite.commits, rollbacks: sqlite.rollbacks }));
}

console.log('\n== sqlite driver: the endpoints ==');
{
  const before = failures.length;
  const report = await harness.request('report.php', { body: { start: '2026-08-02', end: '2026-08-02' }, user: USERS.office_manager });
  check('report.php answers 200 with the store selected', report.status === 200, JSON.stringify(report.body).slice(0, 200));
  const job = await harness.request('cache_job.php', {
    body: { start: '2026-08-02', end: '2026-08-02', action: 'status' },
    user: USERS.office_manager
  });
  check('cache_job.php reports the driver', job.status === 200 && job.body.driver === 'sqlite', JSON.stringify(job.body).slice(0, 200));
  /* The connection double lives inside one PHP process, so a second request
   * starts from an empty store: what this asserts is the response contract
   * with the store selected, not the cached state. */
  check('cache_job.php answers the full status shape with the store selected',
    job.body.total === 1 && typeof job.body.ready === 'number' && typeof job.body.percent === 'number' && typeof job.body.next === 'string',
    JSON.stringify(job.body).slice(0, 200));
  if (failures.length !== before) console.log('  (see the failures above)');
}

console.log('\n== sqlite driver: a multi-page fetch writes each page once ==');
{
  /* The PBX stub calls the callback once per page with the accumulated list,
   * like the real client does; page 1 replaces the day, page 2 appends. */
  await harness.seedPbx('fetchCdrsPages', [
    [CDRS.slice(0, 2), 250, false],
    [CDRS.slice(2), 500, true]
  ]);
  await useDriver('sqlite');
  const multi = await run(`
$out['records'] = count(loadRawCdrs($user, $filters));
$out['inserts'] = CdrStoreDoubleConnection::countStatements('INSERT INTO cdr_records');
$out['deletes'] = CdrStoreDoubleConnection::countStatements('DELETE FROM cdr_records');
$out['meta'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['is_cached'] = cdrDayIsCached($user, '2026-08-02');
`);
  if (multi) {
    check('both pages end up stored', multi.meta.records === 3 && multi.records === 3, JSON.stringify(multi.meta));
    check('each record is inserted once across pages', multi.inserts === 3, multi.inserts);
    check('the day is replaced by the first page only', multi.deletes === 1, multi.deletes);
    check('the finished day is complete and cached', multi.meta.complete === true && multi.is_cached === true, JSON.stringify(multi.meta));
  }
  await harness.seedPbx('fetchCdrsPages', []);
}

console.log('\n== sqlite driver: an expired day is refetched and replaced ==');
await useDriver('sqlite', "define('CACHE_TTL_SECONDS', 0);");
const stale = await run(`
$out['driver'] = cdrCacheDriver();
$before = fetchCount();
loadRawCdrs($user, $filters);
$out['fetched_cold'] = fetchCount() - $before;
$out['meta_after_cold'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$before2 = fetchCount();
$rows = loadRawCdrs($user, $filters);
$out['fetched_when_stale'] = fetchCount() - $before2;
$out['records'] = count($rows);
$out['meta_after_stale'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['is_cached'] = cdrDayIsCached($user, '2026-08-02');
`);
if (stale) {
  check('the cold fetch stores the day', stale.fetched_cold === 1 && stale.meta_after_cold.records === 3, JSON.stringify(stale.meta_after_cold));
  check('an expired day is fetched again', stale.fetched_when_stale === 1, stale.fetched_when_stale);
  check('the refreshed day does not duplicate its records', stale.meta_after_stale.records === 3 && stale.records === 3,
    JSON.stringify({ records: stale.records, meta: stale.meta_after_stale.records }));
  check('an expired day no longer counts as cached', stale.is_cached === false);
}

/* -------------------------------------------------------------------- json */
console.log('\n== json driver (the original day files) ==');
await useDriver('json');
const json = await run(`
$out['driver'] = cdrCacheDriver();
$before = fetchCount();
$rows1 = loadRawCdrs($user, $filters);
$out['fetched'] = fetchCount() - $before;
$out['records_first'] = count($rows1);
$files = glob(CACHE_DIR . '/cdr-day-*.json') ?: [];
$out['json_files'] = count($files);
$out['json_complete'] = false;
foreach ($files as $file) {
    $cached = readCdrDayCache($file);
    if (is_array($cached) && !empty($cached['complete']) && count($cached['records']) === 3) $out['json_complete'] = true;
}
$before2 = fetchCount();
$rows2 = loadRawCdrs($user, $filters);
$out['fetched_second_time'] = fetchCount() - $before2;
$out['records_second'] = count($rows2);
$out['meta'] = cdrDayCacheMeta('acme.example', '2026-08-02');
$out['range_status'] = cdrRangeCacheStatus($user, '2026-08-02', '2026-08-02');
$out['store_status'] = cdrStoreStatus('acme.example');
`);

if (json) {
  check('the json driver is selected when it is configured', json.driver === 'json', json.driver);
  check('the first request fetches and writes a day file', json.fetched === 1 && json.records_first === 3 && json.json_files === 1, JSON.stringify({ fetched: json.fetched, files: json.json_files }));
  check('the day file holds all three records and is complete', json.json_complete === true);
  check('the second request is served from the day file', json.fetched_second_time === 0 && json.records_second === 3, JSON.stringify({ fetched: json.fetched_second_time, records: json.records_second }));
  check('the metadata reader agrees with the file', json.meta.exists && json.meta.complete && json.meta.records === 3, JSON.stringify(json.meta));
  check('the range status is ready', json.range_status.ready === 1 && json.range_status.driver === 'json', JSON.stringify(json.range_status));
  check('the store is untouched (no connection, no rows)', json.store_status.available === false && json.store_status.days === 0, JSON.stringify(json.store_status));
}

console.log('\n== the operator CLI ==');
{
  const runCli = async (args, driver = 'sqlite') => {
    await useDriver(driver);
    const raw = await harness.script(`<?php
$_SERVER['argv'] = ${JSON.stringify(args)};
$_SERVER['argc'] = ${args.length};
require TEST_TMP . '/tools/cdr-cache.php';
`);
    return raw;
  };

  const status = await runCli(['cdr-cache.php', 'status']);
  check('status prints the driver and the store file', /driver\s+sqlite/.test(status) && /cdrs\.sqlite/.test(status), status.slice(0, 200));
  check('status reports schema version and the json file count', /schema version\s+1/.test(status) && /json day files\s+\d+/.test(status), status.slice(0, 300));

  const help = await runCli(['cdr-cache.php']);
  check('no command prints the usage', /usage:/.test(help) && /import <domain>/.test(help), help.slice(0, 200));

  const refusal = await runCli(['cdr-cache.php', 'import', 'acme.example'], 'json');
  check('import refuses to run while the driver is json', /CDR_CACHE_DRIVER is not "sqlite"/.test(refusal) && /--force/.test(refusal), refusal.slice(0, 200));

  /* With the store reachable (the connection double) the import runs and
   * reports what it did; the JSON day file from the scenario above is the
   * input, which is exactly the migration path an operator follows. */
  const imported = await runCli(['cdr-cache.php', 'import', 'acme.example', '--force']);
  check('import reads the json day files and reports per day',
    /importing \d+ day file\(s\)/.test(imported) && /import \d{4}-\d{2}-\d{2}\s+\d+ records/.test(imported) && /imported \d+ day\(s\), \d+ record\(s\)/.test(imported),
    imported.slice(0, 400));

  const verify = await runCli(['cdr-cache.php', 'verify', 'acme.example']);
  check('verify compares json and store (nothing imported → reported)', /not in the store|json and store agree/.test(verify), verify.slice(0, 300));

  /* Each CLI run is its own process with its own connection double, so the
   * store starts empty here: prune must report zero and skip the vacuum. */
  const prune = await runCli(['cdr-cache.php', 'prune', 'acme.example', '2026-01-01']);
  check('prune on an empty store reports nothing to do and does not vacuum',
    /pruned 0 day\(s\), 0 record\(s\) older than 2026-01-01/.test(prune) && !/vacuum/.test(prune),
    prune.slice(0, 300));

  const pruned = await runCli(['cdr-cache.php', 'prune', 'acme.example', '2026-01-01', '--vacuum']);
  check('--vacuum reclaims space even when nothing was pruned', /vacuum done/.test(pruned), pruned.slice(0, 300));
}

console.log('\n== F2: warming a long range happens in batches ==');
{
  /* A 12-day range with batch=4 must take exactly three warm calls, in date
   * order, and the last one reports the range complete. The batch is what keeps
   * a manager's >31-day range off a one-round-trip-per-day path. */
  await useDriver('json');
  const from = '2026-09-01';
  const to = '2026-09-12';
  const warm = await run(`
$out['batches'] = [];
for ($i = 0; $i < 4; $i++) {
    $status = cdrRangeCacheStatus($user, '${from}', '${to}');
    if (!empty($status['complete'])) break;
    $batch = warmCdrBatch($user, '${from}', '${to}', 4, 20);
    $out['batches'][] = ['warmed' => $batch['warmed'], 'days' => $batch['days'], 'stopped' => $batch['stopped'], 'ready' => $batch['status']['ready'], 'complete' => $batch['status']['complete']];
}
$out['final'] = cdrRangeCacheStatus($user, '${from}', '${to}');
$out['cached_probe'] = cdrDayIsCached($user, '2026-09-03');
`);
  if (warm) {
    check('each batch fills exactly its day budget', warm.batches.length === 3 && warm.batches.every(b => b.warmed === 4), JSON.stringify(warm.batches));
    check('the batches stop on the day budget while work remains',
      warm.batches[0].stopped === 'days' && warm.batches[0].complete === false && warm.batches[1].complete === false,
      JSON.stringify(warm.batches.map(b => b.stopped)));
    check('the batches run in date order and never repeat a day',
      JSON.stringify(warm.batches[0].days) === JSON.stringify(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) &&
      JSON.stringify(warm.batches[2].days) === JSON.stringify(['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']),
      JSON.stringify(warm.batches.map(b => b.days)));
    check('the range is complete after the last batch', warm.final.complete === true && warm.final.pending === 0, JSON.stringify(warm.final));
    check('a warmed day is on the cache afterwards', warm.cached_probe === true, String(warm.cached_probe));

    /* A batch on a complete range is a no-op rather than a re-fetch, and the
     * day budget is clamped to 31. */
    const edges = await run(`
$before = fetchCount();
$clamped = warmCdrBatch($user, '${from}', '${to}', 999, 20);
$out['clamped_warmed'] = $clamped['warmed'];
$out['clamped_stopped'] = $clamped['stopped'];
$out['clamped_complete'] = $clamped['status']['complete'];
$out['fetches'] = fetchCount() - $before;
`);
    if (edges) {
      check('a complete range warms nothing and fetches nothing', edges.clamped_warmed === 0 && edges.fetches === 0 && edges.clamped_stopped === 'complete', JSON.stringify(edges));
    }
  }
}

console.log(`\n${failures.length === 0 ? 'CDR CACHE TESTS OK' : `${failures.length} FAILURE(S): ${failures.join(' | ')}`}`);
process.exit(failures.length ? 1 : 0);
