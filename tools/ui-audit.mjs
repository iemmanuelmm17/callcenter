#!/usr/bin/env node
/**
 * UI consistency audit.
 *
 *   node tools/ui-audit.mjs            # report
 *   node tools/ui-audit.mjs --strict   # exit 1 on findings that must be zero
 *
 * The dashboard is written with React.createElement (`h`) inside a closure, so
 * there is no JSX to parse; this walks the h(...) calls with a real JS parser
 * (esbuild's transform is not enough here, so the checks are token-based with
 * balanced-paren scanning, which is reliable for this codebase's style).
 *
 * Checks
 *  1. CLICKABLE / CURSOR  every element with an onClick handler must say how it
 *     behaves: a `cursor-pointer`/`cursor-default` class, or `disabled:` state.
 *     A div with onClick and no cursor is the classic "looks like text, clicks
 *     like a button" bug.
 *  2. TOOLTIP             interactive controls should carry a `title` (or a
 *     Tooltip/qHelp child) — icon-only buttons are unusable without one.
 *  3. COLOUR DRIFT        hardcoded colours in JS that are not the theme
 *     tokens: charts may use literals, but UI text/background must use the
 *     CSS variables so the light theme keeps working.
 *  4. CURSOR CSS          clickable classes used by the UI must have a
 *     `cursor` rule in the stylesheet.
 *  5. LAZY / SKELETON     components that load data should render a skeleton
 *     while loading, and remote assets should be lazily loaded.
 *  6. SKELETON STYLE      placeholders must use the shared `skel()` helper:
 *     a hand-rolled `animate-pulse bg-slate-800` block does not follow the
 *     light theme and shimmers at a different rate than every other loader.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'assets/js/src/app.js');
const CSS = path.join(ROOT, 'assets/css/src/custom.css');
const SHELL = path.join(ROOT, 'portal.php');
const strict = process.argv.includes('--strict');

const source = readFileSync(APP, 'utf8');
const css = readFileSync(CSS, 'utf8');
const shell = readFileSync(SHELL, 'utf8');
const lines = source.split('\n');
const lineOf = (index) => source.slice(0, index).split('\n').length;

/* ------------------------------------------------------------------ helpers */

/**
 * Walk `h(` call sites and return {tag, props, startIndex, line}.
 * Balanced-paren scanning that respects strings, template literals and
 * comments, which is all this file needs.
 */
function findElements(src) {
  const out = [];
  const re = /(?<![\w.$])h\(\s*(?:'([a-zA-Z][\w-]*)'|([A-Za-z_$][\w$]*))/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const tag = match[1] || match[2];
    /* Grab the argument list: from the '(' after h. */
    const open = src.indexOf('(', match.index + 1);
    let depth = 0;
    let i = open;
    let quote = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const args = src.slice(open + 1, i);
    /* The tag is the first argument; props are the second, when they are an
     * object literal (h('button', { ... }, 'Close')). */
    const rest = afterFirstArgument(args);
    const props = /^\s*\{/.test(rest) ? rest.slice(rest.indexOf('{'), findPropsEnd(rest)) : '';
    out.push({ tag, props, args, index: match.index, line: lineOf(match.index), isComponent: !match[1] });
  }
  return out;
}

/**
 * Arguments after the first top-level comma: `'button', {...}, 'x'` -> `{...}, 'x'`.
 * String, template and bracket aware so a comma inside a value cannot split us.
 */
function afterFirstArgument(args) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return args.slice(i + 1);
  }
  return '';
}

/** End offset of the leading object literal inside an argument list. */
function findPropsEnd(args) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return args.length;
}

const elements = findElements(source);
if (process.env.UI_AUDIT_DEBUG) {
  for (const el of elements.slice(0, 5)) console.log('DEBUG', el.line, el.tag, JSON.stringify(el.props.slice(0, 60)), 'onClick?', /onClick/.test(el.props));
  console.log('DEBUG total', elements.length, 'with props', elements.filter(e => e.props).length);
}

/* ------------------------------------------------------- 1. cursor/clicks */

