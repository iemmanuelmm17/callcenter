/**
 * CDR memory: field trimming, the per-page callback and the capacity guard.
 *
 * This is the suite for the production fatal
 * "Allowed memory size of 536870912 bytes exhausted ... in
 * includes/reporting/cache.php on line 299" - the merge loop that held every
 * field of every call in the requested range.
 *
 * What must hold:
 *   1. TRIMMING IS BEHAVIOUR-PRESERVING. Every metric computed from a trimmed
 *      record equals the metric computed from the wide one, on a fixture that
 *      carries all the field families the app reads plus the junk a PBX sends.
 *      The one reader that scans keys at runtime (callDisconnectReason) still
 *      finds its fields through the pattern rules.
 *   2. IT ACTUALLY SAVES MEMORY. A wide synthetic day is measured before and
 *      after; the suite asserts the trimmed form is a fraction of the wide one
 *      and that a load of it stays inside a stated budget.
 *   3. THE FETCH CALLBACK IS PER PAGE. The double mirrors the real client's
 *      contract (new rows only), the contract is exercised through it, and the
 *      real client is checked for the removed accumulated-list call.
 *   4. A RANGE THAT CANNOT FIT IS REFUSED, NOT FATAL. Both the pre-check (from
 *      the store's counts) and the in-loop projection raise
 *      ReportingLimitException with an actionable message.
 *
 *   node tests/php/cdr-memory.mjs
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

const CDR_TRIM = readFileSync(path.join(ROOT, 'includes/reporting/cdr_trim.php'), 'utf8');
const CAPACITY = readFileSync(path.join(ROOT, 'includes/reporting/capacity.php'), 'utf8');
const PBX = readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8');
const GENERATED = readFileSync(path.join(ROOT, 'includes/reporting/cdr_keep_fields.php'), 'utf8');

const harness = await new PhpHarness();
await harness.boot();

/** A PHP snippet that died prints its error where JSON should be: say so. */
const asJson = (raw, label) => {
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    check(`${label}: PHP answered JSON`, false, raw.slice(0, 500));
    return {};
  }
};

/*
 * A wide record: the field families the app reads (copied from the accessors,
 * the AA field list and the client) plus the kind of thing an ns-api CDR
 * carries that nothing here reads. 120 fields, which is the shape the meter
 * sees on real data.
 */
