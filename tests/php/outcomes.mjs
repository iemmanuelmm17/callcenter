/**
 * Missed / abandoned parity across every report nav.
 *
 * The complaint this suite answers: the Dashboard, Agents, Queues, Telephone
 * Numbers, Auto Attendants, Call history and Alerts each computed "missed" and
 * "abandoned" their own way, so the same call could be abandoned on one screen
 * and missed on another (and the Agents table's Abandoned column was never
 * filled in at all).
 *
 * Two halves:
 *
 *   1. canonical truth table — includes/reporting/outcomes.php run as real PHP
 *      over hand-built CDRs, one case per rule (answer timestamp, batch
 *      timestamp, talking seconds, queue batch leg, queue/AA sniff, directory
 *      service code, voicemail, direction 2, plain no answer);
 *
 *   2. endpoint reconciliation — one synthetic day of 11 calls whose buckets are
 *      known by hand (4 inbound answered, 3 abandoned, 2 voicemail, 1 no
 *      answer, 1 outbound) is pushed through every report endpoint, and each
 *      endpoint must agree with those counts and with every other endpoint.
 *
 *   node tests/php/outcomes.mjs
 */
import { PhpHarness, USERS } from './php.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 500));
  }
};

const D = '2026-08-02';
const at = hhmm => `${D}T${hhmm}:00Z[US/Eastern]`;

/* ------------------------------------------------------------------ fixtures */

const inbound = extra => Object.assign({
  'call-direction': 1,
  'call-start-datetime': at('10:00'),
  'call-orig-user': '8454259810',
  'call-orig-to-user': '8457620002',
  'call-orig-caller-id': '8454259810',
  'call-total-duration-seconds': 60,
  'call-talking-duration-seconds': 0,
}, extra);

const CDRS = [
  /* answered in the queue, 120 s of talk */
  inbound({ id: 'c1', 'call-answer-datetime': at('10:00:05'), 'call-talking-duration-seconds': 120, 'call-term-user': '6080', 'call-through-user': '700', 'call-term-call-id': 'c1-term' }),
  /* queue abandon, batch leg present */
  inbound({ id: 'c2', 'call-start-datetime': at('10:10'), 'call-batch-start-datetime': at('10:10:02'), 'call-term-user': '6080', 'call-through-user': '700' }),
  /* queue abandon, no batch fields — the aggregate-only CDR shape */
  inbound({ id: 'c3', 'call-start-datetime': at('10:20'), 'call-term-user': '6080', 'call-through-user': '700' }),
  /* auto attendant abandon (900 is the system-aa user) */
  inbound({ id: 'c4', 'call-start-datetime': at('10:30'), 'call-term-user': '6080', 'call-through-user': '900' }),
  /* plain no answer */
  inbound({ id: 'c5', 'call-start-datetime': at('10:40'), 'call-term-user': '6080' }),
  /* voicemail by CDR field */
  inbound({ id: 'c6', 'call-start-datetime': at('10:50'), 'call-term-user': '6080', 'call-term-to-uri': 'sip:vm6080@pbx.example' }),
  /* answered with ONLY the batch answer timestamp, plus talk */
  inbound({ id: 'c7', 'call-start-datetime': at('11:00'), 'call-batch-answer-datetime': at('11:00:04'), 'call-talking-duration-seconds': 60, 'call-term-user': '6080', 'call-through-user': '700' }),
  /* voicemail by direction 2 */
  inbound({ id: 'c8', 'call-direction': 2, 'call-start-datetime': at('11:10'), 'call-term-user': '6080' }),
  /* outbound */
  { id: 'c9', 'call-direction': 0, 'call-start-datetime': at('11:20'), 'call-orig-user': '6081', 'call-term-user': '8454259810', dialed: '8454259810', 'call-talking-duration-seconds': 30, 'call-total-duration-seconds': 40, 'call-orig-call-id': 'c9-orig' },
  /* answered with zero talking seconds */
  inbound({ id: 'c10', 'call-start-datetime': at('11:30'), 'call-answer-datetime': at('11:30:03'), 'call-term-user': '6080', 'call-through-user': '700' }),
  /* auto attendant -> agent, answered */
  inbound({ id: 'c11', 'call-start-datetime': at('11:40'), 'call-answer-datetime': at('11:40:06'), 'call-talking-duration-seconds': 45, 'call-term-user': '6081', 'call-through-user': '900', 'prefilled-trace-api': '/ns-api/v2/sipflow?call=c11&amp;leg=1' }),
];

/* Buckets known by hand — the single source of truth every endpoint is compared
 * against. Keep these in step with CDRS above. */
