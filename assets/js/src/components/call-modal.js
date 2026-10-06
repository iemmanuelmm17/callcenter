/* The drill-down calls dialog (Tabulator table + export).
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { api, apiDownload } from '../lib/api.js';
import { fmt, formatPhoneNumber } from '../lib/format.js';
import { ensureTabulator, h, useEffect, useEscape, useRef, useState } from '../lib/react.js';
import { slaRingHtml } from '../lib/sla.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';

function CallModal({metric,hour,agent,phoneNumber,callerNumber,queue,queuesOnly,filters,callTypes,slaSeconds,onClose}) {
  useEscape(true, onClose);

    const ref = useRef(null);
    const table = useRef(null);

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [totalRecords, setTotalRecords] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [exporting, setExporting] = useState(false);
    const [tableReady, setTableReady] = useState(() => typeof window !== 'undefined' && !!window.Tabulator);

    /* Lazy dependency: pull Tabulator in on the first modal, not on boot. */
    useEffect(() => {
        if (tableReady) return undefined;
        let alive = true;
        ensureTabulator()
            .then(() => { if (alive) setTableReady(true); })
            .catch(() => { if (alive) setError('Unable to load the call table.'); });
        return () => { alive = false; };
    }, [tableReady]);

    useEffect(() => {
        setPage(1);
    }, [metric, hour, agent, phoneNumber, callerNumber, queue, queuesOnly, filters, callTypes, pageSize]);

    useEffect(() => {

        let cancelled = false;

        setLoading(true);
        setError('');

        if (table.current) {
            try { table.current.destroy(); } catch (e) {}
            table.current = null;
        }

        api('calls', {
            ...filters,
            callTypes,
            metric,
            hour,
            agent,
            phoneNumber,
            callerNumber,
            queue,
            queuesOnly: !!queuesOnly,
            slaSeconds,
            page,
            size: pageSize
        })
        .then(r => {
            if (cancelled) return;
            const rows = Array.isArray(r?.data) ? r.data : [];
            const total = Number(r?.total || rows.length) || 0;
            const last = Math.max(1, Number(r?.last_page || Math.ceil(total / pageSize) || 1));
            setRecords(rows);
            setTotalRecords(total);
            setTotalPages(last);
        })
        .catch(() => {
            if (cancelled) return;
            setError('Unable to load call details.');
            setRecords([]);
            setTotalRecords(0);
            setTotalPages(1);
        })
        .finally(() => {
            if (!cancelled) setLoading(false);
        });

        return () => {
            cancelled = true;
            if (table.current) {
                try { table.current.destroy(); } catch (e) {}
                table.current = null;
            }
        };

    }, [metric, hour, agent, phoneNumber, callerNumber, queue, queuesOnly, slaSeconds, filters, callTypes, page, pageSize]);

    const startIndex = totalRecords === 0 ? 0 : (page - 1) * pageSize;
    const endIndex = Math.min(startIndex + records.length, totalRecords);
    const currentRows = records;


    /*
     * =========================================================
     * CREATE / UPDATE TABULATOR
     * =========================================================
     *
     * IMPORTANT:
     *
     * Tabulator receives ONLY the current page.
     *
     * React controls pagination.
     *
     * =========================================================
     */

    useEffect(() => {

        if (
            loading ||
            error ||
            !tableReady ||
            !ref.current
        ) {
            return;
        }


        /*
         * Destroy existing table.
         */

        if (table.current) {

            try {
                table.current.destroy();
            } catch (e) {}

            table.current = null;
        }


        /*
         * Create table.
         */

        table.current =
            new Tabulator(
                ref.current,
                {
                    data:
                        currentRows,

                    layout:
                        'fitColumns',

                    height:
                        '58vh',

                    placeholder:
                        'No calls found.',

                    movableColumns:
                        true,

                    columnDefaults: {
                        headerSort:
                            true,

                        resizable:
                            true
                    },

                    columns: [

                        /*
                         * DATE
                         */

                        {
                            title:
                                'Date',

                            field:
                                'startedAt',

                            minWidth:
                                85,

                            formatter: cell => {
                                const v = cell.getValue();
                                const formatted = formatCallDate(v);
                                return formatted || '';
                            }
                        },


                        /*
                         * TIME
                         */

                        {
                            title:
                                'Time',

                            field:
                                'startedAt',

                            minWidth:
                                85,

                            formatter: cell => {
                                const formatted = formatCallTime(cell.getValue());
                                return formatted || '';
                            }
                        },


                        /*
                         * TYPE
                         */

                        {
                            title:
                                'Type',

                            field:
                                'type',

                            minWidth:
                                52,

                            hozAlign:
                                'center',

                            headerHozAlign:
                                'center',

                            formatter: cell => {
                                const t = String(cell.getValue() || '').toLowerCase();
                                const phone = 'M1.885.511a1.745 1.745 0 0 1 2.612.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.678.678 0 0 0 .178.643l2.457 2.457a.678.678 0 0 0 .644.178l2.189-.547a1.745 1.745 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.634 18.634 0 0 1-7.01-4.42 18.634 18.634 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877L1.885.511z';
                                const inboundArrow = 'M15.854.146a.5.5 0 0 1 0 .708L11.707 5H14.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 1 0v2.793L15.146.146a.5.5 0 0 1 .708 0z';
                                const outboundArrow = 'M11.5 1a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2.707l-4.146 4.147a.5.5 0 0 1-.708-.708L14.293 2H12a.5.5 0 0 1-.5-.5z';
                                const missed = 'M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.57 17.57 0 0 0 4.168 6.608 17.57 17.57 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328zM13.78.22a.75.75 0 0 1 0 1.06L4.28 10.78a.75.75 0 1 1-1.06-1.06L12.72.22a.75.75 0 0 1 1.06 0z';
                                let color = '#94a3b8';
                                let label = String(cell.getValue() || '');
                                let paths = [phone];
                                if (t === 'inbound' || t === 'incoming') {
                                    color = '#38bdf8';
                                    label = 'Inbound';
                                    paths = [phone, inboundArrow];
                                } else if (t === 'outbound' || t === 'outgoing') {
                                    color = '#34d399';
                                    label = 'Outbound';
                                    paths = [phone, outboundArrow];
                                } else if (t === 'missed') {
                                    color = '#f87171';
                                    label = 'Missed';
                                    paths = [missed];
                                } else if (t === 'onnet') {
                                    color = '#a78bfa';
                                    label = 'On-net';
                                    paths = [phone];
                                }
                                const wrap = document.createElement('span');
                                wrap.title = label;
                                wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:100%;color:' + color;
                                wrap.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                                    paths.map(d => '<path d="' + d + '"/>').join('') +
                                    '</svg>';
                                return wrap;
                            }
                        },


                        /*
                         * FROM NAME
                         */

                        {
                            title:
                                'From Name',

                            field:
                                'from',

                            minWidth:
                                120,

                            formatter:
                                cell =>
                                    cell.getValue() ||
                                    ''
                        },


                        /*
                         * FROM
                         */

                        {
                            title:
                                'From',

                            field:
                                'fromNumber',

                            minWidth:
                                100,

                            formatter:
                                cell =>
                                    formatPhoneNumber(
                                        cell.getValue()
                                    )
                        },


                        /*
                         * DIALED
                         */

                        {
                            title:
                                'Dialed',

                            field:
                                'dialed',

                            minWidth:
                                100,

                            formatter:
                                cell =>
                                    formatPhoneNumber(
                                        cell.getValue()
                                    )
                        },


                        /*
                         * TO
                         */

                        {
                            title:
                                'To',

                            field:
                                'to',

                            minWidth:
                                90,

                            formatter:
                                cell =>
                                    formatPhoneNumber(
                                        cell.getValue()
                                    )
                        },


                        {
                            title: 'Talk',
                            field: 'talking',
                            minWidth: 70,
                            formatter: cell => fmt(cell.getValue())
                        },
                        {
                            title: 'Ring',
                            field: 'ringing',
                            minWidth: 70,
                            formatter: cell => slaRingHtml(cell.getValue(), slaSeconds)
                        },
                        {
                            title: 'Reason',
                            field: 'disconnectReason',
                            minWidth: 140,
                            formatter: cell => cell.getValue() || ''
                        },

                        /*
                         * TOTAL
                         */

                        {
                            title:
                                'Total',

                            field:
                                'total',

                            minWidth:
                                80,

                            formatter:
                                cell =>
                                    fmt(
                                        cell.getValue()
                                    )
                        }
                    ]
                }
            );


        /*
         * Cleanup.
         */

        return () => {

            if (table.current) {

                try {
                    table.current.destroy();
                } catch (e) {}

                table.current = null;
            }
        };

    }, [
        currentRows,
        loading,
        error,
        tableReady,
        slaSeconds
    ]);


    /*
     * =========================================================
     * PAGE SIZE
     * =========================================================
     */

    const changePageSize =
        value => {

            const size =
                Number(value);

            setPageSize(size);
            setPage(1);
        };


    /*
     * =========================================================
     * PAGE NAVIGATION
     * =========================================================
     */

    const goToPage =
        target => {

            const next =
                Math.max(
                    1,
                    Math.min(
                        totalPages,
                        target
                    )
                );

            setPage(next);
        };


    /*
     * =========================================================
     * BUILD PAGE NUMBERS
     * =========================================================
     *
     * Examples:
     *
     * 1 2 3 4 5 6 7
     *
     * 1 2 3 4 … 10
     *
     * 1 … 4 5 6 … 10
     *
     * 1 … 7 8 9 10
     *
     * =========================================================
     */

    const buildPages =
        () => {

            if (totalPages <= 7) {

                return Array.from(
                    {
                        length:
                            totalPages
                    },

                    (_, i) =>
                        i + 1
                );
            }


            const result = [
                1
            ];


            /*
             * -------------------------------------------------
             * Near beginning
             * -------------------------------------------------
             */

            if (page <= 4) {

                result.push(2);
                result.push(3);
                result.push(4);
                result.push(5);

                result.push(
                    'ellipsis-right'
                );
            }


            /*
             * -------------------------------------------------
             * Near end
             * -------------------------------------------------
             */

            else if (
                page >=
                totalPages - 3
            ) {

                result.push(
                    'ellipsis-left'
                );

                result.push(
                    totalPages - 4
                );

                result.push(
                    totalPages - 3
                );

                result.push(
                    totalPages - 2
                );

                result.push(
                    totalPages - 1
                );
            }


            /*
             * -------------------------------------------------
             * Middle
             * -------------------------------------------------
             */

            else {

                result.push(
                    'ellipsis-left'
                );

                result.push(
                    page - 1
                );

                result.push(
                    page
                );

                result.push(
                    page + 1
                );

                result.push(
                    'ellipsis-right'
                );
            }


            /*
             * -------------------------------------------------
             * Always show last page
             * -------------------------------------------------
             */

            result.push(
                totalPages
            );


            return result;
        };


    const paginationPages =
        buildPages();


    /*
     * =========================================================
     * RECORD RANGE
     * =========================================================
     */

    const recordRange =
        totalRecords === 0

            ? 'Showing 0 of 0'

            : `Showing ${
                startIndex + 1
            }–${
                endIndex
            } of ${
                totalRecords.toLocaleString()
            }`;

    const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

    /*
     * Export the whole result set, not the page on screen. The server streams
     * the CSV in one request; before, this looped api('calls') 100 rows at a
     * time, and every page repeated the full CDR scan behind the modal.
     */
    const exportCallsCsv = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            await apiDownload('calls', {
                ...filters,
                callTypes,
                metric,
                hour,
                agent,
                phoneNumber,
                callerNumber,
                queue,
                queuesOnly: !!queuesOnly,
                slaSeconds,
                export: true
            }, 'calls-' + String(metric || 'all') + '.csv');
        } catch (e) {
            setError('Unable to export calls.');
        } finally {
            setExporting(false);
        }
    };

    /*
     * =========================================================
     * TITLE
     * =========================================================
     */

    const title =
        `${
            metric === 'total'
                ? 'All'
                : (metric === 'incoming' || metric === 'offered')
                    ? 'Inbound + missed'
                    : metric === 'sla_missed'
                    ? 'SLA missed (ring over target)'
                    : metric === 'sla'
                    ? 'Answered within SLA'
                    : metric
        } call details`;


    /*
     * =========================================================
     * CONTEXT LINES
     * =========================================================
     */

    const metricLabels = {
        total: 'All calls', incoming: 'Inbound + missed', offered: 'Offered',
        inbound: 'Inbound', outbound: 'Outbound', missed: 'Missed', onnet: 'On-net',
        answered: 'Answered', abandoned: 'Abandoned', sla: 'Within SLA',
        sla_missed: 'SLA missed', handled: 'Handled', voicemail: 'Voicemail',
        /* The missed breakdown and the queue scopes used to show their raw
         * metric id ("missed_noanswer") in the title and the View chip. */
        missed_abandon: 'Abandoned', missed_noanswer: 'Missed — no answer',
        missed_voicemail: 'Missed — voicemail', missed_no_abandon: 'Missed (not abandoned)',
        queue_abandoned: 'Abandoned in queue', queue_offered: 'Offered to queue'
    };
    const filterChips = [];
    const f = filters || {};
    if (f.start && f.end) {
        filterChips.push({ k: 'Range', v: f.start === f.end ? f.start : (f.start + ' → ' + f.end) });
    } else if (f.start) {
        filterChips.push({ k: 'From', v: f.start });
    }
    if (f.site) filterChips.push({ k: 'Site', v: f.site });
    if (f.department) filterChips.push({ k: 'Dept', v: f.department });
    if (callTypes && typeof callTypes === 'object') {
        const keys = ['inbound', 'outbound', 'missed', 'onnet'];
        const on = keys.filter(k => callTypes[k]);
        filterChips.push({ k: 'Types', v: on.length === keys.length ? 'All' : (on.length ? on.join(', ') : 'None') });
    }
    if (metric) {
        filterChips.push({ k: 'View', v: metricLabels[metric] || String(metric) });
    }
    if (phoneNumber) filterChips.push({ k: 'Number', v: formatPhoneNumber(phoneNumber) });
    if (callerNumber) filterChips.push({ k: 'Caller', v: formatPhoneNumber(callerNumber) });
    if (agent) filterChips.push({ k: 'Agent', v: String(agent) });
    if (queue) filterChips.push({ k: 'Queue', v: String(queue) });
    else if (queuesOnly) filterChips.push({ k: 'Scope', v: 'Queue calls' });
    if (hour !== null && hour !== undefined) {
        const hh = String(hour).padStart(2, '0');
        filterChips.push({ k: 'Hour', v: hh + ':00–' + hh + ':59' });
    }
    if (slaSeconds && (metric === 'sla' || metric === 'sla_missed')) {
        filterChips.push({ k: 'SLA ring', v: slaSeconds + 's' });
    }


    /*
 * =========================================================
 * RENDER
 * =========================================================
 */

