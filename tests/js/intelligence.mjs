import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulate } from 'react-dom/test-utils';
import { unzipSync, strFromU8 } from 'fflate';
import { createHarness, FIXTURES } from './harness.mjs';
import { parseWatchedPhrases, formatWatchedPhrases } from '../../assets/js/src/lib/intelligence-watch.js';
import { intelligenceMonthRange } from '../../assets/js/src/lib/intelligence-month.js';
assert.deepEqual(intelligenceMonthRange('2024-02', '2026-11-17'), { start: '2024-02-01', end: '2024-02-29' });
assert.deepEqual(intelligenceMonthRange('2026-11', '2026-11-17'), { start: '2026-11-01', end: '2026-11-17' });
assert.equal(intelligenceMonthRange('2026-12', '2026-11-17'), null);
assert.deepEqual(parseWatchedPhrases(' red, blue\n  green , ,  '), ['red', 'blue', 'green']);
assert.deepEqual(parseWatchedPhrases('reboot, "billing, urgent"\n"said ""hello"""'), ['reboot', 'billing, urgent', 'said "hello"']);
const existingPhrases = ['plain', 'keep, this', 'say "hello"', '"quoted, words"'];
assert.deepEqual(parseWatchedPhrases(formatWatchedPhrases(existingPhrases)), existingPhrases, 'existing literal commas and quotes round-trip');
assert.throws(() => parseWatchedPhrases('"unfinished'), /Close the quoted/);
assert.throws(() => parseWatchedPhrases('"one"two'), /comma or new line/);
assert.throws(() => parseWatchedPhrases('"a\nb"'), /stay on one line/);
const operations = [];
let smtpFailure = false;
let activeLookups = 0, maxLookups = 0, sendAttempts = 0, failSendAt = 0, monitorEnabled = false, monitorRecipients = [];
const calls = Array.from({ length: 115 }, (_, i) => ({ reference: 'ref-' + String(i).padStart(3, '0'), emailReference: 'email-' + String(i).padStart(3, '0'), callId: 'call-' + String(i).padStart(3, '0'), callerNumber: '0015550100', dialedNumber: '18005550100', destinationNumber: '201', startedAt: '2024-02-29T12:00:00Z', month: '202402' }));
calls.push({ rowKey: 'cdr-unavailable', reference: null, emailReference: 'email-unavailable', callId: 'call-unavailable', startedAt: '2024-02-29T12:00:00Z', status: 'unavailable', detail: 'missing job ID', topicsHint: ['device'], matchesHint: [{ keyword: 'reboot', source: 'Topic', excerpt: 'reboot request' }] });
FIXTURES.cache_job = body => body.action === 'warm' ? { complete: true, ready: 29, total: 29, batch: { warmed: 29, stopped: 'complete' } } : { complete: false, ready: 0, total: 29 };
FIXTURES.intelligence = body => {
  operations.push(body);
  if (body.action === 'monitor_status') return { enabled: monitorEnabled, configured: true, recipients: monitorRecipients, paused: monitorEnabled && !monitorRecipients.length, lastRun: { time: 1709251200, catchupSeconds: 7200, counts: { missingTime: 3, unidentified: 1 }, error: 'CDR discovery failed; pending retries were attempted.' }, reviews: { total: 0, items: [] } };
  if (body.action === 'monitor_enable') { monitorEnabled = body.enabled; return { enabled: monitorEnabled, configured: true, recipients: monitorRecipients, paused: monitorEnabled && !monitorRecipients.length, reviews: { total: 0, items: [] } }; }
  if (body.action === 'monitor_recipients') { monitorRecipients = body.recipients.split(';').map(x => x.trim()).filter(Boolean); return { enabled: monitorEnabled, configured: true, recipients: monitorRecipients, paused: monitorEnabled && !monitorRecipients.length, reviews: { total: 0, items: [] } }; }
  if (body.action === 'smtp_diagnostic') return smtpFailure ? { ok:false, code:28, description:'The SMTP operation timed out.', tcpConnected:false, elapsedSeconds:10 } : { ok:true, elapsedSeconds:1 };
  if (body.action === 'smtp_test_email') return smtpFailure ? { ok:false, code:28, description:'The SMTP operation timed out.' } : { ok:true };
  if (body.action === 'watches') return { watches: ['reboot', 'billing'] };
  if (body.action === 'list') return { calls, missing: 2, missingReasons: { jobId: 1, server: 0, callId: 0, month: 1 }, cacheStatus: { complete: true } };
  if (body.action === 'lookup') {
    const n = Number(body.reference.slice(4));
    activeLookups++; maxLookups = Math.max(maxLookups, activeLookups);
    const result = n >= 113 ? { status: 'error', detail: 'unavailable' } : {
      status: 'finished', summary: n === 85 ? '=SUM(1,1) & <safe>' : n === 0 ? 'Please REBOOT the device.' : 'Summary ' + n,
      topics: n < 110 ? ['device', 'topic ' + String(n).padStart(3, '0'), ...(n === 0 ? ['extra 1', 'extra 2', 'extra 3', 'extra 4', 'extra 5'] : [])] : [],
      matches: n === 0 ? [{ keyword: 'reboot', source: 'Summary', excerpt: 'reboot request' }] : n === 85 ? [{ keyword: 'billing', source: 'Transcript', excerpt: '=danger & <sample>' }] : []
    };
    return Promise.resolve(result).finally(() => { activeLookups--; });
  }
  if (body.action === 'send') { sendAttempts++; if (sendAttempts === failSendAt) throw new Error('mail failure'); return { sent: true, emailStatus: { time: 1709251200, recipients: body.recipients, kind: 'manual' } }; }
  if (body.action === 'save_watches') return { watches: body.watches.filter(Boolean) };
  return {};
};
const { window, document, root, flush, click, byText, errors, act, requested, press } = await createHarness({ search: 'start=2025-01-01&end=2025-01-01' });
await flush(10);
// Managers can configure domain workers, and invalid values never get saved.
let savedSettings;
const settingsFixture = FIXTURES.settings;
FIXTURES.settings = body => {
  if (Object.keys(body).length) { savedSettings = body; return { data: { ...settingsFixture, ...body } }; }
  return { data: { ...settingsFixture, intelligenceWorkers: 12 } };
};
await click(byText('.nav-item', 'Settings'));
await flush(10);
let workersInput = document.querySelector('#intelligence-workers');
assert.equal(workersInput.value, '12');
await act(async () => { Simulate.change(workersInput, { target: { value: '33' } }); });
await click(byText('button', 'Save'));
assert.match(document.querySelector('[aria-label="Settings"]').textContent, /whole number from 1 to 32/);
assert.equal(savedSettings, undefined);
await act(async () => { Simulate.change(workersInput, { target: { value: '16' } }); });
await click(byText('button', 'Save'));
assert.equal(savedSettings.intelligenceWorkers, 16);
FIXTURES.settings = settingsFixture;
await click(byText('.nav-item', 'Topics & summaries'));
await flush(1200);
const firstList = operations.find(x => x.action === 'list');
assert.equal(firstList.start.slice(-3), '-01');
assert.equal(firstList.start.slice(0, 7), firstList.end.slice(0, 7));
assert.notEqual(firstList.start, '2025-01-01');
assert.equal(firstList.hours, 'all');
assert.ok(maxLookups > 4 && maxLookups <= 8);
assert.ok(requested.some(r => r.endpoint === 'cache_job' && JSON.parse(r.body).action === 'warm'));
assert.match(root().textContent, /Managers only/);
assert.match(root().textContent, /Checked 115 \/ 115/);
assert.match(document.querySelector('#intel-sync-diagnostics').textContent, /3 unavailable or incomplete/);
assert.match(document.querySelector('#intel-sync-diagnostics').textContent, /Missing: job ID 1, PBX server 0, call ID 0, lookup month 1/);
assert.equal(document.querySelector('.intel-bulk-dock'), null);
const table = () => document.querySelector('.intel-table tbody');
const row = id => table().querySelector('[aria-label="Select call ' + id + '"]')?.closest('tr');
assert.equal(table().querySelectorAll('tr').length, 30);
assert.ok(row('call-unavailable').classList.contains('is-matched'));
assert.match(row('call-unavailable').textContent, /Incomplete check/);
assert.match(root().textContent, /Showing 1–30 of 111/);
assert.ok(byText('button', 'First').disabled && byText('button', 'Previous').disabled);
assert.equal(document.querySelector('[aria-label="Scrollable calls table"]').getAttribute('tabindex'), '0');
assert.equal(row('call-000').querySelector('mark').textContent, 'REBOOT');
assert.match(row('call-000').textContent, /2024-02-29/);
assert.match(row('call-000').textContent, /7:00 AM/);
assert.deepEqual([...row('call-000').querySelectorAll('.intel-party')].map(el => el.textContent), ['0015550100', '18005550100', '201', 'No email recorded']);
assert.deepEqual([...row('call-unavailable').querySelectorAll('.intel-party')].map(el => el.textContent), ['Unknown', 'Unknown', 'Unknown', 'No email recorded']);
assert.equal([...row('call-000').querySelector('.intel-topic-list').children].filter(el => el.tagName === 'BUTTON').length, 5);
assert.match(row('call-000').querySelector('.intel-more-topics summary').textContent, /\+2 more/);
assert.equal(row('call-000').querySelector('.intel-ref-pill').getAttribute('title'), 'call-000');
let copied = '';
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } }, configurable: true });
await click(row('call-000').querySelector('.intel-ref-pill'));
assert.equal(copied, 'call-000');
await click(row('call-000').querySelector('.intel-more-topics summary'));
await click([...row('call-000').querySelectorAll('.intel-topic')].find(el => el.textContent === 'extra 5'));
assert.match(root().textContent, /Calls: extra 5/);
await click(byText('button', 'Reset filters'));

