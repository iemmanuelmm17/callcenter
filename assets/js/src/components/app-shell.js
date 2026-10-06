/* The signed-in shell: navigation, routing, global filters and modals.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { AgentCompare, AgentOverview, AgentPerformanceTable, Agents } from './agents.js';
import { AutoAttendantReport } from './auto-attendant-report.js';
import { AutoAttendants } from './auto-attendants.js';
import { CallHistoryDashboard } from './call-history.js';
import { CallModal } from './call-modal.js';
import { CallTypeFilters, Filters } from './filters.js';
import { AlertsBell } from './login.js';
import { OverviewDashboard } from './overview.js';
import { QueueDashboard } from './queue.js';
import { SettingsModal } from './settings.js';
import { TelephoneNumbers } from './telephone-numbers.js';
import { NavIcon, ThemeToggle, ToastHost, navItems, useToasts } from './ui.js';
import { api, routesForRole } from '../lib/api.js';
import { histInitials } from '../lib/format.js';
import { h, useEffect, useRef, useState } from '../lib/react.js';
import { readSlaSeconds, writeSlaSeconds } from '../lib/sla.js';
import { today } from '../lib/time.js';

function Dashboard({user,onLogout}) {

const [route,setRoute] = useState('dashboard');
const [collapsed,setCollapsed] = useState(false);

const [filters,setFilters] = useState(() => {
    const q = new URLSearchParams(location.search);
    return {
        start: q.get('start') || today,
        end: q.get('end') || today,
        department: q.get('department') || '',
        site: q.get('site') || ''
    };
});

const [aaReport, setAaReport] = useState(null);
/* null = not fetched yet (lazy-loaded by the Structure tab). */
const [aaStructures, setAaStructures] = useState(null);
const [aaStructLoading, setAaStructLoading] = useState(false);
const [aaRoster, setAaRoster] = useState([]);
/* Phase 1 (list) is tracked separately from phase 2 (selected AA data). */
const [aaRosterLoading, setAaRosterLoading] = useState(false);
const [aaError, setAaError] = useState('');
const [aaLoading, setAaLoading] = useState(false);
const [cacheJob, setCacheJob] = useState(null);
const rangeDayCount = (() => {
    if (!filters.start || !filters.end) return 0;
    const a = new Date(filters.start + 'T00:00:00');
    const b = new Date(filters.end + 'T00:00:00');
    return Math.round((b - a) / 864e5) + 1;
})();
const [aaView, setAaView] = useState('overview');
const [selectedAutoAttendants, setSelectedAutoAttendants] = useState([]);
const [selectedAgents,setSelectedAgents] = useState([]);
const [callTypes,setCallTypes] = useState({ inbound: true, outbound: true, missed: true, onnet: true });
const [report,setReport] = useState(null);
const [agentReport,setAgentReport] = useState(null);
const [agentReportLoading,setAgentReportLoading] = useState(false);
const agentPerformance = Array.isArray(agentReport?.agentPerformance) ? agentReport.agentPerformance : [];
const [loading,setLoading] = useState(true);
const [modal,setModal] = useState(null);
const [inventory,setInventory] = useState({ agents: 0, totalNumbers: 0, enabledNumbers: 0, autoAttendants: 0, aaCalls: 0, queues: 0 });
const [inventoryReady,setInventoryReady] = useState({ agents: false, numbers: false, aa: false });
const [agentSub,setAgentSub] = useState('performance');
const [slaSeconds, setSlaSeconds] = useState(readSlaSeconds);
const [domainSettings, setDomainSettings] = useState({ slaPct: 80, abandonPct: 10, missedPct: 20, ahtMinutes: 5, ahtOutboundMinutes: 5, topAgentAhtMinutes: 5, topAgentMinCalls: 20 });
const [focusQueue, setFocusQueue] = useState('');
const [focusAa, setFocusAa] = useState('');
const [settingsOpen, setSettingsOpen] = useState(false);
const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
const navPanelRef = useRef(null);
const mainScrollRef = useRef(null);


