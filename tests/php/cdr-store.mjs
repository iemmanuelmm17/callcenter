/**
 * SQLite CDR store contract test.
 *
 * The store's SQL lives in PHP, but the PHP runtime in this container
 * (php-wasm) has no pdo_sqlite driver, so the statements are executed by
 * Node's own SQLite engine (node:sqlite, the same SQLite library) and the PHP
 * side is checked against the recorded calls.
 *
 * Three things are proven here:
 *   1. the schema, the upsert and the day bookkeeping statements actually run,
 *      are idempotent, and `record_count` stays the number of stored records;
 *   2. resuming a fetch after a partial page appends only what is new (this is
 *      the property the old JSON cache bought by rewriting whole days, and the
 *      resume logic depends on it);
 *   3. the PHP statements match the schema, the driver switch answers json when
 *      SQLite is missing, and reporting/cache.php talks to the store.
 *
 *   node tests/php/cdr-store.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PhpHarness, ROOT } from './php.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 400));
  }
};

const store = readFileSync(path.join(ROOT, 'includes/reporting/cdr_store.php'), 'utf8');
const arrays = (name) => {
  const start = store.indexOf(`function ${name}(): array`);
  if (start === -1) throw new Error(`no ${name}() in includes/reporting/cdr_store.php`);
  const open = store.indexOf('[', store.indexOf('{', start));
  let depth = 0;
  let quote = null;
  for (let i = open; i < store.length; i++) {
    const ch = store[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const version = (store.match(/define\('CDR_STORE_SCHEMA_VERSION', (\d+)\)/) || [])[1] || '1';
        /* `'PRAGMA user_version = ' . CDR_STORE_SCHEMA_VERSION` is a PHP
         * concatenation: fold the version the store defines into the string
         * before the quotes are turned into JSON strings. */
        const literal = store.slice(open, i + 1)
          .replace(/'([^']*)'\s*\.\s*CDR_STORE_SCHEMA_VERSION/g, (_, text) => JSON.stringify(text + version))
          .replace(/'([^']*)'/g, (_, text) => JSON.stringify(text));
        return JSON.parse(literal.replace(/\/\*[\s\S]*?\*\//g, ''));
      }
    }
  }
  throw new Error(`could not read the array literal of ${name}()`);
};

/* `cdrStoreSchemaSql()` appends the schema version to the last entry. */
const schema = arrays('cdrStoreSchemaSql');
const pragmas = arrays('cdrStorePragmas');
const insertSql = (store.match(/return '(INSERT INTO cdr_records[\s\S]*?)';/) || [])[1];
const daySql = (store.match(/return '(INSERT INTO cdr_days[\s\S]*?)';/) || [])[1];

console.log('== node:sqlite executes the store schema ==');
const db = new DatabaseSync(':memory:');
let schemaError = null;
try {
  for (const statement of schema) db.exec(statement);
} catch (error) {
  schemaError = error;
}
check('every schema statement runs', !schemaError, schemaError && schemaError.message);
if (schemaError) process.exit(1);

const write = (domain, day, records, complete, nextOffset, replace = false, tz = 'US/Eastern') => {
  const stored = replace ? 0 : Number(db.prepare('SELECT COUNT(*) AS n FROM cdr_records WHERE domain = ? AND tz = ? AND day = ?').get(domain, tz, day).n);
  const tail = records.slice(stored);
  if (replace) db.prepare('DELETE FROM cdr_records WHERE domain = ? AND tz = ? AND day = ?').run(domain, tz, day);
  const insert = db.prepare(insertSql);
  tail.forEach((record, index) => {
    insert.run(
      domain, tz, day, stored + index, record.key, record.start_ts ?? null,
      record.kind ?? null, record.agent ?? null, record.department ?? null, record.site ?? null,
      JSON.stringify(record.raw)
    );
  });
  db.prepare(daySql).run(domain, tz, day, complete ? 1 : 0, nextOffset, domain, tz, day, 1700000000);
  return tail.length;
};

const record = (key, over = {}) => ({ key, start_ts: 1754000000, kind: 'inbound', agent: '7001', department: 'Sales', site: 'HQ', raw: { id: key, 'call-direction': 1, ...over } });
const meta = (domain, day, tz = 'US/Eastern') => db.prepare('SELECT * FROM cdr_days WHERE domain = ? AND tz = ? AND day = ?').get(domain, tz, day);