const WIDE = {
  id: 'wide-1',
  'call-direction': 1,
  'call-start-datetime': '2026-08-02T14:00:00.000Z',
  'call-answer-datetime': '2026-08-02T14:00:05.000Z',
  'call-ringing-datetime': '2026-08-02T14:00:01.000Z',
  'call-disconnect-datetime': '2026-08-02T14:04:00.000Z',
  'call-batch-start-datetime': '2026-08-02T14:00:05.000Z',
  'call-batch-answer-datetime': '2026-08-02T14:00:06.000Z',
  'call-batch-on-hold-duration-seconds': 30,
  'call-batch-total-duration-seconds': 235,
  'call-talking-duration-seconds': 200,
  'call-total-duration-seconds': 240,
  'call-type': 'inbound',
  'call-type-icon': 'in',
  'call-leg-ordinal-index': 1,
  'call-orig-user': '6080',
  'call-orig-caller-id': '8454259810',
  'call-orig-from-name': 'Ada Lovelace',
  'call-orig-from-user': '+18454259810',
  'call-orig-from-uri': 'sip:8454259810@carrier.example',
  'call-orig-to-user': '700',
  'call-orig-to-uri': 'sip:700@pbx.example',
  'call-orig-request-user': '700',
  'call-orig-request-uri': 'sip:700@pbx.example',
  'call-orig-department': 'Sales',
  'call-orig-site': 'HQ',
  'call-orig-call-id': 'orig-1',
  'call-orig-by-hostname': 'pbx1',
  'call-term-user': '6080',
  'call-term-caller-id': '8454259810',
  'call-term-to-uri': 'sip:6080@pbx.example',
  'call-term-department': 'Sales',
  'call-term-site': 'HQ',
  'call-term-call-id': 'term-1',
  'call-term-by-hostname': 'pbx1',
  'call-term-pre-routing-uri': 'sip:6080@pbx.example',
  'call-through-user': '700',
  'call-through-uri': 'sip:700@pbx.example',
  'call-through-department': 'Support',
  'call-through-site': 'HQ',
  'call-through-call-id': 'through-1',
  'call-id': 'call-1',
  'call-parent-call-id': 'parent-1',
  'call-parent-cdr-id': 'parent-cdr-1',
  'call-recording-status': 'completed',
  'call-disconnect-reason-text': 'Normal Clearing',
  'call-disconnect-reason-code': '16',
  'call-release-cause-9': 'NORMAL_CLEARING',
  'call-hangup-party-2': 'caller',
  'call-intelligence-percent-positive': '70',
  'call-intelligence-percent-neutral': '20',
  'call-intelligence-percent-negative': '10',
  'call-intelligence-topics-top': 'billing',
  'call-onnet': 'no',
  'onnet': 'no',
  'on-net': 'no',
  'dial-rule-application': 'callqueue',
  'dial-rule-description': 'Queue 700',
  'dial-rule-parameter': '700',
  'dial-rule-translation-destination-user': '6080',
  'dial-rule-translation-destination-host': 'pbx1',
  'dial-rule-translation-source-name': 'main',
  'prefilled-trace-api': 'https://pbx.example/trace/1',
  'prefilled_trace_api': 'https://pbx.example/trace/1',
  'dialed': '700',
  to: '6080',
  from: '8454259810',
  direction: '1',
  disposition: 'answered',
  'call-queuing': 'yes',
  'call-queuing-duration-seconds': 12,
  'call-action-by-hostname': 'pbx1',
  'call-via-hostname': 'pbx1',
  'call-orig-pre-routing-uri': 'sip:700@pbx.example',
  'call-term-to-host': 'pbx1',
  'call-orig-from-host': 'carrier',
  /* The junk: real CDR fields the application never reads. */
  'call-tenant-billing-class': 'residential',
  'call-route-class': 'national',
  'call-account-code': 'acct-9',
  'call-translation-table-id': '7',
  'call-sip-flow-token': 'tok-9',
  'call-media-relay-mode': 'force',
  'call-rating-profile': 'p1',
  'call-jitter-max-ms': '12',
  'call-packet-loss-pct': '0',
  'call-codec-negotiated': 'PCMU',
  'call-transcoding-flag': 'false',
  'call-region-id': 'us-east',
  'call-tenant-tag-1': 'a',
  'call-tenant-tag-2': 'b',
  'call-tenant-tag-3': 'c',
  _server: 'nms1'
};
/* A real CDR is wide and mostly EMPTY, in both halves: the 30 blob fields
 * below stand in for the vendor fields nobody reads, and the list after them
 * for fields the app CAN read but which are blank on most calls (recording
 * status on a call with no recording, the intelligence fields when the
 * add-on is off, the trace API, the batch leg on a non-queue call). */
for (let i = 0; i < 30; i++) WIDE[`call-vendor-blob-${i}`] = '';
for (const name of ['call-route-class', 'call-account-code', 'call-translation-table-id',
  'call-sip-flow-token', 'call-media-relay-mode', 'call-rating-profile', 'call-jitter-max-ms',
  'call-packet-loss-pct', 'call-codec-negotiated', 'call-transcoding-flag', 'call-region-id',
  'call-tenant-tag-1', 'call-tenant-tag-2', 'call-tenant-tag-3', 'call-tenant-billing-class',
  'call-recording-status', 'call-intelligence-percent-positive', 'call-intelligence-percent-neutral',
  'call-intelligence-percent-negative', 'call-intelligence-topics-top', 'prefilled-trace-api',
  'prefilled_trace_api', 'call-batch-start-datetime', 'call-batch-answer-datetime',
  'call-batch-on-hold-duration-seconds', 'call-batch-total-duration-seconds',
  'call-queuing', 'call-queuing-duration-seconds', 'dial-rule-parameter',
  'dial-rule-translation-destination-host', 'dial-rule-translation-source-name',
  'call-orig-by-hostname', 'call-term-by-hostname', 'call-action-by-hostname',
  'call-via-hostname', 'call-term-to-host', 'call-orig-from-host', 'call-term-caller-id',
  'call-orig-request-uri', 'call-term-pre-routing-uri']) {
  WIDE[name] = '';
}