useEffect(() => {
    api('settings').then(r => {
        const d = r && r.data ? r.data : r;
        if (!d) return;
        setSlaSeconds(writeSlaSeconds(d.slaSeconds));
        setDomainSettings({
            slaPct: Number(d.slaPct || 80),
            abandonPct: Number(d.abandonPct || 10),
            missedPct: Number(d.missedPct || 20),
            ahtMinutes: Number(d.ahtMinutes || 5),
            ahtOutboundMinutes: Number(d.ahtOutboundMinutes || d.ahtMinutes || 5),
            /*
             * Top-agent qualification. Falls back to the general AHT
             * threshold so the podium still behaves sensibly against a
             * backend that does not yet persist these two keys.
             */
            topAgentAhtMinutes: Number(d.topAgentAhtMinutes || d.ahtMinutes || 5),
            topAgentMinCalls: Number(d.topAgentMinCalls ?? 20)
        });
    }).catch(() => {});
}, []);

useEffect(() => {
    const allowed = routesForRole(user.role);
    if (!allowed.includes(route)) {
        setRoute(allowed[0] || 'dashboard');
        return;
    }
    if (navPanelRef.current) {
        const el = navPanelRef.current.querySelector('.nav-item.is-on');
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({block: 'nearest'});
    }
    if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0;
}, [route, user.role]);

const loadAgentReport = async selected => {
    setAgentReportLoading(true);
    const reportFilters = {
        ...filters,
        agents: Array.isArray(selected) ? selected : [],
        callTypes,
        slaSeconds
    };
    try {
        /*
         * Same two-phase load as the dashboard: agent performance comes
         * from the CURRENT period only, so waiting on the previous-period
         * sweep just to colour two delta labels kept this screen blank on
         * wide ranges. Phase 1 paints, phase 2 backfills the deltas.
         */
        const response = await api('report', { ...reportFilters, skipPrevious: 1 });
        const reportData = response?.data && typeof response.data === 'object' && !Array.isArray(response.data) ? response.data : response;
        const performance = Array.isArray(reportData?.agentPerformance) ? reportData.agentPerformance : [];
        setAgentReport({ ...reportData, agentPerformance: performance });
        setAgentReportLoading(false);

        /* Phase 2 — comparison, non-blocking. */
        api('report', { ...reportFilters, previousOnly: 1 })
        .then(prevRes => {
            const prevData = prevRes?.data && typeof prevRes.data === 'object' && !Array.isArray(prevRes.data) ? prevRes.data : prevRes;
            const previous = prevData && prevData.comparison && prevData.comparison.previous;
            if (!previous) return;
            setAgentReport(cur => cur ? {
                ...cur,
                comparison: { ...(cur.comparison || {}), previous, pending: false }
            } : cur);
        })
        .catch(() => {
            /* Deltas stay hidden rather than showing invented numbers. */
            setAgentReport(cur => cur ? {
                ...cur,
                comparison: { ...(cur.comparison || {}), pending: false }
            } : cur);
        });
    } catch (e) {
        if (e.status === 401) onLogout();
        else setAgentReport(null);
        setAgentReportLoading(false);
    }
};

