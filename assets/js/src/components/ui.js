/* Shared UI atoms: icons, skeletons, tooltips, toasts, pills and the theme toggle.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { h, useEffect, useRef, useState } from '../lib/react.js';
import { writeSlaSeconds } from '../lib/sla.js';
import { applyTheme, readTheme } from '../lib/theme.js';

function SlaControl({value, onChange}) {
    return h('label', {className:'sla-control', title:'Answered within this many seconds of ringing meets SLA. Used system-wide.'},
      h('span', {className:'sla-control-label'}, 'SLA max ring'),
      h('input', {
        type:'number', min:5, max:120, step:1,
        className:'sla-control-input',
        value,
        onChange: e => onChange(writeSlaSeconds(e.target.value))
      }),
      h('span', {className:'sla-control-unit'}, 'sec')
    );
  }

function NavIcon({name, className = 'h-4 w-4', size}) {
  const paths = {
    dashboard: [
      'M0 0h1v15h15v1H0V0zm14.817 3.113a.5.5 0 0 1 .07.704l-4.5 5.5a.5.5 0 0 1-.74.037L7.06 6.767l-3.656 5.027a.5.5 0 0 1-.808-.588l4-5.5a.5.5 0 0 1 .758-.06l2.609 2.61 4.15-5.073a.5.5 0 0 1 .704-.07z'
    ],
    agents: [
      'M8 1a5 5 0 0 0-5 5v4.5H2V6a6 6 0 1 1 12 0v4.5h-1V6a5 5 0 0 0-5-5z',
      'M11 8a1 1 0 0 1 1-1h2v1a2 2 0 0 1-2 2h-.5a.5.5 0 0 1 0-1H12a1 1 0 0 0 1-1V8h-1a1 1 0 0 1-1-1zM5 8a1 1 0 0 0-1-1H2v1a2 2 0 0 0 2 2h.5a.5.5 0 0 0 0-1H4a1 1 0 0 1-1-1V8h1a1 1 0 0 0 1-1z'
    ],
    queues: [
      'M2.5 3.5a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1h-11zm0 5a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1h-11zm0 5a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1h-11z',
      'M.5 3.5a.5.5 0 0 1 0-1 .5.5 0 0 1 0 1zm0 5a.5.5 0 0 1 0-1 .5.5 0 0 1 0 1zm0 5a.5.5 0 0 1 0-1 .5.5 0 0 1 0 1z'
    ],
    phone: [
      'M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.568 17.568 0 0 0 4.168 6.608 17.569 17.569 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328z'
    ],
    attendants: [
      'M6 3.5A1.5 1.5 0 0 1 7.5 2h1A1.5 1.5 0 0 1 10 3.5v1A1.5 1.5 0 0 1 8.5 6v1H11a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0V8h-5v.5a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 5 7h2.5V6A1.5 1.5 0 0 1 6 4.5v-1zM8.5 5a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1zM3 11.5A1.5 1.5 0 0 1 4.5 10h1A1.5 1.5 0 0 1 7 11.5v1A1.5 1.5 0 0 1 5.5 14h-1A1.5 1.5 0 0 1 3 12.5v-1zm1.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1zm4.5.5A1.5 1.5 0 0 1 10.5 10h1a1.5 1.5 0 0 1 1.5 1.5v1a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 9 12.5v-1zm1.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1z'
    ],
    play: [
      'M5.5 3.5v9l7-4.5-7-4.5z'
    ],
    stop: [
      'M5 5h6v6H5z'
    ],
    pause: [
      'M5 3.5h2.2v9H5zM8.8 3.5H11v9H8.8z'
    ],
    download: [
      'M8 1.5a.5.5 0 0 1 .5.5v6.8l2.15-2.15a.5.5 0 1 1 .7.7l-3 3a.5.5 0 0 1-.7 0l-3-3a.5.5 0 1 1 .7-.7L7.5 8.8V2a.5.5 0 0 1 .5-.5z',
      'M2.5 9.5a.5.5 0 0 1 .5.5v2.5h10V10a.5.5 0 0 1 1 0v2.6a.9.9 0 0 1-.9.9H2.9a.9.9 0 0 1-.9-.9V10a.5.5 0 0 1 .5-.5z'
    ],
    chevronUp: [
      'M7.65 5.15a.5.5 0 0 1 .7 0l4 4a.5.5 0 0 1-.7.7L8 6.21 4.35 9.85a.5.5 0 1 1-.7-.7l4-4z'
    ],
    sun: [
      'M8 4.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5zM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6.5-2a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1A.5.5 0 0 1 3 8zM8 12.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 1 .5-.5z'
    ],
    settings: [
      'M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z',
      'M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319z'
    ],
    moon: [
      'M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z'
    ]
  };
  const d = paths[name] || paths.dashboard;
  const px = size || 16;
  return h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    width: px,
    height: px,
    className,
    'aria-hidden': 'true',
    style: size ? {width: px, height: px, display: 'block'} : undefined
  }, ...d.map((p, i) => h('path', {key: i, d: p})));
}

function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  const isDark = theme !== 'light';
  return h('button', {
    type: 'button',
    title: isDark ? 'Switch to light mode' : 'Switch to dark mode',
    onClick: () => {
      const next = isDark ? 'light' : 'dark';
      applyTheme(next);
      setTheme(next);
    },
    className: 'theme-toggle'
  },
    h('span', {className: 'theme-toggle-knob'},
      h(NavIcon, {name: isDark ? 'moon' : 'sun', size: 12, className: ''})
    ),
    isDark ? 'Night' : 'Day'
  );
}

const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'agents', label: 'Agents', icon: 'agents' },
    { id: 'queues', label: 'Queues', icon: 'queues' },
    { id: 'telephone_numbers', label: 'Telephone Numbers', icon: 'phone' },
    { id: 'attendants', label: 'Auto-Attendants', icon: 'attendants' },
    { id: 'call_history', label: 'Call History', icon: 'history' },
];

function flowFaIcon(classes) {
  const c = ' ' + String(classes || '').toLowerCase() + ' ';
  if (c.includes('ctg-hang-up') || c.includes('hang-up') || c.includes('hangup')) return 'fa-solid fa-phone-slash';
  if (c.includes('ctg-answer') || c.includes('answer')) return 'fa-solid fa-phone';
  if (c.includes('ctg-queue') || c.includes('queue')) return 'fa-solid fa-ellipsis';
  if (c.includes('ctg-ringing') || c.includes('ctg-ring') || c.includes('ring')) return 'fa-solid fa-bell';
  if (c.includes('ctg-hold') || c.includes('hold')) return 'fa-solid fa-pause';
  if (c.includes('ctg-vmail') || c.includes('voicemail') || c.includes('vmail')) return 'fa-solid fa-voicemail';
  if (c.includes('ctg-record') || c.includes('record')) return 'fa-solid fa-circle';
  if (c.includes('ctg-call') || c.includes('call-from') || c.includes('callback')) return 'fa-solid fa-phone-flip';
  if (c.includes('ctg-transfer') || c.includes('transfer')) return 'fa-solid fa-arrow-right-arrow-left';
  return 'fa-solid fa-circle';
}

function FlowKindIcon({classes}) {
  const cls = flowFaIcon(classes);
  const kind = cls.split(' ').pop().replace('fa-', '');
  return h('span', {className: 'hist-flow-ico hist-flow-ico-' + kind, title: String(classes || '')},
    h('i', {className: cls, 'aria-hidden': 'true'})
  );
}

function ToastHost({toasts, onDismiss}) {
  if (!toasts.length) return null;
  return ReactDOM.createPortal(
    h('div', {className: 'toast-wrap', role: 'status', 'aria-live': 'polite'},
      ...toasts.map(t => h('div', {key: t.id, className: 'toast is-' + (t.kind || 'ok')},
        h('span', {className: 'toast-ico', 'aria-hidden': 'true'},
          h('i', {className: t.kind === 'error' ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check'})),
        h('div', {className: 'toast-body'},
          h('div', {className: 'toast-title'}, t.title),
          t.message ? h('div', {className: 'toast-msg'}, t.message) : null
        ),
        h('button', {
          type: 'button',
          className: 'toast-x',
          'aria-label': 'Dismiss notification',
          onClick: () => onDismiss(t.id)
        }, '\u00d7')
      ))
    ),
    document.body
  );
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});
  const dismiss = React.useCallback(id => {
    setToasts(list => list.filter(t => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);
  const push = React.useCallback((kind, title, message) => {
    const id = 't' + Date.now() + Math.random().toString(36).slice(2, 7);
    setToasts(list => [...list, {id, kind, title, message}]);
    /* Errors stay until dismissed; successes clear themselves. */
    if (kind !== 'error') {
      timers.current[id] = setTimeout(() => dismiss(id), 4000);
    }
    return id;
  }, [dismiss]);
  /* Clear any pending timers if the host unmounts. */
  useEffect(() => () => {
    Object.values(timers.current).forEach(clearTimeout);
    timers.current = {};
  }, []);
  return {toasts, push, dismiss};
}

