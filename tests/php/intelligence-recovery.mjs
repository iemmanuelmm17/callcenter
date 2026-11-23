import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT, USERS } from './php.mjs';
const h = await new PhpHarness(); await h.boot();
await h.write('includes/config.local.php', `<?php
 define('PBX_SERVERS',['nms1'=>'https://pbx.example']); define('INTELLIGENCE_MONITOR_API_KEY','key');
 define('INTELLIGENCE_SMTP_HOST','smtp.example'); define('INTELLIGENCE_SMTP_PORT',587);
 define('INTELLIGENCE_SMTP_USERNAME','sender@example.com'); define('INTELLIGENCE_SMTP_PASSWORD','password'); define('INTELLIGENCE_SMTP_FROM','sender@example.com');
`);
await h.write('tools/intelligence-monitor.php', readFileSync(path.join(ROOT,'tools/intelligence-monitor.php'),'utf8'));
const requires = `require_once TEST_TMP . '/includes/reporting.php'; require_once TEST_TMP . '/includes/intelligence.php'; require_once TEST_TMP . '/includes/intelligence-monitor.php'; require_once TEST_TMP . '/includes/intelligence-queue.php';`;
const run = () => h.script(`require TEST_TMP . '/tools/intelligence-monitor.php';`);
const status = async () => (await h.request('intelligence.php',{user:USERS.office_manager,body:{action:'monitor_status'}})).body;
const state = async () => JSON.parse(await h.script(`${requires} echo json_encode(monitorState('test.example'));`));
await h.script(`${requires} intelligenceSaveWatches('test.example',['urgent']); monitorSaveRecipients('test.example','a@example.com'); monitorSetEnabled('test.example',true); monitorUpdate('test.example', function ($s) { $s['since']=time()-200000; $s['discoveryCursor']=time()-32*3600; return $s; });`);
await h.seedPbx('filterCdrWindows', true);
await h.seedPbx('transcription', {'call-intelligence-job-id':'123','call-intelligence-processing-status':'finished','call-intelligence-summary-status':'success','call-intelligence-summary':'all good','call-intelligence-topics-top':['billing'],'call-intelligence-segments':[]});
const now = Math.floor(Date.now()/1000);
const stamp = seconds => new Date(seconds*1000).toISOString();
const call = (id, start, end) => ({id,domain:'test.example',_server:'nms1','call-start-datetime':stamp(start),'call-disconnect-datetime':stamp(end),'call-intelligence-job-id':'123','prefilled-transcription-api':`/ns-api/v2/domains/test.example/transcriptions?id=123&date=202611&callid=${id}`});
const old = call('old-outage',now-31*3600,now-30*3600);
const long = call('long-call',now-23*3600,now-600);
const pending = call('pending-before-failure',now-700,now-600);
await h.seedPbx('fetchCdrs',[old,long,pending]);
await h.script(`${requires} $s=monitorState('test.example'); monitorQueueCdr('test.example','pending-before-failure',${now-700},${now-600},$s);`);
// A failing discovery must neither suppress an already-due retry nor advance the checkpoint.
await h.seedPbx('failCdrWindows',{throw:true});
const before = await state();
await run();
const failed = await status(); const afterFailure = await state();
assert.match(failed.lastRun.error,/discovery failed/i);
assert.equal(failed.lastRun.counts.checked,1,'due call was processed even though discovery fails');
assert.equal(afterFailure.discoveryCursor,before.discoveryCursor,'failed window never moves the cursor');
const done = JSON.parse(await h.script(`${requires} echo json_encode(monitorReadFile(monitorQueueDoneFile('test.example','pending-before-failure')));`));
assert.equal(done.status,'done');
await h.seedPbx('failCdrWindows',{}); // no failure; remove file instead
await h.script(`@unlink(TEST_TMP . '/pbx/failCdrWindows.json');`);
await h.script(`@unlink(TEST_TMP . '/pbx-calls.jsonl');`);
await run();
const recovered1 = await state();
assert.equal(recovered1.discoveryCursor-before.discoveryCursor,4*3600,'catch-up advances by at most four one-hour windows per run');
assert((await status()).lastRun.catchupSeconds>0,'catch-up backlog is visible');
const recovered = await status();
assert(recovered.reviews.items.some(x=>x.callid==='old-outage' && /24 hours/.test(x.reason)),'expired call from outage is reviewed, not mailed');
assert.equal(recovered.lastRun.counts.checked,1,'call started 23 hours ago and completed recently is checked');
await run();
assert((await status()).lastRun.catchupSeconds<=5,'subsequent runs complete the older gap, apart from elapsed run time');
assert.equal((await status()).lastRun.counts.checked,0,'overlapping scans do not recheck or resend completed calls');
// Failure of one retry bucket must not starve another bucket.
const retryBad = call('retry-failed', now-2500, now-2000);
const retryGood = call('retry-ok', now-1000, now-600);
await h.seedPbx('fetchCdrs',[retryBad,retryGood]);
await h.script(`${requires} $s=monitorState('test.example'); monitorQueueCdr('test.example','retry-failed',${now-2500},${now-2000},$s); monitorQueueCdr('test.example','retry-ok',${now-1000},${now-600},$s);`);
await h.seedPbx('failCdrWindows',{retryOnly:true,retryBefore:now-2000});
await run();
assert.match((await status()).lastRun.error,/retry windows failed/i);
const retryResults = JSON.parse(await h.script(`${requires} echo json_encode(['bad'=>monitorReadFile(monitorQueueFile('test.example','retry-failed')), 'good'=>monitorReadFile(monitorQueueDoneFile('test.example','retry-ok'))]);`));
assert.equal(retryResults.bad.status,'pending'); assert.equal(retryResults.good.status,'done');
await h.script(`@unlink(TEST_TMP . '/pbx/failCdrWindows.json');`);
await run();
assert.equal(JSON.parse(await h.script(`${requires} echo json_encode(monitorReadFile(monitorQueueDoneFile('test.example','retry-failed')));`)).status,'done');

