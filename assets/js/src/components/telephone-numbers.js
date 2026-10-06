/* Telephone number inventory, graphs and the simultaneous-calls tab.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { SimultaneousCallsPanel } from './simultaneous.js';
import { ErrorState, Tooltip, skel, skelPanel } from './ui.js';
import { api, apiDownload } from '../lib/api.js';
import { fmt, fmtNum, fmtPct, formatPhoneNumber } from '../lib/format.js';
import { h, useEffect, useMemo, useRef, useState } from '../lib/react.js';

function telephoneDestinationType(application) {

    const value =
        String(application || '')
            .trim()
            .toLowerCase();

    if (
        value === 'to-user' ||
        value === 'to-user-residential' ||
		value === 'to-user-add-header'
    ) {
        return 'User';
    }
	
	if (
        value === 'to-device-add-header'
    ) {
        return 'Device';
    }

    if (
        value === 'to-callqueue' ||
        value === 'call queuing add header' ||
        value === 'to-callqueue-announce-count-callers-ahead'
    ) {
        return 'Queue';
    }

    if (value === 'available-number') {
        return 'Available';
    }

    if (value === 'to-single-device') {
        return 'Conference';
    }

    if (
        value === 'to-voicemail' ||
        value === 'to-voicemail-residential'
    ) {
        return 'Voicemail';
    }

    if (
        value ===
        'to-connection-add-header-update-cdr-by-user'
    ) {
        return 'PSTN';
    }

    return value;
}

function displayTnExtension(name, ext) {
    const junk = v => {
        const t = String(v == null ? '' : v).trim();
        if (!t) return true;
        if (t === '0' || t === '*' || t === '[*]' || t === 'N/A' || t === 'n/a' || t === '-') return true;
        if (/^\[?\*+\]?$/.test(t)) return true;
        return false;
    };
    const n = String(name == null ? '' : name).trim();
    const e = String(ext == null ? '' : ext).trim();
    const nameOk = !junk(n);
    const extOk = !junk(e);
    if (nameOk && extOk) return n + ' (' + e + ')';
    if (nameOk) return n;
    if (extOk) return e;
    return '—';
}

function tnIsEnabled(phone) {
  return phone.enabled !== false && phone.enabled !== 0 && String(phone.enabled).toLowerCase() !== 'no';
}

function tnCallVolume(phone) {
  const c = phone.calls || {};
  return Number(c.inbound || 0) + Number(c.missed || 0) + Number(c.outbound || 0);
}

function tnTypeKind(type) {
  const t = String(type || '').toLowerCase();
  if (/toll|tf|800|888|877|866|855|844|833/.test(t)) return 'tollfree';
  return 'local';
}

function tnTypeLabel(type) {
  return tnTypeKind(type) === 'tollfree' ? 'Toll-Free' : 'Local DID';
}

function tnRouteMeta(phone) {
  const app = String((phone.routing && phone.routing.application) || phone.application || '').toLowerCase();
  const dest = phone.destination || {};
  const code = String(dest.serviceCode || dest.service || '').toLowerCase();
  const name = String(dest.name || dest.extension || '').toLowerCase();
  const label = telephoneDestinationType(app);
  if (code === 'system-aa' || /auto.?attend|ivr|attendant/.test(app + name + label)) {
    return { kind: 'aa', label: dest.name || 'Auto-attendant', icon: 'fa-solid fa-diagram-project' };
  }
  if (/callqueue|queue/.test(app) || label === 'Queue') {
    return { kind: 'queue', label: dest.name || dest.extension || 'Queue', icon: 'fa-solid fa-layer-group' };
  }
  if (/voicemail/.test(app) || label === 'Voicemail') {
    return { kind: 'vm', label: dest.name || 'Voicemail', icon: 'fa-solid fa-voicemail' };
  }
  if (/conference|to-single-device/.test(app) || label === 'Conference') {
    return { kind: 'conf', label: dest.name || 'Conference', icon: 'fa-solid fa-users' };
  }
  if (/device|door|ring.?group/.test(app + name + label) || label === 'Device') {
    return { kind: 'door', label: dest.name || dest.extension || 'Device', icon: 'fa-solid fa-door-open' };
  }
  if (label === 'PSTN' || /connection|pstn/.test(app)) {
    return { kind: 'pstn', label: dest.name || 'PSTN', icon: 'fa-solid fa-globe' };
  }
  if (label === 'Available' || /available/.test(app)) {
    return { kind: 'avail', label: 'Unassigned', icon: 'fa-regular fa-circle' };
  }
  const shown = displayTnExtension(dest.name, dest.extension);
  return { kind: 'user', label: shown === '—' ? 'User' : shown, icon: 'fa-solid fa-user' };
}

function tnFaint(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t || t === '—') return h('span', { className: 'tn-faint' }, '—');
  return t;
}

function TelephoneNumbersTable({data,loading, filters, onTelephoneClick}) {

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [sortKey, setSortKey] = useState('calls');
    const [sortDir, setSortDir] = useState('desc');
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState('');

    /*
     * Export the whole inventory for the selected range: every DID the PBX
     * knows, not the ten rows on screen and not the subset the search box and
     * the type/Active-only toggles happen to hide. The server streams it.
     */
    const exportInventory = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            await apiDownload('telephone_numbers', { ...(filters || {}), export: true }, 'telephone-numbers.csv');
        } catch (e) {
            setError(e && e.message ? e.message : 'Unable to export telephone numbers.');
        } finally {
            setExporting(false);
        }
    };

    const rows = Array.isArray(data) ? data : [];

    const sorted = useMemo(() => {
        const copy = rows.slice();
        copy.sort((a, b) => {
            const ca = a.calls || {};
            const cb = b.calls || {};
            let av, bv;
            if (sortKey === 'calls') {
                av = Number(ca.inbound || 0);
                bv = Number(cb.inbound || 0);
            } else if (sortKey === 'missed') {
                av = Number(ca.missed || 0);
                bv = Number(cb.missed || 0);
            } else if (sortKey === 'talk') {
                av = Number(ca.talkSeconds || 0);
                bv = Number(cb.talkSeconds || 0);
            } else if (sortKey === 'number') {
                av = String(a.number || '');
                bv = String(b.number || '');
                return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
            } else if (sortKey === 'type') {
                av = tnTypeLabel(a.type);
                bv = tnTypeLabel(b.type);
                return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
            } else {
                av = 0; bv = 0;
            }
            if (av === bv) {
                return String(a.number || '').localeCompare(String(b.number || ''));
            }
            return sortDir === 'asc' ? av - bv : bv - av;
        });
        return copy;
    }, [rows, sortKey, sortDir]);

    useEffect(() => { setPage(1); }, [data, pageSize, sortKey, sortDir]);

    const totalRows = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalRows);
    const paginatedData = sorted.slice(startIndex, endIndex);

    const sortBtn = (field, label, align, tip) => {
        const active = sortKey === field;
        const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
        return h('th', { className: 'whitespace-nowrap px-2 py-2 ' + (align || 'text-left') },
            h(Tooltip, { text: tip || ('Sort by ' + label) },
                h('button', {
                    type: 'button',
                    onClick: () => {
                        if (sortKey === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                        else { setSortKey(field); setSortDir(field === 'number' || field === 'type' ? 'asc' : 'desc'); }
                    },
                    className: 'tn-sort ' + (active ? 'is-on' : '')
                }, label + arrow)
            )
        );
    };

    if (loading) {
        return h('section', {className: 'border border-slate-700 bg-slate-900'},
            h('div', {className: 'border-b border-slate-700 px-3 py-2'}, skel('h-3 w-40')),
            ...Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'border-b border-slate-800 px-3 py-3'},
                skel('h-3')))
        );
    }

    return h('section', {className: 'border border-slate-700 bg-slate-900'},
        error ? h(ErrorState, {message: error, onRetry: () => setReload(n => n + 1), className: 'border-x-0 border-t-0 p-2 text-[11px]'}) : null,
        h('div', {className: 'overflow-x-auto'},
            h('table', {className: 'w-full min-w-[1200px] text-xs q-table'},
                h('thead', null,
                    h('tr', {className: 'border-b border-slate-700 bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500'},
                        h('th', {className: 'whitespace-nowrap px-2 py-2 text-left'},
                            h('div', {className: 'flex items-center gap-2'},
                                h('button', {
                                    type: 'button',
                                    onClick: exportInventory,
                                    disabled: exporting || !!loading,
                                    title: 'Export the complete inventory for this range as CSV',
                                    className: 'hist-export'
                                }, exporting ? 'Exporting…' : 'Export CSV'),
                                sortBtn('number', 'Telephone Number', 'text-left', 'Sort by number')
                            )
                        ),
                        sortBtn('type', 'Type', 'text-left', 'Sort by Local DID vs Toll-Free'),
                        h('th', {className: 'whitespace-nowrap px-2 py-2 text-left'},
                            h(Tooltip, {text: 'Where this DID routes: person, queue, IVR, device, or unassigned.'},
                                h('span', {className: 'cursor-help border-b border-dotted border-slate-600'}, 'Routes to'))
                        ),
                        h('th', {className: 'whitespace-nowrap px-2 py-2 text-left'}, 'Extension'),
                        h('th', {className: 'whitespace-nowrap px-2 py-2 text-left'}, 'Department'),
                        h('th', {className: 'whitespace-nowrap px-2 py-2 text-left'}, 'Site'),
                        sortBtn('calls', 'Calls', 'text-right', 'Answered inbound volume. Click a number to open those calls.'),
                        sortBtn('missed', 'Missed', 'text-right', 'Unanswered inbound. Red when greater than zero.'),
                        sortBtn('talk', 'Talk', 'text-right', 'Total talking time on this DID.')
                    )
                ),
                h('tbody', null,
                    paginatedData.length === 0
                        ? h('tr', null, h('td', {colSpan: 9, className: 'px-4 py-10 text-center text-xs text-slate-500'}, 'No telephone numbers found.'))
                        : paginatedData.map((phone, index) => {
                            const calls = phone.calls || {};
                            const destination = phone.destination || {};
                            const missed = Number(calls.missed || 0);
                            const inbound = Number(calls.inbound || 0);
                            const talk = Number(calls.talkSeconds || 0);
                            const enabled = tnIsEnabled(phone);
                            const unused = tnCallVolume(phone) === 0;
                            const typeKind = tnTypeKind(phone.type);
                            const route = tnRouteMeta(phone);
                            return h('tr', {
                                key: [phone.id, phone.number, startIndex + index].join('-'),
                                className: 'tn-row border-b border-slate-800'
                            },
                                h('td', {className: 'whitespace-nowrap px-2 py-2'},
                                    h('span', {className: 'inline-flex items-center gap-2'},
                                        h('button', {
                                            type: 'button',
                                            title: 'Open inbound calls for this number',
                                            onClick: () => onTelephoneClick(phone),
                                            className: 'cursor-pointer font-medium text-cyan-400 hover:text-cyan-300 hover:underline'
                                        }, formatPhoneNumber(phone.number)),
                                        enabled ? null : h('span', {className: 'tn-disabled-badge'}, 'Disabled'),
                                        unused ? h('span', {className: 'tn-unused-pill', title: 'No calls in the selected range'}, 'Unused') : null
                                    )
                                ),
                                h('td', {className: 'whitespace-nowrap px-2 py-2'},
                                    h('span', {className: 'tn-type tn-type-' + typeKind},
                                        h('span', {className: 'tn-type-dot', 'aria-hidden': 'true'}),
                                        tnTypeLabel(phone.type)
                                    )
                                ),
                                h('td', {className: 'whitespace-nowrap px-2 py-2'},
                                    h('span', {className: 'tn-route tn-route-' + route.kind, title: route.label},
                                        h('i', {className: route.icon, 'aria-hidden': 'true'}),
                                        h('span', {className: 'truncate'}, route.label)
                                    )
                                ),
                                h('td', {className: 'whitespace-nowrap px-2 py-2 text-slate-400'}, tnFaint(displayTnExtension('', destination.extension) === '—' ? '' : destination.extension)),
                                h('td', {className: 'whitespace-nowrap px-2 py-2'}, tnFaint(destination.department)),
                                h('td', {className: 'whitespace-nowrap px-2 py-2'}, tnFaint(destination.site)),
                                h('td', {className: 'whitespace-nowrap px-2 py-2 text-right tabular-nums ' + (inbound ? 'text-slate-200' : 'tn-faint')}, fmtNum(inbound)),
                                h('td', {className: 'whitespace-nowrap px-2 py-2 text-right tabular-nums ' + (missed > 0 ? 'text-rose-400 font-bold' : 'tn-faint')}, fmtNum(missed)),
                                h('td', {className: 'whitespace-nowrap px-2 py-2 text-right tabular-nums ' + (talk > 0 ? 'text-slate-200' : 'tn-faint')}, fmt(talk))
                            );
                        })
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
                    className: 'cursor-pointer rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                }, 'Prev'),
                h('span', {className: 'px-2 text-slate-300'}, 'Page ' + currentPage + ' of ' + totalPages),
                h('button', {
                    disabled: currentPage >= totalPages,
                    onClick: () => setPage(p => Math.min(totalPages, p + 1)),
                    className: 'cursor-pointer rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
                }, 'Next')
            )
        )
    );
}

