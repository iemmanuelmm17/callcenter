/* The agent compare view: two agents (or a range) side by side.
 *
 * Split out of the single-file assets/js/src/app.js by
 * tools/split-js-file.mjs, then out of components/agents.js when that file
 * reached four views in one. Every function body below is byte-identical to the
 * original — the split is verified by hashing the declaration before and after
 * (see CHANGES.md, QA round 2). */

import { api } from '../lib/api.js';
import { fmt, fmtNum } from '../lib/format.js';
import { h, useCallback, useEffect, useState } from '../lib/react.js';
import { readSlaSeconds } from '../lib/sla.js';
import { DateRangePicker } from './date-range-picker.js';
import { SearchableSelect, Tooltip, skel } from './ui.js';

function pickAgentRow(report, extension) {
    const rows = Array.isArray(report?.agentPerformance) ? report.agentPerformance : [];
    if (!rows.length) return null;
    if (extension) {
        const hit = rows.find(r => String(r.extension) === String(extension));
        if (hit) return hit;
    }
    return rows[0];
}

function AgentCompare({filters, callTypes, onAgentClick}) {
    const [roster, setRoster] = useState([]);
    const [left, setLeft] = useState('');
    const [right, setRight] = useState('');
    const [range, setRange] = useState({start: filters.start, end: filters.end});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [leftReport, setLeftReport] = useState(null);
    const [rightReport, setRightReport] = useState(null);

    useEffect(() => {
        setRange({start: filters.start, end: filters.end});
    }, [filters.start, filters.end]);

    useEffect(() => {
        let active = true;
        api('agents', filters)
            .then(r => {
                if (!active) return;
                const data = Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
                setRoster(data);
                if (!left && data[0]) setLeft(String(data[0].extension));
                if (!right && data[1]) setRight(String(data[1].extension));
                else if (!right && data[0]) setRight(String(data[0].extension));
            })
            .catch(() => { if (active) setRoster([]); });
        return () => { active = false; };
    }, [filters.start, filters.end, filters.department, filters.site]);

    const load = useCallback(async () => {
        if (!left || !right) return;
        setLoading(true);
        setError('');
        try {
            /*
             * skipPrevious: this view compares two AGENTS against each
             * other, never against the previous period, so the second CDR
             * sweep was pure waste — and doubly so here, since two reports
             * are requested in parallel (4 sweeps for data nobody reads).
             */
            const body = (agent) => ({
                ...filters,
                start: range.start,
                end: range.end,
                agents: [agent],
                callTypes,
                slaSeconds: readSlaSeconds(),
                skipPrevious: 1,
                /*
                 * An agent with no call in the range still gets a row (all
                 * zeros). Without it two idle agents left this screen saying
                 * "Select two agents to compare" with both already selected.
                 */
                zeroCallAgents: 1
            });
            const [a, b] = await Promise.all([
                api('report', body(left)),
                api('report', body(right))
            ]);
            const unwrap = r => (r?.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : r;
            setLeftReport(unwrap(a));
            setRightReport(unwrap(b));
        } catch (e) {
            setError(e.message || 'Unable to compare agents.');
            setLeftReport(null);
            setRightReport(null);
        } finally {
            setLoading(false);
        }
    }, [left, right, range.start, range.end, filters, callTypes]);

    useEffect(() => { load(); }, [load]);

    const leftRow = pickAgentRow(leftReport, left);
    const rightRow = pickAgentRow(rightReport, right);
    const leftName = roster.find(a => String(a.extension) === String(left));
    const rightName = roster.find(a => String(a.extension) === String(right));
    const options = roster.map(a => ({
        value: String(a.extension),
        label: a.name || a.extension
    }));

    const groups = [
        {
            title: 'Volume',
            rows: [
                ['total', 'Total calls', 'n', false],
                ['ib', 'Inbound', 'n', false],
                ['ob', 'Outbound', 'n', false],
                ['mc', 'Missed', 'n', true],
                ['onnet', 'On-net', 'n', false]
            ]
        },
        {
            title: 'Inbound timing',
            rows: [
                ['ibAht', 'AHT', 't', true],
                ['ibAat', 'AAT', 't', true],
                ['ibLtt', 'Longest talk', 't', true],
                ['ibTct', 'Total talk', 't', false]
            ]
        },
        {
            title: 'Outbound timing',
            rows: [
                ['obArt', 'ART', 't', true],
                ['obAat', 'AAT', 't', true],
                ['obLtt', 'Longest talk', 't', true],
                ['obTct', 'Total talk', 't', false]
            ]
        }
    ];

    const swap = () => {
        const a = left, b = right;
        setLeft(b);
        setRight(a);
    };

    const metricRow = (field, label, kind, lowerBetter) => {
        const a = Number((leftRow && leftRow[field]) || 0);
        const b = Number((rightRow && rightRow[field]) || 0);
        const max = Math.max(a, b, 1);
        const aw = Math.round((a / max) * 100);
        const bw = Math.round((b / max) * 100);
        const delta = a - b;
        const betterLeft = lowerBetter ? a < b : a > b;
        const betterRight = lowerBetter ? b < a : b > a;
        const deltaText = a === b
            ? '0'
            : (kind === 't'
                ? ((delta > 0 ? '+' : '−') + fmt(Math.abs(delta)))
                : ((delta > 0 ? '+' : '') + fmtNum(delta)));
        const deltaCls = a === b
            ? 'text-slate-500'
            : (betterLeft ? 'text-sky-400' : (betterRight ? 'text-orange-400' : 'text-slate-400'));
        const fmtVal = v => kind === 't' ? fmt(v || 0) : fmtNum(v || 0);
        return h('div', {key: field, className: 'cmp-row'},
            h('div', {className: 'cmp-row-label'}, label),
            h('div', {className: 'cmp-bars'},
                h('div', {className: 'cmp-bar-col'},
                    h('div', {className: 'cmp-bar-track'},
                        h('div', {className: 'cmp-bar-fill cmp-bar-blue', style: {width: aw + '%'}})
                    ),
                    h('span', {className: 'cmp-bar-val text-sky-300'}, fmtVal(a))
                ),
                h('div', {className: 'cmp-bar-col'},
                    h('div', {className: 'cmp-bar-track'},
                        h('div', {className: 'cmp-bar-fill cmp-bar-orange', style: {width: bw + '%'}})
                    ),
                    h('span', {className: 'cmp-bar-val text-orange-300'}, fmtVal(b))
                )
            ),
            h('div', {className: 'cmp-delta ' + deltaCls}, deltaText)
        );
    };

    return h('div', {className: 'space-y-3'},
        h('div', {className: 'border border-slate-700 bg-slate-900 p-3'},
            h('div', {className: 'mb-3 flex items-center justify-between'},
                h('div', null,
                    h('h2', {className: 'text-sm font-semibold text-slate-100'}, 'Compare agents'),
                    h('p', {className: 'mt-0.5 text-[10px] text-slate-500'}, 'Search two agents. Blue is Agent 1, burnt orange is Agent 2. Swap to flip sides.')
                ),
                h(Tooltip, {text: 'Each side loads a filtered agent report for the chosen dates. Delta is Agent 1 minus Agent 2.'},
                    h('span', {className: 'cursor-help border-b border-dotted border-slate-600 text-[10px] text-slate-500'}, 'How it works')
                )
            ),
            h('div', {className: 'flex flex-wrap items-end gap-3'},
                h('div', {className: 'min-w-[12rem] flex-1'},
                    h('div', {className: 'mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-sky-400'},
                        h('span', {className: 'cmp-dot cmp-dot-blue'}),
                        'Agent 1'
                    ),
                    h(SearchableSelect, {
                        value: left,
                        onChange: setLeft,
                        options,
                        placeholder: 'Search agent 1…',
                        accent: 'blue'
                    })
                ),
                h('button', {
                    type: 'button',
                    title: 'Swap agents',
                    onClick: swap,
                    className: 'cmp-swap'
                },
                    h('svg', {xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 16 16', fill: 'currentColor', width: 16, height: 16, 'aria-hidden': 'true'},
                        h('path', {d: 'M5.5 3.5 3 6h2.5V13h1V6H9L6.5 3.5h-1zm5 9L13 10h-2.5V3h-1v7H7l2.5 2.5h1z'})
                    )
                ),
                h('div', {className: 'min-w-[12rem] flex-1'},
                    h('div', {className: 'mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-orange-400'},
                        h('span', {className: 'cmp-dot cmp-dot-orange'}),
                        'Agent 2'
                    ),
                    h(SearchableSelect, {
                        value: right,
                        onChange: setRight,
                        options,
                        placeholder: 'Search agent 2…',
                        accent: 'orange'
                    })
                ),
                h('div', null,
                    h('div', {className: 'text-[10px] uppercase tracking-wide text-slate-500'}, 'Date range'),
                    h('div', {className: 'mt-1'},
                        h(DateRangePicker, {
                            start: range.start,
                            end: range.end,
                            onChange: (start, end) => setRange({start, end})
                        })
                    )
                )
            ),
            (leftName || rightName) ? h('div', {className: 'mt-3 flex flex-wrap gap-3 text-[11px] text-slate-400'},
                /*
                 * The numbers on this screen came from the COMPARE range, not
                 * from the page's date filter. Passing the range along is what
                 * makes the drill-down list add up to the figure that was
                 * clicked instead of to a different period.
                 */
                h('button', {
                    type: 'button',
                    className: 'cursor-pointer text-sky-300 hover:underline',
                    title: 'Open these calls (' + range.start + ' → ' + range.end + ')',
                    onClick: () => left && onAgentClick && onAgentClick({ extension: left, start: range.start, end: range.end })
                }, (leftName?.name || left) + ' · calls'),
                h('button', {
                    type: 'button',
                    className: 'cursor-pointer text-orange-300 hover:underline',
                    title: 'Open these calls (' + range.start + ' → ' + range.end + ')',
                    onClick: () => right && onAgentClick && onAgentClick({ extension: right, start: range.start, end: range.end })
                }, (rightName?.name || right) + ' · calls')
            ) : null
        ),

        error ? h('div', {className: 'border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300'}, error) : null,

        loading ? h('div', {className: 'border border-slate-700 bg-slate-900 p-3'},
            skel('h-3 w-40'),
            ...Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'mt-2'}, skel('h-8')))
        ) :

        (!leftRow && !rightRow) ? h('div', {className: 'border border-slate-700 bg-slate-900 p-8 text-center text-xs text-slate-500'}, 'Select two agents to compare.') :

        h('div', {className: 'space-y-3'},
            ...groups.map(g => h('section', {key: g.title, className: 'cmp-section'},
                h('div', {className: 'cmp-section-title'}, g.title),
                ...g.rows.map(([field, label, kind, lowerBetter]) => metricRow(field, label, kind, lowerBetter))
            ))
        )
    );
}

export { AgentCompare };
