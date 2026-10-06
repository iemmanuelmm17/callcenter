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

/* The picker never selects more than this many days, and never a future one. */
const MAX_RANGE_DAYS = 31;

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
 * more than MAX_RANGE_DAYS from the start. `maxDate` is passed in (the caller
 * knows today) so this stays pure.
 */
const clampEnd = (from, to, maxDate) => {
    let end = to;
    if (end > maxDate) end = maxDate;
    if (daysSpan(from, end) > MAX_RANGE_DAYS) {
        end = addDays(from, MAX_RANGE_DAYS - 1);
        if (end > maxDate) end = maxDate;
    }
    return end;
};

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
