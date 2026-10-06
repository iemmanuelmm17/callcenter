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
    { name: 'php lint', cmd: ['node', 'tools/php-lint.mjs'] },
    { name: 'css coverage', cmd: ['node', 'tools/css-coverage.mjs'] },
    { name: 'ui audit', cmd: ['node', 'tools/ui-audit.mjs', '--strict'] },
    { name: 'module budget', cmd: ['node', 'tools/module-budget.mjs'] },
    { name: 'dead code', cmd: ['node', 'tools/dead-code.mjs', '--strict'] }
  ],
  js: [
    { name: 'build', cmd: ['node', 'tools/build.mjs'] },
    { name: 'js smoke', cmd: ['node', 'tests/js/smoke.mjs'] }
  ],
  php: [
    { name: 'api matrix', cmd: ['node', 'tests/php/endpoints.mjs'] },
    { name: 'url policy', cmd: ['node', 'tests/php/security.mjs'] },
    { name: 'csv exports', cmd: ['node', 'tests/php/export.mjs'] }
  ]
};

let selected;
if (which === 'all') selected = [...SUITES.static, ...SUITES.js, ...SUITES.php];
else if (SUITES[which]) selected = SUITES[which];
else {
  console.error(`unknown suite "${which}" — use js, php, static or all`);
  process.exit(2);
}

const run = (cmd) => new Promise((resolve) => {
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', code => resolve(code ?? 1));
});

const results = [];
for (const suite of selected) {
  const started = Date.now();
  console.log(`\n${'='.repeat(72)}\n# ${suite.name}\n${'='.repeat(72)}`);
  const code = await run(suite.cmd);
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
