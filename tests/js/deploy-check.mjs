/**
 * Self-test for tools/deploy-check.mjs, the tool written after a real deploy
 * incident: an FTFP upload in ASCII mode rewrote LF as CRLF inside
 * assets/vendor/chart.js/chart.umd.js, the browser refused the file on its
 * integrity hash, and the dashboard went blank.
 *
 * The tool has to be able to tell three things apart, against a tree on disk:
 *
 *   1. identical bytes                      -> ok, exit 0
 *   2. the same text with CRLF line endings -> "LF rewritten as CRLF in transit"
 *   3. a different file of the same size    -> "bytes differ"
 *
 * It copies the real assets into a temp directory for each case, so this stays
 * a test of the tool rather than of the repository's current bytes.
 *
 *   node tests/js/deploy-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX = path.join(ROOT, 'tests/.tmp/deploy-check');

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 300));
  }
};

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/vendor/VENDOR.json'), 'utf8'));
const buildManifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/build-manifest.json'), 'utf8'));
const chart = 'assets/vendor/chart.js/chart.umd.js';

/* Run the tool against a directory; never throw, just report. */
const run = tree => {
  try {
    const stdout = execFileSync(process.execPath, ['tools/deploy-check.mjs', tree], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: (error.stdout || '') + (error.stderr || '') };
  }
};

/* A deploy tree that really is this repository: every file the manifests name,
 * copied (not stubbed), plus the two prod build artifacts. */
const stage = () => {
  rmSync(SANDBOX, { recursive: true, force: true });
  for (const file of manifest.files) {
    const from = path.join(ROOT, file.target);
    const to = path.join(SANDBOX, file.target);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to);
  }
  mkdirSync(path.join(SANDBOX, 'assets/js'), { recursive: true });
  mkdirSync(path.join(SANDBOX, 'assets/css'), { recursive: true });
  for (const key of ['js', 'css']) {
    cpSync(path.join(ROOT, buildManifest[key].file), path.join(SANDBOX, buildManifest[key].file));
  }
  writeFileSync(path.join(SANDBOX, 'assets/build-manifest.json'), JSON.stringify(buildManifest, null, 2));
  writeFileSync(path.join(SANDBOX, 'assets/vendor/VENDOR.json'), JSON.stringify(manifest, null, 2));
};

console.log('== deploy-check: an uploaded tree that matches ==');
stage();
let result = run(SANDBOX);
check('a byte-identical tree passes', result.code === 0, result.out.slice(-300));
check('it reports every file it checked',
  /all \d+ files match this repository byte for byte/.test(result.out),
  result.out.split('\n').slice(-2).join(' '));
check('the count covers the vendored files and the prod build',
  Number((result.out.match(/all (\d+) files/) || [])[1]) === manifest.files.length + 2,
  (result.out.match(/all (\d+) files/) || [])[1]);

console.log('\n== deploy-check: an ASCII-mode upload (the incident) ==');
{
  const file = path.join(SANDBOX, chart);
  const original = readFileSync(file);
  writeFileSync(file, Buffer.from(original.toString('binary').replace(/\n/g, '\r\n'), 'binary'));
  result = run(SANDBOX);
  check('it fails', result.code === 1, result.code);
  check('it names the line-ending rewrite',
    /LF rewritten as CRLF in transit/.test(result.out), result.out.match(/LF rewritten[^\n]*/)?.[0]);
  check('it shows both sizes, so the extra bytes are visible',
    result.out.includes(String(original.length + (original.toString('binary').match(/\n/g) || []).length)) &&
      result.out.includes(String(original.length)),
    result.out.match(/\d+ bytes received, \d+ expected/)?.[0]);
  check('it says how to fix the upload (binary mode)',
    /BINARY mode/i.test(result.out) && /git rm -r --cached/.test(result.out));
  check('it counts only the file that changed', /1 of \d+ files do not match/.test(result.out),
    result.out.match(/\d+ of \d+ files/)?.[0]);
}

console.log('\n== deploy-check: same size, different bytes ==');
{
  const file = path.join(SANDBOX, chart);
  const original = readFileSync(path.join(ROOT, chart));
  const sameSize = Buffer.from(original);
  sameSize[10] = sameSize[10] === 0x78 ? 0x79 : 0x78;   /* one byte flipped */
  writeFileSync(file, sameSize);
  result = run(SANDBOX);
  check('it fails', result.code === 1, result.code);
  check('a same-size difference is not blamed on line endings',
    /bytes differ/.test(result.out) && !/LF rewritten/.test(result.out),
    result.out.match(/%s.*|bytes differ[^\n]*/)?.[0]);
  check('the sha384 of the file on disk is what decides',
    createHash('sha384').update(sameSize).digest('base64') !== manifest.files.find(f => f.target === chart).sha384);
}

console.log('\n== deploy-check: a missing file ==');
{
  rmSync(path.join(SANDBOX, chart));
  result = run(SANDBOX);
  check('a file the manifest names but the tree lacks is a failure',
    result.code === 1 && /file is not in the uploaded tree/.test(result.out),
    result.out.match(/FAIL[^\n]*/)?.[0]);
}

rmSync(SANDBOX, { recursive: true, force: true });
if (!existsSync(SANDBOX)) console.log('\n  (temp tree removed)');

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nDEPLOY CHECK OK — the tool catches the incident it was written for');
process.exit(0);
