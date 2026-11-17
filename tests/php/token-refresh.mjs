import assert from 'node:assert/strict';
import { PhpHarness } from './php.mjs';
const h = await new PhpHarness();
await h.boot();
await h.write('includes/config.local.php', `<?php
define('PBX_SERVERS', ['nms1' => 'https://pbx.example']);
define('PBX_CLIENT_ID', 'id');
define('PBX_CLIENT_SECRET', 'secret');
`);
const raw = await h.script(`
require_once TEST_TMP . '/includes/auth.php';
foreach (['CURLOPT_POST','CURLOPT_RETURNTRANSFER','CURLOPT_TIMEOUT','CURLOPT_HTTPHEADER','CURLOPT_POSTFIELDS','CURLINFO_RESPONSE_CODE'] as $i => $name) if (!defined($name)) define($name, $i + 1);
$GLOBALS['refreshCalls'] = 0;
function curl_init($url) { $GLOBALS['refreshCalls']++; return new stdClass(); }
function curl_setopt_array($ch, $options) { return true; }
function curl_exec($ch) { return json_encode(['access_token'=>'new-access','refresh_token'=>'new-refresh','expires_in'=>3600]); }
function curl_getinfo($ch, $opt) { return 200; }
function curl_close($ch) {}
session_save_path(TEST_TMP . '/cache');
session_id('refresh-test'); session_start();
$_SESSION = ['token'=>'old-access','refresh_token'=>'old-refresh','token_expires_at'=>time()+3600,'pbx_client_id'=>'id','last_activity'=>time(),'user'=>['username'=>'om','domain'=>'test.example']];
session_write_close();
$first = refreshPbxToken('old-access');
session_start();
$persisted = [$_SESSION['token'] ?? '', $_SESSION['refresh_token'] ?? ''];
$_SESSION['token'] = 'other-access';
$_SESSION['refresh_token'] = 'other-refresh';
$_SESSION['token_expires_at'] = time()+3600;
session_write_close();
$_SESSION['token'] = 'old-access';
$_SESSION['refresh_token'] = 'old-refresh';
$reused = refreshPbxToken('old-access');
$afterReuse = $_SESSION['token'] ?? '';
session_start(); $_SESSION = []; session_write_close();
$_SESSION = ['token'=>'old-access','refresh_token'=>'old-refresh','user'=>['username'=>'om','domain'=>'test.example'],'last_activity'=>time()];
$ended = refreshPbxToken('old-access');
echo json_encode(['first'=>$first,'persisted'=>$persisted,'reused'=>$reused,'afterReuse'=>$afterReuse,'ended'=>$ended,'calls'=>$GLOBALS['refreshCalls']]);
`);
const result = JSON.parse(raw.trim());
assert.equal(result.first, true);
assert.deepEqual(result.persisted, ['new-access', 'new-refresh']);
assert.equal(result.reused, true);
assert.equal(result.afterReuse, 'other-access');
assert.equal(result.calls, 1, 'concurrent rotation should not refresh twice');
assert.equal(result.ended, false, 'a logged-out session cannot be resurrected');
console.log('TOKEN REFRESH OK — persisted rotation, concurrent reuse and logout');
