/* SLA threshold persistence and the ring class/HTML helpers.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { fmt } from './format.js';

const SLA_KEY = 'callscope-sla-seconds';

const readSlaSeconds = () => {
    try {
      const n = Number(localStorage.getItem(SLA_KEY));
      if (!Number.isFinite(n) || n < 5) return 20;
      return Math.min(120, Math.round(n));
    } catch (e) { return 20; }
  };

const writeSlaSeconds = n => {
    const v = Math.min(120, Math.max(5, Math.round(Number(n) || 20)));
    try { localStorage.setItem(SLA_KEY, String(v)); } catch (e) {}
    return v;
  };

const slaRingClass = (seconds, sla) => {
    const n = Number(seconds || 0);
    if (!Number.isFinite(n) || n <= 0) return 'sla-ring sla-ring-na';
    return n <= Number(sla || 20) ? 'sla-ring sla-ring-ok' : 'sla-ring sla-ring-over';
  };

const slaRingHtml = (seconds, sla) => {
    const n = Number(seconds || 0);
    const cls = slaRingClass(n, sla);
    const label = n > 0 ? fmt(n) : '—';
    return '<span class="' + cls + '">' + label + '</span>';
  };

export { readSlaSeconds, slaRingClass, slaRingHtml, writeSlaSeconds };