// The watch drawer is dismissible by keyboard and preserves the unsaved draft.
const watchButton = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Keyword Watch'));
watchButton.focus();
await click(watchButton);
assert.ok(document.querySelector('[role="dialog"][aria-label="Keyword Watch"]'));
const watchOverlay = document.querySelector('[aria-label="Keyword Watch"]').closest('.intel-overlay');
assert.ok(watchOverlay.parentElement === document.body, 'drawer portal is outside the filter stacking context');
const css = readFileSync(new URL('../../assets/css/src/custom.css', import.meta.url), 'utf8');
assert.match(css, /\.intel-overlay\s*\{[^}]*z-index:\s*2147483647/s);
assert.match(css, /\.filters-bar\s*\{[^}]*z-index:\s*40000/s);
assert.equal(document.querySelector('[aria-label="Watched phrases"]').value, 'reboot\nbilling');
assert.ok([...document.querySelectorAll('[aria-label="Keyword Watch"] summary')].some(el => el.textContent.includes('PBX lookup month override')));
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /this domain’s saved recipients/);
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /catch-up remaining: approximately 2 hours/i);
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /3 incomplete CDR observations/);
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /discovery failed/i);
assert.ok(byText('button', 'Enable automatic alerts').disabled, 'must save recipients first');
const autoRecipients = document.querySelector('[aria-label="Automatic alert recipients"]');
await act(async () => { Simulate.change(autoRecipients, { target: { value: 'one@example.com; two@example.com' } }); });
await click(byText('button', 'Save alert recipients'));
assert.deepEqual(monitorRecipients, ['one@example.com', 'two@example.com']);
await click(byText('button', 'Enable automatic alerts'));
assert.equal(monitorEnabled, true);
assert.ok(byText('button', 'Disable automatic alerts'));
await act(async () => { Simulate.change(document.querySelector('[aria-label="Automatic alert recipients"]'), { target: { value: '' } }); });
await click(byText('button', 'Save alert recipients'));
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /alerts are paused/i);
await click(byText('button', 'Disable automatic alerts'));
assert.equal(monitorEnabled, false);