function toHourList(hours) {
  const list = Array.from({length: 24}, () => 0);
  if (Array.isArray(hours)) {
    hours.forEach((n, i) => {
      if (i >= 0 && i < 24) list[i] = Number(n || 0);
    });
    return list;
  }
  if (hours && typeof hours === 'object') {
    Object.keys(hours).forEach(k => {
      const i = Number(k);
      if (i >= 0 && i < 24) list[i] = Number(hours[k] || 0);
    });
  }
  return list;
}

function toHeatmap(heatmap) {
  const grid = Array.from({length: 7}, () => Array.from({length: 24}, () => 0));
  if (!heatmap) return grid;
  if (Array.isArray(heatmap)) {
    heatmap.forEach((row, d) => {
      if (d < 0 || d > 6) return;
      const cells = Array.isArray(row) ? row : Object.values(row || {});
      cells.forEach((n, h) => {
        if (h >= 0 && h < 24) grid[d][h] = Number(n || 0);
      });
    });
    return grid;
  }
  if (typeof heatmap === 'object') {
    Object.keys(heatmap).forEach(dk => {
      const d = Number(dk);
      if (d < 0 || d > 6) return;
      const row = heatmap[dk];
      if (Array.isArray(row)) {
        row.forEach((n, h) => { if (h < 24) grid[d][h] = Number(n || 0); });
      } else if (row && typeof row === 'object') {
        Object.keys(row).forEach(hk => {
          const h = Number(hk);
          if (h >= 0 && h < 24) grid[d][h] = Number(row[hk] || 0);
        });
      }
    });
  }
  return grid;
}

