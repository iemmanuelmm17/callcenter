/* Time zone and timestamp formatting for every table, chart and export label.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { h } from './react.js';

/*
 * The desk's timezone, not the browser's (review, finding C7).
 *
 * It starts at the deployment default and is re-seated by applyServerTimezone()
 * as soon as the server says otherwise - from the clock island portal.php renders
 * (before the first paint, so the default date range is already the right DAY)
 * and again from every payload that carries `timezone`. It is a `let` and
 * `today` is recomputed by that setter on purpose: both are exported as live
 * bindings, so a component reading `today` after a manager changes the setting
 * gets the desk's new date, not the one the module saw at import time.
 *
 * The zone decides WHICH calendar date a call belongs to, so this is not a
 * label: an off-by-one here is a report about a different day than the one the
 * server was asked for.
 */
let APP_TZ = 'America/New_York';

/*
 * A zone name the runtime cannot resolve must never reach Intl: an invalid
 * timeZone option throws inside every formatToParts call downstream, which would
 * take the whole dashboard down over one bad setting. The shape allowed is an
 * IANA id - letters, digits, '_', '+', '-' and the '/' between Region and City -
 * which is also what the server accepts (normalizeTimezoneName() in
 * includes/timezone.php), including its refusal of a bare offset like '+08:00',
 * which has no DST rules to follow.
 */
const usableTimezone = name => {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean || clean.length > 64 || /[^A-Za-z0-9_+/\-]/.test(clean)) return '';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: clean });
    } catch (e) {
        return '';
    }
    return clean;
};

/**
 * Adopt the server's timezone and answer with the one now in effect.
 * The date helpers below read APP_TZ at CALL time, so an apply mid-session is
 * enough: nothing has to be re-rendered into place.
 */
const applyServerTimezone = name => {
    const clean = usableTimezone(name);
    if (!clean || clean === APP_TZ) return APP_TZ;
    APP_TZ = clean;
    /* `today` is a function of the zone as much as of the clock. */
    today = date(new Date());
    return APP_TZ;
};

const tzParts = (d, tz) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);
    const g = t => parts.find(p => p.type === t)?.value || '';
    return {
      year: g('year'),
      month: g('month'),
      day: g('day'),
      hour: g('hour'),
      minute: g('minute'),
      second: g('second')
    };
  };

const calendarDateInTz = (d, tz = APP_TZ) => {
    const p = tzParts(d, tz);
    return `${p.year}-${p.month}-${p.day}`;
  };

const date = d => calendarDateInTz(d instanceof Date ? d : new Date(d), APP_TZ);

let today = date(new Date());

const easternOffsetMinutes = (year, month, day) => {
    const utc = Date.UTC(year, month - 1, day, 12);
    const p = tzParts(new Date(utc), APP_TZ);
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second)
    );
    return (asUtc - utc) / 60000;
  };

const parseCallInstant = value => {
    if (!value && value !== 0) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    let raw = String(value).trim();
    if (!raw) return null;
    if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
    if (/^\d{13}$/.test(raw)) return new Date(Number(raw));

    const namedZone = raw.match(/\[([^\]]+)\]$/);
    if (namedZone) {
      raw = raw.replace(/\[[^\]]+\]$/, '').replace(/[zZ]$/, '');
    }

    const m = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
    );
    if (namedZone && m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4] || 0);
      const minute = Number(m[5] || 0);
      const second = Number(m[6] || 0);
      const offsetMin = easternOffsetMinutes(year, month, day);
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000);
    }

    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4] || 0);
      const minute = Number(m[5] || 0);
      const second = Number(m[6] || 0);
      const offsetMin = easternOffsetMinutes(year, month, day);
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000);
    }

    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };

const nsTimestampParts = value => {
    const d = parseCallInstant(value);
    if (d) {
      const p = tzParts(d, APP_TZ);
      let hour = Number(p.hour);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12 || 12;
      return {
        date: p.year + '-' + p.month + '-' + p.day,
        time: hour + ':' + p.minute + ' ' + ampm
      };
    }
    const raw = String(value || '');
    const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return { date: '', time: '' };
    let hour = Number(m[4]);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return {
      date: m[1] + '-' + m[2] + '-' + m[3],
      time: hour + ':' + m[5] + ' ' + ampm
    };
  };

const formatCallDate = value => nsTimestampParts(value).date;

const formatCallTime = value => nsTimestampParts(value).time;

const callCalendarDate = value => {
    const d = parseCallInstant(value);
    return d ? calendarDateInTz(d, APP_TZ) : '';
  };

const rangeDateTimes = (start, end) => {
    /* The day boundaries are the desk's, so a range picked in the browser means
     * the same window the server will slice its cache by (finding C7). */
    const zone = APP_TZ;
    return {
      timezone: zone,
      datetimeStart: String(start) + 'T00:00:00Z[' + zone + ']',
      datetimeEnd: String(end) + 'T23:59:59Z[' + zone + ']'
    };
  };

function formatHistDate(value) {
  if (!value) return '—';
  let raw = String(value).trim();
  const named = /\[[^\]]+\]$/.test(raw);
  raw = raw.replace(/\[[^\]]*\]$/, '');
  if (named) raw = raw.replace(/[zZ]$/, '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let month, day, hour, minute;
  if (m) {
    month = Number(m[2]);
    day = Number(m[3]);
    hour = Number(m[4]);
    minute = Number(m[5]);
  } else {
    const d = new Date(raw.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return String(value);
    month = d.getMonth() + 1;
    day = d.getDate();
    hour = d.getHours();
    minute = d.getMinutes();
  }
  const am = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  return (months[month - 1] || '') + ' ' + day + ', ' + h + ':' + String(minute).padStart(2, '0') + ' ' + am;
}

function formatMmss(n) {
  const s = Math.max(0, Math.floor(Number(n) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function histDayKey(value) {
  const raw = String(value || '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = formatHistDate(value);
  return d.split(',')[0] || d;
}

function histDayLabel(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return key || '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
}

function histTimeOnly(value) {
  const d = formatHistDate(value);
  const i = d.lastIndexOf(',');
  return i >= 0 ? d.slice(i + 1).trim() : d;
}

export { APP_TZ, applyServerTimezone, date, formatCallDate, formatCallTime, formatHistDate, formatMmss, histDayKey, histDayLabel, histTimeOnly, nsTimestampParts, parseCallInstant, rangeDateTimes, today, tzParts };