await click(byText('button', 'Check SMTP connection'));
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /Authentication and delivery are not confirmed/);
assert.ok(byText('button', 'Send test email').disabled);
await act(async () => { Simulate.change(document.querySelector('[aria-label="Test email address"]'), { target: { value: 'check@example.com' } }); });
await click(byText('button', 'Send test email'));
assert.equal(operations.find(x => x.action === 'smtp_test_email').recipient, 'check@example.com');
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /SMTP accepted the test message/);
smtpFailure = true;
await click(byText('button', 'Check SMTP connection'));
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /cURL error 28.*No email was sent/);
await click(byText('button', 'Send test email'));
assert.match(document.querySelector('[aria-label="Keyword Watch"]').textContent, /Delivery is uncertain/);
await press(document.activeElement, 'Escape');
assert.equal(document.querySelector('[role="dialog"][aria-label="Keyword Watch"]'), null);
assert.ok(document.activeElement === watchButton, 'focus returns to drawer trigger');

const matchStatus = document.querySelector('[aria-label="Match status"]');
const keyword = document.querySelector('[aria-label="Watched keyword"]');
await act(async () => { Simulate.change(matchStatus, { target: { value: 'matched' } }); });
assert.equal(table().querySelectorAll('tr').length, 3);
await act(async () => { Simulate.change(keyword, { target: { value: 'billing' } }); });
assert.equal(table().querySelectorAll('tr').length, 1);
assert.ok(row('call-085'));
let downloaded, downloadName;
window.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; };
window.HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
const workbook = async () => {
  const bytes = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = reject; reader.readAsArrayBuffer(downloaded); });
  return unzipSync(bytes);
};
await click(byText('button', 'Export Excel (partial)'));
let archive = await workbook();
let xml = new window.DOMParser().parseFromString(strFromU8(archive['xl/worksheets/sheet1.xml']), 'application/xml');
assert.equal(xml.querySelectorAll('row').length, 2);
assert.match(xml.documentElement.textContent, /call-085/);
assert.match(xml.documentElement.textContent, /0015550100/);
assert.match(xml.documentElement.textContent, /18005550100/);
assert.match(xml.documentElement.textContent, /=danger & <sample>/);
assert.equal(xml.querySelectorAll('f').length, 0);
await act(async () => { Simulate.change(matchStatus, { target: { value: 'incomplete' } }); });
assert.match(root().textContent, /No calls match the current filters/);
await act(async () => { Simulate.change(keyword, { target: { value: '' } }); });
assert.ok(row('call-unavailable'));
await act(async () => { Simulate.change(matchStatus, { target: { value: 'unmatched' } }); });
assert.match(root().textContent, /Showing 1–30 of 108/);
assert.ok(!row('call-unavailable'));
await act(async () => { Simulate.change(matchStatus, { target: { value: 'all' } }); });
await click(byText('button', 'Export Excel (partial)'));
archive = await workbook();
xml = new window.DOMParser().parseFromString(strFromU8(archive['xl/worksheets/sheet1.xml']), 'application/xml');
assert.equal(xml.querySelectorAll('row').length, 112, 'exports all pages');
assert.match(strFromU8(archive['xl/worksheets/sheet2.xml']), /Sensitive|sensitive/);
assert.ok(downloadName.endsWith('-partial.xlsx'), 'incomplete checks mark the export partial');

