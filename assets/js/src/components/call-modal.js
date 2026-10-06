/* The drill-down calls dialog (Tabulator table + export).
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { CallFlowDialog, loadCallFlow } from './call-flow-dialog.js';
import { buildCallColumns } from './call-modal-columns.js';
import { RecordingPlayer } from './recording-player.js';
import { api, apiDownload } from '../lib/api.js';
import { useMetricCatalog } from '../lib/metrics.js';
import { formatPhoneNumber } from '../lib/format.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';
import { ensureTabulator, h, useEffect, useEscape, useRef, useState } from '../lib/react.js';

function CallModal({metric,hour,timeFrom,timeTo,agent,callId,phoneNumber,callerNumber,queue,queuesOnly,filters,callTypes,slaSeconds,onClose}) {
    /*
     * Metric wording comes from the server catalog (api/filters.php /
     * includes/reporting/metrics.php). Declared before the title uses it —
     * a const is in the temporal dead zone until its own line runs.
     */
    const catalog = useMetricCatalog();
    const metricMeta = catalog[metric] || null;
    /* Chip wording is the label; the dialog title prefers its own wording. */
    const metricLabel = metricMeta ? (metricMeta.label || metricMeta.title || metric) : metric;
    const metricWording = metricMeta ? (metricMeta.title || metricMeta.label || metric) : metric;

    const ref = useRef(null);
    const table = useRef(null);

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    /*
     * Two overlays live inside this dialog: the recording tray and the sip-flow
     * dialog. Escape unwinds them from the inside out — the flow closes first,
     * then the player, and only then the dialog itself.
     */
    const [playing, setPlaying] = useState(null);
    const [flow, setFlow] = useState(null);
    /* Read by the Rec formatter so the playing row can be marked. */
    const playingRef = useRef('');
    playingRef.current = playing ? String(playing.id || playing.origCallId || '') : '';

    useEscape(true, () => {
        if (flow) { setFlow(null); return; }
        if (playing) { setPlaying(null); return; }
        onClose();
    });

    /* The flow dialog is per-row; the tray plays one row at a time. */
    const openFlow = async row => {
        setFlow({ loading: true, row, steps: [] });
        try {
            setFlow({ loading: false, row, steps: await loadCallFlow(row) });
        } catch (e) {
            setFlow({
                loading: false,
                row,
                steps: [],
                error: e && e.message ? e.message : 'Unable to load call flow.'
            });
        }
    };

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
        /* A new scope is a new result set: keep nothing from the old one. */
        setPlaying(null);
        setFlow(null);
    }, [metric, hour, timeFrom, timeTo, agent, callId, phoneNumber, callerNumber, queue, queuesOnly, filters, callTypes, pageSize]);

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
            timeFrom,
            timeTo,
            agent,
            callId,
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

    }, [metric, hour, timeFrom, timeTo, agent, callId, phoneNumber, callerNumber, queue, queuesOnly, slaSeconds, filters, callTypes, page, pageSize]);

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

                    columns: buildCallColumns({
                        slaSeconds,
                        playingRef,
                        onPlay: setPlaying,
                        onFlow: openFlow
                    })
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
     * Tabulator renders its own DOM, so the "this row is playing" mark is
     * re-applied by redrawing when the selection changes — a formatter is not
     * re-run by React state on its own.
     */
    useEffect(() => {
        if (!table.current || typeof table.current.redraw !== 'function') return;
        try { table.current.redraw(); } catch (e) {}
    }, [playing]);


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
                callId,
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

    /*
     * No hard-coded metric wording here: `metricWording` is the server's title
     * (or label), and the raw id is the fallback until the catalog lands.
     */
    const title =
        callId
            /* One specific call (an agent's recent-call row, say). */
            ? 'Call ' + callId + ' details'
            : metricWording + ' call details';


    /*
     * =========================================================
     * CONTEXT LINES
     * =========================================================
     */

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
        filterChips.push({ k: 'View', v: metricLabel });
    }
    if (callId) filterChips.push({ k: 'Call', v: callId });
    if (phoneNumber) filterChips.push({ k: 'Number', v: formatPhoneNumber(phoneNumber) });
    if (callerNumber) filterChips.push({ k: 'Caller', v: formatPhoneNumber(callerNumber) });
    if (agent) filterChips.push({ k: 'Agent', v: String(agent) });
    if (queue) filterChips.push({ k: 'Queue', v: String(queue) });
    else if (queuesOnly) filterChips.push({ k: 'Scope', v: 'Queue calls' });
    if (hour !== null && hour !== undefined) {
        const hh = String(hour).padStart(2, '0');
        filterChips.push({ k: 'Hour', v: hh + ':00–' + hh + ':59' });
    }
    /* The exact interval, when one was clicked (Simultaneous rows). */
    if (timeFrom && timeTo) {
        filterChips.push({ k: 'Window', v: timeFrom + '–' + timeTo });
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
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,

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
         * RECORDING TRAY
         * =================================================
         *
         * One row at a time. The player resolves its own URL when it is
         * mounted without one, so opening a row costs exactly one
         * api/recording.php call and closing it stops the audio.
         */

        playing
            ? h(
                'div',
                { className: 'cm-tray' },
                h(
                    'div',
                    { className: 'cm-tray-head' },
                    h('span', { className: 'cm-tray-title' }, 'Recording'),
                    h(
                        'span',
                        { className: 'cm-tray-sub' },
                        [
                            playing.startedAt ? formatCallDate(playing.startedAt) + ' ' + formatCallTime(playing.startedAt) : '',
                            [playing.from || playing.fromNumber, playing.to || playing.dialed].filter(Boolean).join(' → ')
                        ].filter(Boolean).join(' · ')
                    )
                ),
                h(RecordingPlayer, {
                    row: playing,
                    preresolved: null,
                    onClose: () => setPlaying(null)
                })
            )
            : null,


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
    ),

    /*
     * Sip flow, above everything else. Same dialog Call history opens; the
     * request (loadCallFlow) is the one this modal's rows are shaped for.
     */
    flow
        ? h(CallFlowDialog, {
            row: flow.row,
            steps: flow.steps,
            loading: flow.loading,
            error: flow.error,
            onClose: () => setFlow(null)
        })
        : null
);
}

export { CallModal };
