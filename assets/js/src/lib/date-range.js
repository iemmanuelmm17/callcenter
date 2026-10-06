/* Calendar and date-range arithmetic for the filter control (QA follow-up).
 *
 * These lived as ~200 lines of closures inside DateRangePicker. Every one of
 * them is a pure function of its arguments — the component keeps the state, the
 * popup and the keyboard handling — so they sit here where they can be tested
 * directly (tests/js/date-range.mjs) instead of only through a rendered popup.
 *
 * Dates are `YYYY-MM-DD` strings in local time, which is what the API and the
 * filter state use; everything is constructed with a `T00:00:00` suffix so a
 * timezone is never in play.
 */

const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
];

const weekDays = [
    'Su',
    'Mo',
    'Tu',
    'We',
    'Th',
    'Fr',
    'Sa'
];

/*
 * =====================================================
 * FORMAT DATE FOR DISPLAY
 * =====================================================
 */
const formatDate = value => {
    if (!value) return '';

    const d = new Date(
        value + 'T00:00:00'
    );

    return d.toLocaleDateString(
        'en-US',
        {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }
    );
};

/*
 * =====================================================
 * CONVERT DATE OBJECT TO YYYY-MM-DD
 * =====================================================
 */
const dateString = d => {
    const y = d.getFullYear();

    const m = String(
        d.getMonth() + 1
    ).padStart(2, '0');

    const day = String(
        d.getDate()
    ).padStart(2, '0');

    return `${y}-${m}-${day}`;
};

/*
 * The picker never selects more than this many days, and never a future one.
 *
 * 31 is the safe window for a supervisor: the day cache is fetched one day at a
 * time, so a bookmarked multi-month URL used to fan out into hundreds of
 * upstream requests. The office manager is the person who produces the
 * month-end and year-on-year packs, so `maxRangeDaysFor(role)` gives them a year
 * - the same split `authorizedFilters()` enforces server-side, stated here so
 * the picker cannot offer a range the API will clamp.
 */
const MAX_RANGE_DAYS = 31;
const MANAGER_MAX_RANGE_DAYS = 366;

const maxRangeDaysFor = role => (role === 'office_manager' ? MANAGER_MAX_RANGE_DAYS : MAX_RANGE_DAYS);

const daysSpan = (from, to) => {
    if (!from || !to) return 0;
    const a = new Date(from + 'T00:00:00');
    const b = new Date(to + 'T00:00:00');
    return Math.round((b - a) / 864e5) + 1;
};
const addDays = (ymd, n) => {
    const d = new Date(ymd + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return dateString(d);
};

/*
 * Pull an end date back inside the allowed window: never after today, never
 * more than `maxDays` (default MAX_RANGE_DAYS) from the start. `maxDate` is
 * passed in (the caller knows today) so this stays pure.
 */
const clampEnd = (from, to, maxDate, maxDays = MAX_RANGE_DAYS) => {
    let end = to;
    if (end > maxDate) end = maxDate;
    if (daysSpan(from, end) > maxDays) {
        end = addDays(from, maxDays - 1);
        if (end > maxDate) end = maxDate;
    }
    return end;
};

/*
 * =====================================================
 * CALENDAR BOUNDARIES (F2)
 * =====================================================
 *
 * Every boundary here is string arithmetic on a YYYY-MM-DD in the desk's
 * calendar - the Eastern date the app reports in - and never a Date built from
 * the browser's local midnight.
 *
 * That distinction is the whole reason these helpers exist: a Date is an
 * instant, and midnight on the 1st in a browser in, say, Tokyo is the previous
 * afternoon in New York. The presets used to build `new Date(y, m, 1)` and
 * label it with the app's formatter, so "This month" could quietly ask for the
 * last day of the previous month. Labels and dates now come from the same
 * strings, so they cannot disagree.
 */
const pad2 = n => String(n).padStart(2, '0');

/* First day of a month, and the day n months away from one (day clamped). */
const monthStart = ymd => ymd.slice(0, 7) + '-01';

const shiftMonths = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const total = (y * 12) + (m - 1) + n;
    const year = Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    return `${year}-${pad2(month + 1)}-${pad2(Math.min(d, daysInMonth(year, month)))}`;
};

const monthEnd = ymd => addDays(shiftMonths(monthStart(ymd), 1), -1);

/* Weekday of a calendar date, 0 = Sunday, without a timezone in the way. */
const weekdayOf = ymd => new Date(ymd + 'T00:00:00Z').getUTCDay();

/* Monday of the week that contains the date (the desk's week starts Monday). */
const weekStart = ymd => addDays(ymd, -((weekdayOf(ymd) + 6) % 7));

const quarterStart = ymd => `${ymd.slice(0, 4)}-${pad2(Math.floor((Number(ymd.slice(5, 7)) - 1) / 3) * 3 + 1)}-01`;

const yearStart = ymd => ymd.slice(0, 4) + '-01-01';

/*
 * =====================================================
 * DAYS IN MONTH
 * =====================================================
 */
const daysInMonth = (
    year,
    month
) =>
    new Date(
        year,
        month + 1,
        0
    ).getDate();

function buildCalendarDays(viewDate) {
    const firstDay = new Date(
        viewDate.getFullYear(),
        viewDate.getMonth(),
        1
    ).getDay();

    const days = daysInMonth(
        viewDate.getFullYear(),
        viewDate.getMonth()
    );

    const calendarDays = [];

    for (let i = 0; i < firstDay; i++) {
        calendarDays.push(null);
    }

    for (let i = 1; i <= days; i++) {
        calendarDays.push(
            new Date(
                viewDate.getFullYear(),
                viewDate.getMonth(),
                i
            )
        );
    }

    return calendarDays;
}

export {
    MAX_RANGE_DAYS,
    MANAGER_MAX_RANGE_DAYS,
    maxRangeDaysFor,
    monthStart,
    monthEnd,
    shiftMonths,
    weekdayOf,
    weekStart,
    quarterStart,
    yearStart,
    buildCalendarDays,
    clampEnd,
    dateString,
    daysInMonth,
    daysSpan,
    addDays,
    formatDate,
    monthNames,
    weekDays
};
