/**
 * Unit tests for the filter control's calendar arithmetic.
 *
 * These helpers were closures inside the 1,079-line DateRangePicker; they are
 * pure functions of their arguments (lib/date-range.js), so the range rules —
 * inclusive day counting, the 31-day cap, never a future date, the leading
 * blank cells of a month grid — are pinned here instead of only through a
 * rendered popup. tests/js/smoke.mjs drives the real popup on top of this.
 */
import {
  MAX_RANGE_DAYS, addDays, buildCalendarDays, clampEnd, dateString, daysInMonth, daysSpan, formatDate, monthNames, weekDays
} from '../../assets/js/src/lib/date-range.js';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

console.log('== display formatting ==');
check('formatDate renders the API\'s YYYY-MM-DD for a person', formatDate('2026-08-02') === 'Aug 2, 2026', formatDate('2026-08-02'));
check('formatDate of nothing is nothing', formatDate('') === '' && formatDate(undefined) === '');
check('dateString is zero-padded YYYY-MM-DD', dateString(new Date(2026, 0, 5)) === '2026-01-05', dateString(new Date(2026, 0, 5)));
check('month and weekday labels are the calendar\'s own',
  monthNames.length === 12 && monthNames[0] === 'January' && monthNames[11] === 'December' &&
    weekDays.length === 7 && weekDays[0] === 'Su' && weekDays[6] === 'Sa');

console.log('\n== day counting is inclusive ==');
check('one day spans one day', daysSpan('2026-08-01', '2026-08-01') === 1);
check('a full month is 31 days', daysSpan('2026-08-01', '2026-08-31') === 31);
check('an incomplete range is zero, not NaN', daysSpan('', '2026-08-01') === 0 && daysSpan('2026-08-01', '') === 0);

console.log('\n== addDays crosses months and years ==');
check('end of a month rolls into the next', addDays('2026-08-31', 1) === '2026-09-01', addDays('2026-08-31', 1));
check('start of a year rolls back', addDays('2026-01-01', -1) === '2025-12-31', addDays('2026-01-01', -1));

console.log('\n== daysInMonth knows leap years ==');
check('February 2026 is 28 days', daysInMonth(2026, 1) === 28, daysInMonth(2026, 1));
check('February 2028 is 29 days', daysInMonth(2028, 1) === 29, daysInMonth(2028, 1));
check('January is 31 and April is 30', daysInMonth(2026, 0) === 31 && daysInMonth(2026, 3) === 30);

console.log('\n== the range cap (MAX_RANGE_DAYS = ' + MAX_RANGE_DAYS + ') ==');
check('a range inside the cap is kept', clampEnd('2026-08-01', '2026-08-05', '2026-12-31') === '2026-08-05');
check('a future end is pulled back to today', clampEnd('2026-08-01', '2026-12-31', '2026-08-10') === '2026-08-10');
check('exactly MAX_RANGE_DAYS is allowed', clampEnd('2026-08-01', '2026-08-31', '2026-12-31') === '2026-08-31', clampEnd('2026-08-01', '2026-08-31', '2026-12-31'));
check('one day over the cap is trimmed to the cap', clampEnd('2026-08-01', '2026-09-01', '2026-12-31') === '2026-08-31', clampEnd('2026-08-01', '2026-09-01', '2026-12-31'));
check('today still wins when the cap reaches past it', clampEnd('2026-12-20', '2027-12-31', '2026-12-25') === '2026-12-25');

console.log('\n== the month grid ==');
const october = buildCalendarDays(new Date(2026, 9, 1));
check('October 2026 starts on a Thursday, so four blank cells lead it',
  october.slice(0, 4).every(cell => cell === null) && october[4].getDate() === 1 && october.filter(Boolean).length === 31,
  october.slice(0, 6).map(cell => cell && cell.getDate()));
check('every cell of the grid is that month', october.filter(Boolean).every(d => d.getMonth() === 9 && d.getFullYear() === 2026));
check('a month starting on Sunday has no blank cells',
  buildCalendarDays(new Date(2026, 1, 1)).length === 28, buildCalendarDays(new Date(2026, 1, 1)).length);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nDATE RANGE OK — the calendar rules are pinned');
process.exit(0);