await click(byText('button', 'Last'));
assert.match(root().textContent, /Page 4 of 4/);
assert.equal(table().querySelectorAll('tr').length, 21);
await click(byText('button', 'Previous'));
await click(table().querySelector('[aria-label="Select call call-085"]'));
await click(byText('button', 'First'));
await click(table().querySelector('[aria-label="Select call call-000"]'));
assert.ok(document.querySelector('.intel-bulk-dock'));
const size = document.querySelector('[aria-label="Rows per page"]');
await act(async () => { Simulate.change(size, { target: { value: '100' } }); });
assert.match(root().textContent, /Showing 1–100 of 111/);
const address = document.querySelector('[aria-label="Recipients"]');
await act(async () => { Simulate.change(address, { target: { value: 'manager@example.com' } }); });
await click(byText('button', 'Email (2)'));
await flush(8);
const send = operations.find(x => x.action === 'send');
assert.deepEqual(send.references.sort(), ['email-000', 'email-085']);
assert.deepEqual(send.recipients, ['manager@example.com']);
assert.match(root().textContent, /SMTP accepted 1 email for 2 calls/);
assert.match(row('call-000').textContent, /SMTP accepted \(manual\)/);
assert.match(row('call-000').textContent, /manager@example.com/);
assert.equal(document.querySelector('.intel-bulk-dock'), null);

