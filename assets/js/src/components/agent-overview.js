/* The per-agent overview: KPIs, volume charts, recent calls.
 *
 * Split out of the single-file assets/js/src/app.js by
 * tools/split-js-file.mjs, then out of components/agents.js when that file
 * reached four views in one. Every function body below is byte-identical to the
 * original — the split is verified by hashing the declaration before and after
 * (see CHANGES.md, QA round 2). */

import { api } from '../lib/api.js';
import { fmt, fmtNum, formatPhoneNumber } from '../lib/format.js';
import { h, keyActivate, useEffect, useRef, useState } from '../lib/react.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';
import { KpiCard, splineArea } from './charts.js';
import { CallTypeIcon, skel } from './ui.js';

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
  const mb = summary.missedBreakdown || {};
  /*
   * One missed definition for the whole screen (includes/reporting/outcomes.php):
   * missed = missed + abandoned, abandon is a subset of it, and offered
   * inbound is inbound + missed. When an agent is open the numbers come from
   * that agent (agent.mc / agent.ab); otherwise they fall back to the
   * dashboard summary, so this card can never mix an agent's misses with
   * somebody else's abandons.
   */
  const abandonedCount = agent ? Number(agent.ab || 0) : Number(mb.abandon || 0);
  const missed = agent
    ? Number(agent.mc || 0) + abandonedCount
    : Number(counts.missed || 0);
  const inbound = Number((agent && agent.ib) || counts.inbound || 0);
  const offered = inbound + missed;
  const abandon = offered ? (abandonedCount / offered) * 100 : 0;
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
        h(KpiCard, {label: 'Abandon rate', value: abandon.toFixed(1) + '%', icon: 'fa-solid fa-person-walking-dashed-line-arrow-right', tone: 'bad', hint: fmtNum(abandonedCount) + ' calls', tooltip: 'Abandoned calls ÷ offered inbound (inbound + missed). Same abandoned rule and denominator as the Dashboard and Queues. Click to open abandoned calls.', onClick: () => open('missed_abandon')}),
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
                  /*
                   * A recent-call row IS a call, so it opens that call —
                   * not "every call of that type for this agent", which is
                   * what it used to do (the row's own identity was dropped).
                   */
                  : actSlice.map((c, i) => h('tr', {
                      key: i,
                      tabIndex: 0,
                      className: 'cursor-pointer hover:bg-slate-800/60',
                      title: 'Open this call',
                      onClick: () => open('total', c.id ? { callId: c.id } : null),
                      onKeyDown: keyActivate(() => open('total', c.id ? { callId: c.id } : null))
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

export { AgentOverview };
