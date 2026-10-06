/* Operations dashboard: KPIs, volume chart, agent podium, SLA control.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { splineArea } from './charts.js';
import { SlaControl, Tooltip, skelPanel } from './ui.js';
import { fmt, fmtNum } from '../lib/format.js';
import { h, useEffect, useRef, useState } from '../lib/react.js';

function OverviewDashboard({loading, report, filters, inventory, inventoryReady, slaSeconds, onSlaChange, onMetric, onHourClick, onDayClick, onAgentClick, onNavigate, allowedRoutes, topAgentQual}) {
  const canvas = useRef(null);
  const chart = useRef(null);
  const ready = inventoryReady || {};
  /* 'inbound' = most inbound calls, 'aht' = lowest inbound AHT. */
  const [agentRank, setAgentRank] = useState('inbound');
  const C = {good:'#35D0A0', outbound:'#7C93F8', onnet:'#B98CE0', warn:'#F5A83C', bad:'#F0555A', dim:'#8892A0'};

  const hoursNow = report?.summary?.hours || [];
  const hoursPrev = report?.comparison?.previous?.hours || report?.summary?.prevHours || [];

  useEffect(() => {
    if (!report || !canvas.current) return;
    chart.current?.destroy();
    const prev = Array.isArray(hoursPrev) && hoursPrev.length === 24 ? hoursPrev : null;
    /*
     * Smooth area (spline) rather than bars. The vertical gradient keeps
     * the fill from swamping the gridlines while the curve still reads
     * as a continuous 24h trend.
     */
    const datasets = [splineArea(canvas.current, C.good, hoursNow, {
      label: 'This period'
    })];
    if (prev) {
      /* Dashed + greyed so the comparison never competes with current. */
      datasets.unshift(splineArea(canvas.current, C.dim, prev, {
        label: 'Previous period',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointHoverRadius: 3
      }));
    }
    chart.current = new Chart(canvas.current, {
      type: 'line',
      data: {
        labels: Array.from({length:24}, (_,i) => String(i).padStart(2,'0')),
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        /*
         * intersect:false — on a line chart the bar-style hit test would
         * force the cursor onto the 2px stroke itself. Nearest-by-index
         * keeps hover and click usable across the whole column.
         */
        interaction: {mode:'index', intersect: false},
        onClick: (event, elements) => {
          if (!elements?.length) return;
          onHourClick && onHourClick(elements[0].index);
        },
        onHover: (event, elements) => {
          const t = event?.native?.target;
          if (t) t.style.cursor = elements?.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: {
            display: !!prev,
            position: 'top',
            align: 'end',
            labels: {color: C.dim, boxWidth: 10, font: {size: 11}}
          },
          tooltip: {
            callbacks: {
              title: items => {
                if (!items.length) return '';
                const hour = items[0].dataIndex;
                return String(hour).padStart(2,'0') + ':00–' + String(hour).padStart(2,'0') + ':59';
              },
              label: item => ' ' + item.dataset.label + ': ' + Number(item.raw).toLocaleString()
            }
          }
        },
        scales: {
          x: {grid: {color: 'rgba(148,163,184,0.15)'}, ticks: {color: '#94a3b8', maxRotation: 0}},
          y: {beginAtZero: true, grid: {color: 'rgba(148,163,184,0.15)'}, ticks: {color: '#94a3b8', precision: 0}}
        }
      }
    });
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [report, onHourClick]);

  const reportReady = !loading && !!report;
  if (!loading && !report) {
    return h('main', {className:'ops-dash'},
      h('div', {className:'ops-card text-rose-300'}, 'No data could be loaded.')
    );
  }

  const c = report?.summary?.counts || {};
  const inbound = report?.summary?.inbound || {};
  const sl = report?.summary?.serviceLevel || {};
  const mb = report?.summary?.missedBreakdown || {};
  /* Sprint A: the wait bands, the hold nobody used to see, and the links layer
   * (transfers, returned calls, repeat callers). */
  const waitBuckets = report?.summary?.waitBuckets || {};
  const missedWaitBuckets = report?.summary?.missedWaitBuckets || {};
  const abandonWaitBuckets = report?.summary?.abandonWaitBuckets || {};
  const hold = report?.summary?.hold || {};
  const links = report?.links || null;
  const waitTotal = Object.values(waitBuckets).reduce((a, b) => a + Number(b || 0), 0);
  const prevCounts = report?.comparison?.previous?.counts || {};
  /* True between phase 1 painting and phase 2 landing. */
  const comparisonPending = report?.comparison?.pending === true;
  const total = Number(c.total || 0);
  const missed = Number(c.missed || 0);
  const inboundCount = Number(c.inbound || 0);
  const outboundCount = Number(c.outbound || 0);
  const onnetCount = Number(c.onnet || 0);
  const incoming = inboundCount + missed;
  const answerRate = incoming ? (inboundCount / incoming) * 100 : 0;
  const abandonCount = Number(mb.abandon || 0);
  const abandonRate = incoming ? (abandonCount / incoming) * 100 : 0;
  const slaVal = Number(sl.sla20 || 0);
  const inv = inventory || {};
  const numEnabled = Number(inv.enabledNumbers || 0);
  const pctDelta = (now, old) => {
    const a = Number(now || 0);
    const b = Number(old || 0);
    if (!b) return a ? 100 : 0;
    return ((a - b) / b) * 100;
  };
  const prevOffered = Number(prevCounts.inbound || 0) + Number(prevCounts.missed || 0);
  const prevAnswerRate = prevOffered ? (Number(prevCounts.inbound || 0) / prevOffered) * 100 : 0;
  const totalDelta = pctDelta(total, prevCounts.total);

  const mix = [
    {label:'Inbound', value: inboundCount, color: C.good, metric:'inbound'},
    {label:'Outbound', value: outboundCount, color: C.outbound, metric:'outbound'},
    {label:'On-net', value: onnetCount, color: C.onnet, metric:'onnet'},
    {label:'Missed', value: missed, color: C.bad, metric:'missed'}
  ];
  const mixTotal = mix.reduce((a, x) => a + Number(x.value || 0), 0);

  const exportOverviewCsv = () => {
    const prevStart = report?.comparison?.previous?.start || '';
    const prevEnd = report?.comparison?.previous?.end || '';
    const rows = [
      ['metric', 'current', 'previous', 'delta_pct'],
      ['inbound', inboundCount, prevCounts.inbound || 0, pctDelta(inboundCount, prevCounts.inbound).toFixed(1)],
      ['missed', missed, prevCounts.missed || 0, pctDelta(missed, prevCounts.missed).toFixed(1)],
      ['answer_rate', answerRate.toFixed(1), prevAnswerRate.toFixed(1), (answerRate - prevAnswerRate).toFixed(1)],
      ['outbound', outboundCount, prevCounts.outbound || 0, pctDelta(c.outbound, prevCounts.outbound).toFixed(1)],
      ['total', total, prevCounts.total || 0, totalDelta.toFixed(1)],
      ['sla_20s', sl.sla20 || 0, '', ''],
      ['p50_ring', sl.p50Ring || 0, '', ''],
      ['p90_ring', sl.p90Ring || 0, '', ''],
      ['missed_noanswer', mb.noanswer || 0, '', ''],
      ['missed_voicemail', mb.voicemail || 0, '', ''],
      ['missed_abandon', mb.abandon || 0, '', ''],
      ['previous_range', prevStart, prevEnd, '']
    ];
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dashboard-' + (filters.start || '') + '-' + (filters.end || '') + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  /*
   * Top agents ranking.
   *
   * Two modes: most inbound calls, or lowest inbound AHT. AHT mode only
   * considers agents who actually took inbound calls — ibAht is 0 for an
   * agent with no inbound, which would otherwise sort them to the top as
   * "fastest" when they simply never answered anything.
   */
  /*
   * Prefer agentPerformance: it is the full, unclipped agent list and is
   * the canonical source of `ib` / `ibAht`. `topAgents` is a convenience
   * projection that the server pre-sorts by TOTAL calls and clips to 10,
   * so ranking by lowest AHT against it would only ever consider the ten
   * busiest agents — the fastest agent could be ranked 11th by volume and
   * never appear. topAgents remains the fallback for older payloads.
   */
  const agentPool = (Array.isArray(report?.agentPerformance) && report.agentPerformance.length)
    ? report.agentPerformance
    : (report?.topAgents || []);
  /* Tolerate both vocabularies: agentPerformance uses ib/ibAht. */
  const inboundOf = a => Number(a.ib ?? a.inbound ?? 0);
  const ahtOf = a => Number(a.ibAht ?? a.aht ?? 0);

  /*
   * AHT qualification (Settings -> Top agent qualification).
   *
   * An agent only qualifies for the AHT podium when they are BOTH fast
   * enough and busy enough:
   *
   *   AHT   <  topAgentAhtMinutes   (minutes -> seconds)
   *   inbound >  topAgentMinCalls
   *
   * Without the volume floor a single lucky 12-second call outranks an
   * agent who handled 300, so the medal would reward luck over work.
   * Non-qualifiers are still listed, ranked below and visually muted,
   * so the card never looks empty on a quiet range.
   */
  const qualAhtSeconds = Math.max(0, Number(topAgentQual?.ahtMinutes ?? 0)) * 60;
  const qualMinCalls = Math.max(0, Number(topAgentQual?.minCalls ?? 0));
  const qualifies = a =>
    inboundOf(a) > 0 &&
    ahtOf(a) > 0 &&
    (qualAhtSeconds <= 0 || ahtOf(a) < qualAhtSeconds) &&
    inboundOf(a) > qualMinCalls;

  const byAht = (a, b) => ahtOf(a) - ahtOf(b) || inboundOf(b) - inboundOf(a);

  const topAgents = (agentRank === 'aht'
    ? (() => {
        const eligible = agentPool.filter(a => inboundOf(a) > 0 && ahtOf(a) > 0);
        const pass = eligible.filter(qualifies).sort(byAht);
        const fail = eligible.filter(a => !qualifies(a)).sort(byAht);
        /* Qualifiers first, everyone else beneath them. */
        return pass.concat(fail);
      })()
    : agentPool
        .slice()
        .sort((a, b) => inboundOf(b) - inboundOf(a) || ahtOf(a) - ahtOf(b))
  ).slice(0, 8);

  /* Index of the first non-qualifier, for the divider in AHT mode. */
  const qualifiedCount = agentRank === 'aht'
    ? topAgents.filter(qualifies).length
    : topAgents.length;

  const maxInbound = Math.max(1, ...topAgents.map(inboundOf));
  /*
   * AHT bars are relative within the visible set: the fastest agent
   * fills the bar and the slowest keeps a visible stub, so the bar reads
   * as a ranking rather than an absolute scale against an arbitrary max.
   */
  const ahtValues = topAgents.map(ahtOf).filter(v => v > 0);
  const ahtFloor = ahtValues.length ? Math.min(...ahtValues) : 0;
  const ahtCeil = ahtValues.length ? Math.max(...ahtValues) : 0;
  const ahtSpan = (ahtCeil - ahtFloor) / 0.85 || 0;

  const qHelp = text => h(Tooltip, {text}, h('span', {className:'cursor-help border-b border-dotted border-slate-600 text-[10px] font-normal text-slate-500'}, '?'));

  const ringMeter = (pct, color) => {
    const r = 17, circ = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const dash = (p / 100) * circ;
    return h('div', {className: 'ops-ring'},
      h('svg', {width: 44, height: 44, viewBox: '0 0 44 44', 'aria-hidden': 'true'},
        h('circle', {cx: 22, cy: 22, r, fill: 'none', stroke: 'currentColor', strokeWidth: 5, className: 'text-slate-800'}),
        p > 0 ? h('circle', {
          cx: 22, cy: 22, r, fill: 'none', stroke: color, strokeWidth: 5,
          strokeLinecap: 'round',
          strokeDasharray: dash + ' ' + circ,
          transform: 'rotate(-90 22 22)'
        }) : null
      ),
      h('span', {className: 'ops-ring-txt', style: {color}}, Math.round(p) + '%')
    );
  };

  const days = report?.summary?.days || {};
  const dayList = [];
  const nextYmd = ymd => {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return dt.toISOString().slice(0, 10);
  };
  for (let d = filters.start; d && filters.end && d <= filters.end; d = nextYmd(d)) dayList.push(d);
  const dayMax = Math.max(1, ...dayList.map(d => Number(days[d] || 0)), 1);

  const sparkline = (values) => {
    const w = 320, ht = 56;
    const vals = (values || []).map(Number);
    if (!vals.length) return null;
    const max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = ht - (v / max) * (ht - 6) - 2;
      return [x, y];
    });
    const line = pts.map(pt => pt[0] + ',' + pt[1]).join(' ');
    const area = 'M0,' + ht + ' L' + pts.map(pt => pt[0] + ',' + pt[1]).join(' L') + ' L' + w + ',' + ht + ' Z';
    return h('svg', {className: 'ops-spark', viewBox: '0 0 ' + w + ' ' + ht, preserveAspectRatio: 'none', 'aria-hidden': 'true'},
      h('path', {d: area, fill: 'rgba(53,208,160,0.16)'}),
      h('polyline', {points: line, fill: 'none', stroke: C.good, strokeWidth: 1.8, strokeLinejoin: 'round', strokeLinecap: 'round'})
    );
  };

  let insight = null;
  if (reportReady && incoming) {
    if (slaVal < 80) {
      insight = {
        bad: true,
        title: 'Service level is ' + slaVal.toFixed(1) + '% — below 80%',
        body: fmtNum(sl.answeredIn20 || 0) + ' of ' + fmtNum(sl.offered || incoming) + ' offered inbound were answered within ' + (slaSeconds || sl.slaSeconds || 20) + ' seconds.',
        link: 'Open SLA misses',
        metric: 'sla_missed'
      };
    } else if (abandonRate >= 8) {
      insight = {
        bad: true,
        title: 'Abandon rate is ' + abandonRate.toFixed(1) + '%',
        body: fmtNum(abandonCount) + ' callers hung up before an agent answered.',
        link: 'Open abandoned calls',
        metric: 'missed_abandon'
      };
    } else if (!comparisonPending && pctDelta(missed, prevCounts.missed) > 15 && missed > 0) {
      insight = {
        bad: false,
        title: 'Missed calls are up ' + pctDelta(missed, prevCounts.missed).toFixed(1) + '% vs last period',
        body: fmtNum(missed) + ' missed this range versus ' + fmtNum(prevCounts.missed || 0) + ' previously.',
        link: 'Open missed calls',
        metric: 'missed'
      };
    }
  }

  const initials = name => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '•';
    return ((parts[0][0] || '') + (parts[1] ? parts[1][0] : '')).toUpperCase();
  };

  const pulse = skelPanel('h-32');

  const sysTile = ({label, value, hint, tip, icon, chip, routeId}) => {
    const can = (allowedRoutes || []).includes(routeId);
    return h('button', {
      type: 'button',
      className: 'ops-sys-btn',
      disabled: !can,
      title: tip,
      onClick: can ? () => onNavigate && onNavigate(routeId) : undefined
    },
      h('span', {className: 'ops-sys-chip ' + chip, 'aria-hidden': 'true'}, h('i', {className: icon})),
      h('span', {className: 'min-w-0'},
        h('span', {className: 'ops-sys-k flex items-center gap-1'}, label, qHelp(tip)),
        h('span', {className: 'ops-sys-n block'}, value),
        h('span', {className: 'ops-sys-h block truncate'}, hint)
      )
    );
  };

  return h('main', {className:'ops-dash'},
    h('div', {className:'ops-head'},
      h('div', null,
        h('h1', {className:'ops-title'}, 'Operations overview'),
        h('p', {className:'ops-sub'}, 'Scan for missed calls, SLA breaches, and agent load. Compare to the previous period of the same length.')
      ),
      h('div', {className:'flex shrink-0 items-center gap-2'},
        h(SlaControl, {value: slaSeconds, onChange: onSlaChange}),
        reportReady ? h('button', {
          type:'button',
          onClick: exportOverviewCsv,
          className:'cursor-pointer rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-cyan-500 hover:text-cyan-300'
        }, 'Export CSV') : null
      )
    ),

    insight ? h('div', {className: 'ops-insight' + (insight.bad ? ' is-bad' : '')},
      h('div', null,
        h('div', {className:'ops-insight-kicker'}, 'Needs attention'),
        h('div', {className:'ops-insight-title'}, insight.title),
        h('div', {className:'ops-insight-body'}, insight.body),
        h('button', {type:'button', className:'ops-insight-link cursor-pointer', onClick: () => onMetric && onMetric(insight.metric)}, insight.link + ' →')
      )
    ) : null,

    h('div', {className:'ops-top'},
      reportReady
        ? h('section', {className:'ops-card'},
            h('div', {className:'ops-total-k flex items-center gap-1'}, 'Total calls', qHelp('All calls in the selected range. Click the number to open the call list. Delta is versus the previous period of the same length (' + fmtNum(prevCounts.total || 0) + ').')),
            h('div', {className:'ops-total-h'}, 'All directions · selected range'),
            h('button', {type:'button', className:'ops-total-n', onClick: () => onMetric && onMetric('total')}, fmtNum(total)),
            /*
             * While the comparison request is still in flight there is
             * no previous period to divide by — showing a delta here
             * would invent a -100% swing out of missing data.
             */
            comparisonPending
              ? h('div', {className: 'ops-total-delta is-flat'}, 'Comparing to last period…')
              : h('div', {className: 'ops-total-delta ' + (Math.abs(totalDelta) < 0.05 ? 'is-flat' : (totalDelta > 0 ? 'is-up' : 'is-down'))},
                  (totalDelta > 0 ? '▲ ' : (totalDelta < 0 ? '▼ ' : '')) +
                  Math.abs(totalDelta).toFixed(1) + '% vs last period (' + fmtNum(prevCounts.total || 0) + ')'
                ),
            sparkline(dayList.map(d => Number(days[d] || 0)))
          )
        : pulse,
      reportReady
        ? h('section', {className:'ops-card'},
            h('div', {className:'ops-label'}, 'Call mix', qHelp('Share of inbound, outbound, on-net and missed volume. Zero categories stay empty on the bar. Click a legend row to open those calls.')),
            h('div', {className:'ops-mix-summary'},
              fmtNum(inboundCount) + ' inbound · ' + fmtNum(outboundCount) + ' outbound · ' +
              fmtNum(missed) + ' missed · ' + fmtNum(onnetCount) + ' on-net'
            ),
            h('div', {className:'ops-mix-bar'},
              mixTotal
                ? mix.filter(x => x.value > 0).map(x => h('div', {
                    key: x.label,
                    className: 'ops-mix-seg',
                    title: x.label + ' ' + fmtNum(x.value),
                    style: {width: ((x.value / mixTotal) * 100) + '%', background: x.color}
                  }))
                : null
            ),
            h('div', {className:'ops-mix-legend'},
              ...mix.map(x => h('button', {
                key: x.label,
                type: 'button',
                className: 'ops-mix-row',
                onClick: () => onMetric && onMetric(x.metric)
              },
                h('span', {className:'ops-dot', style:{background: x.color}}),
                h('span', {className:'ops-mix-name'}, x.label),
                h('span', {className:'ops-mix-val'}, fmtNum(x.value)),
                h('span', {className:'ops-mix-pct'}, (mixTotal ? ((x.value / mixTotal) * 100).toFixed(1) : '0.0') + '%')
              ))
            )
          )
        : pulse,
      reportReady
        ? h('section', {className:'ops-card'},
            h('div', {className:'ops-label'}, 'Rates', qHelp('Offered = inbound answered + missed calls. Answer rate is answered inbound ÷ offered. Abandon rate is callers who reached a queue or the auto attendant and hung up before an agent answered ÷ offered — the same abandoned definition every other report uses. Service level is offered inbound answered within the SLA ring setting. Click a row to open related calls.')),
            h('div', {className:'ops-hint'}, 'Answer, abandon & SLA'),
            h('button', {type:'button', className:'ops-rate-row w-full text-left', onClick: () => onMetric && onMetric('inbound')},
              ringMeter(answerRate, answerRate >= 85 ? C.good : (answerRate >= 70 ? C.warn : C.bad)),
              h('div', null,
                h('div', {className:'ops-rate-k'}, 'Answer rate'),
                h('div', {className:'ops-rate-h'}, fmtNum(inboundCount) + ' of ' + fmtNum(incoming) + ' offered')
              )
            ),
            h('button', {type:'button', className:'ops-rate-row w-full text-left', onClick: () => onMetric && onMetric('missed_abandon')},
              ringMeter(abandonRate, abandonRate >= 8 ? C.bad : C.dim),
              h('div', null,
                h('div', {className:'ops-rate-k'}, 'Abandon rate'),
                h('div', {className:'ops-rate-h'}, fmtNum(abandonCount) + ' calls')
              )
            ),
            h('button', {type:'button', className:'ops-rate-row w-full text-left', onClick: () => onMetric && onMetric('sla_missed')},
              ringMeter(slaVal, slaVal >= 80 ? C.good : C.bad),
              h('div', null,
                h('div', {className:'ops-rate-k'}, 'Service level'),
                h('div', {className:'ops-rate-h'}, 'answered ≤' + (slaSeconds || sl.slaSeconds || 20) + 's')
              )
            )
          )
        : pulse
    ),

    h('div', {className:'ops-split'},
      reportReady
        ? h('section', {className:'ops-card ops-wait'},
            h('div', {className:'ops-label'}, 'How long callers waited', qHelp('Every answered inbound call, banded by how long it rang before somebody picked up. p50 is the middle caller and p90 the slow tenth — the numbers a manager quotes, computed with the same percentile method as a spreadsheet (PERCENTILE.INC). Click a band to open exactly those calls.')),
            h('div', {className:'ops-wait-head'},
              h('div', {className:'ops-wait-stat'},
                h('span', {className:'ops-wait-k'}, 'p50 wait'),
                h('span', {className:'ops-wait-v'}, (sl.p50Wait || 0) + 's')
              ),
              h('div', {className:'ops-wait-stat'},
                h('span', {className:'ops-wait-k'}, 'p90 wait'),
                h('span', {className:'ops-wait-v'}, (sl.p90Wait || 0) + 's')
              ),
              h('div', {className:'ops-wait-stat'},
                h('span', {className:'ops-wait-k'}, 'Hold'),
                h('span', {className:'ops-wait-v'}, (hold.totalSeconds ? Math.round(hold.totalSeconds / 60) + 'm' : '0m')),
                h('span', {className:'ops-wait-hint'}, fmtNum(hold.calls || 0) + ' calls held')
              ),
              h('div', {className:'ops-wait-stat'},
                h('span', {className:'ops-wait-k'}, 'In SLA'),
                h('span', {className:'ops-wait-v'}, (sl.sla || 0) + '%'),
                h('span', {className:'ops-wait-hint'},
                  sl.perQueue
                    ? 'per queue, avg target ' + (sl.avgTargetSeconds || sl.slaSeconds || 20) + 's'
                    : 'within ' + (sl.slaSeconds || slaSeconds || 20) + 's')
              )
            ),
            h('div', {className:'ops-wait-bars'},
              ...[['0-30', 'under 30s', C.good], ['31-60', '31–60s', C.warn], ['61-120', '61–120s', C.warn], ['120+', 'over 120s', C.bad]].map(([band, label, color]) => {
                const value = Number(waitBuckets[band] || 0);
                const pct = waitTotal ? (value / waitTotal) * 100 : 0;
                return h('button', {
                  key: band,
                  type: 'button',
                  className: 'ops-wait-row',
                  title: value + ' call(s) waited ' + label,
                  onClick: () => onMetric && onMetric('inbound', { waitBucket: band })
                },
                  h('span', {className:'ops-wait-name'}, label),
                  h('span', {className:'ops-wait-track'},
                    h('span', {className:'ops-wait-fill', style:{width: pct.toFixed(1) + '%', background: color}})
                  ),
                  h('span', {className:'ops-wait-val'}, fmtNum(value)),
                  h('span', {className:'ops-wait-pct'}, pct.toFixed(0) + '%')
                );
              })
            ),
            h('div', {className:'ops-hint'},
              'Abandons by how long the caller waited: ' +
              fmtNum(abandonWaitBuckets.lt5 || 0) + ' under 5s (usually misdials) · ' +
              fmtNum(abandonWaitBuckets['5-30'] || 0) + ' 5–30s · ' +
              fmtNum(abandonWaitBuckets.gt30 || 0) + ' over 30s (a staffing failure)'
            )
          )
        : pulse,
      reportReady && links
        ? h('section', {className:'ops-card ops-links'},
            h('div', {className:'ops-label'}, 'Follow-ups', qHelp('Transfers: how often a call was handed to a different agent (a call routed through three agents counts as two hand-offs but one transferred call). Callbacks: missed calls an outbound call to the same number came after, within 24 hours — matched on the customer number, so a return call from a softphone counts. Repeat callers: the same number calling in twice or more.')),
            h('button', {type:'button', className:'ops-link-row', title: 'Open the calls that were not returned',
              onClick: () => onMetric && onMetric('inbound', { callbackState: 'unreturned' })
            },
              h('span', {className:'ops-link-k'}, 'Missed calls not returned'),
              h('span', {className:'ops-link-v'}, fmtNum(links.callbacks?.unreturned || 0)),
              h('span', {className:'ops-link-h'}, (links.callbacks?.ratePct || 0) + '% of ' + fmtNum(links.callbacks?.missed || 0) + ' were')
            ),
            h('button', {type:'button', className:'ops-link-row', title: 'Open the returned calls',
              onClick: () => onMetric && onMetric('inbound', { callbackState: 'returned' })
            },
              h('span', {className:'ops-link-k'}, 'Returned within 24h'),
              h('span', {className:'ops-link-v'}, fmtNum(links.callbacks?.returned || 0)),
              h('span', {className:'ops-link-h'},
                links.callbacks?.avgReturnSeconds
                  ? 'avg back in ' + Math.round(links.callbacks.avgReturnSeconds / 60) + ' min'
                  : 'none yet')
            ),
            h('div', {className:'ops-link-row is-static'},
              h('span', {className:'ops-link-k'}, 'Transfer rate'),
              h('span', {className:'ops-link-v'}, (links.transfers?.ratePct || 0) + '%'),
              h('span', {className:'ops-link-h'},
                fmtNum(links.transfers?.count || 0) + ' hand-offs in ' + fmtNum(links.transfers?.handled || 0) + ' handled')
            ),
            h('div', {className:'ops-link-row is-static'},
              h('span', {className:'ops-link-k'}, 'Repeat callers (24h)'),
              h('span', {className:'ops-link-v'}, (links.repeat?.rate24Pct || 0) + '%'),
              h('span', {className:'ops-link-h'},
                fmtNum(links.repeat?.repeat24 || 0) + ' of ' + fmtNum(links.repeat?.callers || 0) + ' callers')
            ),
            (links.transfers?.agentPairs || []).length
              ? h('div', {className:'ops-link-pairs'},
                  h('div', {className:'ops-hint'}, 'Most common hand-offs'),
                  ...links.transfers.agentPairs.slice(0, 3).map((pair, i) =>
                    h('div', {key: i, className:'ops-link-pair'},
                      h('span', null, pair.from + ' → ' + pair.to),
                      h('span', {className:'ops-link-v'}, fmtNum(pair.count))
                    ))
                )
              : h('div', {className:'ops-hint'}, 'No transfers in this period.')
          )
        : pulse
    ),

    h('div', {className:'ops-split'},
      reportReady
        ? h('section', {className:'ops-card ops-hour'},
            h('div', {className:'ops-label'}, 'Call volume by hour', qHelp('Calls started in each hour, summed across the range. Ghost bars are the previous period when present. Click a bar to open those calls.')),
            h('div', {className:'ops-hint'},
              hoursPrev && hoursPrev.length === 24
                ? 'This period vs previous period. Click a bar to open those calls.'
                : 'Click a bar to open those calls. Previous-period hourly data is not in this report — totals still compare above.'
            ),
            h('div', {className:'ops-hour-chart cursor-pointer'}, h('canvas', {ref: canvas}))
          )
        : h('section', {className:'ops-card'}, pulse),
      h('section', {className:'ops-card'},
        h('div', {className:'ops-label'}, 'Top agents', qHelp(
          agentRank === 'aht'
            ? 'Ranked by lowest inbound AHT (fastest handling). Agents with no inbound calls are excluded — a zero AHT means "never answered", not "instant". Click a row to open that agent’s overview for this date range.'
            : 'Ranked by highest inbound volume. Bar length is relative to the top agent. Click a row to open that agent’s overview for this date range.'
        )),
        /*
         * Rank toggle. Two different questions get asked of this card:
         * "who is carrying the load" (volume) and "who is fastest"
         * (AHT), so it is a switch rather than two separate cards.
         */
        h('div', {className:'ops-rank-tabs', role:'group', 'aria-label':'Rank top agents by'},
          [['inbound', 'Most inbound'], ['aht', 'Lowest AHT']].map(([id, label]) =>
            h('button', {
              key: id,
              type: 'button',
              className: 'ops-rank-tab' + (agentRank === id ? ' is-on' : ''),
              'aria-pressed': agentRank === id,
              onClick: () => setAgentRank(id)
            }, label)
          )
        ),
        h('div', {className:'ops-hint'}, agentRank === 'aht'
          ? 'Fastest inbound handling this range.'
          : 'Highest inbound volume this range.'),
        !reportReady
          ? pulse
          : (topAgents.length === 0
              ? h('div', {className:'px-1 py-8 text-center text-xs text-slate-500'},
                  agentRank === 'aht' ? 'No agents handled inbound calls in this range.' : 'No agent data available.')
              : topAgents.map((agent, index) => {
                  const inbound = Number(agent.ib ?? agent.inbound ?? 0);
                  const aht = Number(agent.ibAht ?? agent.aht ?? 0);
                  const name = agent.name || agent.extension || 'Agent';
                  /* Bar tracks whichever metric is being ranked on. */
                  const barPct = agentRank === 'aht'
                    ? (ahtSpan > 0 ? (1 - ((aht - ahtFloor) / ahtSpan)) * 100 : 100)
                    : (maxInbound ? (inbound / maxInbound) * 100 : 0);
                  /*
                   * In AHT mode a medal means "qualified AND on the
                   * podium" — an unqualified agent must never be gold
                   * just because everyone above them was filtered out.
                   */
                  const ok = agentRank !== 'aht' || qualifies(agent);
                  const medal = !ok ? ''
                    : (index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '');
                  const why = ok ? '' :
                    (aht >= qualAhtSeconds && qualAhtSeconds > 0
                      ? 'AHT ' + fmt(aht) + ' is not under ' + (qualAhtSeconds / 60) + ' min'
                      : 'Only ' + fmtNum(inbound) + ' inbound, needs more than ' + fmtNum(qualMinCalls));
                  const row = h('button', {
                    key: agent.extension || name,
                    type: 'button',
                    className: 'ops-agent-row' + (medal ? ' is-' + medal : '') + (ok ? '' : ' is-unqualified'),
                    title: ok
                      ? 'Open ' + name + '’s overview for this date range'
                      : name + ' — below the qualification bar (' + why + '). Click to open their overview.',
                    onClick: () => onAgentClick && onAgentClick(agent.extension)
                  },
                    /* Medal rank for the podium, plain number after. */
                    h('span', {className: 'ops-rank' + (medal ? ' is-' + medal : '')}, String(index + 1)),
                    h('span', {className:'ops-avatar'}, initials(name)),
                    h('span', {className:'min-w-0'},
                      h('span', {className:'ops-agent-name block truncate'}, name),
                      h('span', {className:'ops-agent-bar'},
                        h('span', {
                          className:'ops-agent-fill' + (agentRank === 'aht' ? ' is-aht' : ''),
                          style:{width: Math.max(0, Math.min(100, barPct)) + '%'}
                        })
                      )
                    ),
                    h('span', {className:'ops-agent-metrics'},
                      h('span', {className:'ops-agent-calls'}, fmtNum(inbound)),
                      h('span', {className:'ops-agent-aht'}, aht ? fmt(aht) : '—')
                    )
                  );
                  /*
                   * Divider marking where the qualifying agents stop, so
                   * the muted rows below are obviously a second tier.
                   */
                  const needsSep = agentRank === 'aht'
                    && index === qualifiedCount
                    && qualifiedCount > 0;
                  return needsSep
                    ? h(React.Fragment, {key: 'sep-' + (agent.extension || name)},
                        h('div', {className: 'ops-agent-sep'}, 'Below qualification'),
                        row
                      )
                    : row;
                }))
        ,
        agentRank === 'aht' && reportReady && topAgents.length > 0 && qualifiedCount === 0
          ? h('div', {className: 'ops-qual-note'},
              'No agent met the qualification bar (under ' + (qualAhtSeconds / 60) +
              ' min AHT and over ' + fmtNum(qualMinCalls) + ' inbound). Showing fastest overall.')
          : null
      )
    ),

    h('div', {className:'ops-split', style:{gridTemplateColumns:'1fr 1fr'}},
      h('section', {className:'ops-card'},
        h('div', {className:'ops-label'}, 'Missed breakdown', qHelp('Abandoned hang-ups are critical. No-answer rang out. Voicemail is elevated, not a breach by itself. Click a row to open those calls.')),
        h('div', {className:'ops-hint'}, 'Abandoned hang-ups are critical. Voicemail is elevated, not a breach by itself.'),
        reportReady
          ? [
              ['Abandoned', abandonCount, 'missed_abandon', C.bad],
              ['No answer', mb.noanswer || 0, 'missed_noanswer', C.warn],
              ['Voicemail', mb.voicemail || 0, 'missed_voicemail', C.onnet]
            ].map(([lab, val, metric, color]) => {
              const maxM = Math.max(abandonCount, mb.noanswer||0, mb.voicemail||0, 1);
              const w = val ? Math.round((Number(val) / maxM) * 100) : 0;
              return h('button', {key: metric, type:'button', className:'ops-break-row', onClick: () => onMetric && onMetric(metric)},
                h('div', {className:'ops-break-top'},
                  h('span', {className:'flex items-center gap-2'}, h('span', {className:'ops-dot', style:{background: color}}), lab),
                  h('span', {className:'text-slate-100'}, fmtNum(val))
                ),
                h('div', {className:'ops-break-track'}, h('div', {className:'ops-break-fill', style:{width: w + '%', background: color}}))
              );
            })
          : pulse
      ),
      h('section', {className:'ops-card'},
        h('div', {className:'ops-label'}, 'Call volume per day', qHelp('Empty ticks are days with zero calls. Click a day with volume to open those calls.')),
        h('div', {className:'ops-hint'}, 'Empty ticks are days with zero calls. Click a day to open those calls.'),
        reportReady
          ? h('div', {className:'ops-day-wrap'},
              ...dayList.map(d => {
                const n = Number(days[d] || 0);
                const hgt = n ? Math.max(4, Math.round((n / dayMax) * 68)) : 2;
                return h('button', {
                  key: d,
                  type: 'button',
                  title: d + ': ' + n + ' calls',
                  onClick: () => n && onDayClick && onDayClick(d),
                  className: 'ops-day-bar' + (n ? '' : ' is-empty') + (n ? ' cursor-pointer' : ''),
                  style: {height: hgt + 'px', opacity: n ? (0.4 + 0.6 * (n / dayMax)) : 1}
                });
              })
            )
          : pulse
      )
    ),

    h('div', {className:'ops-sys'},
      ready.agents
        ? sysTile({
            label: 'Agents',
            value: fmtNum(inv.agents ?? 0),
            hint: (allowedRoutes||[]).includes('agents') ? 'Open agents' : 'Your department',
            tip: 'Count of agents in the current department/site filter. Click to open Agents when your role allows it.',
            icon: 'fa-solid fa-user-group',
            chip: 'is-good',
            routeId: 'agents'
          })
        : pulse,
      ready.aa
        ? sysTile({
            label: 'Auto-attendants',
            value: fmtNum(inv.autoAttendants ?? 0),
            hint: fmtNum(inv.aaCalls || 0) + ' IVR calls',
            tip: 'IVR menus configured. Sub-stat is auto-attendant calls in this range. Click to open Auto-Attendants when your role allows it.',
            icon: 'fa-solid fa-diagram-project',
            chip: 'is-onnet',
            routeId: 'attendants'
          })
        : pulse,
      (ready.queues || ready.agents)
        ? sysTile({
            label: 'Queues',
            value: fmtNum(inv.queues ?? 0),
            hint: (allowedRoutes||[]).includes('queues') ? 'Open queues' : 'Call queues',
            tip: 'Call queues for this account. Count is shown only when inventory includes it. Click to open Queues when your role allows it.',
            icon: 'fa-solid fa-layer-group',
            chip: 'is-warn',
            routeId: 'queues'
          })
        : pulse,
      ready.numbers
        ? sysTile({
            label: 'Phone numbers',
            value: fmtNum(inv.totalNumbers ?? 0),
            hint: numEnabled + ' enabled',
            tip: 'DID inventory for this account. Sub-stat is how many numbers are enabled. Click to open Telephone Numbers when your role allows it.',
            icon: 'fa-solid fa-hashtag',
            chip: 'is-out',
            routeId: 'telephone_numbers'
          })
        : pulse
    )
  );
}

export { OverviewDashboard };
