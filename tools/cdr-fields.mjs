#!/usr/bin/env node
/**
 * CDR field-allowlist generator.
 *
 *   node tools/cdr-fields.mjs            # check: fail when the list is stale
 *   node tools/cdr-fields.mjs --write     # regenerate the committed list
 *   node tools/cdr-fields.mjs --list      # print what would be written
 *
 * WHY THIS EXISTS
 * ---------------
 * A PBX CDR from the ns-api is a very wide flat record: well over a hundred
 * fields per call, most of them empty, and the app reads a few dozen. Holding
 * every field of every call in the range is what exhausted PHP's 512 MB in
 * production (includes/reporting/cache.php, the merge loop), so records are
 * now trimmed to the fields the application can actually read
 * (includes/reporting/cdr_trim.php).
 *
 * A trim list is only safe if it is COMPLETE, and hand-maintaining one is how
 * a field silently disappears six months later. So the list is generated from
 * the source: every string literal that could name a CDR field, in every file
 * that runs in production. Adding a read of a new field and forgetting the
 * list fails `node tools/cdr-fields.mjs` and the test suite with it.
 *
 * The scan is deliberately OVER-inclusive. A name in the list that the PBX
 * never sends costs nothing (the trim only ever looks at fields that are
 * present); a name missing from the list costs a wrong number. So class names,
 * config keys and prose fragments that happen to look like field names are
 * kept, and the header of the generated file says so.
 *
 * The one reader that scans keys at RUNTIME instead of naming them is
 * callDisconnectReason() in includes/reporting/cdr_fields.php (it looks for
 * /disconnect|release|hangup/i). Pattern rules cover it, and
 * tests/php/cdr-memory.mjs asserts that no other file grew a runtime key scan.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'includes/reporting/cdr_keep_fields.php');

/* Every tree that runs in production. tests/ and tools/*.mjs are out on
 * purpose: a test may name a field it wants to see kept, and that would hide
 * the gap. tools/*.php is in (the CDR CLI is the deployed diagnostic). */
const TREES = [
  ['includes', ['.php']],
  ['api', ['.php']],
  ['assets/js/src', ['.js']],
  ['tools', ['.php']]
];
const FILES = ['portal.php', 'index.php'];

/* Field names the code reads that are not hyphenated and do not sit in a key
 * position our scan can see (they arrive through a helper's key list). Kept as
 * a literal seed so the generator stays a pure function of the source. */
const SEED = ['dialed', 'direction', 'disposition', 'id'];

/* The PBX is not consistent about spelling: prefilled_trace_api and
 * call-orig-from-user both appear, so underscores and hyphens are both field
 * characters here. */
const NAME = /^(?:[a-z][a-z0-9_]*)(?:-[a-z0-9_]+)*$/;
const QUOTED = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;

const walk = (dir, exts, out) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(full, exts, out);
    } else if (exts.some(e => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
};

const files = [...FILES.map(f => path.join(ROOT, f))];
for (const [dir, exts] of TREES) {
  const full = path.join(ROOT, dir);
  try { if (statSync(full).isDirectory()) walk(full, exts, files); } catch { /* absent */ }
}

const names = new Set(SEED);
const where = new Map();
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  for (const match of text.matchAll(QUOTED)) {
    const literal = match[1] ?? match[2] ?? '';
    if (!NAME.test(literal)) continue;
    /* One-character names are loop variables and colour keys, never fields. */
    if (literal.length < 2) continue;
    names.add(literal);
    if (!where.has(literal)) where.set(literal, rel);
  }
}

const list = [...names].sort();

const body = `<?php
declare(strict_types=1);

/**
 * GENERATED FILE - do not edit. Regenerate with:
 *
 *     node tools/cdr-fields.mjs --write
 *
 * The names of every CDR field this application may read, derived from the
 * string literals of every file that runs in production (includes/, api/,
 * assets/js/src/, tools/*.php, portal.php, index.php). See
 * tools/cdr-fields.mjs for the why and the completeness argument.
 *
 * The list is intentionally over-inclusive: names the PBX never sends cost
 * nothing because trimming only considers keys that are present. Anything
 * MISSING from this list is dropped before the app sees it, so a new field
 * read must come with a regenerated list - the "cdr fields" suite fails
 * otherwise.
 *
 * ${list.length} names.
 */
return [
${list.map(n => `    '${n}',`).join('\n')}
];
`;

const current = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return null; } })();
const write = process.argv.includes('--write');
const showList = process.argv.includes('--list');

if (showList) {
  console.log(list.join('\n'));
  process.exit(0);
}

if (write) {
  writeFileSync(OUT, body);
  console.log(`cdr fields: wrote ${path.relative(ROOT, OUT)} (${list.length} names from ${files.length} files)`);
  process.exit(0);
}

if (current !== body) {
  const have = new Set(
    (current?.match(/^\s{4}'([^']+)',$/gm) ?? []).map(line => line.trim().replace(/^'|',$/g, ''))
  );
  const missing = list.filter(n => !have.has(n));
  const extra = [...have].filter(n => !names.has(n));
  console.error('CDR FIELD LIST IS STALE');
  if (missing.length) {
    console.error(`  ${missing.length} name(s) are read by the code but not kept:`);
    for (const name of missing.slice(0, 25)) console.error(`    - ${name}  (${where.get(name) ?? 'seed'})`);
    if (missing.length > 25) console.error(`    ... and ${missing.length - 25} more`);
  }
  if (extra.length) console.error(`  ${extra.length} kept name(s) no longer appear in the source (harmless)`);
  console.error('  Run: node tools/cdr-fields.mjs --write');
  process.exit(1);
}

console.log(`cdr fields: OK (${list.length} names, ${files.length} files scanned)`);