useEffect(() => {
    const key = String(filters.start || '') + '|' + String(filters.end || '');
    let active = true;
    const days = rangeDayCount;
    if (days < 7) {
        setCacheJob(null);
        return;
    }
    (async () => {
        const apply = st => {
            if (!active || !st) return;
            setCacheJob(st.complete ? null : st);
        };
        const tick = () => new Promise(r => setTimeout(r, 50));
        try {
            let st = await api('cache_job', {start: filters.start, end: filters.end, action: 'status'});
            if (!active) return;
            if (!st || st.complete) {
                setCacheJob(null);
                return;
            }
            apply(st);
            await tick();
            let guard = 0;
            const maxWarm = Math.max(days * 4, 16);
            while (active && st && !st.complete && guard < maxWarm) {
                const warmingDay = st.next || '';
                if (warmingDay) {
                    setCacheJob({...st, next: warmingDay, warming: true});
                    await tick();
                }
                const warm = api('cache_job', {start: filters.start, end: filters.end, action: 'warm'});
                while (active) {
                    const raced = await Promise.race([
                        warm.then(v => ({done: true, v})),
                        new Promise(r => setTimeout(() => r({done: false}), 600))
                    ]);
                    if (!active) return;
                    if (raced.done) {
                        st = raced.v;
                        break;
                    }
                    try {
                        const snap = await api('cache_job', {start: filters.start, end: filters.end, action: 'status'});
                        if (!active) return;
                        if (snap) {
                            st = {...snap, next: snap.next || warmingDay};
                            apply(st);
                            if (snap.complete) {
                                await warm;
                                return;
                            }
                        }
                    } catch (e) {
                        if (e && e.status === 401) throw e;
                    }
                }
                if (!active) return;
                apply(st);
                await tick();
                guard++;
            }
        } catch (e) {
            if (e && e.status === 401) onLogout();
        } finally {
            if (active) {
                setCacheJob(null);
            }
        }
    })();
    return () => { active = false; };
}, [filters.start, filters.end]);

const agentPerformanceTable = h(AgentPerformanceTable, {
    data: agentPerformance,
    loading: agentReportLoading,
    slaSeconds,
    missedPct: domainSettings.missedPct,
    abandonPct: domainSettings.abandonPct,
    ahtMinutes: domainSettings.ahtMinutes,
    onAgentClick: extension => {
        setSelectedAgents([extension]);
        setAgentSub('overview');
    },
    onMetricClick: (metric, extension) => {
        setModal({
            metric: metric || 'total',
            agent: extension || null,
            filters: {
                ...filters,
                agents: extension ? [extension] : (Array.isArray(selectedAgents) ? selectedAgents : [])
            }
        });
    }
});

useEffect(() => {
    if (route !== 'dashboard') return;
    const inv = report?.inventory;
    if (!inv) {
        setInventoryReady({agents:false, numbers:false, aa:false});
        return;
    }
    setInventory(prev => ({
        ...prev,
        agents: Number(inv.agents || 0),
        totalNumbers: Number(inv.totalNumbers || 0),
        enabledNumbers: Number(inv.enabledNumbers || 0),
        autoAttendants: Number(inv.autoAttendants || 0),
        aaCalls: Number(inv.aaCalls || 0),
        queues: inv.queues != null ? Number(inv.queues) : (inv.queueCount != null ? Number(inv.queueCount) : 0)
    }));
    setInventoryReady({agents:true, numbers:true, aa:true, queues:true});
}, [route, report]);

useEffect(() => {
    if (route !== 'agents') return;
    const agents = agentSub === 'overview' ? selectedAgents : [];
    loadAgentReport(agents);
}, [route, agentSub, filters.start, filters.end, filters.department, filters.site, selectedAgents, callTypes, slaSeconds]);

/*
 * =====================================================================
 * PHASE 1 — auto attendant roster only.
 * =====================================================================
 *
 * Loads nothing but the list. No CDRs, no per-AA PBX config fetch. The
 * sidebar fills immediately and the main panel invites a selection.
 *
 * Computing overview + structure for EVERY attendant up front was the
 * bulk of this page's cost, and almost none of it was ever looked at.
 */
useEffect(() => {
    if (route !== 'attendants') return;
    let active = true;
    setAaRosterLoading(true);
    setAaError('');
    api('aa', { ...filters, rosterOnly: 1 })
        .then(r => {
            if (!active) return;
            const response = r?.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r;
            const users = Array.isArray(response?.autoAttendants) ? response.autoAttendants : [];
            setAaRoster(users);
        })
        .catch(e => {
            if (!active) return;
            if (e && e.status === 401) onLogout();
            setAaRoster([]);
            setAaError(e && e.message ? e.message : 'Unable to load auto attendants.');
        })
        .finally(() => {
            if (active) setAaRosterLoading(false);
        });
    return () => { active = false; };
}, [route, filters.start, filters.end, filters.department, filters.site]);

