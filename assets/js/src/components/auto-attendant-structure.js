/* Auto-attendant option tree.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { telephoneDestinationType } from './telephone-numbers.js';
import { Tooltip } from './ui.js';
import { h, useEffect, useRef, useState } from '../lib/react.js';
import { formatCallDate } from '../lib/time.js';

function AutoAttendantStructure({selected, structures, data, onShowCalls}) {
  const audioRef = useRef(null);
  const [playingId, setPlayingId] = useState('');
  const [audioTime, setAudioTime] = useState(0);
  const [audioDur, setAudioDur] = useState(0);
  const ext = selected[0] || '';
  const structKeys = structures && typeof structures === 'object' ? Object.keys(structures) : [];
  const tree = (structures && (
    structures[ext]
    || structures[String(ext)]
    || structures[String(Number(ext))]
    || (structKeys.find(k => String(k) === String(ext)) ? structures[structKeys.find(k => String(k) === String(ext))] : null)
  )) || null;
  let prompts = Array.isArray(tree?.prompts) ? tree.prompts : [];
  if (!prompts.length && Array.isArray(data)) {
    const byPrompt = {};
    data.filter(c => String(c.extension || '') === String(ext)).forEach(c => {
      const pid = String(c.prompt || c.additionalPrompt || '').trim();
      if (!pid) return;
      if (!byPrompt[pid]) {
        byPrompt[pid] = {id: pid, name: pid, starting: !c.additionalPrompt, parentPrompt: '', parentOption: '', options: {}, audioUrl: '', audioFilename: '', audioDuration: 0};
      }
      const digit = String(c.case || c.additionalCase || '').trim();
      if (digit && !byPrompt[pid].options[digit]) {
        byPrompt[pid].options[digit] = {
          digit,
          description: c.optionDescription || ('Option ' + digit),
          destinationApplication: c.destinationApplication || '',
          destinationUser: c.destinationUser || c.destination || '',
          nextPrompt: c.nextPrompt || c.additionalPrompt || ''
        };
      }
    });
    prompts = Object.values(byPrompt).map(p => ({
      ...p,
      options: Object.values(p.options).sort((a, b) => String(a.digit).localeCompare(String(b.digit), undefined, {numeric: true}))
    }));
  }
  const byId = {};
  prompts.forEach(p => { byId[p.id] = p; byId[String(p.id).toLowerCase()] = p; });

  const childrenOf = {};
  prompts.forEach(p => {
    const parent = String(p.parentPrompt || '').trim();
    if (!parent) return;
    const key = parent + '|' + String(p.parentOption || '').trim();
    (childrenOf[key] || (childrenOf[key] = [])).push(p);
  });

  const calls = Array.isArray(data)
    ? data.filter(c => String(c.extension || '') === String(ext))
    : [];

  const talkOf = c => Number(c.talkSeconds || c['call-talking-duration-seconds'] || 0) || 0;
  const destOf = c => String(c.destination || '').trim();
  const throughOf = c => String(c.throughUser || c.queue || c['call-through-user'] || '').trim();
  const termOf = c => String(c.termUser || c['call-term-user'] || destOf(c)).trim();
  const isAbandon = c => {
    if (c && c.abandoned === true) return true;
    const through = throughOf(c);
    const term = termOf(c);
    if (through && term && through === term) return true;
    const dest = destOf(c);
    return dest !== '' && dest !== '-' && String(dest) === String(ext);
  };

  const classifyOutcome = (call, hasDigit) => {
    const reason = String(call.disconnectReason || call['call-disconnect-reason-text'] || '').trim();
    if (/invalid\s*dtmf|invalid digit|unknown digit|wrong digit|bad dtmf|unrecognized/i.test(reason)) return 'invalid';
    if (/time\s*-?\s*out|timed\s*out|max wait|expired|no\s*input/i.test(reason) && !/no digit/i.test(reason)) return 'timeout';
    if (/no digit/i.test(reason)) return 'nodigit';
    if (!hasDigit) {
      if (/time\s*-?\s*out|timed\s*out|max wait|expired/i.test(reason)) return 'timeout';
      return 'nodigit';
    }
    return 'ok';
  };

  const menuDigits = prompt => new Set((prompt.options || []).map(o => String(o.digit)));

  const isDialByExt = (call, prompt) => {
    const d = String(call.case || '').trim() || String(call.additionalCase || '').trim();
    if (!d) return false;
    if (menuDigits(prompt).has(d)) return false;
    const app = String(call.destinationApplication || '').toLowerCase();
    if (/dial.?by.?ext|to-user|extension/.test(app) && d.length >= 2) return true;
    return d.length >= 2;
  };

  const dialSuccess = call => {
    if (isAbandon(call)) return false;
    const dest = destOf(call);
    return talkOf(call) > 0 || (dest !== '' && dest !== '-' && dest !== String(ext));
  };

  const statsForPrompt = (prompt, isNested) => {
    const pid = String(prompt.id || '').toLowerCase();
    const relevant = calls.filter(c => {
      const addP = String(c.additionalPrompt || '').toLowerCase();
      if (isNested) return addP === pid;
      return true;
    });
    const digits = {};
    const digitCalls = {};
    let nodigit = 0, timeout = 0, invalid = 0, abandon = 0;
    const dialOk = [], dialFail = [];
    const dropCalls = [], timeoutCalls = [], invalidCalls = [], abandonCalls = [];
    relevant.forEach(c => {
      if (isAbandon(c)) { abandon++; abandonCalls.push(c); return; }
      const digit = isNested
        ? String(c.additionalCase || '').trim()
        : String(c.case || '').trim();
      if (isDialByExt(c, prompt)) {
        if (dialSuccess(c)) dialOk.push(c);
        else dialFail.push(c);
        return;
      }
      const outcome = classifyOutcome(c, !!digit);
      if (outcome === 'invalid' || (digit && digit.length === 1 && !menuDigits(prompt).has(digit))) {
        invalid++; invalidCalls.push(c); return;
      }
      if (outcome === 'timeout') { timeout++; timeoutCalls.push(c); return; }
      if (outcome === 'nodigit' || !digit) { nodigit++; dropCalls.push(c); return; }
      digits[digit] = (digits[digit] || 0) + 1;
      (digitCalls[digit] || (digitCalls[digit] = [])).push(c);
    });
    return { total: relevant.length, digits, digitCalls, nodigit, timeout, invalid, abandon, dialOk, dialFail, dropCalls, timeoutCalls, invalidCalls, abandonCalls, relevant };
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlayingId('');
    setAudioTime(0);
  };

  const playPrompt = (event, prompt) => {
    if (event) event.stopPropagation();
    const url = String(prompt.audioUrl || '').trim();
    if (!url) return;
    if (playingId === prompt.id) {
      stopAudio();
      return;
    }
    stopAudio();
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingId(prompt.id);
    audio.ontimeupdate = () => setAudioTime(audio.currentTime || 0);
    audio.onloadedmetadata = () => setAudioDur(audio.duration || prompt.audioDuration || 0);
    audio.play().catch(() => stopAudio());
    audio.onended = () => stopAudio();
    audio.onerror = () => stopAudio();
  };

  useEffect(() => () => stopAudio(), []);

  const destKind = opt => {
    const app = String(opt.destinationApplication || '').toLowerCase();
    if (opt.nextPrompt) return 'aa';
    if (app.includes('queue')) return 'queue';
    if (app.includes('voicemail')) return 'vm';
    if (app.includes('user') || app.includes('device')) return 'user';
    if (/hang|disconnect|bye|unavailable/.test(app)) return 'drop';
    if (/dial/.test(app)) return 'dial';
    return 'other';
  };

  const destIcon = kind => {
    const map = {
      queue: '☎',
      aa: '↻',
      vm: '✉',
      user: '☺',
      drop: '!',
      dial: '#',
      other: '→'
    };
    return map[kind] || '→';
  };

  const destTitle = opt => {
    const kind = destKind(opt);
    const app = telephoneDestinationType(opt.destinationApplication) || opt.destinationApplication || '';
    const user = opt.destinationUser || '';
    if (opt.nextPrompt) return 'Additional AA · ' + opt.nextPrompt;
    if (kind === 'queue') return 'Queue: ' + (user || app);
    if (kind === 'vm') return 'Voicemail' + (user ? ' · ' + user : '');
    if (kind === 'user') return (app || 'User') + (user ? ' · ' + user : '');
    return [app, user].filter(Boolean).join(' · ') || 'Destination';
  };

  const cleanDest = opt => {
    const raw = destTitle(opt);
    const digit = String(opt.digit || '');
    return raw.replace(new RegExp('^' + digit + '\\s+'), '').replace(/^AA designer\s*/i, '').trim() || raw;
  };

  const mmss = n => {
    const s = Math.max(0, Math.floor(Number(n) || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  const waveBars = (prompt) => {
    const seed = String(prompt.audioFilename || prompt.id || 'g');
    const n = 28;
    const bars = [];
    for (let i = 0; i < n; i++) {
      const hgt = 18 + ((seed.charCodeAt(i % seed.length) * (i + 3)) % 42);
      bars.push(hgt);
    }
    const dur = audioDur || prompt.audioDuration || 1;
    const progress = playingId === prompt.id ? Math.min(1, audioTime / dur) : 0;
    return h('div', {className:'aa-wave', 'aria-hidden':'true'},
      ...bars.map((ht, i) => h('span', {
        key: i,
        className: 'aa-wave-bar' + ((i / n) <= progress && playingId === prompt.id ? ' is-on' : ''),
        style: {height: ht + '%'}
      }))
    );
  };

  const sparkline = values => {
    const nums = values.length ? values : [0];
    const max = Math.max(1, ...nums);
    const w = 120, ht = 36, pad = 2;
    const step = nums.length > 1 ? (w - pad * 2) / (nums.length - 1) : 0;
    const pts = nums.map((v, i) => {
      const x = pad + i * step;
      const y = ht - pad - ((v / max) * (ht - pad * 2));
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return h('svg', {className:'aa-spark', viewBox:'0 0 ' + w + ' ' + ht, width: w, height: ht},
      h('polyline', {fill:'none', stroke:'#22d3ee', strokeWidth:'1.6', points: pts})
    );
  };

  const showCalls = (title, rows) => {
    if (typeof onShowCalls === 'function') onShowCalls({title, rows: rows || []});
  };

  const flowRow = (key, keycap, label, dest, count, total, color, rows, kind, hover) => {
    const pct = total ? ((count / total) * 100).toFixed(1) + '%' : '0.0%';
    const bar = total ? Math.round((count / Math.max(1, total)) * 100) : 0;
    return h('button', {
      key,
      type: 'button',
      title: hover || label,
      onClick: () => showCalls(label, rows),
      className: 'aa-flow-row'
    },
      h('span', {className:'aa-keycap'}, keycap),
      h('span', {className:'aa-flow-line', 'aria-hidden':'true'}),
      h('span', {className:'aa-dest-box aa-dest-' + (kind || 'other')},
        h('span', {className:'aa-dest-ico', title: kind || 'destination'}, destIcon(kind)),
        h('span', {className:'aa-dest-text'}, dest)
      ),
      h('span', {className:'aa-flow-metric'},
        h('span', {className:'font-semibold text-slate-100'}, count.toLocaleString()),
        h('span', {className:'text-slate-500'}, pct),
        h('span', {className:'aa-mini-track'}, h('span', {className:'aa-mini-fill', style:{width: bar + '%', background: color || '#22d3ee'}}))
      )
    );
  };

  const renderPrompt = (prompt, depth, visited) => {
    if (!prompt || visited[prompt.id]) return null;
    visited[prompt.id] = true;
    const isNested = depth > 0 || !!prompt.parentPrompt;
    const stats = statsForPrompt(prompt, isNested);
    const playing = playingId === prompt.id;
    const dur = audioDur && playing ? audioDur : (prompt.audioDuration || 0);
    return h('section', {key: prompt.id + '-' + depth, className: 'aa-flow-card' + (depth ? ' is-nested' : '')},
      depth === 0 ? null : h('div', {className:'aa-flow-head'},
        h('div', {className:'min-w-0'},
          h('div', {className:'text-sm font-medium text-slate-100'}, prompt.name || prompt.id),
          h('div', {className:'text-[11px] text-slate-500'}, 'Nested prompt · ' + prompt.id)
        )
      ),
      h('div', {className:'aa-flow-body'},
        ...(prompt.options || []).map(opt => {
          const nextId = String(opt.nextPrompt || '').trim();
          let child = nextId ? (byId[nextId] || byId[nextId.toLowerCase()]) : null;
          const nested = childrenOf[prompt.id + '|' + String(opt.digit || '').trim()] || [];
          if (!child && nested[0]) child = nested[0];
          const count = stats.digits[String(opt.digit)] || 0;
          const kind = destKind(opt);
          return h('div', {key: prompt.id + '-' + opt.digit},
            flowRow(
              prompt.id + '-' + opt.digit,
              opt.digit || '–',
              (opt.description || ('Option ' + opt.digit)),
              cleanDest(opt),
              count,
              stats.total,
              kind === 'queue' ? '#22d3ee' : (kind === 'aa' ? '#a78bfa' : '#34d399'),
              stats.digitCalls[String(opt.digit)] || [],
              kind,
              (opt.description || '') + ' → ' + cleanDest(opt) + (kind === 'queue' ? ' · queue destination' : '')
            ),
            child ? h('div', {className:'aa-nested'}, renderPrompt(child, depth + 1, visited)) : null
          );
        }),
        flowRow('dial-ok', 'ext', 'Dial by extension · success', 'Reached extension', stats.dialOk.length, stats.total, '#34d399', stats.dialOk, 'dial', 'Caller dialed an extension that was answered or connected.'),
        flowRow('dial-fail', 'ext', 'Dial by extension · fail', 'No match / no answer', stats.dialFail.length, stats.total, '#f87171', stats.dialFail, 'drop', 'Caller dialed an extension that did not connect.'),
        flowRow('no-digit', '–', 'No digit', 'No keypress', stats.nodigit, stats.total, '#34d399', stats.dropCalls, 'drop', 'Caller left the greeting without pressing a digit.'),
        flowRow('timeout', '–', 'Timeout', 'Wait expired', stats.timeout, stats.total, '#f87171', stats.timeoutCalls, 'drop', 'Prompt wait expired before a valid selection.'),
        flowRow('invalid', '–', 'Invalid DTMF', 'Unrecognized key', stats.invalid, stats.total, '#fb923c', stats.invalidCalls, 'drop', 'Caller pressed a digit that is not a menu option.'),
        flowRow('abandon', '–', 'Abandoned', 'Hung up on AA', stats.abandon, stats.total, '#a78bfa', stats.abandonCalls, 'drop', 'Caller hung up before reaching a destination. call-through-user equals call-term-user (still on the AA).')
      )
    );
  };

  if (!ext) {
    return h('div', {className:'flex h-full items-center justify-center text-sm text-slate-500'},
      'Select an Auto Attendant.');
  }

  if (!prompts.length) {
    return h('div', {className:'border border-slate-700 bg-slate-900 p-8 text-center text-sm text-slate-500'},
      'No prompt map is available for extension ' + ext + '.');
  }

  const nestedIds = {};
  prompts.forEach(p => {
    if (p.parentPrompt) nestedIds[p.id] = true;
    (p.options || []).forEach(opt => {
      if (opt.nextPrompt) nestedIds[opt.nextPrompt] = true;
    });
  });
  const roots = prompts.filter(p => p.starting || (!p.parentPrompt && !nestedIds[p.id]));
  const shown = roots.length ? roots : prompts.filter(p => !p.parentPrompt);
  const visited = {};
  const rootPrompt = shown[0] || prompts[0];
  const playing = playingId === rootPrompt.id;
  const dur = audioDur && playing ? audioDur : (rootPrompt.audioDuration || 0);
  const overallStats = statsForPrompt(rootPrompt, false);

  const overall = { total: calls.length, nodigit: overallStats.nodigit, timeout: overallStats.timeout, invalid: overallStats.invalid, abandon: overallStats.abandon };
  const dropOff = overall.nodigit;
  const daily = {};
  calls.forEach(c => {
    const day = formatCallDate(c.start || c.startedAt);
    if (day) daily[day] = (daily[day] || 0) + 1;
  });
  const sparkVals = Object.keys(daily).sort().map(k => daily[k]);
  const pct = n => overall.total ? ((n / overall.total) * 100).toFixed(1) + '%' : '0.0%';
  const maxDrop = Math.max(1, dropOff, overall.timeout, overall.invalid, overall.abandon);

  const breakItem = (lab, n, color, rows, tip) => h('button', {
    type: 'button',
    className: 'aa-break-item',
    onClick: () => showCalls(lab, rows),
    title: tip
  },
    h('div', {className:'flex items-center justify-between gap-2'},
      h('span', {className:'text-[11px] font-medium ' + color}, lab),
      h('span', {className:'text-xs text-slate-200'}, n.toLocaleString() + ' calls · ' + pct(n))
    ),
    h('div', {className:'aa-mini-track mt-1'},
      h('div', {className:'aa-mini-fill', style:{width: Math.round((n / maxDrop) * 100) + '%', background: color.includes('emerald') || color.includes('green') ? '#34d399' : (color.includes('rose') ? '#f87171' : (color.includes('orange') ? '#fb923c' : (color.includes('violet') ? '#a78bfa' : '#fbbf24')))}})
    )
  );

  return h('div', {className:'aa-structure'},
    h('section', {className:'aa-hero'},
      h('div', {className:'aa-hero-kicker'}, 'Greeting Performance Summary'),
      h('div', {className:'aa-hero-grid'},
        h('button', {
          type:'button',
          className:'aa-hero-total',
          onClick: () => showCalls('All AA calls', calls)
        },
          h('div', {className:'aa-hero-count'}, overall.total.toLocaleString() + ' Calls'),
          sparkline(sparkVals),
          h('div', {className:'text-[11px] text-slate-500'}, 'Total Auto Attendant (AA) Calls')
        ),
        h('div', {className:'aa-hero-breaks'},
          breakItem('No digit', dropOff, 'text-emerald-400', overallStats.dropCalls, 'Caller left without pressing a digit. Click for calls.'),
          breakItem('Timeout', overall.timeout, 'text-rose-300', overallStats.timeoutCalls, 'Prompt wait expired. Click for calls.'),
          breakItem('Invalid DTMF', overall.invalid, 'text-orange-300', overallStats.invalidCalls, 'Unrecognized or invalid DTMF. Click for calls.'),
          h('div', {className:'text-[10px] text-slate-500'}, 'calls received at this greeting')
        ),
        h('div', {className:'aa-hero-center'},
          h('div', {className:'text-base font-semibold text-slate-100'}, rootPrompt.name || tree.name || ext),
          h('div', {className:'mt-1 flex flex-wrap items-center justify-center gap-2'},
            h('span', {className:'aa-status-badge'},
              h('span', {className:'aa-status-dot'}),
              'Starting'
            ),
            h(Tooltip, {text:'Prompt ID ' + rootPrompt.id + ' · extension ' + ext},
              h('span', {className:'cursor-help text-[11px] text-slate-500'}, rootPrompt.id)
            )
          )
        ),
        h('div', {className:'aa-player'},
          h('button', {
            type:'button',
            disabled: !rootPrompt.audioUrl,
            onClick: e => playPrompt(e, rootPrompt),
            className:'aa-play-btn' + (playing ? ' is-playing' : ''),
            title: rootPrompt.audioUrl ? (playing ? 'Pause greeting' : 'Play greeting') : 'No greeting audio'
          }, playing ? '❚❚' : '▶'),
          h('div', {className:'min-w-0 flex-1'},
            waveBars(rootPrompt),
            h('div', {className:'mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-500'},
              h('span', {className:'font-mono text-slate-300'}, mmss(playing ? audioTime : 0) + ' / ' + (dur ? dur + 's' : '0s')),
              h('span', {className:'truncate', title: rootPrompt.audioFilename || ''}, rootPrompt.audioFilename || 'No audio file')
            )
          )
        )
      )
    ),
    h('section', {className:'aa-flow-panel'},
      h('div', {className:'aa-flow-title'},
        h('h2', null, 'Call Routing Logic & Distribution'),
        h(Tooltip, {text:'Each keypress is a menu option. Counts are calls that chose that digit at this greeting. Click a row to open those calls. Ext rows are dial-by-extension attempts that did not match a single-digit option.'},
          h('span', {className:'cursor-help border-b border-dotted border-slate-600 text-[10px] text-slate-500'}, '?')
        )
      ),
      ...shown.map(p => renderPrompt(p, 0, visited))
    )
  );
}

export { AutoAttendantStructure };
