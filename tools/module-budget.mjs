#!/usr/bin/env node
/**
 * Module budget guard.
 *
 *   node tools/module-budget.mjs                 # report + check (default max 2000 lines)
 *   node tools/module-budget.mjs --max 1500      # tighter budget
 *
 * The dashboard was one 12,000-line file; the split is only worth anything if
 * it stays split. This fails when a module grows past `--max`, when an import
 * points at a file that does not exist, or when a module is imported by
 * nobody (a leftover of a refactor).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets/js/src');
const ENTRY = 'app.js';
const maxIndex = process.argv.indexOf('--max');
const max = maxIndex === -1 ? 2000 : Number(process.argv[maxIndex + 1]);

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
};
walk(SRC);

const modules = files.map(file => {
  const text = readFileSync(file, 'utf8');
  return {
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    text,
    lines: text.split('\n').length - 1,
    imports: [...text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  };
});

const known = new Set(modules.map(m => m.rel));
const imported = new Set();
const brokenImports = [];
for (const module of modules) {
  for (const specifier of module.imports) {
    if (!specifier.startsWith('.')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(module.rel), specifier));
    if (!known.has(resolved)) brokenImports.push(`${module.rel} → ${specifier}`);
    else imported.add(resolved);
  }
}

const oversize = modules.filter(m => m.lines > max);
const orphans = modules.filter(m => m.rel !== ENTRY && !imported.has(m.rel));

const biggest = [...modules].sort((a, b) => b.lines - a.lines);
const TOTAL = modules.reduce((n, m) => n + m.lines, 0);

console.log(`assets/js/src: ${modules.length} modules, ${TOTAL} lines (budget ${max} per file)`);
console.log('largest modules:');
for (const module of biggest.slice(0, 8)) {
  console.log(`  ${String(module.lines).padStart(5)}  ${module.rel}`);
}

const report = (title, rows, format) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (!rows.length) console.log('  none');
  for (const row of rows) console.log('  - ' + format(row));
};
report('module over the line budget', oversize, m => `${m.rel} — ${m.lines} lines`);
report('import pointing at a missing file', brokenImports, row => row);
report('module nothing imports', orphans, m => m.rel);

const failed = oversize.length + brokenImports.length + orphans.length;
if (failed) {
  console.log(`\n${failed} module budget problem(s)`);
  process.exit(1);
}
console.log('\nMODULE BUDGET OK');
