/* Agent statistics table, the agent sidebar, compare and per-agent overview.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { KpiCard, splineArea } from './charts.js';
import { DateRangePicker } from './date-range-picker.js';
import { CallTypeIcon, SearchableSelect, Tooltip, skel, skelKpis } from './ui.js';
import { api } from '../lib/api.js';
import { fmt, fmtNum, formatPhoneNumber } from '../lib/format.js';
import { h, keyActivate, useCallback, useEffect, useEscape, useMemo, useRef, useState } from '../lib/react.js';
import { readSlaSeconds } from '../lib/sla.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';

function AgentPerformanceTable({data,loading,onAgentClick,onMetricClick,slaSeconds,missedPct,abandonPct,ahtMinutes}) {

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
        ['mc', ['Missed', 'Calls'], 'Inbound calls that were not answered (excluding queue abandon). Click to open missed calls.', 'num', 'missed', 'Missed Calls'],
        ['mcRate', ['Missed', 'Rate'], 'Missed ÷ (inbound + missed). Red when above the domain missed-call rate setting.', 'pct', 'missed', 'Missed Rate'],
        ['ibAht', ['Inbound', 'AHT'], 'Inbound average handling time (talk). Red when above the domain AHT setting.', 'dur', 'answered', 'Inbound Average Handling Time'],
        ['ibAat', ['Inbound', 'AAT'], 'Inbound average answer / ring time. Red when above the SLA max-ring setting.', 'dur', 'answered', 'Inbound Average Answer Time'],
        ['ibLtt', ['Inbound', 'LTT'], 'Inbound longest talking time. Click to open answered inbound calls.', 'dur', 'answered', 'Inbound Longest Talking Time'],
        ['ibTct', ['Inbound', 'TCT'], 'Inbound total talking time. Click to open answered inbound calls.', 'dur', 'answered', 'Inbound Total Calling Time'],
        ['obArt', ['Outbound', 'ART'], 'Outbound average ring time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Average Ring Time'],
        ['obAat', ['Outbound', 'AAT'], 'Outbound average answer time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Average Answer Time'],
        ['obLtt', ['Outbound', 'LTT'], 'Outbound longest talking time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Longest Talking Time'],
        ['obTct', ['Outbound', 'TCT'], 'Outbound total talking time. Click to open outbound calls.', 'dur', 'outbound', 'Outbound Total Calling Time']
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

    const durationFields = ['ibAht','ibAat','ibLtt','ibTct','obArt','obAat','obLtt','obTct'];
    const missLimit = Number(missedPct != null ? missedPct : 20);
    const abLimit = Number(abandonPct != null ? abandonPct : 10);
    const ahtLimitSec = Number(ahtMinutes != null ? ahtMinutes : 5) * 60;
    const slaRing = Number(slaSeconds != null ? slaSeconds : 20);

    const offeredOf = agent => {
        const n = Number(agent.offered);
        if (Number.isFinite(n) && n > 0) return n;
        return Number(agent.ib || 0) + Number(agent.mc || 0) + Number(agent.ab || 0);
    };
    const rateOf = (agent, field) => {
        if (agent[field] != null && agent[field] !== '') return Number(agent[field] || 0);
        const off = offeredOf(agent);
        if (!off) return 0;
        if (field === 'mcRate') return (Number(agent.mc || 0) / off) * 100;
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
        return blank(fmtNum(n));
    };

    const rows = Array.isArray(data) ? data : [];
    const sites = Array.from(new Set(rows.map(a => String(a.site || '').trim()).filter(Boolean))).sort();

    const sorted = useMemo(() => {
        const copy = rows.filter(a => {
            if (siteFilter && String(a.site || '') !== siteFilter) return false;
            const q = query.trim().toLowerCase();
            if (!q) return true;
            return ((a.name || '') + ' ' + (a.extension || '') + ' ' + (a.department || '') + ' ' + (a.site || '')).toLowerCase().includes(q);
        });
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
    }, [rows, sortKey, sortDir, query, siteFilter]);

    useEffect(() => { setPage(1); }, [data, pageSize, sortKey, sortDir, query, siteFilter]);

    const totalRows = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalRows);
    const paginatedData = sorted.slice(startIndex, endIndex);

    const totals = rows.reduce((acc, a) => {
        acc.calls += Number(a.total || 0);
        acc.missed += Number(a.mc || 0);
        acc.handle += Number(a.ibAht || 0);
        acc.handleN += Number(a.ibAht || 0) > 0 || Number(a.total || 0) > 0 ? 1 : 0;
        if (Number(a.total || 0) > 0) acc.active += 1;
        return acc;
    }, {calls: 0, missed: 0, handle: 0, handleN: 0, active: 0});
    const avgHandle = rows.length
        ? (rows.reduce((s, a) => s + Number(a.ibAht || 0) * Math.max(1, Number(a.ib || 0)), 0) /
           Math.max(1, rows.reduce((s, a) => s + Math.max(0, Number(a.ib || 0)), 0)))
        : 0;
    const ahtFallback = rows.length
        ? rows.reduce((s, a) => s + Number(a.ibAht || 0), 0) / Math.max(1, rows.filter(a => Number(a.ibAht || 0) > 0).length)
        : 0;
    const ahtShow = Number.isFinite(avgHandle) && avgHandle > 0 ? avgHandle : ahtFallback;

    const toggleSort = field => {
        if (sortKey === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else {
            setSortKey(field);
            setSortDir(field === 'agent' || field === 'site' || field === 'extension' ? 'asc' : 'desc');
        }
    };

    const exportCsv = () => {
        const header = ['name','extension','department','site','total_calls','inbound','outbound','onnet','missed_calls','missed_rate','abandoned_calls','abandoned_rate','ib_aht','ib_aat','ib_ltt','ib_tct','ob_art','ob_aat','ob_ltt','ob_tct'];
        const body = sorted.map(a => [
            a.name, a.extension, a.department, a.site, a.total, a.ib, a.ob, a.onnet, a.mc, rateOf(a, 'mcRate').toFixed(1),
            a.ab, rateOf(a, 'abRate').toFixed(1),
            a.ibAht, a.ibAat, a.ibLtt, a.ibTct, a.obArt, a.obAat, a.obLtt, a.obTct
        ]);
        const csv = [header, ...body].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
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
            kpi('Missed calls', fmtNum(totals.missed), 'text-rose-300', () => onMetricClick && onMetricClick('missed'), 'Inbound calls that were not answered. Click to open those calls.', 'fa-solid fa-phone-slash')
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
                        paginatedData.length === 0
                            ? h('tr', null, h('td', {colSpan: visibleCols.length, className: 'px-4 py-10 text-center text-xs text-slate-500'}, 'No agent stats.'))
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

function Agents({filters,role,selectedAgents,onAgentsChange,onData,singleSelect}) {
    const [agents,setAgents] = useState([]);
    const [term,setTerm] = useState('');
    const [selected,setSelected] = useState(Array.isArray(selectedAgents) ? selectedAgents : []);
    const [loading,setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        setSelected(Array.isArray(selectedAgents) ? selectedAgents : []);
    }, [selectedAgents]);

    useEffect(() => {
        let active = true;
        setLoading(true);
        api('agents', filters)
            .then(r => {
                if (!active) return;
                const data = Array.isArray(r?.data) ? r.data : [];
                setAgents(data);
                if (onData) onData(data);
            })
            .catch(() => {
                if (!active) return;
                setAgents([]);
                if (onData) onData([]);
            })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [filters.start, filters.end, filters.department, filters.site]);

    const visible = agents
        .filter(x =>
            (String(x.name || '') + String(x.extension || '')).toLowerCase().includes(term.toLowerCase())
        )
        .slice()
        .sort((a, b) => Number(b.totalCalls || b.total || 0) - Number(a.totalCalls || a.total || 0));

    useEffect(() => {
        if (!singleSelect || loading || !visible.length) return;
        const current = Array.isArray(selected) ? selected : [];
        if (current.length === 1 && visible.some(a => a.extension === current[0])) return;
        const pick = visible[0].extension;
        setSelected([pick]);
        onAgentsChange([pick]);
    }, [singleSelect, loading, agents, term]);

    const applySelection = ids => {
        const next = singleSelect ? ids.slice(0, 1) : ids;
        setSelected(next);
        onAgentsChange(next);
    };

    const toggleAgent = extension => {
        if (singleSelect) {
            applySelection([extension]);
            return;
        }
        const next = selected.includes(extension)
            ? selected.filter(x => x !== extension)
            : [...selected, extension];
        applySelection(next);
    };

    return h('aside', {className: 'agent-side' + (collapsed ? ' is-collapsed' : '')},
        h('div', {className: 'aa-side-head'},
            collapsed ? null : h('h2', {className: 'text-sm font-semibold text-slate-100'}, 'Agents'),
            h('button', {
                type: 'button',
                title: collapsed ? 'Expand agents' : 'Collapse agents',
                onClick: () => setCollapsed(c => !c),
                className: 'aa-side-toggle'
            }, collapsed ? '›' : '‹')
        ),
        collapsed ? null : h('div', {className: 'px-3 pb-1 flex items-center justify-between'},
            singleSelect
                ? h('span', {className: 'text-[10px] text-slate-500'}, 'Select one')
                : h('div', {className: 'flex gap-2 text-[11px]'},
                    h('button', {type: 'button', onClick: () => applySelection(visible.map(a => a.extension)), className: 'text-cyan-400 hover:text-cyan-300'}, 'Select all'),
                    h('button', {type: 'button', onClick: () => applySelection([]), className: 'text-slate-500 hover:text-slate-300'}, 'Clear')
                )
        ),
        collapsed ? null : h('input', {
            value: term,
            onChange: e => setTerm(e.target.value),
            placeholder: 'Find agent or extension…',
            className: 'aa-side-search'
        }),
        loading
            ? h('div', {className: 'space-y-1 px-3 pt-1'},
                ...Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'mb-1'}, skel('h-12'))))
            : h('div', {className: 'agent-side-list'},
                ...visible.map(a => {
                    const on = selected.includes(a.extension);
                    const label = a.name || a.extension;
                    return h('button', {
                        key: a.extension,
                        type: 'button',
                        title: label,
                        onClick: () => toggleAgent(a.extension),
                        className: 'agent-pick ' + (on ? 'is-on' : '')
                    },
                        collapsed
                            ? h('span', {className: 'aa-side-glyph'}, String(label).slice(0, 1).toUpperCase())
                            : h(React.Fragment, null,
                                h('span', {className: 'agent-pick-av', 'aria-hidden': 'true'},
                                    String(label).trim().slice(0, 1).toUpperCase() || '?'),
                                h('span', {className: 'min-w-0 flex-1 text-left'},
                                    h('span', {className: 'agent-pick-name truncate'}, label),
                                    h('span', {className: 'agent-pick-ext truncate'}, a.extension)
                                )
                              )
                    );
                })
            )
    );
}

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
                skipPrevious: 1
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
                h('button', {
                    type: 'button',
                    className: 'cursor-pointer text-sky-300 hover:underline',
                    onClick: () => left && onAgentClick && onAgentClick(left)
                }, (leftName?.name || left) + ' · calls'),
                h('button', {
                    type: 'button',
                    className: 'cursor-pointer text-orange-300 hover:underline',
                    onClick: () => right && onAgentClick && onAgentClick(right)
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

function AgentOverview({report, loading, filters, callTypes, selectedAgents, onCallClick}) {
  const hourCanvas = useRef(null);
  const hourChart = useRef(null);
  const [activity, setActivity] = useState([]);
  const [actLoading, setActLoading] = useState(false);
  const [actPage, setActPage] = useState(1);
  const [actSize, setActSize] = useState(10);
  const [actSort, setActSort] = useState('startedAt');
  const [actDir, setActDir] = useState('desc');
  const [actQuery, setActQuery] = useState('');

  const rows = Array.isArray(report?.agentPerformance) ? report.agentPerformance : [];
  const focusExt = Array.isArray(selectedAgents) && selectedAgents.length
    ? String(selectedAgents[selectedAgents.length - 1])
    : (rows[0] ? String(rows[0].extension) : '');
  const agent = rows.find(r => String(r.extension) === focusExt) || rows[0] || null;
  const summary = report?.summary || {};
  const counts = summary.counts || {};
  const prev = report?.comparison?.previous?.counts || {};
  /* Comparison arrives in a lazy second pass; suppress deltas until then. */
  const comparisonPending = report?.comparison?.pending === true;
  const hours = Array.isArray(summary.hours) ? summary.hours : Array.from({length: 24}, () => 0);

  useEffect(() => {
    if (!agent) { setActivity([]); return; }
    let active = true;
    setActLoading(true);
    api('calls', {
      ...filters,
      callTypes,
      agent: agent.extension,
      metric: 'total',
      page: 1,
      size: 50
    }).then(r => {
      if (!active) return;
      setActivity(Array.isArray(r?.data) ? r.data : []);
      setActPage(1);
    }).catch(() => {
      if (active) setActivity([]);
    }).finally(() => { if (active) setActLoading(false); });
    return () => { active = false; };
  }, [agent && agent.extension, filters.start, filters.end, callTypes]);

  useEffect(() => {
    if (!hourCanvas.current) return;
    hourChart.current?.destroy();
    const labels = Array.from({length: 24}, (_, i) => {
      const h12 = i % 12 || 12;
      const ap = i < 12 ? 'AM' : 'PM';
      return i % 2 === 0 ? h12 + ' ' + ap : '';
    });
    hourChart.current = new Chart(hourCanvas.current, {
      type: 'line',
      data: {
        labels,
        datasets: [splineArea(hourCanvas.current, '#22d3ee', hours)]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        /* Column-wide hit test; the 2px stroke alone is a poor target. */
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        onHover: (event, elements) => {
          const t = event?.native?.target;
          if (t) t.style.cursor = elements?.length ? 'pointer' : 'default';
        },
        onClick: (evt, els) => {
          if (!els.length || !agent) return;
          onCallClick && onCallClick({ metric: 'total', hour: els[0].index, agent: agent.extension });
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#94a3b8', maxRotation: 0 } },
          y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', precision: 0 } }
        }
      }
    });
    return () => { hourChart.current?.destroy(); hourChart.current = null; };
  }, [hours.join('|'), agent && agent.extension]);

  const pctDelta = (now, old) => {
    const a = Number(now || 0), b = Number(old || 0);
    if (!b) return a ? 100 : 0;
    return ((a - b) / b) * 100;
  };
  const total = Number((agent && agent.total) || counts.total || 0);
  const missed = Number((agent && agent.mc) || counts.missed || 0);
  const inbound = Number((agent && agent.ib) || counts.inbound || 0);
  const offered = inbound + missed;
  const mb = summary.missedBreakdown || {};
  const abandonCount = Number(mb.abandon || 0);
  const abandon = offered ? (abandonCount / offered) * 100 : 0;
  const prevOffered = Number(prev.inbound || 0) + Number(prev.missed || 0);
  const prevAbandon = prevOffered ? (Number(prev.missed || 0) / prevOffered) * 100 : 0;
  const aht = Number((agent && agent.ibAht) || summary.inbound?.avgHandling || 0);
  const initials = String((agent && agent.name) || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();

  const q = actQuery.trim().toLowerCase();
  const filtered = activity.filter(c => {
    if (!q) return true;
    return [c.from, c.fromNumber, c.to, c.dialed, c.type, c.queue].join(' ').toLowerCase().includes(q);
  });
  const sorted = filtered.slice().sort((a, b) => {
    let av, bv;
    if (actSort === 'name') { av = String(a.from || a.fromNumber || ''); bv = String(b.from || b.fromNumber || ''); }
    else if (actSort === 'duration') { av = Number(a.talking || 0); bv = Number(b.talking || 0); }
    else { av = String(a.startedAt || ''); bv = String(b.startedAt || ''); }
    if (av < bv) return actDir === 'asc' ? -1 : 1;
    if (av > bv) return actDir === 'asc' ? 1 : -1;
    return 0;
  });
  const actPages = Math.max(1, Math.ceil(sorted.length / actSize));
  const safeAct = Math.min(actPage, actPages);
  const actSlice = sorted.slice((safeAct - 1) * actSize, safeAct * actSize);

  const queueMap = {};
  activity.forEach(c => {
    const qid = String(c.queue || '').trim();
    if (!qid) return;
    if (!queueMap[qid]) queueMap[qid] = { id: qid, answered: 0, missed: 0 };
    if (c.type === 'missed' || !(Number(c.talking) > 0)) queueMap[qid].missed++;
    else queueMap[qid].answered++;
  });
  const assocQueues = Object.values(queueMap).sort((a, b) => (b.answered + b.missed) - (a.answered + a.missed)).slice(0, 6);

  const deltaLine = (delta, invert) => {
    const n = Number(delta);
    if (!Number.isFinite(n)) return null;
    const up = n > 0.05;
    const down = n < -0.05;
    const good = invert ? down : up;
    const cls = !up && !down ? 'text-slate-500' : (good ? 'text-emerald-400' : 'text-rose-400');
    const arrow = up ? '↑' : (down ? '↓' : '→');
    return h('span', {className: cls}, arrow + ' ' + Math.abs(n).toFixed(1) + '% vs previous period');
  };

  if (loading && !agent) {
    return h('div', {className: 'ag-ov'},
      h('aside', {className: 'ag-ov-side dash-card'},
        h('div', {className: 'ag-ov-profile'},
          skel('h-10 w-10 !rounded-full'),
          h('div', {className:'min-w-0 flex-1'}, skel('h-4 w-32'), skel('mt-2 h-3 w-24'), skel('mt-2 h-3 w-20'))
        ),
        skel('h-3 w-24 mb-2'),
        ...Array.from({length: 6}, (_, i) => h('div', {key: i, className: 'ag-ov-recent-row'}, skel('h-4 w-4'), skel('h-3 flex-1'), skel('h-3 w-10')))
      ),
      h('div', {className: 'ag-ov-main'},
        h('div', {className: 'ag-ov-head'}, skel('h-3 w-36'), skel('mt-2 h-4 w-64')),
        h('section', {className: 'ag-ov-kpis'},
          ...Array.from({length: 3}, (_, i) => h('div', {key: i, className: 'kpi-card'}, skel('h-3 w-16'), skel('mt-3 h-7 w-20'), skel('mt-2 h-2 w-24')))
        ),
        h('div', {className: 'ag-ov-charts'},
          h('section', {className: 'dash-card ag-ov-volume'}, skel('h-3 w-28'), skel('mt-3 h-[180px] w-full')),
          h('section', {className: 'dash-card ag-ov-missed'}, skel('h-3 w-24'), skel('mt-4 h-10 w-16'), skel('mt-3 h-3 w-28'))
        ),
        h('div', {className: 'ag-ov-bottom'},
          h('section', {className: 'dash-card ag-ov-activity'}, skel('h-3 w-28'), ...Array.from({length: 6}, (_, i) => h('div', {key: i, className: 'mt-2'}, skel('h-8 w-full')))),
          h('section', {className: 'dash-card'}, skel('h-3 w-32'), ...Array.from({length: 4}, (_, i) => h('div', {key: i, className: 'mt-2'}, skel('h-8 w-full'))))
        )
      )
    );
  }
  if (!agent) {
    return h('div', {className: 'grid place-items-center py-16 text-sm text-slate-500'}, 'Select an agent in the list.');
  }

  const open = (metric, extra) => onCallClick && onCallClick({ metric, agent: agent.extension, ...(extra || {}) });

  return h('div', {className: 'ag-ov'},
    h('aside', {className: 'ag-ov-side dash-card'},
      h('div', {className: 'ag-ov-profile'},
        h('div', {className: 'ag-ov-avatar'}, initials || '—'),
        h('div', {className: 'min-w-0'},
          h('div', {className: 'truncate text-sm font-semibold text-slate-100'}, agent.name || agent.extension),
          h('div', {className: 'text-[11px] text-slate-500'}, 'Call Center Agent'),
          h('div', {className: 'mt-1 flex items-center gap-1.5 text-[11px] text-emerald-400'},
            h('span', {className: 'inline-block h-1.5 w-1.5 rounded-full bg-emerald-400'}),
            total > 0 ? 'Active in range' : 'No calls in range'
          )
        )
      ),
      h('div', {className: 'ag-ov-recent-label'}, 'Recent calls'),
      actLoading
        ? h('div', {className: 'space-y-2'}, ...Array.from({length: 5}, (_, i) => h('div', {key: i, className: 'skeleton-shimmer h-6 rounded'})))
        : h('div', {className: 'ag-ov-recent'},
            ...(activity.slice(0, 6).map((c, i) => h('button', {
              key: i, type: 'button', className: 'ag-ov-recent-row',
              onClick: () => open('total')
            },
              h(CallTypeIcon, {type: c.type, size: 13}),
              h('span', {className: 'min-w-0 flex-1 truncate text-slate-200'}, c.from || formatPhoneNumber(c.fromNumber) || '—'),
              h('span', {className: 'shrink-0 font-mono text-cyan-300'}, Number(c.talking) > 0 ? fmt(c.talking) : '—')
            ))),
            activity.length === 0 ? h('div', {className: 'px-1 py-4 text-center text-[11px] text-slate-500'}, 'No recent calls.') : null
          ),
      h('button', {
        type: 'button',
        className: 'mt-2 w-full cursor-pointer text-left text-[11px] text-cyan-400 hover:underline',
        onClick: () => open('total')
      }, 'View all')
    ),
    h('div', {className: 'ag-ov-main'},
      h('div', {className: 'ag-ov-head'},
        h('h1', {className: 'text-xs font-semibold uppercase tracking-wide text-slate-400'}, 'Agent performance'),
        h('p', {className: 'text-sm text-slate-100'}, (agent.name || agent.extension) + "'s call activity and performance overview")
      ),
      h('section', {className: 'ag-ov-kpis'},
        h(KpiCard, {label: 'Calls', value: total, icon: 'fa-solid fa-phone', delta: comparisonPending ? null : pctDelta(total, prev.total), tooltip: 'Total calls for this agent. Click to open.', onClick: () => open('total')}),
        h(KpiCard, {label: 'Abandon rate', value: abandon.toFixed(1) + '%', icon: 'fa-solid fa-person-walking-dashed-line-arrow-right', tone: 'bad', hint: fmtNum(abandonCount) + ' calls', tooltip: 'Queue/IVR hang-ups before answer ÷ offered inbound. Click to open abandoned calls.', onClick: () => open('missed_abandon')}),
        h(KpiCard, {label: 'Avg. handle time', value: fmt(aht), icon: 'fa-solid fa-hourglass-half', tooltip: 'Inbound average handling time. Click to open inbound calls.', onClick: () => open('inbound')})
      ),
      h('div', {className: 'ag-ov-charts'},
        h('section', {className: 'dash-card ag-ov-volume'},
          h('div', {className: 'dash-label'}, 'Call volume'),
          h('div', {className: 'dash-hour-chart'}, h('canvas', {ref: hourCanvas}))
        ),
        h('section', {className: 'dash-card ag-ov-missed'},
          h('div', {className: 'dash-label'}, 'Missed calls'),
          h('button', {type: 'button', className: 'w-full cursor-pointer text-left', onClick: () => open('missed')},
            h('div', {className: 'text-3xl font-semibold text-rose-300'}, fmtNum(missed)),
            h('div', {className: 'mt-1 text-[11px] text-slate-500'}, 'Missed calls'),
            h('div', {className: 'mt-2 text-[11px]'}, comparisonPending
              ? h('span', {className: 'text-slate-500'}, 'Comparing to last period…')
              : (deltaLine(pctDelta(missed, prev.missed), true) || 'vs previous period'))
          )
        )
      ),
      h('div', {className: 'ag-ov-bottom'},
        h('section', {className: 'dash-card ag-ov-activity'},
          h('div', {className: 'mb-2 flex flex-wrap items-center justify-between gap-2'},
            h('div', {className: 'dash-label'}, 'Call activity'),
            h('input', {
              value: actQuery,
              onChange: e => { setActQuery(e.target.value); setActPage(1); },
              placeholder: 'Search…',
              className: 'w-40 border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400'
            })
          ),
          h('div', {className: 'q-table-wrap'},
            h('table', {className: 'q-table'},
              h('thead', null, h('tr', null,
                ...[['name', 'Name'], ['startedAt', 'Time'], ['duration', 'Duration']].map(([field, lab]) => {
                  const active = actSort === field;
                  const arrow = active ? (actDir === 'asc' ? ' ↑' : ' ↓') : '';
                  return h('th', {key: field},
                    h('button', {
                      type: 'button',
                      className: 'cursor-pointer ' + (active ? 'text-cyan-300' : ''),
                      onClick: () => {
                        if (actSort === field) setActDir(d => d === 'asc' ? 'desc' : 'asc');
                        else { setActSort(field); setActDir(field === 'name' ? 'asc' : 'desc'); }
                      }
                    }, lab + arrow)
                  );
                })
              )),
              h('tbody', null,
                actSlice.length === 0
                  ? h('tr', null, h('td', {colSpan: 3, className: 'px-2 py-8 text-center text-slate-500'}, actLoading ? 'Loading…' : 'No calls.'))
                  : actSlice.map((c, i) => h('tr', {
                      key: i,
                      tabIndex: 0,
                      className: 'cursor-pointer hover:bg-slate-800/60',
                      onClick: () => open(c.type || 'total'),
                      onKeyDown: keyActivate(() => open(c.type || 'total'))
                    },
                      h('td', {className: 'text-slate-200'},
                        h('span', {className: 'inline-flex items-center gap-2 min-w-0'},
                          h(CallTypeIcon, {type: c.type, size: 13}),
                          h('span', {className: 'truncate'}, c.from || formatPhoneNumber(c.fromNumber) || '—')
                        )
                      ),
                      h('td', {className: 'text-slate-400'}, (formatCallDate(c.startedAt) + ' ' + formatCallTime(c.startedAt)).trim()),
                      h('td', {className: 'font-mono text-cyan-300'}, Number(c.talking) > 0 ? fmt(c.talking) : '—')
                    ))
              )
            )
          ),
          h('div', {className: 'mt-2 flex items-center justify-between text-xs text-slate-400'},
            h('span', null, sorted.length === 0 ? 'Showing 0 of 0' : ('Showing ' + (((safeAct - 1) * actSize) + 1) + '–' + Math.min(safeAct * actSize, sorted.length) + ' of ' + sorted.length)),
            h('div', {className: 'flex gap-1'},
              h('button', {type: 'button', disabled: safeAct <= 1, onClick: () => setActPage(p => Math.max(1, p - 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Prev'),
              h('button', {type: 'button', disabled: safeAct >= actPages, onClick: () => setActPage(p => Math.min(actPages, p + 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Next')
            )
          )
        ),
        h('section', {className: 'dash-card ag-ov-queues'},
          h('div', {className: 'dash-label'}, 'Associated queues'),
          assocQueues.length === 0
            ? h('div', {className: 'py-6 text-center text-xs text-slate-500'}, 'No queue legs in this sample.')
            : assocQueues.map(q => {
                const tot = q.answered + q.missed;
                const ans = tot ? Math.round((q.answered / tot) * 100) : 0;
                const miss = 100 - ans;
                return h('div', {key: q.id, className: 'mb-3'},
                  h('div', {className: 'mb-1 truncate text-[11px] text-slate-300'}, 'Queue ' + q.id),
                  h('div', {className: 'text-[10px] text-slate-500'}, 'Answered'),
                  h('div', {className: 'dash-missed-track mb-1'}, h('div', {className: 'dash-missed-fill', style: {width: ans + '%', background: '#34d399'}})),
                  h('div', {className: 'flex justify-between text-[10px] text-slate-500'}, h('span', null, 'In queue / missed'), h('span', null, miss + '%')),
                  h('div', {className: 'dash-missed-track'}, h('div', {className: 'dash-missed-fill', style: {width: miss + '%', background: '#f87171'}}))
                );
              })
        )
      )
    )
  );
}

export { AgentCompare, AgentOverview, AgentPerformanceTable, Agents };
