import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './php.mjs';
import { PhpHarness, USERS } from './php.mjs';
const h = await new PhpHarness();
await h.boot();
await h.write('includes/config.local.php', `<?php
  define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
  define('INTELLIGENCE_MONITOR_API_KEY', 'server-only-key');
  define('INTELLIGENCE_RECORDING_URL', 'https://calls.example.com/api/intelligence-recording.php');
  define('INTELLIGENCE_ALERT_RECIPIENTS', ['alerts@example.com']);
  define('INTELLIGENCE_SMTP_HOST', 'smtp.example.com');
  define('INTELLIGENCE_SMTP_PORT', 587);
  define('INTELLIGENCE_SMTP_USERNAME', 'smtp@example.com');
  define('INTELLIGENCE_SMTP_PASSWORD', 'password');
  define('INTELLIGENCE_SMTP_FROM', 'sender@example.com');
`);
const req = (action, data = {}, user = USERS.office_manager) => h.request('intelligence.php', { user, body: { action, ...data } });
for (const role of ['supervisor', 'agent', 'basic_user']) assert.equal((await req('monitor_status', {}, USERS[role])).status, 403);
assert.equal((await req('monitor_enable', { enabled: true })).status, 422, 'watches are required');
await req('save_watches', { watches: ['urgent'] });
assert.equal((await req('monitor_enable', { enabled: true })).status, 422, 'global addresses must not activate a domain');
for (const role of ['supervisor', 'agent', 'basic_user']) assert.equal((await req('monitor_recipients', {recipients:'a@example.com'}, USERS[role])).status, 403);
assert.equal((await req('monitor_recipients', { recipients: 'not-an-email' })).status, 422);
assert.equal((await req('monitor_recipients', { recipients: 'a@example.com\nb@example.com' })).status, 422);
assert.equal((await req('monitor_recipients', { recipients: Array.from({length:11}, (_,i)=>`a${i}@example.com`).join(';') })).status, 422);
const savedRecipients = await req('monitor_recipients', {recipients:'alerts@example.com; second@example.com; ALERTS@example.com'});
assert.deepEqual(savedRecipients.body.recipients, ['ALERTS@example.com','second@example.com']);
assert.equal((await req('monitor_recipients', {recipients:'bad@example.com; not-valid'})).status, 422);
assert.deepEqual((await req('monitor_status')).body.recipients, ['ALERTS@example.com','second@example.com'], 'invalid edits do not overwrite the saved list');
assert.deepEqual((await req('monitor_status', {}, { ...USERS.office_manager, domain: 'another.test' })).body.recipients, [], 'recipients are domain isolated');
assert.equal((await req('monitor_enable', { enabled: true })).body.enabled, true);
assert.equal((await req('monitor_status')).body.configured, true);
assert.equal((await req('monitor_status', {}, { ...USERS.office_manager, domain: 'another.test' })).body.enabled, false);
await h.seedPbx('transcription', { 'call-intelligence-job-id': '123', 'call-intelligence-processing-status': 'processing' });
const pending = await h.script(`
require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';
$state = monitorUpdate('test.example', function ($s) { $s['since'] = time()-100; return $s; });
$call = ['_server'=>'nms1', 'call-disconnect-datetime'=>gmdate('c', time()-20), 'call-intelligence-job-id'=>'123', 'prefilled-transcription-api'=>'/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=pending'];
$c = ['checked'=>0,'sent'=>0,'pending'=>0,'review'=>0,'unresolved'=>0,'missingTime'=>0]; monitorProcessCall(new PbxClient('key'), 'test.example', $call, $state, $c); echo json_encode($c);
`);
assert.equal(JSON.parse(pending).pending, 1, 'unfinished jobs stay pending');
await h.seedPbx('transcription', {
  'call-intelligence-job-id': '123', 'call-intelligence-processing-status': 'finished',
  'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'urgent help',
  'call-intelligence-topics-top': ['billing'], 'call-intelligence-segments': [{ comment: 'urgent problem' }]
});
const signed = (await h.script(`
session_id('test-session-123'); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php';
$ref = ['id'=>'123','callid'=>'api-report','displayField'=>'callid','identifiers'=>['callid'=>'api-report'],'server'=>'nms1','month'=>'202611','completedAt'=>gmdate('c', time()-10)];
echo intelligenceSign($ref, 'test.example');
`)).trim();
assert.equal((await req('lookup', { reference: signed })).body.status, 'finished');
const marked = await h.script(`
require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';
$ref = ['id'=>'123','callid'=>'api-report']; $file = monitorDirectory() . '/job-' . monitorDomainId('test.example') . '-' . monitorJobKey($ref) . '.json'; echo json_encode(monitorReadFile($file));
`);
assert.equal(JSON.parse(marked).status, 'report_checked', 'successful report API lookup records suppression');
await h.seedPbx('recording', { 'file-access-url': 'https://pbx.example/ns-api/v2/recording.wav' });
const output = await h.script(`
require_once TEST_TMP . '/includes/reporting.php';
require_once TEST_TMP . '/includes/intelligence.php';
require_once TEST_TMP . '/includes/intelligence-monitor.php';
foreach (['CURLOPT_USERNAME','CURLOPT_PASSWORD','CURLOPT_USE_SSL','CURLOPT_SSL_VERIFYPEER','CURLOPT_SSL_VERIFYHOST','CURLOPT_MAIL_FROM','CURLOPT_MAIL_RCPT','CURLOPT_UPLOAD','CURLOPT_INFILE','CURLOPT_INFILESIZE','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLUSESSL_ALL'] as $i => $n) if (!defined($n)) define($n, $i + 100);
function curl_init($url) { return new stdClass(); }
function curl_setopt_array($curl, $opts) { $payload = stream_get_contents($opts[CURLOPT_INFILE]); rewind($opts[CURLOPT_INFILE]); $GLOBALS['payloads'][] = $payload; preg_match_all('~Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)~', $payload, $matches); $GLOBALS['bodies'][] = base64_decode($matches[1][0] ?? ''); $GLOBALS['html'][] = base64_decode($matches[1][1] ?? ''); $GLOBALS['rcpt'][] = $opts[CURLOPT_MAIL_RCPT]; return true; }
function curl_exec($curl) { $GLOBALS['sends']++; return !$GLOBALS['fail']; }
function curl_close($curl) {}
$GLOBALS['sends'] = 0; $GLOBALS['fail'] = false; $GLOBALS['bodies'] = []; $GLOBALS['html'] = []; $GLOBALS['payloads'] = []; $GLOBALS['rcpt'] = [];
$domain = 'test.example';
intelligenceSaveWatches($domain, ['urgent']);
monitorSetEnabled($domain, true);
$state = monitorUpdate($domain, function ($s) { $s['since'] = time() - 100; return $s; });
$make = function ($id) use ($domain) { return ['id'=>'cdr-'.$id, '_server'=>'nms1', 'call-direction'=>1, 'call-orig-from-user'=>'15550001111', 'call-orig-to-user'=>'18005550999', 'call-term-user'=>'222', 'call-term-call-id'=>$id, 'call-start-datetime'=>gmdate('c', time()-40), 'call-disconnect-datetime'=>gmdate('c', time()-20), 'call-intelligence-job-id'=>'123', 'prefilled-transcription-api'=>'/ns-api/v2/domains/'.$domain.'/transcriptions?id=123&date=202611&callid='.$id]; };
$counts = ['checked'=>0,'sent'=>0,'pending'=>0,'review'=>0,'unresolved'=>0,'missingTime'=>0];
$client = new PbxClient('key');
$call = $make('one');
monitorProcessCall($client, $domain, $call, $state, $counts);
monitorProcessCall($client, $domain, $call, $state, $counts);
$reason = null; $ref = intelligenceReference($make('two'), $domain, '', $reason); $ref['completedAt'] = $make('two')['call-disconnect-datetime'];
monitorMarkReport($domain, $ref);
monitorProcessCall($client, $domain, $make('two'), $state, $counts);
$GLOBALS['fail'] = true;
monitorProcessCall($client, $domain, $make('three'), $state, $counts);
$GLOBALS['fail'] = false;
monitorProcessCall($client, $domain, $make('three'), $state, $counts);
$otherDomain='another.test'; intelligenceSaveWatches($otherDomain, ['urgent']);
monitorSaveRecipients($otherDomain, 'other@example.com; next@example.com'); monitorSetEnabled($otherDomain, true);
$otherState=monitorUpdate($otherDomain, function ($s) { $s['since']=time()-100; return $s; });
$otherCall=$make('tenant'); $otherCall['prefilled-transcription-api']='/ns-api/v2/domains/another.test/transcriptions?id=123&date=202611&callid=tenant';
$otherCounts=['checked'=>0,'sent'=>0,'pending'=>0,'review'=>0,'unresolved'=>0,'missingTime'=>0];
monitorProcessCall($client,$otherDomain,$otherCall,$otherState,$otherCounts);
$missing = $make('four'); unset($missing['call-intelligence-job-id']); $missing['call-disconnect-datetime'] = gmdate('c', time()-90000);
$state['since'] = time()-100000;
monitorProcessCall($client, $domain, $missing, $state, $counts);
echo json_encode(['sends'=>$GLOBALS['sends'], 'counts'=>$counts, 'reviews'=>monitorReviews($domain), 'body'=>$GLOBALS['bodies'][0] ?? '', 'html'=>$GLOBALS['html'][0] ?? '', 'payload'=>$GLOBALS['payloads'][0] ?? '', 'rcpt'=>$GLOBALS['rcpt'], 'otherCounts'=>$otherCounts]);
`);
const result = JSON.parse(output.trim());
assert.equal(result.sends, 3, 'duplicate and report-checked calls send nothing; uncertain delivery is not retried');
assert.deepEqual(result.rcpt[0], ['<ALERTS@example.com>', '<second@example.com>']);
assert.deepEqual(result.rcpt[2], ['<other@example.com>', '<next@example.com>'], 'each domain uses only its own recipients');
assert.equal(result.otherCounts.sent, 1);
assert.equal(result.counts.sent, 1);
assert.match(result.payload, /Content-Type: multipart\/alternative/);
assert.match(result.html, /<mark[^>]*>urgent<\/mark>/i);
assert.match(result.html, /Listen to recording/);
assert.match(result.body, /https:\/\/calls\.example\.com\/api\/intelligence-recording\.php#[0-9a-f]{72}/);
assert.match(result.body, /Date: \d{4}-\d{2}-\d{2}/);
assert.match(result.body, /Time: .*US\/Eastern/);
assert.match(result.body, /Caller number: 15550001111/);
assert.match(result.body, /Originally dialed: 18005550999/);
assert.match(result.body, /Final destination: 222/);
assert.equal(result.reviews.total, 2, JSON.stringify(result));
assert.match(JSON.stringify(result.reviews), /uncertain/);
assert.match(JSON.stringify(result.reviews), /unavailable after 24 hours/);
const review = result.reviews.items[0];
assert.equal((await req('monitor_reviewed', { id: review.id }, { ...USERS.office_manager, domain: 'another.test' })).status, 422, 'review is tenant scoped');
assert.equal((await req('monitor_reviewed', { id: review.id })).body.reviews.total, 1);
// The old subscription and pending state must not be required or changed by enabling polling.
const legacyState = JSON.parse(await h.script(`
require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';
$s=monitorUpdate('test.example', function ($s) { $s['subscriptionId']='legacy-id'; $s['subscriptionPending']=true; return $s; });
echo json_encode(monitorSetEnabled('test.example',true));
`));
assert.equal(legacyState.subscriptionId, 'legacy-id', 'existing PBX subscriptions are left alone');
assert.equal(legacyState.subscriptionPending, undefined, 'old provisioning state no longer blocks the domain');
assert.equal((await req('monitor_status')).body.enabled, true);
const gone = await h.script(`require TEST_TMP . '/api/intelligence-webhook.php'; echo ':' . http_response_code();`);
assert.match(gone, /no longer active.*:410/);
const configured = await h.script(`define('INTELLIGENCE_CDR_LOOKBACK_MINUTES', 60); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; echo json_encode(['minutes'=>monitorLookbackMinutes(),'ready'=>monitorReady()]);`);
assert.deepEqual(JSON.parse(configured), {minutes:60, ready:true});
const invalidConfig = await h.script(`define('INTELLIGENCE_CDR_LOOKBACK_MINUTES', 0); require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; echo json_encode(['minutes'=>monitorLookbackMinutes(),'ready'=>monitorReady()]);`);
assert.deepEqual(JSON.parse(invalidConfig), {minutes:null, ready:false});

// A polling scan discovers a CDR even when it has no job ID. No webhook needed.
await req('monitor_enable', {enabled:false}, { ...USERS.office_manager, domain:'another.test' });
await h.seedPbx('transcription', { 'call-intelligence-job-id': '123', 'call-intelligence-processing-status': 'finished', 'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'all good', 'call-intelligence-topics-top': ['billing'], 'call-intelligence-segments': [] });
const discoveredCall = { id:'cdr-cron', domain:'test.example', _server:'nms1', 'call-start-datetime':new Date(Date.now()-400000).toISOString(), 'call-disconnect-datetime':new Date(Date.now()-380000).toISOString() };
await h.seedPbx('fetchCdrs', [discoveredCall]);
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; monitorUpdate('test.example', function ($s) { $s['since']=time()-1000; return $s; });`);
await h.write('tools/intelligence-monitor.php', readFileSync(path.join(ROOT, 'tools/intelligence-monitor.php'), 'utf8'));
assert.equal((await req('monitor_recipients', {recipients:''})).body.paused, true);
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const windows = (await h.pbxCalls()).filter(x => typeof x === 'string' && x.startsWith('cdr-window:')).map(x => JSON.parse(x.slice('cdr-window:'.length)));
assert.equal(windows.length, 1, 'one discovery request for the enabled domain');
assert.equal(windows[0].domain, 'test.example');
assert.equal(Date.parse(windows[0].end)-Date.parse(windows[0].start), 600000, 'default discovery window is 10 minutes');
assert.equal(windows[0].concurrency, 1, 'avoid speculative extra pages');
const originalConfig = await h.readInterpreterFile('includes/config.local.php');
await h.write('includes/config.local.php', originalConfig + "\ndefine('INTELLIGENCE_CDR_LOOKBACK_MINUTES', 60);\n");
await h.script(`@unlink(TEST_TMP . '/pbx-calls.jsonl'); require TEST_TMP . '/tools/intelligence-monitor.php';`);
const customWindows = (await h.pbxCalls()).filter(x => typeof x === 'string' && x.startsWith('cdr-window:')).map(x => JSON.parse(x.slice('cdr-window:'.length)));
assert.equal(Date.parse(customWindows[0].end)-Date.parse(customWindows[0].start), 3600000, 'configured discovery window is applied');
await h.write('includes/config.local.php', originalConfig);
const paused = await req('monitor_status');
assert.equal(paused.body.paused, true);
assert.match(paused.body.lastRun.error, /Paused/);
const queued = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; echo json_encode(monitorReadFile(monitorQueueFile('test.example','cdr-cron')));`));
assert.equal(queued.status, 'pending', 'discovery continues while recipients are paused');
assert.equal((await req('monitor_recipients', {recipients:'ALERTS@example.com; second@example.com'})).body.paused, false);
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const retry = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; echo json_encode(monitorReadFile(monitorQueueFile('test.example','cdr-cron')));`));
assert.equal(retry.status, 'pending');
assert.equal(retry.attempts, 1, 'missing job is retried');
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; $f=monitorQueueFile('test.example','cdr-cron'); $s=monitorReadFile($f); $s['next']=time()-1; monitorWriteFile($f,$s);`);
await h.seedPbx('fetchCdrs', [{ ...discoveredCall, 'call-intelligence-job-id':'123', 'prefilled-transcription-api':'/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=cron' }]);
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const after = await req('monitor_status');
assert.equal(after.body.lastRun.counts.checked, 1, JSON.stringify(after.body));
assert.equal(after.body.lastRun.error, '');
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const repeated = await req('monitor_status');
assert.equal(repeated.body.lastRun.counts.checked, 0, 'overlapping scans do not re-check finished CDRs');
const finalState = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; echo json_encode(['pending'=>is_file(monitorQueueFile('test.example','cdr-cron')), 'done'=>is_file(monitorQueueDoneFile('test.example','cdr-cron')), 'auto'=>monitorEmailStatus('test.example','cdr-one')]);`));
assert.equal(finalState.pending, false); assert.equal(finalState.done, true);
assert.deepEqual(finalState.auto.recipients, ['ALERTS@example.com', 'second@example.com']);

// Once a pending call ages outside the discovery window, its old start bucket is re-fetched.
const olderCall = { id:'cdr-older', domain:'test.example', _server:'nms1', 'call-start-datetime':new Date(Date.now()-900000).toISOString(), 'call-disconnect-datetime':new Date(Date.now()-850000).toISOString(), 'call-intelligence-job-id':'123', 'prefilled-transcription-api':'/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=older' };
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; $s=monitorUpdate('test.example', function ($s) { $s['since']=time()-2000; return $s; }); monitorQueueCdr('test.example','cdr-older',time()-900,time()-850,$s);`);
await h.seedPbx('filterCdrWindows', true);
await h.seedPbx('fetchCdrs', [olderCall]);
await h.script(`@unlink(TEST_TMP . '/pbx-calls.jsonl'); require TEST_TMP . '/tools/intelligence-monitor.php';`);
const retryWindows = (await h.pbxCalls()).filter(x => typeof x === 'string' && x.startsWith('cdr-window:')).map(x => JSON.parse(x.slice('cdr-window:'.length)));
assert.equal(retryWindows.length, 2, 'one discovery request and one older retry window');
assert.equal(Date.parse(retryWindows[0].end)-Date.parse(retryWindows[0].start), 600000);
assert.equal(Date.parse(retryWindows[1].end)-Date.parse(retryWindows[1].start), 299000);
assert.equal((await req('monitor_status')).body.lastRun.counts.checked, 1, 'older pending call is checked');
await h.seedPbx('filterCdrWindows', false);

