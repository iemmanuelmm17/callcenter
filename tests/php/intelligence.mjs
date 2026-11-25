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
  id: 'cdr1', _server: 'nms1', 'call-direction': 1, 'call-orig-from-name': 'Ada <Caller>', 'call-orig-from-user': 'sip:+18005550101@carrier', 'call-orig-to-user': '18005550999', 'call-term-user': '2400', 'call-start-datetime': '2026-11-16T10:00:00Z[US/Eastern]',
  'call-intelligence-job-id': 78920299,
  'prefilled-transcription-api': 'https://untrusted.example/ns-api/v2/domains/test.example/transcriptions?id=78920299&date=202611&callid=abc%40pbx'
},
{ id: 'cdr2', _server: 'nms1', 'call-start-datetime': '2026-11-16T10:01:00Z[US/Eastern]' },
{ id: 'cdr3', 'call-intelligence-job-id': 33, 'call-start-datetime': '2026-11-16T10:02:00Z[US/Eastern]' },
{ id: 'cdr4', _server: 'nms1', 'call-direction': 1, 'call-orig-from-name': 'Café User', 'call-orig-from-user': '5553333', 'call-orig-to-user': '700', 'call-term-user': '2500', 'call-intelligence-job-id': 44, 'call-intelligence-topics-top': 'account number, billing', 'call-start-datetime': '2026-11-16T10:03:00Z[US/Eastern]' },
{ id: 'cdr5', _server: 'nms1', 'call-intelligence-job-id': 55, 'call-id': 'other', 'call-start-datetime': '2026-11-16T10:04:00Z[US/Eastern]' },
{ id: 'cdr6', _server: 'nms1', 'call-direction': 0, 'call-orig-user': '0100', 'call-orig-to-user': '5554444', 'call-intelligence-job-id': 330696339, 'call-start-datetime': '2026-11-16T14:27:13+00:00',
  'prefilled-transcription-api': '/ns-api/v2/domains/test.example/transcriptions?id=330696339&amp;date=202611&amp;orig_callid=orig%40pbx&amp;term_callid=term%40pbx&amp;by_callid=through%40pbx&amp;ignored=unsafe' }]);
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; monitorRecordEmail('test.example', 'cdr1', ['mail@example.com'], 'manual', 123456);`);
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';
monitorReviewCdr('test.example', ['id'=>'cdr4','call-start-datetime'=>'2026-11-16T10:03:00Z'], monitorExpiryReason('callId'));
monitorReviewCdr('test.example', ['id'=>'cdr2','call-start-datetime'=>'2026-11-16T10:01:00Z'], monitorExpiryReason('jobId'));
monitorReviewCdr('other.example', ['id'=>'cdr4'], 'other tenant');
monitorReviewCdr('test.example', ['id'=>'orphan-in','call-start-datetime'=>'2026-11-16T14:00:00Z'], 'in month');
monitorReviewCdr('test.example', ['id'=>'orphan-out','call-start-datetime'=>'2026-10-16T14:00:00Z'], 'outside month');
monitorReviewCdr('test.example', ['id'=>'orphan-unknown'], 'unknown date');
monitorReviewCdr('test.example', ['id'=>'tz-in','call-start-datetime'=>'2026-11-17T02:00:00Z'], 'same local day');
monitorReviewCdr('test.example', ['id'=>'tz-out','call-start-datetime'=>'2026-11-16T03:00:00Z'], 'different local day');
$ref=['id'=>'78920299','callid'=>'abc@pbx']; $f=monitorDirectory().'/job-'.monitorDomainId('test.example').'-'.monitorJobKey($ref).'.json'; monitorWriteFile($f,['status'=>'review','time'=>time(),'callid'=>'abc@pbx','reason'=>'SMTP delivery uncertain; verify before retrying']);
`);
const listing = await req('list', { start: '2026-11-16', end: '2026-11-16', hours: 'all' });
assert.equal(listing.status, 200, JSON.stringify(listing));
assert.equal(listing.body.calls.length, 7, JSON.stringify(listing.body));
const noTopicReview = listing.body.calls.find(x => x.callId === 'cdr2');
assert.equal(noTopicReview.topicsHint.length, 0); assert.equal(noTopicReview.reviews.length, 1); assert.ok(noTopicReview.emailReference);
const orphan = listing.body.calls.find(x => x.callId === 'orphan-in');
assert.equal(orphan.reviewOnly, true); assert.equal(orphan.emailReference, null); assert.equal(orphan.startedAt.slice(0,10), '2026-11-16');
assert.equal(listing.body.calls.find(x => x.callId === 'orphan-unknown').startedAt, '');
assert(!listing.body.calls.some(x => x.callId === 'orphan-out'), 'known review dates outside the selected month are excluded');
assert(listing.body.calls.some(x=>x.callId==='tz-in'), 'review date uses the reporting timezone');
assert(!listing.body.calls.some(x=>x.callId==='tz-out'), 'UTC date is not mistaken for the reporting date');
const restricted = await req('list', { start:'2026-11-16', end:'2026-11-16', department:'Sales', hours:'all' });
assert(!restricted.body.calls.some(x => x.reviewOnly), 'unverified records do not bypass department filtering');
assert(restricted.body.unscopedReviews > 0, 'hidden unknown-scope reviews are disclosed');
assert.equal(listing.body.intelligenceWorkers, 24);
const unavailable = listing.body.calls.find(x => x.status === 'unavailable' && x.topicsHint.length);
assert.equal(unavailable.reference, null);
assert.ok(unavailable.emailReference);
assert.deepEqual([unavailable.callerNumber, unavailable.dialedNumber, unavailable.destinationNumber], ['5553333', '700', '2500']);
assert.deepEqual(unavailable.topicsHint, ['account number', 'billing']);
assert.match(unavailable.reviews[0].reason, /usable transcription call ID/);
assert.equal(listing.body.calls[0].reviews.length, 1, 'legacy job review matches by job identity');
assert.match(listing.body.calls[0].reviews[0].reason, /may have succeeded/);
assert(!JSON.stringify(listing.body.calls).includes('other tenant'));
assert.equal((await req('monitor_status')).body.reviews.total, 8, 'no-topics review remains separately accessible');
assert.equal((await req('monitor_reviews', {}, USERS.supervisor)).status, 403);
assert.equal((await req('monitor_reviews', {}, other)).body.total, 1);
assert.deepEqual(unavailable.matchesHint.map(m => m.keyword), ['ACCOUNT']);
const threeIdCall = listing.body.calls.find(x => x.callId === 'through@pbx');
assert.equal(threeIdCall.callIdField, 'by_callid');
assert.deepEqual([threeIdCall.callerNumber, threeIdCall.dialedNumber, threeIdCall.destinationNumber], ['0100', '5554444', '5554444']);
assert.deepEqual(listing.body.missingReasons, { jobId: 1, server: 1, callId: 1, month: 1 });
assert.equal(listing.body.calls[0].callId, 'abc@pbx');
assert.deepEqual([listing.body.calls[0].callerNumber, listing.body.calls[0].dialedNumber, listing.body.calls[0].destinationNumber], ['18005550101', '18005550999', '2400']);
assert.equal(listing.body.calls[0].month, '202611');
assert.deepEqual(listing.body.calls[0].emailStatus, {time: 123456, recipients: ['mail@example.com'], kind: 'manual'});
const signedCdr = await h.script(`session_id('test-session-123'); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; echo json_encode(intelligenceVerifyEmail(${JSON.stringify(listing.body.calls[0].emailReference)}, 'test.example')['cdrId']);`);
assert.equal(JSON.parse(signedCdr), 'cdr1');
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
assert.match(unmatchedBody, /Date: 2026-11-16/);
assert.match(unmatchedBody, /Time: 10:00 AM \(US\/Eastern\)/);
assert.match(unmatchedBody, /Caller number: 18005550101 Ada <Caller>\n/);
assert.match(unmatchedBody, /Originally dialed: 18005550999/);
assert.match(unmatchedBody, /Final destination: 2400/);
assert.match(unmatchedBody, /Caller number: 5553333 Café User\n/);
assert.match(unmatchedBody, /Final destination: 2500/);
const otherZone = await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; setReportingTimezone('Asia/Manila'); echo json_encode(intelligenceEmailCallDetails('2024-02-29T17:30:00Z', []));`);
assert.match(JSON.parse(otherZone), /Date: 2024-03-01/);
assert.match(JSON.parse(otherZone), /Time: 1:30 AM \(Asia\/Manila\)/);
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
assert.match(JSON.parse(largeSnapshot.trim()), /Caller number: Unknown/);
const legacy = await h.script(`session_id('test-session-123'); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; $old = ['kind'=>'email','ref'=>null,'callid'=>'legacy','field'=>'id','startedAt'=>'','topics'=>[],'reason'=>'jobId']; $token = intelligenceSign($old, 'test.example'); echo json_encode(intelligenceVerifyEmail($token, 'test.example'));`);
assert.equal(JSON.parse(legacy.trim()).callerNumber, '', 'previously signed snapshots remain usable');
assert.equal(JSON.parse(legacy.trim()).callerName, '', 'older snapshots omit the new optional name');
const sanitized = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; $a=intelligencePartyDetails(['call-orig-from-name'=>"  Alice".chr(13).chr(10)." Bcc:fake  " ]); $b=intelligencePartyDetails(['call-orig-from-name'=>['invalid']]); $c=intelligencePartyDetails([]); echo json_encode([$a,$b,$c]);`));
assert.equal(sanitized[0].callerName, 'Alice Bcc:fake');
assert.equal(sanitized[1].callerName, ''); assert.equal(sanitized[2].callerName, '');
const missingName = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; echo json_encode(intelligenceEmailCallDetails('', ['callerNumber'=>'123','callerName'=>'','dialedNumber'=>'456','destinationNumber'=>'789']));`));
assert.match(missingName, /Caller number: 123\nOriginally dialed: 456\nFinal destination: 789\n/);

await h.seedPbx('transcription', { 'call-intelligence-job-id': 78920299, 'call-id': 'abc@pbx', 'call-intelligence-processing-status': 'finished' });
assert.equal((await req('lookup', { reference })).body.status, 'partial');
// Reviews beyond the old 50-item status page remain available in the main table.
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; for ($i=0;$i<53;$i++) monitorReviewCdr('page.example', ['id'=>'old-'.$i], 'unknown date');`);
const many=await req('list',{start:'2026-11-16',end:'2026-11-16',hours:'all'},{...USERS.office_manager,domain:'page.example'});
assert.equal(many.status,200,JSON.stringify(many));
assert.equal(many.body.calls.filter(x=>x.reviewOnly).length,53,'all review records, not just the first page, reach the table');
console.log('INTELLIGENCE OK — role, tenant, references, watch matching and partial jobs');
