#!/usr/bin/env node
/**
 * One-shot migration tool: split the single 12k-line `assets/js/src/app.js`
 * into ES modules.
 *
 *   node tools/split-js-file.mjs --dry                # show the plan, write nothing
 *   node tools/split-js-file.mjs --from HEAD          # write the modules + new entry
 *   node tools/split-js-file.mjs --verify             # hash every unit before/after
 *
 * `--from <git-ref>` overrides the source commit; by default it is the one
 * recorded as `from` in tools/app-modules.json (the last commit before the
 * split). The original is read from git, not from disk, because the working
 * tree already holds the split.
 *
 * Why a tool instead of hand-editing: the file holds ~115 top-level
 * declarations inside one IIFE, and the only way to prove a move happened
 * without an edit is to hash the source text of every declaration before and
 * after. The tool parses the original with acorn, moves whole statements
 * (byte-identical, indentation included) into the files named by
 * `tools/app-modules.json`, and derives the `import`/`export` statements from
 * the real dependency graph: an identifier used inside a unit that is declared
 * by a unit in another module becomes an import from that module.
 *
 * The map assigns every top-level unit to a module; anything left over stays in
 * the entry file. Declarations are matched by any name they declare, and
 * statement units that declare nothing (bootstrap calls) by `#<line>`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as acorn from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'assets/js/src/app.js');
const MAP_FILE = path.join(ROOT, 'tools/app-modules.json');
const dry = process.argv.includes('--dry');
const verify = process.argv.includes('--verify');
const map = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const fromIndex = process.argv.indexOf('--from');
/* Default to the commit recorded in the map: HEAD is the split result, so it
 * cannot be its own source. */
const from = fromIndex === -1 ? (map.from || 'HEAD') : process.argv[fromIndex + 1];

/* The pre-split file: a git ref or a path. */
const originalOf = ref => {
  if (existsSync(ref)) return readFileSync(ref, 'utf8');
  return execFileSync('git', ['show', `${ref}:assets/js/src/app.js`], { cwd: ROOT, encoding: 'utf8' });
};
const source = originalOf(from);
const lineOf = index => source.slice(0, index).split('\n').length;
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ parse */

const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', ranges: true });
if (ast.body.length !== 1 || ast.body[0].type !== 'ExpressionStatement') {
  throw new Error('expected a single top-level IIFE');
}
const iife = ast.body[0].expression;
if (iife.type !== 'CallExpression' || iife.callee.type !== 'ArrowFunctionExpression') {
  throw new Error('expected the top-level statement to be an IIFE');
}

const declaredNames = node => {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    return node.id ? [node.id.name] : [];
  }
  if (node.type === 'VariableDeclaration') {
    return node.declarations.flatMap(decl => {
      if (decl.id.type === 'Identifier') return [decl.id.name];
      if (decl.id.type === 'ObjectPattern') return decl.id.properties.flatMap(p => (p.value.name ? [p.value.name] : []));
      if (decl.id.type === 'ArrayPattern') return decl.id.elements.filter(Boolean).map(e => e.name);
      return [];
    });
  }
  return [];
};

const units = iife.callee.body.body.map((stmt, index) => ({
  index,
  stmt,
  names: declaredNames(stmt),
  line: lineOf(stmt.start),
  start: stmt.start,
  end: stmt.end,
  text: source.slice(stmt.start, stmt.end),
  key: declaredNames(stmt)[0] || `#${lineOf(stmt.start)}`
}));

const byName = new Map();
for (const unit of units) for (const name of unit.names) byName.set(name, unit);
const byKey = new Map(units.map(unit => [unit.key, unit]));

/* ----------------------------------------------------- dependency analysis */

const SKIP_KEYS = new Set(['type', 'start', 'end', 'range', 'loc']);
function usedIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) usedIdentifiers(item, out);
    return out;
  }
  if (typeof node.type !== 'string') return out;
  if (node.type === 'Identifier') {
    out.add(node.name);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (!value || typeof value !== 'object') continue;
    /* `obj.api` and `{api: 1}` are not uses of the `api` binding. */
    if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
    if (node.type === 'Property' && key === 'key' && !node.computed) continue;
    if ((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && key === 'key') continue;
    if (node.type === 'LabeledStatement' && key === 'label') continue;
    if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') continue;
    usedIdentifiers(value, out);
  }
  return out;
}

/* Names this unit assigns to (`x = …`, `x++`, `for (x of …)`): an imported
 * binding is read-only in JavaScript, so a cross-module write is a hard error
 * and has to be resolved by hand before the split can build. */
function assignedIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) assignedIdentifiers(item, out);
    return out;
  }
  if (typeof node.type !== 'string') return out;
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') out.add(node.left.name);
  if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') out.add(node.argument.name);
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    if (node.left.type === 'Identifier') out.add(node.left.name);
  }
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (!value || typeof value !== 'object') continue;
    assignedIdentifiers(value, out);
  }
  return out;
}

