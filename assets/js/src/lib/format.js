/* Number, percentage and telephone formatting plus the call-history label helpers.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { h } from './react.js';

const fmt = seconds => {
    const n = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const sec = Math.floor(n % 60);
    if (h > 99) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

const fmtNum = n => Number(n || 0).toLocaleString();

const fmtPct = (n, d) => d ? ((n / d) * 100).toFixed(1) + '%' : '0.0%';

function histPartyLabel(name, number) {
  const n = String(name || '').trim();
  const num = formatPhoneNumber(number) || String(number || '').trim();
  if (n && num && n !== num) return { name: n, num };
  if (n) return { name: n, num: '' };
  return { name: '', num: num || '—' };
}

function histInitials(name, ext) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length) return ((parts[0][0] || '') + (parts[1] ? parts[1][0] : '')).toUpperCase();
  return String(ext || '?').slice(0, 2).toUpperCase();
}

function histTypeTone(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'inbound' || t === 'incoming') return 'good';
  if (t === 'outbound' || t === 'outgoing') return 'outbound';
  if (t === 'onnet') return 'onnet';
  if (t === 'missed') return 'bad';
  return 'dim';
}

function histOutcomeMeta(outcome) {
  const o = String(outcome || '').toLowerCase();
  if (o === 'answered') return { label: 'Answered', tone: 'good' };
  if (o === 'voicemail') return { label: 'Voicemail', tone: 'warn' };
  if (o === 'abandoned') return { label: 'Abandoned', tone: 'bad' };
  if (o === 'missed') return { label: 'Missed', tone: 'bad' };
  return { label: 'Unknown', tone: 'dim' };
}

const formatPhoneNumber = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return value || '';
};

export { fmt, fmtNum, fmtPct, formatPhoneNumber, histInitials, histOutcomeMeta, histPartyLabel, histTypeTone };