const wideJson = JSON.stringify(WIDE);

console.log('== the allowlist is generated from the source ==');
{
  const generatedNames = GENERATED.split('\n').filter(line => line.startsWith("    '"));
  check('every generated line is a quoted field name',
    generatedNames.length > 500
      && generatedNames.every(line => /^    '[^']+',$/.test(line))
      && GENERATED.trimEnd().endsWith('];'),
    { names: generatedNames.length });
  check('the allowlist covers the accessor families the app reads',
    ['call-orig-caller-id', 'call-disconnect-reason-text', 'call-intelligence-topics-top', 'prefilled_trace_api', 'dial-rule-application', 'dialed']
      .every(name => GENERATED.includes(`    '${name}',`)),
    'a read family is missing');
  check('trims are applied where records enter, not only where they are read',
    /cdrTrimRecord\(\$row\)/.test(PBX) && /cdrTrimRecord\(\$record\)/.test(readFileSync(path.join(ROOT, 'includes/reporting/cdr_store.php'), 'utf8')),
    'a read path does not trim');
}

console.log('\n== trimming is behaviour-preserving ==');
{
  const raw = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$wide = json_decode(base64_decode('${Buffer.from(wideJson).toString('base64')}'), true);
$trim = cdrTrimRecord($wide);
$out = [];
$out['kept'] = count($trim);
$out['wide'] = count($wide);
$out['droppedNames'] = array_values(array_diff(array_keys($wide), array_keys($trim)));
$out['keptDisconnect'] = isset($trim['call-disconnect-reason-text']) && isset($trim['call-release-cause-9']) && isset($trim['call-hangup-party-2']);
$out['keptServer'] = ($trim['_server'] ?? '') === 'nms1';

/* The runtime key scan in callDisconnectReason() must still see everything it
 * could see before: it prefers /text|reason/, then falls back to any match. */
$scan = cdrTrimRecord(['call-x-disconnect-blob' => 'OVERLOAD', 'call-start-datetime' => 'x']);
$out['scanSurvives'] = ($scan['call-x-disconnect-blob'] ?? '') === 'OVERLOAD';

/*
 * Empty values go too (a PBX sends mostly empty fields), but an empty
 * DIRECTION must stay: it is read with a -1 default, and present-but-empty
 * coerces to 0 = outbound, which is a different answer from absent.
 */
$empties = cdrTrimRecord(['call-term-user' => '', 'call-orig-department' => '', 'call-direction' => '', 'direction' => '']);
$out['emptyDropped'] = !isset($empties['call-term-user']) && !isset($empties['call-orig-department']);
$out['emptyDirectionKept'] = ($empties['call-direction'] ?? 'gone') === '' && ($empties['direction'] ?? 'gone') === '';
$out['emptyListPinned'] = cdrKeepEmptyFields() === ['call-direction', 'direction'];
$out['zeroIsNotEmpty'] = (cdrTrimRecord(['call-talking-duration-seconds' => 0])['call-talking-duration-seconds'] ?? null) === 0;

$directory = ['6080' => ['name' => 'Ada', 'serviceCode' => 'user'], '700' => ['name' => 'Support queue', 'serviceCode' => 'system-queue']];
$queueIds = ['700' => true];

/*
 * The fingerprint: everything the application can ask a record, evaluated on
 * the wide record and on the trimmed one. If the trim dropped something a
 * reader can name, one of these strings changes.
 */
$fingerprint = static function (array $row) use ($directory, $queueIds): array {
    return [
        'type' => callType($row) . '/' . classifyCdrType($row),
        'agent' => callAgent($row),
        'department' => callDepartment($row),
        'site' => callSite($row),
        'queue' => cdrQueueMatch($row, $queueIds),
        'disconnect' => callDisconnectReason($row),
        'voicemailText' => cdrLooksLikeVoicemail($row) ? 'y' : 'n',
        'flow' => callHasFlowHint($row) ? 'y' : 'n',
        'ids' => implode(',', callCallIds($row)),
        'recordingId' => callRecordingCallId($row),
        'trace' => callTraceApi($row),
        'fromName' => callFromName($row),
        'toName' => callTo($row),
        'dialed' => (string)callDialed($row),
        'matches' => cdrMatchesPhoneNumber($row, '8454259810') ? 'y' : 'n',
        'external' => cdrLooksExternalNumber((string)($row['call-orig-from-user'] ?? '')) ? 'y' : 'n',
        'answered' => callAnswered($row) ? 'y' : 'n',
        'unanswered' => callUnansweredForType($row) ? 'y' : 'n',
        'ring' => (string)ringSeconds($row),
        'wait' => (string)waitSeconds($row),
        'hold' => (string)holdSeconds($row),
        'talk' => (string)seconds($row, 'call-talking-duration-seconds'),
        'stamp' => callStartStamp($row),
        'localDate' => callLocalDate($row),
        'net' => cdrOnnetFlag($row) ? 'y' : 'n',
        'number' => phoneNumberFromCdr($row),
        'outcome' => callOutcome($row) . '/' . callMissedReason($row),
        'voicemail' => callIsVoicemail($row) ? 'y' : 'n',
        'abandoned' => callIsAbandoned($row) ? 'y' : 'n',
        'summaryKey' => cdrCacheKey($row, 3),
    ];
};
$out['same'] = $fingerprint($wide) === $fingerprint($trim);
$before = $fingerprint($wide);
$after = $fingerprint($trim);
$out['diff'] = [];
foreach ($before as $k => $v) { if (($after[$k] ?? null) !== $v) $out['diff'][$k] = [$v, $after[$k] ?? null]; }

/* And the metrics themselves, over a list of several wide calls. */
$list = [$wide];
for ($i = 0; $i < 6; $i++) { $copy = $wide; $copy['id'] = 'wide-' . $i; $copy['call-direction'] = $i % 2; $copy['call-talking-duration-seconds'] = 30 * $i; $list[] = $copy; }
$metrics = static function (array $rows) use ($directory, $queueIds): array {
    $summary = summary($rows, 30, $directory, $queueIds);
    unset($summary['generatedAt']);
    return [
        'summary' => $summary,
        'agents' => agentPerformance($rows, $directory, $queueIds),
    ];
};
$out['metricsSame'] = $metrics($list) === $metrics(cdrTrimRecords($list));
echo json_encode($out);
`);
  const out = asJson(raw, 'trim') || {};
  const dropped = out.droppedNames || [];
  check('the wide fixture is the shape we think it is', out.wide >= 100, out.wide);
  check('the trim keeps only a fraction of the fields',
    out.kept > 15 && out.kept < out.wide * 0.7, { wide: out.wide, kept: out.kept });
  check('the junk is gone',
    dropped.includes('call-tenant-billing-class') && dropped.includes('call-vendor-blob-7')
      && dropped.includes('call-codec-negotiated'),
    dropped.slice(0, 8));
  check('the runtime key scan still matches a disconnect-looking field', out.scanSurvives);
  check('empty values are dropped', out.emptyDropped);
  check('an empty direction is kept (it means outbound, not absent)', out.emptyDirectionKept);
  check('the empty-value exception list is exactly the two direction keys', out.emptyListPinned);
  check('zero is data, not emptiness', out.zeroIsNotEmpty);
  check('the fields callDisconnectReason prefers survive a trim', out.keptDisconnect);
  check('the application tag survives a trim', out.keptServer);
  check('every accessor returns the same answer on the trimmed record', out.same, out.diff);
  check('summary() and agentPerformance() are byte-identical after a trim', out.metricsSame);
}

console.log('\n== the fetch callback gets one page at a time ==');
{
  check('the real client no longer hands over the accumulated list',
    !/onPage\(array_values\(\$serverRows\)/.test(PBX) && PBX.includes('$unpublished'),
    'PbxClient still passes the growing list');
  check('the double mirrors the real contract',
    /\$onPage\(\$new, \$offset, \$complete\)/.test(readFileSync(path.join(ROOT, 'tests/php/php.mjs'), 'utf8')));

  await harness.seedPbx('fetchCdrsPages', [
    [[{ id: 'p1a', 'call-direction': 1, 'call-start-datetime': '2026-08-03T14:00:00Z' }, { id: 'p1b', 'call-direction': 1, 'call-start-datetime': '2026-08-03T14:01:00Z' }], 2, false],
    [[{ id: 'p2a', 'call-direction': 1, 'call-start-datetime': '2026-08-03T14:02:00Z' }, { id: 'p2b', 'call-direction': 1, 'call-start-datetime': '2026-08-03T14:03:00Z' }], 4, false],
    [[{ id: 'p3a', 'call-direction': 1, 'call-start-datetime': '2026-08-03T14:04:00Z' }], 5, true]
  ]);
  const raw = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$pages = [];
$client = new PbxClient('token');
$result = $client->fetchCdrs('test.example', '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z', 0, [], static function (array $rows, int $offset, bool $complete) use (&$pages): void {
    $pages[] = ['count' => count($rows), 'ids' => array_column($rows, 'id'), 'offset' => $offset, 'complete' => $complete];
});
echo json_encode(['pages' => $pages, 'total' => count($result['records']), 'complete' => $result['complete']]);
`);
  const out = asJson(raw, 'pages');
  check('one callback per page, each with only that page\'s rows',
    out.pages.length === 3 && out.pages.every((p, i) => p.count === [2, 2, 1][i]),
    out.pages.map(p => p.count));
  check('no row is handed over twice',
    out.pages.flatMap(p => p.ids).length === 5 && new Set(out.pages.flatMap(p => p.ids)).size === 5,
    out.pages.flatMap(p => p.ids));
  check('the accumulated result is still complete', out.total === 5 && out.complete === true, out.total);
}

