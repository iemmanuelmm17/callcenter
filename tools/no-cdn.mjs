#!/usr/bin/env node
/**
 * No third-party runtime dependencies (QA-3).
 *
 * React, ReactDOM, Chart.js, Tabulator, Font Awesome and IBM Plex Mono are
 * vendored under assets/vendor (tools/vendor.mjs). This check keeps it that
 * way: if any source or template starts pulling a library from a public CDN
 * again, the test suite fails instead of the page failing on a locked-down
 * network.
 *
 * Matches scheme-relative and absolute references to the hosts we cared about;
 * a hostname mentioned in prose (a comment explaining the move) is fine.
 *
 *   node tools/no-cdn.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOSTS = [
  'unpkg.com', 'cdn.jsdelivr.net', 'jsdelivr.net', 'cdnjs.cloudflare.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com',
  'code.jquery.com', 'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com'
];

const SCAN = ['portal.php', 'index.php'];
const SCAN_DIRS = ['includes', 'assets/js/src', 'assets/css/src'];
const EXTS = new Set(['.php', '.js', '.mjs', '.css', '.html']);

const offenders = [];
const patterns = HOSTS.flatMap(host => [
  { host, needle: '//' + host },
  { host, needle: 'https:' + host },
]);

const scan = (relative, text) => {
  text.split('\n').forEach((line, i) => {
    for (const { host, needle } of patterns) {
      if (line.includes(needle)) {
        offenders.push(`${relative}:${i + 1}  ${host}  ${line.trim().slice(0, 110)}`);
      }
    }
  });
};

const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (EXTS.has(path.extname(name))) {
      scan(path.relative(ROOT, full), readFileSync(full, 'utf8'));
    }
  }
};

for (const file of SCAN) scan(file, readFileSync(path.join(ROOT, file), 'utf8'));
for (const dir of SCAN_DIRS) {
  const full = path.join(ROOT, dir);
  try {
    if (statSync(full).isDirectory()) walk(full);
  } catch {
    /* A directory that does not exist cannot reference a CDN. */
  }
}

if (offenders.length) {
  console.error('third-party CDN references found:\n  ' + offenders.join('\n  '));
  console.error('\nvendor the file with tools/vendor.mjs and load it from assets/vendor instead');
  process.exit(1);
}
console.log(`no CDN references in ${SCAN.length} templates + ${SCAN_DIRS.length} source trees`);