const month = document.querySelector('[aria-label="Report month"]');
await act(async () => { Simulate.change(month, { target: { value: '2024-02' } }); });
await flush(1200);
const lastList = operations.filter(x => x.action === 'list').at(-1);
assert.equal(lastList.start, '2024-02-01');
assert.equal(lastList.end, '2024-02-29');
assert.match(root().textContent, /Report period: 2024-02-01 — 2024-02-29/);
await click(byText('button', 'Last'));
const topicList = () => document.querySelector('#intelligence-topic-list');
const topicButtons = () => [...topicList().querySelectorAll('button')];
assert.equal(topicButtons().length, 10);
assert.equal(topicButtons()[0].textContent, 'device (111)');
await click(topicButtons()[0]);
assert.match(root().textContent, /Calls: device/);
assert.match(root().textContent, /Page 1 of 2/);
await click(byText('button', 'Reset filters'));
const search = document.querySelector('[aria-label="Search topics"]');
await act(async () => { Simulate.change(search, { target: { value: 'TOPIC 109' } }); });
assert.equal(topicButtons().length, 1);
await click(topicButtons()[0]);
assert.match(root().textContent, /Calls: topic 109/);
assert.ok(row('call-109'));
await act(async () => { Simulate.change(search, { target: { value: '' } }); });
assert.match(root().textContent, /Topic: topic 109/);
await click(byText('button', 'Reset filters'));
await click(byText('button', 'Browse all'));
let dialog = document.querySelector('[role="dialog"][aria-label="Browse topics"]');
assert.ok(dialog);
assert.equal(dialog.querySelectorAll('.intel-quick-pill').length, 116);
const sortTopics = dialog.querySelector('[aria-label="Sort topics"]');
await act(async () => { Simulate.change(sortTopics, { target: { value: 'alphabetical' } }); });
assert.equal(dialog.querySelector('.intel-quick-pill').textContent, 'device (111)');
const modalSearch = dialog.querySelector('[aria-label="Search all topics"]');
await act(async () => { Simulate.change(modalSearch, { target: { value: 'no topic found' } }); });
assert.match(dialog.textContent, /No topics match your search/);
await act(async () => { Simulate.change(modalSearch, { target: { value: 'topic 109' } }); });
await click(dialog.querySelector('.intel-quick-pill'));
assert.equal(document.querySelector('[role="dialog"][aria-label="Browse topics"]'), null);
assert.match(root().textContent, /Calls: topic 109/);
await click(byText('button', 'Reset filters'));
await act(async () => { Simulate.change(search, { target: { value: '' } }); });

// Selection across all filtered pages, including incomplete calls, and safe retry after a failed batch.
await click(document.querySelector('[aria-label="Select all filtered calls"]'));
assert.match(root().textContent, /111 selected/);
assert.equal(table().querySelectorAll('input[type=checkbox]:checked').length, 100);
await act(async () => { Simulate.change(matchStatus, { target: { value: 'matched' } }); });
assert.match(root().textContent, /3 in current filter/);
await click(byText('button', 'Unselect filtered calls'));
assert.match(root().textContent, /108 selected/);
await click(byText('button', 'Select all filtered calls'));
await act(async () => { Simulate.change(matchStatus, { target: { value: 'all' } }); });
const beforeFailure = sendAttempts;
failSendAt = beforeFailure + 2;
await click(byText('button', 'Email (111)'));
await flush(80);
assert.match(root().textContent, /Email stopped after 10 of 111 calls were accepted/);
assert.match(root().textContent, /101 selected/);
failSendAt = 0;
const beforeRetry = sendAttempts;
await click(byText('button', 'Email (101)'));
await flush(100);
assert.equal(sendAttempts - beforeRetry, 11);
assert.match(root().textContent, /SMTP accepted 11 emails for 101 calls/);
assert.equal(document.querySelector('.intel-bulk-dock'), null);
assert.ok(operations.filter(x => x.action === 'send').every(x => x.references.length <= 10));

