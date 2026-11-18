import { PhpHarness, USERS } from './php.mjs';
import assert from 'node:assert/strict';
const h = await new PhpHarness();
await h.boot();
const req = (action, data = {}, user = USERS.office_manager) => h.request('intelligence.php', { user, body: { action, ...data } });
for (const role of ['supervisor', 'agent', 'basic_user']) {
  assert.equal((await req('watches', {}, USERS[role])).status, 403, `${role} denied`);
}
assert.equal((await h.request('intelligence.php', { body: { action: 'watches' } })).status, 401);
assert.equal((await req('save_watches', { watches: ['reboot', 'ACCOUNT', 'reboot'] })).status, 200);
assert.deepEqual((await req('watches')).body.watches, ['reboot', 'ACCOUNT']);
const other = { ...USERS.office_manager, domain: 'other.example' };
assert.deepEqual((await req('watches', {}, other)).body.watches, []);
const settings = (user, method = 'GET', body = null) => h.request('settings.php', { user, method, body });
assert.equal((await settings(USERS.office_manager)).body.data.intelligenceWorkers, 8);
assert.equal((await settings(USERS.office_manager, 'POST', { intelligenceWorkers: 24 })).body.data.intelligenceWorkers, 24);
assert.equal((await settings(other)).body.data.intelligenceWorkers, 8, 'workers are scoped to domain');
assert.equal((await settings(USERS.supervisor, 'POST', { intelligenceWorkers: 2 })).status, 403);
assert.equal((await settings(USERS.office_manager, 'POST', { slaPct: 89 })).body.data.intelligenceWorkers, 24, 'partial settings save preserves workers');
assert.equal((await settings(USERS.office_manager, 'POST', { intelligenceWorkers: 100 })).body.data.intelligenceWorkers, 32);
assert.equal((await settings(USERS.office_manager, 'POST', { intelligenceWorkers: -1 })).body.data.intelligenceWorkers, 1);
assert.equal((await settings(USERS.office_manager, 'POST', { intelligenceWorkers: 'invalid' })).body.data.intelligenceWorkers, 1);
await settings(USERS.office_manager, 'POST', { intelligenceWorkers: 24 });

assert.equal((await req('save_watches', { watches: ['bad\nline'] })).status, 422);
await h.seedPbx('users', []);
await h.seedPbx('fetchCdrs', [{
  id: 'cdr1', _server: 'nms1', 'call-direction': 1, 'call-start-datetime': '2026-11-16T10:00:00Z[US/Eastern]',
  'call-intelligence-job-id': 78920299,
  'prefilled-transcription-api': 'https://untrusted.example/ns-api/v2/domains/test.example/transcriptions?id=78920299&date=202611&callid=abc%40pbx'
},
{ id: 'cdr2', _server: 'nms1', 'call-start-datetime': '2026-11-16T10:01:00Z[US/Eastern]' },
{ id: 'cdr3', 'call-intelligence-job-id': 33, 'call-start-datetime': '2026-11-16T10:02:00Z[US/Eastern]' },
{ id: 'cdr4', _server: 'nms1', 'call-intelligence-job-id': 44, 'call-intelligence-topics-top': 'account number, billing', 'call-start-datetime': '2026-11-16T10:03:00Z[US/Eastern]' },
{ id: 'cdr5', _server: 'nms1', 'call-intelligence-job-id': 55, 'call-id': 'other', 'call-start-datetime': '2026-11-16T10:04:00Z[US/Eastern]' },
{ id: 'cdr6', _server: 'nms1', 'call-intelligence-job-id': 330696339, 'call-start-datetime': '2026-11-16T14:27:13+00:00',
  'prefilled-transcription-api': '/ns-api/v2/domains/test.example/transcriptions?id=330696339&amp;date=202611&amp;orig_callid=orig%40pbx&amp;term_callid=term%40pbx&amp;by_callid=through%40pbx&amp;ignored=unsafe' }]);
const listing = await req('list', { start: '2026-11-16', end: '2026-11-16', hours: 'all' });
assert.equal(listing.status, 200, JSON.stringify(listing));
assert.equal(listing.body.calls.length, 3, JSON.stringify(listing.body));
assert.equal(listing.body.intelligenceWorkers, 24);
const unavailable = listing.body.calls.find(x => x.status === 'unavailable');
assert.equal(unavailable.reference, null);
assert.ok(unavailable.emailReference);
assert.deepEqual(unavailable.topicsHint, ['account number', 'billing']);
assert.deepEqual(unavailable.matchesHint.map(m => m.keyword), ['ACCOUNT']);
const threeIdCall = listing.body.calls.find(x => x.callId === 'through@pbx');
assert.equal(threeIdCall.callIdField, 'by_callid');
assert.deepEqual(listing.body.missingReasons, { jobId: 1, server: 1, callId: 1, month: 1 });
assert.equal(listing.body.calls[0].callId, 'abc@pbx');
assert.equal(listing.body.calls[0].month, '202611');
const reference = listing.body.calls[0].reference;
await h.seedPbx('transcription', {
  'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'finished',
  'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'Device reboot requested',
  'call-intelligence-topics-top': ['account number', 'account number'],
  'call-intelligence-segments': [{ comment: 'Testing phone' }]
});
const lookup = await req('lookup', { reference });
assert.equal(lookup.status, 200, JSON.stringify(lookup));
assert.equal(lookup.body.status, 'finished');
assert.deepEqual(lookup.body.topics, ['account number']);
assert.deepEqual(lookup.body.matches.map(m => m.keyword), ['reboot', 'ACCOUNT']);
await h.seedPbx('transcription', {
  'call-intelligence-job-id': 330696339, 'call-id': 'orig@pbx', 'call-intelligence-processing-status': 'finished',
  'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'A billing issue',
  'call-intelligence-topics-all': ['billing issue'], 'call-intelligence-topics-top': ['other topic'], 'call-intelligence-segments': [{ comment: 'Account number' }]
});
const threeIds = await req('lookup', { reference: threeIdCall.reference });
assert.equal(threeIds.body.status, 'finished', JSON.stringify(threeIds));
assert.deepEqual(threeIds.body.topics, ['billing issue', 'other topic']);
const recorded = threeIds.pbxCalls.find(x => typeof x === 'string' && x.startsWith('transcription-args:'));
assert.deepEqual(JSON.parse(recorded.slice('transcription-args:'.length)).identifiers,
  { orig_callid: 'orig@pbx', term_callid: 'term@pbx', by_callid: 'through@pbx' });