const EXPECT = {
  total: 11,
  inbound: 4,          // c1, c7, c10, c11
  outbound: 1,         // c9
  missed: 6,           // c2..c6, c8
  abandon: 3,          // c2, c3, c4
  voicemail: 2,        // c6, c8
  noanswer: 1,         // c5
  offered: 10,         // inbound + missed
  agent80: { ib: 3, mc: 3, ab: 3, offered: 9 },
};

const harness = await new PhpHarness();
await harness.boot();

/* ------------------------------------------------------- 1. truth table */

const CASES = {
  answerTimestamp: inbound({ 'call-answer-datetime': at('10:00:05'), 'call-term-user': '6080' }),
  batchAnswer: inbound({ 'call-batch-answer-datetime': at('10:00:05'), 'call-term-user': '6080' }),
  talkOnly: inbound({ 'call-talking-duration-seconds': 45, 'call-term-user': '6080' }),
  queueBatch: inbound({ 'call-batch-start-datetime': at('10:00:02'), 'call-term-user': '6080', 'call-through-user': '700' }),
  queueSniff: inbound({ 'call-term-user': '6080', 'call-through-user': '700' }),
  aaSniff: inbound({ 'call-term-user': '6080', 'call-through-user': '900' }),
  ivrApp: inbound({ 'call-term-user': '6080', 'dial-rule-application': 'auto-attend' }),
  voicemailField: inbound({ 'call-term-user': '6080', 'call-term-to-uri': 'sip:vm6080@pbx.example' }),
  voicemailTalk: inbound({ 'call-talking-duration-seconds': 30, 'call-term-user': '6080', 'call-term-to-uri': 'sip:vm6080@pbx.example' }),
  directionTwo: inbound({ 'call-direction': 2, 'call-term-user': '6080' }),
  noAnswer: inbound({ 'call-term-user': '6080' }),
  answeredZeroTalk: inbound({ 'call-answer-datetime': at('10:00:05'), 'call-term-user': '6080' }),
};

await harness.write('outcome-cases.json', JSON.stringify(CASES));

const truthRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$cases = json_decode((string)file_get_contents(TEST_TMP . '/outcome-cases.json'), true);
$directory = ['6080' => ['serviceCode' => ''], '700' => ['serviceCode' => 'system-queue'], '900' => ['serviceCode' => 'system-aa']];
$queueIds = ['700' => true];
$out = [];
foreach ($cases as $name => $row) {
    $out[$name] = [
        'answered' => callAnswered($row),
        'abandoned' => callIsAbandoned($row, $directory, $queueIds),
        'outcome' => callOutcome($row, $directory, $queueIds),
        'reason' => callMissedReason($row, $directory, $queueIds),
        'bucket' => callMissedBucket($row, $directory, $queueIds),
        'type' => classifyCdrType($row, $directory),
    ];
}
echo json_encode($out);
`);

let truth = {};
try {
  const start = truthRaw.indexOf('{');
  truth = JSON.parse(truthRaw.slice(start, truthRaw.lastIndexOf('}') + 1));
} catch {
  console.log('  FAIL could not parse the truth-table output:', truthRaw.slice(0, 600));
  process.exit(1);
}

console.log('\n== canonical outcome rules (includes/reporting/outcomes.php) ==');
const TABLE = [
  ['answerTimestamp', 'answered', 'inbound', false],
  /* the queue leg answer and the talking seconds were invisible to the old classifier */
  ['batchAnswer', 'answered', 'inbound', false],
  ['talkOnly', 'answered', 'inbound', false],
  ['answeredZeroTalk', 'answered', 'inbound', false],
  ['queueBatch', 'abandoned', 'missed', true],
  ['queueSniff', 'abandoned', 'missed', true],
  ['aaSniff', 'abandoned', 'missed', true],
  ['ivrApp', 'abandoned', 'missed', true],
  ['voicemailField', 'voicemail', 'missed', false],
  /* a caller leaving a message talks, but nobody answered the call */
  ['voicemailTalk', 'voicemail', 'missed', false],
  ['directionTwo', 'voicemail', 'missed', false],
  ['noAnswer', 'noanswer', 'missed', false],
];
for (const [name, outcome, type, abandoned] of TABLE) {
  const row = truth[name] || {};
  check(`${name}: outcome=${outcome}`, row.outcome === outcome, row);
  check(`${name}: classifyCdrType=${type}`, row.type === type, row);
  check(`${name}: callIsAbandoned=${abandoned}`, row.abandoned === abandoned, row);
  const reason = outcome === 'answered' ? 'answered' : (outcome === 'abandoned' ? 'abandon' : outcome);
  check(`${name}: missed reason=${reason}`, row.reason === reason, row);
  check(`${name}: bucket never "answered"`, row.bucket !== 'answered', row);
}

const kindsRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
echo json_encode(callOutcomeKinds());
`);
let kinds = [];
try {
  const start = kindsRaw.indexOf('[');
  kinds = JSON.parse(kindsRaw.slice(start, kindsRaw.lastIndexOf(']') + 1));
} catch { /* reported below */ }
check('the outcome vocabulary is answered/abandoned/voicemail/noanswer',
  JSON.stringify(kinds) === JSON.stringify(['answered', 'abandoned', 'voicemail', 'noanswer']), kinds);
