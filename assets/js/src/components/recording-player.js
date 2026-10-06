/* The recording player: inline audio with a scrubber, a download button and
 * the resolve-on-demand fallback.
 *
 * Was the top of assets/js/src/components/call-history.js; it is now shared
 * with the drill-down calls modal, which grew a Rec column. Same component,
 * same behaviour — Call history passes the URL its background pass already
 * resolved, the modal lets it resolve on mount.
 */

import { NavIcon } from './ui.js';
import { api } from '../lib/api.js';
import { h, useEffect, useRef, useState } from '../lib/react.js';
import { buildRecordingAudio, recordingFileName } from '../lib/recording.js';
import { formatMmss } from '../lib/time.js';

function RecordingPlayer({ row, preresolved, onClose }) {
  /*
   * The table's background pass has almost always resolved this row
   * already — the button only enables once it has. Seeding from that
   * cache means expanding is instant instead of re-running a lookup
   * that is known to succeed.
   */
  const seedUrl = (preresolved && preresolved.url) || '';
  const [state, setState] = useState(seedUrl ? 'ready' : 'loading');
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(
    (preresolved && Number(preresolved.duration)) || Number(row.talking) || 0
  );
  const [url, setUrl] = useState(seedUrl);
  /*
   * The absolute URL the media element actually settled on, taken from
   * currentSrc once a source is selected. The download button mirrors
   * this so you always save the same bytes you are hearing.
   */
  const [downloadSrc, setDownloadSrc] = useState('');
  const audioRef = useRef(null);
  const barRef = useRef(null);

  /* Fall back to resolving here if the row was opened without a cache hit. */
  useEffect(() => {
    if (seedUrl) return undefined;
    let cancelled = false;
    const recId = String(row.recordingCallId || (row.type === 'outbound' || row.type === 'onnet' ? row.origCallId : row.termCallId) || '');
    const recUser = String(row.recordingUser || (row.type === 'outbound' || row.type === 'onnet' ? row.origUser : row.termUser) || '');
    const recUserKey = recUser.replace(/^sip:/i, '').split('@')[0];

    api('recording', {
      callId: recId,
      origCallId: row.origCallId,
      termCallId: row.termCallId,
      extension: recUserKey,
      termUser: row.termUser,
      origUser: row.origUser,
      agent: row.agent
    }).then(res => {
      if (cancelled) return;
      const nsUrl = String((res && res.data && res.data.url) || (res && res.url) || '').replace(/&amp;/gi, '&');
      if (!nsUrl) {
        setState('empty');
        return;
      }
      setUrl(nsUrl);
      /*
       * Seed the scrubber from the CDR talk time so the bar has a sane
       * length before metadata lands; real duration overwrites it on
       * loadedmetadata.
       */
      const hinted = Number((res && res.data && res.data.duration) || 0) || Number(row.talking || 0) || 0;
      if (hinted > 0) setDuration(hinted);
      setState('ready');
    }).catch(() => {
      if (!cancelled) setState('error');
    });

    return () => { cancelled = true; };
  }, [row, seedUrl]);

  /* Build the <audio> once a URL exists, reusing the multi-source fallback. */
  useEffect(() => {
    if (state !== 'ready' || !url) return undefined;

    const audio = buildRecordingAudio(url, row);
    if (!audio) { setState('empty'); return undefined; }

    audio.style.display = 'none';
    document.body.appendChild(audio);
    audioRef.current = audio;

    /*
     * currentSrc is empty until the element commits to a <source>, so it
     * is captured on the first load event rather than up front.
     */
    const captureSrc = () => {
      const chosen = String(audio.currentSrc || '');
      if (chosen) setDownloadSrc(prev => (prev === chosen ? prev : chosen));
    };

    const onMeta = () => {
      captureSrc();
      /* Streamed transcodes can report Infinity until fully buffered. */
      const d = Number(audio.duration);
      if (isFinite(d) && d > 0) setDuration(d);
    };
    const onTime = () => setCurrent(audio.currentTime || 0);
    const onEnd = () => { setPlaying(false); setCurrent(0); try { audio.currentTime = 0; } catch (e) {} };
    const onErr = () => setState('error');

    audio.addEventListener('loadstart', captureSrc);
    audio.addEventListener('loadeddata', captureSrc);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);
    audio.load();

    /* Expanding the row is an explicit "I want to hear this". */
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));

    return () => {
      audio.removeEventListener('loadstart', captureSrc);
      audio.removeEventListener('loadeddata', captureSrc);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onErr);
      try { audio.pause(); } catch (e) {}
      try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
      try { if (audio.parentNode) audio.parentNode.removeChild(audio); } catch (e) {}
      audioRef.current = null;
    };
  }, [state, url, row]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  };

  const seekTo = clientX => {
    const a = audioRef.current;
    const bar = barRef.current;
    if (!a || !bar || !duration) return;
    const box = bar.getBoundingClientRect();
    if (!box.width) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const target = ratio * duration;
    try { a.currentTime = target; setCurrent(target); } catch (e) {}
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const ready = state === 'ready';

  const message = state === 'loading' ? 'Loading recording…'
    : state === 'empty' ? 'No recording was stored for this call.'
    : state === 'error' ? 'Recording could not be loaded.'
    : '';

  return h('div', { className: 'rec-panel' },
    h('button', {
      type: 'button',
      className: 'rec-btn rec-btn-play',
      disabled: !ready,
      'aria-label': playing ? 'Pause' : 'Play',
      title: playing ? 'Pause' : 'Play',
      onClick: toggle
    }, h(NavIcon, { name: playing ? 'pause' : 'play', size: 15 })),

    h('div', { className: 'rec-main' },
      h('div', {
        className: 'rec-track' + (ready ? '' : ' is-idle'),
        ref: barRef,
        role: 'slider',
        tabIndex: ready ? 0 : -1,
        'aria-label': 'Seek',
        'aria-valuemin': 0,
        'aria-valuemax': Math.round(duration),
        'aria-valuenow': Math.round(current),
        onMouseDown: e => { if (ready) seekTo(e.clientX); },
        onKeyDown: e => {
          const a = audioRef.current;
          if (!a || !ready) return;
          if (e.key === 'ArrowRight') { e.preventDefault(); a.currentTime = Math.min(duration, a.currentTime + 5); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 5); }
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        }
      },
        h('div', { className: 'rec-fill', style: { width: pct + '%' } }),
        ready ? h('div', { className: 'rec-thumb', style: { left: pct + '%' } }) : null
      ),
      h('div', { className: 'rec-meta' },
        h('span', { className: 'rec-time' }, formatMmss(current) + ' / ' + formatMmss(duration)),
        message ? h('span', { className: 'rec-msg' + (state === 'error' ? ' is-bad' : '') }, message) : null
      )
    ),

    /*
     * Download the EXACT file that is playing.
     *
     * This used to hardcode convert=wav16, which was wrong in two ways:
     * the browser may have negotiated a different container from the
     * <source> list (so you'd download something other than what you
     * just heard), and if the PBX cannot produce wav16 for that call the
     * proxy returns an error body saved as a .wav — a file that will not
     * open. `downloadSrc` is read off the live element's currentSrc, so
     * it is by definition a format the server actually produced.
     *
     * Still routed through the same-origin proxy: a cross-origin
     * <a download> is ignored by browsers (it navigates instead of
     * saving) and the proxy carries the session auth.
     */
    ready && downloadSrc
      ? h('a', {
          className: 'rec-btn rec-btn-dl',
          href: 'api/recording.php?stream=1&src=' + encodeURIComponent(downloadSrc),
          download: recordingFileName(row, downloadSrc),
          title: 'Download recording',
          'aria-label': 'Download recording',
          onClick: e => e.stopPropagation()
        }, h(NavIcon, { name: 'download', size: 15 }))
      : h('button', {
          type: 'button',
          className: 'rec-btn rec-btn-dl',
          disabled: true,
          title: ready ? 'Preparing download…' : 'No recording available',
          'aria-label': 'Download recording'
        }, h(NavIcon, { name: 'download', size: 15 })),

    h('button', {
      type: 'button',
      className: 'rec-btn rec-btn-close',
      title: 'Collapse',
      'aria-label': 'Collapse',
      onClick: onClose
    }, h(NavIcon, { name: 'chevronUp', size: 15 }))
  );
}

export { RecordingPlayer };