function skel(cls) {
    return h('div', {className: 'skeleton-shimmer rounded ' + cls});
}

function skelKpis(n) {
    return h('section', {className: 'dash-kpi'},
        ...Array.from({length: n}, (_, i) => h('div', {key: i, className: 'kpi-card'},
            skel('h-3 w-16'),
            skel('mt-3 h-6 w-20'),
            skel('mt-2 h-2 w-24')
        ))
    );
}

function skelPanel(heightCls, extra) {
    return h('section', {className: 'dash-card ' + (extra || '')},
        skel('h-3 w-28'),
        skel('mt-3 ' + (heightCls || 'h-40'))
    );
}

function Tooltip({text, children, className = ''}) {
    const [visible, setVisible] = useState(false);
    const triggerRef = useRef(null);

    const [position, setPosition] = useState({
        top: 0,
        left: 0
    });

    useEffect(() => {
        if (!visible || !triggerRef.current) {
            return;
        }

        const rect =
            triggerRef.current.getBoundingClientRect();

        setPosition({
            top: rect.top - 8,
            left: rect.left + rect.width / 2
        });
    }, [visible]);

    return h(
        'span',
        {
            ref: triggerRef,

            className:
                ` inline-flex ${className}`,

            onMouseEnter: () =>
                setVisible(true),

            onMouseLeave: () =>
                setVisible(false)
        },

        children,

        visible &&
            h(
                'span',
                {
                    style: {
                        position: 'fixed',
                        top: position.top,
                        left: position.left,
                        transform: 'translate(-50%, -100%)',
                        zIndex: 999999
                    },

                    className:
                        'max-w-xs whitespace-normal rounded-sm border border-slate-600 bg-slate-950 px-2 py-1.5 text-[10px] font-normal normal-case tracking-normal text-slate-200 shadow-xl pointer-events-none'
                },

                text
            )
    );
}