check('every truth-table outcome uses the vocabulary',
  Object.values(truth).every(row => kinds.includes(row.outcome)),
  Object.entries(truth).filter(([, row]) => !kinds.includes(row.outcome)).map(([name]) => name));

const abandonCases = TABLE.filter(([, outcome]) => outcome === 'abandoned').map(([name]) => name);
check('abandoned cases all bucket as abandon',
  abandonCases.every(name => truth[name].bucket === 'abandon'),
  abandonCases.map(name => [name, truth[name].bucket]));
check('voicemail cases all bucket as voicemail',
  ['voicemailField', 'voicemailTalk', 'directionTwo'].every(name => truth[name].bucket === 'voicemail'),
  truth.voicemailField);
check('no-answer case buckets as noanswer', truth.noAnswer.bucket === 'noanswer', truth.noAnswer);

/* ------------------------------------------------- 2. endpoint parity */

await harness.seedPbx('users', [
  USERS.office_manager,
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6080@test.example' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', 'user-scope': 'User', department: 'Support', site: 'HQ', 'login-username': '6081@test.example' },
  { user: '700', 'name-first-name': 'Sales', 'name-last-name': 'Queue', 'user-scope': 'User', 'service-code': 'system-queue' },
  { user: '900', 'name-first-name': 'Main', 'name-last-name': 'IVR', 'user-scope': 'User', 'service-code': 'system-aa' },
]);
await harness.seedPbx('callqueues', [{ callqueue: '700', description: 'Sales queue', site: 'HQ', 'callqueue-dispatch-type': 'simultaneous', 'callqueue-count-agents-total': 2 }]);
await harness.seedPbx('callqueueAgents', [{ user: '6080', name: 'Ada Lovelace' }]);
await harness.seedPbx('phonenumbers', [{ phonenumber: '8457620002', 'dial-rule-application': 'to-callqueue', 'dial-rule-parameter': '700', enabled: 'yes' }]);
await harness.seedPbx('archiveCdrs', []);
await harness.seedPbx('fetchCdrs', CDRS);
await harness.seedPbx('autoAttendants', [{ extension: '900', name: 'Main IVR' }]);
await harness.seedPbx('autoAttendantUser', [{ extension: '900', name: 'Main IVR' }]);
await harness.seedPbx('autoAttendant', [{ 'dial-plan': [] }]);
await harness.seedPbx('recording', []);
await harness.seedPbx('sipflowCradle', []);

const user = USERS.office_manager;
const body = { start: D, end: D };
const request = (endpoint, extra = {}) => harness.request(endpoint, { body: { ...body, ...extra }, user });
const count = payload => (Array.isArray(payload?.data) ? payload.data.length : -1);

console.log('\n== report.php (Dashboard) ==');
const report = await request('report.php', { callTypes: { inbound: true, outbound: true, missed: true, onnet: true }, skipPrevious: 1 });
const summary = report.body?.summary || {};
const counts = summary.counts || {};
const breakdown = summary.missedBreakdown || {};
check('report status 200', report.status === 200, report.body);
check('counts.inbound = 4', counts.inbound === EXPECT.inbound, counts);
check('counts.missed = 6', counts.missed === EXPECT.missed, counts);
check('counts.outbound = 1', counts.outbound === EXPECT.outbound, counts);
check('breakdown noanswer = 1', breakdown.noanswer === EXPECT.noanswer, breakdown);
check('breakdown voicemail = 2', breakdown.voicemail === EXPECT.voicemail, breakdown);
check('breakdown abandon = 3', breakdown.abandon === EXPECT.abandon, breakdown);
check('breakdown adds up to counts.missed',
  (breakdown.noanswer || 0) + (breakdown.voicemail || 0) + (breakdown.abandon || 0) === counts.missed,
  breakdown);