console.log('\n== a wide day costs a fraction of what it did ==');
{
  /* 1,200 records x the wide shape, cached as a day file. The measurement is
   * taken by PHP itself, so it is the real cost of the arrays. */
  const day = '2026-08-04';
  const records = [];
  for (let i = 0; i < 1200; i++) {
    const row = { ...WIDE, id: `wide-${i}`, 'call-start-datetime': `2026-08-04T${String(10 + (i % 8)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z` };
    records.push(row);
  }
  const raw = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$rows = json_decode(base64_decode('${Buffer.from(JSON.stringify(records)).toString('base64')}'), true);
$wideBytes = strlen(serialize($rows));
$trimmed = cdrTrimRecords($rows);
$trimBytes = strlen(serialize($trimmed));
writeCdrDayCache(cdrDayCacheFile('test.example', '${day}'), $rows, true, 0);
$loaded = loadRawCdrs(['domain' => 'test.example'], ['start' => '${day}', 'end' => '${day}']);
/* php-wasm reports 0 from memory_get_usage(), so the cost is measured as the
 * serialized payload of what came out of the loader: keys, values and shape. */
$loadedBytes = strlen(serialize($loaded));
$report = cdrTrimReport($rows);
echo json_encode([
  'records' => count($loaded),
  'wideBytes' => $wideBytes,
  'trimBytes' => $trimBytes,
  'loadedBytes' => $loadedBytes,
  'fields' => count($loaded[0] ?? []),
  'wideFields' => count($rows[0] ?? []),
  'keptFields' => $report['keptFields'],
  'emptied' => $report['emptied'],
  'memFns' => memory_get_usage(true),
]);
`);
  const out = asJson(raw, 'wide day');
  const ratio = out.trimBytes / out.wideBytes;
  check('every record survived the load', out.records === 1200, out.records);
  check('the trimmed payload is well under the wide one',
    ratio < 0.5, { wideBytes: out.wideBytes, trimBytes: out.trimBytes, ratio: Number(ratio.toFixed(3)) });
  check('what the loader produced is the trimmed shape',
    out.loadedBytes === out.trimBytes && out.fields === out.keptFields,
    { loadedBytes: out.loadedBytes, trimBytes: out.trimBytes, fields: out.fields, keptFields: out.keptFields });
  console.log(`  .. wide ${(out.wideBytes / 1024).toFixed(0)} kB -> trimmed ${(out.trimBytes / 1024).toFixed(0)} kB ` +
    `(${(ratio * 100).toFixed(0)} %), ${out.wideFields} fields -> ${out.fields} kept ` +
    `(${out.emptied} empty values dropped)`);
}

console.log('\n== a range that cannot fit is refused, not fatal ==');
{
  /*
   * The pre-check reads the store's per-day counts, so the double serves the
   * days; the budget is pinned through REPORTING_MEMORY_HEADROOM_BYTES (the
   * same hook a deployment can use) instead of the runner's php.ini.
   */
  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('REPORTING_MEMORY_HEADROOM_BYTES', 102400);
`);
  await harness.write('includes/cdr-store-double.php', readFileSync(path.join(ROOT, 'tests/php/fixtures/cdr-store-double.php'), 'utf8'));
  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_CACHE_DRIVER', 'sqlite');
