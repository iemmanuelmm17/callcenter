import assert from 'node:assert/strict';
import { PhpHarness, USERS } from './php.mjs';
const h = await new PhpHarness();
await h.boot();
const bootstrap = await h.readInterpreterFile('includes/bootstrap.php');
await h.write('includes/bootstrap.php', bootstrap + `
foreach (['CURLOPT_USERNAME','CURLOPT_PASSWORD','CURLOPT_USE_SSL','CURLOPT_SSL_VERIFYPEER','CURLOPT_SSL_VERIFYHOST','CURLOPT_NOBODY','CURLOPT_CUSTOMREQUEST','CURLOPT_RETURNTRANSFER','CURLOPT_MAIL_FROM','CURLOPT_MAIL_RCPT','CURLOPT_UPLOAD','CURLOPT_INFILE','CURLOPT_INFILESIZE','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLUSESSL_ALL','CURLINFO_CONNECT_TIME','CURLINFO_TOTAL_TIME'] as $i => $name) if (!defined($name)) define($name, $i + 100);
function curl_init($url) { return (object)['url'=>$url,'opts'=>[]]; }
function curl_setopt_array($curl, $opts) { $curl->opts=$opts; return true; }
function curl_exec($curl) {
  $opts=$curl->opts;
  $info=['url'=>$curl->url, 'noop'=>$opts[CURLOPT_CUSTOMREQUEST] ?? null, 'nobody'=>$opts[CURLOPT_NOBODY] ?? false, 'tls'=>$opts[CURLOPT_USE_SSL] ?? null, 'verify'=>$opts[CURLOPT_SSL_VERIFYPEER] ?? null, 'hostverify'=>$opts[CURLOPT_SSL_VERIFYHOST] ?? null, 'timeout'=>$opts[CURLOPT_TIMEOUT] ?? null, 'connecttimeout'=>$opts[CURLOPT_CONNECTTIMEOUT] ?? null, 'rcpt'=>$opts[CURLOPT_MAIL_RCPT] ?? [], 'upload'=>$opts[CURLOPT_UPLOAD] ?? false];
  if (isset($opts[CURLOPT_INFILE])) $info['payload']=stream_get_contents($opts[CURLOPT_INFILE]);
  file_put_contents(TEST_TMP . '/smtp-call.json', json_encode($info));
  return is_file(TEST_TMP . '/smtp-fail') ? false : (empty($info['upload']) ? '' : true);
}
function curl_errno($curl) { return 28; }
function curl_getinfo($curl, $info) { return $info === CURLINFO_CONNECT_TIME ? 0.4 : 30; }
function curl_close($curl) {}
`);
const req = (action, data = {}, user = USERS.office_manager) => h.request('intelligence.php', { user, body: { action, ...data } });
for (const role of ['supervisor', 'agent', 'basic_user']) {
  assert.equal((await req('smtp_diagnostic', {}, USERS[role])).status, 403);
  assert.equal((await req('smtp_test_email', {recipient:'test@example.com'}, USERS[role])).status, 403);
}
assert.equal((await h.request('intelligence.php', {body:{action:'smtp_diagnostic'}})).status, 401);
assert.equal((await req('smtp_diagnostic')).status, 503);
const smtpConfig = `<?php
  define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
  define('INTELLIGENCE_SMTP_HOST', 'smtp.example.com'); define('INTELLIGENCE_SMTP_PORT', 587);
  define('INTELLIGENCE_SMTP_USERNAME', 'private-user'); define('INTELLIGENCE_SMTP_PASSWORD', 'private-password'); define('INTELLIGENCE_SMTP_FROM', 'sender@example.com');
`;
await h.write('includes/config.local.php', smtpConfig);
const stateBefore = (await req('monitor_recipients', {recipients:'alerts@example.com'})).body;
let response = await req('smtp_diagnostic');
assert.equal(response.status, 200, JSON.stringify(response));
assert.equal(response.body.ok, true);
assert.equal(response.body.tcpConnected, true);
assert(!JSON.stringify(response).includes('private-'));
let call = JSON.parse(await h.readInterpreterFile('smtp-call.json'));
assert.deepEqual([call.noop,call.nobody,call.upload,call.rcpt.length], ['NOOP',true,false,0]);
assert.equal(call.tls, 115); // CURLUSESSL_ALL, defined by this stub
assert.equal(call.verify, true); assert.equal(call.hostverify, 2);
assert.equal(call.timeout, 30); assert.equal(call.connecttimeout, 10);
for (const recipient of ['bad', 'x@example.com\nBcc:x@example.com', '', ['x@example.com']]) assert.equal((await req('smtp_test_email', {recipient})).status, 422);
response = await req('smtp_test_email', {recipient:'test@example.com'});
assert.deepEqual(response.body, {ok:true});
call = JSON.parse(await h.readInterpreterFile('smtp-call.json'));
assert.deepEqual(call.rcpt, ['<test@example.com>']);
assert.equal(call.upload, true);
assert.match(call.payload, /Subject: CallScope SMTP test/);
assert.match(Buffer.from(call.payload.split('\r\n\r\n')[1].replace(/\s/g,''), 'base64').toString(), /contains no call data/);
await h.write('smtp-fail', 'yes');
response = await req('smtp_diagnostic');
assert.equal(response.body.ok, false); assert.equal(response.body.code, 28); assert.match(response.body.description, /timed out/);
response = await req('smtp_test_email', {recipient:'test@example.com'});
assert.equal(response.body.ok, false); assert.equal(response.body.code, 28); assert.match(response.body.description, /timed out/);
assert(!JSON.stringify(response).includes('private-'));
// The same timeout applies to diagnostic and the shared mail sender; connection stays separate.
for (const seconds of [1, 90, 300]) {
  await h.write('includes/config.local.php', smtpConfig + `\ndefine('INTELLIGENCE_SMTP_TIMEOUT', ${seconds});\n`);
  for (const [action, data] of [['smtp_diagnostic', {}], ['smtp_test_email', {recipient:'test@example.com'}]]) {
    const r = await req(action, data);
    assert.equal(r.body.code, 28);
    call = JSON.parse(await h.readInterpreterFile('smtp-call.json'));
    assert.equal(call.timeout, seconds); assert.equal(call.connecttimeout, 10);
  }
}
for (const invalid of ['0', '-1', '301', "'60'", '1.5', 'false']) {
  await h.write('includes/config.local.php', smtpConfig + `\ndefine('INTELLIGENCE_SMTP_TIMEOUT', ${invalid});\n`);
  for (const [action, data] of [['smtp_diagnostic', {}], ['smtp_test_email', {recipient:'test@example.com'}], ['send', {}]]) {
    const r = await req(action, data); assert.equal(r.status, 503); assert.match(r.body.error, /integer from 1 to 300/);
  }
  const parsed = JSON.parse(await h.script(`require_once TEST_TMP . '/includes/intelligence.php'; echo json_encode([intelligenceSmtpTimeout(), intelligenceSmtpConfigured()]);`));
  assert.deepEqual(parsed, [null, false]);
}
await h.write('includes/config.local.php', smtpConfig);
const stateAfter = (await req('monitor_status')).body;
assert.deepEqual(stateAfter.recipients, stateBefore.recipients);
assert.equal(stateAfter.enabled, false);
assert.equal(stateAfter.reviews.total, 0);
console.log('SMTP DIAGNOSTIC OK — authorization, no-delivery probe, test mail and timeout');
