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
const output = await h.script(`
require_once TEST_TMP . '/includes/reporting.php';
require_once TEST_TMP . '/includes/intelligence.php';
require_once TEST_TMP . '/includes/intelligence-monitor.php';
foreach (['CURLOPT_USERNAME','CURLOPT_PASSWORD','CURLOPT_USE_SSL','CURLOPT_SSL_VERIFYPEER','CURLOPT_SSL_VERIFYHOST','CURLOPT_MAIL_FROM','CURLOPT_MAIL_RCPT','CURLOPT_UPLOAD','CURLOPT_INFILE','CURLOPT_INFILESIZE','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLUSESSL_ALL'] as $i => $n) if (!defined($n)) define($n, $i + 100);
function curl_init($url) { return new stdClass(); }
function curl_setopt_array($curl, $opts) { return true; }
function curl_exec($curl) { $GLOBALS['sends']++; return !$GLOBALS['fail']; }
function curl_close($curl) {}
$GLOBALS['sends'] = 0; $GLOBALS['fail'] = false;
$domain = 'test.example';
intelligenceSaveWatches($domain, ['urgent']);
monitorSetEnabled($domain, true);
$state = monitorUpdate($domain, function ($s) { $s['since'] = time() - 100; return $s; });
$make = function ($id) use ($domain) { return ['id'=>'cdr-'.$id, '_server'=>'nms1', 'call-start-datetime'=>gmdate('c', time()-40), 'call-disconnect-datetime'=>gmdate('c', time()-20), 'call-intelligence-job-id'=>'123', 'prefilled-transcription-api'=>'/ns-api/v2/domains/'.$domain.'/transcriptions?id=123&date=202611&callid='.$id]; };
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
$missing = $make('four'); unset($missing['call-intelligence-job-id']); $missing['call-disconnect-datetime'] = gmdate('c', time()-90000);
$state['since'] = time()-100000;
monitorProcessCall($client, $domain, $missing, $state, $counts);
echo json_encode(['sends'=>$GLOBALS['sends'], 'counts'=>$counts, 'reviews'=>monitorReviews($domain)]);
`);
const result = JSON.parse(output.trim());
assert.equal(result.sends, 2, 'duplicate and report-checked calls send nothing; uncertain delivery is not retried');
assert.equal(result.counts.sent, 1);
assert.equal(result.reviews.total, 2, JSON.stringify(result));
assert.match(JSON.stringify(result.reviews), /uncertain/);
assert.match(JSON.stringify(result.reviews), /unavailable after 24 hours/);
const review = result.reviews.items[0];
assert.equal((await req('monitor_reviewed', { id: review.id }, { ...USERS.office_manager, domain: 'another.test' })).status, 422, 'review is tenant scoped');
assert.equal((await req('monitor_reviewed', { id: review.id })).body.reviews.total, 1);
// Exercise the real scheduled entry point with the PBX stub and a complete,
// unmatched job: repeat-day discovery still finishes it exactly once.
await h.seedPbx('transcription', { 'call-intelligence-job-id': '123', 'call-intelligence-processing-status': 'finished', 'call-intelligence-summary-status': 'success', 'call-intelligence-summary': 'all good', 'call-intelligence-topics-top': ['billing'], 'call-intelligence-segments': [] });
await h.seedPbx('fetchCdrs', [{ id: 'cdr-cron', _server: 'nms1', 'call-start-datetime': new Date(Date.now()-40000).toISOString(), 'call-disconnect-datetime': new Date(Date.now()-20000).toISOString(), 'call-intelligence-job-id': '123', 'prefilled-transcription-api': '/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=cron' }]);
await h.write('tools/intelligence-monitor.php', readFileSync(path.join(ROOT, 'tools/intelligence-monitor.php'), 'utf8'));
await h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const after = await req('monitor_status');
assert.equal(after.body.lastRun.counts.checked, 1, JSON.stringify(after.body));
assert.equal(after.body.lastRun.error, '');
assert.equal((await req('monitor_enable', { enabled: false })).body.enabled, false);
console.log('INTELLIGENCE MONITOR OK — tenant controls, report suppression, deduplication, and review');
