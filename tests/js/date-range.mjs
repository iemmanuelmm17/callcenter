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
  MAX_RANGE_DAYS, MANAGER_MAX_RANGE_DAYS, addDays, buildCalendarDays, clampEnd, dateString, daysInMonth, daysSpan, formatDate,
  maxRangeDaysFor, monthEnd, monthNames, monthStart, quarterStart, shiftMonths, weekStart, weekdayOf, weekDays, yearStart
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

/* F2: the span cap is per role, and the two sides must agree.
 * includes/auth.php authorizedFilters() clamps a supervisor to 31 days and an
 * office manager to 366; if the picker offered more, the API would quietly trim
 * the range and the numbers on screen would not be the range on the button. */
check('the supervisor cap is the 31-day window', maxRangeDaysFor('supervisor') === MAX_RANGE_DAYS && MAX_RANGE_DAYS === 31);
check('the office manager cap is a year plus the leap day', maxRangeDaysFor('office_manager') === MANAGER_MAX_RANGE_DAYS && MANAGER_MAX_RANGE_DAYS === 366);
check('the cap is role-based, not role-string-lenient', maxRangeDaysFor('office-manager') === MAX_RANGE_DAYS && maxRangeDaysFor('') === MAX_RANGE_DAYS);
check('a caller with a wider cap can select a quarter',
  clampEnd('2026-01-01', '2026-03-31', '2026-12-31', MANAGER_MAX_RANGE_DAYS) === '2026-03-31',
  clampEnd('2026-01-01', '2026-03-31', '2026-12-31', MANAGER_MAX_RANGE_DAYS));
/* 1 Jan 2026 + 365 days = 1 Jan 2027: 366 days inclusive, the last span the
 * manager cap allows. One day more trims back to exactly that. */
check('the manager cap allows exactly 366 days',
  clampEnd('2026-01-01', '2027-01-01', '2027-12-31', MANAGER_MAX_RANGE_DAYS) === '2027-01-01' &&
  daysSpan('2026-01-01', clampEnd('2026-01-01', '2027-01-01', '2027-12-31', MANAGER_MAX_RANGE_DAYS)) === 366,
  clampEnd('2026-01-01', '2027-01-01', '2027-12-31', MANAGER_MAX_RANGE_DAYS));
check('a day past the manager cap is trimmed to the same 366 days',
  clampEnd('2026-01-01', '2027-01-02', '2027-12-31', MANAGER_MAX_RANGE_DAYS) === '2027-01-01' &&
  daysSpan('2026-01-01', clampEnd('2026-01-01', '2027-01-02', '2027-12-31', MANAGER_MAX_RANGE_DAYS)) === 366,
  clampEnd('2026-01-01', '2027-01-02', '2027-12-31', MANAGER_MAX_RANGE_DAYS));
check('the default cap is unchanged for a caller that passes nothing',
  clampEnd('2026-01-01', '2026-03-31', '2026-12-31') === '2026-01-31',
  clampEnd('2026-01-01', '2026-03-31', '2026-12-31'));

/* F2: the preset boundaries. Every one is string arithmetic on a calendar
 * date, so the date a preset asks for cannot depend on the reader's timezone:
 * "This month" is the 1st of the month the desk is currently in. */
console.log('\n== F2: calendar boundaries are dates, not instants ==');
check('a month starts at the 1st', monthStart('2026-10-06') === '2026-10-01' && monthStart('2026-02-28') === '2026-02-01');
check('a month ends at the last day it really has', monthEnd('2026-10-06') === '2026-10-31' && monthEnd('2026-02-10') === '2026-02-28' && monthEnd('2028-02-10') === '2028-02-29');
check('subtracting a month clamps the day, like the API does',
  shiftMonths('2026-03-31', -1) === '2026-02-28' && shiftMonths('2026-01-31', -1) === '2025-12-31',
  [shiftMonths('2026-03-31', -1), shiftMonths('2026-01-31', -1)]);
check('a year earlier clamps a leap day', shiftMonths('2028-02-29', -12) === '2027-02-28', shiftMonths('2028-02-29', -12));
check('weekday 0 is Sunday and 6 is Saturday', weekdayOf('2026-10-04') === 0 && weekdayOf('2026-10-10') === 6);
check('the week starts on Monday', weekStart('2026-10-06') === '2026-10-05' && weekStart('2026-10-04') === '2026-09-28' && weekStart('2026-10-05') === '2026-10-05');
check('the quarter starts on a quarter boundary',
  quarterStart('2026-10-06') === '2026-10-01' && quarterStart('2026-01-01') === '2026-01-01' &&
  quarterStart('2026-03-31') === '2026-01-01' && quarterStart('2026-12-31') === '2026-10-01',
  [quarterStart('2026-10-06'), quarterStart('2026-03-31'), quarterStart('2026-12-31')]);
check('the year starts on 1 January', yearStart('2026-10-06') === '2026-01-01' && yearStart('2026-01-01') === '2026-01-01');
check('a rolling 90-day window is 90 days inclusive',
  daysSpan(addDays('2026-10-06', -89), '2026-10-06') === 90, daysSpan(addDays('2026-10-06', -89), '2026-10-06'));

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