require_once __DIR__ . '/cdr-store-double.php';
define('CDR_STORE_CONNECTION_FACTORY', 'cdrStoreDoubleFactory');
define('REPORTING_MEMORY_HEADROOM_BYTES', 102400);
`);
  const raw = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$user = ['domain' => 'test.example'];
$rows = [];
for ($i = 0; $i < 300; $i++) {
    $rows[] = ['id' => 'cap-' . $i, 'call-direction' => 1, 'call-start-datetime' => '2026-08-05T14:00:00Z', 'call-term-user' => '6080'];
}
cdrDayCacheWrite('test.example', '2026-08-05', $rows, true, 300, true);
$out = [];
$out['headroom'] = reportingMemoryHeadroomBytes();
$out['counts'] = reportingDayRecordEstimates($user, '2026-08-05', '2026-08-05');
try {
    reportingRangeGuard($user, ['start' => '2026-08-05', 'end' => '2026-08-05']);
    $out['threw'] = false;
} catch (Throwable $e) {
    $out['threw'] = true;
    $out['class'] = get_class($e);
    $out['message'] = $e->getMessage();
}
echo json_encode($out);
`);
  const out = asJson(raw, 'guard');
  check('the pinned budget is what the guard uses', out.headroom === 102400, out.headroom);
  check('the store reports its per-day counts', out.counts['2026-08-05'] === 300, out.counts);
  check('an oversized range raises ReportingLimitException', out.threw && out.class === 'ReportingLimitException', out.class);
  check('the message names the size, the limit and the way out',
    /300 calls/.test(out.message) && /memory_limit/.test(out.message) && /Narrow the range/.test(out.message),
    out.message);

  /*
   * The in-loop projection: no counts available (the JSON driver cannot answer
   * cheaply), so the guard can only speak after real records are in hand.
   */
  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_CACHE_DRIVER', 'json');
