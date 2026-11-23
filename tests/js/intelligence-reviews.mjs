import assert from 'node:assert/strict';
import { Simulate } from 'react-dom/test-utils';
import { createHarness, FIXTURES } from './harness.mjs';
const tableReview = {id:'job-a',callid:'shown',reason:'SMTP did not confirm acceptance. Delivery is uncertain; verify before retrying.'};
const noTopicReview = {id:'review-no-topic',callid:'no-topic',reason:'No topics were available.'};
let reviews = [tableReview,noTopicReview,...Array.from({length:53},(_,i)=>({id:'review-'+i,callid:'older-'+i,reason:'The specific cause was not recorded.'}))];
const page = () => ({total:reviews.length,offset:0,items:reviews.slice(0,50)});
const operations=[];
FIXTURES.cache_job = () => ({complete:true,ready:1,total:1});
FIXTURES.intelligence = body => {
  operations.push(body);
  if (body.action === 'monitor_status') return {enabled:true,configured:true,recipients:['alert@example.com'],reviews:page()};
  if (body.action === 'monitor_reviewed') { reviews=reviews.filter(x=>x.id!==body.id); return {reviews:page()}; }
  if (body.action === 'watches') return {watches:['urgent']};
  if (body.action === 'list') return {calls:[
    {reference:'ref',emailReference:'mail',callId:'shown',startedAt:'2026-11-01T10:00:00Z',reviews:[tableReview]},
    {reference:'other',emailReference:'mail2',callId:'normal',startedAt:'2026-11-01T09:00:00Z',reviews:[]},
    {rowKey:'no-topic',emailReference:'mail3',reference:null,callId:'no-topic',status:'unavailable',startedAt:'2026-11-01T08:00:00Z',topicsHint:[],reviews:[noTopicReview]},
    ...reviews.slice(2).map(item=>({rowKey:'row-'+item.id,reviewOnly:true,emailReference:null,callId:item.callid,startedAt:'',status:'unavailable',topicsHint:[],reviews:[item]}))
  ],missing:0,unscopedReviews:0,cacheStatus:{complete:true}};
  if (body.action === 'lookup') return {status:'finished',topics:['billing'],summary:'Help',matches:[]};
  return {};
};
const {document,root,flush,click,byText,errors,act} = await createHarness();
await flush(10); await click(byText('.nav-item','Topics & summaries')); await flush(50);
const row=id=>document.querySelector('[aria-label="Select call '+id+'"]')?.closest('tr');
assert.match(row('shown').textContent,/Delivery is uncertain/);
assert.ok(row('normal'));
assert.equal(row('no-topic'), undefined, 'ordinary view still hides calls without topics');
assert.equal(document.querySelector('[aria-label="Other calls needing review"]'), null, 'no separate review section');
assert.match(document.querySelector('.intel-table thead').textContent,/Automatic alert review/);
await act(async()=>{ Simulate.change(document.querySelector('[aria-label="Review status"]'),{target:{value:'review'}}); });
await flush(10);
assert.match(root().textContent,/Calls for review/);
assert.match(root().textContent,/Showing 1–30 of 55/);
assert.ok(row('shown')); assert.ok(row('no-topic')); assert.equal(row('normal'),undefined);
assert.ok(row('older-0').querySelector('input[type=checkbox]').disabled, 'limited records cannot be manually emailed');
assert.match(row('older-0').textContent,/Unknown call date/);
await click(byText('button','Last')); await flush(10);
assert.ok(row('older-52'), 'review list is not capped at 50');
await click(byText('button','First')); await flush(10);
await click(document.querySelector('[aria-label="Select all filtered calls"]')); await flush(10);
assert.match(document.querySelector('.intel-selection-badge').textContent,/2 selected/, 'bulk select skips limited records');
await click(byText('button','Clear all selections')); await flush(10);
await click(row('shown').querySelector('[aria-label="Mark review shown reviewed"]')); await flush(10);
assert.equal(row('shown'),undefined,'acknowledged item leaves review filter');
assert.match(root().textContent,/No email was sent or retried/);
await click(row('older-0').querySelector('[aria-label="Mark review older-0 reviewed"]')); await flush(10);
assert.equal(row('older-0'),undefined);
assert.equal(operations.filter(x=>x.action==='send').length,0);
assert.equal(errors.length,0,JSON.stringify(errors));
console.log('INTELLIGENCE REVIEWS UI OK — one table, review filter, pagination and safe acknowledgement');
