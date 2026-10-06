#!/usr/bin/env node
/**
 * CSS coverage check.
 *
 * The past failure mode of this codebase: app.css was a stale compiled
 * Tailwind artifact, so class names used in JS silently had no styling (the
 * page only looked right because portal.php loaded the Tailwind CDN at
 * runtime). This tool makes that drift impossible to miss.
 *
 * It parses only real class attributes/expressions:
 *   - JS :  className: '…' + (cond ? '…' : '…')
 *   - PHP:  class="…"
 * then verifies the built stylesheet has a rule for every token. Missing
 * Tailwind utilities are fatal; missing custom classes are reported as
 * warnings (a few are behavioural markers with no styling of their own).
 *
 *   node tools/css-coverage.mjs            # report
 *   node tools/css-coverage.mjs --strict   # also fail on custom classes
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = path.join(ROOT, 'assets/css/app.css');
const strict = process.argv.includes('--strict');

const SCAN_DIRS = ['assets/js/src', 'includes'];
const SCAN_FILES = ['index.php', 'portal.php'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = [
  ...SCAN_FILES.map(f => path.join(ROOT, f)),
  ...SCAN_DIRS.flatMap(dir => {
    try { return walk(path.join(ROOT, dir)); } catch { return []; }
  })
].filter(f => /\.(php|js)$/.test(f));

const OPEN = '([{', CLOSE = ')]}';

/** Reads the whole className expression, stopping at the delimiter that ends it. */
function classNameSegment(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    else if (c === '\n' && depth === 0) break;
    i++;
  }
  return text.slice(start, i);
}

const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"/g;

const tokens = new Map(); // token -> Set(file)
const addTokens = (literal, file) => {
  for (const raw of literal.split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (!/^-?[a-zA-Z][a-zA-Z0-9_:/[\]().%!-]*$/.test(token)) continue; // CSS-ish only
    if (/^(https?|data|sip|tel|audio|application|text)/.test(token)) continue;
    if (!tokens.has(token)) tokens.set(token, new Set());
    tokens.get(token).add(path.relative(ROOT, file));
  }
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const patterns = file.endsWith('.php')
    ? [/class\s*=\s*"/g, /class\s*=\s*'/g]
    : [/className\s*[:=]\s*/g, /classList\.(add|remove|toggle)\s*\(/g];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      const segment = classNameSegment(text, m.index + m[0].length);
      STRING_LITERAL.lastIndex = 0;
      let lit;
      while ((lit = STRING_LITERAL.exec(segment))) {
        addTokens(lit[1] ?? lit[2] ?? '', file);
      }
    }
  }
}

/*
 * Classes with no stylesheet rule *on purpose*. Keeping this list explicit
 * (with a reason each) means the coverage check stays actionable instead of
 * being ignored as noise.
 */
const EXPECTED_UNSTYLED = new Map([
  /* Font Awesome glyph names — styled by the Font Awesome CSS, not app.css. */
  ...['fa-solid', 'fa-regular', 'fa-bell', 'fa-circle-info', 'fa-circle-check',
      'fa-circle-exclamation', 'fa-triangle-exclamation', 'fa-table-columns', 'fa-users', 'fa-phone']
      .map(t => [t, 'Font Awesome icon name']),
  /* Inert layout hooks: present in markup, no rule in any stylesheet. Left in
   * place deliberately (they cost nothing and document intent); listed here so
   * real drift is visible. Candidates for either styling or removal. */
  ...['ag-ov-main', 'ag-ov-activity', 'ag-ov-missed', 'ag-ov-queues', 'aa-donut-center',
      'aa-donut-legend', 'aa-flow-body', 'aa-flow-head', 'aa-call-sheet', 'dash-donut',
      'hist-party-cell', 'q-path-item', 'qs-qname', 'rec-btn-dl', 'set-row-copy']
      .map(t => [t, 'inert hook, pending styling or removal']),
  /* Not style hooks at all: JS selectors / NetSapiens-portal-compatible markup. */
  ['nav-item', 'queried by JS (nav-item.is-on)'],
  ['cdraudio', 'matches the NetSapiens portal audio markup'],
  ['has-unread', 'bell state marker (count is rendered by .fb-bell-badge)'],
  /* Values from conditional expressions the scanner sees as class literals. */
  ...['start', 'end', 'error', 'pass', 'fail', 'bad', 'aht', 'other', 'hist-flow-ico-']
      .map(t => [t, 'not a class name (expression value)']),
]);

const css = readFileSync(CSS_FILE, 'utf8');
const escapeSelector = token =>
  token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/').replace(/:/g, '\\:').replace(/!/g, '\\!');

const UTILITY =
  /^(hover:|focus:|active:|disabled:|group-|sm:|md:|lg:|xl:|2xl:|dark:|!)?-?((bg|text|border|ring|divide|from|to|via|placeholder|shadow|outline|fill|stroke|accent|caret|decoration|opacity|scale|rotate|translate|skew|transition|duration|delay|ease|animate|cursor|select|pointer-events|resize|scroll|snap|touch|will-change|z|order|col|row|grid|flex|basis|grow|shrink|justify|items|content|self|place|gap|space|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|min-w|max-w|h|min-h|max-h|size|font|leading|tracking|whitespace|break|truncate|list-|indent|align|uppercase|lowercase|capitalize|italic|antialiased|tabular-nums|sr-only|overflow|overscroll|visible|invisible|static|fixed|absolute|relative|sticky|inset|top|right|bottom|left|float|clear|isolate|object|aspect|columns|table|border-collapse|first:|last:|odd:|even:|empty:|block|inline|hidden|rounded|blur|backdrop|appearance)(-|$))/;

const missingUtility = [];
const missingCustom = [];
const expected = [];
for (const [token, sources] of [...tokens].sort()) {
  if (css.includes('.' + escapeSelector(token))) continue;
  const entry = { token, sources: [...sources] };
  if (EXPECTED_UNSTYLED.has(token)) expected.push(entry);
  else (UTILITY.test(token) ? missingUtility : missingCustom).push(entry);
}

const show = list => list.slice(0, 60).map(e => `   - ${e.token.padEnd(32)} ${e.sources.join(', ')}`).join('\n');
console.log(`scanned ${files.length} source files → ${tokens.size} class tokens`);
console.log(`missing utilities: ${missingUtility.length}`);
if (missingUtility.length) console.log(show(missingUtility));
console.log(`missing custom classes: ${missingCustom.length}`);
if (missingCustom.length || strict) console.log(show(missingCustom));
console.log(`expected-unstyled (documented): ${expected.length}`);

if (missingUtility.length || (strict && missingCustom.length)) {
  console.error('\nFAIL: classes used by the UI have no styling in assets/css/app.css.');
  process.exit(1);
}
console.log('\nOK: every Tailwind utility used by the sources is present in the built stylesheet.');