// An incomplete historical page must preserve its returned CDR without
// checkpointing the failed hour; the same hour is retried on the next run.
const partial = call('partial-page',now-28*3600,now-27*3600);
await h.script(`${requires} monitorUpdate('test.example',function($s) { $s['discoveryCursor']=time()-29*3600; return $s; });`);
const partialCursor = (await state()).discoveryCursor;
await h.seedPbx('fetchCdrs',[partial]);
await h.seedPbx('failCdrWindows',{before:now-24*3600,rows:[partial]});
await run();
const failedCatchup = await status();
assert.match(failedCatchup.lastRun.error,/discovery failed/i);
assert.equal((await state()).discoveryCursor,partialCursor,'an incomplete historical window is not committed');
assert(failedCatchup.reviews.items.some(x=>x.callid==='partial-page'),'records returned before the failure are retained and expired safely');
await h.script(`@unlink(TEST_TMP . '/pbx/failCdrWindows.json');`);
await run();
assert((await state()).discoveryCursor > partialCursor,'the failed historical window is retried after restart');

// A recovered completed CDR from before enablement must never be queued.
const beforeEnable = JSON.parse(await h.script(`${requires}
$s=monitorState('test.example'); $start=(int)$s['since']-1000; $end=(int)$s['since']-500;
monitorRememberOpenCdr('test.example',['id'=>'before-enable','call-start-datetime'=>gmdate('c',$start)],$s,time());
file_put_contents(TEST_TMP . '/pbx/fetchCdrs.json',json_encode([['id'=>'before-enable','call-start-datetime'=>gmdate('c',$start),'call-disconnect-datetime'=>gmdate('c',$end)]]));
file_put_contents(TEST_TMP . '/pbx/filterCdrWindows.json','false'); $counts=['missingTime'=>0,'unidentified'=>0];
monitorDiscoverWindow(new PbxClient('key'),'test.example',$s,$start-1,$end+1,time(),$counts);
monitorReviewOpenCdrs('test.example',$s,time()+90000); $reviews=monitorReviews('test.example');
echo json_encode(['pending'=>is_file(monitorQueueFile('test.example','before-enable')),'done'=>is_file(monitorQueueDoneFile('test.example','before-enable')), 'reviewed'=>(bool)array_filter($reviews['items'],fn($r)=>$r['cdrId']==='before-enable')]);`));
assert.deepEqual(beforeEnable,{pending:false,done:false,reviewed:false});

