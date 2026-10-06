/* Chart primitives: the gradient helper, the sparkline builder, KPI cards and the donut.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { Tooltip } from './ui.js';
import { fmtNum } from '../lib/format.js';
import { h, useEffect, useRef } from '../lib/react.js';

const hexToRgba = (hex, alpha = 1) => {
    let x = String(hex || '').trim().replace('#', '');
    if (x.length === 3) x = x.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(x)) return hex;
    const n = parseInt(x, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

const splineArea = (canvasEl, color, data, extra) => {
    let fill = hexToRgba(color, 0.28);
    try {
      const ctx = canvasEl && canvasEl.getContext && canvasEl.getContext('2d');
      if (ctx) {
        const g = ctx.createLinearGradient(0, 0, 0, canvasEl.clientHeight || 200);
        g.addColorStop(0, hexToRgba(color, 0.30));
        g.addColorStop(1, hexToRgba(color, 0.02));
        fill = g;
      }
    } catch (e) { /* keep the flat fallback */ }
    return Object.assign({
      data,
      borderColor: color,
      backgroundColor: fill,
      fill: true,
      tension: 0.4,
      cubicInterpolationMode: 'monotone',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBackgroundColor: color,
      pointHoverBorderColor: '#0b1220'
    }, extra || {});
  };

function DonutChart({title, hint, center, slices, onSlice}) {
  const canvas = useRef(null);
  const chart = useRef(null);
  const colors = ['#22d3ee','#34d399','#f87171','#a78bfa','#fbbf24','#60a5fa'];
  const sliceKey = slices.map(x => x.label + ':' + x.value).join('|');

  useEffect(() => {
    if (!canvas.current) return;
    chart.current?.destroy();
    chart.current = new Chart(canvas.current, {
      type: 'doughnut',
      data: {
        labels: slices.map(x => x.label),
        datasets: [{
          data: slices.map(x => x.value),
          backgroundColor: slices.map((x,i) => x.color || colors[i % colors.length]),
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        onHover: (event, elements) => {
          const t = event?.native?.target;
          if (t) t.style.cursor = (onSlice && elements && elements.length) ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: item => {
                const tot = item.dataset.data.reduce((a, b) => a + Number(b || 0), 0);
                const n = Number(item.raw || 0);
                const pct = tot ? ((n / tot) * 100).toFixed(1) + '%' : '0%';
                return ' ' + item.label + ': ' + n.toLocaleString() + ' (' + pct + ')';
              }
            }
          }
        },
        onClick: (evt, els) => {
          if (!els.length || typeof onSlice !== 'function') return;
          onSlice(slices[els[0].index]);
        }
      }
    });
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [sliceKey]);

  const total = slices.reduce((a,b) => a + Number(b.value||0), 0);

  return h('section', {className:'dash-card dash-donut'},
    h('h2', {className:'dash-label flex items-center gap-1.5'},
      title,
      hint ? h(Tooltip, {text: hint}, h('span', {className:'cursor-help border-b border-dotted border-slate-600 text-[10px] font-normal text-slate-500'}, '?')) : null
    ),
    h('div', {className:'relative mx-auto h-[132px] w-[132px] ' + (onSlice ? 'cursor-pointer' : '')},
      h('canvas', {ref: canvas}),
      h('div', {className:'pointer-events-none absolute inset-0 grid place-items-center text-center'},
        h('div', null,
          h('div', {className:'text-lg font-semibold text-slate-100'}, center != null ? center : fmtNum(total)),
          h('div', {className:'text-[10px] uppercase text-slate-500'}, 'total')
        )
      )
    ),
    h('div', {className:'mt-2 space-y-0.5'},
      ...slices.map((sl, i) => h(onSlice ? 'button' : 'div', {
        key: sl.label,
        type: onSlice ? 'button' : undefined,
        onClick: onSlice ? () => onSlice(sl) : undefined,
        className: 'flex w-full items-center justify-between text-xs text-slate-400 ' + (onSlice ? 'cursor-pointer hover:text-slate-100' : '')
      },
        h('span', {className:'flex items-center gap-2'},
          h('span', {className:'inline-block h-2 w-2 rounded-full', style:{background: sl.color || colors[i % colors.length]}}),
          sl.label
        ),
        h('span', {className:'font-medium text-slate-200'}, fmtNum(sl.value))
      ))
    )
  );
}

function KpiCard({label, value, hint, tooltip, onClick, accent, delta, icon, tone}) {
  const deltaNum = delta == null || delta === '' ? null : Number(delta);
  const deltaText = deltaNum == null || Number.isNaN(deltaNum) ? null
    : ((deltaNum > 0 ? '+' : '') + deltaNum.toFixed(1) + '%');
  const deltaColor = deltaNum == null || Number.isNaN(deltaNum) || Math.abs(deltaNum) < 0.05 ? 'text-slate-500'
    : (deltaNum > 0 ? 'text-emerald-400' : 'text-rose-400');
  const acc = String(accent || '');
  const isBad = tone === 'bad' || acc.includes('rose') || acc.includes('over') || acc.includes('sla-ring-over');
  const valCls = isBad ? 'is-bad' : (tone === 'good' || acc.includes('emerald') || acc.includes('sla-ring-ok') ? 'is-good' : '');
  return h('button', {
    type:'button',
    onClick,
    disabled: !onClick,
    title: tooltip || '',
    className:'kpi-card kpi-flat text-left ' +
      (onClick ? 'kpi-click cursor-pointer' : 'cursor-default') +
      (isBad ? ' is-bad' : '')
  },
    h('div', {className:'kpi-head'},
      icon ? h('span', {className:'kpi-ico' + (isBad ? ' is-bad' : '')}, h('i', {className: icon, 'aria-hidden': 'true'})) : null,
      h('span', {className:'kpi-label'}, label),
      tooltip ? h(Tooltip, {text: tooltip}, h('span', {className:'qs-i cursor-help'}, 'i')) : null
    ),
    /*
     * The delta sits inline beside the value. It used to live in
     * .kpi-hint, which is pinned bottom-right — the same corner as the
     * "View →" affordance drawn by .kpi-card.kpi-click::after, so the
     * two overlapped on any clickable card that had a comparison.
     */
    h('div', {className:'kpi-valrow'},
      h('div', {className:'kpi-value ' + valCls + ' ' + (accent || '')}, typeof value === 'number' ? fmtNum(value) : value),
      deltaText ? h('span', {className: 'kpi-delta ' + deltaColor}, deltaText) : null
    ),
    hint
      ? h('div', {className:'kpi-hint'}, h('span', {className:'truncate'}, hint))
      : null
  );
}

export { DonutChart, KpiCard, splineArea };
