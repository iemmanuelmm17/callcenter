/* The domain settings dialog (thresholds, call types, saved per domain).
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { ThemeToggle } from './ui.js';
import { ServiceSettings, normalizeHours, defaultBusinessHours, hoursHaveOpenDay } from './settings-service.js';
import { api } from '../lib/api.js';
import { h, useEffect, useEscape, useState } from '../lib/react.js';
import { writeSlaSeconds } from '../lib/sla.js';

function SettingsModal({user, slaSeconds, filters, callTypes, onSlaChange, onClose, onSaved, onNotify}) {
  useEscape(true, onClose);
  const DEFAULTS = { slaSeconds: 20, slaPct: 80, missedPct: 20, abandonPct: 10, ahtMinutes: 5, ahtOutboundMinutes: 5, contactPct: 50, topAgentAhtMinutes: 5, topAgentMinCalls: 20 };
  /* QA-5: supervisors may read the thresholds, only managers change them. */
  const canSave = user.role === 'office_manager';
  const [form, setForm] = useState({
    slaSeconds: slaSeconds || DEFAULTS.slaSeconds,
    slaPct: DEFAULTS.slaPct,
    missedPct: DEFAULTS.missedPct,
    abandonPct: DEFAULTS.abandonPct,
    ahtMinutes: DEFAULTS.ahtMinutes,
    ahtOutboundMinutes: DEFAULTS.ahtOutboundMinutes,
    contactPct: DEFAULTS.contactPct,
    topAgentAhtMinutes: DEFAULTS.topAgentAhtMinutes,
    topAgentMinCalls: DEFAULTS.topAgentMinCalls
  });
  const [live, setLive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /*
   * The service-desk settings (opening hours, per-queue targets, roster) are
   * held here with the thresholds so one Save writes one payload: a manager who
   * edits both must not be able to save half of it.
   */
  const [service, setService] = useState(() => ({
    businessHours: defaultBusinessHours(),
    queueSla: {},
    roster: []
  }));
  /* The lists the editors need (agents, queues) come with the filter payload
   * every role already fetches on load. */
  const [directory, setDirectory] = useState({ agents: [], queues: [] });
  useEffect(() => {
    api('settings').then(r => {
      const d = r && r.data ? r.data : r;
      if (!d) return;
      setService({
        businessHours: normalizeHours(d.businessHours),
        queueSla: (d.queueSla && typeof d.queueSla === 'object') ? d.queueSla : {},
        roster: Array.isArray(d.roster) ? d.roster : []
      });
      setForm({
        slaSeconds: Number(d.slaSeconds || DEFAULTS.slaSeconds),
        slaPct: Number(d.slaPct || DEFAULTS.slaPct),
        missedPct: Number(d.missedPct || DEFAULTS.missedPct),
        abandonPct: Number(d.abandonPct || DEFAULTS.abandonPct),
        ahtMinutes: Number(d.ahtMinutes || DEFAULTS.ahtMinutes),
        ahtOutboundMinutes: Number(d.ahtOutboundMinutes || d.ahtMinutes || DEFAULTS.ahtOutboundMinutes),
        contactPct: Number(d.contactPct || DEFAULTS.contactPct),
        topAgentAhtMinutes: Number(d.topAgentAhtMinutes || d.ahtMinutes || DEFAULTS.topAgentAhtMinutes),
        topAgentMinCalls: Number(d.topAgentMinCalls ?? DEFAULTS.topAgentMinCalls)
      });
    }).catch(() => {});
  }, []);
  useEffect(() => {
    api('filters')
      .then(r => {
        const data = r && r.data ? r.data : r;
        setDirectory({
          agents: Array.isArray(data?.agents) ? data.agents : [],
          queues: Array.isArray(data?.queues) ? data.queues : []
        });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!filters || !filters.start) return;
    /* Reads summary.* only (SLA / missed / abandon / AHT) — no comparison. */
    api('report', { ...filters, callTypes: callTypes || { inbound: true, outbound: true, missed: true, onnet: true }, slaSeconds: form.slaSeconds, skipPrevious: 1 })
      .then(r => {
        const report = r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r;
        const c = report?.summary?.counts || {};
        const mb = report?.summary?.missedBreakdown || {};
        const sl = report?.summary?.serviceLevel || {};
        const inbound = report?.summary?.inbound || {};
        const outbound = report?.summary?.outbound || {};
        const offered = Number(c.inbound || 0) + Number(c.missed || 0);
        const missedPct = offered ? (Number(c.missed || 0) / offered) * 100 : 0;
        const abandonPct = offered ? (Number(mb.abandon || 0) / offered) * 100 : 0;
        const ahtSec = Number(inbound.avgHandling || inbound.avgTalk || 0);
        const ahtOutSec = Number(outbound.avgHandling || outbound.avgTalk || 0);
        setLive({
          slaPct: Number(sl.sla20 || 0),
          slaSeconds: Number(sl.slaSeconds || form.slaSeconds || 20),
          missedPct,
          abandonPct,
          ahtMinutes: ahtSec / 60,
          ahtOutboundMinutes: ahtOutSec / 60,
          /* Sprint B: the contact-rate chip reads the outbound panel's own
           * connects ÷ attempts, so the modal quotes no rate the report does
           * not also publish. */
          ob: Number(outbound.count || 0),
          obConnected: Number(outbound.connected || 0),
          contactPct: Number(outbound.connectPct || 0)
        });
      })
      .catch(() => setLive(null));
  }, [filters && filters.start, filters && filters.end, form.slaSeconds]);
  const clamp = (key, v) => {
    const spec = { slaSeconds: [5, 120, 1], slaPct: [1, 100, 0.5], missedPct: [1, 100, 0.5], abandonPct: [1, 100, 0.5], ahtMinutes: [1, 120, 0.5], ahtOutboundMinutes: [1, 120, 0.5], contactPct: [1, 100, 0.5], topAgentAhtMinutes: [0.5, 120, 0.5], topAgentMinCalls: [0, 10000, 1] }[key];
    const n = Number(v);
    if (!Number.isFinite(n)) return form[key];
    const [min, max, step] = spec;
    const rounded = Math.round(n / step) * step;
    return Math.min(max, Math.max(min, rounded));
  };
  const setKey = (key, v) => setForm(f => ({ ...f, [key]: clamp(key, v) }));
  const stepKey = (key, dir) => {
    const step = { slaSeconds: 1, slaPct: 0.5, missedPct: 0.5, abandonPct: 0.5, ahtMinutes: 0.5, ahtOutboundMinutes: 0.5, contactPct: 0.5, topAgentAhtMinutes: 0.5, topAgentMinCalls: 1 }[key];
    setKey(key, Number(form[key]) + dir * step);
  };
  const save = async () => {
    if (!canSave) return;
    setBusy(true); setError('');
    try {
      const payload = {
        slaSeconds: clamp('slaSeconds', form.slaSeconds),
        slaPct: clamp('slaPct', form.slaPct),
        missedPct: clamp('missedPct', form.missedPct),
        abandonPct: clamp('abandonPct', form.abandonPct),
        ahtMinutes: clamp('ahtMinutes', form.ahtMinutes),
        ahtOutboundMinutes: clamp('ahtOutboundMinutes', form.ahtOutboundMinutes),
        contactPct: clamp('contactPct', form.contactPct),
        topAgentAhtMinutes: clamp('topAgentAhtMinutes', form.topAgentAhtMinutes),
        topAgentMinCalls: clamp('topAgentMinCalls', form.topAgentMinCalls),
        /*
         * The service-desk block. A calendar that is switched on with no open
         * day is refused by the server on purpose (it would report zero calls),
         * so the client does not send one and says why instead of appearing to
         * save.
         */
        businessHours: service.businessHours,
        queueSla: service.queueSla,
        roster: service.roster
      };
      if (payload.businessHours && payload.businessHours.enabled && !hoursHaveOpenDay(payload.businessHours)) {
        throw new Error('Opening hours need at least one open day before they can be switched on.');
      }
      const saved = await api('settings', payload);
      const d = saved && saved.data ? saved.data : saved;
      onSlaChange(writeSlaSeconds(d.slaSeconds));
      if (onSaved) onSaved(d);
      /*
       * Warn when the server did not echo back the top-agent keys: the
       * save "succeeded" but those two values were dropped, which would
       * otherwise look like the setting silently refusing to stick.
       */
      const dropped = ['topAgentAhtMinutes', 'topAgentMinCalls']
        .filter(k => d && typeof d === 'object' && d[k] == null);
      if (onNotify) {
        if (dropped.length) {
          onNotify('error', 'Saved, but some settings were not stored',
            'The server did not persist: ' + dropped.join(', ') +
            '. The dashboard will use them for this session only.');
        } else {
          onNotify('ok', 'Settings saved', 'Domain thresholds updated.');
        }
      }
      onClose();
    } catch (e) {
      const msg = (e && e.message) || 'Unable to save settings.';
      setError(msg);
      if (onNotify) onNotify('error', 'Could not save settings', msg);
    } finally { setBusy(false); }
  };
  const liveChip = (text, over) =>
    h('span', { className: 'set-live' + (over ? ' is-over' : ' is-ok') }, text);
  const row = ({ key, tone, icon, title, desc, unit, liveNode }) =>
    h('div', { className: 'set-row-card is-' + tone },
      h('div', { className: 'set-row-ico', 'aria-hidden': 'true' }, h('i', { className: icon })),
      h('div', { className: 'set-row-copy' },
        h('div', { className: 'set-row-title' }, title),
        h('div', { className: 'set-row-desc' }, desc),
        liveNode
      ),
      h('div', { className: 'set-input-wrap' },
        h('div', { className: 'set-input-shell' },
          h('input', {
            type: 'number',
            disabled: !canSave,
            value: form[key],
            onChange: e => setForm({ ...form, [key]: e.target.value }),
            onBlur: e => setKey(key, e.target.value)
          }),
          h('span', { className: 'set-suffix' }, unit)
        ),
        h('div', { className: 'set-stepper' },
          h('button', { type: 'button', disabled: !canSave, title: 'Increase', onClick: () => stepKey(key, 1) }, '▴'),
          h('button', { type: 'button', disabled: !canSave, title: 'Decrease', onClick: () => stepKey(key, -1) }, '▾')
        )
      )
    );
  const slaOver = live && Number(live.slaPct) < Number(form.slaPct);
  const missOver = live && live.missedPct > Number(form.missedPct);
  const abOver = live && live.abandonPct > Number(form.abandonPct);
  const ahtOver = live && live.ahtMinutes > Number(form.ahtMinutes);
  const ahtOutOver = live && live.ahtOutboundMinutes > Number(form.ahtOutboundMinutes);
  return h('div', { className: 'hist-modal-bg set-overlay cursor-default', role: 'presentation', onClick: onClose },
    h('div', {
      className: 'set-modal cursor-default',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Settings',
      onClick: e => e.stopPropagation()
    },
      h('div', { className: 'set-head' },
        h('div', null,
          h('div', { className: 'set-title' }, 'Settings'),
          h('div', { className: 'set-sub' }, 'Domain thresholds · loaded on every login')
        ),
        h('button', { type: 'button', className: 'hist-modal-x', onClick: onClose, title: 'Close' }, '×')
      ),
      h('div', { className: 'set-scroll' },
        h('div', { className: 'set-sec-label' }, 'Inbound · service level'),
        row({
          key: 'slaSeconds', tone: 'good', icon: 'fa-solid fa-stopwatch',
          title: 'SLA max ring',
          desc: 'An inbound call meets SLA when an agent answers within this many seconds of ringing.',
          unit: 'sec',
          liveNode: live
            ? liveChip('Current ring target: ' + (live.slaSeconds || form.slaSeconds) + 's', false)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        row({
          key: 'slaPct', tone: 'good', icon: 'fa-solid fa-percent',
          title: 'SLA percent passing rate',
          desc: 'A queue or dashboard passes SLA when this percent of answered calls meet the max-ring target. Below this is a fail.',
          unit: '%',
          liveNode: live
            ? liveChip('Current: ' + live.slaPct.toFixed(1) + '% answered in time', slaOver)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        h('div', { className: 'set-sec-label' }, 'Inbound · alerts'),
        row({
          key: 'missedPct', tone: 'bad', icon: 'fa-solid fa-phone-slash',
          title: 'Missed-call rate',
          desc: 'Percent of offered inbound that reached a user directly and were not answered, including voicemail.',
          unit: '%',
          liveNode: live
            ? liveChip('Current: ' + live.missedPct.toFixed(1) + '%', missOver)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        row({
          key: 'abandonPct', tone: 'bad', icon: 'fa-solid fa-person-walking-dashed-line-arrow-right',
          title: 'Abandoned-call rate',
          desc: 'Percent of offered calls that rang a queue or IVR and the caller hung up before an agent answered.',
          unit: '%',
          liveNode: live
            ? liveChip('Current: ' + live.abandonPct.toFixed(1) + '%', abOver)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        row({
          key: 'ahtMinutes', tone: 'warn', icon: 'fa-solid fa-hourglass-half',
          title: 'Inbound AHT',
          desc: 'Average talking duration on answered inbound calls. Alert when this many minutes is exceeded.',
          unit: 'min',
          liveNode: live
            ? liveChip('Current inbound: ' + live.ahtMinutes.toFixed(1) + ' min', ahtOver)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        h('div', { className: 'set-sec-label' }, 'Outbound · alerts'),
        row({
          key: 'ahtOutboundMinutes', tone: 'warn', icon: 'fa-solid fa-arrow-up-right-from-square',
          title: 'Outbound AHT',
          desc: 'Average talking duration on outbound calls. Alert when this many minutes is exceeded.',
          unit: 'min',
          liveNode: live
            ? liveChip('Current outbound: ' + Number(live.ahtOutboundMinutes || 0).toFixed(1) + ' min', ahtOutOver)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        row({
          key: 'contactPct', tone: 'good', icon: 'fa-solid fa-phone-arrow-up-right',
          title: 'Outbound contact rate (at least)',
          desc: 'Outbound calls a human answered ÷ outbound attempts. The agent table marks a rate below this red — a floor, where every other threshold here is a ceiling.',
          unit: '%',
          liveNode: live
            ? liveChip('Current outbound connects: ' + Number(live.obConnected || 0) + ' of ' + Number(live.ob || 0) + ' attempts', false)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        h('div', { className: 'set-sec-label' }, 'Top agent qualification'),
        h('div', { className: 'set-row-desc', style: { margin: '-2px 0 8px', opacity: .85 } },
          'Applies to the "Lowest AHT" ranking on the Operations overview. An agent qualifies for the podium only when both conditions are met. Agents that miss the bar are still listed, ranked below.'),
        row({
          key: 'topAgentAhtMinutes', tone: 'warn', icon: 'fa-solid fa-gauge-high',
          title: 'Qualifying AHT (less than)',
          desc: 'An agent qualifies only when their inbound average handle time is UNDER this many minutes.',
          unit: 'min',
          liveNode: live
            ? liveChip('Domain inbound AHT: ' + live.ahtMinutes.toFixed(1) + ' min', false)
            : h('span', { className: 'set-live is-na' }, 'Current: —')
        }),
        row({
          key: 'topAgentMinCalls', tone: 'good', icon: 'fa-solid fa-phone-volume',
          title: 'Minimum inbound calls (greater than)',
          desc: 'An agent qualifies only when they handled MORE than this many inbound calls. Stops one fast call outranking a heavy workload.',
          unit: 'calls',
          liveNode: h('span', { className: 'set-live is-na' },
            'Must beat both thresholds to earn a medal')
        }),
        /*
         * The service-desk settings (opening hours, per-queue targets, the
         * roster) live in the SCROLLING BODY, not in the dialog footer.
         *
         * They used to render inside .set-foot-left - a single flex row next to
         * "Reset to defaults" - which squashed three cards into a strip beside
         * the buttons: the manager saw the business-hours time inputs jammed
         * against the Save button and nothing else was legible. One Save still
         * writes one payload (the state lives in the dialog), so moving the
         * markup only changes where it is read.
         */
        h('div', { className: 'set-sec-label' }, 'Service desk · hours, targets, roster'),
        h('p', { className: 'set-section-note' },
          'These three apply to this domain only and are saved with the thresholds above: ',
          'opening hours decide which calls count by default, the per-queue targets decide ',
          'which calls meet SLA, and the roster is what makes occupancy possible.'),
        h(ServiceSettings, {
          value: service,
          onChange: setService,
          canSave,
          agents: directory.agents,
          queues: directory.queues
        }),
        h('div', { className: 'set-sec-label' }, 'Appearance'),
        h('div', { className: 'set-theme-row' },
          h('div', { className: 'set-row-copy' },
            h('div', { className: 'set-row-title' }, 'Color mode'),
            h('div', { className: 'set-row-desc' }, 'Night is dark. Day is light. Saved in this browser.')
          ),
          h(ThemeToggle)
        ),
        error ? h('div', { className: 'set-error' }, error) : null,
        !canSave ? h('div', { className: 'set-readonly' }, 'View only. Only an office manager can change the domain thresholds.') : null
      ),
      h('div', { className: 'set-foot' },
        h('div', { className: 'set-foot-left' },
          canSave ? h('button', { type: 'button', className: 'set-reset', onClick: () => setForm({ ...DEFAULTS }) }, 'Reset to defaults') : null,
          h('div', { className: 'set-scope' }, 'Applies to this PBX domain only')
        ),
        h('div', { className: 'set-foot-right' },
          h('button', { type: 'button', className: 'set-ghost', onClick: onClose }, 'Close'),
          canSave ? h('button', { type: 'button', className: 'set-save', disabled: busy, onClick: save }, busy ? 'Saving…' : 'Save') : null
        )
      )
    )
  );
}

export { SettingsModal };
