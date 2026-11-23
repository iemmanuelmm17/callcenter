import assert from 'node:assert/strict';
import { PhpHarness } from './php.mjs';
const h = await new PhpHarness();
await h.boot();
await h.write('includes/config.local.php', `<?php
define('PBX_SERVERS', ['nms1'=>'https://pbx.example']);
define('INTELLIGENCE_MONITOR_API_KEY', 'secret-service-key');
`);
const init = `require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';`;
const call = `['call-direction'=>1,'call-term-user'=>'sip:222@test.example','call-term-call-id'=>'abc']`;
const url = 'https://recordings.example.com/audio/abc.wav?token=a%2Fb&Expires=123#start';
await h.seedPbx('recording', { 'file-access-url': url });
const result = JSON.parse(await h.script(`${init}
$link=intelligenceRecordingLink(new PbxClient('key'), 'test.example', ${call});
$missing=intelligenceRecordingLink(new PbxClient('key'), 'test.example', []);
$message=intelligenceAutomaticMessage('test.example', [], ['callid'=>'abc'], ['summary'=>'URGENT <script>','topics'=>['urgent'],'matches'=>[['keyword'=>'urgent','source'=>'summary','excerpt'=>'URGENT <script>']]], $link);
echo json_encode(['link'=>$link, 'missing'=>$missing, 'message'=>$message]);`));
assert.equal(result.link, url, 'signed PBX URL, including query and fragment, is unchanged');
assert.equal(result.missing, null);
assert(result.message.text.includes(url));
assert(result.message.html.includes('href="https://recordings.example.com/audio/abc.wav?token=a%2Fb&amp;Expires=123#start"'));
assert(!result.message.html.includes('<script>'));
assert.match(result.message.html, /<mark[^>]*>URGENT<\/mark>/);
assert.doesNotMatch(result.message.text, /30 days/);
assert.doesNotMatch(result.message.html, /30 days/);
assert.match(result.message.text, /recording server controls its availability and expiration/);
assert(!(await h.pbxCalls()).some(x=>String(x).startsWith('download:') || String(x).startsWith('downloadPublic:')), 'issuing direct URLs never fetches audio');
assert.equal((await h.script(`${init} intelligenceRecordingPrune(); echo is_dir(monitorDirectory().'/recording-links')?'created':'absent';`)).trim(),'absent','new installs do not create legacy link storage');
const fallback = JSON.parse(await h.script(`${init} echo json_encode(intelligenceAutomaticMessage('test.example', [], ['callid'=>'abc'], ['summary'=>'urgent','topics'=>[],'matches'=>[['keyword'=>'urgent','source'=>'summary','excerpt'=>'urgent']]], null));`));
assert.match(fallback.text, /Recording download link unavailable/);
assert(!fallback.html.includes('Listen to recording'));
for (const unsafe of ['javascript:alert(1)', 'http://recordings.example.com/audio.wav', 'https://user:pass@recordings.example.com/a.wav', 'https://recordings.example.com/a\r\nLocation: https://evil.example/', 'https://recordings.example.com\\evil.example/a', 'https://recordings.example.com/a b']) {
  await h.seedPbx('recording', {'file-access-url':unsafe});
  assert.equal((await h.script(`${init} echo intelligenceRecordingLink(new PbxClient('key'), 'test.example', ${call}) ?? 'rejected';`)).trim(), 'rejected', unsafe);
}
await h.seedPbx('recording', {'file-access-url':null});
assert.equal((await h.script(`${init} echo intelligenceRecordingLink(new PbxClient('key'), 'test.example', ${call}) ?? 'rejected';`)).trim(), 'rejected');

// Previously sent app links remain redeemable until their original expiration,
// but redirect without fetching audio or forwarding the service key.
await h.seedPbx('recording', {'file-access-url':url});
const legacy = JSON.parse(await h.script(`${init}
$now=time(); $token=sprintf('%08x',$now).bin2hex(random_bytes(32)); $file=intelligenceRecordingTokenFile($token); @mkdir(dirname($file),0700,true);
monitorWriteFile($file,['created'=>$now,'domain'=>'test.example','user'=>'222','callId'=>'abc']);
$bad=substr($token,0,-1).(substr($token,-1)==='a'?'b':'a');
echo json_encode(['token'=>$token,'resolved'=>intelligenceRecordingResolve($token),'tampered'=>intelligenceRecordingResolve($bad),'expired'=>intelligenceRecordingResolve(sprintf('%08x',time()-30*86400).str_repeat('a',64))]);`));
assert.equal(legacy.resolved.user,'222'); assert.equal(legacy.tampered,null); assert.equal(legacy.expired,null);
const invalid = await h.script(`$_SERVER['REQUEST_METHOD']='POST'; $_POST=['token'=>'bad']; require TEST_TMP . '/api/intelligence-recording.php';`);
assert.match(invalid, /invalid or expired/);
const landing = await h.script(`$_SERVER['REQUEST_METHOD']='GET'; require TEST_TMP . '/api/intelligence-recording.php';`);
assert.match(landing, /location\.hash/);
await h.script(`@unlink(TEST_TMP . '/pbx-calls.jsonl');`);
const redirect = JSON.parse(await h.script(`$_SERVER['REQUEST_METHOD']='POST'; $_POST=['token'=>'${legacy.token}']; require TEST_TMP . '/api/intelligence-recording.php'; echo json_encode(['status'=>http_response_code(),'headers'=>headers_list()]);`));
assert.equal(redirect.status,303);
assert(redirect.headers.includes('Location: '+url));
assert(redirect.headers.some(x=>x==='Referrer-Policy: no-referrer'));
assert(!JSON.stringify(redirect).includes('secret-service-key'));
assert(!(await h.pbxCalls()).some(x=>String(x).startsWith('download:') || String(x).startsWith('downloadPublic:')), 'legacy redirect never fetches audio');
console.log('INTELLIGENCE RECORDING OK — direct URL, safe formatting and legacy redirect');