check('serviceLevel.offered = inbound + missed',
  summary.serviceLevel?.offered === counts.inbound + counts.missed,
  summary.serviceLevel);

const performance = Array.isArray(report.body?.agentPerformance) ? report.body.agentPerformance : [];
const row80 = performance.find(r => String(r.extension) === '6080') || {};
const sumMc = performance.reduce((n, r) => n + Number(r.mc || 0), 0);
const sumAb = performance.reduce((n, r) => n + Number(r.ab || 0), 0);
check('agent rows carry an ab field', performance.every(r => Object.prototype.hasOwnProperty.call(r, 'ab')), performance[0]);
check('Σ(mc + ab) over agents = counts.missed',
  sumMc + sumAb === counts.missed, { sumMc, sumAb, missed: counts.missed });
check('Σ(ab) over agents = breakdown abandon',
  sumAb === breakdown.abandon, { sumAb, abandon: breakdown.abandon });
check('6080: ib 3, mc 3, ab 3',
  Number(row80.ib) === EXPECT.agent80.ib && Number(row80.mc) === EXPECT.agent80.mc && Number(row80.ab) === EXPECT.agent80.ab,
  row80);
check('6080: offered = ib + mc + ab',
  Number(row80.offered) === EXPECT.agent80.offered, row80.offered);
check('6080: mcRate = (mc + ab) ÷ offered = 66.7',
  Number(row80.mcRate) === 66.7, row80.mcRate);
check('6080: abRate = ab ÷ offered = 33.3',
  Number(row80.abRate) === 33.3, row80.abRate);
check('every agent row: offered = ib + mc + ab',
  performance.every(r => Number(r.offered) === Number(r.ib) + Number(r.mc) + Number(r.ab)),
  performance.map(r => [r.extension, r.offered, r.ib, r.mc, r.ab]));
check('every agent row: mcRate = (mc + ab) ÷ offered',
  performance.every(r => Number(r.offered) === 0 ? true : Number(r.mcRate) === Math.round(100 * (Number(r.mc) + Number(r.ab)) / Number(r.offered) * 10) / 10),
  performance.map(r => [r.extension, r.mcRate]));

console.log('\n== api/agents.php (Agents nav) ==');
const agentRows = (await request('agents.php')).body?.data || [];
const agents80 = agentRows.find(r => String(r.extension) === '6080') || {};
check('agents row carries an ab field', Object.prototype.hasOwnProperty.call(agents80, 'ab'), agents80);
check('agents 6080: mc 3, ab 3',
  Number(agents80.mc) === EXPECT.agent80.mc && Number(agents80.ab) === EXPECT.agent80.ab, agents80);
check('agents Σ(mc + ab) = counts.missed',
  agentRows.reduce((n, r) => n + Number(r.mc || 0) + Number(r.ab || 0), 0) === counts.missed,
  agentRows.map(r => [r.extension, r.mc, r.ab]));
check('agents Σ(ab) = breakdown abandon',
  agentRows.reduce((n, r) => n + Number(r.ab || 0), 0) === breakdown.abandon,
  agentRows.map(r => [r.extension, r.ab]));
const drill80 = await request('calls.php', { metric: 'missed_no_abandon', agent: '6080' });
check('agents Missed cell opens exactly that many calls',
  count(drill80.body) === Number(agents80.mc), { opened: count(drill80.body), cell: agents80.mc });
const drill80ab = await request('calls.php', { metric: 'missed_abandon', agent: '6080' });
check('agents Abandoned cell opens exactly that many calls',
  count(drill80ab.body) === Number(agents80.ab), { opened: count(drill80ab.body), cell: agents80.ab });
check('agents row matches report.php row (mc/ab/ib)',
  agentRows.every(r => {
    const match = performance.find(p => String(p.extension) === String(r.extension));
    return !!match && Number(match.mc) === Number(r.mc) && Number(match.ab) === Number(r.ab) && Number(match.ib) === Number(r.ib);
  }),
  agentRows.map(r => [r.extension, r.mc, r.ab, r.ib]));

