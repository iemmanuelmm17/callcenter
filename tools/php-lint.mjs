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
const BANNED = [
  { pattern: /\beval\s*\(/, why: 'eval() executes arbitrary code' },
  { pattern: /\bassert\s*\(\s*\$/, why: 'assert() with a variable is code execution in old PHP' },
  { pattern: /\bcreate_function\s*\(/, why: 'create_function() is removed in PHP 8' },
  { pattern: /\bunserialize\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/, why: 'unserialize() of user input (object injection)' },
  { pattern: /\b(exec|shell_exec|system|passthru|popen|proc_open)\s*\(/, why: 'shell execution' },
  { pattern: /extract\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/, why: 'extract() of user input' }
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