const CLICK_STYLES = /cursor-(pointer|default|not-allowed|wait)|disabled:opacity|is-click|is-on|hist-export|aa-tab|nav-item|queue-row|tn-tab|sim-tab|aa-side-item/;
const NON_INTERACTIVE = new Set(['div', 'span', 'section', 'td', 'tr', 'li', 'p', 'article', 'main', 'tbody', 'thead', 'table', 'aside', 'header', 'footer', 'strong', 'em', 'small']);
const clickable = elements.filter(el => /\bonClick\s*:/.test(el.props));
const missingCursor = clickable.filter(el => {
  if (el.tag === 'button' || el.tag === 'a' || el.tag === 'input' || el.tag === 'select') return false;
  if (!NON_INTERACTIVE.has(el.tag)) return false;
  return !CLICK_STYLES.test(el.props);
});
const missingRole = clickable.filter(el => {
  if (!NON_INTERACTIVE.has(el.tag)) return false;
  return !/\brole\s*:/.test(el.props) && !/\btabIndex\s*:/.test(el.props) && !/onKeyDown/.test(el.props);
});

/* -------------------------------------------------------------- 2. tooltips */

const hasTooltip = (el) => /\b(title|tooltip|help)\s*:/i.test(el.props) || /Tooltip|qHelp|HelpTip/.test(el.args);
/* A control with a visible text label does not need a tooltip; an icon-only
 * control is unusable without one, so those are the findings that matter. */
const isIconOnly = (el) => {
  const rest = afterFirstArgument(el.args);
  const icon = /fa-(solid|regular|brands)|h\(\s*'i'|\bIcon\b/.test(rest);
  if (!icon) return false;
  /* Any quoted string that is not a class/title/fa name counts as a label. */
  const texts = [...rest.matchAll(/,\s*'([^']{2,})'/g)].map(m => m[1])
    .filter(text => !/^(fa-|text-|bg-|border|rounded|flex|grid|p-|m-|w-|h-|min-|max-|gap-|cursor-)/.test(text));
  return texts.length === 0;
};
const interactive = elements.filter(el => el.tag === 'button' || /\bonClick\s*:/.test(el.props));
const missingTooltip = interactive.filter(el => isIconOnly(el) && !hasTooltip(el));

/* --------------------------------------------------------- 3. colour drift */

const themeTokens = new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map(m => m[1]));
const jsColorLiterals = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => ({ value: m[0], line: lineOf(m.index) }));
/* A literal is "drift" when the same colour exists as a theme token: the UI
 * should reference the token so the light/dark remap applies. */
const tokenByHex = new Map();
for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
  tokenByHex.set(m[2].toLowerCase(), m[1]);
}
const drift = jsColorLiterals.filter(c => tokenByHex.has(c.value.toLowerCase()));
/* Semantic palette used by charts and badges. A semantic that appears with two
 * different literals (two greens, two reds) is a colour inconsistency. */