function chartsFromTelephoneNumbers(numbers) {
  const hours = Array.from({length: 24}, () => 0);
  const days = {};
  const heatmap = Array.from({length: 7}, () => Array.from({length: 24}, () => 0));
  const outcomes = {answered: 0, missed: 0, busy: 0, failed: 0};
  const duration = [
    {label: '0–30s', count: 0},
    {label: '30–60s', count: 0},
    {label: '1–3m', count: 0},
    {label: '3–10m', count: 0},
    {label: '10m+', count: 0}
  ];

  (Array.isArray(numbers) ? numbers : []).forEach(n => {
    const c = n.calls || {};
    const inbound = Number(c.inbound || 0);
    const missed = Number(c.missed || 0);
    outcomes.answered += inbound;
    outcomes.missed += missed;
  });

  return {hours, days, outcomes, duration, heatmap};
}

function TelephoneNumbersGraphs({charts, numbers, onNumberClick}) {
  const volumeRef = useRef(null);
  const volumeChart = useRef(null);
  const outcomeRef = useRef(null);
  const outcomeChart = useRef(null);
  const durationRef = useRef(null);
  const durationChart = useRef(null);

  const hours = toHourList(charts?.hours);
  const days = charts?.days && typeof charts.days === 'object' && !Array.isArray(charts.days) ? charts.days : {};
  const dayKeys = Object.keys(days).sort();
  const useDays = dayKeys.length > 1;
  const volumeLabels = useDays
    ? dayKeys.map(d => {
        const p = d.split('-');
        return (p[1] || '') + '/' + (p[2] || '');
      })
    : Array.from({length:24}, (_, i) => String(i).padStart(2,'0'));
  const volumeData = useDays ? dayKeys.map(d => Number(days[d] || 0)) : hours.map(n => Number(n || 0));

  const oc = charts?.outcomes || {};
  const slices = [
    {label:'Answered', value: Number(oc.answered||0), color:'#34d399'},
    {label:'Missed', value: Number(oc.missed||0), color:'#f87171'},
    {label:'Busy', value: Number(oc.busy||0), color:'#fbbf24'},
    {label:'Failed', value: Number(oc.failed||0), color:'#a78bfa'}
  ];
  const outcomeTotal = slices.reduce((a,b) => a + b.value, 0);

  const duration = Array.isArray(charts?.duration) ? charts.duration : [];
  const heatmap = toHeatmap(charts?.heatmap);
  const heatMax = Math.max(1, ...heatmap.flat().map(n => Number(n||0)));
  const weekDays = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const inboundCount = n => {
    const c = n && n.calls && typeof n.calls === 'object' ? n.calls : {};
    return Number(c.inbound || 0) + Number(c.missed || 0);
  };
  const topFromCharts = Array.isArray(charts?.top)
    ? charts.top.map(n => ({
        number: String(n.number || n.phoneNumber || ''),
        calls: Number(n.calls || n.inbound || 0)
      })).filter(n => n.number && n.calls > 0)
    : [];
  const topFromNumbers = (Array.isArray(numbers) ? numbers : [])
    .map(n => ({
      number: String(n.number || n.phoneNumber || n.id || ''),
      calls: inboundCount(n)
    }))
    .filter(n => n.number && n.calls > 0)
    .sort((a,b) => b.calls - a.calls)
    .slice(0, 10);
  const top = (topFromCharts.length ? topFromCharts : topFromNumbers).slice(0, 10);

  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', maxRotation: 0, font: { size: 9 } } },
      y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', precision: 0, font: { size: 9 } } }
    }
  };

  useEffect(() => {
    if (!volumeRef.current) return;
    volumeChart.current?.destroy();
    volumeChart.current = new Chart(volumeRef.current, {
      type: 'line',
      data: {
        labels: volumeLabels,
        datasets: [{
          data: volumeData,
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.18)',
          fill: true,
          tension: 0.3,
          pointRadius: useDays ? 2 : 0,
          borderWidth: 1.5
        }]
      },
      options: chartOpts
    });
    return () => { volumeChart.current?.destroy(); volumeChart.current = null; };
  }, [volumeLabels.join('|'), volumeData.join('|')]);

  useEffect(() => {
    if (!outcomeRef.current) return;
    outcomeChart.current?.destroy();
    outcomeChart.current = new Chart(outcomeRef.current, {
      type: 'doughnut',
      data: {
        labels: slices.map(s => s.label),
        datasets: [{ data: slices.map(s => s.value), backgroundColor: slices.map(s => s.color), borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: { legend: { display: false } }
      }
    });
    return () => { outcomeChart.current?.destroy(); outcomeChart.current = null; };
  }, [slices.map(s => s.value).join('|')]);

  useEffect(() => {
    if (!durationRef.current) return;
    durationChart.current?.destroy();
    durationChart.current = new Chart(durationRef.current, {
      type: 'bar',
      data: {
        labels: duration.map(d => d.label),
        datasets: [{ data: duration.map(d => d.count), backgroundColor: '#0891b2', borderRadius: 2 }]
      },
      options: chartOpts
    });
    return () => { durationChart.current?.destroy(); durationChart.current = null; };
  }, [duration.map(d => d.count).join('|')]);

  const topMax = Math.max(1, ...top.map(n => n.calls));
  const panel = (title, hint, body, extra) => h('section', {className:'border border-slate-700 bg-slate-900 p-2 ' + (extra||'')},
    h('div', {className:'mb-1 flex items-center justify-between'},
      h('h3', {className:'text-[10px] font-semibold uppercase tracking-wide text-slate-400'}, title),
      hint ? h('span', {className:'text-[9px] text-slate-600'}, hint) : null
    ),
    body
  );

  return h('div', {className:'grid grid-cols-1 gap-2 lg:grid-cols-2'},
    panel(useDays ? 'Call volume by day' : 'Call volume by hour', 'Eastern',
      h('div', {className:'h-36'}, h('canvas', {ref: volumeRef}))
    ),
    panel('Outcomes', outcomeTotal.toLocaleString() + ' calls',
      h('div', {className:'flex items-center gap-3'},
        h('div', {className:'relative h-32 w-32 shrink-0'},
          h('canvas', {ref: outcomeRef}),
          h('div', {className:'pointer-events-none absolute inset-0 grid place-items-center text-center'},
            h('div', {className:'text-sm font-semibold text-slate-100'}, fmtNum(outcomeTotal))
          )
        ),
        h('div', {className:'min-w-0 flex-1 space-y-1'},
          ...slices.map(s => h('div', {key:s.label, className:'flex items-center justify-between text-[11px] text-slate-400'},
            h('span', {className:'flex items-center gap-1.5'},
              h('span', {className:'inline-block h-2 w-2 rounded-full', style:{background:s.color}}),
              s.label
            ),
            h('span', {className:'text-slate-200'}, fmtNum(s.value) + (outcomeTotal ? ' · ' + fmtPct(s.value, outcomeTotal) : ''))
          ))
        )
      )
    ),
    panel('Talk time', 'Inbound talk duration',
      h('div', {className:'h-36'}, h('canvas', {ref: durationRef}))
    ),
    /*
     * Was an EMPTY canvas: panel() promised "click a bar" but no chart was
     * ever created for it, and onNumberClick was never called by anything.
     * The bars are real elements now, so a click can open that number's
     * calls with the number as the filter.
     */
    panel('Top numbers', 'Inbound to DID · click a bar',
      top.length === 0
        ? h('div', {className:'py-10 text-center text-[11px] text-slate-500'}, 'No inbound calls to any number in this range.')
        : h('div', {className:'space-y-1'},
            ...top.map(n => {
              const pct = Math.max(2, Math.round((n.calls / topMax) * 100));
              return h('button', {
                key: n.number,
                type: 'button',
                title: 'Open the inbound calls to ' + formatPhoneNumber(n.number),
                onClick: () => onNumberClick && onNumberClick(n.number),
                className: 'flex w-full cursor-pointer items-center gap-2 text-left'
              },
                h('span', {className:'w-24 shrink-0 truncate font-mono text-[10px] text-slate-400'}, formatPhoneNumber(n.number)),
                h('span', {className:'min-w-0 flex-1'},
                  h('span', {className:'block h-3 rounded-sm bg-cyan-600/70', style:{width: pct + '%'}})
                ),
                h('span', {className:'w-10 shrink-0 text-right font-mono text-[10px] text-cyan-300'}, fmtNum(n.calls))
              );
            })
          )
    ),
    panel('Activity heatmap', 'Hour × weekday',
      h('div', {className:'overflow-x-auto'},
        h('table', {className:'w-full text-[9px]'},
          h('thead', null,
            h('tr', null,
              h('th', {className:'px-1 py-0.5 text-left text-slate-500'}, ''),
              ...Array.from({length:24}, (_, hr) =>
                h('th', {key:hr, className:'px-0.5 py-0.5 text-center font-normal text-slate-500'}, String(hr).padStart(2,'0'))
              )
            )
          ),
          h('tbody', null,
            ...weekDays.map((label, d) =>
              h('tr', {key:label},
                h('td', {className:'whitespace-nowrap px-1 py-0.5 text-slate-500'}, label),
                ...heatmap[d].map((n, hr) => {
                  const v = Number(n || 0);
                  const a = heatMax ? v / heatMax : 0;
                  return h('td', {
                    key: hr,
                    title: label + ' ' + String(hr).padStart(2,'0') + ':00 · ' + v,
                    className: 'h-4 min-w-[10px] px-0.5',
                    style: {background: v ? `rgba(8,145,178,${0.12 + a * 0.88})` : 'transparent'}
                  });
                })
              )
            )
          )
        )
      )
    )
  );
}

function TelephoneNumbers({filters, onCallClick}) {
  const [numbers, setNumbers] = useState([]);
  const [summary, setSummary] = useState({totalNumbers:0, enabledNumbers:0, totalCalls:0, totalMissed:0, totalTalkSeconds:0});
  const [charts, setCharts] = useState(null);
  const [repeatCallers, setRepeatCallers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hideZeroCalls, setHideZeroCalls] = useState(false);
  const [tnView, setTnView] = useState('inventory');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api('telephone_numbers', filters).then(r => {
      if (cancelled) return;
      const data = r && r.data && typeof r.data === 'object' ? r.data : r;
      const telephoneNumbers = Array.isArray(data?.numbers) ? data.numbers : [];
      setNumbers(telephoneNumbers);
      setSummary(data?.summary || {totalNumbers:0, enabledNumbers:0, totalCalls:0, totalMissed:0, totalTalkSeconds:0});
      setCharts(data?.charts || chartsFromTelephoneNumbers(telephoneNumbers));
      setRepeatCallers(Array.isArray(data?.repeatCallers) ? data.repeatCallers : []);
    }).catch(err => {
      if (cancelled) return;
      setNumbers([]);
      setError(err?.message || 'Unable to load telephone numbers.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filters?.start, filters?.end, filters?.department, filters?.site, reload]);

  const term = search.toLowerCase().trim();
  const unusedCount = numbers.filter(p => tnCallVolume(p) === 0).length;
  /*
   * Memoised: the table resets to page 1 whenever its `data` identity changes,
   * so re-filtering on every parent render (a keystroke, a tab switch, a
   * cache banner) used to bounce the user back to page 1 mid-read.
   */
  const visibleNumbers = useMemo(() => numbers.filter(phone => {
    if (hideZeroCalls && tnCallVolume(phone) === 0) return false;
    if (typeFilter === 'local' && tnTypeKind(phone.type) !== 'local') return false;
    if (typeFilter === 'tollfree' && tnTypeKind(phone.type) !== 'tollfree') return false;
    if (!term) return true;
    const d = phone.destination || {};
    const route = tnRouteMeta(phone);
    return [phone.number, phone.type, tnTypeLabel(phone.type), d.name, d.extension, d.department, d.site, route.label].some(v => String(v||'').toLowerCase().includes(term));
  }), [numbers, hideZeroCalls, typeFilter, term]);

  const kpi = (label, value, icon, tone, onClick, tip) => {
    const Tag = onClick ? 'button' : 'div';
    return h(Tag, {
      type: onClick ? 'button' : undefined,
      onClick,
      title: tip || '',
      className: 'tn-kpi-mini' + (tone ? ' is-' + tone : '') + (onClick ? ' is-click' : '')
    },
      h('div', {className: 'tn-kpi-mini-top'},
        h('span', {className: 'tn-kpi-ico', 'aria-hidden': 'true'}, h('i', {className: icon})),
        h('span', {className: 'tn-kpi-mini-label'}, label),
        tip ? h(Tooltip, {text: tip}, h('span', {className: 'cursor-help border-b border-dotted border-slate-600 text-[10px]'}, '?')) : null
      ),
      h('div', {className: 'tn-kpi-mini-value'}, typeof value === 'number' ? fmtNum(value) : value)
    );
  };

  if (error) {
    return h('section', {className:'min-w-0 flex-1 overflow-auto p-3'},
      h(ErrorState, {message: error, onRetry: () => setReload(n => n + 1), className: 'bg-slate-900 text-xs'})
    );
  }
  if (loading) {
    return h('section', {className:'min-w-0 flex-1 overflow-auto p-3'},
      h('div', {className:'tn-kpi-ribbon'},
        ...Array.from({length: 4}, (_, i) => h('div', {key: i, className: 'tn-kpi-mini'}, skel('h-3 w-16'), skel('mt-3 h-6 w-20')))
      ),
      skelPanel('h-64')
    );
  }

  return h('section', {className:'min-w-0 flex-1 overflow-auto p-3'},
    h('div', {className:'mb-3'},
      h('h1', {className:'text-sm font-semibold text-slate-100'}, 'Telephone Numbers'),
      h('p', {className:'mt-0.5 text-[10px] text-slate-500'}, 'Where each DID routes, and which numbers are worth keeping.')
    ),
    h('div', {className:'tn-tabs'},
      ...[
        ['inventory','Inventory','Number list, routing, and unused inventory'],
        ['graphs','Graphs','Volume mix for this range'],
        ['simultaneous','Simultaneous','How many inbound calls were in flight at the same time, interval by interval'],
        ['repeats','Repeat callers','Callers who hit these DIDs more than once']
      ].map(([id,label,tip]) =>
        h('button', {
          key: id,
          type: 'button',
          title: tip,
          onClick: () => setTnView(id),
          className: 'tn-tab' + (tnView === id ? ' is-on' : '')
        }, label)
      )
    ),
    h('section', {className: 'tn-kpi-ribbon'},
      kpi('Total numbers', summary.totalNumbers || 0, 'fa-solid fa-hashtag', null, null, 'DIDs in inventory for this account.'),
      kpi('Total calls', summary.totalCalls || 0, 'fa-solid fa-phone', 'good', () => onCallClick && onCallClick({ metric: 'incoming' }), 'Inbound + missed volume on all listed numbers. Click to open the call list.'),
      kpi('Missed calls', summary.totalMissed || 0, 'fa-solid fa-phone-slash', 'bad', () => onCallClick && onCallClick({ metric: 'missed' }), 'Unanswered inbound to these numbers. Click to open missed calls.'),
      kpi('Disabled numbers', Math.max(0, Number(summary.totalNumbers || 0) - Number(summary.enabledNumbers || 0)), 'fa-solid fa-ban', 'warn', null, 'Inventory marked disabled — candidates to reclaim.')
    ),
    unusedCount > 0
      ? h('div', {className: 'tn-insight'},
          h('i', {className: 'fa-solid fa-circle-info', 'aria-hidden': 'true'}),
          h('span', null, unusedCount + (unusedCount === 1 ? ' number had zero calls this range' : ' numbers had zero calls this range') + ' — tagged Unused as cleanup candidates.')
        )
      : null,
    tnView === 'graphs'
      ? h(TelephoneNumbersGraphs, {
          charts,
          numbers,
          /*
           * A DID bar counts inbound + missed calls to that number, which is
           * metric 'incoming' (inbound + missed), scoped by the number.
           */
          onNumberClick: number => {
            if (onCallClick && number) onCallClick({ phoneNumber: number, callerNumber: null, metric: 'incoming' });
          }
        })
      : tnView === 'simultaneous'
      ? h(SimultaneousCallsPanel, { filters, onCallClick })
      : tnView === 'repeats'
      ? h('div', {className:'border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400'},
          (repeatCallers.length ? repeatCallers.length + ' repeat callers' : 'No repeat callers in this range.')
        )
      : h('div', null,
          h('div', {className:'tn-toolbar'},
            h('input', {
              value: search,
              onChange: e => setSearch(e.target.value),
              placeholder: 'Search number, destination, extension, department or site…',
              className: 'min-w-0 flex-1 border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400'
            }),
            h('select', {
              value: typeFilter,
              title: 'Filter by number type',
              onChange: e => setTypeFilter(e.target.value),
              className: 'tn-type-filter'
            },
              h('option', {value: 'all'}, 'All types'),
              h('option', {value: 'local'}, 'Local DID'),
              h('option', {value: 'tollfree'}, 'Toll-Free')
            ),
            h('button', {
              type: 'button',
              title: 'Hide numbers with zero calls in this range',
              onClick: () => setHideZeroCalls(v => !v),
              className: 'tn-active-filter ' + (hideZeroCalls ? 'is-on' : '')
            }, 'Active only')
          ),
          h(TelephoneNumbersTable, {
            data: visibleNumbers,
            loading: false,
            filters,
            onTelephoneClick: phone => {
              const number = phone?.number || phone?.phoneNumber || '';
              if (onCallClick && number) onCallClick({ phoneNumber: number, metric: 'incoming' });
            }
          })
        )
  );
}

export { TelephoneNumbers, telephoneDestinationType };
