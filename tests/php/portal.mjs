/**
 * portal.php renders self-hosted, integrity-checked tags (QA-3).
 *
 * The static guard (tools/no-cdn.mjs) proves no source references a CDN. This
 * suite proves the other half: the HTML portal.php actually emits points at
 * files that exist in the repo, carries an integrity hash for each vendored
 * file, hands the lazy Tabulator hashes to the bundle, and says so loudly when
 * the vendored tree is missing instead of rendering a blank page.
 *
 *   node tests/php/portal.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness } from './php.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
/* php-wasm resolves the harness's absolute host paths. */
const TMP = path.join(ROOT, 'tests/.tmp');
const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 400));
  }
};

const harness = await new PhpHarness();
await harness.boot();

/* portal.php lives at the web root, so mirror it and the vendor manifest into
 * the interpreter's filesystem the same way the harness mirrors api/. */
await harness.write('portal.php', readFileSync(path.join(ROOT, 'portal.php'), 'utf8'));
const manifestText = readFileSync(path.join(ROOT, 'assets/vendor/VENDOR.json'), 'utf8');
const manifest = JSON.parse(manifestText);

console.log('\n== portal.php: the vendored manifest is required ==');
const withoutManifest = await harness.script(`require '${TMP}/portal.php';`);
check('a missing assets/vendor tree is reported, not rendered blank',
  /Vendored assets are missing/.test(withoutManifest) && !/<script[^>]+src="https?:/.test(withoutManifest),
  withoutManifest.slice(0, 200));

console.log('\n== portal.php: emitted tags ==');
await harness.write('assets/vendor/VENDOR.json', manifestText);
const html = await harness.script(`require '${TMP}/portal.php';`);

const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
check('no tag points at a remote origin', remote.length === 0, remote);