const SEMANTICS = [
  { name: 'ok/green', hue: /^#(3[0-9a-f]|2[0-9a-f]|1[0-9a-f])[0-9a-f]{2}(3[0-9a-f]|4[0-9a-f]|5[0-9a-f])|^#(22c55e|34d399|10b981|31a24c)/i },
  { name: 'bad/red', hue: /^#(f8|ef|e4|f4|dc)[0-9a-f]{4}|^#(f87171|ef4444|e41e3f)/i },
  { name: 'warn/amber', hue: /^#(f5|f0|fb|f59)[0-9a-f]{4}|^#(f59e0b|fbbf24|f97316)/i }
];
const semanticUse = new Map();
for (const literal of jsColorLiterals) {
  for (const semantic of SEMANTICS) {
    if (!semantic.hue.test(literal.value)) continue;
    if (!semanticUse.has(semantic.name)) semanticUse.set(semantic.name, new Map());
    const bucket = semanticUse.get(semantic.name);
    if (!bucket.has(literal.value)) bucket.set(literal.value, []);
    const lines = bucket.get(literal.value);
    if (lines.length < 6) lines.push(literal.line);
  }
}
const colourInconsistency = [...semanticUse.entries()]
  .filter(([, bucket]) => bucket.size > 1)
  .map(([name, bucket]) => ({ name, values: [...bucket.keys()] }));

const driftByColor = new Map();
for (const c of drift) {
  const key = c.value.toLowerCase();
  if (!driftByColor.has(key)) driftByColor.set(key, { token: tokenByHex.get(key), count: 0, lines: [] });
  const entry = driftByColor.get(key);
  entry.count++;
  if (entry.lines.length < 4) entry.lines.push(c.line);
}

/* ------------------------------------------------------------ 4. cursor css */

/* Only classes that actually sit on a clickable element are "click hooks";
 * everything else (q-table-wrap, dash-card, …) is decoration and needs no
 * cursor rule. Tailwind cursor-* utilities count as a rule. */
const cssCursorClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)[^{}]*\{[^{}]*cursor:\s*pointer/gs)].map(m => m[1]));
const cssDefaultClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)[^{}]*\{[^{}]*cursor:\s*default/gs)].map(m => m[1]));
const clickableClasses = new Map(); /* class -> first element that clicks */
for (const el of clickable) {
  if (/cursor-(pointer|default|not-allowed|wait)/.test(el.props)) continue;
  if (el.tag === 'button' || el.tag === 'a' || el.tag === 'input' || el.tag === 'select') continue;
  const classText = (el.props.match(/className\s*:\s*'([^']*)'/) || [])[1] || '';
  const UTILITY = /^(?:[a-z-]*:)*(?:text|bg|border|rounded|shadow|flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|top|bottom|left|right|inset|z|w|h|min|max|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space|overflow|opacity|transition|duration|truncate|whitespace|leading|tracking|font|items|justify|content|self|order|col|row|basis|grow|shrink|cursor|pointer|select|align|tabular|antialiased|uppercase|capitalize|underline|list|float|clear|object|aspect|container|ring|divide|outline|sr|not|first|last|odd|even|group|peer)(?:-|$)/;
  for (const name of classText.split(/\s+/).filter(Boolean)) {
    if (UTILITY.test(name)) continue;
    if (!clickableClasses.has(name)) clickableClasses.set(name, el);
  }
}
const cursorlessHooks = [...clickableClasses.entries()]
  .filter(([name]) => !cssCursorClasses.has(name) && !cssDefaultClasses.has(name))
  .map(([name, el]) => ({ name, line: el.line, tag: el.tag }));

/* ------------------------------------------------- 5. lazy + skeleton usage */

