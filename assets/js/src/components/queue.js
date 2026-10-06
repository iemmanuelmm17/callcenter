/* Queue dashboard: KPIs, donut, recent calls, sentiment and cradle paths.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { DonutChart, KpiCard, splineArea } from './charts.js';
import { ErrorState, SlaControl, Tooltip, skelKpis, skelPanel } from './ui.js';
import { api } from '../lib/api.js';
import { fmt, fmtNum } from '../lib/format.js';
import { h, keyActivate, useEffect, useRef, useState } from '../lib/react.js';
import { slaRingClass } from '../lib/sla.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';

function QueueDashboard({filters, slaSeconds, slaPct, abandonPct, onSlaChange, onCallClick, initialQueue}) {
  const hourCanvas = useRef(null);
  const hourChart = useRef(null);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState(initialQueue || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [tab, setTab] = useState('summary');
  const [expanded, setExpanded] = useState('');
  const [cradleHops, setCradleHops] = useState({});
  const [cradleBusy, setCradleBusy] = useState('');
  const [statsPage, setStatsPage] = useState(1);
  const [statsSize, setStatsSize] = useState(25);
  const [statsSortKey, setStatsSortKey] = useState('totalCalls');
  const [statsSortDir, setStatsSortDir] = useState('desc');
  const [statsQuery, setStatsQuery] = useState('');
  const [statsSite, setStatsSite] = useState('');
  const [hideInactive, setHideInactive] = useState(true);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  /* Bumped by Retry; the panel had no way back from a transient failure. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api('queue', {...filters, queue: tab === 'summary' ? '' : selected, slaSeconds})
      .then(r => {
        if (!active) return;
        const payload = r?.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r;
        setData(payload);
      })
      .catch(e => {
        if (!active) return;
        setError(e.message || 'Unable to load queues.');
        setData(null);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filters.start, filters.end, filters.site, filters.department, selected, slaSeconds, tab, reload]);

  useEffect(() => { setPage(1); setExpanded(''); setCradleHops({}); }, [selected, data, pageSize]);
  useEffect(() => { setStatsPage(1); }, [data, statsSize, statsSortKey, statsSortDir, statsQuery, statsSite, hideInactive]);

  const queues = Array.isArray(data?.queues) ? data.queues : [];
  const queueStats = Array.isArray(data?.queueStats) ? data.queueStats : [];
  const queueCallCounts = {};
  queueStats.forEach(q => { queueCallCounts[String(q.callqueue)] = Number(q.totalCalls || 0); });
  const visible = queues.filter(q => {
    const hay = ((q.description || '') + ' ' + (q.callqueue || '') + ' ' + (q.site || '')).toLowerCase();
    return hay.includes(term.trim().toLowerCase());
  }).slice().sort((a, b) => {
    const av = Number(a.totalCalls ?? a.calls ?? a.total ?? queueCallCounts[String(a.callqueue)] ?? 0);
    const bv = Number(b.totalCalls ?? b.calls ?? b.total ?? queueCallCounts[String(b.callqueue)] ?? 0);
    if (bv !== av) return bv - av;
    return String(a.description || a.callqueue || '').localeCompare(String(b.description || b.callqueue || ''));
  });
  useEffect(() => {
    if (loading || !visible.length) return;
    if (selected && visible.some(q => q.callqueue === selected)) return;
    setSelected(visible[0].callqueue);
  }, [loading, queues, term, selected]);
  useEffect(() => {
    if (!initialQueue) return;
    setSelected(initialQueue);
    setTab('overview');
  }, [initialQueue]);
  const kpis = data?.kpis || {};
  const hours = Array.isArray(data?.hours) ? data.hours : Array.from({length: 24}, () => 0);
  const outcomes = data?.outcomes || {answered: 0, abandoned: 0, missed: 0};
  const status = data?.agentStatus || {available: 0, oncall: 0, unavailable: 0, offline: 0};
  const roster = Array.isArray(data?.roster) ? data.roster : [];
  const topAgents = Array.isArray(data?.topAgents) ? data.topAgents : [];
  const reasons = Array.isArray(data?.disconnectReasons) ? data.disconnectReasons : [];
  const sentiment = data?.sentiment || {positive: 0, neutral: 0, negative: 0, topics: []};
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  const statsColumns = [
    ['callqueue', ['Ext'], 'Queue extension (callqueue).', 'text', '4.5%'],
    ['description', ['Queue'], 'Queue name. Site is shown underneath.', 'text', '14%'],
    ['totalCalls', ['Total', 'Calls'], 'All CDR legs whose call-through-user is this queue.', 'num', '6%'],
    ['offered', ['Calls', 'Offered'], 'Calls answered by an agent plus abandoned calls.', 'num', '6%'],
    ['handled', ['Calls', 'Handled'], 'Calls answered by an agent (talk or answer time).', 'num', '6%'],
    ['slaMiss', ['SLA'], 'Answered calls whose ring exceeded the SLA seconds setting.', 'num', '5.5%'],
    ['sla', ['SLA', 'Rate'], 'Percent of answered queue calls with ring at or under SLA.', 'num', '6%'],
    ['abandoned', ['Abandoned', 'Calls'], 'Callers who hung up in this queue before an agent answered.', 'num', '7%'],
    ['abandonRate', ['Abandoned', 'Call', 'Percentage'], 'Abandoned ÷ offered for this queue.', 'num', '7%'],
    ['avgRing', ['Average', 'Ring', 'Time'], 'Average ring / wait before answer.', 'dur', '7%'],
    ['maxRing', ['Longest', 'Ring', 'Time'], 'Longest ring / wait before answer.', 'dur', '7%'],
    ['avgTalk', ['Average', 'Talk', 'Time'], 'Average talking duration on answered queue calls.', 'dur', '7%'],
    ['maxTalk', ['Longest', 'Talk', 'Time'], 'Longest talking duration on this queue.', 'dur', '7%'],
    ['totalTalk', ['Total', 'Talk', 'Time'], 'Sum of talking duration on this queue.', 'dur', '8%']
  ];
  const statsFiltered = queueStats.filter(q => {
    if (statsSite && String(q.site || '') !== statsSite) return false;
    const qy = statsQuery.trim().toLowerCase();
    if (qy && !((q.description || '') + ' ' + (q.callqueue || '') + ' ' + (q.site || '')).toLowerCase().includes(qy)) return false;
    if (hideInactive && Number(q.totalCalls || 0) <= 0) return false;
    return true;
  });
  const inactiveCount = queueStats.filter(q => {
    if (statsSite && String(q.site || '') !== statsSite) return false;
    const qy = statsQuery.trim().toLowerCase();
    if (qy && !((q.description || '') + ' ' + (q.callqueue || '') + ' ' + (q.site || '')).toLowerCase().includes(qy)) return false;
    return Number(q.totalCalls || 0) <= 0;
  }).length;
  const sortedQueueStats = statsFiltered.slice().sort((a, b) => {
    const col = statsColumns.find(c => c[0] === statsSortKey);
    const kind = col ? col[3] : 'num';
    if (kind === 'text') {
      const av = String(a[statsSortKey] || '').toLowerCase();
      const bv = String(b[statsSortKey] || '').toLowerCase();
      if (av < bv) return statsSortDir === 'asc' ? -1 : 1;
      if (av > bv) return statsSortDir === 'asc' ? 1 : -1;
      return 0;
    }
    const av = Number(a[statsSortKey] || 0);
    const bv = Number(b[statsSortKey] || 0);
    return statsSortDir === 'asc' ? av - bv : bv - av;
  });
  const toggleStatsSort = field => {
    if (statsSortKey === field) setStatsSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else {
      setStatsSortKey(field);
      setStatsSortDir(field === 'callqueue' || field === 'description' ? 'asc' : 'desc');
    }
  };
  const openQueueCalls = (metric, queueId) => {
    if (typeof onCallClick !== 'function') return;
    const q = queueId !== undefined ? queueId : selected;
    onCallClick({
      metric: metric || 'total',
      queue: q || null,
      queuesOnly: !q,
      slaSeconds
    });
  };
  const meta = data?.queue || null;
  const selectedRow = queues.find(q => q.callqueue === selected) || null;

  useEffect(() => {
    if (!hourCanvas.current || tab !== 'overview') return;
    hourChart.current?.destroy();
    hourChart.current = new Chart(hourCanvas.current, {
      type: 'line',
      data: {
        labels: Array.from({length: 24}, (_, i) => String(i).padStart(2, '0')),
        datasets: [splineArea(hourCanvas.current, '#22d3ee', hours)]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        /* Column-wide hit test; the 2px stroke alone is a poor target. */
        interaction: {mode: 'index', intersect: false},
        plugins: {legend: {display: false}},
        onHover: (event, elements) => {
          const t = event?.native?.target;
          if (t) t.style.cursor = elements?.length ? 'pointer' : 'default';
        },
        onClick: (event, elements) => {
          if (!elements?.length || typeof onCallClick !== 'function') return;
          onCallClick({
            metric: 'total',
            hour: elements[0].index,
            queue: selected || null,
            queuesOnly: !selected,
            /* Same SLA the chart and the table colour rings with. */
            slaSeconds
          });
        },
        scales: {
          x: {grid: {color: '#1e293b'}, ticks: {color: '#94a3b8', maxRotation: 0}},
          y: {beginAtZero: true, grid: {color: '#1e293b'}, ticks: {color: '#94a3b8', precision: 0}}
        }
      }
    });
    return () => { hourChart.current?.destroy(); hourChart.current = null; };
    /* slaSeconds + selected, because the click handler above closes over them. */
  }, [hours.join('|'), tab, slaSeconds, selected]);

  const exportCsv = () => {
    const rows = tab === 'summary'
      ? [['queue', 'name', 'site', 'total_calls', 'offered', 'handled', 'sla_missed', 'sla_rate', 'abandoned', 'abandon_rate', 'avg_ring', 'max_ring', 'avg_talk', 'max_talk', 'total_talk'],
         ...queueStats.map(q => [q.callqueue, q.description, q.site, q.totalCalls, q.offered, q.handled, q.slaMiss, q.sla, q.abandoned, q.abandonRate, q.avgRing, q.maxRing, q.avgTalk, q.maxTalk, q.totalTalk])]
      : [
          ['metric', 'value'],
          ['waiting', kpis.waiting ?? 0],
          ['agents_available', kpis.agentsAvailable ?? 0],
          ['agents_total', kpis.agentsTotal ?? 0],
          ['total_calls', kpis.totalCalls ?? 0],
          ['avg_ring', kpis.avgWait ?? 0],
          ['sla', kpis.sla ?? 0],
          ['abandon_rate', kpis.abandonRate ?? 0],
          ['avg_talk', kpis.avgTalk ?? 0]
        ];
    const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'queue-' + (tab === 'summary' ? 'stats' : (selected || 'all')) + '-' + (filters.start || '') + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportRecentCsv = () => {
    const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const pathOf = c => {
      const hops = Array.isArray(c.hops) ? c.hops : [];
      if (hops.length) return hops.map(x => x.label || x).join(' → ');
      return c.path || '';
    };
    const header = ['caller', 'agent', 'path', 'ring', 'talk', 'sentiment', 'reason', 'date', 'time'];
    const body = (Array.isArray(recent) ? recent : []).map(c => [
      c.caller || '',
      c.agent || '',
      pathOf(c),
      Number(c.wait) > 0 ? fmt(c.wait) : '',
      Number(c.talk) > 0 ? fmt(c.talk) : '',
      c.sentiment || '',
      c.reason || '',
      formatCallDate(c.startedAt) || '',
      formatCallTime(c.startedAt) || ''
    ]);
    const csv = [header, ...body].map(r => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'queue-recent-' + (selected || 'all') + '-' + (filters.start || '') + '-' + (filters.end || '') + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const outcomeTotal = (outcomes.answered || 0) + (outcomes.abandoned || 0) + (outcomes.missed || 0);
  const statusSlices = [
    {label: 'Available', value: status.available || 0, color: '#34d399'},
    {label: 'On call', value: status.oncall || 0, color: '#f59e0b'},
    {label: 'Unavailable', value: status.unavailable || 0, color: '#94a3b8'},
    {label: 'Offline', value: status.offline || 0, color: '#475569'}
  ];
  const pill = st => {
    const map = {
      available: ['Available', 'q-pill-ok'],
      oncall: ['On call', 'q-pill-warn'],
      unavailable: ['Unavailable', 'q-pill-off'],
      offline: ['Offline', 'q-pill-off']
    };
    const [lab, cls] = map[st] || [st, 'q-pill-off'];
    return h('span', {className: 'q-pill ' + cls}, lab);
  };

  const pages = Math.max(1, Math.ceil(recent.length / pageSize));
  const safePage = Math.min(page, pages);
  const slice = recent.slice((safePage - 1) * pageSize, safePage * pageSize);
  const statsPages = Math.max(1, Math.ceil(sortedQueueStats.length / statsSize));
  const safeStats = Math.min(statsPage, statsPages);
  const statsSlice = sortedQueueStats.slice((safeStats - 1) * statsSize, safeStats * statsSize);

  const title = selectedRow
    ? (selectedRow.callqueue + ' — ' + selectedRow.description)
    : (meta ? ((meta.callqueue || '') + ' — ' + (meta.description || '')) : 'All queues');

  const tip = (text, child) => h(Tooltip, {text}, child);
  const qHelp = (label) => tip(label, h('span', {className: 'cursor-help border-b border-dotted border-slate-600 text-[10px] font-normal text-slate-500'}, '?'));

  const skeletonMain = h('div', {className: 'space-y-3'},
    skelKpis(7),
    h('div', {className: 'dash-breakdown'},
      skelPanel('h-40', 'q-card-fit'),
      skelPanel('h-40', 'q-card-fit'),
      skelPanel('h-40', 'q-card-fit')
    ),
    h('div', {className: 'queue-split'},
      skelPanel('h-36', 'q-card-fit'),
      skelPanel('h-36', 'q-card-fit')
    ),
    h('div', {className: 'queue-split'},
      skelPanel('h-28', 'q-card-fit'),
      skelPanel('h-28', 'q-card-fit')
    ),
    skelPanel('h-48')
  );

  const overview = h('div', {className: 'space-y-3'},
    h('section', {className: 'dash-kpi'},
      h(KpiCard, {label: 'Waiting now', value: kpis.waiting ?? 0, icon: 'fa-solid fa-hourglass-half', tone: (kpis.waiting || 0) > 0 ? 'bad' : null, tooltip: 'Live callers currently queued (active-queued-calls-total-current).'}),
      h(KpiCard, {label: 'Agents', value: (kpis.agentsAvailable ?? 0) + '/' + (kpis.agentsTotal ?? 0), hint: 'Available / total', icon: 'fa-solid fa-user-group', tooltip: 'Agents ready for dispatch versus total agents on this queue.'}),
      h(KpiCard, {label: 'Total calls', value: kpis.totalCalls ?? 0, icon: 'fa-solid fa-phone', tooltip: 'CDR legs whose call-through-user is this queue (or all queues). Click to open those calls.', onClick: () => openQueueCalls('total')}),
      h(KpiCard, {label: 'Avg ring', value: fmt(kpis.avgWait || 0), icon: 'fa-solid fa-bell', tone: Number(kpis.avgWait || 0) > slaSeconds ? 'bad' : null, tooltip: 'Average ring / wait before answer. Click to open answered queue calls.', onClick: () => openQueueCalls('answered')}),
      h(KpiCard, {label: 'Service level', value: (kpis.sla ?? 0) + '%', hint: 'Answered in ' + (slaSeconds || kpis.slaSeconds || 20) + 's', icon: 'fa-solid fa-stopwatch', tone: Number(kpis.sla || 0) < Number(slaPct || 80) ? 'bad' : 'good', tooltip: 'Click to open answered queue calls whose ring exceeded the SLA seconds setting.', onClick: () => openQueueCalls('sla_missed')}),
      h(KpiCard, {label: 'Abandon rate', value: (kpis.abandonRate ?? 0) + '%', hint: fmtNum(outcomes.abandoned || kpis.abandoned || 0) + ' calls', icon: 'fa-solid fa-person-walking-dashed-line-arrow-right', tone: 'bad', tooltip: 'Share of queue legs where the caller hung up before an agent answered. Click to open those calls.', onClick: () => openQueueCalls('abandoned')}),
      h(KpiCard, {label: 'Avg talk', value: fmt(kpis.avgTalk || 0), icon: 'fa-solid fa-comments', tooltip: 'Average talking duration on answered queue calls. Click to open answered calls.', onClick: () => openQueueCalls('answered')})
    ),
    h('div', {className: 'dash-breakdown'},
      h(DonutChart, {title: 'Agent status', hint: 'Live roster status for the selected queue. Select a queue to load agents.', slices: statusSlices}),
      h('section', {className: 'dash-card dash-hour q-card-fit'},
        h('div', {className: 'dash-label'}, 'Call volume by hour', qHelp('Queue CDR starts by hour of day (US/Eastern).')),
        h('div', {className: 'dash-hour-chart'}, h('canvas', {ref: hourCanvas}))
      ),
      h('section', {className: 'dash-card q-card-fit'},
        h('div', {className: 'dash-label'}, 'Sentiment', qHelp('Average call-intelligence positive / neutral / negative on queue CDRs.')),
        ...[['Positive', sentiment.positive, '#34d399'], ['Neutral', sentiment.neutral, '#94a3b8'], ['Negative', sentiment.negative, '#f87171']].map(([lab, val, color]) =>
          h('div', {key: lab, className: 'mb-2'},
            h('div', {className: 'flex justify-between text-[11px] text-slate-400'},
              h('span', null, lab), h('span', null, (val || 0) + '%')
            ),
            h('div', {className: 'dash-missed-track'},
              h('div', {className: 'dash-missed-fill', style: {width: Math.min(100, Number(val) || 0) + '%', background: color}})
            )
          )
        )
      )
    ),
    h('div', {className: 'queue-split'},
      h('section', {className: 'dash-card q-card-fit'},
        h('div', {className: 'dash-label'}, 'Agents', qHelp('Roster for the selected queue only. Loaded when a queue is selected.')),
        h('div', {className: 'q-table-wrap'},
          h('table', {className: 'q-table'},
            h('thead', null, h('tr', null,
              h('th', null, 'Name'),
              h('th', null, 'Dept'),
              h('th', null, 'Status'),
              h('th', {className: 'text-right'}, 'Active'),
              h('th', {className: 'text-right'}, 'Last dispatch')
            )),
            h('tbody', null,
              roster.length === 0
                ? h('tr', null, h('td', {colSpan: 5, className: 'px-2 py-6 text-center text-slate-500'}, selected ? 'No agents.' : 'Select a queue to load agents.'))
                : roster.map(a => h('tr', {key: a.id},
                    h('td', {className: 'text-slate-200'}, a.name),
                    h('td', {className: 'text-slate-400'}, a.department || '—'),
                    h('td', null, pill(a.status)),
                    h('td', {className: 'text-right'}, a.activeCalls ?? 0),
                    h('td', {className: 'text-right text-slate-500'},
                      a.lastDispatch ? (formatCallDate(a.lastDispatch) + ' ' + formatCallTime(a.lastDispatch)) : '—')
                  ))
            )
          )
        )
      ),
      h('section', {className: 'dash-card q-card-fit'},
        h('div', {className: 'dash-label'}, 'Top agents', qHelp('Answered volume by call-term-user (agents, not queues).')),
        h('div', {className: 'q-table-wrap'},
          h('table', {className: 'q-table'},
            h('thead', null, h('tr', null,
              h('th', null, ''),
              h('th', null, 'Name'),
              h('th', {className: 'text-right'}, 'Calls'),
              h('th', {className: 'text-right'}, 'AHT'),
              h('th', {className: 'text-right'}, 'Sent.')
            )),
            h('tbody', null,
              topAgents.length === 0
                ? h('tr', null, h('td', {colSpan: 5, className: 'px-2 py-6 text-center text-slate-500'}, 'No agent calls.'))
                : topAgents.map((a, i) => h('tr', {key: a.extension},
                    h('td', null, h('span', {className: 'rank-badge ' + (i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '')}, String(i + 1))),
                    h('td', {className: 'text-slate-200'}, a.name),
                    h('td', {className: 'text-right'}, a.calls),
                    h('td', {className: 'text-right font-mono text-cyan-300'}, fmt(a.aht || 0)),
                    h('td', {className: 'text-right'}, a.sentiment)
                  ))
            )
          )
        )
      )
    ),
    h('div', {className: 'queue-split'},
      h(DonutChart, {
        title: 'Outcomes',
        hint: 'Answered vs abandoned (reached the queue, never answered) vs missed (reached the queue extension, never joined the queue). Center is every queue leg in this mix.',
        center: fmtNum(outcomeTotal),
        slices: [
          {label: 'Answered', value: outcomes.answered || 0, color: '#34d399'},
          {label: 'Abandoned', value: outcomes.abandoned || 0, color: '#f87171'},
          {label: 'Missed', value: outcomes.missed || 0, color: '#f59e0b'}
        ]
      }),
      h('section', {className: 'dash-card q-card-fit'},
        h('div', {className: 'dash-label'}, 'Disconnect reasons', qHelp('Top call-disconnect-reason-text values on queue CDRs.')),
        h('div', {className: 'q-scroll-body'},
          reasons.length === 0
            ? h('div', {className: 'text-xs text-slate-500'}, 'No disconnect reasons.')
            : reasons.map((r, i) => h('div', {key: r.reason, className: 'flex justify-between border-b border-slate-800 py-1.5 text-xs', title: r.reason},
                h('span', {className: 'text-slate-400 truncate pr-2'}, (i + 1) + '. ' + r.reason),
                h('span', {className: 'text-slate-200'}, r.count)
              ))
        )
      )
    ),
    h('section', {className: 'dash-card'},
      h('div', {className: 'mb-2 flex items-center justify-between gap-2'},
        h('div', {className: 'dash-label mb-0'}, 'Recent calls', qHelp('Click a row to load the Sky cradle path (queues then answering agent). Ring is wait-to-answer. Use Open to open that one call — recording and SIP flow.')),
        h('button', {
          type: 'button',
          disabled: !recent.length,
          onClick: exportRecentCsv,
          title: 'Exports the most recent calls the server returns for this queue (capped at 200). Use Call History for a complete range export.',
          className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40'
        }, 'Export CSV')
      ),
      h('div', {className: 'q-table-wrap q-table-wrap-lg'},
        h('table', {className: 'q-table'},
          h('thead', null, h('tr', null,
            h('th', null, ''),
            ...[['Caller', 'Originating caller'], ['Agent', 'call-term-user when that extension is not a queue'], ['Path', 'Cradle hop'], ['Ring', 'Ring / wait before answer'], ['Talk', 'Talking duration'], ['Sentiment', 'Ending sentiment'], ['Reason', 'Disconnect reason'], ['Time', 'Queue start (US/Eastern)']].map(([lab, t]) =>
              h('th', {key: lab}, tip(t, h('span', {className: 'cursor-help border-b border-dotted border-slate-600'}, lab)))),
            h('th', {key: 'open'}, tip('Open the single call', h('span', {className: 'cursor-help border-b border-dotted border-slate-600'}, 'Call')))
          )),
          h('tbody', null,
            slice.length === 0
              ? h('tr', null, h('td', {colSpan: 10, className: 'px-2 py-8 text-center text-slate-500'}, 'No queue calls in this range.'))
              : slice.flatMap((c, i) => {
                  const key = String((c.cradle && c.cradle.orig) || c.parentId || i) + ':' + i;
                  const open = expanded === key;
                  const hops = cradleHops[key] || c.hops || [];
                  const toggleRow = () => {
                    if (open) { setExpanded(''); return; }
                    setExpanded(key);
                    if (cradleHops[key] || !c.cradle || !c.cradle.orig) return;
                    setCradleBusy(key);
                    api('cradle', c.cradle)
                      .then(r => {
                        const payload = r?.data && typeof r.data === 'object' ? r.data : r;
                        const next = Array.isArray(payload?.hops) ? payload.hops : [];
                        setCradleHops(prev => ({...prev, [key]: next.length ? next : (c.hops || [])}));
                      })
                      .catch(() => setCradleHops(prev => ({...prev, [key]: c.hops || []})))
                      .finally(() => setCradleBusy(k => k === key ? '' : k));
                  };
                  const rows = [h('tr', {
                    key,
                    tabIndex: 0,
                    className: 'cursor-pointer hover:bg-slate-800/60 ' + (open ? 'bg-slate-800/40' : ''),
                    title: 'Click to show call path',
                    onClick: toggleRow,
                    onKeyDown: keyActivate(toggleRow)
                  },
                    h('td', {className: 'text-slate-500'}, open ? '▾' : '▸'),
                    h('td', {className: 'text-slate-200'}, c.caller || '—'),
                    h('td', {className: 'text-slate-300'}, c.agent || '—'),
                    h('td', {className: 'wrap text-cyan-300'},
                      cradleBusy === key ? 'Loading…' : ((hops.length ? hops : (c.hops || [])).map(x => x.label || x).join(' → ') || c.path || 'Click to load')
                    ),
                    h('td', {className: 'font-mono ' + slaRingClass(c.wait, slaSeconds)}, Number(c.wait) > 0 ? fmt(c.wait) : '—'),
                    h('td', {className: 'font-mono'}, Number(c.talk) > 0 ? fmt(c.talk) : '—'),
                    h('td', null, h('span', {className: 'q-sent ' + (c.sentiment || 'neutral'), title: c.sentiment})),
                    h('td', {className: 'text-slate-400 max-w-[12rem] truncate', title: c.reason}, c.reason || '—'),
                    h('td', {className: 'text-slate-500 whitespace-nowrap'},
                      (formatCallDate(c.startedAt) + ' ' + formatCallTime(c.startedAt)).trim() || '—'),
                    h('td', null,
                      c.id
                        ? h('button', {
                            type: 'button',
                            className: 'cursor-pointer rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-cyan-300 hover:border-cyan-500',
                            title: 'Open this call: recording and SIP flow',
                            /* The row itself expands the cradle path, so this
                             * must not also toggle it. */
                            onClick: e => {
                              if (e && e.stopPropagation) e.stopPropagation();
                              if (typeof onCallClick === 'function') onCallClick({metric: 'total', callId: String(c.id)});
                            }
                          }, 'Open')
                        : '—')
                  )];
                  if (open) {
                    const show = hops.length ? hops : (c.hops && c.hops.length ? c.hops : (c.path ? [{label: c.path}] : []));
                    rows.push(h('tr', {key: key + '-path'},
                      h('td', {colSpan: 10, className: 'q-path-cell'},
                        cradleBusy === key
                          ? h('div', {className: 'text-xs text-slate-500'}, 'Loading cradle path…')
                          : h('div', {className: 'q-path'},
                              (show.length ? show : [{label: 'No hop path'}]).map((hop, hi) =>
                                h('span', {key: hi, className: 'q-path-item'},
                                  hi ? h('span', {className: 'q-path-arrow'}, '→') : null,
                                  h('span', {className: 'q-path-hop ' + (hop.kind || '')}, hop.label || hop)
                                )
                              )
                            )
                      )
                    ));
                  }
                  return rows;
                })
          )
        )
      ),
      h('div', {className: 'mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400'},
        h('div', {className: 'flex items-center gap-2'},
          'Rows per page:',
          h('select', {
            value: pageSize,
            onChange: e => { setPageSize(Number(e.target.value)); setPage(1); },
            className: 'cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs'
          },
            h('option', {value: 10}, '10'),
            h('option', {value: 25}, '25'),
            h('option', {value: 50}, '50'),
            h('option', {value: 100}, '100')
          )
        ),
        h('div', {className: 'flex gap-1'},
          h('button', {type: 'button', disabled: safePage <= 1, onClick: () => setPage(p => Math.max(1, p - 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Prev'),
          h('span', {className: 'px-2 py-1'}, 'Page ' + safePage + ' of ' + pages),
          h('button', {type: 'button', disabled: safePage >= pages, onClick: () => setPage(p => Math.min(pages, p + 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Next')
        )
      )
    )
  );

  const statsSites = Array.from(new Set(queueStats.map(q => String(q.site || '').trim()).filter(Boolean))).sort();
  const statsTotals = statsFiltered.reduce((acc, q) => {
    const n = Number(q.totalCalls || 0);
    const offered = Number(q.offered || 0);
    acc.queues += 1;
    acc.calls += n;
    acc.offered += offered;
    acc.slaW += Number(q.sla || 0) * Math.max(offered, n);
    acc.slaWBase += Math.max(offered, n);
    acc.handled += Number(q.handled || 0);
    acc.slaMiss += Number(q.slaMiss || 0);
    acc.abandoned += Number(q.abandoned || 0);
    return acc;
  }, {queues: 0, calls: 0, offered: 0, slaW: 0, slaWBase: 0, handled: 0, slaMiss: 0, abandoned: 0});
  const overallSla = statsTotals.slaWBase ? (statsTotals.slaW / statsTotals.slaWBase) : 0;
  const openStat = (ev, metric, queueId) => {
    if (ev) ev.stopPropagation();
    openQueueCalls(metric, queueId);
  };
  const slaPass = Number(slaPct != null ? slaPct : 80);
  const abLimit = Number(abandonPct != null ? abandonPct : 10);
  const failedSlaQueues = statsFiltered.filter(q => Number(q.totalCalls || 0) > 0 && Number(q.sla || 0) < slaPass).length;
  const slaMissRate = statsTotals.handled ? (statsTotals.slaMiss / statsTotals.handled) * 100 : 0;
  const qsBlank = v => {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === '0' || s === '0.0' || s === '0.0%' || s === '0%' || s === '00:00:00' || s === '00:00') return '—';
    return s;
  };
  const numCell = (q, field, text, metric, tone) => {
    const shown = qsBlank(text);
    const empty = shown === '—';
    return h('td', {className: 'qs-num'},
      h('button', {
        type: 'button',
        className: 'qs-num-btn' + (tone === 'fail' && !empty ? ' is-fail' : (tone === 'pass' && !empty ? ' is-pass' : (empty ? ' is-faint' : ''))),
        title: 'Open matching calls',
        onClick: ev => openStat(ev, metric, q.callqueue)
      }, shown)
    );
  };
  const qsKpi = (label, value, icon, tip, tone, onClick, hint) =>
    h(KpiCard, {label, value, icon, tooltip: tip, hint, tone: tone === 'bad' ? 'bad' : (tone === 'ok' || tone === 'good' ? 'good' : null), onClick});
  const summary = h('div', {className: 'qs-page'},
    h('div', {className: 'qs-kpis'},
      qsKpi('Queues', fmtNum(statsTotals.queues), 'fa-solid fa-layer-group', 'How many queues are in this comparison after search, site, and active filters.', null),
      qsKpi('Inactive queues', fmtNum(inactiveCount), 'fa-solid fa-moon', 'Queues with zero calls in this range. Hidden by default.', inactiveCount ? 'bad' : null),
      qsKpi('Total calls', fmtNum(statsTotals.calls), 'fa-solid fa-phone', 'Sum of queue CDR legs (call-through-user) across the filtered queues.', 'good'),
      qsKpi(
        'Missed SLA',
        fmtNum(statsTotals.slaMiss),
        'fa-solid fa-stopwatch',
        'Answered calls whose ring exceeded the SLA max-ring setting. Rate is missed ÷ answered. Pass requires SLA percent ≥ the domain passing rate (' + slaPass + '%). Click to open those calls.',
        slaMissRate <= (100 - slaPass) || !statsTotals.handled ? 'ok' : 'bad',
        () => openQueueCalls('sla_missed'),
        (statsTotals.handled ? slaMissRate.toFixed(1) : '0.0') + '% of answered'
      ),
      qsKpi(
        'Queues failed SLA',
        fmtNum(failedSlaQueues),
        'fa-solid fa-triangle-exclamation',
        'Queues with calls whose SLA rate is below the configured passing rate (' + slaPass + '%).',
        failedSlaQueues ? 'bad' : 'ok',
        () => openQueueCalls('sla_missed')
      )
    ),
    failedSlaQueues
      ? h('div', {className: 'qs-insight'},
          h('i', {className: 'fa-solid fa-triangle-exclamation', 'aria-hidden': 'true'}),
          h('span', null, failedSlaQueues + (failedSlaQueues === 1 ? ' queue is below the ' : ' queues are below the ') + slaPass + '% SLA passing rate.')
        )
      : null,
    h('div', {className: 'qs-toolbar'},
      h('input', {
        value: statsQuery,
        onChange: e => setStatsQuery(e.target.value),
        placeholder: 'Search queue name or extension…',
        className: 'min-w-0 flex-1 border border-slate-700 bg-slate-950 px-3 py-2 text-xs outline-none focus:border-cyan-400'
      }),
      h('select', {
        value: statsSite,
        onChange: e => setStatsSite(e.target.value),
        title: 'Filter by site',
        className: 'qs-site'
      },
        h('option', {value: ''}, 'All sites'),
        ...statsSites.map(site => h('option', {key: site, value: site}, site))
      ),
      h('button', {
        type: 'button',
        className: 'qs-site' + (hideInactive ? ' is-on' : ''),
        title: hideInactive ? 'Inactive queues are hidden. Click to show them.' : 'Hide queues with no calls in this range.',
        onClick: () => setHideInactive(v => !v)
      }, hideInactive ? 'Show inactive (' + inactiveCount + ')' : 'Hide inactive')
    ),
    h('section', {className: 'dash-card qs-card'},
    h('div', {className: 'dash-label'}, 'All queues', qHelp('Compare every queue. Click a number to open those calls. Click the queue name to open Overview.')),
    h('div', {className: 'qs-table-fit'},
      h('table', {className: 'q-table qs-table'},
        h('thead', null, h('tr', null,
          ...statsColumns.map(([field, lines, t, kind, width]) => {
            const active = statsSortKey === field;
            const arrow = active ? (statsSortDir === 'asc' ? ' ↑' : ' ↓') : '';
            const labelLines = Array.isArray(lines) ? lines : [lines];
            return h('th', {key: field, style: {width: width}, className: 'qs-th'},
              h('div', {className: 'qs-th-inner'},
                h('button', {type: 'button', className: 'qs-sort' + (active ? ' is-on' : ''), onClick: () => toggleStatsSort(field)},
                  ...labelLines.map((ln, i) => h('span', {key: i, className: 'qs-th-line'}, ln + (i === labelLines.length - 1 ? arrow : '')))
                ),
                h(Tooltip, {text: t}, h('span', {className: 'qs-i cursor-help', title: t}, 'i'))
              )
            );
          })
        )),
        h('tbody', null,
          statsSlice.length === 0
            ? h('tr', null, h('td', {colSpan: statsColumns.length, className: 'px-2 py-8 text-center text-xs text-slate-500'}, 'No queue stats.'))
            : statsSlice.map(q => {
                const sla = Number(q.sla || 0);
                const ab = Number(q.abandonRate || 0);
                const calls = Number(q.totalCalls || 0);
                const slaMiss = Number(q.slaMiss || 0);
                const abandoned = Number(q.abandoned || 0);
                const slaTone = calls > 0 ? (sla >= slaPass ? 'pass' : 'fail') : null;
                const abTone = Number(q.offered || 0) > 0 ? (ab > abLimit ? 'fail' : 'pass') : null;
                const flagged = slaTone === 'fail' || abTone === 'fail';
                return h('tr', {
                  key: q.callqueue,
                  className: 'qs-row' + (flagged ? ' is-flag' : '')
                },
                  h('td', {className: 'font-mono text-cyan-300 qs-num'}, q.callqueue),
                  h('td', {className: 'qs-qname'},
                    h('button', {
                      type: 'button',
                      className: 'qs-qbtn',
                      title: 'Open Overview for this queue',
                      onClick: () => { setSelected(q.callqueue); setTab('overview'); }
                    },
                      h('span', {className: 'qs-name'},
                        flagged ? h('i', {className: 'fa-solid fa-triangle-exclamation qs-warn'}) : null,
                        q.description || '—'
                      ),
                      h('span', {className: 'qs-site-sub'}, q.site || '—')
                    )
                  ),
                  numCell(q, 'totalCalls', fmtNum(q.totalCalls), 'total', null),
                  numCell(q, 'offered', fmtNum(q.offered), 'queue_offered', null),
                  numCell(q, 'handled', fmtNum(q.handled), 'answered', null),
                  numCell(q, 'slaMiss', fmtNum(slaMiss), 'sla_missed', slaTone),
                  numCell(q, 'sla', (q.sla ?? 0) + '%', 'sla_missed', slaTone),
                  numCell(q, 'abandoned', fmtNum(abandoned), 'abandoned', abTone),
                  numCell(q, 'abandonRate', (q.abandonRate ?? 0) + '%', 'abandoned', abTone),
                  numCell(q, 'avgRing', fmt(q.avgRing || 0), 'answered', null),
                  numCell(q, 'maxRing', fmt(q.maxRing || 0), 'answered', null),
                  numCell(q, 'avgTalk', fmt(q.avgTalk || 0), 'answered', null),
                  numCell(q, 'maxTalk', fmt(q.maxTalk || 0), 'answered', null),
                  numCell(q, 'totalTalk', fmt(q.totalTalk || 0), 'answered', null)
                );
              })
        )
      )
    ),
    h('div', {className: 'mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400'},
      h('div', {className: 'flex items-center gap-2'},
        'Rows per page:',
        h('select', {
          value: statsSize,
          onChange: e => { setStatsSize(Number(e.target.value)); setStatsPage(1); },
          className: 'cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs'
        },
          h('option', {value: 10}, '10'),
          h('option', {value: 25}, '25'),
          h('option', {value: 50}, '50'),
          h('option', {value: 100}, '100')
        )
      ),
      h('div', {className: 'flex gap-1'},
        h('button', {type: 'button', disabled: safeStats <= 1, onClick: () => setStatsPage(p => Math.max(1, p - 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Prev'),
        h('span', {className: 'px-2 py-1'}, 'Page ' + safeStats + ' of ' + statsPages),
        h('button', {type: 'button', disabled: safeStats >= statsPages, onClick: () => setStatsPage(p => Math.min(statsPages, p + 1)), className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 disabled:opacity-40'}, 'Next')
      )
    )
  )
  );

  const isStats = tab === 'summary';
  const headTitle = isStats ? 'Comparing all queues' : title;
  const headSub = isStats
    ? 'SLA, abandon, and handle time across every queue. Click a row to open Overview for that queue.'
    : null;

  return h('div', {className: 'queue-layout' + (isStats ? ' is-stats' : '')},
    isStats ? null : h('aside', {className: 'queue-side' + (sideCollapsed ? ' is-collapsed' : '')},
      h('div', {className: 'aa-side-head'},
        sideCollapsed ? null : h('h2', {className: 'text-sm font-semibold text-slate-100'}, 'Queues'),
        h('button', {
          type: 'button',
          title: sideCollapsed ? 'Expand queues' : 'Collapse queues',
          onClick: () => setSideCollapsed(c => !c),
          className: 'aa-side-toggle'
        }, sideCollapsed ? '›' : '‹')
      ),
      sideCollapsed ? null : h('div', {className: 'px-3 pb-1 text-[10px] text-slate-500'}, 'Select one'),
      sideCollapsed ? null : h('input', {
        value: term,
        onChange: e => setTerm(e.target.value),
        placeholder: 'Find queue or site…',
        className: 'aa-side-search'
      }),
      h('div', {className: 'queue-side-list'},
        loading && !queues.length
          ? Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'mb-2 px-2'},
              h('div', {className: 'skeleton-shimmer h-10 rounded'})))
          : visible.map(q => {
              const label = q.description || q.callqueue;
              return h('button', {
                key: q.callqueue,
                type: 'button',
                title: label + ' · ' + (q.waiting || 0) + ' waiting',
                onClick: () => setSelected(q.callqueue),
                className: 'queue-row ' + (selected === q.callqueue ? 'is-active' : '')
              },
                sideCollapsed
                  ? h('span', {className: 'aa-side-glyph'}, String(label).slice(0, 1).toUpperCase())
                  : h('span', {className: 'q-dot ' + (q.dot || 'ok')}),
                sideCollapsed ? null : h('span', {className: 'min-w-0 flex-1'},
                  h('span', {className: 'block truncate text-slate-100'}, label),
                  h('span', {className: 'block text-[10px] text-slate-500'}, q.callqueue + (q.site ? ' · ' + q.site : ''))
                )
              );
            })
      )
    ),
    h('div', {className: 'queue-main'},
      h('div', {className:'aa-tabs mb-3'},
        ...[['summary', 'Queue stats', 'Compare every queue: SLA, abandon, ring and talk.'], ['overview', 'Overview', 'Live KPIs, roster, and recent calls for the selected queue.']].map(([id, lab, t]) =>
          h('button', {
            key: id,
            type: 'button',
            title: t,
            onClick: () => setTab(id),
            className: 'aa-tab' + (tab === id ? ' is-on' : '')
          }, lab)
        )
      ),
      h('div', {className: 'mb-2 flex flex-wrap items-start justify-between gap-2'},
        h('div', null,
          h('h1', {className: 'text-sm font-semibold text-slate-100'}, headTitle),
          headSub ? h('p', {className: 'mt-0.5 text-[10px] text-slate-500'}, headSub) : null
        ),
        h('div', {className: 'flex items-center gap-2'},
          h(SlaControl, {value: slaSeconds, onChange: onSlaChange}),
          h('button', {
            type: 'button',
            onClick: exportCsv,
            className: 'cursor-pointer rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300'
          }, 'Export CSV')
        )
      ),
      error ? h(ErrorState, {message: error, onRetry: () => setReload(n => n + 1), className: 'mb-2'}) : null,
      loading && !data ? skeletonMain : (tab === 'summary' ? summary : overview)
    )
  );
}

export { QueueDashboard };