// Incomplete records become reviews only with reliable identity and scope.
await h.seedPbx('filterCdrWindows', false);
const incomplete = JSON.parse(await h.script(`${requires}
$s=monitorState('test.example'); $client=new PbxClient('key'); $c=['missingTime'=>0,'unidentified'=>0];
$rows=[['id'=>'bad-time','call-disconnect-datetime'=>gmdate('c',time()-20)],
 ['call-id'=>'fallback-leg','call-start-datetime'=>gmdate('c',time()-400),'call-disconnect-datetime'=>gmdate('c',time()-300)],
 ['call-start-datetime'=>gmdate('c',time()-400),'call-disconnect-datetime'=>gmdate('c',time()-300)],
 ['id'=>'open-call','call-start-datetime'=>gmdate('c',time()-100)], ['id'=>'unknown-date'],
 ['id'=>'   ','call-id'=>'blank-id','call-start-datetime'=>gmdate('c',time()-400),'call-disconnect-datetime'=>gmdate('c',time()-300)]];
file_put_contents(TEST_TMP . '/pbx/fetchCdrs.json',json_encode($rows));
monitorDiscoverWindow($client,'test.example',$s,time()-1000,time(),time(),$c);
$before=monitorReviews('test.example'); monitorReviewOpenCdrs('test.example',$s,time()+86400); $after=monitorReviews('test.example');
echo json_encode(['counts'=>$c,'before'=>$before,'after'=>$after]);`));
assert.equal(incomplete.counts.missingTime,6);
assert.equal(incomplete.counts.unidentified,1);
assert(incomplete.before.items.some(x=>x.cdrId==='bad-time'));
assert(incomplete.before.items.some(x=>x.cdrId==='unknown-date' && x.startedAt==='' && /eligibility/.test(x.reason)), 'stable references with unknown dates are reviewed without guessing eligibility');
assert(incomplete.before.items.some(x=>x.callid==='fallback-leg' && x.cdrId===''),'fallback is never guessed to be a CDR ID');
assert(incomplete.before.items.some(x=>x.callid==='blank-id' && x.cdrId===''),'blank CDR IDs are not scheduled as usable IDs');
assert(!incomplete.before.items.some(x=>x.callid==='open-call'),'ongoing call is not prematurely reviewed');
assert(incomplete.after.items.some(x=>x.cdrId==='open-call'),'uncompleted identifiable call is reviewed after 24 hours');
await h.script(`${requires} $s=monitorState('test.example'); monitorReviewOpenCdrs('test.example',$s,time()+90000);`);
assert.equal((await status()).reviews.items.filter(x=>x.cdrId==='open-call').length,1,'repeated runs cannot duplicate incomplete reviews');
// A call that completes during the overlap is not later misreported as open.
const resolved = JSON.parse(await h.script(`${requires}
$s=monitorState('test.example'); $start=time()-200; $call=['id'=>'completed-open','call-start-datetime'=>gmdate('c',$start)];
monitorRememberOpenCdr('test.example',$call,$s,time()); monitorResolveOpenCdr('test.example','completed-open',$start,$s);
monitorReviewOpenCdrs('test.example',$s,time()+90000); echo json_encode(monitorReviews('test.example'));`));
assert(!resolved.items.some(x=>x.cdrId==='completed-open'));

console.log('INTELLIGENCE RECOVERY OK — checkpoint catch-up, 24-hour overlap, failed discovery and incomplete CDRs');
process.exit(0);
