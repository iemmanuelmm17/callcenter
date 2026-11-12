/* The agent performance table (one row per agent, sortable, drillable).
 *
 * Split out of the single-file assets/js/src/app.js by
 * tools/split-js-file.mjs, then out of components/agents.js when that file
 * reached four views in one. Every function body below is byte-identical to the
 * original — the split is verified by hashing the declaration before and after
 * (see CHANGES.md, QA round 2). */

import { fmt, fmtNum } from '../lib/format.js';
import { h, useEffect, useEscape, useMemo, useState } from '../lib/react.js';
import { countBy, maxBy, sumBy, weightedMean, weightedPct } from '../lib/totals.js';
import { KpiCard } from './charts.js';
import { Tooltip, skel, skelKpis } from './ui.js';

function AgentPerformanceTable({data,loading,onAgentClick,onMetricClick,slaSeconds,missedPct,abandonPct,ahtMinutes,contactPct}) {

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [sortKey, setSortKey] = useState('total');
    const [sortDir, setSortDir] = useState('desc');

    const columns = [
        ['extension', ['Ext'], 'Agent extension number.', 'text', null, 'Extension'],
        ['agent', ['Agent'], 'Agent name. Click to open Overview for this agent.', 'text', null, 'Agent name'],
        ['site', ['Site'], 'Site assigned to the agent.', 'text', null, 'Site'],
        ['total', ['Total', 'Calls'], 'All calls attributed to this agent in the selected range. Click to open those calls.', 'num', 'total', 'Total Calls'],
        ['ib', ['Inbound'], 'Answered inbound calls. Click to open inbound calls.', 'num', 'inbound', 'Inbound Calls'],
        ['ob', ['Outbound'], 'Outbound calls placed by this agent. Click to open outbound calls.', 'num', 'outbound', 'Outbound Calls'],
        ['onnet', ['On-net'], 'Internal (on-network) calls. Click to open on-net calls.', 'num', 'onnet', 'On-net Calls'],
        ['mc', ['Missed', 'Calls'], 'Inbound calls that were not answered and were not abandoned (rang out or went to voicemail). Click to open exactly these calls — abandoned ones have their own column.', 'num', 'missed_no_abandon', 'Missed Calls'],
        ['ab', ['Abandoned', 'Calls'], 'Inbound calls the caller abandoned in a queue or auto attendant. Click to open abandoned calls.', 'num', 'missed_abandon', 'Abandoned Calls'],
        ['mcRate', ['Missed', 'Rate'], 'All missed calls (missed + abandoned) ÷ offered inbound (inbound + missed + abandoned). Same definition as the Dashboard, so both screens show the same rate. Red when above the domain missed-call rate setting.', 'pct', 'missed', 'Missed Rate'],
        ['ibAht', ['Inbound', 'AHT'], 'Inbound average handling time (talk). Red when above the domain AHT setting.', 'dur', 'answered', 'Inbound Average Handling Time'],
        ['ibAat', ['Inbound', 'AAT'], 'Inbound average answer / ring time. Red when above the SLA max-ring setting.', 'dur', 'answered', 'Inbound Average Answer Time'],
        ['ibLtt', ['Inbound', 'LTT'], 'Inbound longest talking time. Click to open answered inbound calls.', 'dur', 'answered', 'Inbound Longest Talking Time'],
        ['ibTct', ['Inbound', 'TCT'], 'Inbound total talking time. Click to open answered inbound calls.', 'dur', 'answered', 'Inbound Total Calling Time'],
        ['obArt', ['Outbound', 'ART'], 'Outbound average ring time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Average Ring Time'],
        ['obAat', ['Outbound', 'AAT'], 'Outbound average answer time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Average Answer Time'],
        ['obLtt', ['Outbound', 'LTT'], 'Outbound longest talking time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Longest Talking Time'],
        ['obTct', ['Outbound', 'TCT'], 'Outbound total talking time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Total Calling Time'],
        /* Sprint B: the two figures the review asks for weekly and that the CDR
         * already carries - a contact rate with its base, and hold. */
        ['obConnectPct', ['Outbound', 'Contact', 'Rate'], 'Outbound calls a human answered ÷ outbound attempts (connects ÷ attempts). Red when below the domain contact-rate setting. Click to open outbound calls — answered ones are the connects.', 'pct', 'outbound', 'Outbound Contact Rate'],
        ['holdAvg', ['Hold', 'Avg'], 'Average hold time on this agent\'s calls that used hold (calls with no hold are not averaged in, so a few long holds are not diluted). Click to open the calls.', 'dur', 'total', 'Average Hold Time'],
        ['holdTotal', ['Hold', 'Total'], 'Total seconds this agent\'s callers spent on hold. Click to open the calls.', 'dur', 'total', 'Total Hold Time']
    ];
    const COLS_KEY = 'callscope-agent-cols';
    const defaultCols = () => Object.fromEntries(columns.map(c => [c[0], true]));
    const [query, setQuery] = useState('');
    const [siteFilter, setSiteFilter] = useState('');
    const [colsOpen, setColsOpen] = useState(false);

    useEscape(colsOpen, () => setColsOpen(false));
    const [colOn, setColOn] = useState(() => {
        try {
            const raw = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
            return raw && typeof raw === 'object' ? Object.assign(defaultCols(), raw) : defaultCols();
        } catch (e) { return defaultCols(); }
    });
    const visibleCols = columns.filter(c => colOn[c[0]] !== false);
    const persistCols = next => {
        setColOn(next);
        try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch (e) {}
    };

    /*
     * Extensions with no calls in the range are listed (the report sends a row
     * of zeros for each one in scope), and this is the switch that hides them.
     * Off by default: a table that leaves out the idle extensions cannot show
     * who was idle. Remembered like the column choice, because a desk with far
     * more extensions than agents wants to set it once, not on every visit.
     */
    const HIDE_ZERO_KEY = 'callscope-agent-hide-zero';
    const [hideZero, setHideZero] = useState(() => {
        try { return localStorage.getItem(HIDE_ZERO_KEY) === '1'; } catch (e) { return false; }
    });
    const toggleHideZero = () => {
        const next = !hideZero;
        setHideZero(next);
        try { localStorage.setItem(HIDE_ZERO_KEY, next ? '1' : '0'); } catch (e) {}
    };
    /* What "0 calls" is measured against, in the words the switch and the empty
     * state share: the rows are the report's, so a department, call-type or
     * sentiment filter narrows them exactly as the date range does. */
    const ZERO_SCOPE = 'for the selected dates and filters';

    const durationFields = ['ibAht','ibAat','ibLtt','ibTct','obArt','obAat','obLtt','obTct'];
    const missLimit = Number(missedPct != null ? missedPct : 20);
    const abLimit = Number(abandonPct != null ? abandonPct : 10);
    const ahtLimitSec = Number(ahtMinutes != null ? ahtMinutes : 5) * 60;
    const slaRing = Number(slaSeconds != null ? slaSeconds : 20);
    const connectLimit = Number(contactPct != null ? contactPct : 50);

    const offeredOf = agent => {
        const n = Number(agent.offered);
        if (Number.isFinite(n) && n > 0) return n;
        return Number(agent.ib || 0) + Number(agent.mc || 0) + Number(agent.ab || 0);
    };
    const rateOf = (agent, field) => {
        if (agent[field] != null && agent[field] !== '') return Number(agent[field] || 0);
        const off = offeredOf(agent);
        if (!off) return 0;
        /* Missed rate is every missed call ÷ offered inbound, exactly like
         * the Dashboard: (mc + ab) / (ib + mc + ab). abRate is the abandon
         * share of the same denominator. */
        if (field === 'mcRate') return ((Number(agent.mc || 0) + Number(agent.ab || 0)) / off) * 100;
        if (field === 'abRate') return (Number(agent.ab || 0) / off) * 100;
        return 0;
    };

    const cellValue = (agent, field) => {
        if (field === 'extension') return agent.extension || '';
        if (field === 'agent') return (agent.name || agent.extension || '') + ' ' + (agent.department || '');
        if (field === 'mcRate' || field === 'abRate') return rateOf(agent, field);
        return agent[field];
    };

    const failTone = (field, agent) => {
        const off = offeredOf(agent);
        if (field === 'mcRate' || field === 'mc') {
            if (!off && !Number(agent.mc || 0)) return null;
            return rateOf(agent, 'mcRate') > missLimit ? 'fail' : 'pass';
        }
        if (field === 'ibAht' && Number(agent.ib || 0) > 0) {
            return Number(agent.ibAht || 0) > ahtLimitSec ? 'fail' : 'pass';
        }
        /* Contact rate is a "more is better" figure, so it fails UNDER the
         * target, unlike every other threshold on this table. An agent with no
         * outbound attempts is neither: there is no rate to judge. */
        if (field === 'obConnectPct') {
            if (Number(agent.ob || 0) === 0) return null;
            return Number(agent.obConnectPct || 0) < connectLimit ? 'fail' : 'pass';
        }
        if (field === 'ibAat' && Number(agent.ib || 0) > 0) {
            return Number(agent.ibAat || 0) > slaRing ? 'fail' : 'pass';
        }
        return null;
    };

    const formatValue = (field, agent) => {
        const blank = v => {
            const s = String(v == null ? '' : v).trim();
            if (!s || s === '0' || s === '0.0' || s === '0.0%' || s === '0%' || s === '00:00:00' || s === '00:00') return '—';
            return s;
        };
        if (field === 'extension') return agent.extension || '—';
        if (field === 'agent') {
            return h('div', {className: 'min-w-[10rem]'},
                h('div', {className: 'truncate font-medium text-cyan-400'}, agent.name || agent.extension || '—'),
                h('div', {className: 'truncate text-[10px] text-slate-500'}, agent.department || '')
            );
        }
        if (durationFields.includes(field)) return blank(fmt(agent[field] || 0));
        if (field === 'site') return agent.site || '—';
        if (field === 'mcRate') return blank(rateOf(agent, field).toFixed(1) + '%');
        const n = Number(agent[field] || 0);
        /* Total calls is the one count that is never blanked. A row built from
         * calls always has at least one, so the only row this changes is an
         * extension listed with none - and there "0" is the fact the row exists
         * to state, where a dash would read as data that failed to load. */
        if (field === 'total') return fmtNum(n);
        return blank(fmtNum(n));
    };

    const rows = Array.isArray(data) ? data : [];
    const sites = Array.from(new Set(rows.map(a => String(a.site || '').trim()).filter(Boolean))).sort();

    /* Search and the per-page site filter - everything except the 0-call switch,
     * so the switch can say how many of the rows these two matched it is
     * hiding (or would hide). */
    const matchesFilters = a => {
        if (siteFilter && String(a.site || '') !== siteFilter) return false;
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return ((a.name || '') + ' ' + (a.extension || '') + ' ' + (a.department || '') + ' ' + (a.site || '')).toLowerCase().includes(q);
    };
    const hasCalls = a => Number(a.total || 0) > 0;
    const zeroCount = rows.filter(a => matchesFilters(a) && !hasCalls(a)).length;

    const sorted = useMemo(() => {
        const copy = rows.filter(a => matchesFilters(a) && (!hideZero || hasCalls(a)));
        const col = columns.find(c => c[0] === sortKey);
        const kind = col ? col[3] : 'num';
        copy.sort((a, b) => {
            let av, bv;
            if (kind === 'text') {
                av = String(cellValue(a, sortKey) || '').toLowerCase();
                bv = String(cellValue(b, sortKey) || '').toLowerCase();
                if (av < bv) return sortDir === 'asc' ? -1 : 1;
                if (av > bv) return sortDir === 'asc' ? 1 : -1;
                return 0;
            }
            av = Number(cellValue(a, sortKey) || 0);
            bv = Number(cellValue(b, sortKey) || 0);
            return sortDir === 'asc' ? av - bv : bv - av;
        });
        return copy;
    }, [rows, sortKey, sortDir, query, siteFilter, hideZero]);

    useEffect(() => { setPage(1); }, [data, pageSize, sortKey, sortDir, query, siteFilter, hideZero]);

    const totalRows = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalRows);
    const paginatedData = sorted.slice(startIndex, endIndex);

    const totals = rows.reduce((acc, a) => {
        acc.calls += Number(a.total || 0);
        acc.missed += Number(a.mc || 0);
        acc.abandoned += Number(a.ab || 0);
        acc.handle += Number(a.ibAht || 0);
        acc.handleN += Number(a.ibAht || 0) > 0 || Number(a.total || 0) > 0 ? 1 : 0;
        if (Number(a.total || 0) > 0) acc.active += 1;
        return acc;
    }, {calls: 0, missed: 0, abandoned: 0, handle: 0, handleN: 0, active: 0});
    const avgHandle = rows.length
        ? (rows.reduce((s, a) => s + Number(a.ibAht || 0) * Math.max(1, Number(a.ib || 0)), 0) /
           Math.max(1, rows.reduce((s, a) => s + Math.max(0, Number(a.ib || 0)), 0)))
        : 0;
    const ahtFallback = rows.length
        ? rows.reduce((s, a) => s + Number(a.ibAht || 0), 0) / Math.max(1, rows.filter(a => Number(a.ibAht || 0) > 0).length)
        : 0;
    const ahtShow = Number.isFinite(avgHandle) && avgHandle > 0 ? avgHandle : ahtFallback;

    /*
     * The totals row (manager review, §5.1): computed from the rows ON SCREEN —
     * `sorted` is the table after search and the per-page site filter, and before
     * pagination, so the row summarises the whole filtered set rather than the
     * ten rows one page happens to show.
     *
     * Aggregates per column kind, stated once here:
     *   counts (total/ib/ob/onnet/mc/ab)          sum
     *   rates  (mcRate/abRate)                    Σnumerator ÷ Σoffered, offered
     *                                             computed by the row's own rule
     *   averages (AHT/AAT/ART/ASAs)               weighted by inbound (or
     *                                             outbound) call volume
     *   total durations (TCT)                     sum
     *   longest durations (LTT)                   max — a sum of "longest"
     *                                             would be meaningless
     */
    const totalsRows = sorted.map(a => Object.assign({}, a, { offered: offeredOf(a) }));
    const totalsAgents = countBy(totalsRows, 'extension');
    /* How many different sites, not how many rows have one. The two were the
     * same number only while every agent sat at a site of their own; a row per
     * idle extension makes the difference plain ("7 agents, 6 sites" for a desk
     * with two sites). */
    const totalsSiteCount = new Set(totalsRows.map(a => String(a.site || '').trim()).filter(Boolean)).size;
    const totalsValue = field => {
        switch (field) {
            case 'agent': return 'All agents';
            case 'extension': return fmtNum(totalsAgents) + (totalsAgents === 1 ? ' agent' : ' agents');
            case 'site': return totalsSiteCount > 0 ? fmtNum(totalsSiteCount) + (totalsSiteCount === 1 ? ' site' : ' sites') : '—';
            case 'total': return fmtNum(sumBy(totalsRows, 'total'));
            case 'ib': return fmtNum(sumBy(totalsRows, 'ib'));
            case 'ob': return fmtNum(sumBy(totalsRows, 'ob'));
            case 'onnet': return fmtNum(sumBy(totalsRows, 'onnet'));
            case 'mc': return fmtNum(sumBy(totalsRows, 'mc'));
            case 'ab': return fmtNum(sumBy(totalsRows, 'ab'));
            case 'mcRate': return totalsRows.length ? weightedPct(totalsRows, ['mc', 'ab'], 'offered').toFixed(1) + '%' : '—';
            case 'ibAht': return totalsRows.length ? fmt(weightedMean(totalsRows, 'ibAht', 'ib')) : '—';
            case 'ibAat': return totalsRows.length ? fmt(weightedMean(totalsRows, 'ibAat', 'ib')) : '—';
            case 'ibLtt': return totalsRows.length ? fmt(maxBy(totalsRows, 'ibLtt')) : '—';
            case 'ibTct': return totalsRows.length ? fmt(sumBy(totalsRows, 'ibTct')) : '—';
            case 'obArt': return totalsRows.length ? fmt(weightedMean(totalsRows, 'obArt', 'ob')) : '—';
            case 'obAat': return totalsRows.length ? fmt(weightedMean(totalsRows, 'obAat', 'ob')) : '—';
            case 'obLtt': return totalsRows.length ? fmt(maxBy(totalsRows, 'obLtt')) : '—';
            case 'obTct': return totalsRows.length ? fmt(sumBy(totalsRows, 'obTct')) : '—';
            /* Connects ÷ attempts over the whole table, and hold over the calls
             * that held - the same rules the rows use, so the total line is a
             * real grand total rather than a sum of rates. */
            case 'obConnectPct': return totalsRows.length ? weightedPct(totalsRows, 'obConnected', 'ob').toFixed(1) + '%' : '—';
            case 'holdAvg': return totalsRows.length ? fmt(weightedMean(totalsRows, 'holdAvg', 'holdCalls')) : '—';
            case 'holdTotal': return totalsRows.length ? fmt(sumBy(totalsRows, 'holdTotal')) : '—';
            default: return '—';
        }
    };
    const totalsKinds = {
        extension: 'text', agent: 'text', site: 'text',
        total: 'num', ib: 'num', ob: 'num', onnet: 'num', mc: 'num', ab: 'num',
        mcRate: 'num',
        ibAht: 'dur', ibAat: 'dur', ibLtt: 'dur', ibTct: 'dur',
        obArt: 'dur', obAat: 'dur', obLtt: 'dur', obTct: 'dur',
        obConnectPct: 'num', holdAvg: 'dur', holdTotal: 'dur'
    };
    const totalsRow = totalsRows.length
        ? h('tr', {className: 'grid-totals'},
            ...visibleCols.map(([field]) => h('td', {
                key: field,
                className: 'px-2 py-2 ' + (totalsKinds[field] === 'text' ? 'text-left' : 'qs-num'),
                title: 'Total for the ' + totalsAgents + ' agent(s) matching the current filters'
            }, totalsValue(field)))
        )
        : null;

    const toggleSort = field => {
        if (sortKey === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else {
            setSortKey(field);
            setSortDir(field === 'agent' || field === 'site' || field === 'extension' ? 'asc' : 'desc');
        }
    };

    const exportCsv = () => {
        const header = ['name','extension','department','site','total_calls','inbound','outbound','onnet','missed_calls','missed_rate','abandoned_calls','abandoned_rate','ib_aht','ib_aat','ib_ltt','ib_tct','ob_art','ob_aat','ob_ltt','ob_tct','ob_contact_pct','hold_avg','hold_total'];
        const body = sorted.map(a => [
            a.name, a.extension, a.department, a.site, a.total, a.ib, a.ob, a.onnet, a.mc, rateOf(a, 'mcRate').toFixed(1),
            a.ab, rateOf(a, 'abRate').toFixed(1),
            a.ibAht, a.ibAat, a.ibLtt, a.ibTct, a.obArt, a.obAat, a.obLtt, a.obTct,
            Number(a.obConnectPct || 0).toFixed(1), a.holdAvg, a.holdTotal
        ]);
        /*
         * The same totals line, computed with the rules of the row on screen and
         * written after the agents it summarises.
         */
        const totalsRow = ['TOTAL', totalsAgents + ' agents', '', '',
            sumBy(totalsRows, 'total'), sumBy(totalsRows, 'ib'), sumBy(totalsRows, 'ob'), sumBy(totalsRows, 'onnet'),
            sumBy(totalsRows, 'mc'), weightedPct(totalsRows, ['mc', 'ab'], 'offered').toFixed(1),
            sumBy(totalsRows, 'ab'), weightedPct(totalsRows, 'ab', 'offered').toFixed(1),
            Math.round(weightedMean(totalsRows, 'ibAht', 'ib')), Math.round(weightedMean(totalsRows, 'ibAat', 'ib')),
            maxBy(totalsRows, 'ibLtt'), sumBy(totalsRows, 'ibTct'),
            Math.round(weightedMean(totalsRows, 'obArt', 'ob')), Math.round(weightedMean(totalsRows, 'obAat', 'ob')),
            maxBy(totalsRows, 'obLtt'), sumBy(totalsRows, 'obTct'),
            weightedPct(totalsRows, 'obConnected', 'ob').toFixed(1),
            Math.round(weightedMean(totalsRows, 'holdAvg', 'holdCalls')), sumBy(totalsRows, 'holdTotal')];
        const csv = [header, ...body, totalsRow].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
        const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'agent-performance.csv';
        link.click();
        URL.revokeObjectURL(url);
    };

    const kpi = (label, value, accent, onClick, tip, icon) =>
        h(KpiCard, {
            label, value, onClick, tooltip: tip, icon,
            tone: (accent && String(accent).includes('rose')) ? 'bad' : null
        });

    if (loading) {
        return h('div', {className: 'space-y-3'},
            skelKpis(4),
            h('section', {className: 'border border-slate-700 bg-slate-900'},
                h('div', {className: 'border-b border-slate-700 px-3 py-2'}, skel('h-3 w-40')),
                ...Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'border-b border-slate-800 px-3 py-3'},
                    skel('h-3 w-full')))
            )
        );
    }

    return h('div', {className: 'space-y-3'},
        h('section', {className: 'dash-kpi'},
            kpi('Total calls', fmtNum(totals.calls), 'text-cyan-300', () => onMetricClick && onMetricClick('total'), 'All calls for agents in this table for the selected date range. Click to open the call list.', 'fa-solid fa-phone'),
            kpi('Active agents', fmtNum(totals.active), null, null, 'Agents with at least one call in the selected range.', 'fa-solid fa-user-check'),
            kpi('Avg handle time', fmt(ahtShow), 'text-cyan-300', null, 'Inbound average handling time, weighted by inbound call volume across agents in this table.', 'fa-solid fa-hourglass-half'),
            kpi('Missed calls', fmtNum(totals.missed + totals.abandoned), 'text-rose-300', () => onMetricClick && onMetricClick('missed'), 'Inbound calls that were not answered, abandoned ones included (missed + abandoned). Click to open those calls.', 'fa-solid fa-phone-slash')
        ),
        h('div', {className: 'ap-toolbar'},
            h('input', {
                value: query,
                onChange: e => setQuery(e.target.value),
                placeholder: 'Search name, extension, department…',
                className: 'ap-search'
            }),
            h('select', {
                value: siteFilter,
                onChange: e => setSiteFilter(e.target.value),
                className: 'ap-site',
                title: 'Filter by site'
            },
                h('option', {value: ''}, 'All sites'),
                ...sites.map(s => h('option', {key: s, value: s}, s))
            ),
            /*
             * The label names what a click does and always carries the count,
             * so the button says how many rows are hidden while they are - a
             * filter nobody can see is how a table ends up "missing" people.
             */
            h('button', {
                type: 'button',
                className: 'ap-zero-btn' + (hideZero ? ' is-on' : ''),
                title: hideZero
                    ? 'Extensions with 0 calls ' + ZERO_SCOPE + ' are hidden. Click to show them.'
                    : 'Hide the extensions with 0 calls ' + ZERO_SCOPE + '.',
                onClick: toggleHideZero
            }, (hideZero ? 'Show' : 'Hide') + ' 0-call extensions (' + fmtNum(zeroCount) + ')'),
            h('button', {
                type: 'button',
                className: 'ap-cols-btn',
                title: 'Choose visible columns',
                onClick: () => setColsOpen(true)
            },
                h('i', {className: 'fa-solid fa-table-columns', 'aria-hidden': 'true'}),
                ' Columns'
            )
        ),
        colsOpen ? h('div', {className: 'hist-modal-bg set-overlay ap-cols-overlay cursor-default', role: 'presentation', onClick: () => setColsOpen(false)},
            h('div', {
                className: 'set-modal ap-cols-modal cursor-default',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': 'Choose columns',
                onClick: e => e.stopPropagation()
            },
                h('div', {className: 'set-head'},
                    h('div', {className: 'set-title'}, 'Columns'),
                    h('button', {type: 'button', className: 'hist-modal-x', onClick: () => setColsOpen(false)}, '×')
                ),
                h('div', {className: 'set-scroll'},
                    h('p', {className: 'set-row-desc mb-2'}, 'Choose which stats appear in Agent stats.'),
                    h('div', {className: 'ap-col-grid'},
                        ...columns.map(([field, lines, tip, kind, metric, fullName]) => {
                            const label = fullName || (Array.isArray(lines) ? lines.join(' ') : lines);
                            return h('label', {key: field, className: 'ap-col-row'},
                                h('input', {
                                    type: 'checkbox',
                                    checked: colOn[field] !== false,
                                    onChange: e => persistCols({ ...colOn, [field]: e.target.checked })
                                }),
                                h('span', null, label)
                            );
                        })
                    )
                ),
                h('div', {className: 'set-foot'},
                    h('button', {type: 'button', className: 'set-ghost', onClick: () => persistCols(defaultCols())}, 'Show all'),
                    h('button', {type: 'button', className: 'set-save', onClick: () => setColsOpen(false)}, 'Done')
                )
            )
        ) : null,
        h('section', {className: 'border border-slate-700 bg-slate-900'},
            h('div', {className: 'flex items-start justify-between gap-2 border-b border-slate-700 px-3 py-2'},
                h('div', null,
                    h('h2', {className: 'text-xs font-semibold uppercase tracking-wide text-slate-300'}, 'Agent stats'),
                    h('p', {className: 'mt-0.5 text-[10px] text-slate-500'}, 'Click a number to open matching calls. Click an agent name to open Overview.')
                ),
                h('button', {
                    type: 'button',
                    onClick: exportCsv,
                    disabled: !rows.length,
                    className: 'shrink-0 cursor-pointer rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-40'
                }, 'Export CSV')
            ),
            h('div', {className: 'overflow-x-auto qs-table-fit'},
                h('table', {className: 'w-full min-w-[1400px] text-xs q-table qs-table'},
                    h('thead', null,
                        h('tr', {className: 'border-b border-slate-700 bg-slate-950 text-[10px] text-slate-500'},
                            ...visibleCols.map(([field, lines, tip, kind]) => {
                                const active = sortKey === field;
                                const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                                const labelLines = Array.isArray(lines) ? lines : [lines];
                                return h('th', {key: field, className: 'qs-th px-2 py-2 text-left'},
                                    h('div', {className: 'qs-th-inner'},
                                        h('button', {
                                            type: 'button',
                                            className: 'qs-sort' + (active ? ' is-on' : ''),
                                            onClick: () => toggleSort(field)
                                        },
                                            ...labelLines.map((ln, i) => h('span', {key: i, className: 'qs-th-line'}, ln + (i === labelLines.length - 1 ? arrow : '')))
                                        ),
                                        h(Tooltip, {text: tip}, h('span', {className: 'qs-i cursor-help', title: tip}, 'i'))
                                    )
                                );
                            })
                        )
                    ),
                    h('tbody', null,
                        totalsRow,
                        paginatedData.length === 0
                            ? h('tr', null, h('td', {colSpan: visibleCols.length, className: 'px-4 py-10 text-center text-xs text-slate-500'},
                                /* Empty because of the switch, not because nobody is
                                 * in scope: say which, and how many it is hiding.
                                 * "Matching" when a search or site filter narrowed
                                 * the table first - the count is of those rows. */
                                hideZero && zeroCount > 0
                                    ? (query.trim() || siteFilter ? 'No matching extension' : 'No extension') + ' had calls ' + ZERO_SCOPE + '. ' +
                                      fmtNum(zeroCount) + (zeroCount === 1 ? ' extension with 0 calls is hidden.' : ' extensions with 0 calls are hidden.')
                                    : 'No agent stats.'))
                            : paginatedData.map((agent, index) => h('tr', {
                                key: [agent.extension, agent.department, agent.site, startIndex + index].join('-'),
                                className: 'border-b border-slate-800 hover:bg-slate-800/60'
                            },
                                ...visibleCols.map(([field, , tip, kind, metric]) => {
                                    const tone = failTone(field, agent);
                                    const shown = formatValue(field, agent);
                                    if (field === 'agent' || field === 'extension') {
                                        return h('td', {key: field, className: 'px-2 py-2 text-left'},
                                            h('button', {
                                                type: 'button',
                                                className: 'qs-qbtn cursor-pointer text-left text-cyan-400 hover:text-cyan-300 hover:underline',
                                                title: 'Open Overview for ' + (agent.name || agent.extension),
                                                onClick: ev => { ev.stopPropagation(); onAgentClick && onAgentClick(agent.extension); }
                                            }, shown)
                                        );
                                    }
                                    if (field === 'site' || !metric) {
                                        return h('td', {key: field, className: 'px-2 py-2 text-left text-slate-300'}, shown);
                                    }
                                    return h('td', {key: field, className: 'qs-num px-2 py-2'},
                                        h('button', {
                                            type: 'button',
                                            className: 'qs-num-btn cursor-pointer' + (shown === '—' ? '' : (tone === 'fail' ? ' is-fail' : (tone === 'pass' ? ' is-pass' : ''))),
                                            title: tip,
                                            onClick: ev => {
                                                ev.stopPropagation();
                                                onMetricClick && onMetricClick(metric, agent.extension);
                                            }
                                        }, shown)
                                    );
                                })
                            ))
                    )
                )
            ),
            h('div', {className: 'flex flex-wrap items-center justify-between gap-3 border-t border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-400'},
                h('div', {className: 'flex items-center gap-2'},
                    'Rows per page:',
                    h('select', {
                        value: pageSize,
                        onChange: e => { setPageSize(Number(e.target.value)); setPage(1); },
                        className: 'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300'
                    },
                        h('option', {value: 10}, '10'),
                        h('option', {value: 25}, '25'),
                        h('option', {value: 50}, '50'),
                        h('option', {value: 100}, '100')
                    ),
                    h('span', {className: 'ml-2 text-slate-500'},
                        totalRows === 0 ? 'Showing 0 of 0' : ('Showing ' + (startIndex + 1) + ' - ' + endIndex + ' of ' + totalRows))
                ),
                h('div', {className: 'flex items-center gap-1'},
                    h('button', {
                        disabled: currentPage <= 1,
                        onClick: () => setPage(p => Math.max(1, p - 1)),
                        className: 'rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                    }, 'Prev'),
                    h('span', {className: 'px-2 text-slate-300'}, 'Page ' + currentPage + ' of ' + totalPages),
                    h('button', {
                        disabled: currentPage >= totalPages,
                        onClick: () => setPage(p => Math.min(totalPages, p + 1)),
                        className: 'rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                    }, 'Next')
                )
            )
        )
    );
}

export { AgentPerformanceTable };
