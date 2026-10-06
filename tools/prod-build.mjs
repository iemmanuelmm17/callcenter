#!/usr/bin/env node
/**
 * The committed prod build must match the sources, and must actually be a
 * deployable artifact (QA-4).
 *
 *   node tools/prod-build.mjs
 *
 * What this catches, in order:
 *
 *   1. staleness  — someone edits a source and commits without rebuilding, so
 *      the browser keeps serving the old bytes under the old content hash.
 *   2. naming     — the hash in the filename must be derived from the file's
 *      own sha256; that is the whole reason a deploy can be proven to have
 *      reached a browser.
 *   3. integrity  — the sha384 in assets/build-manifest.json must match the
 *      bytes on disk, because portal.php copies it into the <script>/<link>.
 *   4. minification — the prod bundle must be materially smaller than the dev
 *      bundle (the review's complaint was a 444 kB unminified download).
 *
 * It refreshes the artifacts itself (so a developer who forgot gets a fixed
 * tree AND a failing test), then re-checks, so the check is idempotent.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 300));
  }
};

const run = args => execFileSync(process.execPath, ['tools/build.mjs', ...args], { cwd: ROOT, stdio: 'pipe' }).toString();
const sha384 = file => createHash('sha384').update(readFileSync(file)).digest('base64');
const sha256short = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);

console.log('== prod build: up to date with the sources ==');
let stale = false;
try {
  run(['--prod', '--check']);
  check('the committed prod build matches the sources', true);
} catch (error) {
  stale = true;
  check('the committed prod build matches the sources', false, (error.stdout || error.message).toString().slice(0, 200));
}

/* Refresh (idempotent: same bytes in, same names out) and verify invariants. */
run(['--prod']);

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/build-manifest.json'), 'utf8'));
check('the manifest names both artifacts', !!manifest.js?.file && !!manifest.css?.file, manifest);

for (const [kind, entry] of Object.entries({ js: manifest.js, css: manifest.css })) {
  const file = path.join(ROOT, entry.file);
  check(`${kind}: the named file exists`, existsSync(file), entry.file);
  if (!existsSync(file)) continue;
  const name = path.basename(entry.file);
  check(`${kind}: the filename carries the file's own content hash`,
    name === `app.${sha256short(file)}.${kind}`, { name, hash: sha256short(file) });
  check(`${kind}: the manifest sizes the file correctly`, statSync(file).size === entry.bytes, { manifest: entry.bytes, disk: statSync(file).size });
  check(`${kind}: the manifest integrity matches the bytes`,
    `sha384-${sha384(file)}` === `sha384-${entry.sha384}`, { manifest: entry.sha384?.slice(0, 16), disk: sha384(file).slice(0, 16) });
}

console.log('\n== prod build: minified, and the only bundle committed ==');
const devJs = path.join(ROOT, 'assets/js/app.js');
const devCss = path.join(ROOT, 'assets/css/app.css');
if (existsSync(devJs) && existsSync(devCss)) {
  const devBytes = statSync(devJs).size + statSync(devCss).size;
  const prodBytes = manifest.js.bytes + manifest.css.bytes;
  check('the minified build is materially smaller than the dev build',
    prodBytes < devBytes * 0.75, { devBytes, prodBytes, ratio: Number((prodBytes / devBytes).toFixed(2)) });
  console.log(`     dev ${(devBytes / 1024).toFixed(1)} kB -> prod ${(prodBytes / 1024).toFixed(1)} kB`);
} else {
  check('the dev build exists for the comparison (run node tools/build.mjs)', false);
}

const hashedJs = readdirSync(path.join(ROOT, 'assets/js')).filter(name => /^app\.[0-9a-f]{10}\.js$/.test(name));
const hashedCss = readdirSync(path.join(ROOT, 'assets/css')).filter(name => /^app\.[0-9a-f]{10}\.css$/.test(name));
check('exactly one hashed bundle and one hashed stylesheet are committed (no dead artifacts)',
  hashedJs.length === 1 && hashedCss.length === 1 && hashedJs[0] === path.basename(manifest.js.file) && hashedCss[0] === path.basename(manifest.css.file),
  { hashedJs, hashedCss });

console.log('\n== prod build: rebuilds are reproducible ==');
try {
  run(['--prod', '--check']);
  check('a second check passes (the refresh wrote exactly the same bytes)', true);
} catch (error) {
  check('a second check passes (the refresh wrote exactly the same bytes)', false, (error.stdout || error.message).toString().slice(0, 200));
}

if (stale) {
  console.log('\nNOTE: the committed prod artifact was stale and has been rebuilt — stage the changed files.');
}
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPROD BUILD OK — hashed, minified, integrity-checked, in sync with the sources');
process.exit(0);