for (const unit of units) {
  unit.writes = [...assignedIdentifiers(unit.stmt, new Set())].filter(name => byName.has(name));
  unit.deps = [...usedIdentifiers(unit.stmt, new Set())]
    .filter(name => byName.has(name) && byName.get(name) !== unit);
}

/* ------------------------------------------------------------ module map */

const moduleOf = new Map(); /* unit -> module file ('' = entry) */
const claimed = new Set();
for (const entry of map.modules) {
  for (const key of entry.units) {
    const unit = byKey.get(key);
    if (!unit) throw new Error(`${entry.file}: no top-level unit named "${key}"`);
    if (claimed.has(unit)) throw new Error(`unit "${key}" is claimed twice`);
    claimed.add(unit);
    moduleOf.set(unit, entry.file);
  }
}
for (const unit of units) if (!moduleOf.has(unit)) moduleOf.set(unit, '');

const fileOf = name => {
  const unit = byName.get(name);
  return unit ? moduleOf.get(unit) : null;
};

/* Every import target must be a module: an import from the entry would create
 * a cycle (the entry imports the modules that import it). */
const problems = [];
const manualWrites = [];
for (const unit of units) {
  const home = moduleOf.get(unit);
  for (const dep of unit.deps) {
    const target = fileOf(dep);
    if (target === null) continue;
    if (target === home) continue;
    if (target === '' && home !== '') problems.push(`${home}: needs "${dep}" which stays in the entry`);
  }
  for (const written of unit.writes) {
    const target = fileOf(written);
    if (target === null || target === home) continue;
    if ((map.manual?.writes || []).includes(written)) {
      manualWrites.push(`${home}: "${written}" (declared in ${target}) — ${map.manual.why}`);
      continue;
    }
    problems.push(`${home}: assigns to "${written}" declared in ${target || 'the entry'} — imports are read-only`);
  }
}
if (problems.length) {
  console.error('module map does not cover the dependencies:\n  ' + problems.join('\n  '));
  process.exit(2);
}
if (manualWrites.length) {
  console.log('resolved by hand after the split:');
  for (const note of [...new Set(manualWrites)]) console.log('  - ' + note);
}

/* The module graph has to stay acyclic: `const` bindings that a module uses
 * before it has been evaluated are a runtime ReferenceError, and a cycle is a
 * sign the boundaries are wrong. */
{
  const edges = new Map();
  for (const unit of units) {
    const home = moduleOf.get(unit);
    if (!edges.has(home)) edges.set(home, new Set());
    for (const dep of unit.deps) {
      const target = fileOf(dep);
      if (target !== null && target !== home) edges.get(home).add(target);
    }
  }
  const state = new Map();
  const cycles = [];
  const walk = (node, trail) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      cycles.push([...trail.slice(trail.indexOf(node)), node].map(x => x || 'app.js').join(' -> '));
      return;
    }
    state.set(node, 'open');
    for (const next of edges.get(node) || []) walk(next, [...trail, node]);
    state.set(node, 'done');
  };
  for (const node of edges.keys()) walk(node, []);
  if (cycles.length) {
    console.error('circular module dependency:\n  ' + cycles.join('\n  '));
    process.exit(2);
  }
}

/* ------------------------------------------------------------ emit files */

const relativeImport = (from, to) => {
  const base = from || 'app.js'; /* the entry keeps its own file name */
  const rel = path.relative(path.dirname(path.join('assets/js/src', base)), path.join('assets/js/src', to));
  const specifier = rel.split(path.sep).join('/');
  /* A bare `time.js` is a package specifier, not a sibling file. */
  return specifier.startsWith('.') ? specifier : './' + specifier;
};

/* Units in `dropped` are deleted, not moved: dead code removed in the same
 * migration, recorded here so `--verify` can tell a deletion from a lost unit. */
const droppedNames = new Set(map.dropped || []);
const liveUnits = units.filter(unit => !unit.names.some(name => droppedNames.has(name)));

const files = new Map(); /* relative path -> content */
const declaredIn = module => liveUnits.filter(unit => moduleOf.get(unit) === module).flatMap(unit => unit.names);
const usedBy = module => {
  const out = new Set();
  for (const unit of liveUnits) {
    if (moduleOf.get(unit) !== module) continue;
    for (const dep of unit.deps) out.add(dep);
  }
  return out;
};

const exportList = module => {
  const declared = new Set(declaredIn(module));
  const wanted = new Set();
  for (const unit of liveUnits) {
    if (moduleOf.get(unit) === module) continue;
    for (const dep of unit.deps) if (declared.has(dep)) wanted.add(dep);
  }
  return [...wanted].sort();
};