/*
 * Filters changed: whatever was computed for the previous range is stale.
 * Kept separate from the fetches so both phases reset together.
 */
useEffect(() => {
    setAaReport(null);
    setAaStructures(null);
}, [filters.start, filters.end, filters.department, filters.site]);

/*
 * =====================================================================
 * PHASE 2 — overview data for the SELECTED attendant.
 * =====================================================================
 */
useEffect(() => {
    if (route !== 'attendants') return;
    const ext = Array.isArray(selectedAutoAttendants) && selectedAutoAttendants.length
        ? String(selectedAutoAttendants[selectedAutoAttendants.length - 1])
        : '';
    /* No selection: nothing to compute, the panel shows the empty state. */
    if (!ext) return;
    if (aaReport !== null) return;

    let active = true;
    setAaLoading(true);
    setAaError('');
    api('aa', { ...filters, attendant: ext, skipStructures: 1 })
        .then(r => {
            if (!active) return;
            const response = r?.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r;
            const calls = Array.isArray(response?.calls) ? response.calls : [];
            const users = Array.isArray(response?.autoAttendants) ? response.autoAttendants : [];
            setAaReport(calls);
            /* Roster now carries real totalCalls — keep the richer copy. */
            if (users.length) {
                setAaRoster(prev => {
                    const byExt = {};
                    users.forEach(u => { byExt[String(u.extension)] = u; });
                    return (Array.isArray(prev) && prev.length ? prev : users)
                        .map(u => byExt[String(u.extension)] || u);
                });
            }
        })
        .catch(e => {
            if (!active) return;
            if (e && e.status === 401) onLogout();
            setAaReport([]);
            setAaError(e && e.message ? e.message : 'Unable to load auto attendant data.');
        })
        .finally(() => {
            if (active) setAaLoading(false);
        });
    return () => { active = false; };
}, [route, selectedAutoAttendants, aaReport, filters.start, filters.end, filters.department, filters.site]);

/*
 * =====================================================================
 * PHASE 3 — structure tree, only when the tab is open.
 * =====================================================================
 *
 * Scoped to the selected attendant, so this fetches ONE PBX config
 * rather than one per attendant in the domain.
 */
useEffect(() => {
    if (route !== 'attendants') return;
    if (aaView !== 'structure') return;
    if (aaStructures !== null) return;
    const ext = Array.isArray(selectedAutoAttendants) && selectedAutoAttendants.length
        ? String(selectedAutoAttendants[selectedAutoAttendants.length - 1])
        : '';
    if (!ext) return;

    let active = true;
    setAaStructLoading(true);

    api('aa', { ...filters, attendant: ext, structuresOnly: 1 })
        .then(r => {
            if (!active) return;
            const response = r?.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r;
            const structures = response?.structures;
            setAaStructures(
                structures && typeof structures === 'object' ? structures : {}
            );
        })
        .catch(e => {
            if (!active) return;
            if (e && e.status === 401) onLogout();
            /* {} rather than null so it renders "no structure" instead of retrying forever. */
            setAaStructures({});
        })
        .finally(() => {
            if (active) setAaStructLoading(false);
        });

    return () => { active = false; };
}, [route, aaView, aaStructures, selectedAutoAttendants, filters.start, filters.end, filters.department, filters.site]);