// During checking, allow a marked partial export and preserve email selection.
let finishLookup, submittedWatches;
FIXTURES.cache_job = () => ({ complete: true, ready: 29, total: 29 });
FIXTURES.intelligence = body => {
  if (body.action === 'list') return { calls: [{ reference: 'slow', emailReference: 'email-slow', callId: 'slow-call', startedAt: '2024-02-29T12:00:00Z', topicsHint: ['device'], matchesHint: [] }], missing: 0, cacheStatus: { complete: true } };
  if (body.action === 'lookup') return new Promise(resolve => { finishLookup = resolve; });
  if (body.action === 'send') return { sent: true };
  if (body.action === 'save_watches') { submittedWatches = body.watches; return { watches: body.watches.filter(Boolean) }; }
  return { watches: ['reboot'] };
};
await click(document.querySelector('[aria-label="Reload"]'));
await flush(20);
assert.ok(!byText('button', 'Export Excel (partial)').disabled);
assert.match(root().textContent, /Export contains currently available calls and is marked partial/);
await click(byText('button', 'Export Excel (partial)'));
assert.ok(downloadName.endsWith('-partial.xlsx'));
archive = await workbook();
assert.match(strFromU8(archive['xl/worksheets/sheet2.xml']), /Partial \/ incomplete/);
assert.match(strFromU8(archive['xl/worksheets/sheet2.xml']), /In progress/);
await click(document.querySelector('[aria-label="Select all filtered calls"]'));
assert.ok(!byText('button', 'Email (1)').disabled);
await act(async () => { finishLookup({ status: 'finished', topics: ['device'], summary: 'ready', matches: [] }); });
await flush(20);
assert.ok(!byText('button', 'Export Excel').disabled);
await click(byText('button', 'Clear all selections'));
assert.equal(document.querySelector('.intel-bulk-dock'), null);

// Saving watched phrases updates the badge and highlights literal metacharacters safely.
await click([...document.querySelectorAll('button')].find(el => el.textContent.includes('Keyword Watch')));
const watched = document.querySelector('[aria-label="Watched phrases"]');
await act(async () => { Simulate.change(watched, { target: { value: '"unclosed' } }); });
await click(byText('button', 'Save watched phrases'));
assert.match(document.querySelector('[aria-label="Keyword Watch"] [role="alert"]').textContent, /Close the quoted watched phrase/);
assert.equal(submittedWatches, undefined, 'invalid quotes must not be sent to the server');
await act(async () => { Simulate.change(watched, { target: { value: 'reboot, billing\n"[oops,stuff"' } }); });
await click(byText('button', 'Save watched phrases'));
await flush(20);
assert.deepEqual(submittedWatches, ['reboot', 'billing', '[oops,stuff']);
assert.match([...document.querySelectorAll('button')].find(el => el.textContent.includes('Keyword Watch')).textContent, /3/);
assert.match(watched.value, /"\[oops,stuff"/, 'literal comma is preserved when saved phrases are redisplayed');
assert.match(document.querySelector('[aria-label="Keyword Watch"] [role="status"]').textContent, /Watched phrases saved/);
await click(document.querySelector('[aria-label="Close Keyword Watch"]'));
await act(async () => { finishLookup({ status: 'finished', topics: ['device'], summary: 'Literal [OOPS,stuff found', matches: [] }); });
await flush(20);
assert.equal(row('slow-call').querySelector('mark').textContent, '[OOPS,stuff');

