/* React bindings used by every module: the hook shortcuts, the createElement alias, the two interaction helpers and the lazy Tabulator loader.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

const {useEffect,useMemo,useRef,useState,useCallback} = React;

const h = React.createElement;
const Fragment = React.Fragment;

const keyActivate = handler => event => {
    if (!handler) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      handler(event);
    }
  };

/*
 * QA-3: Tabulator is vendored (tools/vendor.mjs) and served from this origin.
 * portal.php renders the integrity hashes into #vendor-manifest so a lazily
 * injected script is checked the same way a <script> tag would be.
 *
 * The PATHS come out of that same manifest. They used to be built here by hand
 * ('assets/vendor/tabulator/' + 'js/tabulator.min.js'), and when the vendored
 * layout flattened to 'assets/vendor/tabulator/tabulator.min.js' the browser
 * requested a file that does not exist: the script 404'd, the loader rejected,
 * and every call modal said "Unable to load the call table." The manifest
 * already publishes both the path and the hash, so there is now one place a
 * path can be wrong and it is the file that generated itself.
 */
const VENDOR_FALLBACK = {
    tabulatorJs: { src: 'assets/vendor/tabulator/tabulator.min.js' },
    tabulatorCss: { href: 'assets/vendor/tabulator/tabulator_midnight.min.css' }
};

const vendorEntry = key => {
    const fallback = VENDOR_FALLBACK[key] || {};
    try {
      const node = document.getElementById('vendor-manifest');
      if (!node) return fallback;
      const parsed = JSON.parse(node.textContent || '{}');
      const entry = parsed && parsed[key];
      return entry && typeof entry === 'object' ? entry : fallback;
    } catch (e) {
      return fallback;
    }
  };

let tabulatorPromise = null;

const ensureTabulator = () => {
    if (typeof window !== 'undefined' && window.Tabulator) return Promise.resolve(window.Tabulator);
    if (tabulatorPromise) return tabulatorPromise;
    tabulatorPromise = new Promise((resolve, reject) => {
      let cssReady = false;
      let jsReady = false;
      const settle = () => {
        if (!cssReady || !jsReady) return;
        if (window.Tabulator) resolve(window.Tabulator);
        else reject(new Error('Tabulator did not initialise'));
      };
      const cssEntry = vendorEntry('tabulatorCss');
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = cssEntry.href || VENDOR_FALLBACK.tabulatorCss.href;
      if (cssEntry.integrity) css.integrity = cssEntry.integrity;
      /* A missing stylesheet must not block the table itself. */
      css.onload = css.onerror = () => { cssReady = true; settle(); };
      document.head.appendChild(css);
      const jsEntry = vendorEntry('tabulatorJs');
      const script = document.createElement('script');
      if (jsEntry.integrity) script.integrity = jsEntry.integrity;
      script.src = jsEntry.src || VENDOR_FALLBACK.tabulatorJs.src;
      script.onload = () => { jsReady = true; settle(); };
      script.onerror = () => reject(new Error('Tabulator failed to load'));
      document.head.appendChild(script);
    });
    return tabulatorPromise;
  };

const useEscape = (open, onClose) => {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
      if (!open) return undefined;
      const onKey = event => {
        /* defaultPrevented, because two listeners can be on `document` at the
         * same time (a dialog inside a dialog, a player inside a dialog) and
         * stopPropagation() does not stop a sibling listener on the same
         * target. The innermost layer wins; one Escape never closes two. */
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
        }
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [open]);
  };

export { ensureTabulator, Fragment, h, keyActivate, useCallback, useEffect, useEscape, useMemo, useRef, useState };