useEffect(() => {
    const q = new URLSearchParams({ start: filters.start, end: filters.end });
    if (filters.department) q.set('department', filters.department);
    if (filters.site) q.set('site', filters.site);
    history.replaceState(null, '', '?' + q.toString());
    if (route !== 'dashboard') return;

    /*
     * Two-phase load.
     *
     * report.php used to fetch the current period AND the previous one
     * for "vs last period" before replying. On a wide range that is two
     * full CDR sweeps, so the progress bar would finish while the server
     * was still pulling history — the dashboard sat empty waiting on
     * numbers that are secondary to the ones being asked for.
     *
     * Phase 1 asks for the current period only (skipPrevious) and paints
     * it. Phase 2 fetches the comparison in the background and merges it
     * in, so deltas fill in a moment later instead of gating everything.
     */
    let active = true;
    setLoading(true);

    api('report', { ...filters, callTypes, slaSeconds, skipPrevious: 1 })
    .then(res => {
        if (!active) return;
        setReport(res);
        setLoading(false);

        /* Phase 2 — comparison, non-blocking. */
        api('report', { ...filters, callTypes, slaSeconds, previousOnly: 1 })
        .then(prev => {
            if (!active) return;
            const previous = prev && prev.comparison && prev.comparison.previous;
            if (!previous) return;
            setReport(cur => {
                if (!cur) return cur;
                return {
                    ...cur,
                    comparison: {
                        ...(cur.comparison || {}),
                        previous,
                        pending: false
                    }
                };
            });
        })
        .catch(() => {
            /*
             * Comparison is supplementary: if it fails the dashboard
             * keeps its current-period numbers rather than erroring out.
             * Clearing `pending` stops the deltas spinning forever.
             */
            if (!active) return;
            setReport(cur => cur ? {
                ...cur,
                comparison: { ...(cur.comparison || {}), pending: false }
            } : cur);
        });
    })
    .catch(e => {
        if (!active) return;
        if (e.status === 401) onLogout();
        else setReport(null);
        setLoading(false);
    });

    return () => { active = false; };
}, [route, filters.start, filters.end, filters.department, filters.site, callTypes, slaSeconds]);

const allowedRoutes = routesForRole(user.role);
const item = navItems.filter(n => allowedRoutes.includes(n.id)).map(n =>
    h('button', {
        key: n.id,
        onClick: () => setRoute(n.id),
        title: collapsed ? n.label : '',
        className: 'nav-item w-full flex items-center gap-3 px-3 py-2 text-left text-xs ' + (
            route === n.id
                ? 'is-on bg-cyan-500/15 text-cyan-300 border-r-2 border-cyan-400'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
        )
    },
        h(NavIcon, {name: n.icon, className: 'h-4 w-4 shrink-0'}),
        !collapsed && h('span', null, n.label)
    )
);

let main;

