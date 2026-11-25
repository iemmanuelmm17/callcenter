import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT, USERS } from './php.mjs';
const h = await new PhpHarness(); await h.boot();
await h.write('includes/config.local.php', `<?php
 define('PBX_SERVERS',['nms1'=>'https://pbx.example']); define('INTELLIGENCE_MONITOR_API_KEY','key');
 define('INTELLIGENCE_SMTP_HOST','smtp.example'); define('INTELLIGENCE_SMTP_PORT',587);
 define('INTELLIGENCE_SMTP_USERNAME','user'); define('INTELLIGENCE_SMTP_PASSWORD','password'); define('INTELLIGENCE_SMTP_FROM','sender@example.com');
`);
const bootstrap=await h.readInterpreterFile('includes/bootstrap.php');
await h.write('includes/bootstrap.php', bootstrap + `
foreach (['CURLOPT_USERNAME','CURLOPT_PASSWORD','CURLOPT_USE_SSL','CURLOPT_SSL_VERIFYPEER','CURLOPT_SSL_VERIFYHOST','CURLOPT_MAIL_FROM','CURLOPT_MAIL_RCPT','CURLOPT_UPLOAD','CURLOPT_INFILE','CURLOPT_INFILESIZE','CURLOPT_TIMEOUT','CURLOPT_CONNECTTIMEOUT','CURLUSESSL_ALL'] as $i => $n) if (!defined($n)) define($n, $i + 100);
function curl_init($url) { return new stdClass(); } function curl_setopt_array($c,$o) { return true; }
function curl_exec($c) { file_put_contents(TEST_TMP.'/smtp-attempts','1',FILE_APPEND); return !is_file(TEST_TMP.'/smtp-fail'); }
function curl_errno($c) { return 28; } function curl_close($c) {}
`);
await h.write('tools/intelligence-monitor.php',readFileSync(path.join(ROOT,'tools/intelligence-monitor.php'),'utf8'));
const req=(action,data={},user=USERS.office_manager)=>h.request('intelligence.php',{user,body:{action,...data}});
const requires=`require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php';`;
const script=s=>h.script(`${requires} ${s}`);
const run=()=>h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const now=Math.floor(Date.now()/1000), start=now-30*3600, end=start+600;
const stamp=x=>new Date(x*1000).toISOString();
const call=(id,t=start)=>({id,domain:'test.example',_server:'nms1','call-start-datetime':stamp(t),'call-disconnect-datetime':stamp(t+600),'call-intelligence-job-id':'123','prefilled-transcription-api':`/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=${id}`});
await h.seedPbx('filterCdrWindows',true);
await h.seedPbx('transcription',{'call-intelligence-job-id':'123','call-intelligence-processing-status':'finished','call-intelligence-summary-status':'success','call-intelligence-summary':'urgent help','call-intelligence-topics-top':['urgent'],'call-intelligence-segments':[]});
await script(`intelligenceSaveWatches('test.example',['urgent']); monitorSaveRecipients('test.example','a@example.com'); monitorSetEnabled('test.example',true); monitorUpdate('test.example',function($s){$s['since']=time()-200000; $s['discoveryCursor']=time()-86400; return $s;});`);
// Start with an uncertain old job and a completed original queue tombstone.
const old=call('old-uncertain');
await h.seedPbx('fetchCdrs',[old]);
const jobId=JSON.parse(await script(`$call=json_decode(${JSON.stringify(JSON.stringify(old))},true); $s=monitorState('test.example'); $reason=null; $ref=intelligenceReference($call,'test.example','',$reason); $id='job-'.monitorDomainId('test.example').'-'.monitorJobKey($ref); monitorWriteFile(monitorDirectory().'/'.$id.'.json',['status'=>'review','cdrId'=>$call['id'],'callid'=>$ref['callid'],'startedAt'=>$call['call-start-datetime'],'reason'=>'SMTP delivery uncertain']); monitorQueueCdr('test.example',$call['id'],${start},${end},$s); $q=monitorReadFile(monitorQueueFile('test.example',$call['id'])); monitorQueueFinish('test.example',$q,'done'); echo json_encode($id);`));
assert.equal((await req('monitor_reviewed',{id:jobId},{...USERS.office_manager,domain:'other.example'})).status,422);
let response=await req('monitor_reviewed',{id:jobId}); assert.equal(response.status,200); assert.equal(response.body.retryCount,1);
assert.equal((await req('monitor_reviewed',{id:jobId})).status,422,'a pending retry cannot be queued again');
let job=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${jobId}.json'));`));
assert.equal(job.status,'retry_pending'); assert(job.retryUntil >= now+86395); assert.equal((await h.readInterpreterFile('smtp-attempts')).length,0,'marking review does not send immediately');
await h.write('smtp-fail','1'); await run();
job=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${jobId}.json'));`));
assert.equal(job.status,'retry_pending','an SMTP timeout stays queued within the new window'); assert.equal(job.retryReason,'smtp'); assert(job.retryNext>now);
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,1);
await script(`@unlink(TEST_TMP.'/smtp-fail'); $f=monitorDirectory().'/${jobId}.json'; $x=monitorReadFile($f); $x['retryNext']=time()-1; monitorWriteFile($f,$x);`);
await run();
job=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${jobId}.json'));`));
assert.equal(job.status,'sent'); assert.equal((await h.readInterpreterFile('smtp-attempts')).length,2);
await run(); assert.equal((await h.readInterpreterFile('smtp-attempts')).length,2,'success is not sent again');
assert.equal((await req('monitor_status')).body.retryCount,0);
// A CDR review can be retried despite its old completed queue tombstone.
const cdr=call('cdr-review',start+1200); await h.seedPbx('fetchCdrs',[cdr]);
let cdrReview=JSON.parse(await script(`$call=json_decode(${JSON.stringify(JSON.stringify(cdr))},true); monitorReviewCdr('test.example',$call,'incomplete'); echo json_encode(monitorReviews('test.example')['items'][0]['id']);`));
assert.equal((await req('monitor_reviewed',{id:cdrReview})).status,200);
await run();
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,3);
let item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${cdrReview}.json'));`)); assert.equal(item.status,'reviewed');
// CDR reviews also retry ambiguous SMTP failures and survive a renewed window.
const cdrFail=call('cdr-fail',start+1800); await h.seedPbx('fetchCdrs',[cdrFail]);
const cdrFailReview=JSON.parse(await script(`$c=json_decode(${JSON.stringify(JSON.stringify(cdrFail))},true); monitorReviewCdr('test.example',$c,'incomplete'); $r=monitorReviews('test.example'); echo json_encode(array_values(array_filter($r['items'],fn($x)=>$x['cdrId']==='cdr-fail'))[0]['id']);`));
assert.equal((await req('monitor_reviewed',{id:cdrFailReview})).status,200);
await h.write('smtp-fail','1'); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${cdrFailReview}.json'));`)); assert.equal(item.status,'retry_pending'); assert.equal(item.retryReason,'smtp');
await script(`@unlink(TEST_TMP.'/smtp-fail'); $f=monitorDirectory().'/${cdrFailReview}.json'; $x=monitorReadFile($f); $x['retryNext']=time()-1; monitorWriteFile($f,$x);`);
await run(); item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${cdrFailReview}.json'));`)); assert.equal(item.status,'reviewed');
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,5);
// An expired CDR retry can be reviewed and retried again after a previous SMTP failure.
const renewCall=call('renew',start+1850); await h.seedPbx('fetchCdrs',[renewCall]);
const renewId=JSON.parse(await script(`$c=json_decode(${JSON.stringify(JSON.stringify(renewCall))},true); monitorReviewCdr('test.example',$c,'unavailable'); $x=monitorReviews('test.example'); echo json_encode(array_values(array_filter($x['items'],fn($v)=>$v['cdrId']==='renew'))[0]['id']);`));
await req('monitor_reviewed',{id:renewId}); await h.write('smtp-fail','1'); await run();
await script(`@unlink(TEST_TMP.'/smtp-fail'); $f=monitorDirectory().'/${renewId}.json'; $x=monitorReadFile($f); $x['retryUntil']=time()-1; monitorWriteFile($f,$x);`); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${renewId}.json'));`)); assert.equal(item.status,'review');
await req('monitor_reviewed',{id:renewId}); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${renewId}.json'));`)); assert.equal(item.status,'reviewed');
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,7);
// Clearing recipients pauses retries, and expiry still returns them to review.
const pausedCall=call('paused',start+1900); await h.seedPbx('fetchCdrs',[pausedCall]);
const pausedId=JSON.parse(await script(`$c=json_decode(${JSON.stringify(JSON.stringify(pausedCall))},true); monitorReviewCdr('test.example',$c,'unavailable'); $x=monitorReviews('test.example'); echo json_encode(array_values(array_filter($x['items'],fn($v)=>$v['cdrId']==='paused'))[0]['id']);`));
await req('monitor_reviewed',{id:pausedId}); await req('monitor_recipients',{recipients:''}); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${pausedId}.json'));`)); assert.equal(item.status,'retry_pending'); assert.equal((await h.readInterpreterFile('smtp-attempts')).length,7);
await script(`$f=monitorDirectory().'/${pausedId}.json'; $x=monitorReadFile($f); $x['retryUntil']=time()-1; monitorWriteFile($f,$x);`); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${pausedId}.json'));`)); assert.equal(item.status,'review');
await req('monitor_recipients',{recipients:'a@example.com'});
// A conflicting existing sent job is never silently reset by another review.
const conflict=call('conflict',start+2100); await h.seedPbx('fetchCdrs',[conflict]);
const conflictReview=JSON.parse(await script(`$c=json_decode(${JSON.stringify(JSON.stringify(conflict))},true); $reason=null; $r=intelligenceReference($c,'test.example','',$reason); monitorJob('test.example',$r,fn($job)=>['status'=>'sent','time'=>time()]); monitorReviewCdr('test.example',$c,'separate review'); $x=monitorReviews('test.example'); echo json_encode(array_values(array_filter($x['items'],fn($v)=>$v['cdrId']==='conflict'))[0]['id']);`));
await req('monitor_reviewed',{id:conflictReview}); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${conflictReview}.json'));`)); assert.equal(item.status,'review'); assert.match(item.reason,/separate automatic check/);
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,7);
// Missing identity remains outstanding rather than guessing.
const missing=JSON.parse(await script(`monitorReviewCdr('test.example',['id'=>'no-time'],'unknown time'); $x=monitorReviews('test.example'); echo json_encode(array_values(array_filter($x['items'],fn($r)=>$r['cdrId']==='no-time'))[0]['id']);`));
response=await req('monitor_reviewed',{id:missing}); assert.equal(response.status,422); assert.match(response.body.error,/remains for manual review/);
assert((await req('monitor_status')).body.reviews.items.some(x=>x.id===missing));
// Missing CDR stays pending, then returns to review after its renewed deadline.
const missCall=call('disappeared',start+2400);
const expiredId=JSON.parse(await script(`$c=json_decode(${JSON.stringify(JSON.stringify(missCall))},true); monitorReviewCdr('test.example',$c,'missing'); $r=monitorReviews('test.example'); echo json_encode(array_values(array_filter($r['items'],fn($x)=>$x['cdrId']==='disappeared'))[0]['id']);`));
await req('monitor_reviewed',{id:expiredId}); await h.seedPbx('fetchCdrs',[]); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${expiredId}.json'));`)); assert.equal(item.status,'retry_pending'); assert.equal(item.retryReason,'cdr');
await script(`$f=monitorDirectory().'/${expiredId}.json'; $x=monitorReadFile($f); $x['retryUntil']=time()-1; monitorWriteFile($f,$x);`); await run();
item=JSON.parse(await script(`echo json_encode(monitorReadFile(monitorDirectory().'/${expiredId}.json'));`)); assert.equal(item.status,'review'); assert.match(item.reason,/expired after 24 hours/);
assert.equal((await h.readInterpreterFile('smtp-attempts')).length,7,'missing or expired retries never send');
console.log('REVIEW RETRY OK — durable requeue, SMTP retry, deduplication, old calls, safety and expiry');
process.exit(0);