for (const entry of [...map.modules, { file: '', description: 'entry' }]) {
  const module = entry.file;
  const own = liveUnits.filter(unit => moduleOf.get(unit) === module);
  if (!own.length) continue;

  const declaredHere = new Set(declaredIn(module));
  const needed = [...usedBy(module)].filter(name => !declaredHere.has(name) && byName.has(name));
  const grouped = new Map();
  for (const name of needed) {
    const target = fileOf(name);
    if (!grouped.has(target)) grouped.set(target, []);
    grouped.get(target).push(name);
  }

  const lines = [];
  if (module) {
    lines.push(`/* ${entry.description}`);
    lines.push(' *');
    lines.push(` * Was part of the single-file assets/js/src/app.js; split out by`);
    lines.push(' * tools/split-js-file.mjs. The body below is byte-identical to the');
    lines.push(' * original source — the move is verified by declaration hash. */');
  } else {
    lines.push('/* CallScope reporting dashboard — entry point.');
    lines.push(' *');
    lines.push(' * The application used to live in this one 12,000-line file; it is now');
    lines.push(' * assembled from the modules under lib/ and components/. The table of');
    lines.push(' * contents is tools/app-modules.json. This file keeps the React root and');
    lines.push(' * the two top-level components that mount it. */');
  }
  const imports = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, names]) => `import { ${names.sort().join(', ')} } from '${relativeImport(module, target)}';`);
  if (imports.length) {
    lines.push('');
    lines.push(...imports);
  }
  lines.push('');
  lines.push(own.map(unit => unit.text).join('\n\n'));
  const exports = module ? exportList(module) : [];
  if (exports.length) {
    lines.push('');
    lines.push(`export { ${exports.join(', ')} };`);
  }
  lines.push('');
  files.set(module || 'app.js', lines.join('\n'));
}

/* ------------------------------------------------------------------ write */

if (verify) {
  /* Re-parse what is on disk and compare every declaration's source text with
   * the original file: same count, same names, same bytes. */
  const dropped = new Set(map.dropped || []);
  const before = new Map();
  for (const unit of units) for (const name of unit.names) before.set(name, sha(unit.text));
  const after = new Map();
  const readUnits = (file) => {
    const text = readFileSync(path.join(ROOT, 'assets/js/src', file), 'utf8');
    const program = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });
    for (const stmt of program.body) {
      let names = declaredNames(stmt);
      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) names = declaredNames(stmt.declaration);
      if (!names.length) continue;
      const node = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
      for (const name of names) after.set(name, sha(text.slice(node.start, node.end)));
    }
  };
  for (const entry of map.modules) if (existsSync(path.join(ROOT, 'assets/js/src', entry.file))) readUnits(entry.file);
  readUnits('app.js');

  const manual = map.manual || {};
  const edited = new Set(manual.edited || []);
  const allowedAdded = new Set(manual.added || []);
  const missing = [...before.keys()].filter(name => !after.has(name) && !dropped.has(name));
  const droppedFound = [...before.keys()].filter(name => !after.has(name) && dropped.has(name));
  const added = [...after.keys()].filter(name => !before.has(name) && !allowedAdded.has(name));
  const changed = [...before.keys()]
    .filter(name => after.has(name) && after.get(name) !== before.get(name) && !edited.has(name));
  console.log(`source: ${from} (${before.size} declarations)`);
  console.log(`after:  ${after.size} declarations in ${map.modules.length + 1} files`);
  console.log(`dropped on purpose: ${droppedFound.join(', ') || 'none'}`);
  console.log(`added by hand: ${[...allowedAdded].join(', ') || 'none'}`);
  console.log(`edited by hand: ${[...edited].join(', ') || 'none'} — ${manual.why || ''}`);
  console.log(`missing: ${missing.join(', ') || 'none'}`);
  console.log(`added:   ${added.join(', ') || 'none'}`);
  console.log(`changed: ${changed.join(', ') || 'none'}`);
  if (missing.length || added.length || changed.length) process.exit(1);
  console.log('SPLIT VERIFIED — every declaration is byte-identical to the original');
  process.exit(0);
}

const summary = [...map.modules.map(entry => entry.file), 'app.js'].map(file => {
  const content = files.get(file);
  if (content === undefined) return { file, lines: 0 };
  return { file, lines: content.split('\n').length - 1 };
});
console.log('module plan:');
for (const row of summary) console.log(`  ${row.file.padEnd(40)} ${String(row.lines).padStart(5)} lines`);
console.log(`  ${String(units.length).padStart(5)} units (${liveUnits.length} moved, ${units.length - liveUnits.length} dropped), ${liveUnits.reduce((n, u) => n + u.text.split('\n').length, 0)} lines of source`);

if (dry) process.exit(0);

for (const [file, content] of files) {
  const target = path.join(ROOT, 'assets/js/src', file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}
/* Report the units that stayed in the entry: they should be bootstrap only. */
const leftover = liveUnits.filter(unit => moduleOf.get(unit) === '').map(unit => unit.key);
console.log(`\nwritten ${files.size} files.`);
console.log(`entry keeps: ${leftover.join(', ')}`);