if (route === 'agents') {
    const agentTabs = [
        ['performance', 'Agent stats', 'All agents: volumes, missed, abandon, and handle time for the date range.'],
        ['overview', 'Overview', 'Single-agent dashboard. Select one agent.'],
        ['compare', 'Compare', 'Side-by-side Agent 1 vs Agent 2.']
    ];

    main = h('div', { className: 'agent-layout' },
        agentSub === 'overview'
            ? h(Agents, {
                filters,
                role: user.role,
                selectedAgents,
                singleSelect: true,
                onAgentsChange: ids => setSelectedAgents(ids)
            })
            : null,
        h('main', { className: 'relative z-0 min-w-0 flex-1 overflow-auto p-3' },
            h('div', {className:'aa-tabs mb-3'},
                ...agentTabs.map(([id, label, tip]) =>
                    h('button', {
                        key: id,
                        type: 'button',
                        title: tip,
                        onClick: () => setAgentSub(id),
                        className: 'aa-tab' + (agentSub === id ? ' is-on' : '')
                    }, label)
                )
            ),
            agentSub === 'compare'
                ? h(AgentCompare, {
                    filters,
                    callTypes,
                    onAgentClick: extension => setModal({
                        metric: 'total',
                        agent: extension,
                        filters: { ...filters, agents: [extension] }
                    })
                })
                : agentSub === 'overview'
                    ? h(AgentOverview, {
                        report: agentReport,
                        loading: agentReportLoading,
                        filters,
                        callTypes,
                        selectedAgents,
                        onCallClick: payload => setModal({
                            metric: payload.metric || 'total',
                            hour: payload.hour,
                            agent: payload.agent || null
                        })
                    })
                : agentPerformanceTable
        )
    );

} else if (route === 'attendants') {
    const aaSelectedExt = Array.isArray(selectedAutoAttendants) && selectedAutoAttendants.length
        ? String(selectedAutoAttendants[selectedAutoAttendants.length - 1])
        : '';
    const aaHasSelection = aaSelectedExt !== '';

    main = h('div', { className: 'aa-layout' },
        h(AutoAttendants, {
            filters,
            items: aaRoster,
            listLoading: aaRosterLoading,
            selectedAutoAttendants,
            onAutoAttendantsChange: selected => setSelectedAutoAttendants(selected)
        }),
        h('main', { className: 'relative z-0 min-w-0 flex-1 overflow-auto p-3' },
            /* Tabs are meaningless with nothing selected. */
            aaHasSelection
                ? h('div', {className:'aa-tabs'},
                    ...[['overview','Overview'],['structure','Structure']].map(([id,label]) =>
                        h('button', {
                            key: id,
                            type: 'button',
                            onClick: () => setAaView(id),
                            className: 'aa-tab' + (aaView === id ? ' is-on' : '')
                        }, label)
                    )
                )
                : null,
            aaError
                ? h('div', {className: 'border border-rose-900 bg-rose-950/30 p-4 text-sm text-rose-300'}, aaError)
                : !aaHasSelection
                    /*
                     * Nothing is computed until an attendant is picked, so
                     * say so instead of rendering an empty dashboard.
                     */
                    ? h('div', {className: 'aa-empty'},
                        h(NavIcon, {name: 'attendants', className: 'aa-empty-icon'}),
                        h('div', {className: 'aa-empty-title'}, 'Select an auto attendant'),
                        h('div', {className: 'aa-empty-sub'},
                            aaRosterLoading
                                ? 'Loading attendants…'
                                : (aaRoster.length
                                    ? 'Choose one from the list to load its overview and structure.'
                                    : 'No auto attendants found for this domain.')
                        )
                      )
                    : h(AutoAttendantReport, {
                        data: aaReport,
                        /* null while the tree is lazy-loading; component expects an object. */
                        structures: aaStructures || {},
                        view: aaView,
                        selectedAutoAttendants,
                        filters,
                        /* Each tab waits only on the data it actually needs. */
                        loading: aaView === 'structure'
                            ? (aaStructLoading || aaStructures == null)
                            : (aaLoading || aaReport == null)
                    })
        )
    );
} else if (route === 'queues') {
    main = h(QueueDashboard, {
        filters,
        slaSeconds,
        slaPct: domainSettings.slaPct,
        abandonPct: domainSettings.abandonPct,
        paused: false,
        initialQueue: focusQueue,
        onSlaChange: setSlaSeconds,
        onCallClick: payload => setModal({
            metric: payload.metric || 'total',
            hour: payload.hour,
            queue: payload.queue || null,
            queuesOnly: !!payload.queuesOnly,
            slaSeconds: payload.slaSeconds,
            callTypes: {inbound: true, outbound: true, missed: true, onnet: true}
        })
    });
} else if (route === 'call_history') {
    main = h(CallHistoryDashboard, { filters, callTypes });
} else if (route === 'telephone_numbers') {
    main = h(TelephoneNumbers, {
        filters,
        onCallClick: payload => {
            const phoneNumber = typeof payload === 'string' ? payload : (payload?.phoneNumber || '');
            const callerNumber = typeof payload === 'object' ? (payload?.callerNumber || null) : null;
            /*
             * The Simultaneous tab drills into the calls behind one
             * interval: it passes that bucket's day and hour (a specific
             * bucket narrows the date range to its own date, an hour-of-day
             * bar keeps the shared range). Everything else behaves as before.
             */
            const hour = typeof payload === 'object' && payload?.hour !== undefined && payload?.hour !== null
                ? Number(payload.hour)
                : null;
            const dayFilters = typeof payload === 'object' && typeof payload?.date === 'string' && payload.date
                ? { ...filters, start: payload.date, end: payload.date }
                : null;
            setModal({
                metric: (typeof payload === 'object' && payload?.metric) || (callerNumber ? 'total' : 'inbound'),
                phoneNumber: phoneNumber || null,
                callerNumber,
                hour: hour !== null && Number.isFinite(hour) ? hour : null,
                ...(dayFilters ? { filters: dayFilters } : {})
            });
        }
    });
} else if (route !== 'dashboard') {
    main = h('div', { className: 'grid h-[calc(100vh-105px)] place-items-center text-slate-500' },
        (navItems.find(x => x.id === route) || {}).label + ' · Coming soon'
    );
} else {
    main = h(OverviewDashboard, {
        loading,
        report,
        filters,
        inventory,
        inventoryReady,
        /* Top-agent AHT podium qualification thresholds. */
        topAgentQual: {
            ahtMinutes: domainSettings.topAgentAhtMinutes,
            minCalls: domainSettings.topAgentMinCalls
        },
        onMetric: metric => setModal({ metric }),
        onHourClick: hour => setModal({ metric: 'total', hour, agent: null }),
        onDayClick: day => setModal({ metric: 'total', filters: { ...filters, start: day, end: day } }),
        /*
         * Top Agents row click opens the agent's OVERVIEW (not a call
         * modal): select the extension, switch the Agents page to its
         * overview sub-tab, and route there. The overview reads the
         * shared `filters`, so the current date range carries over and
         * loadAgentReport refetches for that agent automatically.
         */
        onAgentClick: extension => {
            if (!extension) return;
            /*
             * agent/basic_user roles cannot reach the Agents route — a
             * route guard would bounce them straight back to the
             * dashboard, so they keep the old call-modal behaviour.
             */
            if (!allowedRoutes.includes('agents')) {
                setModal({ metric: 'total', agent: extension });
                return;
            }
            setSelectedAgents([String(extension)]);
            setAgentSub('overview');
            setRoute('agents');
        },
        onNavigate: setRoute,
        slaSeconds,
        onSlaChange: setSlaSeconds,
        allowedRoutes
    });
}

