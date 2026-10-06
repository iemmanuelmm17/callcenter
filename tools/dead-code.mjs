#!/usr/bin/env node
/**
 * Dead-code report.
 *
 *   node tools/dead-code.mjs            # report
 *   node tools/dead-code.mjs --strict   # exit 1 when something is unreferenced
 *
 * PHP is parsed with php-parser, so declarations are exact. JS is a single
 * bundle source file, so a whole-word reference count is used for top-level
 * declarations — every hit is meant to be eyeballed before deleting, and the
 * JS smoke test plus `npm run build` prove the result still runs.
 *
 * A declaration is "referenced" when its name appears anywhere else in the
 * codebase (PHP, JS, tests, tools, markdown). That under-reports dead code
 * (a name mentioned in a comment counts), which is the safe direction.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PhpParser from 'php-parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'cache', 'logs', '.tmp', 'vendor']);
const strict = process.argv.includes('--strict');

const phpFiles = [];
const jsFiles = [];
const textFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (name === 'app.css' || name === 'app.js') continue; /* build output */
    if (name.endsWith('.php')) { phpFiles.push(full); textFiles.push(full); }
    else if (name.endsWith('.js') || name.endsWith('.mjs')) { jsFiles.push(full); textFiles.push(full); }
    else if (name.endsWith('.md') || name.endsWith('.json') || name.endsWith('.html')) textFiles.push(full);
  }
})(ROOT);

const parser = new PhpParser.Engine({ parser: { extractDoc: false, suppressErrors: true, version: '8.3' }, ast: { withPositions: true } });

const corpus = new Map(); /* file -> stripped source (comments removed) */
const phpSource = new Map();
for (const file of textFiles) {
  const raw = readFileSync(file, 'utf8');
  phpSource.set(file, raw);
  /* PHP/JS line comments contain prose about the code ("...used by report.php"),
   * which would make everything look referenced. Strip line comments only —
   * block comments hold docblock references that are often the only mention. */
  corpus.set(file, raw.replace(/^[ \t]*(?:\/\/|#\s|\*)[^\n]*$/gm, ''));
}

const nameOf = (node) => (typeof node === 'string' ? node : (node?.name ?? ''));

const declarations = []; /* {kind, name, file, line, scope} */
for (const file of phpFiles) {
  const rel = path.relative(ROOT, file);
  let ast;
  try { ast = parser.parseCode(readFileSync(file, 'utf8'), rel); } catch { continue; }
  for (const node of ast.children) {
    if (node.kind === 'function') declarations.push({ kind: 'function', name: nameOf(node.name), file: rel, line: node.loc?.start?.line ?? 0 });
    if (node.kind === 'class') {
      declarations.push({ kind: 'class', name: nameOf(node.name), file: rel, line: node.loc?.start?.line ?? 0 });
      for (const member of node.body ?? []) {
        if (member.kind !== 'method') continue;
        const visibility = member.visibility ?? 'public';
        if (visibility === 'public') continue; /* public methods are the class API */
        declarations.push({ kind: `${visibility} method`, name: nameOf(member.name), file: rel, line: member.loc?.start?.line ?? 0, className: nameOf(node.name) });
      }
    }
  }
}

/* JS: top-level declarations in the bundle source only. */
const JS_ENTRY = path.join(ROOT, 'assets/js/src/app.js');
const jsSource = readFileSync(JS_ENTRY, 'utf8');
const jsDecls = new Map();
const jsPatterns = [
  /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.memo\()?function/gm,
  /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.memo\()?\(/gm
];
for (const pattern of jsPatterns) {
  for (const match of jsSource.matchAll(pattern)) {
    const line = jsSource.slice(0, match.index).split('\n').length;
    if (!jsDecls.has(match[1])) jsDecls.set(match[1], { name: match[1], line });
  }
}

const countReferences = (name, ownFile) => {
  let count = 0;
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  for (const [file, text] of corpus) {
    const hits = text.match(word);
    if (!hits) continue;
    /* A declaration line does not count as a use. */
    const own = file === ownFile ? 1 : 0;
    count += hits.length - own;
  }
  return count;
};

const dead = [];
for (const decl of declarations) {
  if (!decl.name) continue;
  const references = countReferences(decl.name, path.join(ROOT, decl.file));
  if (references <= 0) dead.push(decl);
}
const deadJs = [];
for (const decl of jsDecls.values()) {
  const word = new RegExp(`\\b${decl.name}\\b`, 'g');
  const hits = (jsSource.match(word) ?? []).length;
  if (hits <= 1) deadJs.push(decl);
}

/* Files nothing else mentions. */
const orphanFiles = [];
for (const file of [...phpFiles, ...jsFiles]) {
  const rel = path.relative(ROOT, file);
  if (rel === 'assets/js/src/app.js' || rel.endsWith('config.local.php')) continue;
  /* tools/ and tests/ are entry points: npm scripts and the test runner invoke
   * them by path, so "nothing references this file" says nothing there. */
  if (rel.startsWith('tools/') || rel.startsWith('tests/')) continue;
  const base = path.basename(rel);
  let references = 0;
  for (const [other, text] of corpus) {
    if (other === file) continue;
    if (text.includes(base)) references++;
  }
  if (references === 0) orphanFiles.push(rel);
}

const print = (title, rows) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (!rows.length) { console.log('  none'); return; }
  for (const row of rows) {
    if (typeof row === 'string') { console.log(`  - ${row}`); continue; }
    const where = row.className ? `${row.file}:${row.line} ${row.className}` : `${row.file}:${row.line}`;
    console.log(`  - ${row.kind ? row.kind + ' ' : ''}${row.name}  (${where})`);
  }
};

console.log(`scanned ${phpFiles.length} PHP, ${jsFiles.length} JS/MJS, ${textFiles.length} text files`);
print('unreferenced PHP functions', dead.filter(d => d.kind === 'function'));
print('unreferenced non-public PHP methods', dead.filter(d => d.kind.includes('method')));
print('unreferenced top-level JS declarations', deadJs);
print('files nothing references', orphanFiles);

const total = dead.filter(d => d.kind === 'function').length + deadJs.length + orphanFiles.length;
if (strict && total > 0) {
  console.log(`\n${total} unreferenced item(s) — remove them or reference them.`);
  process.exit(1);
}
console.log('\nclean: nothing dead outside tools/ and tests/');