console.log('\n== api/calls.php (drill-downs) ==');
const metricCounts = {};
for (const metric of ['total', 'missed', 'missed_abandon', 'missed_noanswer', 'missed_voicemail', 'missed_no_abandon', 'abandoned', 'incoming']) {
  const payload = (await request('calls.php', { metric })).body;
  metricCounts[metric] = count(payload);
}
check('metric total = 11', metricCounts.total === EXPECT.total, metricCounts);
check('metric missed = 6', metricCounts.missed === EXPECT.missed, metricCounts);
check('metric missed_abandon = 3', metricCounts.missed_abandon === EXPECT.abandon, metricCounts);
check('metric missed_noanswer = 1', metricCounts.missed_noanswer === EXPECT.noanswer, metricCounts);
check('metric missed_voicemail = 2', metricCounts.missed_voicemail === EXPECT.voicemail, metricCounts);
check('metric abandoned = 3', metricCounts.abandoned === EXPECT.abandon, metricCounts);
check('metric incoming = offered = 10', metricCounts.incoming === EXPECT.offered, metricCounts);
check('missed buckets add up to missed',
  metricCounts.missed_abandon + metricCounts.missed_noanswer + metricCounts.missed_voicemail === metricCounts.missed,
  metricCounts);
check('metric missed_no_abandon = 3 (the Agents Missed column)',
  metricCounts.missed_no_abandon === EXPECT.agent80.mc, metricCounts);
check('metric missed_no_abandon + abandoned = missed',
  metricCounts.missed_no_abandon + metricCounts.abandoned === metricCounts.missed, metricCounts);

/*
 * ---------------------------------------------------------------------------
 * The list behind ONE clicked item.
 *
 * Every figure in the UI opens a call list; the list is only honest if its
 * filters are the ones the figure was computed with. These checks pin the
 * three ways that used to drift: a row opened "its type" instead of itself,
 * a queue metric counted calls that never reached a queue, and an interval
 * opened the whole hour.
 * ---------------------------------------------------------------------------
 */
console.log('\n== api/calls.php (one call) ==');
const byId = (await request('calls.php', { callId: 'c1' })).body;
check('callId returns exactly that call',
  count(byId) === 1 && String(byId.data?.[0]?.id) === 'c1', byId?.data?.map(r => r.id));
const byLegId = (await request('calls.php', { callId: 'c1-term' })).body;
check('callId matches a leg id (term) as well as the row id',
  count(byLegId) === 1 && String(byLegId.data?.[0]?.id) === 'c1', byLegId?.data?.map(r => r.id));
const byOrigId = (await request('calls.php', { callId: 'c9-orig' })).body;
check('callId matches a leg id (orig) for an outbound call',
  count(byOrigId) === 1 && String(byOrigId.data?.[0]?.id) === 'c9', byOrigId?.data?.map(r => r.id));
check('an unknown callId returns nothing, not everything',
  count((await request('calls.php', { callId: 'nope' })).body) === 0);

const row1 = byId.data?.[0] || {};
const ATTACH_FIELDS = ['id', 'hasRecordingHint', 'hasFlowHint', 'recordingCallId', 'recordingUser', 'traceApi', 'servers', 'disconnectedAt'];
check('a drill-down row carries the identity + attachment fields the columns read',
  ATTACH_FIELDS.every(k => Object.prototype.hasOwnProperty.call(row1, k)),
  ATTACH_FIELDS.filter(k => !Object.prototype.hasOwnProperty.call(row1, k)));
check('the recording hint points at the term leg of an inbound call',
  row1.hasRecordingHint === true && row1.recordingCallId === 'c1-term' && row1.recordingUser === '6080', row1);
const allRows = (await request('calls.php', { metric: 'total' })).body?.data || [];
const row9 = allRows.find(r => String(r.id) === 'c9') || {};
check('the recording hint points at the orig leg of an outbound call',
  row9.recordingCallId === 'c9-orig' && row9.recordingUser === '6081', row9);
check('a call with no recording leg says so',
  row9.hasRecordingHint === true && (allRows.find(r => String(r.id) === 'c5') || {}).hasRecordingHint === false,
  allRows.map(r => [r.id, r.hasRecordingHint]));
const row11 = allRows.find(r => String(r.id) === 'c11') || {};
check('the flow hint comes from the prefilled trace url, entities decoded',
  row11.hasFlowHint === true && row11.traceApi === '/ns-api/v2/sipflow?call=c11&leg=1', row11.traceApi);

console.log('\n== api/calls.php (the window inside an hour) ==');
const hour10 = (await request('calls.php', { metric: 'incoming', hour: 10 })).body?.data || [];
const window10 = (await request('calls.php', { metric: 'incoming', hour: 10, timeFrom: '10:00', timeTo: '10:15' })).body?.data || [];
check('the 10:00 hour holds 6 inbound calls', hour10.length === 6, hour10.map(r => r.id));
check('the 10:00–10:15 window holds only the 2 that started in it',
  window10.map(r => String(r.id)).sort().join(',') === 'c1,c2', window10.map(r => [r.id, r.time]));
