/* Simultaneous-call counting over a date range.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { Tooltip, skel, skelPanel } from './ui.js';
import { api } from '../lib/api.js';
import { fmtNum } from '../lib/format.js';
import { h, keyActivate, useEffect, useMemo, useRef, useState } from '../lib/react.js';
import { APP_TZ, histDayLabel } from '../lib/time.js';

function simClock(value) {
  const match = String(value == null ? '' : value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value == null ? '' : value) || '—';
  const hour = Number(match[1]) % 24;
  const am = hour >= 12 ? 'PM' : 'AM';
  return (hour % 12 || 12) + ':' + match[2] + ' ' + am;
}

const SIM_INTERVAL_CHOICES = [
  [5, '5 minutes'],
  [10, '10 minutes'],
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour']
];

function SimultaneousCallsPanel({filters, onCallClick}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [search, setSearch] = useState('');
  const [minPeak, setMinPeak] = useState('');
  const [sortKey, setSortKey] = useState('time');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const volumeRef = useRef(null);
  const volumeChart = useRef(null);
  const hourRef = useRef(null);
  const hourChart = useRef(null);
  const dayRef = useRef(null);
  const dayChart = useRef(null);

  /*
   * The parent rebuilds its onCallClick closure every render; keep the
   * latest in a ref so the charts can drill down without being rebuilt.
   */
  const drillRef = useRef(onCallClick);
  drillRef.current = onCallClick;

  const drill = payload => {
    if (typeof drillRef.current === 'function') drillRef.current(payload);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    /*
     * Same call shape as the rest of the page: POST with the shared
     * filters, plus the bucket size. The server echoes the effective
     * interval back (it widens very fine buckets on 31-day ranges).
     */
    api('simultaneous_calls', { ...filters, interval: intervalMinutes })
      .then(response => {
        if (cancelled) return;
        const payload = response && response.data && typeof response.data === 'object'
          ? response.data
          : response;
        if (!payload || !payload.summary) throw new Error('Unexpected response.');
        setData(payload);
        const effective = Number(payload.summary.intervalMinutes || intervalMinutes);
        if (effective !== intervalMinutes) setIntervalMinutes(effective);
      })
      .catch(err => {
        if (cancelled) return;
        setData(null);
        setError(err && err.message ? err.message : 'Failed to load simultaneous calls.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filters?.start, filters?.end, filters?.department, filters?.site, intervalMinutes]);

  const summary = data && data.summary ? data.summary : {};
  const intervals = Array.isArray(data?.intervals) ? data.intervals : [];
  const byHour = Array.isArray(data?.byHour) ? data.byHour : [];
  const byDay = Array.isArray(data?.byDay) ? data.byDay : [];

  const peakValue = Number(summary.peak || 0);
  const busiestDay = summary.busiestDay || null;
  const busiestHour = summary.busiestHour || null;
  const multiDay = intervals.length > 0
    && intervals[0].date !== intervals[intervals.length - 1].date;
  const intervalText = (Number(summary.intervalMinutes || intervalMinutes) || 15) >= 60
    ? 'hourly buckets'
    : (Number(summary.intervalMinutes || intervalMinutes) || 15) + '-minute buckets';

  useEffect(() => {
    setPage(1);
  }, [data, pageSize, search, minPeak, sortKey, sortDir]);

  /* ---------- graph 1: simultaneous calls across the range ---------- */
  const volumeSignature = intervals.map(row => Number(row.simultaneous || 0)).join(',');

  useEffect(() => {
    const canvas = volumeRef.current;
    if (!canvas) return;
    if (volumeChart.current) { volumeChart.current.destroy(); volumeChart.current = null; }
    if (!intervals.length || typeof Chart === 'undefined') return;

    const labels = intervals.map(row => multiDay
      ? String(row.date || '').slice(5).replace('-', '/') + ' ' + String(row.time || '')
      : String(row.time || ''));

    volumeChart.current = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: intervals.map(row => Number(row.simultaneous || 0)),
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.15)',
          fill: true,
          tension: 0.25,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => {
                const row = intervals[items[0].dataIndex] || {};
                return histDayLabel(row.date) + ' · ' + simClock(row.time) + ' – ' + simClock(row.endTime);
              },
              label: item => {
                const row = intervals[item.dataIndex] || {};
                return [
                  fmtNum(row.simultaneous) + ' simultaneous',
                  'avg ' + Number(row.average || 0).toFixed(2) + ' · ' + fmtNum(row.started) + ' started'
                ];
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#1e293b' },
            ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 9 } }
          },
          y: {
            beginAtZero: true,
            grid: { color: '#1e293b' },
            ticks: { color: '#94a3b8', precision: 0, font: { size: 9 } }
          }
        },
        onClick: (event, elements) => {
          if (!elements || !elements.length) return;
          const row = intervals[elements[0].index];
          if (row) drill({ date: row.date, hour: row.hour, metric: 'incoming' });
        }
      }
    });

    return () => {
      if (volumeChart.current) { volumeChart.current.destroy(); volumeChart.current = null; }
    };
  }, [volumeSignature, multiDay, intervalMinutes, loading, error]);

  /* ---------- graph 2: peak by hour of day ---------- */
  const hourSignature = byHour.map(row => Number(row.peak || 0)).join(',');

  useEffect(() => {
    const canvas = hourRef.current;
    if (!canvas) return;
    if (hourChart.current) { hourChart.current.destroy(); hourChart.current = null; }
    if (!byHour.length || typeof Chart === 'undefined') return;

    hourChart.current = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: byHour.map(row => String(row.label || '').slice(0, 2)),
        datasets: [{
          data: byHour.map(row => Number(row.peak || 0)),
          backgroundColor: '#22d3ee',
          borderRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => String(items[0].label) + ':00 – ' + String((Number(items[0].label) + 1) % 24).padStart(2, '0') + ':00',
              label: item => {
                const row = byHour[item.dataIndex] || {};
                return [
                  'peak ' + fmtNum(row.peak) + ' simultaneous',
                  'avg ' + Number(row.average || 0).toFixed(2) + ' · ' + fmtNum(row.started) + ' calls started'
                ];
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 9 } } },
          y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', precision: 0, font: { size: 9 } } }
        },
        onClick: (event, elements) => {
          if (!elements || !elements.length) return;
          const row = byHour[elements[0].index];
          if (row) drill({ hour: row.hour, metric: 'incoming' });
        }
      }
    });

    return () => {
      if (hourChart.current) { hourChart.current.destroy(); hourChart.current = null; }
    };
  }, [hourSignature, loading, error]);

  /* ---------- graph 3: peak by day ---------- */
  const daySignature = byDay.map(row => Number(row.peak || 0)).join(',');

  useEffect(() => {
    const canvas = dayRef.current;
    if (!canvas) return;
    if (dayChart.current) { dayChart.current.destroy(); dayChart.current = null; }
    if (!byDay.length || typeof Chart === 'undefined') return;

    dayChart.current = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: byDay.map(row => String(row.date || '').slice(5).replace('-', '/')),
        datasets: [{
          data: byDay.map(row => Number(row.peak || 0)),
          backgroundColor: '#0891b2',
          borderRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => histDayLabel(byDay[items[0].dataIndex]?.date),
              label: item => {
                const row = byDay[item.dataIndex] || {};
                return [
                  'peak ' + fmtNum(row.peak) + (row.time ? ' at ' + simClock(row.time) : ''),
                  'avg ' + Number(row.average || 0).toFixed(2) + ' · ' + fmtNum(row.started) + ' calls started'
                ];
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 9 } } },
          y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', precision: 0, font: { size: 9 } } }
        },
        onClick: (event, elements) => {
          if (!elements || !elements.length) return;
          const row = byDay[elements[0].index];
          if (row) drill({ date: row.date, metric: 'incoming' });
        }
      }
    });

    return () => {
      if (dayChart.current) { dayChart.current.destroy(); dayChart.current = null; }
    };
  }, [daySignature, loading, error]);

  /* ---------- summary table (Date and Time are separate columns) ---------- */
  const term = search.trim().toLowerCase();
  const minValue = minPeak === '' ? null : Math.max(0, Number(minPeak) || 0);

  const filtered = useMemo(() => intervals.filter(row => {
    if (minValue !== null && Number(row.simultaneous || 0) < minValue) return false;
    if (!term) return true;
    return [
      row.date,
      row.time,
      row.endTime,
      histDayLabel(row.date),
      simClock(row.time),
      simClock(row.endTime)
    ].some(value => String(value == null ? '' : value).toLowerCase().includes(term));
  }), [intervals, term, minValue]);

  const sorted = useMemo(() => {
    const copy = filtered.slice();
    const metric = row => {
      if (sortKey === 'simultaneous') return Number(row.simultaneous || 0);
      if (sortKey === 'average') return Number(row.average || 0);
      if (sortKey === 'started') return Number(row.started || 0);
      return 0;
    };
    if (sortKey === 'time') {
      /* Server order is already chronological; newest-first when asked. */
      return sortDir === 'asc' ? copy : copy.reverse();
    }
    copy.sort((a, b) => {
      const av = metric(a);
      const bv = metric(b);
      if (av === bv) {
        return String(a.date + a.time).localeCompare(String(b.date + b.time));
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRows);
  const pageRows = sorted.slice(startIndex, endIndex);

  const sortBtn = (field, label, tip) => {
    const active = sortKey === field;
    const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    return h('th', { className: 'text-right' },
      h(Tooltip, { text: tip },
        h('button', {
          type: 'button',
          onClick: () => {
            if (sortKey === field) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
            else { setSortKey(field); setSortDir('desc'); }
          },
          className: 'tn-sort ' + (active ? 'is-on' : '')
        }, label + arrow)
      )
    );
  };

  const exportCsv = () => {
    const headers = ['Date', 'Time', 'Time end', 'Simultaneous', 'Average', 'Calls started'];
    const lines = [headers.join(',')];
    sorted.forEach(row => {
      lines.push([
        row.date,
        simClock(row.time),
        simClock(row.endTime),
        Number(row.simultaneous || 0),
        Number(row.average || 0).toFixed(2),
        Number(row.started || 0)
      ].map(value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"').join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'simultaneous-calls-' + String(filters?.start || '') + '_' + String(filters?.end || '') + '.csv';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const kpi = (label, value, sub, icon, tone, tip, onClick) => {
    const Tag = onClick ? 'button' : 'div';
    return h(Tag, {
      type: onClick ? 'button' : undefined,
      onClick,
      title: tip || '',
      className: 'tn-kpi-mini' + (tone ? ' is-' + tone : '') + (onClick ? ' is-click' : '')
    },
      h('div', { className: 'tn-kpi-mini-top' },
        h('span', { className: 'tn-kpi-ico', 'aria-hidden': 'true' }, h('i', { className: icon })),
        h('span', { className: 'tn-kpi-mini-label' }, label),
        tip ? h(Tooltip, { text: tip },
          h('span', { className: 'cursor-help border-b border-dotted border-slate-600 text-[10px]' }, '?')) : null
      ),
      h('div', { className: 'tn-kpi-mini-value' }, typeof value === 'number' ? fmtNum(value) : value),
      sub ? h('div', { className: 'sim-kpi-sub' }, sub) : null
    );
  };

  if (error) {
    return h('section', { className: 'min-w-0 flex-1 overflow-auto' },
      h('section', { className: 'border border-red-900 bg-slate-900 p-4 text-xs text-red-400' }, error)
    );
  }

  if (loading) {
    return h('section', { className: 'min-w-0 flex-1 overflow-auto' },
      h('div', { className: 'tn-kpi-ribbon' },
        ...Array.from({ length: 4 }, (_, i) =>
          h('div', { key: i, className: 'tn-kpi-mini' }, skel('h-3 w-16'), skel('mt-3 h-6 w-20'))
        )
      ),
      skelPanel('h-56'),
      skelPanel('h-32')
    );
  }

  const peakRowClass = row => Number(row.simultaneous || 0) > 0 && Number(row.simultaneous || 0) === peakValue
    ? 'sim-peak-row'
    : '';

  const panel = (title, hint, body, extra) => h('section', { className: 'sim-panel ' + (extra || '') },
    h('div', { className: 'sim-panel-head' },
      h('h3', { className: 'sim-panel-title' }, title),
      hint ? h('span', { className: 'sim-panel-hint' }, hint) : null
    ),
    body
  );

  return h('div', null,
    h('section', { className: 'tn-kpi-ribbon' },
      kpi('Peak simultaneous', peakValue, peakValue > 0
          ? histDayLabel(summary.peakDate) + ' · ' + simClock(summary.peakTime)
          : 'No calls in range',
        'fa-solid fa-users', peakValue > 0 ? 'warn' : null,
        'Most inbound calls in flight at the same moment. Click for the calls behind it.',
        () => drill({ date: summary.peakDate, hour: Number(String(summary.peakTime || '0').slice(0, 2)) || 0, metric: 'incoming' })),
      kpi('Average simultaneous', Number(summary.average || 0).toFixed(2), intervalText + ' in ' + String(summary.timezone || APP_TZ),
        'fa-solid fa-wave-square', null,
        'Call-seconds in flight ÷ seconds in range: the average line load, all day and night included.'),
      kpi('Busiest day', busiestDay ? fmtNum(busiestDay.peak) : 0, busiestDay
          ? histDayLabel(busiestDay.date) + (busiestDay.time ? ' · ' + simClock(busiestDay.time) : '')
          : '—',
        'fa-solid fa-calendar-day', null,
        'Highest simultaneous count of any single day in the range.',
        busiestDay ? () => drill({ date: busiestDay.date, metric: 'incoming' }) : null),
      kpi('Inbound calls', Number(summary.totalCalls || 0),
        fmtNum(summary.inbound) + ' answered · ' + fmtNum(summary.missed) + ' missed',
        'fa-solid fa-phone', 'good', 'Inbound plus missed calls counted in this range.',
        () => drill({ metric: 'incoming' }))
    ),

    data.insight
      ? h('div', { className: 'tn-insight' },
          h('i', { className: 'fa-solid fa-circle-info', 'aria-hidden': 'true' }),
          h('span', null, data.insight + ' Individual intervals are listed below.')
        )
      : null,

    h('div', { className: 'tn-toolbar' },
      h('select', {
        value: intervalMinutes,
        title: 'Bucket size for the graph and the summary table',
        onChange: e => setIntervalMinutes(Number(e.target.value)),
        className: 'tn-type-filter'
      },
        ...SIM_INTERVAL_CHOICES.map(([value, label]) =>
          h('option', { key: value, value }, label)
        )
      ),
      h('input', {
        value: search,
        onChange: e => setSearch(e.target.value),
        placeholder: 'Search date or time…',
        className: 'min-w-0 flex-1 border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400'
      }),
      h('input', {
        type: 'number',
        min: 0,
        step: 1,
        value: minPeak,
        onChange: e => setMinPeak(e.target.value),
        placeholder: 'Min simultaneous',
        title: 'Show only intervals at or above this simultaneous count',
        className: 'w-32 border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400'
      }),
      peakValue > 0
        ? h('button', {
            type: 'button',
            title: 'Show only the intervals sitting at the peak',
            onClick: () => setMinPeak(minValue === peakValue ? '' : String(peakValue)),
            className: 'tn-active-filter ' + (minValue === peakValue ? 'is-on' : '')
          }, 'Peak only')
        : null,
      h('button', {
        type: 'button',
        className: 'hist-export',
        onClick: exportCsv,
        disabled: totalRows === 0,
        title: 'Export the filtered intervals as CSV'
      }, 'Export CSV')
    ),

    panel(multiDay ? 'Simultaneous calls by interval' : 'Simultaneous calls through the day',
      intervalText + ' · ' + String(summary.timezone || APP_TZ) + ' · click a point for those calls',
      h('div', { className: 'sim-chart' }, h('canvas', { ref: volumeRef }))
    ),

    h('div', { className: 'sim-grid' },
      panel('Peak by hour of day', 'Highest simultaneous count in each hour',
        h('div', { className: 'sim-chart is-sm' }, h('canvas', { ref: hourRef }))
      ),
      panel('Peak by day', multiDay ? 'Every day in this range' : 'Single day in range',
        h('div', { className: 'sim-chart is-sm' }, h('canvas', { ref: dayRef }))
      )
    ),

    h('section', { className: 'sim-panel' },
      h('div', { className: 'sim-panel-head' },
        h('h3', { className: 'sim-panel-title' }, 'Interval summary'),
        h('span', { className: 'sim-panel-hint' },
          fmtNum(totalRows) + (totalRows === 1 ? ' interval' : ' intervals') +
          (totalRows !== intervals.length ? ' of ' + fmtNum(intervals.length) : '') +
          ' · peak ' + fmtNum(peakValue))
      ),
      h('div', { className: 'sim-table-scroll' },
        h('table', { className: 'q-table sim-table' },
          h('thead', null,
            h('tr', null,
              h('th', { title: 'Calendar day (US/Eastern)' }, 'Date'),
              h('th', { title: 'Bucket start and end, US/Eastern' }, 'Time'),
              sortBtn('simultaneous', 'Simultaneous', 'Peak number of inbound calls in flight inside this interval.'),
              sortBtn('average', 'Average', 'Call-seconds ÷ interval length: the average line load across this interval.'),
              sortBtn('started', 'Calls started', 'Inbound calls that began ringing inside this interval.')
            )
          ),
          h('tbody', null,
            pageRows.length === 0
              ? h('tr', null, h('td', { colSpan: 5, className: 'sim-empty' },
                  intervals.length === 0
                    ? 'No inbound calls in this range.'
                    : 'No intervals match these filters.'))
              : pageRows.map((row, index) => {
                  const value = Number(row.simultaneous || 0);
                  const peakRow = value > 0 && value === peakValue;
                  const share = peakValue > 0 ? Math.max(0, Math.min(1, value / peakValue)) : 0;
                  return h('tr', {
                    key: [row.date, row.time, startIndex + index].join('-'),
                    tabIndex: 0,
                    onKeyDown: keyActivate(() => drill({ date: row.date, hour: row.hour, metric: 'incoming' })),
                    className: 'cursor-pointer ' + peakRowClass(row),
                    title: 'Open the calls behind this interval',
                    onClick: () => drill({ date: row.date, hour: row.hour, metric: 'incoming' })
                  },
                    h('td', { className: 'hist-day-label' }, histDayLabel(row.date)),
                    h('td', { className: 'hist-time' },
                      simClock(row.time) + ' – ' + simClock(row.endTime)
                    ),
                    h('td', { className: 'sim-num' },
                      h('span', { className: 'sim-value' },
                        fmtNum(value),
                        peakRow ? h('span', { className: 'sim-chip-peak', title: 'Busiest interval in this range' }, 'Peak') : null
                      ),
                      h('span', { className: 'sim-bar' + (peakRow ? ' is-peak' : ''), 'aria-hidden': 'true' },
                        h('i', { style: { width: Math.round(share * 100) + '%' } })
                      )
                    ),
                    h('td', { className: 'sim-num' }, Number(row.average || 0).toFixed(2)),
                    h('td', { className: 'sim-num' }, fmtNum(row.started))
                  );
                })
          )
        )
      ),
      h('div', { className: 'sim-pager' },
        h('div', { className: 'flex items-center gap-2' },
          'Rows per page:',
          h('select', {
            value: pageSize,
            onChange: e => { setPageSize(Number(e.target.value)); setPage(1); },
            className: 'tn-type-filter'
          },
            h('option', { value: 10 }, '10'),
            h('option', { value: 25 }, '25'),
            h('option', { value: 50 }, '50'),
            h('option', { value: 100 }, '100')
          ),
          h('span', null,
            totalRows === 0 ? 'Showing 0 of 0' : ('Showing ' + (startIndex + 1) + ' - ' + endIndex + ' of ' + totalRows))
        ),
        h('div', { className: 'flex items-center gap-1' },
          h('button', {
            type: 'button',
            disabled: currentPage <= 1,
            onClick: () => setPage(p => Math.max(1, p - 1)),
            className: 'sim-page-btn'
          }, 'Prev'),
          h('span', { className: 'px-2' }, 'Page ' + currentPage + ' of ' + totalPages),
          h('button', {
            type: 'button',
            disabled: currentPage >= totalPages,
            onClick: () => setPage(p => Math.min(totalPages, p + 1)),
            className: 'sim-page-btn'
          }, 'Next')
        )
      )
    )
  );
}

export { SimultaneousCallsPanel };