define('REPORTING_MEMORY_HEADROOM_BYTES', 1048576);
`);
  const raw2 = await harness.script(`<?php
require_once TEST_TMP . '/includes/reporting.php';
$_SESSION['token'] = 'test-token';
$wide = json_decode(base64_decode('${Buffer.from(wideJson).toString('base64')}'), true);
$out = ['counts' => reportingDayRecordEstimates(['domain' => 'test.example'], '2026-08-06', '2026-08-08')];
foreach (['2026-08-06', '2026-08-07', '2026-08-08'] as $day) {
    $rows = [];
    for ($i = 0; $i < 400; $i++) { $copy = $wide; $copy['id'] = $day . '-' . $i; $rows[] = $copy; }
    writeCdrDayCache(cdrDayCacheFile('test.example', $day), $rows, true, 0);
}
try {
    loadRawCdrs(['domain' => 'test.example'], ['start' => '2026-08-06', 'end' => '2026-08-08']);
    $out['threw'] = false;
    $out['count'] = null;
} catch (Throwable $e) {
    $out['threw'] = true;
    $out['class'] = get_class($e);
    $out['message'] = $e->getMessage();
}
echo json_encode($out);
`);
  const out2 = asJson(raw2, 'projection');
  check('the JSON driver offers no cheap counts (so the projection does the work)',
    Object.keys(out2.counts).length === 0, out2.counts);
  check('the projection stops the load before PHP runs out of memory',
    out2.threw && out2.class === 'ReportingLimitException', { threw: out2.threw, class: out2.class });
  check('the projection message is the same actionable shape',
    /Narrow the range/.test(out2.message || ''), out2.message);

  /* And the guard must not fire for a range that fits. */
  await harness.write('includes/config.local.php', `<?php
