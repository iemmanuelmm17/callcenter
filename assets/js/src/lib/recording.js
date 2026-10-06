/* Recording URL variants and the audio element used by the player.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

const RECORDING_VARIANTS = [
  { convert: 'wav16', type: 'audio/wav' },
  { convert: 'aac', type: 'audio/aac' },
  { convert: 'aac', type: 'audio/mp4' },
  { convert: 'mp3', type: 'audio/mpeg' }
];

function recordingUrlWithConvert(url, convert) {
  let clean = String(url || '').trim();
  if (!clean) return '';

  /* The API hands these back HTML-escaped; &amp; is not a query separator. */
  clean = clean.replace(/&amp;/gi, '&');

  /* Drop any convert the server pre-baked in, then append ours. */
  clean = clean
    .replace(/([?&])convert=[^&#]*/gi, '$1')
    .replace(/&&+/g, '&')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');

  return clean + (clean.indexOf('?') === -1 ? '?' : '&') + 'convert=' + encodeURIComponent(convert);
}

function recordingSources(nsUrl) {
  const base = String(nsUrl || '').trim();
  if (!base) return [];

  const direct = [];
  const proxied = [];

  RECORDING_VARIANTS.forEach(variant => {
    const url = recordingUrlWithConvert(base, variant.convert);
    if (!url) return;
    direct.push({ src: url, type: variant.type });
    proxied.push({
      src: 'api/recording.php?stream=1&src=' + encodeURIComponent(url),
      type: variant.type
    });
  });

  return direct.concat(proxied);
}

function buildRecordingAudio(nsUrl, row) {
  const sources = recordingSources(nsUrl);
  if (!sources.length) return null;

  const audio = document.createElement('audio');
  audio.className = 'cdraudio';
  audio.preload = 'auto';
  audio.id = 'audio-' + String((row && (row.termCallId || row.origCallId || row.id)) || '');
  if (row && row.origCallId) audio.setAttribute('data-orig-id', String(row.origCallId));
  if (row && row.termCallId) audio.setAttribute('data-term-id', String(row.termCallId));

  sources.forEach(source => {
    const el = document.createElement('source');
    el.src = source.src;
    el.type = source.type;
    audio.appendChild(el);
  });

  return audio;
}

function recordingFileName(row, src) {
  const stamp = String(row.startedAt || '').replace(/[^\d]/g, '').slice(0, 12);
  const a = String(row.fromNumber || row.from || 'call').replace(/[^\w+]/g, '');
  const b = String(row.dialed || row.to || '').replace(/[^\w+]/g, '');
  const convert = (String(src || '').match(/[?&]convert=([^&#]+)/i) || [])[1] || '';
  const ext = /wav/i.test(convert) ? 'wav'
    : /mp3/i.test(convert) ? 'mp3'
    : /aac|mp4|m4a/i.test(convert) ? 'm4a'
    : 'wav';
  return ['rec', stamp, a, b].filter(Boolean).join('_').slice(0, 90) + '.' + ext;
}

export { buildRecordingAudio, recordingFileName };