const skeletonComponents = new Set([...source.matchAll(/(?:function|const)\s+([A-Za-z_$][\w$]*)\s*[=(]/g)].map(m => m[1]));
const componentsWithLoading = [...source.matchAll(/\bconst\s+\[(\w*[Ll]oading)\w*,\s*set\w*\]\s*=\s*useState\(true\)/g)].map(m => m[1]);
/* Which components render `skel`/`skeleton` inside their own body? */
const componentBodies = new Map();
{
  /* Component boundaries are PascalCase declarations only: a nested helper
   * such as `const tile = (` is camelCase and must not cut the body short
   * (it did, which reported skeletons as missing on components that render
   * them further down). */
  const re = /^(?:  )?(?:function|const)\s+([A-Z][\w$]*)\s*[=(]/gm;
  const starts = [...source.matchAll(re)].map(m => ({ name: m[1], index: m.index, line: lineOf(m.index) }));
  starts.forEach((entry, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    componentBodies.set(entry.name, { line: entry.line, body: source.slice(entry.index, end) });
  });
}
const lazyCandidates = [...componentBodies.entries()]
  .filter(([, info]) => /\buseState\(true\)/.test(info.body) && /\bapi\(/.test(info.body))
  .filter(([, info]) => !/skel(?:eton)?[A-Z(]|skelPanel|skelKpis|loading &&|loading \?/.test(info.body))
  /* Passing `loading` down to a child that renders the skeleton is fine:
   * an object-literal prop (`\n  loading,` / `loading }`) is not the same as
   * the state declaration (`const [loading, setLoading]`). */
  .filter(([, info]) => !/\n\s*loading\s*[,}]/.test(info.body))
  .map(([name, info]) => ({ name, line: info.line }));

/* Hand-rolled skeleton blocks: an `animate-pulse` element that is shaped like a
 * placeholder (h-/w- sizing, bg-slate-*) instead of the shared shimmer helper. */
const handRolledSkeletons = [...source.matchAll(/className:\s*'([^']*\banimate-pulse[^']*)'/g)]
  .filter(m => /(?:^|\s)(?:h-|w-|bg-slate-)/.test(m[1]))
  .map(m => ({ line: lineOf(m.index), classes: m[1] }));

const shellScripts = [...shell.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
const shellStyles = [...shell.matchAll(/<link[^>]*href="([^"]+)"/g)].map(m => m[1]);
const remoteAssets = [...shellScripts, ...shellStyles].filter(url => /^https?:/.test(url));
const lazyAttrs = [...source.matchAll(/loading\s*=\s*'lazy'|loading:\s*'lazy'/g)].length;
const imageElements = [...source.matchAll(/h\(\s*'(?:img)'/g)].length;
/* Tabulator is ~500 kB and only the call modal needs it: the shell must load it
 * through ensureTabulator() on first use, never eagerly. Dropping the eager
 * tags without the loader in app.js would silently break the call table. */
const eagerHeavyAssets = remoteAssets.filter(url => /tabulator/i.test(url));
const tabulatorLazyLoader = /ensureTabulator\s*=/.test(source) && /tabulator-tables@6\.3\.1/.test(source);
const lazyDependencyFindings = [
  ...eagerHeavyAssets.map(url => ({ line: 0, detail: 'loaded eagerly by the shell: ' + url })),
  ...(eagerHeavyAssets.length === 0 && !tabulatorLazyLoader
    ? [{ line: 0, detail: 'no eager Tabulator tag and no ensureTabulator() loader in app.js' }]
    : [])
];


/* ----------------------------------------------------------------- report */

const section = (title, rows, format) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (!rows.length) { console.log('  none'); return; }
  for (const row of rows.slice(0, 25)) console.log('  - ' + format(row));
  if (rows.length > 25) console.log(`  … ${rows.length - 25} more`);
};

console.log(`scanned ${elements.length} elements, ${clickable.length} clickable, ${lines.length} lines of app.js`);
console.log(`stylesheet: ${cssCursorClasses.size} classes with cursor: pointer, ${themeTokens.size} colour tokens`);

section('interactive element without cursor styling', missingCursor,
  el => `h('${el.tag}') line ${el.line} — ${(el.props.match(/className\s*:\s*'([^']{0,70})'/) || [, ''])[1]}`);
section('interactive element without role/tabIndex', missingRole,
  el => `h('${el.tag}') line ${el.line}`);
section('interactive element without a tooltip', missingTooltip,
  el => `h('${el.tag}') line ${el.line} — ${(el.props.match(/className\s*:\s*'([^']{0,60})'/) || [, ''])[1]}`);
section('JS colour literals duplicating a theme token', [...driftByColor.entries()],
  ([hex, info]) => `${hex} == --color-${info.token} — ${info.count}× (lines ${info.lines.join(', ')})`);
section('clickable classes with no cursor rule', cursorlessHooks,
  row => `h('${row.tag}') line ${row.line} — .${row.name}`);
section('components with a loading state but no skeleton', lazyCandidates,
  c => `${c.name}() line ${c.line}`);
section('placeholder not using the shared skel() helper', handRolledSkeletons,
  row => `line ${row.line} — ${row.classes}`);
section('heavy dependency not lazy-loaded', lazyDependencyFindings, row => row.detail);
section('remote assets in the shell', remoteAssets, url => url);
console.log(`\n## lazy-loading attributes\n  loading='lazy' occurrences: ${lazyAttrs}`);
console.log(`  components with loading state: ${componentsWithLoading.length}`);
console.log(`  images in the bundle: ${imageElements} (lazy-capable: ${imageElements ? 'yes' : 'not applicable — no <img> here'})`);


const blocking = {
  cursors: missingCursor.length,
  colours: driftByColor.size,
  cssCursors: cursorlessHooks.length,
  handRolledSkeletons: handRolledSkeletons.length,
  lazyDependencies: lazyDependencyFindings.length
};
console.log(`\nsummary: ${blocking.cursors} cursor findings, ${blocking.colours} colour-drift groups, ${blocking.cssCursors} css cursor gaps, ${missingTooltip.length} tooltip findings, ${lazyCandidates.length} skeleton findings, ${blocking.handRolledSkeletons} hand-rolled placeholders, ${blocking.lazyDependencies} eager heavy assets`);
if (strict) {
  const total = blocking.cursors + blocking.colours + blocking.cssCursors + blocking.handRolledSkeletons + blocking.lazyDependencies;
  if (total > 0) {
    console.log(`\n${total} issue(s) that must be zero`);
    process.exit(1);
  }
  console.log('\nUI AUDIT OK');
}