// An automatically matched CDR sends once even when successive windows overlap.
const hit = { ...discoveredCall, id:'cdr-hit', 'call-intelligence-job-id':'123', 'prefilled-transcription-api':'/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=hit' };
await h.seedPbx('fetchCdrs', [hit]);
await h.seedPbx('transcription', { 'call-intelligence-job-id':'123', 'call-intelligence-processing-status':'finished', 'call-intelligence-summary-status':'success', 'call-intelligence-summary':'urgent help', 'call-intelligence-topics-top':['billing'], 'call-intelligence-segments':[] });
const mailHarness = `
foreach (['CURLOPT_USERNAME','CURLOPT_PASSWORD','CURLOPT_USE_SSL','CURLOPT_SSL_VERIFYPEER','CURLOPT_SSL_VERIFYHOST','CURLOPT_MAIL_FROM','CURLOPT_MAIL_RCPT','CURLOPT_UPLOAD','CURLOPT_INFILE','CURLOPT_INFILESIZE','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLUSESSL_ALL'] as $i => $n) if (!defined($n)) define($n, $i + 100);
function curl_init($url) { return new stdClass(); }
function curl_setopt_array($curl, $opts) { return true; }
function curl_exec($curl) { file_put_contents(TEST_TMP . '/mail-count', '1', FILE_APPEND); return true; }
function curl_close($curl) {}
require TEST_TMP . '/tools/intelligence-monitor.php';`;
await h.script(mailHarness);
await h.script(mailHarness);
assert.equal(await h.readInterpreterFile('mail-count'), '1', 'matched CDR sends one automatic email across overlapping polls');
const hitMail = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; echo json_encode(monitorEmailStatus('test.example','cdr-hit'));`));
assert.deepEqual(hitMail.recipients, ['ALERTS@example.com', 'second@example.com']);
assert.equal(hitMail.kind, 'automatic');

// Completed CDRs already saved from the previous webhook version remain valid.
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; $s=monitorState('test.example'); monitorQueueCdr('test.example','legacy-pending',time()-900,time()-500,$s);`);
await h.seedPbx('fetchCdrsPages', [[[ { ...discoveredCall, id:'cdr-partial' } ], 1, false]]);
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
assert.match((await req('monitor_status')).body.lastRun.error, /failed/, 'partial discovery is reported');
const preserved = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; echo json_encode(monitorReadFile(monitorQueueFile('test.example','legacy-pending')));`));
assert.equal(preserved.status, 'pending');
const partialSaved = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; echo json_encode(monitorReadFile(monitorQueueFile('test.example','cdr-partial')));`));
assert.equal(partialSaved.status, 'pending', 'partial discovery rows are retained even when the scan fails');
await h.seedPbx('fetchCdrsPages', []);
await h.script(`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php'; $s=monitorUpdate('test.example', function ($s) { $s['since']=time()-100000; return $s; }); monitorQueueCdr('test.example','expired',time()-95000,time()-90000,$s);`);
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const expired = await req('monitor_status');
assert.ok(expired.body.reviews.items.some(item => item.callid === 'expired' && /24 hours/.test(item.reason)), 'expired CDR needs review');
assert.equal((await req('monitor_enable', { enabled: false })).body.enabled, false);
console.log('INTELLIGENCE MONITOR OK — polling, retry, tenant isolation, deduplication and review');