return h('div', { className: 'min-h-screen' },
    h('div', { className: 'min-h-screen flex' },
        h('nav', {
            className: 'relative flex-shrink-0 border-r border-slate-700 bg-slate-900 transition-all duration-150 ' + (collapsed ? 'w-12' : 'w-44')
        },
            h('button', { onClick: () => setCollapsed(!collapsed), className: 'w-full border-b border-slate-700 py-3 text-cyan-400' }, '☰'),
            h('div', { ref: navPanelRef, className: 'nav-panel pt-2' }, ...item,
                h('button', {
                    key: 'settings',
                    type: 'button',
                    onClick: () => setSettingsOpen(true),
                    title: collapsed ? 'Settings' : '',
                    className: 'nav-item w-full flex items-center gap-3 px-3 py-2 text-left text-xs ' + (
                        settingsOpen ? 'is-on bg-cyan-500/15 text-cyan-300 border-r-2 border-cyan-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    )
                },
                    h(NavIcon, {name: 'settings', className: 'h-4 w-4 shrink-0'}),
                    !collapsed && h('span', null, 'Settings')
                )
            ),
            h('div', { className: 'nav-user' + (collapsed ? ' is-collapsed' : '') },
                h('span', {
                    className: 'hist-avatar nav-user-avatar',
                    title: [user.displayName, user.role, user.domain].filter(Boolean).join(' · ')
                }, histInitials(user.displayName || user.username, user.extension)),
                !collapsed
                    ? h('div', { className: 'nav-user-copy' },
                        h('div', { className: 'nav-user-name', title: user.displayName }, user.displayName || user.username || 'Signed in'),
                        h('div', { className: 'nav-user-role' }, String(user.role || '').replace(/_/g, ' ')),
                        h('div', { className: 'nav-user-domain', title: user.domain }, user.domain || '')
                      )
                    : null,
                h('button', {
                    type: 'button',
                    onClick: onLogout,
                    title: 'Sign out',
                    className: 'nav-user-out'
                }, collapsed ? '↪' : 'Sign out')
            )
        ),
        h('div', { ref: mainScrollRef, className: 'min-w-0 flex-1 overflow-auto' },
            h('header', { className: 'relative z-30 flex h-12 items-center justify-between border-b border-slate-700 bg-slate-900 px-3' },
                h('div', null,
                    h('span', { className: 'text-sm font-semibold text-slate-100' }, 'Reporting dashboard'),
                    h('span', { className: 'ml-2 text-[10px] text-slate-500' }, 'US/Eastern · ' + user.displayName)
                ),
                h('div', { className: 'flex items-center gap-3' },
                    h(AlertsBell, {filters, onOpenItem: it => {
                        const id = String(it.id || '').trim();
                        const kind = String(it.kind || '');
                        if (kind === 'queue') {
                            setFocusQueue(id);
                            setRoute('queues');
                        } else if (kind === 'aa') {
                            if (id) setSelectedAutoAttendants([id]);
                            setFocusAa(id);
                            setRoute('attendants');
                        } else {
                            if (id) setSelectedAgents([id]);
                            setAgentSub('overview');
                            setRoute('agents');
                        }
                    }}),
                    h(ThemeToggle),
                    h('span', { className: 'text-[10px] uppercase tracking-wider text-cyan-400' }, user.role.replace('_', ' '))
                )
            ),
            h(Filters, { filters, setFilters, role: user.role, rangeLocked: !!cacheJob }),
            cacheJob ? h('div', {className: 'cache-job'},
                h('div', {className: 'cache-job-copy'},
                    h('span', {className: 'font-medium text-slate-200'}, 'Preparing call history'),
                    h('span', {className: 'text-slate-500'},
                        ' ' + (cacheJob.ready || 0) + ' of ' + (cacheJob.total || 0) + ' days cached' +
                        (cacheJob.next ? ' · fetching ' + cacheJob.next : '')
                    )
                ),
                h('div', {className: 'cache-job-track'},
                    h('div', {className: 'cache-job-fill', style: {width: Math.max(2, Number(cacheJob.percent || 0)) + '%'}})
                )
            ) : null,
            route === 'dashboard' || route === 'agents' || route === 'call_history'
                ? h(CallTypeFilters, { callTypes, setCallTypes })
                : null,
            main
        )
    ),
    settingsOpen
        ? h(SettingsModal, {
            user,
            slaSeconds,
            filters,
            callTypes,
            onSlaChange: setSlaSeconds,
            onClose: () => setSettingsOpen(false),
            onNotify: pushToast,
            onSaved: d => {
                if (!d) return;
                if (d.slaSeconds) setSlaSeconds(writeSlaSeconds(d.slaSeconds));
                setDomainSettings(prev => ({
                    slaPct: Number(d.slaPct || 80),
                    abandonPct: Number(d.abandonPct || 10),
                    missedPct: Number(d.missedPct || 20),
                    ahtMinutes: Number(d.ahtMinutes || 5),
                    ahtOutboundMinutes: Number(d.ahtOutboundMinutes || d.ahtMinutes || 5),
                    /*
                     * Keep the values the user just chose even if the
                     * backend does not echo them back yet, otherwise the
                     * Top Agents card would snap back to the old
                     * thresholds the moment the modal closes.
                     */
                    topAgentAhtMinutes: Number(
                        d.topAgentAhtMinutes ?? prev.topAgentAhtMinutes ?? d.ahtMinutes ?? 5),
                    topAgentMinCalls: Number(
                        d.topAgentMinCalls ?? prev.topAgentMinCalls ?? 20)
                }));
            }
        })
        : null,
    h(ToastHost, { toasts, onDismiss: dismissToast }),
    modal
        ? h(CallModal, {
            metric: modal.metric || 'total',
            hour: modal.hour !== undefined ? modal.hour : null,
            agent: modal.agent || null,
            phoneNumber: modal.phoneNumber || null,
            callerNumber: modal.callerNumber || null,
            queue: modal.queue || null,
            queuesOnly: !!modal.queuesOnly,
            filters: modal.filters || filters,
            callTypes: modal.callTypes || callTypes,
            slaSeconds,
            onClose: () => setModal(null)
        })
        : null
);
}

export { Dashboard };
