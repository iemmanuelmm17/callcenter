/* The filter date-range control (calendar, presets, keyboard).
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { h, useEffect, useRef, useState } from '../lib/react.js';
import { today } from '../lib/time.js';
import { MAX_RANGE_DAYS, buildCalendarDays, clampEnd, dateString, daysSpan, formatDate, monthNames, weekDays } from '../lib/date-range.js';

function DateRangePicker({start, end, onChange, disabled, maxRangeDays}) {
    /*
     * The span cap this role may pick (F2). Defaults to the 31-day window, so
     * every caller that does not pass one keeps the old behaviour.
     */
    const spanCap = Number(maxRangeDays) > 0 ? Number(maxRangeDays) : MAX_RANGE_DAYS;

    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);

    const [viewDate, setViewDate] = useState(
        start
            ? new Date(start + 'T00:00:00')
            /* Open on the desk's current month, not the browser's: `today` is
             * the date in the reporting timezone (finding C7), and a picker that
             * opens on a different month than the field it is filled with invites
             * the reader to click the wrong day. */
            : new Date(today + 'T00:00:00')
    );

    const [selecting, setSelecting] = useState('start');

    const [tempStart, setTempStart] = useState(start);
    const [tempEnd, setTempEnd] = useState(end);

    const [hoverDate, setHoverDate] = useState('');
    const [popPos, setPopPos] = useState({top: 0, left: 0});

    const popupRef = useRef(null);
    const btnRef = useRef(null);
    const calendarRef = useRef(null);

    /* Today in the same YYYY-MM-DD form as the filter state: the calendar never
     * offers a future day, and clampEnd() is given it to enforce the range. */
    const maxDate = today;

    /*
     * =====================================================
     * FIRST DAY OF MONTH
     * =====================================================
     */
    /*
     * =====================================================
     * CALENDAR DAYS FOR THE VISIBLE MONTH
     * =====================================================
     */
    const calendarDays =
        buildCalendarDays(viewDate);

    /*
     * =====================================================
     * DATE CLICK
     * =====================================================
     */
    const handleDateClick = d => {

        const selected =
            dateString(d);

        if (selected > maxDate) {
            return;
        }

        /*
         * Selecting start date
         */
        if (
            selecting === 'start'
        ) {

            setTempStart(
                selected
            );

            setTempEnd('');

            setHoverDate('');

            setSelecting('end');

            return;
        }

        /*
         * If user clicks before
         * the current start date,
         * make clicked date the new start.
         */
        if (
            tempStart &&
            selected < tempStart
        ) {

            setTempStart(
                selected
            );

            setTempEnd('');

            setHoverDate('');

            return;
        }

        /*
         * Selecting end date
         */
        setTempEnd(
            clampEnd(tempStart, selected, maxDate, spanCap)
        );

        setHoverDate('');

        setSelecting('start');
    };

    /*
     * =====================================================
     * SELECTED START / END
     * =====================================================
     */
    const isSelected = value =>
        value === tempStart ||
        value === tempEnd;

    /*
     * =====================================================
     * RANGE CHECK
     * =====================================================
     */
    const isInRange = value => {

        /*
         * -------------------------------------------------
         * COMPLETED RANGE
         * -------------------------------------------------
         */
        if (
            tempStart &&
            tempEnd
        ) {

            return (
                value >= tempStart &&
                value <= tempEnd
            );
        }

        /*
         * -------------------------------------------------
         * HOVER PREVIEW
         *
         * Start date is selected.
         * User is choosing the end date.
         * -------------------------------------------------
         */
        if (
            selecting === 'end' &&
            tempStart &&
            !tempEnd &&
            hoverDate
        ) {

            const from =
                tempStart < hoverDate
                    ? tempStart
                    : hoverDate;

            const to =
                tempStart < hoverDate
                    ? hoverDate
                    : tempStart;

            return (
                value >= from &&
                value <= to
            );
        }

        return false;
    };

    /*
     * =====================================================
     * APPLY
     * =====================================================
     */
    const apply = () => {

        if (
            tempStart &&
            tempEnd
        ) {

            onChange(
                tempStart,
                tempEnd
            );

            setOpen(false);
        }
    };

    /*
     * =====================================================
     * CANCEL
     * =====================================================
     */
    const cancel = () => {

        setTempStart(start);

        setTempEnd(end);

        setHoverDate('');

        setOpen(false);
    };

    /*
     * =====================================================
     * CLOSE WHEN CLICKING OUTSIDE / ESCAPE
     * =====================================================
     */
    useEffect(() => {

        if (!open) return;

        const handler = e => {

            /*
             * Click outside
             */
            const inPop = popupRef.current && popupRef.current.contains(e.target);
            const inBtn = btnRef.current && btnRef.current.contains(e.target);
            if (!inPop && !inBtn) {
                cancel();
            }

            /*
             * Escape
             */
            if (
                e.key === 'Escape'
            ) {

                cancel();
            }
        };

        document.addEventListener(
            'mousedown',
            handler
        );

        document.addEventListener(
            'keydown',
            handler
        );

        return () => {

            document.removeEventListener(
                'mousedown',
                handler
            );

            document.removeEventListener(
                'keydown',
                handler
            );
        };

    }, [
        open,
        start,
        end
    ]);

    /*
     * =====================================================
     * RENDER
     * =====================================================
     */
    useEffect(() => {
        if (!open || !btnRef.current) return;
        const place = () => {
            const r = btnRef.current.getBoundingClientRect();
            const width = 330;
            let left = r.left;
            if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
            let top = r.bottom + 8;
            setPopPos({top, left});
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open]);

    return h(
        'div',
        {
            ref: btnRef,

            className:
                'relative date-picker'
        },

        /*
         * =================================================
         * DATE RANGE BUTTON
         * =================================================
         */
        h(
            'button',
            {
                type: 'button',
                disabled: !!disabled,
                title: disabled ? 'Date range is locked while call history is loading' : '',

                onClick: () => {
                    if (disabled) return;

                    setTempStart(start);

                    setTempEnd(end);

                    setHoverDate('');

                    setSelecting('start');

                    if (start) {

                        setViewDate(
                            new Date(
                                start +
                                'T00:00:00'
                            )
                        );
                    }

                    setOpen(
                        !open
                    );
                },

                className:
                    'flex items-center gap-2 border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50'
            },

            /*
             * Calendar icon
             */
            h(
                'span',
                {
                    className:
                        'text-slate-500'
                },

                '▣'
            ),

            /*
             * Date text
             */
            h(
                'span',
                null,

                start && end
                    ? `${formatDate(start)} – ${formatDate(end)}`
                    : 'Select date range'
            ),

            /*
             * Dropdown arrow
             */
            h(
                'span',
                {
                    className:
                        'text-slate-500'
                },

                '▾'
            )
        ),

        /*
         * =================================================
         * POPUP
         * =================================================
         */
        open &&
            ReactDOM.createPortal(
            h(
                'div',
                {
                    ref: popupRef,
                    className:
                        'date-picker-pop w-[330px] border border-slate-700 bg-slate-900 p-3 shadow-2xl',
                    style: {
                        top: popPos.top + 'px',
                        left: popPos.left + 'px'
                    }
                },

                /*
                 * =========================================
                 * HEADER
                 * =========================================
                 */
                h(
                    'div',
                    {
                        className:
                            'mb-3 flex items-center justify-between'
                    },

                    /*
                     * Previous month
                     */
                    h(
                        'button',
                        {
                            type: 'button',

                            onClick: () =>
                                setViewDate(
                                    new Date(
                                        viewDate.getFullYear(),
                                        viewDate.getMonth() - 1,
                                        1
                                    )
                                ),

                            className:
                                'px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white'
                        },

                        '‹'
                    ),

                    /*
                     * Month / Year
                     */
                    h(
                        'div',
                        {
                            className:
                                'text-xs font-semibold text-slate-200'
                        },

                        `${monthNames[viewDate.getMonth()]} ${viewDate.getFullYear()}`
                    ),

                    h(
                        'button',
                        {
                            type: 'button',

                            onClick: () =>
                                setViewDate(
                                    new Date(
                                        viewDate.getFullYear(),
                                        viewDate.getMonth() + 1,
                                        1
                                    )
                                ),

                            className:
                                'px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white'
                        },

                        '›'
                    )
                ),

                /*
                 * =========================================
                 * SELECTION STATUS
                 * =========================================
                 */
                h(
                    'div',
                    {
                        className:
                            'mb-3 grid grid-cols-2 gap-2'
                    },

                    /*
                     * START
                     */
                    h(
                        'div',
                        {
                            className:
                                `border px-2 py-1.5 ${
                                    selecting === 'start'
                                        ? 'border-cyan-400'
                                        : 'border-slate-700'
                                }`
                        },

                        h(
                            'div',
                            {
                                className:
                                    'text-[9px] uppercase text-slate-500'
                            },

                            'Start'
                        ),

                        h(
                            'div',
                            {
                                className:
                                    'text-xs text-slate-200'
                            },

                            tempStart
                                ? formatDate(
                                      tempStart
                                  )
                                : 'Select'
                        )
                    ),

                    /*
                     * END
                     */
                    h(
                        'div',
                        {
                            className:
                                `border px-2 py-1.5 ${
                                    selecting === 'end'
                                        ? 'border-cyan-400'
                                        : 'border-slate-700'
                                }`
                        },

                        h(
                            'div',
                            {
                                className:
                                    'text-[9px] uppercase text-slate-500'
                            },

                            'End'
                        ),

                        h(
                            'div',
                            {
                                className:
                                    'text-xs text-slate-200'
                            },

                            tempEnd
                                ? formatDate(
                                      tempEnd
                                  )
                                : 'Select'
                        )
                    )
                ),

                /*
                 * =========================================
                 * WEEK DAYS
                 * =========================================
                 */
                h(
                    'div',
                    {
                        className:
                            'grid grid-cols-7'
                    },

                    ...weekDays.map(
                        day =>
                            h(
                                'div',
                                {
                                    key: day,

                                    className:
                                        'py-1 text-center text-[9px] text-slate-500'
                                },

                                day
                            )
                    )
                ),

                /*
                 * =========================================
                 * CALENDAR
                 * =========================================
                 */
                h(
                    'div',
                    {
                        ref: calendarRef,

                        onMouseLeave: () => {

                            /*
                             * Clear hover only while
                             * selecting the end date.
                             */
                            if (
                                selecting === 'end'
                            ) {

                                setHoverDate('');
                            }
                        },

                        className:
                            'grid grid-cols-7'
                    },

                    ...calendarDays.map(
                        (d, i) => {

                            /*
                             * Empty calendar cells
                             */
                            if (!d) {

                                return h(
                                    'div',
                                    {
                                        key:
                                            `empty-${i}`,

                                        className:
                                            'h-8'
                                    }
                                );
                            }

                            const value =
                                dateString(d);

                            /*
                             * Is start/end?
                             */
                            const selected =
                                isSelected(
                                    value
                                );

                            /*
                             * Is part of completed
                             * or preview range?
                             */
                            const inRange =
                                isInRange(
                                    value
                                );

                            /*
                             * Is this EXACTLY the
                             * date under the mouse?
                             */
                            const isHovering =
                                selecting === 'end' &&
                                tempStart &&
                                !tempEnd &&
                                hoverDate === value;

                            /*
                             * Is this part of the
                  * temporary hover range?
                             */
                            const isPreview =
                                selecting === 'end' &&
                                tempStart &&
                                !tempEnd &&
                                hoverDate &&
                                inRange;

                            /*
                             * Today
                             */
                            /* The desk's today, which is the day the report
                             * beside this picker is about (finding C7) - not the
                             * date the reader's machine thinks it is. */
                            const todayValue = today;

                            /*
                             * ---------------------------------
                             * BACKGROUND
                             * ---------------------------------
                             *
                             * Priority:
                             *
                             * 1. Hovered date
                             * 2. Selected start/end
                             * 3. Hover preview range
                             * 4. Existing selected range
                             * 5. Transparent
                             */
                            let background =
                                'transparent';

                            if (
                                isHovering
                            ) {

                                background =
                                    '#06b6d4';

                            } else if (
                                selected
                            ) {

                                background =
                                    '#06b6d4';

                            } else if (
                                isPreview
                            ) {

                                background =
                                    'rgba(6, 182, 212, 0.25)';

                            } else if (
                                inRange
                            ) {

                                background =
                                    'rgba(6, 182, 212, 0.15)';
                            }

                            /*
                             * ---------------------------------
                             * TEXT COLOR
                             * ---------------------------------
                             */
                            let color =
                                '#cbd5e1';

                            if (
                                isHovering
                            ) {

                                color =
                                    '#020617';

                            } else if (
                                selected
                            ) {

                                color =
                                    '#020617';

                            } else if (
                                isPreview
                            ) {

                                color =
                                    '#a5f3fc';

                            } else if (
                                inRange
                            ) {

                                color =
                                    '#a5f3fc';

                            } else if (
                                value === todayValue
                            ) {

                                color =
                                    '#22d3ee';
                            }

                            /*
                             * ---------------------------------
                             * FONT WEIGHT
                             * ---------------------------------
                             */
                            let fontWeight =
                                '400';

                            if (
                                isHovering ||
                                selected ||
                                value === todayValue
                            ) {

                                fontWeight =
                                    '600';
                            }

                            /*
                             * ---------------------------------
                             * DATE BUTTON
                             * ---------------------------------
                             */
                            const isFuture = value > maxDate;

                            return h(
                                'button',
                                {
                                    key: value,

                                    type: 'button',

                                    disabled: isFuture,

                                    onClick: () =>
                                        handleDateClick(
                                            d
                                        ),

                                    /*
                                     * IMPORTANT:
                                     *
                                     * This directly changes
                                     * hoverDate state.
                                     */
                                    onMouseEnter: () => {

                                        if (
                                            selecting === 'end' &&
                                            tempStart &&
                                            !tempEnd
                                        ) {

                                            setHoverDate(
                                                value
                                            );
                                        }
                                    },

                                    style: {
                                        backgroundColor:
                                            background,

                                        color:
                                            color,

                                        fontWeight:
                                            fontWeight,

                                        transition:
                                            'background-color 100ms ease, color 100ms ease'
                                    },

                                    /*
                                     * IMPORTANT:
                                     *
                                     * NO hover:bg-* class here.
                                     *
                                     * Tailwind hover background
                                     * would override the inline
                                     * background behavior.
                                     */
                                    className:
                                        'h-8 w-full text-[11px] transition-colors'
                                },

                                d.getDate()
                            );
                        }
                    )
                ),

                /*
                 * =========================================
                 * FOOTER
                 * =========================================
                 */
                h(
                    'div',
                    {
                        className:
                            'mt-3 flex items-center justify-between border-t border-slate-700 pt-3'
                    },

                    /*
                     * CANCEL
                     */
                    h(
                        'button',
                        {
                            type: 'button',

                            onClick:
                                cancel,

                            className:
                                'px-2 py-1 text-xs text-slate-400 hover:text-white'
                        },

                        'Cancel'
                    ),

                    /*
                     * APPLY
                     */
                    h(
                        'button',
                        {
                            type: 'button',

                            disabled:
                                !tempStart ||
                                !tempEnd ||
                                tempEnd > maxDate ||
                                daysSpan(tempStart, tempEnd) > spanCap,

                            onClick:
                                apply,

                            className:
                                'border border-cyan-500 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40'
                        },

                        'Apply'
                    )
                )
            )
            , document.body)
    );
}

export { DateRangePicker };