// A failed or incomplete cache is never hidden, and no-match filters explain a disabled export.
let warmAttempts = 0;
FIXTURES.cache_job = body => { if (body.action === 'warm') warmAttempts++; return { complete: false, ready: 0, total: 29, batch: { warmed: 0, stopped: 'partial' } }; };
FIXTURES.intelligence = body => {
  if (body.action === 'list') return { calls: [{ reference: 'fail', emailReference: 'email-fail', callId: 'pending-call', startedAt: '2024-02-29T12:00:00Z', topicsHint: ['reboot device'], matchesHint: [] }], missing: 0, cacheStatus: { complete: false } };
  if (body.action === 'lookup') return { status: 'pending', detail: 'processing' };
  return { watches: ['reboot'] };
};
await click(document.querySelector('[aria-label="Reload"]'));
await flush(30);
assert.equal(warmAttempts, 3);
assert.match(root().textContent, /CDR month is not fully loaded/);
assert.match(row('pending-call').textContent, /Incomplete check/);
await act(async () => { Simulate.change(matchStatus, { target: { value: 'unmatched' } }); });
assert.ok(byText('button', 'Export Excel').disabled);
assert.match(root().textContent, /Excel export is unavailable until at least one filtered call is available/);
await act(async () => { Simulate.change(matchStatus, { target: { value: 'all' } }); });
FIXTURES.cache_job = () => { throw new Error('network unavailable'); };
await click(document.querySelector('[aria-label="Reload"]'));
await flush(30);
assert.match(root().textContent, /Could not fully prepare call history: network unavailable/);
assert.ok(row('pending-call'));

// Progress is driven by elapsed time, not by waiting for a ten-job boundary.
const realNow = window.Date.now;
let clock = 10000, started = 0;
window.Date.now = () => clock;
const pendingJobs = new Map();
FIXTURES.cache_job = () => ({ complete: true, ready: 29, total: 29 });
FIXTURES.intelligence = body => {
  if (body.action === 'list') return { intelligenceWorkers: 3, calls: Array.from({ length: 12 }, (_, i) => ({ reference: 'job-' + i, emailReference: 'email-' + i, callId: 'progress-' + i, startedAt: '2024-02-29T12:00:00Z', topicsHint: ['device'] })), missing: 0, cacheStatus: { complete: true } };
  if (body.action === 'lookup') { started++; return new Promise(resolve => { pendingJobs.set(body.reference, resolve); }); }
  return { watches: [] };
};
await click(document.querySelector('[aria-label="Reload"]'));
await flush(20);
assert.equal(started, 3, 'configured workers control simultaneous lookups');
const resolveJob = key => { const resolve = pendingJobs.get(key); pendingJobs.delete(key); resolve({ status: 'finished', topics: ['device'], summary: 'ready', matches: [] }); };
await act(async () => { resolveJob('job-0'); });
await flush(10);
assert.match(root().textContent, /Checked 1 \/ 12/);
clock += 600;
await act(async () => { resolveJob('job-1'); });
await flush(10);
assert.match(root().textContent, /Checked 2 \/ 12/, 'progress updates without waiting for ten completions');
for (let i = 0; i < 12 && pendingJobs.size; i++) {
  await act(async () => { for (const key of [...pendingJobs.keys()]) resolveJob(key); });
  await flush(10);
}
window.Date.now = realNow;
assert.match(root().textContent, /Checked 12 \/ 12/);
// Higher configured values can start more than eight requests (per browser).
let highStarted = 0;
const highPending = [];
FIXTURES.intelligence = body => {
  if (body.action === 'list') return { intelligenceWorkers: 32, calls: Array.from({ length: 40 }, (_, i) => ({ reference: 'high-' + i, callId: 'high-' + i, topicsHint: ['device'] })), missing: 0, cacheStatus: { complete: true } };
  if (body.action === 'lookup') { highStarted++; return new Promise(resolve => highPending.push(resolve)); }
  return { watches: [] };
};
await click(document.querySelector('[aria-label="Reload"]'));
await flush(20);
assert.equal(highStarted, 32, 'upper bound starts 32 lookups when work is available');
await act(async () => { for (const resolve of highPending.splice(0)) resolve({ status: 'finished', topics: ['device'] }); });
await flush(20);
assert.equal(highStarted, 40, 'workers continue through the remaining calls');
for (let i = 0; i < 3 && highPending.length; i++) {
  await act(async () => { for (const resolve of highPending.splice(0)) resolve({ status: 'finished', topics: ['device'] }); });
  await flush(10);
}

assert.equal(errors.length, 0, errors.join('\n'));
console.log('INTELLIGENCE UI OK — compact dashboard, filters, batch email and partial Excel');