function SearchableSelect({value, onChange, options, placeholder, accent}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef(null);
  const input = useRef(null);
  const selected = (options || []).find(o => String(o.value) === String(value));
  const q = query.trim().toLowerCase();
  const visible = (options || []).filter(o => {
    if (!q) return true;
    return String(o.label || '').toLowerCase().includes(q) || String(o.value || '').toLowerCase().includes(q);
  }).slice(0, 80);

  useEffect(() => {
    if (!open) return;
    const close = e => {
      if (wrap.current && !wrap.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open && input.current) input.current.focus();
  }, [open]);

  const border = accent === 'orange' ? 'focus-within:border-orange-500' : 'focus-within:border-cyan-400';
  const chip = accent === 'orange' ? 'cmp-chip-orange' : 'cmp-chip-blue';

  return h('div', {ref: wrap, className: 'relative min-w-0 flex-1'},
    h('button', {
      type: 'button',
      onClick: () => setOpen(o => !o),
      className: 'cmp-select-btn ' + (open ? 'is-open ' : '') + border
    },
      h('span', {className: 'min-w-0 truncate text-left'},
        selected
          ? [h('span', {key: 'n', className: 'text-slate-100'}, selected.label),
             h('span', {key: 'e', className: 'ml-1 text-slate-500'}, selected.value)]
          : h('span', {className: 'text-slate-500'}, placeholder || 'Select…')
      ),
      h('span', {className: 'ml-auto shrink-0 text-slate-500'}, open ? '▴' : '▾')
    ),
    open ? h('div', {className: 'cmp-select-menu'},
      h('input', {
        ref: input,
        value: query,
        onChange: e => setQuery(e.target.value),
        placeholder: 'Type to search name or extension…',
        className: 'cmp-select-search'
      }),
      h('div', {className: 'cmp-select-list'},
        visible.length === 0
          ? h('div', {className: 'px-2 py-3 text-xs text-slate-500'}, 'No matches.')
          : visible.map(o => h('button', {
              key: o.value,
              type: 'button',
              onClick: () => {
                onChange(String(o.value));
                setOpen(false);
                setQuery('');
              },
              className: 'cmp-select-option ' + (String(o.value) === String(value) ? chip : '')
            },
              h('span', {className: 'block truncate text-slate-100'}, o.label),
              h('span', {className: 'text-[10px] text-slate-500'}, o.value)
            ))
      )
    ) : null
  );
}

/*
 * The one error block (QA-9).
 *
 * Five panels repeated this markup inline, two of them with different wording
 * ("Failed to load..." vs "Unable to load..."), and none offered a retry — a
 * transient PBX failure meant reloading the whole page.
 */
function ErrorState({message, onRetry, className = ''}) {
  return h(
    'div',
    {
      role: 'alert',
      className:
        'border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300 ' +
        className
    },
    h('span', null, message || 'Unable to load this panel.'),
    typeof onRetry === 'function'
      ? h(
          'button',
          {
            type: 'button',
            className:
              'ml-3 font-semibold text-rose-200 underline hover:text-rose-100',
            onClick: onRetry
          },
          'Retry'
        )
      : null
  );
}

function CallTypeIcon({type, size = 14}) {
  const t = String(type || '').toLowerCase();
  const phone = 'M1.885.511a1.745 1.745 0 0 1 2.612.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.678.678 0 0 0 .178.643l2.457 2.457a.678.678 0 0 0 .644.178l2.189-.547a1.745 1.745 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.634 18.634 0 0 1-7.01-4.42 18.634 18.634 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877L1.885.511z';
  const inboundArrow = 'M15.854.146a.5.5 0 0 1 0 .708L11.707 5H14.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 1 0v2.793L15.146.146a.5.5 0 0 1 .708 0z';
  const outboundArrow = 'M11.5 1a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2.707l-4.146 4.147a.5.5 0 0 1-.708-.708L14.293 2H12a.5.5 0 0 1-.5-.5z';
  const missed = 'M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.57 17.57 0 0 0 4.168 6.608 17.57 17.57 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328zM13.78.22a.75.75 0 0 1 0 1.06L4.28 10.78a.75.75 0 1 1-1.06-1.06L12.72.22a.75.75 0 0 1 1.06 0z';
  let color = '#94a3b8';
  let label = 'Call';
  let paths = [phone];
  if (t === 'inbound' || t === 'incoming') { color = '#38bdf8'; label = 'Inbound'; paths = [phone, inboundArrow]; }
  else if (t === 'outbound' || t === 'outgoing') { color = '#34d399'; label = 'Outbound'; paths = [phone, outboundArrow]; }
  else if (t === 'missed') { color = '#f87171'; label = 'Missed'; paths = [missed]; }
  else if (t === 'onnet') { color = '#a78bfa'; label = 'On-net'; paths = [phone]; }
  return h('span', {
    className: 'call-type-icon',
    title: label,
    style: { color, width: size, height: size, display: 'inline-flex', flexShrink: 0 }
  },
    h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 16 16', fill: 'currentColor', width: size, height: size, 'aria-hidden': 'true' },
      ...paths.map((d, i) => h('path', {key: i, d})))
  );
}

export { CallTypeIcon, ErrorState, FlowKindIcon, NavIcon, SearchableSelect, SlaControl, ThemeToggle, ToastHost, Tooltip, navItems, skel, skelKpis, skelPanel, useToasts };