const firstPage = [record('a'), record('b'), record('c')];
check('first page inserts every record', write('acme.example', '2026-08-02', firstPage, false, 750) === 3);
const dayRow = meta('acme.example', '2026-08-02');
check('day is not complete after page one', Number(dayRow.complete) === 0);
check('next_offset is stored', Number(dayRow.next_offset) === 750);
check('record_count matches the records', Number(dayRow.record_count) === 3, dayRow.record_count);

const secondPage = [...firstPage, record('d'), record('e')];
check('resumed fetch appends only the new records', write('acme.example', '2026-08-02', secondPage, true, 1500) === 2);
check('day is complete after the last page', Number(meta('acme.example', '2026-08-02').complete) === 1);
check('record_count follows both pages', Number(meta('acme.example', '2026-08-02').record_count) === 5);
check('records are returned in PBX order',
  db.prepare('SELECT cdr_key FROM cdr_records WHERE domain = ? AND tz = ? AND day = ? ORDER BY seq').all('acme.example', 'US/Eastern', '2026-08-02').map(r => r.cdr_key).join('') === 'abcde');

check('re-writing the same page changes nothing', write('acme.example', '2026-08-02', secondPage, true, 1500) === 0);
check('record_count is still five', Number(meta('acme.example', '2026-08-02').record_count) === 5);

const corrected = [record('a'), record('b', { 'call-answer-datetime': '2026-08-02T10:05:00.000Z' }), record('x')];
check('a fresh fetch replaces the day instead of merging', write('acme.example', '2026-08-02', corrected, true, 500, true) === 3);
check('the replaced day kept exactly the new records', Number(meta('acme.example', '2026-08-02').record_count) === 3);
check('an upserted record keeps one row',
  Number(db.prepare('SELECT COUNT(*) AS n FROM cdr_records WHERE domain = ? AND tz = ? AND day = ? AND cdr_key = ?').get('acme.example', 'US/Eastern', '2026-08-02', 'b').n) === 1);

console.log('\n== day keys are per domain and per timezone ==');
write('other.example', '2026-08-02', [record('z')], true, 0);
check('two domains keep separate days', Number(meta('acme.example', '2026-08-02').record_count) === 3 && Number(meta('other.example', '2026-08-02').record_count) === 1);
write('acme.example', '2026-08-02', [record('tz')], true, 0, true, 'America/New_York');
check('a different timezone is a different day',
  Number(db.prepare('SELECT COUNT(*) AS n FROM cdr_records WHERE domain = ? AND day = ?').get('acme.example', '2026-08-02').n) === 4);

