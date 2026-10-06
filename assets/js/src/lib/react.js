/* React bindings used by every module: the hook shortcuts, the createElement alias, the two interaction helpers and the lazy Tabulator loader.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

const {useEffect,useMemo,useRef,useState,useCallback} = React;

const h = React.createElement;

const keyActivate = handler => event => {
    if (!handler) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      handler(event);
    }
  };

const TABULATOR_BASE = 'https://unpkg.com/tabulator-tables@6.3.1/dist/';

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
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = TABULATOR_BASE + 'css/tabulator_midnight.min.css';
      /* A missing stylesheet must not block the table itself. */
      css.onload = css.onerror = () => { cssReady = true; settle(); };
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = TABULATOR_BASE + 'js/tabulator.min.js';
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

export { ensureTabulator, h, keyActivate, useCallback, useEffect, useEscape, useMemo, useRef, useState };
