/**
 * Vendor path check — the bug that made every call modal fail.
 *
 * `ensureTabulator()` used to build its script URL by hand
 * ('assets/vendor/tabulator/' + 'js/tabulator.min.js'). The vendored library is
 * shipped flat ('assets/vendor/tabulator/tabulator.min.js'), so the browser
 * requested a file that does not exist, the script 404'd, and the dialog showed
 * "Unable to load the call table." — for everyone, on every drill-down, while
 * every suite stayed green because no test had ever asked where the file IS.
 *
 * Three things are asserted, and they must agree with each other:
 *
 *   1. every path VENDOR.json advertises (its lazy src/href and every target)
 *      exists on disk;
 *   2. the path the CLIENT falls back to is the manifest's path, not a second
 *      guess;
 *   3. the integrity the client would check is the manifest's hash, so a
 *      lazily injected script is verified exactly like a <script> tag.
 *
 *   node tests/js/vendor-paths.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 300));
  }
};

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/vendor/VENDOR.json'), 'utf8'));
const source = readFileSync(path.join(ROOT, 'assets/js/src/lib/react.js'), 'utf8');

console.log('\n== vendored files are where the manifest says they are ==');

for (const file of manifest.files || []) {
  check(`${file.id} exists at ${file.target}`, existsSync(path.join(ROOT, file.target)), file.target);
}

console.log('\n== the lazy-load paths (what ensureTabulator() requests) ==');

const lazy = manifest.lazy || {};
check('the manifest publishes a lazy path for the JS and the CSS',
  !!(lazy.tabulatorJs && lazy.tabulatorJs.src) && !!(lazy.tabulatorCss && lazy.tabulatorCss.href),
  Object.keys(lazy));

for (const [key, entry] of Object.entries(lazy)) {
  const relative = entry.src || entry.href || '';
  check(`${key} points at a file that exists`, !!relative && existsSync(path.join(ROOT, relative)), relative);
}

/*
 * The client's fallback is only used when the manifest element is missing, but
 * it must still be the truth: a wrong fallback is how the original bug shipped.
 */
const fallbackBlock = source.match(/const VENDOR_FALLBACK = \{([\s\S]*?)\n\};/);
check('the client declares a vendor fallback table', !!fallbackBlock, 'VENDOR_FALLBACK not found');
if (fallbackBlock) {
  const block = fallbackBlock[1];
  const jsSrc = (block.match(/tabulatorJs:\s*\{\s*src:\s*'([^']+)'/) || [])[1] || '';
  const cssHref = (block.match(/tabulatorCss:\s*\{\s*href:\s*'([^']+)'/) || [])[1] || '';
  check('the client JS fallback is the manifest path', jsSrc === (lazy.tabulatorJs || {}).src,
    { client: jsSrc, manifest: (lazy.tabulatorJs || {}).src });
  check('the client CSS fallback is the manifest path', cssHref === (lazy.tabulatorCss || {}).href,
    { client: cssHref, manifest: (lazy.tabulatorCss || {}).href });
  check('the client fallback paths exist on disk too',
    existsSync(path.join(ROOT, jsSrc)) && existsSync(path.join(ROOT, cssHref)), [jsSrc, cssHref]);
}

/*
 * The loader must read paths from the manifest rather than composing them; if a
 * future edit reintroduces a hand-built URL, this catches it.
 */
check('the loader does not concatenate a base path by hand',
  !/TABULATOR_BASE\s*\+/.test(source) && !/assets\/vendor\/tabulator\/js\//.test(source),
  'a hand-built tabulator URL is back in react.js');
check('the loader reads the src from the vendor manifest',
  /jsEntry\.src/.test(source) && /cssEntry\.href/.test(source), 'the loader ignores the manifest paths');
check('the loader still applies the manifest integrity hash',
  /jsEntry\.integrity/.test(source) && /cssEntry\.integrity/.test(source), 'SRI dropped from the loader');

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('VENDOR PATHS OK');
