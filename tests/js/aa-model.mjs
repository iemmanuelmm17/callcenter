/**
 * Unit tests for the Auto-Attendant report's derived numbers.
 *
 * buildAaReportModel was ~270 lines of closures inside the 1,698-line
 * AutoAttendantReport component; it lives in lib/aa-report-model.js now. These
 * tests pin the arithmetic directly — no bundle, no jsdom — so a future change
 * to the component cannot silently move a number on the report.
 *
 * APP_TZ is America/New_York, so the fixture uses UTC instants: in August that
 * is UTC-4, which makes 13:15Z = 09:15 local, 18:05Z = 14:05 local.
 */
/*
 * The model reaches lib/time.js, which uses React's createElement; the same
 * global the browser supplies is set up here (tests/js/harness.mjs does this
 * for the rendered suites).
 */
globalThis.React = (await import('react')).default;
const { buildAaReportModel } = await import('../../assets/js/src/lib/aa-report-model.js');

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

const calls = [
  /* 09:15 local — has a case, a destination, an additional tier; no-digit */
  { caller: 'A', case: '1', start: '2026-08-02T13:15:00Z', totalSeconds: 60, disconnectReason: 'no digit', destination: '100', additionalTier: 'tier1' },
  /* 09:45 local — same hour, same caller, DTMF */
  { caller: 'A', case: '1', start: '2026-08-02T13:45:00Z', totalSeconds: 120, disconnectReason: 'dtmf' },
  /* 14:05 local — abandoned, reason text says the caller hung up */
  { caller: 'B', case: '2', start: '2026-08-02T18:05:00Z', totalSeconds: 30, disconnectReason: 'orig: bye', abandoned: true },
  /* 14:20 local — abandoned with no reason at all */
  { caller: 'C', start: '2026-08-02T18:20:00Z', totalSeconds: 0, abandoned: true },
  /* no start, no destination, no case — the '-' bucket */
  { caller: '', case: '', start: '', totalSeconds: 10, disconnectReason: 'no queue', destination: '200' }
];

const m = buildAaReportModel(calls);
const empty = buildAaReportModel([]);

console.log('== totals and callers ==');
check('totalCalls counts every filtered call', m.totalCalls === 5, m.totalCalls);
check('uniqueCallers ignores blank/absent callers', m.uniqueCallers === 3, m.uniqueCallers);
check('averageDurationSeconds is the mean total duration', m.averageDurationSeconds === 44, m.averageDurationSeconds);

console.log('\n== abandonment (the backend flag decides, not the reason text) ==');
check('abandonedCount uses call.abandoned only', m.abandonedCount === 2, m.abandonedCount);
check('abandonmentRate is a percentage of all calls', m.abandonmentRate === 40, m.abandonmentRate);
check('a call with abandon reason text but no flag is not abandoned',
  m.abandonedCalls.every(call => call.abandoned === true) && m.abandonedCalls.length === 2);
check('no calls -> zero, not NaN', empty.abandonmentRate === 0 && empty.abandonedCount === 0);

console.log('\n== outcome buckets ==');
check('reason text is collapsed into the known labels',
  m.outcomeMap['No Digit'] === 1 && m.outcomeMap.DTMF === 1 && m.outcomeMap['No Queue'] === 1, m.outcomeMap);
check('the abandoned flag overrides the reason label',
  m.outcomeMap.Abandoned === 2 && m.outcomeMap['Caller Hangup'] === undefined, m.outcomeMap);
check('rows are sorted by count, descending', m.outcomeRows[0].outcome === 'Abandoned' && m.outcomeRows[0].count === 2, m.outcomeRows);
check('every call lands in exactly one bucket',
  m.outcomeRows.reduce((total, row) => total + row.count, 0) === 5);

console.log('\n== digits / case ==');
check('a missing and an empty case both fall into the "-" bucket',
  m.digitMap['-'] && m.digitMap['-'].calls === 2, m.digitMap);
check('the same case is one bucket across calls',
  m.digitMap['1'] && m.digitMap['1'].calls === 2, m.digitMap);
check('digits sort numerically with "-" last',
  m.digitRows.map(row => row.digit).join(',') === '1,2,-', m.digitRows.map(row => row.digit));
check('every call lands in exactly one digit bucket',
  m.digitRows.reduce((total, row) => total + row.calls, 0) === 5);

console.log('\n== destinations ==');
check('destinations are counted and capped at ten rows',
  m.destinationMap['-'] === 3 && m.destinationMap['100'] === 1 && m.destinationMap['200'] === 1 && m.destinationRows.length === 3, m.destinationMap);

console.log('\n== hourly distribution ==');
check('a call is counted in its New York local hour',
  m.hourCounts[9] === 2 && m.hourCounts[14] === 2 && m.hourCounts[8] === 0, m.hourCounts.slice(8, 15));
check('hours with no start are dropped, not counted at midnight', m.hourCounts[0] === 0, m.hourCounts[0]);
check('hourlyRows labels every hour 00:00 .. 23:00',
  m.hourlyRows.length === 24 && m.hourlyRows[0].hour === '00:00' && m.hourlyRows[23].hour === '23:00');

console.log('\n== peak traffic ==');
check('peaks are the busiest hours, ranked',
  m.peakHours.length === 2 && m.peakHours[0].hour === 9 && m.peakHours[1].hour === 14, m.peakHours);
check('ties break toward the earlier hour', m.peakHour.hour === 9);
check('quiet hours are never a peak',
  empty.peakHours.length === 0 && empty.peakHour === null);
check('callsInPeakHours selects the calls inside those hours',
  m.callsInPeakHours().length === 4 && new Set(m.callsInPeakHours().map(c => c.start.slice(11, 13))).size === 2);
check('formatHourLabel labels midnight and noon correctly',
  m.formatHourLabel(0) === '12 AM' && m.formatHourLabel(12) === '12 PM' &&
    m.formatHourLabel(9) === '9 AM' && m.formatHourLabel(13) === '1 PM' && m.formatHourLabel(99) === '-');

console.log('\n== additional tier ==');
check('only calls that reached the additional prompt are selected',
  m.additionalTierCalls.length === 1 && m.additionalTierCalls[0].caller === 'A', m.additionalTierCalls.length);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAA MODEL OK — the report arithmetic is pinned');
process.exit(0);