return h(
    'div',
    {
        className:
            'fixed inset-0 z-50 bg-slate-950/85 p-5',

        style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        }
    },

    /*
     * =====================================================
     * MODAL
     * =====================================================
     */

    h(
        'div',
        {
            className:
            'call-modal ' +
            'flex w-full max-w-[1400px] ' +
            'flex-col ' +
            'overflow-hidden ' +
            'border border-slate-700 ' +
            'bg-slate-950 ' +
            'shadow-2xl',

            style: {
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '90vh'
            }
        },

        /*
         * =================================================
         * HEADER
         * =================================================
         */

        h(
            'div',
            {
                className:
                    'shrink-0 border-b border-slate-800 ' +
                    'bg-slate-900 px-4 py-3'
            },

            h(
                'div',
                {
                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px'
                    }
                },

                h(
                    'div',
                    {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            minWidth: 0,
                            gap: '16px'
                        }
                    },

                    h(
                        'div',
                        {
                            className:
                                'text-sm font-semibold text-slate-100'
                        },

                        title
                    ),

                    h(
                        'div',
                        {
                            style: {
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: '5px'
                            }
                        },

                        h(
                            'span',
                            {
                                className:
                                    'text-[10px] text-slate-500'
                            },

                            'Total records'
                        ),

                        h(
                            'span',
                            {
                                className:
                                    'text-xs font-medium text-slate-300'
                            },

                            loading
                                ? 'Loading…'
                                : error
                                    ? '—'
                                    : totalRecords.toLocaleString()
                        )
                    )
                ),

                h(
                    'div',
                    {
                        className: 'ml-4 flex shrink-0 items-center gap-2'
                    },
                    h(
                        'button',
                        {
                            type: 'button',
                            onClick: exportCallsCsv,
                            disabled: exporting || loading || !!error || totalRecords === 0,
                            className:
                                'cursor-pointer rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-40'
                        },
                        exporting ? 'Exporting…' : 'Export CSV'
                    ),
                    h(
                        'button',
                        {
                            type:
                                'button',

                            onClick:
                                onClose,

                            className:
                                'text-2xl font-light leading-none text-slate-500 hover:text-slate-200'
                        },

                        '×'
                    )
                )
            ),

            filterChips.length
                ? h(
                    'div',
                    { className: 'call-modal-filters' },
                    ...filterChips.map((chip, index) =>
                        h(
                            'span',
                            {
                                key: 'chip-' + index,
                                className: 'call-modal-chip',
                                title: chip.k + ': ' + chip.v
                            },
                            h('span', { className: 'call-modal-chip-k' }, chip.k),
                            h('span', { className: 'call-modal-chip-v' }, chip.v)
                        )
                    )
                )
                : null
        ),

        /*
         * =================================================
         * TABLE AREA        /*
         * =================================================
         * TABLE AREA
         * =================================================
         */

        h(
            'div',
            {
                className:
                    'min-w-0 flex-1 bg-slate-950',

                style: {
                    minHeight: 0
                }
            },

            /*
             * LOADING
             */

            loading

                ? h(
                    'div',
                    {
                        className:
                            'grid h-[58vh] place-items-center ' +
                            'text-xs text-slate-500'
                    },

                    'Loading call details…'
                )

                :

                /*
                 * ERROR
                 */

                error

                    ? h(
                        'div',
                        {
                            className:
                                'grid h-[58vh] place-items-center ' +
                                'text-xs text-rose-400'
                        },

                        error
                    )

                    :

                    /*
                     * TABULATOR
                     */

                    h(
                        'div',
                        {
                            ref:
                                ref,

                            className:
                                'w-full'
                        }
                    )
        ),

        /*
         * =================================================
         * FOOTER
         * =================================================
         */

        !loading &&
        !error

            ? h(
                'div',
                {
                    className:
                        'shrink-0 border-t border-slate-800 ' +
                        'bg-slate-900 px-4 py-3',

                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }
                },

                /*
                 * LEFT — ROWS PER PAGE
                 */

                h(
                    'div',
                    {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        },

                        className:
                            'text-xs text-slate-400'
                    },

                    h(
                        'span',
                        {
                            className:
                                'text-slate-500'
                        },

                        'Rows per page:'
                    ),

                    h(
                        'select',
                        {
                            value:
                                pageSize,

                            onChange:
                                e =>
                                    changePageSize(
                                        e.target.value
                                    ),

                            className:
                                'rounded border border-slate-700 ' +
                                'bg-slate-950 px-2 py-1 text-xs ' +
                                'text-slate-200 outline-none ' +
                                'focus:border-cyan-500'
                        },

                        h(
                            'option',
                            {
                                value:
                                    10
                            },
                            '10'
                        ),

                        h(
                            'option',
                            {
                                value:
                                    25
                            },
                            '25'
                        ),

                        h(
                            'option',
                            {
                                value:
                                    50
                            },
                            '50'
                        ),

                        h(
                            'option',
                            {
                                value:
                                    100
                            },
                            '100'
                        )
                    ),

                    h(
                        'span',
                        {
                            className:
                                'ml-2 text-slate-500'
                        },

                        recordRange
                    )
                ),

                /*
                 * RIGHT — PAGINATION
                 */

                h(
                    'div',
                    {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }
                    },

                    /*
                     * PREVIOUS
                     */

                    h(
                        'button',
                        {
                            type:
                                'button',

                            disabled:
                                page <= 1,

                            onClick:
                                () =>
                                    goToPage(
                                        page - 1
                                    ),

                            className:
                                'min-w-[30px] rounded border ' +
                                'border-slate-700 bg-slate-950 ' +
                                'px-2 py-1 text-xs text-slate-300 ' +
                                'hover:bg-slate-800 ' +
                                'disabled:cursor-not-allowed ' +
                                'disabled:opacity-30'
                        },

                        '‹'
                    ),

                    /*
                     * PAGE NUMBERS
                     */

                    ...paginationPages.map(
                        (item, index) => {

                            if (
                                typeof item ===
                                'string'
                            ) {

                                return h(
                                    'span',
                                    {
                                        key:
                                            `${item}-${index}`,

                                        className:
                                            'min-w-[20px] px-1 py-1 ' +
                                            'text-center text-xs ' +
                                            'text-slate-600'
                                    },

                                    '…'
                                );
                            }

                            const active =
                                item === page;

                            return h(
                                'button',
                                {
                                    key:
                                        item,

                                    type:
                                        'button',

                                    onClick:
                                        () =>
                                            goToPage(
                                                item
                                            ),

                                    className:
                                        'min-w-[30px] rounded border ' +
                                        'px-2 py-1 text-xs ' +
                                        'transition-colors ' +

                                        (
                                            active

                                                ? 'border-cyan-500 ' +
                                                  'bg-cyan-950/70 ' +
                                                  'text-cyan-300'

                                                : 'border-slate-700 ' +
                                                  'bg-slate-950 ' +
                                                  'text-slate-400 ' +
                                                  'hover:bg-slate-800 ' +
                                                  'hover:text-slate-200'
                                        )
                                },

                                String(item)
                            );
                        }
                    ),

                    /*
                     * NEXT
                     */

                    h(
                        'button',
                        {
                            type:
                                'button',

                            disabled:
                                page >= totalPages,

                            onClick:
                                () =>
                                    goToPage(
                                        page + 1
                                    ),

                            className:
                                'min-w-[30px] rounded border ' +
                                'border-slate-700 bg-slate-950 ' +
                                'px-2 py-1 text-xs ' +
                                'text-slate-300 ' +
                                'hover:bg-slate-800 ' +
                                'disabled:cursor-not-allowed ' +
                                'disabled:opacity-30'
                        },

                        '›'
                    )
                )
            )

            : null
    )
);
}

export { CallModal };
