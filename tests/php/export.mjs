/**
 * CSV export tests.
 *
 * The exports matter because a wrong file is silently wrong: nobody notices
 * that a spreadsheet holds 25 of 30 000 rows until they act on it. These tests
 * run the real endpoints under PHP 8.4 and assert
 *   1. the row count is the whole filtered result set, not the page,
 *   2. the header matches the columns the UI shows,
 *   3. values are formatted exactly like the front end formats them,
 *   4. a caller-ID name that starts with a formula character cannot execute
 *      when the file is opened in Excel / Sheets,
 *   5. a normal (non-export) request still returns JSON.
 */
import { PhpHarness, USERS } from './php.mjs';

const harness = await new PhpHarness();
await harness.boot();

/* Three days of CDRs, one of them with a hostile caller name. */
const DAY = (day, hour, extra = {}) => ({
  id: `cdr-${day}-${hour}`,
  'call-direction': 1,
  'call-start-datetime': `2026-08-0${day}T${String(hour).padStart(2, '0')}:00:00Z[US/Eastern]`,
  'call-answer-datetime': `2026-08-0${day}T${String(hour).padStart(2, '0')}:00:05Z[US/Eastern]`,
  'call-disconnect-datetime': `2026-08-0${day}T${String(hour).padStart(2, '0')}:01:00Z[US/Eastern]`,
  'call-total-duration-seconds': 60,
  'call-talking-duration-seconds': 55,
  'call-term-user': '6080',
  'call-orig-user': '8454259810',
  'call-orig-to-user': '8457620002',
  'call-through-user': '700',
  'call-orig-caller-id': '8454259810',
  ...extra
});

const cdrs = [];
for (let hour = 9; hour < 17; hour++) {
  cdrs.push(DAY(2, hour));
  cdrs.push(DAY(3, hour));
}
/* 16 answered + this one hostile-named call = 17 rows over two days. */
cdrs.push(DAY(4, 9, { 'call-orig-from-name': '=HYPERLINK("http://evil","click")' }));

await harness.seedPbx('users', [
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ' }
]);
await harness.seedPbx('fetchCdrs', cdrs);
await harness.seedPbx('phonenumbers', [
  { phonenumber: '8457620002', 'dial-rule-application': 'user', 'dial-rule-parameter': '6080', enabled: 'yes' },
  { phonenumber: '8005551212', 'dial-rule-application': 'voicemail', enabled: 'no' }
]);

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log('  PASS', label);
  else {
    failures++;
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
  }
};
const csvLines = (output) => output.replace(/^\uFEFF/, '').trim().split('\n').map(line => line.trim());
const parse = (line) => {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(value); value = ''; }
    else value += ch;
  }
  cells.push(value);
  return cells;
};

console.log('== CSV exports (real PHP 8.4)\n');

/* ---------------------------------------------------------------- history */
{
  const json = await harness.request('call_history.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', page: 1, size: 25 },
    user: USERS.office_manager
  });
  check('call history JSON page still works', json.status === 200 && Array.isArray(json.body?.data), json.body);
  check('call history JSON page is paginated to 25 rows', json.body?.data?.length === 17 || json.body?.data?.length === 25,
    { rows: json.body?.data?.length, total: json.body?.total });
  const total = Number(json.body?.total || 0);

  /* Page 2 would be empty here, but the export must not care about pages. */
  const csv = await harness.request('call_history.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', size: 25, page: 2, export: true },
    user: USERS.office_manager
  });
  const lines = csvLines(csv.phpOutput);
  check('call history export streams a CSV header',
    lines[0] === 'Date,"From name",From,Dialed,To,Agent,Queue,Outcome,Ring,Talk,Disconnect', lines[0]);
  check('call history export ignores the page parameter and exports every row',
    lines.length - 1 === total && total === 17, { dataRows: lines.length - 1, total, requestedPage: 2 });

  const hostile = lines.find(line => line.includes('HYPERLINK'));
  const hostileName = hostile ? parse(hostile)[1] : '';
  check('formula-like caller name is neutralised in the file',
    hostileName.startsWith("'=HYPERLINK"), hostileName.slice(0, 40));
  /* Rows are newest-first, so find the 9 AM Aug 2 call by its cells. */
  const nineAm = lines.map(parse).find(cells => cells[0] === 'Aug 2, 9:00 AM');
  check('values are formatted like the UI (Aug 2, 9:00 AM / 00:05 / 00:55)',
    !!nineAm && nineAm[8] === '00:05' && nineAm[9] === '00:55', nineAm);

  /* auditView() appends to logs/audit-YYYY-MM.jsonl (monthly, UTC). */
  const auditFile = 'logs/audit-' + new Date().toISOString().slice(0, 7) + '.jsonl';
  const audit = await harness.readInterpreterFile(auditFile);
  check('call history export is audited',
    audit.includes('call_history_export') && audit.includes('"export":"call_history"'),
    audit.trim().split('\n').slice(-1)[0]);
}

