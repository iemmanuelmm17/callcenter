/* Theme selection: the persisted preference and the stylesheet injection that must run before the first render.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

const THEME_KEY = 'callscope-theme';

const readTheme = () => {
    try {
      return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  };

const applyTheme = theme => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
  };

applyTheme(readTheme());

if (!document.getElementById('fa-icons')) {
    const fa = document.createElement('link');
    fa.id = 'fa-icons';
    fa.rel = 'stylesheet';
    fa.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
    document.head.appendChild(fa);
  }

if (!document.getElementById('plex-mono')) {
    const plex = document.createElement('link');
    plex.id = 'plex-mono';
    plex.rel = 'stylesheet';
    plex.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&display=swap';
    document.head.appendChild(plex);
  }

export { applyTheme, readTheme };
