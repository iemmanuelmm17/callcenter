import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT } from './php.mjs';
const h = await new PhpHarness(); await h.boot();
await h.write('includes/PbxClient.php', readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8'));
await h.write('includes/config.local.php', `<?php define('PBX_SERVERS',['nms1'=>'https://pbx.example']); define('PBX_REQUESTS_PER_SECOND',50);`);
const result = JSON.parse(await h.script(`
require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php';
foreach (['CURLOPT_RETURNTRANSFER','CURLOPT_CONNECTTIMEOUT','CURLOPT_TIMEOUT','CURLOPT_HTTPHEADER','CURLOPT_ENCODING','CURLOPT_TCP_KEEPALIVE','CURLOPT_HTTP_VERSION','CURL_HTTP_VERSION_1_1','CURLINFO_RESPONSE_CODE'] as $i=>$name) if (!defined($name)) define($name,$i+1);
$GLOBALS['requests']=[];
function curl_init($url) { return (object)['url'=>$url,'opts'=>[]]; }
function curl_setopt_array($c,$opts) { $c->opts=$opts; return true; }
function curl_exec($c) { $GLOBALS['requests'][]=['url'=>$c->url,'headers'=>$c->opts[CURLOPT_HTTPHEADER]]; return json_encode([['file-access-url'=>'https://cdn.example/audio.wav?signature=redacted']]); }
function curl_getinfo($c,$key) { return 200; }
function curl_errno($c) { return 0; } function curl_error($c) { return ''; } function curl_close($c) {}
$client=new PbxClient('service-secret',true);
$link=intelligenceRecordingLink($client,'test.example',['call-direction'=>1,'call-term-user'=>'sip:222@test.example','call-term-call-id'=>'call@pbx']);
echo json_encode(['link'=>$link,'requests'=>$GLOBALS['requests']]);
`));
assert.equal(result.link,'https://cdn.example/audio.wav?signature=redacted');
assert.equal(result.requests.length,1, 'only the recording metadata endpoint is called');
assert.equal(result.requests[0].url,'https://pbx.example/ns-api/v2/domains/test.example/users/222/recordings/call%40pbx');
assert(result.requests[0].headers.includes('Authorization: Bearer service-secret'));
assert(!result.link.includes('service-secret'));
console.log('INTELLIGENCE RECORDING API OK — correct authenticated lookup, no audio transfer');
process.exit(0);