assert.equal((await req('lookup', { reference: reference + 'bad' })).status, 422);
assert.equal((await req('lookup', { reference }, other)).status, 422);
assert.equal((await req('send', { references: [reference], recipients: ['bad\naddress'] })).status, 422);
assert.equal((await req('send', { references: [reference], recipients: ['manager@example.com'] })).status, 422, 'lookup references cannot be used as email snapshots');
assert.equal((await req('send', { references: [listing.body.calls[0].emailReference, unavailable.emailReference], recipients: ['manager@example.com'] })).status, 503);
assert.equal((await req('send', { references: [unavailable.emailReference + 'bad'], recipients: ['manager@example.com'] })).status, 422);
assert.equal((await req('send', { references: [unavailable.emailReference], recipients: ['manager@example.com'] }, other)).status, 422);
assert.equal((await req('lookup', { reference: unavailable.emailReference })).status, 422);
assert.equal((await req('send', { references: Array(11).fill(unavailable.emailReference), recipients: ['manager@example.com'] })).status, 422);

const override = await req('list', { start: '2026-11-16', end: '2026-11-16', month: '202610' });
assert.equal(override.body.calls[0].month, '202610');
assert.equal((await req('list', { start: '2026-11-16', end: '2026-11-16', month: '202613' })).status, 422);
const unicode = await h.script(`require_once TEST_TMP . '/includes/intelligence.php'; echo json_encode(intelligenceMatches(['call-intelligence-summary' => 'ÉTÉ reboot'], ['été']));`);
assert.equal(JSON.parse(unicode.trim())[0].keyword, 'été');
const fallback = await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; define('INTELLIGENCE_PBX_SERVER', 'nms1'); $reason = null; echo json_encode(intelligenceReference(['call-intelligence-job-id'=>7, 'prefilled-transcription-api'=>'/ns-api/v2/domains/test.example/transcriptions?id=7&date=202611&by_callid=example%40pbx'], 'test.example', '', $reason));`);
assert.equal(JSON.parse(fallback.trim()).server, 'nms1');
const emailBody = async (tokens) => JSON.parse((await h.script(`session_id('test-session-123'); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; $tokens = json_decode(base64_decode('${Buffer.from(JSON.stringify(tokens)).toString('base64')}'), true); $calls = array_map(fn($token) => intelligenceVerifyEmail($token, 'test.example'), $tokens); echo json_encode(intelligenceEmailBody($calls, new PbxClient(), 'test.example', intelligenceWatches('test.example')));`)).trim());
await h.seedPbx('transcription', { 'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'finished', 'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'No match', 'call-intelligence-topics-top': ['billing'], 'call-intelligence-segments': [] });
const unmatchedBody = await emailBody([listing.body.calls[0].emailReference, unavailable.emailReference]);
assert.match(unmatchedBody, /Status: finished/);
assert.match(unmatchedBody, /Summary: No match/);
assert.match(unmatchedBody, /No keyword matches/);
assert.match(unmatchedBody, /Status: unavailable/);
assert.match(unmatchedBody, /Topics: account number, billing/);
assert.match(unmatchedBody, /ACCOUNT \(Topic\): account number/);
await h.seedPbx('transcription', { 'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'processing' });
const pendingBody = await emailBody([listing.body.calls[0].emailReference]);
assert.match(pendingBody, /Status: pending \(check incomplete\)/);
assert.match(pendingBody, /No confirmed keyword match; check incomplete/);
await h.seedPbx('transcription', { 'call-intelligence-job-id': 999, 'call-id': 'abc@pbx' });
const errorBody = await emailBody([listing.body.calls[0].emailReference]);
assert.match(errorBody, /Status: unavailable/);
const largeSnapshot = await h.script(`session_id('test-session-123'); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; $token = intelligenceEmailReference(null, 'abc', 'id', '', [str_repeat('x', 4000)], 'jobId', 'test.example'); $call = intelligenceVerifyEmail($token, 'test.example'); echo json_encode(intelligenceEmailBody([$call], new PbxClient(), 'test.example', []));`);
assert.match(JSON.parse(largeSnapshot.trim()), /Some CDR topics were omitted/);

await h.seedPbx('transcription', { 'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'finished' });
assert.equal((await req('lookup', { reference })).body.status, 'partial');
console.log('INTELLIGENCE OK — role, tenant, references, watch matching and partial jobs');
