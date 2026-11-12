#!/usr/bin/env node
/**
 * Test runner.
 *
 *   node tests/run.mjs         # everything (what `npm test` runs)
 *   node tests/run.mjs js      # browser-side suite (jsdom + real React)
 *   node tests/run.mjs php     # API suite (real PHP 8.4 via phpwasm)
 *   node tests/run.mjs static  # lint + CSS coverage only (no build, fastest gate)
 *
 * Suites run as child processes so one crash cannot hide another's results, and
 * the summary at the end is what a human reads before pushing.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const which = (process.argv[2] || 'all').toLowerCase();

const SUITES = {
  static: [
    /*
     * The dev build runs first: css-coverage, ui-audit and the jsdom smoke all
     * read assets/js/app.js + assets/css/app.css, which are git-ignored build
     * output (QA-4) — a fresh clone has no stylesheet until this step runs.
     */
    { name: 'build', cmd: ['node', 'tools/build.mjs'] },
    { name: 'prod build', cmd: ['node', 'tools/prod-build.mjs'] },
    { name: 'php lint', cmd: ['node', 'tools/php-lint.mjs'] },
    /* The CDR allowlist is generated from the source: a new field read that
     * was not regenerated fails here, before it can silently drop data. */
    { name: 'cdr fields', cmd: ['node', 'tools/cdr-fields.mjs'] },
    { name: 'css coverage', cmd: ['node', 'tools/css-coverage.mjs'] },
    { name: 'ui audit', cmd: ['node', 'tools/ui-audit.mjs', '--strict'] },
    { name: 'module budget', cmd: ['node', 'tools/module-budget.mjs'] },
    { name: 'dead code', cmd: ['node', 'tools/dead-code.mjs', '--strict'] },
    { name: 'no cdn', cmd: ['node', 'tools/no-cdn.mjs'] },
    { name: 'vendor check', cmd: ['node', 'tools/vendor.mjs', '--check'] },
    { name: 'deploy check', cmd: ['node', 'tests/js/deploy-check.mjs'] }
  ],
  js: [
    { name: 'js smoke', cmd: ['node', 'tests/js/smoke.mjs'] },
    { name: 'aa fields', cmd: ['node', 'tests/js/aa-fields.mjs'] },
    { name: 'aa model', cmd: ['node', 'tests/js/aa-model.mjs'] },
    { name: 'date range', cmd: ['node', 'tests/js/date-range.mjs'] },
    /* The desk's timezone on the client side (review C7). */
    { name: 'desk clock', cmd: ['node', 'tests/js/timezone.mjs'] },
    { name: 'pagination', cmd: ['node', 'tests/js/pagination.mjs'] },
    /* Bug #4: the call modal 404'd because the Tabulator URL was hand-built. */
    { name: 'vendor paths', cmd: ['node', 'tests/js/vendor-paths.mjs'] }
  ],
  php: [
    { name: 'api matrix', cmd: ['node', 'tests/php/endpoints.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'url policy', cmd: ['node', 'tests/php/security.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'csv exports', cmd: ['node', 'tests/php/export.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'cdr store', cmd: ['node', 'tests/php/cdr-store.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'cdr cache', cmd: ['node', 'tests/php/cdr-cache.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'cdr memory', cmd: ['node', 'tests/php/cdr-memory.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'cdr speed', cmd: ['node', 'tests/php/cdr-speed.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'outcome parity', cmd: ['node', 'tests/php/outcomes.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'report metrics', cmd: ['node', 'tests/php/report-metrics.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    /* Agent stats lists the extensions with no call: who gets a row, and who is sent whose. */
    { name: 'zero-call agents', cmd: ['node', 'tests/php/zero-call-agents.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'call links', cmd: ['node', 'tests/php/call-links.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } },
    { name: 'portal', cmd: ['node', 'tests/php/portal.mjs'], env: { CALLCENTER_STRICT_PHP: '1' } }
  ]
};

let selected;
if (which === 'all') selected = [...SUITES.static, ...SUITES.js, ...SUITES.php];
else if (SUITES[which]) selected = SUITES[which];
else {
  console.error(`unknown suite "${which}" — use js, php, static or all`);
  process.exit(2);
}

/*
 * Every PHP suite runs with CALLCENTER_STRICT_PHP=1, so the interpreter
 * surfaces its own warnings and a stray diagnostic before a JSON body (the
 * "Server returned invalid JSON" class of bug) fails the suite instead of
 * shipping. See tests/php/php.mjs for what the flag does.
 */
const run = (cmd, env = {}) => new Promise((resolve) => {
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', code => resolve(code ?? 1));
});

const results = [];
for (const suite of selected) {
  const started = Date.now();
  console.log(`\n${'='.repeat(72)}\n# ${suite.name}\n${'='.repeat(72)}`);
  const code = await run(suite.cmd, suite.env || {});
  results.push({ ...suite, code, ms: Date.now() - started });
}

console.log(`\n${'='.repeat(72)}\n# summary\n${'='.repeat(72)}`);
for (const result of results) {
  const status = result.code === 0 ? 'OK  ' : 'FAIL';
  console.log(`  ${status} ${result.name.padEnd(16)} ${(result.ms / 1000).toFixed(1)}s`);
}
const failed = results.filter(result => result.code !== 0);
if (failed.length) {
  console.log(`\n${failed.length} suite(s) failed: ${failed.map(f => f.name).join(', ')}`);
  process.exit(1);
}
console.log('\nALL SUITES PASSED');