check('the window is a strict subset of the hour', window10.length < hour10.length);
check('every returned call starts inside the window',
  window10.every(r => ['10:00 AM', '10:10 AM'].includes(r.time)), window10.map(r => r.time));
check('a window with an unparseable end is ignored, not emptied',
  count((await request('calls.php', { timeFrom: 'abc', timeTo: '10:15' })).body) === EXPECT.total);
check('a zero-length window is ignored, not emptied',
  count((await request('calls.php', { timeFrom: '10:00', timeTo: '10:00' })).body) === EXPECT.total);
check('a window that wraps past midnight is accepted',
  count((await request('calls.php', { timeFrom: '23:50', timeTo: '00:10' })).body) === 0);

console.log('\n== api/queue.php (Queues nav) ==');
const queueData = (await request('queue.php')).body?.data || {};
const qOutcomes = queueData.outcomes || {};
const qStats = Array.isArray(queueData.queueStats) ? queueData.queueStats : [];
const q700 = qStats.find(q => String(q.callqueue) === '700') || {};
const queueScopedAbandon = count((await request('calls.php', { metric: 'abandoned', queue: '700' })).body);
const queueScopedOffered = count((await request('calls.php', { metric: 'queue_offered', queue: '700' })).body);
check('queue 700 answered = 3', qOutcomes.answered === 3, qOutcomes);
check('queue 700 abandoned = 2 (not 1)',
  qOutcomes.abandoned === 2, qOutcomes);
check('queue 700 missed = 0', qOutcomes.missed === 0, qOutcomes);
check('queue outcomes add up to the 5 queue calls',
  qOutcomes.answered + qOutcomes.abandoned + qOutcomes.missed === 5, qOutcomes);
check('queue table offered = answered + abandoned', q700.offered === (q700.handled + q700.abandoned), q700);
check('queue table abandoned matches the KPI', q700.abandoned === qOutcomes.abandoned, [q700.abandoned, qOutcomes.abandoned]);
check('queue abandonRate = abandoned ÷ offered = 40', Number(queueData.kpis?.abandonRate) === 40, queueData.kpis);
check('queue abandoned = calls.php queue-scoped abandoned',
  qOutcomes.abandoned === queueScopedAbandon, [qOutcomes.abandoned, queueScopedAbandon]);
check('queue offered = calls.php queue-scoped offered',
  (qOutcomes.answered + qOutcomes.abandoned) === queueScopedOffered,
  [qOutcomes.answered + qOutcomes.abandoned, queueScopedOffered]);

/*
 * queue_abandoned / queue_offered are QUEUE metrics: they are counted over the
 * calls that reached a queue, so the same metric without an explicit queue
 * still has to mean the same thing. Before this, asking for them unscoped fell
 * back to the dashboard rule and picked up the auto-attendant abandon too,
 * which is not a queue call and is not in the Queues nav's totals.
 */
const queueStagedAbandon = count((await request('calls.php', { metric: 'queue_abandoned' })).body);
const queueStagedOffered = count((await request('calls.php', { metric: 'queue_offered' })).body);
check('queue_abandoned without a queue = the Queues nav abandoned figure',
  queueStagedAbandon === qOutcomes.abandoned, [queueStagedAbandon, qOutcomes.abandoned]);
check('queue_offered without a queue = answered + abandoned',
  queueStagedOffered === qOutcomes.answered + qOutcomes.abandoned,
  [queueStagedOffered, qOutcomes.answered, qOutcomes.abandoned]);
check('a queue metric does not absorb the auto-attendant abandon',
  metricCounts.abandoned === EXPECT.abandon && queueStagedAbandon === EXPECT.abandon - 1,
  [metricCounts.abandoned, queueStagedAbandon]);

console.log('\n== api/aa.php (Auto Attendants nav) ==');
const aaCalls = (await request('aa.php')).body?.data?.calls || [];
const aaById = Object.fromEntries(aaCalls.map(c => [String(c.id), c]));
check('AA report keeps both attendant calls', aaCalls.length === 2, aaCalls.map(c => c.id));
check('AA answered call is not abandoned', aaById.c11 && aaById.c11.abandoned === false, aaById.c11);
check('AA unanswered call is abandoned', aaById.c4 && aaById.c4.abandoned === true, aaById.c4);
check('AA abandoned count = 1', aaCalls.filter(c => c.abandoned === true).length === 1, aaCalls.map(c => [c.id, c.abandoned]));