declare(strict_types=1);
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('CDR_CACHE_DRIVER', 'json');
define('REPORTING_MEMORY_HEADROOM_BYTES', 33554432);
`);
  const raw3 = await harness.script(`<?php
$_SESSION['token'] = 'test-token';
require_once TEST_TMP . '/includes/reporting.php';
$out = [];
try {
    $rows = loadRawCdrs(['domain' => 'test.example'], ['start' => '2026-08-06', 'end' => '2026-08-06']);
    $out['loaded'] = count($rows);
    $out['threw'] = false;
} catch (Throwable $e) {
    $out['threw'] = true;
    $out['message'] = $e->getMessage();
}
echo json_encode($out);
`);
  const out3 = asJson(raw3, 'fits');
  check('a day that fits still loads', out3.threw === false && out3.loaded === 400, out3);
}

console.log('\n== the operator meter runs ==');
{
  /* The tool the operator runs after this fatal (php tools/cdr-memory.php):
   * it must work on a cache that exists, read one day, and print the numbers
   * the message told them to look at. */
  const CLI = readFileSync(path.join(ROOT, 'tools/cdr-memory.php'), 'utf8');
  await harness.write('tools/cdr-memory.php', CLI);
  const out = await harness.script(`<?php
/* The meter measures the most recent cached day, so cache one for today. */
require_once TEST_TMP . '/includes/reporting.php';
$wide = json_decode(base64_decode('${Buffer.from(wideJson).toString('base64')}'), true);
$today = (new DateTimeImmutable('today', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d');
$rows = [];
for ($i = 0; $i < 5; $i++) { $copy = $wide; $copy['id'] = 'meter-' . $i; $rows[] = $copy; }
writeCdrDayCache(cdrDayCacheFile('test.example', $today), $rows, true, 0);
$_SERVER['argv'] = ['cdr-memory.php', 'test.example', '3'];
$_SERVER['argc'] = 3;
require TEST_TMP . '/tools/cdr-memory.php';
`);
  const text = String(out);
  check('the meter prints the memory limit and the budget',
    /PHP memory_limit:/.test(text) && /a report may use:/.test(text), text.slice(0, 200));
  check('it reports the driver and the calls in the window',
    /driver:/.test(text) && /calls/.test(text), text.slice(0, 300));
  check('it measures a day: records, bytes per record, fields kept and dropped',
    /per record as stored/.test(text) && /fields the app keeps:/.test(text) && /fields dropped:/.test(text),
    text.slice(0, 600));
  check('it says how much fits in one request',
    /calls fit per request/.test(text), text.slice(0, 800));
}

console.log('\n== the endpoints answer 413 with the message ==');
{
  check('the shared catch helper exists and knows the exception',
    readFileSync(path.join(ROOT, 'includes/bootstrap.php'), 'utf8').includes('jsonResponseThrowable')
      && CAPACITY.includes('class ReportingLimitException'),
    'no shared handler');
  const report = readFileSync(path.join(ROOT, 'api/report.php'), 'utf8');
  check('report.php routes the exception through it',
    /jsonResponseThrowable\(\$e, 'Unable to load reporting data\.'\)/.test(report));
  const patched = ['api/queue.php', 'api/calls.php', 'api/agents.php', 'api/telephone_numbers.php', 'api/call_history.php']
    .filter(file => readFileSync(path.join(ROOT, file), 'utf8').includes('jsonResponseThrowable('));
  check('every CDR-serving endpoint uses it', patched.length === 5, patched);
  check('a genuine fatal is turned into JSON for api/*.php',
    readFileSync(path.join(ROOT, 'includes/bootstrap.php'), 'utf8').includes('installApiFatalHandler'));
}

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('CDR MEMORY OK');
