/**
 * Endpoint matrix: every api/*.php is executed under real PHP 8.4 by the
 * phpwasm harness and checked for
 *   1. the session gate (401 without a session),
 *   2. the method gate (405 for the wrong verb),
 *   3. the role gate (403 for a role that must not see the data),
 *   4. a 2xx for the role that is supposed to see it,
 *   5. no PHP fatal/notice leaking into the response.
 *
 * The matrix is a living table: it is the contract the refactor must not
 * break, and the place to add an endpoint when a new one is created.
 */
import { PhpHarness, USERS } from './php.mjs';

const failures = [];
const results = [];
const check = (label, ok, extra) => {
  results.push({ label, ok });
  if (!ok) {
    failures.push(label);
    const detail = extra === undefined ? '' : JSON.stringify(extra).slice(0, 400);
    console.log('  FAIL', label, detail);
  } else {
    console.log('  PASS', label);
  }
};

/* endpoint -> {method, body, allowed: role that must get 2xx, forbidden: roles that must get 403, requiresSession} */
const MATRIX = [
  { endpoint: 'report.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: [] },
  { endpoint: 'agents.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: [] },
  { endpoint: 'calls.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02', metric: 'total' }, allowed: 'office_manager', forbidden: [] },
  { endpoint: 'call_history.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: ['agent'] },
  { endpoint: 'telephone_numbers.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: ['supervisor', 'agent'], allowGet: true },
  { endpoint: 'simultaneous_calls.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: ['supervisor', 'agent'], allowGet: true },
  { endpoint: 'queue.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: ['agent'] },
  { endpoint: 'cradle.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: ['agent'] },
  { endpoint: 'aa.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02', rosterOnly: 1 }, allowed: 'office_manager', forbidden: ['supervisor', 'agent'] },
  { endpoint: 'alerts.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, allowed: 'office_manager', forbidden: [] },
  { endpoint: 'call_flow.php', method: 'POST', body: { traceApi: '/ns-api/v2/sipflow?x=1', origCallId: 'o1', startTime: '2026-08-02 10:00:00' }, allowed: 'office_manager', forbidden: ['agent'] },
  { endpoint: 'filters.php', method: 'POST', body: {}, allowed: 'office_manager', forbidden: [], allowGet: true },
  /*
   * QA-5: reading the thresholds is manager/supervisor, changing them is the
   * office manager's alone.
   */
  { endpoint: 'settings.php', method: 'POST', body: {}, allowed: 'office_manager', forbidden: ['supervisor', 'agent', 'basic_user'], allowGet: true },
  { endpoint: 'settings.php', method: 'GET', body: null, allowed: 'supervisor', forbidden: ['agent', 'basic_user'], allowGet: true },
  { endpoint: 'cache_job.php', method: 'POST', body: { start: '2026-08-02', end: '2026-08-02', action: 'status' }, allowed: 'office_manager', forbidden: [] },
  /* session.php intentionally answers 200 {user:null} when not logged in — the
   * login screen uses it to detect an existing session. */
  { endpoint: 'session.php', method: 'POST', body: null, allowed: 'office_manager', forbidden: [], allowGet: true, noSessionStatus: 200 },
  { endpoint: 'logout.php', method: 'POST', body: null, allowed: 'office_manager', forbidden: [], sessionOptional: true },
  { endpoint: 'login.php', method: 'POST', body: { username: 'x', password: 'y' }, allowed: null, forbidden: [], sessionOptional: true, expectStatus: [401, 422] },
];

const harness = await new PhpHarness();
await harness.boot();

/* Canonical PBX fixtures for the harness runs. */
await harness.seedPbx('users', [
  { user: '1000', 'name-first-name': 'Test', 'name-last-name': 'Manager', 'user-scope': 'Office Manager', department: '', site: '', 'login-username': '1000@test.example' },
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6080@test.example' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', 'user-scope': 'User', department: 'Support', site: 'HQ', 'login-username': '6081@test.example' },
  { user: '6082', 'name-first-name': 'Numeric', 'name-last-name': 'Location', 'user-scope': 'User', department: '123', site: '456' }
]);
await harness.seedPbx('callqueues', [{ callqueue: '700', description: 'Sales queue', site: 'HQ', 'callqueue-dispatch-type': 'simultaneous', 'active-queued-calls-total-current': 2, 'callqueue-count-agents-available': 4, 'callqueue-count-agents-total': 6 }]);
await harness.seedPbx('callqueueAgents', [{ user: '6080', name: 'Ada Lovelace' }]);
/* The PBX stub reads 'phonenumbers' (test-harness/php.mjs) — the camelCase
 * spelling here made this seed a no-op, so the DID endpoint was being exercised
 * against an empty inventory. */
await harness.seedPbx('phonenumbers', [{ phonenumber: '8457620002', type: 'local', enabled: 'yes' }]);
await harness.seedPbx('archiveCdrs', []);
await harness.seedPbx('fetchCdrs', [{
  id: 'cdr1', 'call-direction': 1, 'call-start-datetime': '2026-08-02T10:00:00Z[US/Eastern]',
  'call-answer-datetime': '2026-08-02T10:00:05Z[US/Eastern]', 'call-disconnect-datetime': '2026-08-02T10:03:00Z[US/Eastern]',
  'call-total-duration-seconds': 180, 'call-talking-duration-seconds': 175, 'call-term-user': '6080',
  'call-orig-user': '8454259810', 'call-orig-to-user': '8457620002', 'call-through-user': '700',
  'call-orig-caller-id': '8454259810', 'call-orig-from-name': 'Ada Lovelace'
}]);
await harness.seedPbx('autoAttendants', [{ extension: '900', name: 'Main IVR' }]);
await harness.seedPbx('autoAttendantUser', [{ extension: '900', name: 'Main IVR' }]);
await harness.seedPbx('autoAttendant', [{ 'dial-plan': [] }]);
await harness.seedPbx('recording', [{ 'file-access-url': 'https://pbx.example/ns-api/recordings/cdr1.wav', 'file-duration-seconds': 180, 'call-recording-status': 'available', 'call-id': 'cdr1' }]);
await harness.seedPbx('sipflowCradle', [{ type: 'ring', timestamp: '2026-08-02T10:00:00Z' }]);

console.log('== endpoint matrix (real PHP 8.4 via phpwasm) ==\n');
for (const entry of MATRIX) {
  const { endpoint, method, body, allowed, forbidden = [], sessionOptional, expectStatus } = entry;
  const label = endpoint.padEnd(24);

  if (!sessionOptional) {
    const want = entry.noSessionStatus ?? 401;
    const res = await harness.request(endpoint, { method, body, user: null });
    check(`${label} no session → ${want}`, res.status === want, { status: res.status, body: res.body });
    if (want === 200) {
      check(`${label} no session reports logged-out`, (res.body?.user ?? null) === null, res.body);
    }
  }

  const wrongMethod = method === 'POST' ? 'GET' : 'POST';
  if (!expectStatus && !entry.allowGet) {
    const res = await harness.request(endpoint, { method: wrongMethod, body, user: USERS.office_manager, query: {} });
    const gated = res.status === 405 || res.status === 401;
    check(`${label} ${wrongMethod} → 405/401`, gated, { status: res.status, body: res.body });
  }

  for (const role of forbidden) {
    const res = await harness.request(endpoint, { method, body, user: USERS[role], query: {} });
    check(`${label} ${role} → 403`, res.status === 403, { status: res.status, body: res.body });
  }

  if (allowed) {
    const res = await harness.request(endpoint, { method, body, user: USERS[allowed], query: {} });
    const expected = expectStatus || [200, 202];
    check(`${label} ${allowed} → ${expected.join('/')}`, expected.includes(res.status),
      { status: res.status, body: res.body });
    check(`${label} no PHP fatal leak`, !res.body?.fatal, res.body?.fatal);
  } else if (expectStatus) {
    const res = await harness.request(endpoint, { method, body, user: USERS.office_manager, query: {} });
    check(`${label} → ${expectStatus.join('/')}`, expectStatus.includes(res.status), { status: res.status, body: res.body });
  }
}

console.log('\n== numeric filter names ==');
{
  const res = await harness.request('filters.php', { method: 'GET', user: USERS.office_manager });
  check('numeric department names are JSON strings', res.body?.departments?.includes('123'), res.body?.departments);
  check('numeric site names are JSON strings', res.body?.sites?.includes('456'), res.body?.sites);
  const restricted = await harness.request('filters.php', {
    method: 'GET', user: { ...USERS.supervisor, department: '123', site: '456' }
  });
  check('restricted numeric filter names are JSON strings',
    restricted.body?.departments?.includes('123') && restricted.body?.sites?.includes('456'), restricted.body);
}

/* ---------------------------------------------------------------------------
 * QA-5: the thresholds every screen colours with travel with the dashboard
 * payload, because the settings endpoint is manager/supervisor only.
 * ------------------------------------------------------------------------- */
console.log('\n== QA-5 settings access ==');
{
  const save = await harness.request('settings.php', {
    method: 'POST', body: { slaPct: 91, missedPct: 33, abandonPct: 12 }, user: USERS.office_manager
  });
  check('an office manager can save the thresholds', save.status === 200, save.body);

  const saved = await harness.request('settings.php', { method: 'GET', user: USERS.office_manager });
  check('the GET reports the saved values and that the caller may edit',
    Number(saved.body?.data?.slaPct) === 91 && saved.body?.canEdit === true, saved.body);

  const supGet = await harness.request('settings.php', { method: 'GET', user: USERS.supervisor });
  check('a supervisor may read them but not edit',
    supGet.status === 200 && supGet.body?.canEdit === false, supGet.body);

  const supWrite = await harness.request('settings.php', {
    method: 'POST', body: { slaPct: 55 }, user: USERS.supervisor
  });
  check('a supervisor cannot change them', supWrite.status === 403, supWrite.status);
  const reread = await harness.request('settings.php', { method: 'GET', user: USERS.office_manager });
  check('the refused write changed nothing', Number(reread.body?.data?.slaPct) === 91, reread.body?.data);

  const forAgent = await harness.request('report.php', {
    method: 'POST', body: { start: '2026-08-02', end: '2026-08-02' }, user: USERS.agent
  });
  const thresholds = forAgent.body?.settings || {};
  check('report.php ships the thresholds to an agent (so the colours match)',
    Number(thresholds.slaPct) === 91 && Number(thresholds.missedPct) === 33 && Number(thresholds.abandonPct) === 12,
    thresholds);
}

/* ---------------------------------------------------------------------------
 * SEC-2 / SEC-3 regression tests: the endpoint-level attacks the review found.
 * The PBX stub mirrors the real client, so a hostile URL must never reach it.
 * ------------------------------------------------------------------------- */
console.log('\n== SEC-2 recording URL policy ==');
const HOSTILE_SRC = [
  ['https://evil.example/ns-api/recording.mp3', 'foreign host'],
  ['https://pbx.example.evil.example/ns-api/x.mp3', 'superstring host'],
  ['http://169.254.169.254/ns-api/latest/meta-data', 'cloud metadata address'],
  ['https://pbx.example/notnsapi/x.mp3', 'path outside /ns-api/'],
  ['javascript:alert(1)//ns-api/', 'javascript scheme'],
  ['file:///etc/passwd', 'file scheme'],
  ['https://pbx.example/ns-api/../../includes/config.php', 'path traversal'],
  ['https://pbx.example/ns-api/x.mp3\r\nX-Test: 1', 'CRLF injection']
];
for (const [src, why] of HOSTILE_SRC) {
  const res = await harness.request('recording.php', {
    method: 'POST',
    body: { src, callId: 'cdr1', extension: '6080' },
    user: USERS.office_manager
  });
  const fetched = res.pbxCalls.filter(call => String(call).startsWith('download'));
  check(`recording.php refuses ${why} (400, nothing fetched)`, res.status === 400 && fetched.length === 0,
    { status: res.status, fetched });
}

{
  const legit = 'https://pbx.example/ns-api/v2/domains/test.example/recordings/cdr1.mp3';

  /* POST only resolves the URL for the player... */
  const res = await harness.request('recording.php', {
    method: 'POST',
    body: { src: legit, callId: 'cdr1', extension: '6080' },
    user: USERS.office_manager
  });
  check('recording.php returns a PBX-hosted recording URL',
    res.status === 200 && res.body?.data?.url === legit,
    { status: res.status, body: res.body });

  /* ...the audio itself is streamed by the GET path. */
  const stream = await harness.request('recording.php', {
    method: 'GET',
    query: { stream: '1', src: legit, callId: 'cdr1' },
    user: USERS.office_manager
  });
  const fetched = stream.pbxCalls.filter(call => String(call).startsWith('download:'));
  check('recording.php streams it from the PBX with the token',
    fetched.length === 1 && fetched[0] === 'download:' + legit && stream.phpOutput.includes('STUB-AUDIO'),
    { fetched, output: stream.phpOutput.slice(0, 80) });

  /*
   * QA-10: a playback is audited, both when the player asks for the URL and
   * when the audio is streamed.
   */
  const auditFile = 'logs/audit-' + new Date().toISOString().slice(0, 7) + '.jsonl';
  const audit = await harness.readInterpreterFile(auditFile);
  const playLines = audit.trim().split('\n').filter(line => line.includes('"resource":"recording"'));
  const streamed = playLines.some(line => line.includes('"stream":1') && line.includes('cdr1'));
  const resolved = playLines.some(line => line.includes('"stream":0') && line.includes('cdr1'));
  check('the URL resolution is audited as a recording view', resolved,
    playLines.slice(-1)[0]);
  check('the streamed playback is audited too', streamed, playLines.slice(-1)[0]);
}

{
  const res = await harness.request('recording.php', {
    method: 'GET',
    query: { stream: '1', src: 'https://evil.example/ns-api/x.mp3', callId: 'cdr1', stream_: '1' },
    user: USERS.office_manager
  });
  const fetched = res.pbxCalls.filter(call => String(call).startsWith('download'));
  check('recording.php stream refuses a foreign src',
    res.phpOutput.includes('Invalid recording URL') && fetched.length === 0,
    { output: res.phpOutput.slice(0, 120), fetched });
}

console.log('\n== SEC-3 call-flow trace policy ==');
for (const [trace, why] of [
  ['https://evil.example/ns-api/v2/sipflow?callids=a1', 'foreign host'],
  ['/ns-api/v2/domains/test.example/recordings?callids=a1', 'another PBX endpoint'],
  ['/ns-api/v2/sipflow?callids=a1\r\nHost: evil.example', 'CRLF injection']
]) {
  const res = await harness.request('call_flow.php', {
    method: 'POST',
    body: { origCallId: 'o1', startTime: '2026-08-02 10:00:00', traceApi: trace },
    user: USERS.office_manager
  });
  const sipflow = res.pbxCalls.filter(call => String(call).startsWith('sipflowCradle'));
  check(`call_flow.php refuses trace from ${why}`, res.status === 400 && sipflow.length === 0,
    { status: res.status, sipflow });
}

{
  const res = await harness.request('call_flow.php', {
    method: 'POST',
    body: {
      origCallId: 'o1',
      startTime: '2026-08-02 10:00:00',
      endTime: '2026-08-02 10:05:00',
      traceApi: '/ns-api/v2/sipflow?callids=o1&type=cradle_to_grave'
    },
    user: USERS.office_manager
  });
  const sipflow = res.pbxCalls.filter(call => String(call).startsWith('sipflowCradle:'));
  check('call_flow.php accepts a canonical PBX trace', res.status === 200 && sipflow.length === 1,
    { status: res.status, sipflow, body: res.body });
}

/*
 * F2: the span cap is part of the endpoint contract, not just a picker rule.
 * The picker uses maxRangeDaysFor(role); the API uses authorizedFilters(); the
 * two must agree or the reader sees numbers for a range a button did not name.
 * These run the real API with a 90-day request for both roles.
 */
{
  const span = (body, user) => harness.request('report.php', { body, user });
  const sup = await span({ start: '2026-08-01', end: '2026-10-29' }, USERS.supervisor);
  const mgr = await span({ start: '2026-08-01', end: '2026-10-29' }, USERS.office_manager);
  const spanDays = (f) => Math.round((new Date(f.end + 'T00:00:00') - new Date(f.start + 'T00:00:00')) / 864e5) + 1;
  check('a supervisor asking for 90 days is held to the 31-day window',
    sup.status === 200 && spanDays(sup.body.filters) === 31 && sup.body.filters.end === '2026-08-31',
    { status: sup.status, filters: sup.body.filters });
  check('an office manager asking for 90 days gets the range that was asked for',
    mgr.status === 200 && spanDays(mgr.body.filters) === 90 && mgr.body.filters.end === '2026-10-29',
    { status: mgr.status, filters: mgr.body.filters });
  check('the clamp anchors on the requested start, not today (a bookmarked link still means what it says)',
    sup.body.filters.start === '2026-08-01', sup.body.filters.start);

  /* The manager's own ceiling, and the leap-day arithmetic in it: 1 Jan 2026
   * + 365 days is 1 Jan 2027, i.e. 366 days inclusive. */
  const wide = await span({ start: '2026-01-01', end: '2027-12-31' }, USERS.office_manager);
  check('an office manager asking for two years is trimmed to 366 days',
    wide.status === 200 && wide.body.filters.end === '2027-01-01' && spanDays(wide.body.filters) === 366,
    { status: wide.status, filters: wide.body.filters, days: wide.status === 200 ? spanDays(wide.body.filters) : null });
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);
if (failures.length) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ENDPOINT MATRIX OK');
process.exit(0);