console.log('\n== api/call_history.php (Call history nav) ==');
const histRows = (await request('call_history.php')).body?.data || [];
const byOutcome = histRows.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {});
check('history abandon rows = 3', byOutcome.abandoned === EXPECT.abandon, byOutcome);
check('history missed rows = 3 (6 missed minus 3 abandoned)',
  byOutcome.missed === counts.missed - EXPECT.abandon, byOutcome);
check('history abandoned + missed = counts.missed',
  (byOutcome.abandoned || 0) + (byOutcome.missed || 0) === counts.missed, byOutcome);
check('history answered rows = 5 (4 inbound + 1 outbound)', byOutcome.answered === 5, byOutcome);
check('history rows = 11', histRows.length === EXPECT.total, histRows.length);
check('history call-level abandoned verdict matches the controller',
  (histRows.find(r => String(r.id) === 'c4') || {}).outcome === 'abandoned'
  && (histRows.find(r => String(r.id) === 'c3') || {}).outcome === 'abandoned'
  && (histRows.find(r => String(r.id) === 'c10') || {}).outcome === 'answered',
  histRows.map(r => [r.id, r.outcome]));

console.log('\n== api/alerts.php (Alerts / settings limits) ==');
const alertItems = (await request('alerts.php')).body?.data?.items || [];
const alertQueue = alertItems.find(i => i.kind === 'queue' && String(i.id) === '700') || {};
const alertAgent = alertItems.find(i => i.kind === 'user' && String(i.id) === '6080') || {};
const round1 = n => Math.round(n * 10) / 10;
check('alerts queue missed % uses the canonical missed count',
  alertQueue.missedPct === round1(100 * (qOutcomes.missed + qOutcomes.abandoned) / (qOutcomes.answered + qOutcomes.abandoned)),
  [alertQueue.missedPct, qOutcomes]);
check('alerts queue abandon % matches queue.php',
  alertQueue.abandonPct === round1(100 * qOutcomes.abandoned / (qOutcomes.answered + qOutcomes.abandoned)),
  [alertQueue.abandonPct, qOutcomes]);
check('alerts agent missed % matches the Agents table',
  alertAgent.missedPct === round1(100 * (Number(agents80.mc) + Number(agents80.ab)) / (Number(agents80.ib) + Number(agents80.mc) + Number(agents80.ab))),
  [alertAgent.missedPct, agents80.mc, agents80.ab]);
check('alerts agent abandon % matches the Agents table',
  alertAgent.abandonPct === round1(100 * Number(agents80.ab) / (Number(agents80.ib) + Number(agents80.mc) + Number(agents80.ab))),
  [alertAgent.abandonPct, agents80.ab]);
check('every alert row keeps abandon ≤ missed',
  alertItems.every(i => Number(i.abandonPct) <= Number(i.missedPct)),
  alertItems.map(i => [i.kind, i.id, i.missedPct, i.abandonPct]));
check('every alert row reports a percentage of its own offered volume',
  alertItems.every(i => Number(i.missedPct) >= 0 && Number(i.missedPct) <= 100 && Number(i.abandonPct) >= 0 && Number(i.abandonPct) <= 100),
  alertItems);

console.log('\n== api/telephone_numbers.php (Telephone Numbers nav) ==');
const tnData = (await request('telephone_numbers.php')).body?.data || {};
const tnSummary = tnData.summary || {};
const tnNumber = (tnData.numbers || [])[0] || {};
check('TN summary inbound = 4', tnSummary.totalInbound === EXPECT.inbound, tnSummary);
check('TN summary missed = 6', tnSummary.totalMissed === EXPECT.missed, tnSummary);
check('TN summary missed matches counts.missed',
  tnSummary.totalMissed === counts.missed && tnSummary.totalInbound === counts.inbound, tnSummary);
check('TN number card inbound = 4, missed = 6',
  tnNumber.calls?.inbound === EXPECT.inbound && tnNumber.calls?.missed === EXPECT.missed, tnNumber.calls);
check('TN number card total = inbound + missed',
  tnNumber.calls?.total === EXPECT.inbound + EXPECT.missed, tnNumber.calls);

/* The Simultaneous Calls tab of the same nav derives its volume from the same
 * classifier, so its inbound/missed must match the Dashboard too. */
const simData = (await request('simultaneous_calls.php')).body?.data || {};
const simSummary = simData.summary || {};
check('simultaneous calls missed matches counts.missed',
  simSummary.missed === counts.missed, simSummary);
check('simultaneous calls total = inbound + missed',
  simSummary.totalCalls === EXPECT.offered, simSummary);

