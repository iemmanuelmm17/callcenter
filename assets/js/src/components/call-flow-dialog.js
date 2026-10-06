/* Cradle-to-grave (sip flow) dialog.
 *
 * Shared by Call history (one row, one flow) and by the drill-down calls modal,
 * which gained a Flow column — the modal asks for a specific call's flow, which
 * is exactly the request this module builds. Keeping the request and the markup
 * in one place means the two screens cannot disagree about what a flow is.
 */

import { FlowKindIcon } from './ui.js';
import { api } from '../lib/api.js';
import { h, useEscape } from '../lib/react.js';
import { formatHistDate } from '../lib/time.js';

/**
 * Fetch the cradle-to-grave steps for one call row.
 *
 * The row carries what the PBX needs: the two call ids, the hostnames the
 * endpoints saw, and the prefilled trace URL when the CDR has one. `startTime`
 * and the disconnect time bound the sipflow search window.
 *
 * @returns {Promise<Array>} steps, empty when the PBX has no events for the call
 * @throws  {Error} when the request itself fails (the caller renders the message)
 */
async function loadCallFlow(row) {
  const res = await api('call_flow', {
    traceApi: row.traceApi,
    origCallId: row.origCallId,
    termCallId: row.termCallId,
    startTime: row.startedAt,
    endTime: row.disconnectedAt || row.startedAt,
    servers: row.servers || ''
  });
  const steps = (res && (res.steps || (res.data && res.data.steps))) || [];
  return Array.isArray(steps) ? steps : [];
}

/** '2026-08-02 · 8454259810 → Main line' — what call this flow belongs to. */
function flowSubtitle(row) {
  if (!row) return '';
  const stamp = formatHistDate(row.startedAt);
  const from = String(row.from || row.fromNumber || '').trim();
  const to = String(row.to || row.dialed || '').trim();
  return [stamp, [from, to].filter(Boolean).join(' → ')].filter(Boolean).join(' · ');
}

/**
 * The dialog itself. It is presentational: the caller owns the state
 * (loading / error / steps) because the caller is also the one that knows when
 * to clear it (paging away, closing the modal, …).
 *
 * Escape is deliberately NOT handled here — the parent already listens for it
 * (and has other layers to unwind first, like a recording tray), so a second
 * document listener would close two things at once.
 */
function CallFlowDialog({ row, steps, loading, error, onClose }) {
  return h('div', {
    className: 'hist-modal-bg cursor-default',
    style: { zIndex: 2147483646 },
    role: 'presentation',
    onClick: onClose
  },
    h('div', {
      className: 'hist-modal cursor-default',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Cradle to grave',
      onClick: e => e.stopPropagation()
    },
      h('div', { className: 'hist-modal-head' },
        h('div', null,
          h('div', { className: 'hist-modal-title' }, 'Cradle to grave'),
          h('div', { className: 'hist-modal-sub' }, flowSubtitle(row))
        ),
        h('button', { type: 'button', className: 'hist-modal-x', onClick: onClose, title: 'Close' }, '×')
      ),
      h('div', { className: 'hist-modal-body' },
        loading
          ? h('div', { className: 'p-4 text-sm text-slate-400' }, 'Loading call flow…')
          : error
            ? h('div', { className: 'p-4 text-sm text-rose-300' }, error)
            : (steps || []).length === 0
              ? h('div', { className: 'p-4 text-sm text-slate-400' }, 'No cradle-to-grave events for this call.')
              : h('ol', { className: 'hist-flow' },
                  (steps || []).map((st, i) =>
                    h('li', { key: i, className: 'hist-flow-step' },
                      h('div', { className: 'hist-flow-time' },
                        h('div', { className: 'hist-flow-clock' }, st.ts || st.clock || ''),
                        (st.diff_ts || st.delta) ? h('div', { className: 'hist-flow-delta' }, st.diff_ts || st.delta) : null
                      ),
                      h('div', { className: 'hist-flow-rail' },
                        h(FlowKindIcon, { classes: st.classes || st.kind }),
                        i < (steps || []).length - 1 ? h('div', { className: 'hist-flow-line' }) : null
                      ),
                      h('div', { className: 'hist-flow-label' }, st.str || st.label || '')
                    )
                  )
                )
      )
    )
  );
}

export { CallFlowDialog, flowSubtitle, loadCallFlow };
