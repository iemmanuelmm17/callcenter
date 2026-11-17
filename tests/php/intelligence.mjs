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
assert.equal((await req('save_watches', { watches: ['bad\nline'] })).status, 422);
await h.seedPbx('users', []);
await h.seedPbx('fetchCdrs', [{
  id: 'cdr1', _server: 'nms1', 'call-direction': 1, 'call-start-datetime': '2026-11-16T10:00:00Z[US/Eastern]',
  'call-intelligence-job-id': 78920299,
  'prefilled-transcription-api': 'https://untrusted.example/ns-api/v2/domains/test.example/transcriptions?id=78920299&date=202611&callid=abc%40pbx'
},
{ id: 'cdr2', _server: 'nms1', 'call-start-datetime': '2026-11-16T10:01:00Z[US/Eastern]' },
{ id: 'cdr3', 'call-intelligence-job-id': 33, 'call-start-datetime': '2026-11-16T10:02:00Z[US/Eastern]' },
{ id: 'cdr4', _server: 'nms1', 'call-intelligence-job-id': 44, 'call-start-datetime': '2026-11-16T10:03:00Z[US/Eastern]' },
{ id: 'cdr5', _server: 'nms1', 'call-intelligence-job-id': 55, 'call-id': 'other', 'call-start-datetime': '2026-11-16T10:04:00Z[US/Eastern]' },
{ id: 'cdr6', _server: 'nms1', 'call-intelligence-job-id': 330696339, 'call-start-datetime': '2026-11-16T14:27:13+00:00',
  'prefilled-transcription-api': '/ns-api/v2/domains/test.example/transcriptions?id=330696339&amp;date=202611&amp;orig_callid=orig%40pbx&amp;term_callid=term%40pbx&amp;by_callid=through%40pbx&amp;ignored=unsafe' }]);
const listing = await req('list', { start: '2026-11-16', end: '2026-11-16', hours: 'all' });
assert.equal(listing.status, 200, JSON.stringify(listing));
assert.equal(listing.body.calls.length, 2, JSON.stringify(listing.body));
assert.equal(listing.body.calls[1].callId, 'through@pbx');
assert.equal(listing.body.calls[1].callIdField, 'by_callid');
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
  'call-intelligence-topics-all': ['billing issue'], 'call-intelligence-segments': [{ comment: 'Account number' }]
});
const threeIds = await req('lookup', { reference: listing.body.calls[1].reference });
assert.equal(threeIds.body.status, 'finished', JSON.stringify(threeIds));
const recorded = threeIds.pbxCalls.find(x => typeof x === 'string' && x.startsWith('transcription-args:'));
assert.deepEqual(JSON.parse(recorded.slice('transcription-args:'.length)).identifiers,
  { orig_callid: 'orig@pbx', term_callid: 'term@pbx', by_callid: 'through@pbx' });

assert.equal((await req('lookup', { reference: reference + 'bad' })).status, 422);
assert.equal((await req('lookup', { reference }, other)).status, 422);
assert.equal((await req('send', { references: [reference], recipients: ['bad\naddress'] })).status, 422);
assert.equal((await req('send', { references: [reference], recipients: ['manager@example.com'] })).status, 503);
const override = await req('list', { start: '2026-11-16', end: '2026-11-16', month: '202610' });
assert.equal(override.body.calls[0].month, '202610');
assert.equal((await req('list', { start: '2026-11-16', end: '2026-11-16', month: '202613' })).status, 422);
const unicode = await h.script(`require_once TEST_TMP . '/includes/intelligence.php'; echo json_encode(intelligenceMatches(['call-intelligence-summary' => 'ÉTÉ reboot'], ['été']));`);
assert.equal(JSON.parse(unicode.trim())[0].keyword, 'été');
const fallback = await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; define('INTELLIGENCE_PBX_SERVER', 'nms1'); $reason = null; echo json_encode(intelligenceReference(['call-intelligence-job-id'=>7, 'prefilled-transcription-api'=>'/ns-api/v2/domains/test.example/transcriptions?id=7&date=202611&by_callid=example%40pbx'], 'test.example', '', $reason));`);
assert.equal(JSON.parse(fallback.trim()).server, 'nms1');
await h.seedPbx('transcription', { 'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'finished' });
assert.equal((await req('lookup', { reference })).body.status, 'partial');
console.log('INTELLIGENCE OK — role, tenant, references, watch matching and partial jobs');
