#!/usr/bin/env node
/**
 * PHP static checks.
 *
 * There is no PHP binary in this environment, so syntax is verified with
 * php-parser (a real PHP grammar, the same one used by Prettier's PHP plugin)
 * and a small hygiene pass flags constructs that the security review cares
 * about (eval, shell execution, unserialize, base64 payloads, ...).
 *
 *   node tools/php-lint.mjs            # syntax + hygiene
 *   node tools/php-lint.mjs --syntax   # syntax only
 *
 * Exit code 1 on any syntax error or on a BANNED construct; hygiene notes are
 * informational and never fail the run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PhpParser from 'php-parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'cache', 'logs', '.tmp', 'vendor']);
const syntaxOnly = process.argv.includes('--syntax');

/* Deliberately banned in this codebase: any of these in application code is a
 * finding, not a style question. */
const SHELL_FUNCTIONS = ['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open'];
const BANNED = [
  { pattern: /\beval\s*\(/, why: 'eval() executes arbitrary code', targets: ['eval('] },
  { pattern: /\bassert\s*\(\s*\$/, why: 'assert() with a variable is code execution in old PHP', targets: ['assert($x'] },
  { pattern: /\bcreate_function\s*\(/, why: 'create_function() is removed in PHP 8', targets: ['create_function('] },
  { pattern: /\bunserialize\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/, why: 'unserialize() of user input (object injection)', targets: ['unserialize($_GET['] },
  /* Shell execution. The negative lookbehind keeps the method form
   * ($pdo->exec(...), PDO::exec(...)) out of it: the ban is about running a
   * command, and the self-test below pins both directions. */
  { pattern: /(?<!function )(?<![>:\w])(exec|shell_exec|system|passthru|popen|proc_open)\b\s*\(/, why: 'shell execution', targets: SHELL_FUNCTIONS.map(name => name + '(') },
  { pattern: /extract\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/, why: 'extract() of user input', targets: ['extract($_POST['] }
];
/* Informational: these have legitimate uses but deserve a look during review. */
const NOTES = [
  { pattern: /\bunserialize\s*\(/, why: 'unserialize()' },
  { pattern: /\bfile_get_contents\s*\(\s*['"]https?:/, why: 'remote file_get_contents' },
  { pattern: /\bcurl_setopt\s*\(\s*[^,]+,\s*CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)\b/i, why: 'TLS verification disabled' },
  { pattern: /md5\s*\(|sha1\s*\(/, why: 'weak hash (md5/sha1)' },
  { pattern: /SELECT\s+\*/i, why: 'SELECT *' }
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.php')) out.push(full);
  }
  return out;
}

/* The banned list is a security control, so prove it catches what it claims to
 * catch (and does not fire on the method forms the codebase legitimately uses)
 * before scanning a single file: a regex edit that quietly neuters it would
 * otherwise pass unnoticed. */
const BANNED_SAMPLES = [
  /* Must fire: the rule's own target plus the shell functions, which every
   * rule that is not the shell rule is expected to ignore. */
  [...SHELL_FUNCTIONS.map(name => name + '('), 'eval(', 'create_function(', 'assert($x', 'unserialize($_GET[', 'extract($_POST['],
  /* Must not fire: the legitimate method forms and names that merely contain
   * a banned word. `-> execute(` is the PDO statement call, spaced out. */
  ['$pdo->exec(', 'PDO::exec(', 'exec_pdo(', 'my_shell_exec(', 'solve(', 'systematic(', '$statement->execute(', 'function exec(string $sql): int {']
];
let selfTestFailures = 0;
for (const { pattern, why, targets } of BANNED) {
  for (const sample of targets) {
    if (pattern.test(sample)) { pattern.lastIndex = 0; continue; }
    console.log(`FAIL self-test: pattern for "${why}" does not match ${JSON.stringify(sample)}`);
    selfTestFailures++;
  }
  for (const sample of BANNED_SAMPLES[1]) {
    if (!pattern.test(sample)) continue;
    pattern.lastIndex = 0;
    console.log(`FAIL self-test: pattern for "${why}" must not match ${JSON.stringify(sample)}`);
    selfTestFailures++;
  }
  pattern.lastIndex = 0;
}
if (selfTestFailures) {
  console.log(`\n${selfTestFailures} self-test failure(s) — the banned-construct rules are broken`);
  process.exit(1);
}

const parser = new PhpParser.Engine({
  parser: { extractDoc: false, suppressErrors: false, version: '8.3' },
  ast: { withPositions: true }
});

const files = walk(ROOT).sort();
let errors = 0;
let banned = 0;
const notes = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const source = readFileSync(file, 'utf8');

  if (source.charCodeAt(0) === 0xfeff) {
    console.log(`FAIL ${rel}: UTF-8 BOM at start of file`);
    errors++;
  }
  if (!source.trimEnd().endsWith('?>') && /\?>\s*\n\s*$/.test(source)) {
    console.log(`NOTE ${rel}: trailing whitespace after closing tag`);
  }

  try {
    parser.parseCode(source, rel);
  } catch (error) {
    errors++;
    const line = error?.loc?.start?.line ?? error?.lineNumber ?? '?';
    const column = error?.loc?.start?.column ?? '?';
    console.log(`FAIL ${rel}:${line}:${column} ${String(error.message).split('\n')[0]}`);
  }

  if (syntaxOnly) continue;

  for (const { pattern, why } of BANNED) {
    const hit = pattern.exec(source);
    if (hit) {
      banned++;
      const line = source.slice(0, hit.index).split('\n').length;
      console.log(`FAIL ${rel}:${line} banned construct — ${why}`);
    }
  }
  for (const { pattern, why } of NOTES) {
    const hit = pattern.exec(source);
    if (hit) {
      const line = source.slice(0, hit.index).split('\n').length;
      notes.push(`${rel}:${line} ${why}`);
    }
  }
}

console.log(`\n${files.length} PHP files parsed with the php-parser grammar`);
if (!syntaxOnly && notes.length) {
  console.log(`\nreview notes (${notes.length}, not fatal):`);
  for (const note of notes) console.log(`  - ${note}`);
}
if (errors || banned) {
  console.log(`\n${errors} syntax error(s), ${banned} banned construct(s)`);
  process.exit(1);
}
console.log('PHP LINT OK');
