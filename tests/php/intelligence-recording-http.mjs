import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PhpHarness, ROOT } from './php.mjs';
const h = await new PhpHarness(); await h.boot();
await h.write('includes/PbxClient.php', readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8'));
await h.write('includes/config.local.php', `<?php define('PBX_SERVERS',['nms1'=>'https://pbx.example']);`);
const result = JSON.parse(await h.script(`
require_once TEST_TMP . '/includes/auth.php'; require_once TEST_TMP . '/includes/PbxClient.php';
foreach (['CURLOPT_RETURNTRANSFER','CURLOPT_FOLLOWLOCATION','CURLOPT_CONNECTTIMEOUT','CURLOPT_TIMEOUT','CURLOPT_HTTPHEADER','CURLOPT_ENCODING','CURLOPT_RESOLVE','CURLOPT_IPRESOLVE','CURLOPT_PROXY','CURL_IPRESOLVE_V4','CURLINFO_RESPONSE_CODE','CURLINFO_CONTENT_TYPE','CURLINFO_REDIRECT_URL'] as $i=>$name) if (!defined($name)) define($name,$i+1);
$GLOBALS['scenario']='public'; $GLOBALS['calls']=[];
function curl_init($url) { return (object)['url'=>$url,'opts'=>[],'status'=>0,'location'=>'']; }
function curl_setopt_array($c,$opts) { $c->opts=$opts; return true; }
function curl_exec($c) { $GLOBALS['calls'][]=['url'=>$c->url,'opts'=>$c->opts]; if (str_contains($c->url,'pbx.example')) { $c->status=302; $c->location=$GLOBALS['scenario']==='private'?'https://127.0.0.1/private':'https://8.8.8.8/audio'; return 'redirect body'; } $c->status=200; return 'RIFF1234WAVEaudio'; }
function curl_getinfo($c,$key) { if($key===CURLINFO_RESPONSE_CODE) return $c->status; if($key===CURLINFO_REDIRECT_URL) return $c->location; return 'audio/wav'; }
function curl_close($c) {}
$client=new PbxClient('service-secret',true); $result=$client->download('https://pbx.example/ns-api/file'); $public=$GLOBALS['calls']; $GLOBALS['calls']=[]; $GLOBALS['scenario']='private'; $refused=$client->download('https://pbx.example/ns-api/file');
echo json_encode(['result'=>$result,'public'=>$public,'private'=>$GLOBALS['calls'],'refused'=>$refused,'httpheader'=>CURLOPT_HTTPHEADER,'resolve'=>CURLOPT_RESOLVE,'proxy'=>CURLOPT_PROXY]);
`));
assert.equal(result.result.ok, true);
assert.equal(result.public.length, 2, 'a 302 with a body must still be followed');
assert(result.public[0].opts[result.httpheader].includes('Authorization: Bearer service-secret'));
assert(!result.public[1].opts[result.httpheader].some(x => x.includes('Authorization')));
assert.deepEqual(result.public[1].opts[result.resolve], ['8.8.8.8:443:8.8.8.8']);
assert.equal(result.public[1].opts[result.proxy], '');
assert.equal(result.refused.ok, false);
assert.equal(result.private.length, 1, 'redirects to private addresses are refused');
console.log('RECORDING HTTP OK — redirects validated and public address pinned');