/*
 * An interval row is a window, and its drill-down has to be that window: the
 * bucket's own `started` count is the number of inbound/missed calls that
 * began inside it, so the call list for the same window must match it exactly
 * (this is what the modal now sends as timeFrom/timeTo).
 */
const simIntervals = Array.isArray(simData.intervals) ? simData.intervals : [];
const busiestInterval = simIntervals.slice().sort((a, b) => Number(b.started || 0) - Number(a.started || 0))[0] || null;
const intervalCalls = busiestInterval
  ? (await request('calls.php', {
      metric: 'incoming',
      timeFrom: busiestInterval.time,
      timeTo: busiestInterval.endTime
    })).body?.data || []
  : [];
check('the busiest interval has calls in it', !!busiestInterval && Number(busiestInterval.started) > 0, busiestInterval);
check('an interval drill opens exactly the calls that started in that interval',
  !!busiestInterval && intervalCalls.length === Number(busiestInterval.started),
  { interval: busiestInterval, opened: intervalCalls.map(r => r.time) });
check('an interval drill keeps every call inside the interval',
  !!busiestInterval && intervalCalls.every(r => {
    const minute = String(r.time || '').match(/^(\d{1,2}):(\d{2})/);
    if (!minute) return false;
    const m = (Number(minute[1]) % 12 + (/PM/.test(r.time) ? 12 : 0)) * 60 + Number(minute[2]);
    const from = busiestInterval.time.split(':').reduce((n, v) => n * 60 + Number(v), 0);
    const to = busiestInterval.endTime.split(':').reduce((n, v) => n * 60 + Number(v), 0);
    return m >= from && m < to;
  }),
  intervalCalls.map(r => r.time));

/*
 * The DID card figures are inbound + missed calls to that number, so the
 * number's own drill-down list has to be that many rows.
 */
const tnDrill = (await request('calls.php', { phoneNumber: String(tnNumber.number || ''), metric: 'incoming' })).body?.data || [];
check('a DID drill opens exactly the number card total',
  tnDrill.length === Number(tnNumber.calls?.total || 0),
  { opened: tnDrill.length, card: tnNumber.calls });

/* --------------------------------------- 3. no second copy of the rules */

console.log('\n== one definition, no leftovers ==');
const { readFileSync, readdirSync } = await import('node:fs');
const path = await import('node:path');
const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const phpFiles = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith('.php')) phpFiles.push(full);
  }
};
for (const dir of ['includes', 'includes/reporting', 'api']) walk(path.join(ROOT, dir));
const stripped = file => readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
check('no call site uses the removed missedKind()',
  phpFiles.every(file => !/(?<![A-Za-z_])missedKind\s*\(/.test(stripped(file))),
  phpFiles.filter(file => /(?<![A-Za-z_])missedKind\s*\(/.test(stripped(file))));
check('no endpoint re-derives the abandoned rule from call-batch-start-datetime',
  phpFiles.every(file => !/!\s*\$\w*[Aa]nswer\w*\s*&&\s*\$\w*[Bb]atchStart/.test(stripped(file))),
  phpFiles.filter(file => /!\s*\$\w*[Aa]nswer\w*\s*&&\s*\$\w*[Bb]atchStart/.test(stripped(file))));
check('the removed inferCallType() helper is gone',
  phpFiles.every(file => !/function\s+inferCallType/.test(stripped(file))),
  phpFiles.filter(file => /function\s+inferCallType/.test(stripped(file))));
const classifier = stripped(path.join(ROOT, 'includes/reporting/cdr_fields.php'));
check('the classifier asks outcomes.php instead of testing call-answer-datetime itself',
  /callUnansweredForType\(\$row\)/.test(classifier) && !/empty\(\$row\['call-answer-datetime'\]\)/.test(classifier),
  'no callUnansweredForType() call in classifyCdrType()');
check('the queue aggregation loops share the canonical outcome helper',
  phpFiles.every(file => !/\$answeredCall\s*=\s*\$answerAt\s*!==\s*''\s*\|\|\s*\$talk\s*>\s*0/.test(stripped(file))),
  phpFiles.filter(file => /\$answeredCall\s*=\s*\$answerAt\s*!==\s*''\s*\|\|\s*\$talk\s*>\s*0/.test(stripped(file))));

/* ------------------------------------------------------------------ summary */

console.log('\n' + '-'.repeat(72));
if (failures.length) {
  console.log(`OUTCOMES FAILED — ${failures.length} check(s):`);
  for (const label of failures) console.log('  -', label);
  process.exit(1);
}
console.log('OUTCOMES OK — every report nav agrees on missed and abandoned');