console.log('\n== the PHP statements match this schema ==');
check('the insert targets the same columns', /INSERT INTO cdr_records \(domain, tz, day, seq, cdr_key, start_ts, kind, agent, department, site, raw\)/.test(insertSql || ''), insertSql && insertSql.slice(0, 80));
check('the insert is an upsert on the primary key', /ON CONFLICT \(domain, tz, day, cdr_key\) DO UPDATE/.test(insertSql || ''));
check('the day upsert counts the stored records', /\(SELECT COUNT\(\*\) FROM cdr_records WHERE domain = \? AND tz = \? AND day = \?\)/.test(daySql || ''));
check('both writes are wrapped in a transaction', /beginTransaction\(\)[\s\S]*commit\(\)/.test(store));
check('a failed write rolls back and is logged', /rollBack\(\)[\s\S]*appExceptionLog/.test(store));
check('WAL is requested', pragmas.some(p => /journal_mode = WAL/.test(p)));
check('busy_timeout is set (concurrent warm jobs)', pragmas.some(p => /busy_timeout/.test(p)));
check('reads are ordered by seq', /ORDER BY seq/.test(store));
check('schema versioning is in place', /user_version = ' \. CDR_STORE_SCHEMA_VERSION/.test(store) || /user_version/.test(store));

console.log('\n== the PHP side drives this store ==');
const harness = new PhpHarness();
await harness.boot();

/* The harness runs snippets through php.run(code) with the mirrored tree at
 * tests/.tmp/includes, so paths are passed in rather than using __DIR__. */
const TMP = path.join(ROOT, 'tests/.tmp');
const php = `<?php
require_once '${TMP}/includes/reporting.php';
$out = [];
/* No pdo_sqlite in this runtime: 'auto' must fall back, 'sqlite' must too
 * (with a log line), 'json' must be honoured. */
$out['auto'] = cdrCacheDriver();
$out['available'] = cdrStoreAvailable();
$out['insert'] = cdrStoreInsertSql();
$out['day'] = cdrStoreDaySql();
$out['schema'] = cdrStoreSchemaSql();
$out['pragmas'] = cdrStorePragmas();
$out['file'] = str_replace(CACHE_DIR, '<cache>', cdrStoreFile());
$out['status'] = cdrStoreStatus();
$out['meta'] = cdrStoreDayMeta('acme.example', '2026-08-02');
$out['load'] = cdrStoreDayLoad('acme.example', '2026-08-02');
cdrStoreDayWrite('acme.example', '2026-08-02', [['id' => 'x']], true, 0);
$out['delete'] = cdrStoreDayDelete('acme.example', '2026-08-02');
$out['prune'] = cdrStorePrune('acme.example', '2026-01-01');
$out['vacuum'] = cdrStoreVacuum();
$out['compare'] = cdrStoreCompareDay(
    ['complete' => true, 'records' => [['id' => 'a'], ['id' => 'b']]],
    ['complete' => true, 'records' => [['id' => 'a'], ['id' => 'c']]]
);
$out['empty'] = cdrStoreCompareDay([], []);
echo json_encode($out);
`;
const raw = await harness.script(php);
let out = null;
try {
  out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
} catch (error) {
  check('PHP store API answers', false, raw.slice(0, 400));
}
if (out) {
  check('driver falls back to json without a SQLite driver', out.auto === 'json' && out.available === false, JSON.stringify({ driver: out.auto, available: out.available }));
  check('every store call is a no-op, not an error, without a driver',
    out.meta.exists === false && out.load === null && out.delete === 0 && out.prune.days === 0 && out.vacuum === false);
  check('status reports the driver and the file', out.status.driver === 'json' && /cdrs\.sqlite$/.test(out.file), JSON.stringify(out.status));
  check('the PHP insert statement equals the tested one', out.insert.replace(/\s+/g, ' ').trim() === insertSql.replace(/\s+/g, ' ').trim());
  check('the PHP day statement equals the tested one', out.day.replace(/\s+/g, ' ').trim() === daySql.replace(/\s+/g, ' ').trim());
  check('the PHP schema creates the same table names',
    out.schema.join('\n').includes('CREATE TABLE IF NOT EXISTS cdr_days') && out.schema.join('\n').includes('CREATE TABLE IF NOT EXISTS cdr_records'));
  check('the PHP schema is accepted by SQLite', (() => {
    const probe = new DatabaseSync(':memory:');
    try {
      for (const statement of out.schema) probe.exec(statement);
      return true;
    } catch (error) {
      check('schema error', false, error.message);
      return false;
    }
  })());
  check('compare detects a differing day', out.compare.same === false && out.compare.missing.length === 1 && out.compare.extra.length === 1, JSON.stringify(out.compare));
  check('compare accepts an identical (empty) day', out.empty.same === true);
  /* These two are source-level facts, so they are read directly: the harness
   * filesystem only contains the mirrored tree, not the repository. */
  const cacheSource = readFileSync(path.join(ROOT, 'includes/reporting/cache.php'), 'utf8');
  const facadeSource = readFileSync(path.join(ROOT, 'includes/reporting.php'), 'utf8');
  check('the reporting facade loads the store module', facadeSource.includes("reporting/cdr_store.php"));
  check('the day cache reads through the store when the driver is sqlite',
    /cdrCacheDriver\(\) === 'sqlite'/.test(cacheSource) && cacheSource.includes('cdrStoreDayLoad('));
  check('the day cache still has the JSON path for the json driver',
    cacheSource.includes('readCdrDayCache(') && cacheSource.includes('writeCdrDayCache('));
}

console.log(`\n${failures.length === 0 ? 'CDR STORE TESTS OK' : `${failures.length} FAILURE(S): ${failures.join(' | ')}`}`);
process.exit(failures.length ? 1 : 0);
