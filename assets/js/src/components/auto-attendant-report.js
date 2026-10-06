/* Auto-attendant performance report.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { AutoAttendantStructure } from './auto-attendant-structure.js';
import { AaCallsSheet } from './auto-attendants.js';
import { skel, skelKpis, skelPanel } from './ui.js';
import { fmtNum } from '../lib/format.js';
import { h } from '../lib/react.js';
import { APP_TZ, nsTimestampParts, parseCallInstant, tzParts } from '../lib/time.js';
import {
    getAdditionalCase,
    getAdditionalPrompt,
    getAdditionalTier,
    getAnswer,
    getCaller,
    getCase,
    getDestination,
    getDirection,
    getDisconnectReason,
    getEnd,
    getQueue,
    getStart,
    getTalkSeconds,
    getTotalSeconds,
    isAdditionalTier,
    value
} from '../lib/aa-call-fields.js';

function AutoAttendantReport({
    data,
    structures,
    view,
    selectedAutoAttendants,
    filters,
    loading
}) {

    const hourlyChartRef = React.useRef(null);
    const hourlyChartInstance = React.useRef(null);

    const digitsChartRef = React.useRef(null);
    const digitsChartInstance = React.useRef(null);

    const destinationChartRef = React.useRef(null);
    const destinationChartInstance = React.useRef(null);

    const outcomesChartRef = React.useRef(null);
    const outcomesChartInstance = React.useRef(null);

    const [callPage, setCallPage] = React.useState(1);
    const [callPageSize, setCallPageSize] = React.useState(10);
    const [aaList, setAaList] = React.useState(null);
    const openAaCalls = (title, list) => setAaList({title, rows: list || []});

    React.useEffect(() => {
        setCallPage(1);
    }, [selectedAutoAttendants, data]);

    /*
     * =========================================================
     * SELECTED AA
     * =========================================================
     */

    const selected = Array.isArray(selectedAutoAttendants)
        ? selectedAutoAttendants.map(String)
        : [];

    /*
     * =========================================================
     * FILTER CALLS
     * =========================================================
     */

    const calls = Array.isArray(data)
        ? data.filter(call =>
            selected.includes(
                String(call.extension || '')
            )
        )
        : [];

    /*
     * =========================================================
     * HELPERS
     * =========================================================
     */

    /*
     * Field readers (getCaller, getStart, ...) live in lib/aa-call-fields.js
     * so they can be unit-tested without rendering this page (QA-11).
     */

    /*
     * =========================================================
     * ADDITIONAL TIER
     * =========================================================
     */

    const additionalTierCalls =
        calls.filter(isAdditionalTier);

    /*
     * =========================================================
     * SUMMARY
     * =========================================================
     */

    const totalCalls = calls.length;

    const uniqueCallers =
        new Set(
            calls
                .map(getCaller)
                .map(x => String(x).trim())
                .filter(Boolean)
        ).size;

    const totalDurationSeconds =
        calls.reduce(
            (total, call) =>
                total +
                getTotalSeconds(call),
            0
        );

    const averageDurationSeconds =
        totalCalls
            ? totalDurationSeconds / totalCalls
            : 0;

    /*
     * =========================================================
     * ABANDONMENT
     * =========================================================
     *
     * One definition, shared with every other report
     * (includes/reporting/outcomes.php): the caller reached the attendant and
     * the call was never answered by a person.
     *
     * `api/aa.php` decides that and sends it as `call.abandoned`. The screen
     * used to re-derive it from the disconnect-reason text on top of the
     * backend flag (`caller hung up` AND never engaged), which is why the Auto
     * Attendant abandonment rate disagreed with the Dashboard, Agents, Queues
     * and Alerts screens for the same calls: calls the PBX released with a
     * different reason string, or that never produced one, were silently left
     * out here.
     *
     * The disconnect reason is still shown per call (and in the outcome
     * breakdown) — it explains a call, it no longer decides the number.
     */

    const isAbandoned = call => call.abandoned === true;

    const abandonedCalls = calls.filter(isAbandoned);
    const abandonedCount = abandonedCalls.length;

    const abandonmentRate =
        totalCalls
            ? (abandonedCount / totalCalls) * 100
            : 0;

    /*
     * =========================================================
     * OUTCOME
     * =========================================================
     */

    const outcomeMap = {};

    calls.forEach(call => {

        let reason =
            getDisconnectReason(call);

        if (!reason) {
            reason = 'Unknown';
        }

        let label = reason;

        if (/no digit/i.test(reason)) {
            label = 'No Digit';
        }
        else if (/no queue/i.test(reason)) {
            label = 'No Queue';
        }
        else if (/dtmf/i.test(reason)) {
            label = 'DTMF';
        }
        else if (/orig:\s*bye/i.test(reason)) {
            label = 'Caller Hangup';
        }

        if (call.abandoned === true) {
            label = 'Abandoned';
        }

        outcomeMap[label] =
            (outcomeMap[label] || 0) + 1;
    });

    const outcomeRows =
        Object.entries(outcomeMap)
            .map(
                ([outcome, count]) => ({
                    outcome,
                    count
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            );

    /*
     * =========================================================
     * DIGITS / CASE
     * =========================================================
     */

    const digitMap = {};

    calls.forEach(call => {

        const digit =
            getCase(call) || '-';

        if (!digitMap[digit]) {
            digitMap[digit] = {
                digit,
                calls: 0
            };
        }

        digitMap[digit].calls++;
    });

    const digitRows =
        Object.values(digitMap)
            .sort((a, b) => {

                if (a.digit === '-') {
                    return 1;
                }

                if (b.digit === '-') {
                    return -1;
                }

                return (
                    Number(a.digit) -
                    Number(b.digit)
                );
            });

    /*
     * =========================================================
     * DESTINATIONS
     * =========================================================
     */

    const destinationMap = {};

    calls.forEach(call => {

        const destination =
            getDestination(call) || '-';

        destinationMap[destination] =
            (destinationMap[destination] || 0) + 1;
    });

    const destinationRows =
        Object.entries(destinationMap)
            .map(
                ([destination, count]) => ({
                    destination,
                    count
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            )
            .slice(0, 10);

    /*
     * =========================================================
     * HOURLY
     * =========================================================
     */

    const hourCounts = Array.from({length: 24}, () => 0);

    calls.forEach(call => {
        const start = getStart(call);
        if (!start) return;
        const instant = parseCallInstant(start);
        if (!instant) return;
        const hour = Number(tzParts(instant, APP_TZ).hour);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
            hourCounts[hour]++;
        }
    });

    const hourlyRows = hourCounts.map((count, hour) => ({
        hour: String(hour).padStart(2, '0') + ':00',
        count
    }));

    /*
     * =========================================================
     * PEAK TRAFFIC
     * =========================================================
     *
     * Which hours actually carry the load, so staffing and trunk capacity
     * can be pointed at them. Ranked by volume; empty hours are dropped so
     * a quiet day cannot report "midnight" as a peak just because it sorts
     * first. Ties break toward the earlier hour, which keeps the label
     * stable between refreshes.
     */

    const peakHours = hourCounts
        .map((count, hour) => ({hour, count}))
        .filter(entry => entry.count > 0)
        .sort((a, b) => (b.count - a.count) || (a.hour - b.hour))
        .slice(0, 3);

    const peakHour = peakHours[0] || null;

    const formatHourLabel = hour => {
        const value = Number(hour);
        if (!Number.isInteger(value) || value < 0 || value > 23) return '-';
        if (value === 0) return '12 AM';
        if (value === 12) return '12 PM';
        return (value > 12 ? value - 12 : value) + (value >= 12 ? ' PM' : ' AM');
    };

    /* Calls landing inside any of the three peak hours. */
    const peakHourSet = new Set(peakHours.map(entry => entry.hour));

    const callsInPeakHours = () => calls.filter(call => {
        const start = getStart(call);
        if (!start) return false;
        const instant = parseCallInstant(start);
        if (!instant) return false;
        return peakHourSet.has(Number(tzParts(instant, APP_TZ).hour));
    });

    /*
     * =========================================================
     * FORMATTERS
     * =========================================================
     */

    const formatTalkTime = seconds => {

        seconds =
            Math.max(
                0,
                Number(seconds) || 0
            );

        const hours =
            Math.floor(seconds / 3600);

        const minutes =
            Math.floor(
                (seconds % 3600) / 60
            );

        const secs =
            Math.floor(seconds % 60);

        if (hours > 0) {

            return (
                String(hours).padStart(2, '0') +
                ':' +
                String(minutes).padStart(2, '0') +
                ':' +
                String(secs).padStart(2, '0')
            );
        }

        return (
            String(minutes).padStart(2, '0') +
            ':' +
            String(secs).padStart(2, '0')
        );
    };

    const formatDateTime = input => {
        const parts = nsTimestampParts(input);
        if (parts.date && parts.time) {
            return parts.date + ' ' + parts.time;
        }
        if (!input) {
            return '-';
        }
        return String(input);
    };

    const formatPhone = input => {

        const digits =
            String(input || '')
                .replace(/\D/g, '');

        if (digits.length === 10) {

            return (
                '(' +
                digits.substring(0, 3) +
                ') ' +
                digits.substring(3, 6) +
                '-' +
                digits.substring(6)
            );
        }

        if (
            digits.length === 11 &&
            digits.startsWith('1')
        ) {

            return (
                '(' +
                digits.substring(1, 4) +
                ') ' +
                digits.substring(4, 7) +
                '-' +
                digits.substring(7)
            );
        }

        return input || '-';
    };

    const outcomeBadge = reason => {
        const raw = String(reason || '').trim() || 'Unknown';
        let cls = 'aa-pill-term';
        let label = raw;
        if (/orig:\s*bye|hang\s*-?up/i.test(raw)) {
            cls = 'aa-pill-hang';
            label = /orig:\s*bye/i.test(raw) && !/hang/i.test(raw) ? raw : 'Hangup';
        } else if (/term:\s*bye/i.test(raw)) {
            cls = 'aa-pill-term';
            label = 'Term: Bye';
        } else if (/transfer|forward/i.test(raw)) {
            cls = 'aa-pill-xfer';
            label = 'Transferred';
        } else if (/no digit/i.test(raw)) {
            cls = 'aa-pill-warn';
            label = 'No Digit';
        }
        return h('span', {className: 'aa-pill ' + cls, title: raw}, label);
    };

    const formatPercent = count => {

        if (!totalCalls) {
            return '0.0%';
        }

        return (
            (
                count /
                totalCalls *
                100
            ).toFixed(1) +
            '%'
        );
    };

    /*
     * =========================================================
     * CALL PATH
     * =========================================================
     */

    const getCallPath = call => {

        const parts = [];

        const rootCase =
            getCase(call);

        const additionalTier =
            getAdditionalTier(call);

        const additionalPrompt =
            getAdditionalPrompt(call);

        const additionalCase =
            getAdditionalCase(call);

        const destination =
            getDestination(call);

        const queue =
            getQueue(call);

        if (rootCase) {

            parts.push(
                'Case ' + rootCase
            );
        }

        if (additionalTier) {

            if (additionalPrompt) {

                parts.push(
                    additionalPrompt.replace(
                        /^Prompt_/i,
                        'Prompt '
                    )
                );
            }

            if (additionalCase) {

                parts.push(
                    'Case ' +
                    additionalCase
                );
            }
        }

        if (
            queue &&
            queue !== destination
        ) {

            parts.push(
                'Queue ' + queue
            );
        }

        if (destination) {

            parts.push(
                destination
            );
        }

        if (!parts.length) {
            return 'Direct';
        }

        return parts.join(' → ');
    };

    /*
     * =========================================================
     * CHART CLEANUP
     * =========================================================
     */

    React.useEffect(() => {

        return () => {

            if (hourlyChartInstance.current) {

                hourlyChartInstance.current.destroy();

                hourlyChartInstance.current =
                    null;
            }

            if (digitsChartInstance.current) {

                digitsChartInstance.current.destroy();

                digitsChartInstance.current =
                    null;
            }

            if (destinationChartInstance.current) {

                destinationChartInstance.current.destroy();

                destinationChartInstance.current =
                    null;
            }
        };

    }, []);

    /*
     * =========================================================
     * HOURLY CHART
     * =========================================================
     */

    React.useEffect(() => {

        if (!hourlyChartRef.current) {
            return;
        }

        if (hourlyChartInstance.current) {

            hourlyChartInstance.current.destroy();

            hourlyChartInstance.current =
                null;
        }

        const hourCtx = hourlyChartRef.current.getContext('2d');
        const hourFill = hourCtx.createLinearGradient(0, 0, 0, 160);
        hourFill.addColorStop(0, 'rgba(56, 189, 248, 0.42)');
        hourFill.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

        hourlyChartInstance.current =
            new Chart(
                hourlyChartRef.current,
                {
                    type: 'line',

                    data: {
                        labels:
                            hourlyRows.map(
                                row =>
                                    row.hour + ':00'
                            ),

                        datasets: [
                            {
                                label: 'Calls',

                                data:
                                    hourlyRows.map(
                                        row =>
                                            row.count
                                    ),

                                tension: 0.4,

                                fill: true,
                                borderColor: '#38bdf8',
                                backgroundColor: hourFill,
                                pointRadius: 0,
                                pointHoverRadius: 4,
                                borderWidth: 2
                            }
                        ]
                    },

                    options: {
                        responsive: true,

                        maintainAspectRatio: false,

                        plugins: {
                            legend: {
                                display: false
                            }
                        },

                        scales: {
                            x: {
                                grid: {
                                    display: false
                                },
                                ticks: {
                                    color: '#94a3b8',
                                    maxRotation: 0
                                }
                            },

                            y: {
                                beginAtZero: true,
                                grid: {
                                    color: 'rgba(148,163,184,0.08)'
                                },
                                ticks: {
                                    precision: 0,
                                    color: '#94a3b8'
                                }
                            }
                        }
                    }
                }
            );

        return () => {

            if (hourlyChartInstance.current) {

                hourlyChartInstance.current.destroy();

                hourlyChartInstance.current =
                    null;
            }
        };

    }, [calls, view, selected]);

    /*
     * =========================================================
     * DIGIT CHART
     * =========================================================
     */

    React.useEffect(() => {

        if (!digitsChartRef.current) {
            return;
        }

        if (digitsChartInstance.current) {

            digitsChartInstance.current.destroy();

            digitsChartInstance.current =
                null;
        }

        if (!digitRows.length) {
            return;
        }

        digitsChartInstance.current =
            new Chart(
                digitsChartRef.current,
                {
                    type: 'bar',

                    data: {
                        labels:
                            digitRows.map(
                                row =>
                                    row.digit
                            ),

                        datasets: [
                            {
                                label: 'Calls',

                                data:
                                    digitRows.map(
                                        row =>
                                            row.calls
                                    ),

                                backgroundColor: '#38bdf8',
                                borderRadius: 4,
                                borderWidth: 0,
                                barPercentage: 0.7,
                                categoryPercentage: 0.8
                            }
                        ]
                    },

                    options: {
                        responsive: true,

                        maintainAspectRatio: false,

                        onHover: (event, elements) => {
                            const t = event?.native?.target;
                            if (t) t.style.cursor = elements?.length ? 'pointer' : 'default';
                        },

                        onClick: (evt, els) => {
                            if (!els.length) return;
                            const row = digitRows[els[0].index];
                            if (!row) return;
                            const related = calls.filter(call => (getCase(call) || '-') === row.digit);
                            openAaCalls('Digit ' + row.digit, related);
                        },

                        plugins: {
                            legend: {
                                display: false
                            },

                            tooltip: {
                                callbacks: {

                                    label: context => {

                                        const row =
                                            digitRows[
                                                context.dataIndex
                                            ];

                                        return (
                                            row.calls +
                                            ' calls (' +
                                            formatPercent(
                                                row.calls
                                            ) +
                                            ')'
                                        );
                                    }
                                }
                            }
                        },

                        scales: {
                            x: {
                                grid: {
                                    display: false
                                },
                                ticks: { color: '#94a3b8' }
                            },

                            y: {
                                beginAtZero: true,
                                grid: {
                                    display: true,
                                    color: 'rgba(148,163,184,0.16)',
                                    lineWidth: 1,
                                    drawBorder: false,
                                    drawTicks: false
                                },
                                ticks: {
                                    precision: 0,
                                    color: '#94a3b8'
                                }
                            }
                        }
                    }
                }
            );

        return () => {

            if (digitsChartInstance.current) {

                digitsChartInstance.current.destroy();

                digitsChartInstance.current =
                    null;
            }
        };

    }, [calls, view, selected]);

    /*
     * =========================================================
     * DESTINATION CHART
     * =========================================================
     */

    React.useEffect(() => {

        if (!destinationChartRef.current) {
            return;
        }

        if (destinationChartInstance.current) {

            destinationChartInstance.current.destroy();

            destinationChartInstance.current =
                null;
        }

        if (!destinationRows.length) {
            return;
        }

        destinationChartInstance.current =
            new Chart(
                destinationChartRef.current,
                {
                    type: 'bar',

                    data: {
                        labels:
                            destinationRows.map(
                                row =>
                                    row.destination
                            ),

                        datasets: [
                            {
                                label: 'Calls',

                                data:
                                    destinationRows.map(
                                        row =>
                                            row.count
                                    ),

                                borderWidth: 0
                            }
                        ]
                    },

                    options: {
                        indexAxis: 'y',

                        responsive: true,

                        maintainAspectRatio: false,

                        plugins: {
                            legend: {
                                display: false
                            }
                        },

                        scales: {
                            x: {
                                beginAtZero: true,

                                ticks: {
                                    precision: 0
                                },

                                title: {
                                    display: true,
                                    text: 'Calls'
                                }
                            },

                            y: {
                                title: {
                                    display: true,
                                    text: 'Destination'
                                },

                                grid: {
                                    display: false
                                }
                            }
                        }
                    }
                }
            );

        return () => {

            if (destinationChartInstance.current) {

                destinationChartInstance.current.destroy();

                destinationChartInstance.current =
                    null;
            }
        };

    }, [calls, view, selected]);

    React.useEffect(() => {
        if (!outcomesChartRef.current) return;
        if (outcomesChartInstance.current) {
            outcomesChartInstance.current.destroy();
            outcomesChartInstance.current = null;
        }
        if (!outcomeRows.length) return;
        const palette = ['#f87171', '#94a3b8', '#34d399', '#a78bfa', '#fbbf24', '#38bdf8'];
        outcomesChartInstance.current = new Chart(outcomesChartRef.current, {
            type: 'doughnut',
            data: {
                labels: outcomeRows.map(r => r.outcome),
                datasets: [{
                    data: outcomeRows.map(r => r.count),
                    backgroundColor: outcomeRows.map((_, i) => palette[i % palette.length]),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                onHover: (event, elements) => {
                    const t = event?.native?.target;
                    if (t) t.style.cursor = elements?.length ? 'pointer' : 'default';
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    const row = outcomeRows[els[0].index];
                    if (!row) return;
                    const related = calls.filter(call => {
                        let reason = getDisconnectReason(call) || 'Unknown';
                        let label = reason;
                        if (/no digit/i.test(reason)) label = 'No Digit';
                        else if (/no queue/i.test(reason)) label = 'No Queue';
                        else if (/dtmf/i.test(reason)) label = 'DTMF';
                        else if (/orig:\s*bye/i.test(reason)) label = 'Caller Hangup';
                        return label === row.outcome;
                    });
                    openAaCalls(row.outcome, related);
                },
                plugins: { legend: { display: false } }
            }
        });
        return () => {
            if (outcomesChartInstance.current) {
                outcomesChartInstance.current.destroy();
                outcomesChartInstance.current = null;
            }
        };
    }, [calls, view, selected]);

    if (loading && !Array.isArray(data)) {
        if (view === 'structure') {
            return h('div', {className: 'aa-structure'},
                h('section', {className: 'aa-hero'},
                    skel('h-3 w-48 mb-3'),
                    h('div', {className: 'aa-hero-grid'},
                        h('div', {className: 'aa-hero-total'}, skel('h-10 w-32'), skel('mt-3 h-9 w-full'), skel('mt-2 h-3 w-40')),
                        h('div', {className: 'aa-hero-breaks'},
                            skel('h-12 w-full'),
                            skel('mt-2 h-12 w-full'),
                            skel('mt-2 h-12 w-full')
                        )
                    )
                ),
                h('section', {className: 'aa-flow-card dash-card mt-3'},
                    skel('h-4 w-40 mb-3'),
                    ...Array.from({length: 6}, (_, i) => h('div', {key: i, className: 'py-2'}, skel('h-9 w-full')))
                )
            );
        }
        return h('div', {className: 'space-y-3'},
            skelKpis(4),
            skelPanel('h-44'),
            h('div', {className: 'aa-dist-grid'},
                skelPanel('h-36'),
                skelPanel('h-36'),
                skelPanel('h-36')
            ),
            skelPanel('h-56')
        );
    }

    /*
     * =========================================================
     * EMPTY SELECTION
     * =========================================================
     */

    if (selected.length === 0) {

        return h(
            'div',
            {
                className:
                    'flex h-full items-center justify-center text-sm text-slate-500'
            },
            'Select an Auto Attendant.'
        );
    }

    if (view === 'structure') {
        return h(React.Fragment, null,
            h(AutoAttendantStructure, {
                selected,
                structures,
                data,
                onShowCalls: setAaList
            }),
            aaList
                ? h(AaCallsSheet, {
                    title: aaList.title,
                    rows: aaList.rows,
                    onClose: () => setAaList(null)
                })
                : null
        );
    }

    /*
     * =========================================================
     * SUMMARY CARD
     * =========================================================
     */

    const StatCard = (
        label,
        number,
        color = 'text-slate-100',
        detail = null
    ) => {

        return h(
            'div',
            {
                className:
                    'kpi-card'
            },

            h(
                'div',
                {
                    className:
                        'text-[9px] uppercase tracking-wide text-slate-500'
                },
                label
            ),

            h(
                'div',
                {
                    className:
                        'mt-0.5 text-xl font-semibold leading-tight ' +
                        color
                },
                number
            ),

            detail
                ? h(
                    'div',
                    {
                        className:
                            'mt-0.5 text-[10px] text-slate-500'
                    },
                    detail
                )
                : null
        );
    };

    /*
     * =========================================================
     * ADDITIONAL TIER TABLE ROWS
     * =========================================================
     */

    const additionalTierGroups =
        Object.values(
            additionalTierCalls.reduce(
                (map, call) => {

                    const key = [
                        call.extension,
                        getAdditionalTier(call),
                        getAdditionalPrompt(call),
                        getAdditionalCase(call),
                        getDestination(call)
                    ].join('|');

                    if (!map[key]) {

                        map[key] = {
                            call,
                            count: 0
                        };
                    }

                    map[key].count++;

                    return map;

                },
                {}
            )
        );

    /*
     * =========================================================
     * CALL DETAIL ROWS
     * =========================================================
     */

    const callTotal = calls.length;
    const callPages = Math.max(1, Math.ceil(callTotal / callPageSize));
    const safeCallPage = Math.min(callPage, callPages);
    const callStart = (safeCallPage - 1) * callPageSize;
    const callEnd = Math.min(callStart + callPageSize, callTotal);
    const pagedCalls = calls.slice(callStart, callEnd);

    const callRows = pagedCalls.map(
        (call, index) => {

            const id =
                String(
                    call.id || (callStart + index)
                );

            return h(
                    'tr',
                    {
                        key: id,
                        className:
                            'border-b border-slate-800'
                    },

                    h(
                        'td',
                        {
                            className:
                                'whitespace-nowrap px-3 py-2 text-slate-400'
                        },
                        formatDateTime(
                            getStart(call)
                        )
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2 text-slate-300'
                        },
                        formatPhone(
                            getCaller(call)
                        )
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2 font-medium text-slate-300'
                        },
                        call.extension || '-'
                    ),

                    h(
                        'td',
                        {
                            className:
                                'max-w-[420px] px-3 py-2 text-cyan-300'
                        },

                        h(
                            'div',
                            {
                                className:
                                    'truncate'
                            },
                            getCallPath(call)
                        )
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2 text-slate-300'
                        },
                        getDestination(call) || '-'
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2'
                        },
                        outcomeBadge(getDisconnectReason(call))
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2 text-slate-400'
                        },
                        formatTalkTime(
                            getTalkSeconds(call)
                        )
                    ),

                    h(
                        'td',
                        {
                            className:
                                'px-3 py-2 text-slate-400'
                        },
                        formatTalkTime(
                            getTotalSeconds(call)
                        )
                    )
            );

        }
    );

    /*
     * =========================================================
     * RENDER
     * =========================================================
     */

    const durationSpark = (() => {
        const nums = (hourlyRows || []).map(r => Number(r.count || 0));
        const max = Math.max(1, ...nums, 0);
        const w = 110, ht = 32, pad = 2;
        const step = nums.length > 1 ? (w - pad * 2) / (nums.length - 1) : 0;
        const pts = nums.map((v, i) => (pad + i * step).toFixed(1) + ',' + (ht - pad - ((v / max) * (ht - pad * 2))).toFixed(1)).join(' ');
        return h('svg', {className:'aa-spark', viewBox:'0 0 ' + w + ' ' + ht, width: w, height: ht},
            h('polyline', {fill:'none', stroke:'#38bdf8', strokeWidth:'1.6', points: pts}));
    })();

    /*
     * 24 slim bars — the whole day at a glance, with the three peak hours
     * lit up. Reading the shape matters more than reading exact values
     * here; the Calls by Hour chart below carries the detail.
     */
    const peakSpark = (() => {
        const max = Math.max(1, ...hourCounts);
        const w = 110, ht = 32, gap = 1.2;
        const barW = (w - gap * 23) / 24;
        return h('svg', {className:'aa-spark', viewBox:'0 0 ' + w + ' ' + ht, width: w, height: ht},
            ...hourCounts.map((count, hour) => {
                const hgt = count > 0 ? Math.max(1.5, (count / max) * (ht - 2)) : 1;
                return h('rect', {
                    key: hour,
                    x: (hour * (barW + gap)).toFixed(2),
                    y: (ht - hgt).toFixed(2),
                    width: barW.toFixed(2),
                    height: hgt.toFixed(2),
                    rx: 0.8,
                    fill: peakHourSet.has(hour) ? '#fbbf24' : '#334155'
                });
            }));
    })();

    const dateHint = (filters && filters.start)
        ? (filters.start === filters.end ? filters.start : (filters.start + ' – ' + filters.end))
        : '';

    const overview = h(
        'div',
        {
            className:
                'aa-overview'
        },

        /*
         * HEADER
         */

        h('div', {className:'aa-ov-head'},
            h('div', null,
                h('h2', {className:'text-lg font-semibold text-slate-100'}, 'Auto Attendant Calls'),
                h('div', {className:'text-xs text-slate-500'},
                    totalCalls.toLocaleString() + ' logical calls' + (dateHint ? ' · ' + dateHint : ''))
            ),
            h('div', {className:'text-xs text-slate-500'},
                additionalTierCalls.length.toLocaleString() + ' additional-tier')
        ),

        h('div', {className:'aa-kpi-grid'},
            h('button', {type:'button', className:'aa-kpi-card', onClick:() => openAaCalls('All AA calls', calls)},
                h('div', {className:'aa-kpi-label'}, 'Volume'),
                h('div', {className:'aa-kpi-value'}, totalCalls.toLocaleString()),
                h('div', {className:'aa-kpi-sub'}, uniqueCallers.toLocaleString() + ' unique callers')
            ),
            h('button', {
                type:'button',
                className:'aa-kpi-card',
                title:'Calls that reached the attendant and were never answered — the same abandoned rule the Dashboard, Agents, Queues and Alerts use. Click to open them.',
                onClick:() => openAaCalls('Abandoned AA calls', abandonedCalls)
            },
                h('div', {className:'aa-kpi-label'}, 'Abandonment Rate'),
                h('div', {className:'aa-kpi-value aa-kpi-bad'}, abandonmentRate.toFixed(1) + '%'),
                h('div', {className:'aa-res-track'},
                    h('div', {className:'aa-res-un', style:{width: Math.min(100, abandonmentRate) + '%'}}),
                    h('div', {className:'aa-res-ans', style:{width: Math.max(0, 100 - abandonmentRate) + '%'}})
                ),
                h('div', {className:'aa-kpi-sub'},
                    abandonedCount.toLocaleString() + ' of ' + totalCalls.toLocaleString() + ' calls abandoned')
            ),
            h('button', {
                type:'button',
                className:'aa-kpi-card',
                title:'Highest volume hours — size systems and staffing to these. Click to open calls in these hours.',
                onClick:() => openAaCalls('Peak traffic calls', callsInPeakHours())
            },
                h('div', {className:'aa-kpi-label'}, 'Peak Traffic Times'),
                h('div', {className:'aa-kpi-value aa-kpi-peak' + (peakHour ? '' : ' is-empty')},
                    peakHour ? formatHourLabel(peakHour.hour) : '—'),
                peakSpark,
                h('div', {className:'aa-kpi-sub'},
                    peakHours.length
                        ? peakHours.map(entry =>
                            formatHourLabel(entry.hour) + ' (' + entry.count.toLocaleString() + ')'
                          ).join(' · ')
                        : 'No call volume in range')
            ),
            h('button', {type:'button', className:'aa-kpi-card', onClick:() => openAaCalls('AA calls', calls)},
                h('div', {className:'aa-kpi-label'}, 'Duration'),
                h('div', {className:'aa-kpi-value'}, formatTalkTime(averageDurationSeconds)),
                durationSpark,
                h('div', {className:'aa-kpi-sub'}, 'Average total duration')
            )
        ),

        h('section', {className:'aa-hero-chart'},
            h('div', {className:'dash-label'}, 'Calls by Hour'),
            h('div', {className:'text-[10px] text-slate-500 mb-1'}, 'US/Eastern'),
            h('div', {className:'aa-hero-canvas cursor-pointer'}, h('canvas', {ref: hourlyChartRef}))
        ),

        h('div', {className:'aa-dist-grid'},
            h('section', {className:'aa-dist-card'},
                h('div', {className:'dash-label'}, 'Cases / Digits'),
                h('div', {className:'aa-chart cursor-pointer'}, h('canvas', {ref: digitsChartRef}))
            ),
            h('section', {className:'aa-dist-card'},
                h('div', {className:'dash-label'}, 'Call Outcomes'),
                h('div', {className:'aa-donut-wrap'},
                    h('div', {className:'aa-donut-canvas cursor-pointer'},
                        h('canvas', {ref: outcomesChartRef}),
                        h('div', {className:'aa-donut-center pointer-events-none'},
                            h('div', {className:'text-lg font-semibold text-slate-100'},
                                fmtNum(outcomeRows.reduce((n, r) => n + Number(r.count || 0), 0))),
                            h('div', {className:'text-[10px] uppercase text-slate-500'}, 'total')
                        )
                    ),
                    h('div', {className:'aa-donut-legend'},
                        ...outcomeRows.map((row, i) => {
                            const colors = ['#f87171', '#94a3b8', '#34d399', '#a78bfa', '#fbbf24', '#38bdf8'];
                            return h('button', {
                                key: row.outcome,
                                type: 'button',
                                className: 'aa-legend-row',
                                onClick: () => openAaCalls(row.outcome, calls.filter(call => {
                                    let reason = getDisconnectReason(call) || 'Unknown';
                                    let label = reason;
                                    if (/no digit/i.test(reason)) label = 'No Digit';
                                    else if (/no queue/i.test(reason)) label = 'No Queue';
                                    else if (/dtmf/i.test(reason)) label = 'DTMF';
                                    else if (/orig:\s*bye/i.test(reason)) label = 'Caller Hangup';
                                    return label === row.outcome;
                                }))
                            },
                                h('span', {className:'aa-legend-dot', style:{background: colors[i % colors.length]}}),
                                h('span', {className:'truncate'}, row.outcome),
                                h('span', {className:'ml-auto text-slate-400'}, formatPercent(row.count))
                            );
                        })
                    )
                )
            ),
            h('section', {className:'aa-dist-card'},
                h('div', {className:'dash-label'}, 'Top Destinations'),
                h('div', {className:'aa-chart cursor-pointer'}, h('canvas', {ref: destinationChartRef}))
            )
        ),

        /*
         * =====================================================
         * CALL DETAILS
         * =====================================================
         */

        h(
            'div',
            {
                className:
                    'overflow-hidden rounded border border-slate-700'
            },

            h(
                'div',
                {
                    className:
                        'border-b border-slate-700 bg-slate-900 px-3 py-3'
                },

                h(
                    'h3',
                    {
                        className:
                            'text-sm font-semibold text-slate-200'
                    },
                    'Call Details'
                ),

                h(
                    'div',
                    {
                        className:
                            'text-[10px] text-slate-500'
                    },
                    'Logical AA journeys for the selected attendant.'
                )
            ),

            calls.length === 0

                ? h(
                    'div',
                    {
                        className:
                            'p-6 text-center text-sm text-slate-500'
                    },
                    'No records found for the selected Auto Attendant.'
                )

                : h(
                    'div',
                    {
                        className:
                            'overflow-x-auto'
                    },

                    h(
                        'table',
                        {
                            className:
                                'w-full text-xs'
                        },

                        h(
                            'thead',
                            {
                                className:
                                    'border-b border-slate-700 bg-slate-900 text-left text-[10px] uppercase text-slate-500'
                            },

                            h(
                                'tr',
                                null,

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Time'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Caller'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'AA'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Call Path'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Destination'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Outcome'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Talk'
                                ),

                                h(
                                    'th',
                                    {
                                        className:
                                            'px-3 py-2'
                                    },
                                    'Total'
                                )
                            )
                        ),

                        h(
                            'tbody',
                            null,
                            ...callRows
                        )
                    ),

                    h(
                        'div',
                        {
                            className:
                                'flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-400'
                        },

                        h(
                            'div',
                            {
                                className:
                                    'flex items-center gap-2'
                            },

                            'Rows per page:',

                            h(
                                'select',
                                {
                                    value: callPageSize,
                                    onChange: e => {
                                        setCallPageSize(Number(e.target.value));
                                        setCallPage(1);
                                    },
                                    className:
                                        'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300'
                                },
                                h('option', {value: 10}, '10'),
                                h('option', {value: 25}, '25'),
                                h('option', {value: 50}, '50'),
                                h('option', {value: 100}, '100')
                            ),

                            h(
                                'span',
                                {className: 'ml-2 text-slate-500'},
                                callTotal === 0
                                    ? 'Showing 0 of 0'
                                    : ('Showing ' + (callStart + 1) + '–' + callEnd + ' of ' + callTotal)
                            )
                        ),

                        h(
                            'div',
                            {className: 'flex items-center gap-1'},

                            h(
                                'button',
                                {
                                    type: 'button',
                                    disabled: safeCallPage <= 1,
                                    onClick: () => setCallPage(p => Math.max(1, p - 1)),
                                    className:
                                        'rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                                },
                                'Prev'
                            ),

                            h(
                                'span',
                                {className: 'px-2 text-slate-300'},
                                'Page ' + safeCallPage + ' of ' + callPages
                            ),

                            h(
                                'button',
                                {
                                    type: 'button',
                                    disabled: safeCallPage >= callPages,
                                    onClick: () => setCallPage(p => Math.min(callPages, p + 1)),
                                    className:
                                        'rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                                },
                                'Next'
                            )
                        )
                    )
                )
        )
    );

    return h(React.Fragment, null,
        overview,
        aaList
            ? h(AaCallsSheet, {
                title: aaList.title,
                rows: aaList.rows,
                onClose: () => setAaList(null)
            })
            : null
    );
}

export { AutoAttendantReport };