const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map(m => m[0]);
const refs = tags
  .map(tag => (tag.match(/(?:src|href)="([^"]+)"/) || [])[1])
  .filter(Boolean)
  .filter(url => !url.startsWith('http'));
check('every local tag exists on disk',
  refs.length > 0 && refs.every(url => existsSync(path.join(ROOT, url))),
  refs.filter(url => !existsSync(path.join(ROOT, url))));

/* The stylesheet and script the manifest lists, in order, each with SRI. */
const loadEntries = manifest.load || [];
check('the manifest load list is non-empty and fully hashed',
  loadEntries.length >= 5 && loadEntries.every(e => /^sha384-[A-Za-z0-9+/=]+$/.test(e.integrity || '')),
  loadEntries.map(e => [e.id, e.integrity && e.integrity.slice(0, 14)]));

const missingIntegrity = loadEntries.filter(entry => {
  const url = entry.src || entry.href;
  const tag = tags.find(t => t.includes(url));
  return !tag || !tag.includes('integrity="' + entry.integrity + '"');
});
check('every manifest entry is emitted with its integrity hash',
  missingIntegrity.length === 0,
  missingIntegrity.map(e => e.id));

check('React/ReactDOM/Chart.js are deferred scripts from this origin',
  loadEntries.filter(e => e.tag === 'script').every(e => {
    const tag = tags.find(t => t.includes(e.src));
    return tag && tag.includes('defer') && !/https?:/.test(tag);
  }));

/*
 * QA-4: with a manifest present the deploy artifacts are the content-hashed
 * files, each carrying the sha384 from the manifest; without one (a dev
 * checkout) the unversioned dev build is used.
 */
const buildManifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/build-manifest.json'), 'utf8'));
await harness.write('assets/build-manifest.json', JSON.stringify(buildManifest));
/* portal.php only serves the manifest when the named files are really there,
 * so the sandbox needs them (their bytes are irrelevant to this check). */
await harness.write(buildManifest.js.file, '/*prod bundle stub*/\n');
await harness.write(buildManifest.css.file, '/*prod css stub*/\n');
const prodHtml = await harness.script(`require '${TMP}/portal.php';`);
check('with a manifest, the hashed stylesheet is loaded with its integrity',
  prodHtml.includes('href="' + buildManifest.css.file + '"') &&
    prodHtml.includes('integrity="sha384-' + buildManifest.css.sha384 + '"'),
  buildManifest.css.file);
check('with a manifest, the hashed bundle is loaded with its integrity',
  prodHtml.includes('src="' + buildManifest.js.file + '"') &&
    prodHtml.includes('integrity="sha384-' + buildManifest.js.sha384 + '"') &&
    /<script[^>]+defer[^>]+src="assets\/js\/app\.[0-9a-f]{10}\.js"/.test(prodHtml),
  buildManifest.js.file);
check('the unversioned dev bundle is not referenced in a prod deploy',
  !/src="assets\/js\/app\.js"/.test(prodHtml) && !/href="assets\/css\/app\.css"/.test(prodHtml));
check('every prod tag exists on disk',
  [buildManifest.js.file, buildManifest.css.file, ...refs].every(url => existsSync(path.join(ROOT, url))),
  [buildManifest.js.file, buildManifest.css.file].filter(url => !existsSync(path.join(ROOT, url))));

/* And the dev fallback: no manifest, unversioned names, no integrity needed. */
await harness.write('assets/build-manifest.json', '{ not json');
const devHtml = await harness.script(`require '${TMP}/portal.php';`);
check('a malformed manifest falls back to the dev build instead of breaking',
  /src="assets\/js\/app\.js"/.test(devHtml) && !/https?:/.test(devHtml.match(/<script[^>]+>/g).join('')),
  devHtml.match(/<script[^>]+>/g).join(' ').slice(0, 160));

check('the app bundle is still loaded',
  tags.some(t => /src="assets\/js\/app\.js"/.test(t)), tags.join(' ').slice(0, 160));

console.log('\n== portal.php: a deploy that changed the bytes says so ==');
{
  /*
   * The integrity hashes fail closed, which means a mangled upload produces a
   * blank dashboard and a console error — the operator's only clue. portal.php
   * compares every declared size (stat, not read) and names the files in the
   * page. The sizes are what matter here, so the stubs are only as long as the
   * manifest says; tools/deploy-check.mjs is what compares real bytes.
   */
  /* The first render had the manifest but no files on disk at all. */
  check('a manifest whose files are not on the server is reported',
    html.includes('id="deploy-warning"') && /do not match assets\/vendor\/VENDOR\.json/.test(html),
    (html.match(/Deploy problem[^<]*/) || [''])[0]);

  const vendorFiles = new Map((manifest.files || []).map(f => [f.target, f.bytes]));
  for (const [relative, bytes] of vendorFiles) {
    await harness.write(relative, 'x'.repeat(bytes));
  }
  await harness.write(buildManifest.js.file, 'x'.repeat(buildManifest.js.bytes));
  await harness.write(buildManifest.css.file, 'x'.repeat(buildManifest.css.bytes));
  const matching = await harness.script(`require '${TMP}/portal.php';`);
  check('every file the right size renders no warning', !matching.includes('deploy-warning'),
    (matching.match(/<div id="deploy-warning"[\s\S]{0,200}/) || [''])[0]);

  /* Now the incident: one file arrives with CRLF instead of LF. */
  const chart = 'assets/vendor/chart.js/chart.umd.js';
  const crlfBytes = vendorFiles.get(chart) + 14;
  await harness.write(chart, 'x'.repeat(crlfBytes));
  const mangled = await harness.script(`require '${TMP}/portal.php';`);
  check('a file whose size differs from the manifest is reported in the page',
    mangled.includes('id="deploy-warning"') && mangled.includes('Deploy problem'), mangled.slice(mangled.indexOf('deploy-warning') - 40, mangled.indexOf('deploy-warning') + 120));
  /* Sizes are printed for a human, so they carry thousands separators. */
  const human = n => n.toLocaleString('en-US');
  check('the report names the file and both sizes',
    mangled.includes(chart) && mangled.includes(human(crlfBytes)) && mangled.includes(human(vendorFiles.get(chart))),
    [human(crlfBytes), human(vendorFiles.get(chart))]);
  check('the report explains the binary-mode fix',
    /binary mode/i.test(mangled) && /deploy-check\.mjs/.test(mangled));
  check('the report counts only the mangled file', /1 file on this server does not match/.test(mangled) ||
    /Deploy problem: 1 file/.test(mangled), (mangled.match(/Deploy problem[^<]*/) || [''])[0]);
}

console.log('\n== portal.php: lazy Tabulator hashes for the bundle ==');
const manifestNode = (html.match(/<script type="application\/json" id="vendor-manifest">([\s\S]*?)<\/script>/) || [])[1];
let lazy = null;
try { lazy = JSON.parse(manifestNode); } catch { /* reported below */ }
check('the vendor manifest is embedded for ensureTabulator()',
  !!lazy && typeof lazy.tabulatorJs?.integrity === 'string' && typeof lazy.tabulatorCss?.integrity === 'string',
  manifestNode && manifestNode.slice(0, 120));
check('the embedded hashes match the vendored files',
  !!lazy &&
    lazy.tabulatorJs.integrity === manifest.lazy.tabulatorJs.integrity &&
    lazy.tabulatorCss.integrity === manifest.lazy.tabulatorCss.integrity,
  lazy && [lazy.tabulatorJs?.integrity?.slice(0, 14), manifest.lazy.tabulatorJs.integrity.slice(0, 14)]);
check('Tabulator is NOT loaded eagerly by the shell',
  !/tabulator/i.test(html.replace(/"lazy"[^<]*/g, '')) || !refs.some(url => /tabulator/i.test(url)),
  refs.filter(url => /tabulator/i.test(url)));

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPORTAL OK — self-hosted, integrity-checked tags');
process.exit(0);