/* ------------------------------------------------------------------ calls */
{
  const csv = await harness.request('calls.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', metric: 'total', export: true },
    user: USERS.office_manager
  });
  const lines = csvLines(csv.phpOutput);
  /*
   * Sprint A added outcome (the canonical vocabulary), wait (the same number as
   * ring, named for the caller), hold (read and discarded before) and transfers.
   * The header and the value rows are written from the same shaper, so this
   * assertion is what keeps them from ever disagreeing.
   */
  check('calls export header matches the modal columns',
    lines[0] === 'date,time,type,outcome,from_name,from,dialed,to,agent,talk,wait,hold,reason,total,transfers,recording,sip_flow', lines[0]);
  check('calls export writes every matching call',
    lines.length - 1 === 17, { dataRows: lines.length - 1 });
  check('calls export formats durations as HH:MM:SS',
    /,\d\d:\d\d:\d\d,/.test(lines[1]), lines[1]);
  const first = parse(lines[1]);
  check('calls export stamps date and time as the UI shows them',
    first[0] === '2026-08-04' && first[1] === '9:00 AM' && first[5] === '(845) 425-9810', first);
  check('calls export carries the canonical outcome in column 4',
    ['answered', 'abandoned', 'voicemail', 'noanswer'].includes(first[3]), first[3]);

  /*
   * The export must honour the SAME filters as the list on screen — including
   * the new ones. A window (the interval a Simultaneous row stands for) and a
   * single call id both have to narrow the file, or the spreadsheet and the
   * table disagree about what was exported.
   */
  const windowed = await harness.request('calls.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', metric: 'total', timeFrom: '09:00', timeTo: '10:00', export: true },
    user: USERS.office_manager
  });
  const windowLines = csvLines(windowed.phpOutput);
  const windowTimes = windowLines.slice(1).map(line => parse(line)[1]);
  /* One 09:00 call per day in the range (Aug 2, 3 and the hostile-named 4th). */
  check('calls export honours the interval window',
    windowLines.length - 1 === 3 && windowTimes.every(t => t === '9:00 AM'),
    { rows: windowLines.length - 1, times: [...new Set(windowTimes)] });

  const oneCall = await harness.request('calls.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', metric: 'total', callId: 'cdr-3-12', export: true },
    user: USERS.office_manager
  });
  const oneLines = csvLines(oneCall.phpOutput);
  check('calls export honours the single-call filter',
    oneLines.length === 2 && parse(oneLines[1])[1] === '12:00 PM',
    { rows: oneLines.length - 1, row: oneLines[1] });
}

/* -------------------------------------------------------- telephone numbers */
{
  const csv = await harness.request('telephone_numbers.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', export: true },
    user: USERS.office_manager
  });
  const lines = csvLines(csv.phpOutput);
  check('telephone numbers export header',
    lines[0] === 'number,type,enabled,routes_to,extension,department,site,calls,missed,abandoned,talk', lines[0]);
  /*
   * The abandoned column (Sprint A) is the subset of the missed ones — the
   * callers who reached a queue and hung up — so it can never exceed the missed
   * count on the same row. That is the invariant worth pinning, not the number.
   */
  const cell = (line, index) => Number(line.split(',')[index]);
  check('every DID row keeps abandons at or below its missed count',
    lines.slice(1, 3).every(line => cell(line, 9) <= cell(line, 8)),
    lines.slice(1, 3).map(line => [cell(line, 8), cell(line, 9)]));
  check('telephone numbers export includes every number, used or not',
    lines.length === 4 && lines[1].startsWith('8457620002') && lines[2].startsWith('8005551212'),
    lines.slice(1));
  check('telephone numbers export ends with a totals row', lines[3].startsWith('TOTAL'), lines[3]);
  check('the totals row carries the same number of columns as the header',
    lines[3].split(',').length === lines[0].split(',').length,
    [lines[0].split(',').length, lines[3].split(',').length]);
}

/* ------------------------------------------------------------- permissions */
{
  const res = await harness.request('call_history.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', export: true },
    user: USERS.agent
  });
  check('a role that cannot read history cannot export it either', res.status === 403, res.status);
  const tn = await harness.request('telephone_numbers.php', {
    method: 'POST',
    body: { start: '2026-08-02', end: '2026-08-04', export: true },
    user: USERS.supervisor
  });
  check('a supervisor cannot export the DID inventory', tn.status === 403, tn.status);
}

console.log(`\n${failures === 0 ? 'EXPORT TESTS OK' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
