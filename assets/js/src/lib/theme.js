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
/*
 * QA-3: the icon font (cdnjs) and IBM Plex Mono (fonts.googleapis.com) used to
 * be injected here from public CDNs. Both are vendored and loaded by
 * portal.php from assets/vendor, so nothing in the app reaches a third party.
 * Loading them in the document head is also one round-trip earlier than a
 * post-bundle injection was.
 */

export { applyTheme, readTheme };
