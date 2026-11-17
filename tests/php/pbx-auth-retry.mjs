import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PhpHarness, ROOT } from './php.mjs';
const h = await new PhpHarness();
await h.boot();
await h.write('includes/PbxClient.php', readFileSync(path.join(ROOT, 'includes/PbxClient.php'), 'utf8'));
await h.write('includes/config.local.php', `<?php
define('PBX_SERVERS', ['nms1'=>'https://pbx.example']);
define('PBX_CLIENT_ID', 'id'); define('PBX_CLIENT_SECRET', 'secret');
define('CDR_PAGE_SIZE', 1); define('PBX_REQUESTS_PER_SECOND', 50);
`);
const raw = await h.script(`
require_once TEST_TMP . '/includes/auth.php';
require_once TEST_TMP . '/includes/PbxClient.php';
foreach (['CURLOPT_POST','CURLOPT_POSTFIELDS','CURLOPT_RETURNTRANSFER','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLOPT_HTTPHEADER','CURLOPT_ENCODING','CURLOPT_TCP_KEEPALIVE','CURLOPT_HTTP_VERSION','CURL_HTTP_VERSION_1_1','CURLINFO_RESPONSE_CODE','CURLM_OK'] as $i => $name) if (!defined($name)) define($name, $i + 1);
$GLOBALS['refreshCalls'] = 0; $GLOBALS['events'] = []; $GLOBALS['transcriptionUrl'] = '';
function curl_init($url) { return (object)['url'=>$url,'opts'=>[],'status'=>0,'body'=>'']; }
function curl_setopt_array($c, $opts) { $c->opts=$opts; return true; }
function curl_exec($c) { $c->status=200; if (str_contains($c->url, '/tokens')) { $GLOBALS['refreshCalls']++; return json_encode(['access_token'=>'new','refresh_token'=>'rotated','expires_in'=>3600]); } $GLOBALS['transcriptionUrl']=$c->url; return json_encode(['call-intelligence-job-id'=>330696339]); }
function curl_getinfo($c, $key) { return $c->status; }
function curl_errno($c) { return 0; }
function curl_error($c) { return ''; }
function curl_close($c) {}
function curl_multi_init() { return (object)['handles'=>[]]; }
function curl_multi_add_handle($mh,$c) { $mh->handles[]=$c; }
function curl_multi_exec($mh,&$running) {
    foreach ($mh->handles as $c) {
        $headers=$c->opts[CURLOPT_HTTPHEADER] ?? [];
        $new=in_array('Authorization: Bearer new', $headers, true);
        parse_str((string)parse_url($c->url, PHP_URL_QUERY), $query);
        $offset=(int)($query['start'] ?? 0);
        $GLOBALS['events'][]=[$offset,$new];
        $c->status=$new ? 200 : 401;
        $c->body=$new ? json_encode($offset < 2 ? [['id'=>'call-'.$offset,'call-start-datetime'=>'2026-11-17T10:00:00Z']] : []) : '{}';
    }
    $running=0; return CURLM_OK;
}
function curl_multi_getcontent($c) { return $c->body; }
function curl_multi_remove_handle($mh,$c) {}
function curl_multi_close($mh) {}
session_save_path(TEST_TMP . '/cache'); session_id('retry-test'); session_start();
$_SESSION = ['token'=>'old','refresh_token'=>'old-refresh','token_expires_at'=>time()+3600,'pbx_client_id'=>'id','last_activity'=>time(),'user'=>['username'=>'om','domain'=>'test.example']];
session_write_close();
$client=new PbxClient('old');
$result=$client->fetchCdrs('test.example','2026-11-17T00:00:00Z','2026-11-17T23:59:59Z');
$client->transcription('nms1', 'test.example', '330696339', '202611', ['orig_callid'=>'orig@pbx','term_callid'=>'term@pbx','by_callid'=>'through@pbx']);
parse_str((string)parse_url($GLOBALS['transcriptionUrl'], PHP_URL_QUERY), $lookupQuery);
$invalid = false; try { $client->transcription('nms1', 'test.example', '330696339', '202611', ['redirect'=>'https://untrusted.example']); } catch (InvalidArgumentException $e) { $invalid=true; }
echo json_encode(['complete'=>$result['complete'],'count'=>count($result['records']),'refreshes'=>$GLOBALS['refreshCalls'],'events'=>$GLOBALS['events'],'lookupQuery'=>$lookupQuery,'invalid'=>$invalid]);
`);
const out = JSON.parse(raw.trim());
assert.equal(out.complete, true);
assert.equal(out.count, 2);
assert.equal(out.refreshes, 1, 'one refresh for a batch of 401s');
assert.deepEqual(out.lookupQuery, {id: '330696339', date: '202611', orig_callid: 'orig@pbx', term_callid: 'term@pbx', by_callid: 'through@pbx'});
assert.equal(out.invalid, true, 'unexpected query parameters are rejected');
assert.deepEqual(out.events.filter(e => e[1]).map(e => e[0]), [0, 1, 2, 3], 'every 401 page retried with new token');
console.log('PBX RETRY OK — all 401 pages replayed after one refresh');

// The PHP-WASM set_time_limit timer otherwise keeps Node alive after the test.
process.exit(0);
