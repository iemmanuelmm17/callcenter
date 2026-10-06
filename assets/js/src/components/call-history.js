/* Call history table, the cradle flow dialog and the recording player.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { CallFlowDialog, loadCallFlow } from './call-flow-dialog.js';
import { RecordingPlayer } from './recording-player.js';
import { CallTypeIcon, ErrorState, NavIcon, skel } from './ui.js';
import { api, apiDownload } from '../lib/api.js';
import { fmt, fmtNum, histInitials, histOutcomeMeta, histPartyLabel, histTypeTone } from '../lib/format.js';
import { h, keyActivate, useEffect, useEscape, useRef, useState } from '../lib/react.js';
import { formatHistDate, formatMmss, histDayKey, histDayLabel, histTimeOnly } from '../lib/time.js';


function CallHistoryDashboard({ filters, callTypes }) {
  const [caller, setCaller] = useState('');
  const [called, setCalled] = useState('');
  const [agent, setAgent] = useState('');
  const [outcome, setOutcome] = useState('');
  const [callerQ, setCallerQ] = useState('');
  const [calledQ, setCalledQ] = useState('');
  const [agentQ, setAgentQ] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /* Bumped by Retry. */
  const [reload, setReload] = useState(0);
  const [openRec, setOpenRec] = useState(null);
  const [flow, setFlow] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setCallerQ(caller.trim());
      setCalledQ(called.trim());
      setAgentQ(agent.trim());
      setPage(1);
    }, 320);
    return () => clearTimeout(t);
  }, [caller, called, agent]);

  useEffect(() => { setPage(1); }, [outcome, callTypes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api('call_history', {
      ...filters,
      caller: callerQ,
      called: calledQ,
      agent: agentQ,
      outcome,
      page,
      size,
      callTypes: callTypes || { inbound: true, outbound: true, missed: true, onnet: true }
    }).then(res => {
      if (cancelled) return;
      setRows(Array.isArray(res.data) ? res.data : []);
      setTotal(Number(res.total) || 0);
      setLastPage(Number(res.last_page) || 1);
      setPage(Number(res.page) || 1);
      setStats(res.stats || null);
      setInsight(res.insight || null);
    }).catch(e => {
      if (!cancelled) setError(e && e.message ? e.message : 'Unable to load call history.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filters, callerQ, calledQ, agentQ, outcome, page, size, callTypes, reload]);

  /*
   * Only one recording open at a time: collapsing the previous row
   * unmounts its player, whose cleanup tears the <audio> down. That is
   * what stops two recordings talking over each other.
   */
  const toggleRec = (row, ev) => {
    if (ev) ev.stopPropagation();
    const id = String(row.id || row.origCallId || '');
    if (recIndex[id] !== 'found') return;   /* nothing to expand yet */
    setOpenRec(prev => (prev === id ? null : id));
  };

  /*
   * Collapse when the underlying list changes — the expanded row would
   * otherwise point at a call that is no longer on screen.
   */
  useEffect(() => { setOpenRec(null); }, [rows]);

  /*
   * ============================================================
   * Recording discovery (runs AFTER the table is on screen)
   * ============================================================
   *
   * Resolving a recording is expensive: recording.php walks every PBX
   * server and tries several ns-api paths per call. Doing that inline
   * with call_history would hold the whole table hostage behind the
   * slowest lookup.
   *
   * So the table renders first with every Listen button disabled, then
   * this pass probes rows in the background and flips each button on as
   * its URL comes back. Three things keep it from being a stampede:
   *
   *   - only rows the backend flagged with hasRecordingHint are probed;
   *     the rest are known-absent and stay disabled for free
   *   - a small concurrency window instead of Promise.all, so we never
   *     open 100 sockets against the PBX at once
   *   - a cancelled flag, so paging away abandons in-flight work rather
   *     than writing results for a list that is no longer displayed
   *
   * Resolved URLs are cached and handed to the player, so expanding a
   * row is instant and never re-fetches.
   */
  const [recIndex, setRecIndex] = useState({});   /* id -> 'probing'|'found'|'none' */
  const recUrls = useRef({});                      /* id -> resolved ns-api url   */

  useEffect(() => {
    let cancelled = false;
    recUrls.current = {};

    const candidates = rows.filter(r => r && r.hasRecordingHint);
    const seed = {};
    rows.forEach(r => {
      const id = String(r.id || r.origCallId || '');
      if (!id) return;
      seed[id] = r.hasRecordingHint ? 'probing' : 'none';
    });
    setRecIndex(seed);

    if (!candidates.length) return () => { cancelled = true; };

    const probe = async row => {
      const id = String(row.id || row.origCallId || '');
      const recId = String(row.recordingCallId || (row.type === 'outbound' || row.type === 'onnet' ? row.origCallId : row.termCallId) || '');
      const recUser = String(row.recordingUser || (row.type === 'outbound' || row.type === 'onnet' ? row.origUser : row.termUser) || '');
      try {
        const res = await api('recording', {
          callId: recId,
          origCallId: row.origCallId,
          termCallId: row.termCallId,
          extension: recUser.replace(/^sip:/i, '').split('@')[0],
          termUser: row.termUser,
          origUser: row.origUser,
          agent: row.agent
        });
        if (cancelled) return;
        const url = String((res && res.data && res.data.url) || (res && res.url) || '').replace(/&amp;/gi, '&');
        const dur = Number((res && res.data && res.data.duration) || 0) || 0;
        if (url) {
          recUrls.current[id] = { url, duration: dur };
          setRecIndex(prev => ({ ...prev, [id]: 'found' }));
        } else {
          setRecIndex(prev => ({ ...prev, [id]: 'none' }));
        }
      } catch (e) {
        if (!cancelled) setRecIndex(prev => ({ ...prev, [id]: 'none' }));
      }
    };

    /* Bounded worker pool over the candidate list. */
    const LIMIT = 4;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < candidates.length) {
        const next = candidates[cursor++];
        await probe(next);
      }
    };
    for (let i = 0; i < Math.min(LIMIT, candidates.length); i++) worker();

    return () => { cancelled = true; };
  }, [rows]);

  const openFlow = async (row) => {
    setFlow({ loading: true, row, steps: [] });
    try {
      setFlow({ loading: false, row, steps: await loadCallFlow(row) });
    } catch (e) {
      setFlow({
        loading: false,
        row,
        steps: [],
        error: e && e.message ? e.message : 'Unable to load call flow.'
      });
    }
  };

  /*
   * Export EVERY row that matches the view.
   *
   * This used to serialise `rows`, i.e. only the page on screen (25 of maybe
   * 30,000), so the file silently disagreed with the header and the stats
   * directly above it. The server streams the whole filtered result set now.
   */
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await apiDownload('call_history', {
        ...filters,
        caller: callerQ,
        called: calledQ,
        agent: agentQ,
        outcome,
        callTypes: callTypes || { inbound: true, outbound: true, missed: true, onnet: true },
        export: true
      }, 'call-history.csv');
    } catch (e) {
      setError(e && e.message ? e.message : 'Unable to export call history.');
    } finally {
      setExporting(false);
    }
  };

  useEscape(!!flow, () => setFlow(null));

  const skel = loading && rows.length === 0;
  const st = stats || {};
  const grouped = [];
  rows.forEach((row, i) => {
    const key = histDayKey(row.startedAt);
    const last = grouped[grouped.length - 1];
    if (!last || last.key !== key) grouped.push({ key, rows: [row] });
    else last.rows.push(row);
  });

  const tile = (label, value, sub, tone, tip) =>
    h('div', { className: 'hist-stat' + (tone ? ' is-' + tone : ''), title: tip || '' },
      h('div', { className: 'hist-stat-label' }, label),
      h('div', { className: 'hist-stat-value' + (tone === 'bad' ? ' is-bad' : '') }, value),
      sub ? h('div', { className: 'hist-stat-sub' }, sub) : null
    );

  const field = (label, node) =>
    h('label', { className: 'hist-filter' }, h('span', null, label), node);

  return h('div', { className: 'hist-page' },
    h('div', { className: 'hist-kpis' },
      skel
        ? Array.from({ length: 6 }).map((_, i) => h('div', { key: i, className: 'hist-stat skeleton-block' }))
        : [
            tile('Total', fmtNum(st.total ?? total), 'In this view', null, 'Calls matching the current date range and filters.'),
            tile('Answered', fmtNum(st.answered || 0), 'Talk time > 0', 'good', 'Calls with talking duration.'),
            tile('Missed', fmtNum(st.missed || 0), 'Direct no-answer / voicemail', 'bad', 'Caller reached a user directly and they did not answer, or the call went to voicemail.'),
            tile('Abandoned', (function(){ const offered = Number(st.answered||0)+Number(st.missed||0)+Number(st.abandoned||0); const r = offered ? ((Number(st.abandoned||0)/offered)*100) : 0; return r.toFixed(1)+'%'; })(), fmtNum(st.abandoned || 0) + ' calls', 'bad', 'Rang into a queue or IVR and the caller hung up before an agent answered.'),
            tile('Avg ring', fmt(st.avgRing || 0), 'Wait before answer', null, 'Average ring across this view.'),
            tile('Avg talk', fmt(st.avgTalk || 0), 'Talking duration', null, 'Average talk across this view.')
          ]
    ),
    insight && insight.text
      ? h('div', { className: 'hist-insight' + (insight.tone === 'bad' ? ' is-bad' : '') }, insight.text)
      : null,
    h('div', { className: 'hist-toolbar' },
      field('Caller', h('input', {
        type: 'search', value: caller, placeholder: 'Name or number',
        onChange: e => setCaller(e.target.value), title: 'Filter by caller name or number'
      })),
      field('Called', h('input', {
        type: 'search', value: called, placeholder: 'Dialed or destination',
        onChange: e => setCalled(e.target.value), title: 'Filter by dialed or destination'
      })),
      field('Agent / queue', h('input', {
        type: 'search', value: agent, placeholder: 'Name or extension',
        onChange: e => setAgent(e.target.value), title: 'Filter by agent or queue extension'
      })),
      field('Outcome', h('select', {
        value: outcome,
        title: 'Filter by derived outcome',
        onChange: e => setOutcome(e.target.value)
      },
        h('option', { value: '' }, 'All outcomes'),
        h('option', { value: 'answered' }, 'Answered'),
        h('option', { value: 'missed' }, 'Missed'),
        h('option', { value: 'abandoned' }, 'Abandoned')
      )),
      h('button', {
        type: 'button', className: 'hist-export', onClick: exportCsv,
        title: 'Export every row matching the current filters as CSV',
        disabled: exporting || loading || total === 0
      }, exporting ? 'Exporting…' : 'Export CSV')
    ),
    error ? h(ErrorState, {message: error, onRetry: () => setReload(n => n + 1), className: 'mb-2 text-sm'}) : null,
    h('div', { className: 'q-table-wrap hist-table-wrap' },
      h('table', { className: 'q-table hist-table' },
        h('thead', null,
          h('tr', null,
            h('th', { title: 'Call type' }, ''),
            h('th', { title: 'Time of day' }, 'Time'),
            h('th', { title: 'Caller to destination' }, 'Caller ↔ Destination'),
            h('th', { title: 'Who handled the call' }, 'Agent / Queue'),
            h('th', { title: 'Ring duration' }, 'Ring'),
            h('th', { title: 'Talk duration' }, 'Talk'),
            h('th', { title: 'Derived outcome. Raw disconnect is shown underneath.' }, 'Outcome'),
            h('th', { title: 'Play recording' }, 'Listen')
          )
        ),
        h('tbody', null,
          skel
            ? Array.from({ length: 8 }).map((_, i) =>
                h('tr', { key: 'sk' + i },
                  ...Array.from({ length: 8 }).map((__, j) =>
                    h('td', { key: j }, h('div', { className: 'skeleton-line' }))
                  )
                )
              )
            : rows.length === 0
              ? h('tr', null, h('td', { colSpan: 8, className: 'text-slate-500' }, 'No calls in this range.'))
              : grouped.flatMap(group => {
                  const head = h('tr', { key: 'd-' + group.key, className: 'hist-day-row' },
                    h('td', { colSpan: 8 },
                      h('span', { className: 'hist-day-label' }, histDayLabel(group.key)),
                      h('span', { className: 'hist-day-count' }, group.rows.length + (group.rows.length === 1 ? ' call' : ' calls'))
                    )
                  );
                  const body = group.rows.flatMap((row, i) => {
                    const id = String(row.id || row.origCallId || i);
                    const expanded = openRec === id;
                    /*
                     * Enabled only once a URL actually came back.
                     * 'probing' shows a spinner so the row reads as
                     * "still looking" rather than "no recording".
                     */
                    const recState = recIndex[id] || (row.hasRecordingHint ? 'probing' : 'none');
                    const canPlay = recState === 'found';
                    const probing = recState === 'probing';
                    const om = histOutcomeMeta(row.outcome);
                    const flag = om.tone === 'bad';
                    const fromP = histPartyLabel(row.from, row.fromNumber);
                    const toP = histPartyLabel('', row.dialed || row.to);
                    const handlerName = row.agentName || row.agent || row.throughUser || '';
                    const handlerExt = row.agent || '';
                    const queue = row.throughUser && row.throughUser !== row.agent ? row.throughUser : '';
                    const main = h('tr', {
                      key: id,
                      tabIndex: 0,
                      onKeyDown: keyActivate(() => openFlow(row)),
                      className: 'cursor-pointer' + (flag ? ' hist-row-flag' : '') + (expanded ? ' hist-row-open' : ''),
                      title: 'View call flow',
                      onClick: () => openFlow(row)
                    },
                      h('td', { className: 'hist-type-cell' },
                        h('span', { className: 'hist-type-chip hist-type-' + histTypeTone(row.type), title: row.type || '' },
                          h(CallTypeIcon, { type: row.type, size: 13 })
                        )
                      ),
                      h('td', { className: 'hist-time', title: formatHistDate(row.startedAt) }, histTimeOnly(row.startedAt)),
                      h('td', { className: 'hist-party-cell' },
                        h('div', { className: 'hist-party' },
                          h('div', { className: 'hist-party-side' },
                            fromP.name ? h('div', { className: 'hist-party-name' }, fromP.name) : null,
                            h('div', { className: 'hist-party-num' }, fromP.num || '—')
                          ),
                          h('span', { className: 'hist-party-arrow', 'aria-hidden': 'true' }, '→'),
                          h('div', { className: 'hist-party-side' },
                            toP.name ? h('div', { className: 'hist-party-name' }, toP.name) : null,
                            h('div', { className: 'hist-party-num' }, toP.num || '—')
                          )
                        )
                      ),
                      h('td', null,
                        h('div', { className: 'hist-agent' },
                          h('span', { className: 'hist-avatar', title: handlerName }, histInitials(row.agentName, handlerExt)),
                          h('div', { className: 'min-w-0' },
                            h('div', { className: 'hist-agent-name' }, handlerName || '—'),
                            h('div', { className: 'hist-agent-meta' },
                              [handlerExt, queue ? 'Q ' + queue : ''].filter(Boolean).join(' · ') || ' ')
                          )
                        )
                      ),
                      h('td', { className: 'font-mono' }, formatMmss(row.ringing)),
                      h('td', { className: 'font-mono' }, formatMmss(row.talking)),
                      h('td', null,
                        h('span', { className: 'hist-pill hist-pill-' + om.tone, title: om.label },
                          h('span', { className: 'hist-pill-dot' }),
                          om.label
                        ),
                        row.disconnectReason
                          ? h('div', { className: 'hist-disc', title: row.disconnectReason }, row.disconnectReason)
                          : null
                      ),
                      h('td', null,
                        h('button', {
                          type: 'button',
                          className: 'hist-listen' + (expanded ? ' is-on' : ''),
                          disabled: !canPlay,
                          'aria-expanded': expanded,
                          'aria-busy': probing,
                          title: probing
                            ? 'Checking for recording…'
                            : canPlay
                              ? (expanded ? 'Hide recording' : 'Play recording')
                              : 'No recording available for this call',
                          onClick: e => toggleRec(row, e)
                        },
                          probing
                            ? h('span', { className: 'rec-spin' })
                            : h(NavIcon, { name: expanded ? 'chevronUp' : 'play', size: 14 })
                        )
                      )
                    );

                    if (!expanded) return [main];

                    return [main, h('tr', { key: id + '-rec', className: 'hist-rec-row' },
                      h('td', { colSpan: 8 },
                        h(RecordingPlayer, {
                          row,
                          preresolved: recUrls.current[id],
                          onClose: () => setOpenRec(null)
                        })
                      )
                    )];
                  });
                  return [head, ...body];
                })
        )
      )
    ),
    h('div', { className: 'hist-pager' },
      h('label', { className: 'hist-size' },
        'Rows',
        h('select', {
          value: size,
          title: 'Rows per page',
          onChange: e => { setSize(Number(e.target.value) || 25); setPage(1); }
        },
          [25, 50, 100].map(n => h('option', { key: n, value: n }, String(n)))
        )
      ),
      h('div', { className: 'hist-pages' },
        h('button', {
          type: 'button', disabled: page <= 1,
          onClick: () => setPage(p => Math.max(1, p - 1)), title: 'Previous page'
        }, 'Prev'),
        h('span', null, 'Page ' + page + ' of ' + lastPage + ' · ' + fmtNum(total) + ' calls'),
        h('button', {
          type: 'button', disabled: page >= lastPage,
          onClick: () => setPage(p => p + 1), title: 'Next page'
        }, 'Next')
      )
    ),
    flow ? h(CallFlowDialog, {
      row: flow.row,
      steps: flow.steps,
      loading: flow.loading,
      error: flow.error,
      onClose: () => setFlow(null)
    }) : null
  );
}

export { CallHistoryDashboard };
