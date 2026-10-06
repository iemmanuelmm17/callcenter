#!/usr/bin/env node
/**
 * Split one PHP file into modules, leaving a facade behind.
 *
 *   node tools/split-php-file.mjs <source.php> <map.json> [--facade <path>]
 *
 * The map is `{ "includes/reporting/cache.php": ["cacheFile", ...], ... }` and
 * must cover every top-level function exactly once; the tool refuses to run
 * otherwise. Declarations are located and cut with php-parser offsets, so a
 * docblock stays attached to its function and nothing is matched by text.
 *
 * Top-level statements that are not declarations (a `declare`, `require_once`,
 * `if (!defined(...)) define(...)`) stay in the facade ahead of the module
 * requires. Each module gets its own `<?php declare(strict_types=1);` header.
 *
 * Written for the includes/reporting.php split; kept because it makes the next
 * such split a ten-minute job instead of a day of copy-paste.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PhpParser from 'php-parser';

const [sourcePath, mapPath, ...rest] = process.argv.slice(2);
if (!sourcePath || !mapPath) {
  console.error('usage: split-php-file.mjs <source.php> <map.json> [--facade <path>]');
  process.exit(2);
}
const facadeFlag = rest.indexOf('--facade');
const facadePath = facadeFlag >= 0 ? rest[facadeFlag + 1] : sourcePath;

const ROOT = process.cwd();
const source = readFileSync(sourcePath, 'utf8');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const nameOf = (node) => (typeof node === 'string' ? node : (node?.name ?? ''));

const parser = new PhpParser.Engine({
  parser: { extractDoc: true, suppressErrors: false, version: '8.3' },
  ast: { withPositions: true }
});
const ast = parser.parseCode(source, sourcePath);

/** Extend the span upwards to include the docblock that documents it. */
function withLeadingDoc(start) {
  let cursor = start;
  /* Step over blank lines / whitespace. */
  while (cursor > 0 && /\s/.test(source[cursor - 1])) cursor--;
  const before = source.slice(0, cursor);
  const close = before.lastIndexOf('*/');
  if (close === -1) return start;
  const blank = before.slice(close + 2);
  if (blank.trim() !== '') return start;
  const open = before.lastIndexOf('/**', close);
  if (open === -1) return start;
  const lineStart = before.lastIndexOf('\n', open) + 1;
  if (before.slice(lineStart, open).trim() !== '') return start;
  return lineStart;
}

const units = [];      /* {name, start, end} */
const preamble = [];   /* offsets of top-level statements that move to the facade */

for (const node of ast.children) {
  if (node.kind === 'function') {
    const start = withLeadingDoc(node.loc.start.offset);
    units.push({ name: nameOf(node.name), start, end: node.loc.end.offset + 1 });
    continue;
  }
  if (node.kind === 'if') {
    const inner = (node.body?.children ?? []).find(child => child.kind === 'function');
    if (inner) {
      const start = withLeadingDoc(node.loc.start.offset);
      units.push({ name: nameOf(inner.name), start, end: node.loc.end.offset + 1, guarded: true });
      continue;
    }
  }
  /* `declare(strict_types=1)` is re-emitted in the generated header, and a
   * second copy after a comment would be a fatal error. */
  if (node.kind === 'declare') continue;
  preamble.push(source.slice(node.loc.start.offset, node.loc.end.offset + 1));
}

/* --- validate the map ---------------------------------------------------- */
const assigned = new Map();
for (const [module, names] of Object.entries(map)) {
  if (module === '__facade__') continue;
  for (const name of names) {
    if (assigned.has(name)) {
      console.error(`"${name}" is assigned to both ${assigned.get(name)} and ${module}`);
      process.exit(1);
    }
    assigned.set(name, module);
  }
}
const unknown = [...assigned.keys()].filter(name => !units.some(unit => unit.name === name));
const missing = units.filter(unit => !assigned.has(unit.name)).map(unit => unit.name);
if (unknown.length || missing.length) {
  if (unknown.length) console.error('map lists functions that do not exist:', unknown.join(', '));
  if (missing.length) console.error('functions missing from the map:', missing.join(', '));
  process.exit(1);
}

/* --- write the modules --------------------------------------------------- */
const MODULE_HEADER = (module) => `<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — ${module}.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */
`;

let written = 0;
for (const module of Object.keys(map)) {
  if (module === '__facade__') continue;
  const picked = units
    .filter(unit => assigned.get(unit.name) === module)
    .sort((a, b) => a.start - b.start)
    .map(unit => source.slice(unit.start, unit.end).replace(/\s+$/, ''));
  const target = path.join(ROOT, module);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, MODULE_HEADER(module) + '\n' + picked.join('\n\n') + '\n');
  console.log(`  ${module.padEnd(38)} ${picked.length} functions`);
  written += picked.length;
}

/* --- rewrite the facade -------------------------------------------------- */
const moduleRequires = Object.keys(map)
  .filter(module => module !== '__facade__')
  .map(module => `require_once __DIR__ . '/${module.replace(/^includes\//, '')}';`)
  .join('\n');

/* A __facade__ entry documents the layout in the facade's header docblock. */
const facadeNote = typeof map.__facade__ === 'string'
  ? '/**\n' + map.__facade__.split('\n').map(line => ' * ' + line.replace(/^\s*\*\s?/, '')).join('\n') + '\n */\n'
  : '';

/* Keep the facade readable: the requires first, then any other statement. */
const cleanPreamble = preamble
  .map(statement => statement.trim())
  .join('\n')
  .replace(/(\n)(if \()/g, '$1\n$2');

const facade = `<?php
declare(strict_types=1);

${facadeNote}${cleanPreamble}

/*
 * The implementation lives in includes/reporting/*.php. This file stays as the
 * single entry point every caller already requires, so no call site changed.
 */
${moduleRequires}
`;

writeFileSync(path.join(ROOT, facadePath), facade);
console.log(`  ${facadePath.padEnd(38)} facade (${preamble.length} top-level statement(s))`);
console.log(`\n${units.length} functions moved: ${written === units.length ? 'OK' : 'MISMATCH'}`);
