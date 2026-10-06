#!/usr/bin/env node
/**
 * Verify that what a server is serving is byte-for-byte what this repository
 * built. Written after a real incident: an FTP upload in ASCII mode rewrote LF
 * as CRLF inside assets/vendor/chart.js/chart.umd.js, the browser refused the
 * file on its integrity hash, and the dashboard rendered blank with only a
 * console error to explain it.
 *
 *   node tools/deploy-check.mjs http://112.198.136.174/deploy/
 *   node tools/deploy-check.mjs ./build-output        # a staging tree on disk
 *   node tools/deploy-check.mjs                       # http://localhost/
 *
 * Checks every file named by assets/vendor/VENDOR.json and
 * assets/build-manifest.json: HTTP status, byte count, and sha384 against the
 * manifest. A mismatch that is exactly a line-ending rewrite is called out as
 * such, because that is by far the most common cause and it is fixed by
 * re-uploading in binary mode — not by touching the code.
 *
 * Exit code 0 when everything matches, 1 when anything does not (so it can gate
 * a deploy script). Needs network access for an http(s) target; no
 * dependencies.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const target = argument || 'http://localhost/';
const isRemote = /^https?:\/\//i.test(target);
const baseUrl = isRemote ? target.replace(/\/?$/, '/') : null;
const baseDir = isRemote ? null : path.resolve(target);

const vendorManifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/vendor/VENDOR.json'), 'utf8'));
const buildManifestPath = path.join(ROOT, 'assets/build-manifest.json');
const buildManifest = existsSync(buildManifestPath) ? JSON.parse(readFileSync(buildManifestPath, 'utf8')) : null;

/* ------------------------------------------------------------------ plan */

const wanted = [];
for (const file of vendorManifest.files || []) {
  wanted.push({ label: file.id + ' (' + file.package + '@' + file.version + ')', file: file.target, bytes: file.bytes, sha384: file.sha384 });
}
if (buildManifest) {
  for (const key of ['js', 'css']) {
    const entry = buildManifest[key];
    if (entry?.file) wanted.push({ label: 'build ' + key, file: entry.file, bytes: entry.bytes, sha384: entry.sha384 });
  }
} else {
  console.log('note: assets/build-manifest.json is absent — this tree has no prod build, checking vendored files only.\n');
}

/* -------------------------------------------------------------- fetching */

const localBytes = relative => {
  const full = path.join(ROOT, relative);
  return existsSync(full) ? readFileSync(full) : null;
};

const fetchBytes = async url => {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) return { error: 'HTTP ' + response.status };
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
};

const sha384 = buffer => createHash('sha384').update(buffer).digest('base64');
const lfCount = buffer => (buffer.toString('binary').match(/\n/g) || []).length;
const asCrlf = buffer => Buffer.from(buffer.toString('binary').replace(/\n/g, '\r\n'), 'binary');

/* A mismatch that is purely a line-ending rewrite: the size difference is
 * exactly the number of line feeds, and the CRLF variant hashes to what the
 * server sent. */
const lineEndingDiagnosis = (local, remote) => {
  const feeds = lfCount(local);
  const delta = remote.length - local.length;
  if (!feeds || delta !== feeds) return null;
  return sha384(asCrlf(local)) === sha384(remote) ? 'LF rewritten as CRLF in transit' : null;
};

/* ------------------------------------------------------------- the check */

console.log(`deploy-check: ${isRemote ? baseUrl : baseDir}\n`);

/* First: is the server even running this revision? Compare its own manifests. */
if (isRemote) {
  for (const [name, localText] of [
    ['assets/vendor/VENDOR.json', JSON.stringify(vendorManifest)],
    ['assets/build-manifest.json', buildManifest ? JSON.stringify(buildManifest) : null]
  ]) {
    if (!localText) continue;
    try {
      const remote = await fetchBytes(new URL(name, baseUrl));
      if (remote.error) {
        console.log(`  ??   ${name} — ${remote.error}`);
        continue;
      }
      const remoteText = remote.bytes.toString('utf8');
      let verdict;
      try {
        const local = JSON.parse(localText);
        const other = JSON.parse(remoteText);
        verdict = JSON.stringify(local) === JSON.stringify(other)
          ? 'identical to this repository'
          : 'DIFFERENT from this repository (the server is running another revision)';
      } catch {
        verdict = 'not JSON on the server';
      }
      console.log(`  ${/IDENTICAL/.test(verdict) || verdict.startsWith('identical') ? 'ok  ' : '!!  '} ${name} — ${verdict}`);
    } catch (error) {
      console.log(`  !!   ${name} — ${error.message}`);
    }
  }
  console.log('');
}

let failed = 0;
let sawLineEndingRewrite = false;
const rows = [];
for (const item of wanted) {
  let received = null;
  let error = null;
  try {
    if (isRemote) {
      const result = await fetchBytes(new URL(item.file, baseUrl));
      if (result.error) error = result.error;
      else received = result.bytes;
    } else {
      const full = path.join(baseDir, item.file);
      if (!existsSync(full)) error = 'file is not in the uploaded tree';
      else received = readFileSync(full);
    }
  } catch (caught) {
    error = caught.name === 'TimeoutError' ? 'timed out' : caught.message;
  }

  const local = localBytes(item.file);
  let verdict;
  if (error) {
    verdict = 'FAIL  ' + error;
    failed++;
  } else if (received.length === local.length && sha384(received) === sha384(local)) {
    verdict = `ok    ${item.bytes} bytes, sha384 matches`;
  } else if (received.length === local.length && item.sha384 && sha384(received) === item.sha384) {
    verdict = `ok    ${item.bytes} bytes, sha384 matches`;
  } else {
    const diagnosis = lineEndingDiagnosis(local, received);
    if (diagnosis) sawLineEndingRewrite = true;
    verdict = `FAIL  ${received.length} bytes received, ${local.length} expected — ${diagnosis || 'bytes differ'}`;
    failed++;
  }
  rows.push([item.label, item.file, verdict]);
}

const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, file, verdict] of rows) {
  console.log(`  ${label.padEnd(width)}  ${verdict}`);
  console.log(`  ${' '.repeat(width)}  ${file}`);
}

console.log('');
if (failed) {
  console.log(`${failed} of ${rows.length} files do not match this repository.`);
  console.log('');
  if (sawLineEndingRewrite) {
    console.log('The differences above are line-ending rewrites: the upload sent CRLF');
    console.log('where the repository (and the integrity hashes) say LF. Fix the transfer,');
    console.log('not the code:');
    console.log('  * FTP/SFTP clients: upload in binary mode (not ASCII/text/auto).');
    console.log('  * Windows: a clone without .gitattributes checks out CRLF — this repository');
    console.log('    pins LF, so `git rm -r --cached . && git reset --hard HEAD` rewrites the');
    console.log('    working tree with the bytes the hashes were computed from.');
    console.log('  * Zip, scp, rsync and robocopy do not rewrite line endings; an editor or a');
    console.log('    text-mode FTP transfer does.');
  } else {
    console.log('These files were not built from this revision (or were edited after the');
    console.log('upload). Re-run `npm run build:prod` here, deploy the result, and check again.');
  }
  process.exit(1);
}
console.log(`DEPLOY OK — all ${rows.length} files match this repository byte for byte.`);
process.exit(0);
