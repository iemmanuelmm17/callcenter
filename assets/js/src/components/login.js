/* Login screen and the alerts bell.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { ThemeToggle } from './ui.js';
import { api } from '../lib/api.js';
import { h, useEffect, useRef, useState } from '../lib/react.js';

function AlertsBell({filters, onOpenItem}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const wrap = useRef(null);
  const load = () => {
    setLoading(true);
    api('alerts', {...filters}).then(r => {
      const d = r && r.data ? r.data : r;
      setItems(Array.isArray(d && d.items) ? d.items : (Array.isArray(r.items) ? r.items : []));
    }).catch(() => setItems([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [filters.start, filters.end]);
  useEffect(() => {
    if (!open) return;
    const close = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const count = items.length;
  const kindLab = k => k === 'queue' ? 'Queue' : (k === 'aa' ? 'Auto-attendant' : 'User');
  const panel = open ? h('div', { className: 'fb-bell-panel' },
    h('div', { className: 'fb-bell-head' }, 'Notifications'),
    h('div', { className: 'fb-bell-list' },
      loading ? h('div', { className: 'fb-bell-empty' }, 'Checking thresholds…')
        : (count === 0
            ? h('div', { className: 'fb-bell-empty' }, 'No users, queues, or auto-attendants over threshold in this range.')
            : items.map((it, i) => h('button', {
                key: i,
                type: 'button',
                className: 'fb-bell-item is-click',
                title: 'Open ' + kindLab(it.kind) + ' details',
                onClick: () => { setOpen(false); onOpenItem && onOpenItem(it); }
              },
                h('div', { className: 'fb-bell-kind' }, kindLab(it.kind)),
                h('div', { className: 'fb-bell-name' }, it.name + (it.id ? ' · ' + it.id : '')),
                ...(it.reasons || []).map((r, j) => h('div', { key: j, className: 'fb-bell-reason' }, r))
              )))
    )
  ) : null;
  return h('div', { ref: wrap, className: 'fb-bell-wrap' },
    h('button', {
      type: 'button',
      className: 'fb-bell' + (count ? ' has-unread' : ''),
      title: 'Threshold alerts',
      onClick: () => { setOpen(o => !o); if (!open) load(); }
    },
      h('i', { className: 'fa-solid fa-bell' }),
      count ? h('span', { className: 'fb-bell-badge' }, count > 9 ? '9+' : String(count)) : null
    ),
    panel
  );
}

function Login({onLogin}) {
    const [form,setForm]=useState({username:'',password:''}), [error,setError]=useState(''), [busy,setBusy]=useState(false);
    const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{onLogin(await api('login',form));}catch(err){setError(err.message)}finally{setBusy(false)}};
    return h('main',{className:'relative min-h-screen grid place-items-center p-4'},
      h('div',{className:'absolute', style:{top:16, right:16}}, h(ThemeToggle)),
      h('form',{onSubmit:submit,className:'w-full max-w-sm border border-slate-700 bg-slate-900 p-5 shadow-2xl'},
      h('div',{className:'mb-5'},h('div',{className:'text-accent text-xs font-bold tracking-[.25em]'},'CALLSCOPE'),h('h1',{className:'text-lg font-semibold text-slate-100 mt-1'},'Call center reporting'),h('p',{className:'mt-1 text-xs text-slate-400'},'Use your PBX credentials to start a secured session.')),
      [['username','Username','text'],['password','Password','password']].map(([key,label,type])=>h('label',{className:'block mb-3',key},h('span',{className:'text-xs text-slate-400'},label),h('input',{required:true,type,value:form[key],onChange:e=>setForm({...form,[key]:e.target.value}),className:'mt-1 w-full rounded-sm border border-slate-700 bg-slate-950 px-2.5 py-2 outline-none focus:border-cyan-400'}))),
      error&&h('p',{className:'mb-3 border border-rose-900 bg-rose-950/50 p-2 text-xs text-rose-300'},error),h('button',{disabled:busy,className:'w-full rounded-sm bg-cyan-500 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60'},busy?'Signing in…':'Sign in')));
  }

export { AlertsBell, Login };
