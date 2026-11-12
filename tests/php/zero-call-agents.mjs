/**
 * Agent rows for the extensions that had no call (`zeroCallAgents`).
 *
 * The complaint this suite answers: the Agent stats table only ever showed the
 * extensions that had calls. agentPerformance() builds a row when it meets a
 * call, so an extension that handled nothing in the range was not a row of
 * zeros - it was missing, and nobody could see who had been idle.
 *
 * report.php now lists every extension in scope when the request asks for it.
 * One synthetic day - eight directory users, three calls - is pushed through
 * the real endpoint, and the suite pins:
 *
 *   1. the default payload is unchanged: no flag, no idle rows;
 *   2. with the flag, one row per ordinary extension in scope - the busy ones
 *      first, the idle ones after them in name order, built from the same keys;
 *   3. a queue or an auto attendant is never listed, whoever asks for it;
 *   4. the idle rows change no total: the summary counts and Top agents are the
 *      same with and without them;
 *   5. the scope is the calls' scope - the department, site and agents filters;
 *   6. the role rules: a supervisor gets their own department, an agent their
 *      own row, and nobody is sent a name api/agents.php does not already
 *      show them.
 *
 *   node tests/php/zero-call-agents.mjs
 */
import { PhpHarness, USERS } from './php.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500));
  }
};

const D = '2026-08-02';
const at = hhmm => `${D}T${hhmm}:00Z[US/Eastern]`;

/* ------------------------------------------------------------------ fixtures */

/*
 * Who is in the directory. Two of them took calls, four did not, and two are
 * not people at all.
 *
 *   6080 Ada Lovelace     Sales    HQ      2 calls (one answered, one missed)
 *   6081 Alan Turing      Support  HQ      1 call  (outbound)
 *   6082 Grace Hopper     Sales    HQ      idle
 *   6083 edsger Dijkstra  Sales    Branch  idle  (lower-case on purpose: the
 *                                                 name order ignores case)
 *   6084 Barbara Liskov   Support  Branch  idle
 *   6085 (no name, no department, no site)  idle
 *   700  the Sales queue   service code system-queue
 *   900  the main IVR      service code system-aa
 */
const DIRECTORY = [
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', department: 'Sales', site: 'HQ' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', department: 'Support', site: 'HQ' },
  { user: '6082', 'name-first-name': 'Grace', 'name-last-name': 'Hopper', department: 'Sales', site: 'HQ' },
  { user: '6083', 'name-first-name': 'edsger', 'name-last-name': 'Dijkstra', department: 'Sales', site: 'Branch' },
  { user: '6084', 'name-first-name': 'Barbara', 'name-last-name': 'Liskov', department: 'Support', site: 'Branch' },
  { user: '6085', department: '', site: '' },
  { user: '700', 'name-first-name': 'Sales', 'name-last-name': 'Queue', 'service-code': 'system-queue' },
  { user: '900', 'name-first-name': 'Main', 'name-last-name': 'IVR', 'service-code': 'system-aa' },
];

const inbound = extra => Object.assign({
  'call-direction': 1,
  'call-start-datetime': at('10:00'),
  'call-orig-user': '8454259810',
  'call-orig-to-user': '8457620002',
  'call-orig-caller-id': '8454259810',
  'call-total-duration-seconds': 60,
  'call-talking-duration-seconds': 0,
}, extra);

const CDRS = [
  /* Ada: answered through the queue, 120 s of talk */
  inbound({ id: 'c1', 'call-answer-datetime': at('10:00:05'), 'call-talking-duration-seconds': 120, 'call-term-user': '6080', 'call-through-user': '700' }),
  /* Ada: plain no answer */
  inbound({ id: 'c2', 'call-start-datetime': at('10:10'), 'call-term-user': '6080' }),
  /* Alan: outbound */
  { id: 'c3', 'call-direction': 0, 'call-start-datetime': at('11:20'), 'call-orig-user': '6081', 'call-term-user': '8454259810', dialed: '8454259810', 'call-talking-duration-seconds': 30, 'call-total-duration-seconds': 40 },
];

const harness = await new PhpHarness();
await harness.boot();
await harness.seedPbx('users', DIRECTORY);
await harness.seedPbx('callqueues', [{ callqueue: '700', description: 'Sales queue', site: 'HQ' }]);
await harness.seedPbx('callqueueAgents', []);
await harness.seedPbx('phonenumbers', []);
await harness.seedPbx('archiveCdrs', []);
await harness.seedPbx('fetchCdrs', CDRS);

const BODY = { start: D, end: D, skipPrevious: 1 };
const report = (user, extra = {}) => harness.request('report.php', { body: { ...BODY, ...extra }, user });
const rowsOf = response => (Array.isArray(response.body?.agentPerformance) ? response.body.agentPerformance : []);
const extensionsOf = response => rowsOf(response).map(row => String(row.extension));
const idleOf = response => rowsOf(response).filter(row => Number(row.total) === 0).map(row => String(row.extension));
const topOf = response => (Array.isArray(response.body?.topAgents) ? response.body.topAgents : []).map(row => String(row.extension));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const manager = USERS.office_manager;

/* ------------------------------------------------ 1. the default is unchanged */

console.log('\n== without the flag: the payload every other caller gets ==');
const plain = await report(manager);
check('report status 200', plain.status === 200, plain.body);
check('only the extensions that had calls have a row',
  same(extensionsOf(plain), ['6080', '6081']), extensionsOf(plain));
check('a falsy flag is the same as no flag',
  same(rowsOf(await report(manager, { zeroCallAgents: 0 })), rowsOf(plain)) &&
    same(rowsOf(await report(manager, { zeroCallAgents: false })), rowsOf(plain)));

/* --------------------------------------------------------- 2. with the flag */

console.log('\n== with the flag: one row per extension in scope ==');
const listed = await report(manager, { zeroCallAgents: 1 });
const listedRows = rowsOf(listed);
check('report status 200', listed.status === 200, listed.body);
check('every ordinary extension has a row - busy first, then idle in name order',
  same(extensionsOf(listed), ['6080', '6081', '6085', '6084', '6083', '6082']), extensionsOf(listed));
check('the rows that had calls are exactly the rows the default payload has',
  same(listedRows.filter(row => Number(row.total) > 0), rowsOf(plain)),
  listedRows.filter(row => Number(row.total) > 0));

const busy = listedRows.find(row => String(row.extension) === '6080') || {};
const idleRows = listedRows.filter(row => Number(row.total) === 0);
check('an idle row is built from the same fields, in the same order, as a busy one',
  idleRows.length === 4 && idleRows.every(row => same(Object.keys(row), Object.keys(busy))),
  { busy: Object.keys(busy), idle: Object.keys(idleRows[0] || {}) });
const identity = ['extension', 'department', 'site', 'name'];
check('every figure on an idle row is zero',
  idleRows.every(row => Object.entries(row).every(([key, value]) => identity.includes(key) || Number(value) === 0)),
  idleRows[0]);
const liskov = listedRows.find(row => String(row.extension) === '6084') || {};
check('an idle row takes its name, department and site from the directory',
  liskov.name === 'Barbara Liskov' && liskov.department === 'Support' && liskov.site === 'Branch', liskov);
const nameless = listedRows.find(row => String(row.extension) === '6085') || {};
check('an extension without a name is listed under its number',
  nameless.name === '6085' && nameless.department === '' && nameless.site === '', nameless);
check('the extension is a string on every row (a numeric key must not turn it into a number)',
  listedRows.every(row => typeof row.extension === 'string'), listedRows.map(row => typeof row.extension));

/* --------------------------------------------- 3. queues and auto attendants */

console.log('\n== a queue or an auto attendant is never an agent ==');
check('no row for the queue (700) or the auto attendant (900)',
  !extensionsOf(listed).includes('700') && !extensionsOf(listed).includes('900'), extensionsOf(listed));
const askedForQueue = await report(manager, { zeroCallAgents: 1, agents: ['700', '900'] });
check('not even when the request names them',
  askedForQueue.status === 200 && rowsOf(askedForQueue).length === 0, extensionsOf(askedForQueue));

/* ---------------------------------------------- 4. idle rows change no total */

console.log('\n== the idle rows change no total ==');
check('summary counts are identical with and without the flag',
  same(listed.body?.summary?.counts, plain.body?.summary?.counts) && Number(plain.body?.summary?.counts?.total) === 3,
  { listed: listed.body?.summary?.counts, plain: plain.body?.summary?.counts });
check('Top agents is identical with and without the flag',
  same(listed.body?.topAgents, plain.body?.topAgents) && same(topOf(listed), ['6080', '6081']),
  { listed: topOf(listed), plain: topOf(plain) });
check('Σ(total) over the agent rows is unchanged',
  listedRows.reduce((n, row) => n + Number(row.total), 0) === rowsOf(plain).reduce((n, row) => n + Number(row.total), 0),
  listedRows.map(row => row.total));

/* ------------------------------------------------- 5. the filters still scope */

console.log('\n== department, site and agents filters ==');
const sales = await report(manager, { zeroCallAgents: 1, department: 'Sales' });
check('department Sales lists Sales only, idle extensions included',
  same(extensionsOf(sales), ['6080', '6083', '6082']), extensionsOf(sales));
const branch = await report(manager, { zeroCallAgents: 1, site: 'Branch' });
check('site Branch lists the Branch extensions, all idle',
  same(extensionsOf(branch), ['6084', '6083']) && same(idleOf(branch), ['6084', '6083']), extensionsOf(branch));
check('a scope where nobody took a call has no Top agents',
  same(topOf(branch), []), topOf(branch));
const salesBranch = await report(manager, { zeroCallAgents: 1, department: 'Sales', site: 'Branch' });
check('department and site together are both applied',
  same(extensionsOf(salesBranch), ['6083']), extensionsOf(salesBranch));
const one = await report(manager, { zeroCallAgents: 1, agents: ['6082'] });
check('agents [6082] returns that extension as a row of zeros (the overview and compare views)',
  same(extensionsOf(one), ['6082']) && same(idleOf(one), ['6082']), rowsOf(one));
const oneUnflagged = await report(manager, { agents: ['6082'] });
check('the same request without the flag has no row at all',
  rowsOf(oneUnflagged).length === 0, rowsOf(oneUnflagged));
const pair = await report(manager, { zeroCallAgents: 1, agents: ['6080', '6084'] });
check('agents [6080, 6084] returns the busy one and the idle one, and nobody else',
  same(extensionsOf(pair), ['6080', '6084']), extensionsOf(pair));
const nobody = await report(manager, { zeroCallAgents: 1, department: 'No Such Department' });
check('a department nobody is in lists nobody',
  rowsOf(nobody).length === 0, extensionsOf(nobody));

/* -------------------------------------------------------- 6. the role rules */

console.log('\n== role rules ==');
/*
 * api/agents.php is the list of people each role is already shown (the Agents
 * sidebar). The idle rows carry names that are attached to no call, so the bar
 * is: nobody is sent a name that endpoint would not send them.
 */
const roster = async user => {
  const response = await harness.request('agents.php', { body: { start: D, end: D }, user });
  return (Array.isArray(response.body?.data) ? response.body.data : []).map(row => String(row.extension));
};
const within = (extensions, allowed) => extensions.every(extension => allowed.includes(extension));

const supervisor = USERS.supervisor; // department: Sales
const supervised = await report(supervisor, { zeroCallAgents: 1 });
check('a supervisor gets their own department',
  same(extensionsOf(supervised), ['6080', '6083', '6082']), extensionsOf(supervised));
const reaching = await report(supervisor, { zeroCallAgents: 1, department: 'Support' });
check('a supervisor asking for another department still gets their own',
  same(extensionsOf(reaching), ['6080', '6083', '6082']), extensionsOf(reaching));
check('a supervisor is sent no idle name the Agents list does not already show them',
  idleOf(supervised).length === 2 && within(idleOf(supervised), await roster(supervisor)),
  { idle: idleOf(supervised), roster: await roster(supervisor) });

/*
 * A supervisor whose own department is blank. The CALLS are not narrowed for
 * them (a blank department is "no filter" in scopedCdrs(), which is not this
 * suite's subject), but the directory must not be handed over on the same
 * reading: only the extensions whose department is blank, exactly as
 * api/agents.php lists them.
 */
const unassigned = { ...USERS.supervisor, department: '' };
const unassignedReport = await report(unassigned, { zeroCallAgents: 1 });
check('a supervisor without a department is sent idle extensions without a department, not the directory',
  same(idleOf(unassignedReport), ['6085']), idleOf(unassignedReport));
check('…and no idle name the Agents list does not already show them',
  within(idleOf(unassignedReport), await roster(unassigned)),
  { idle: idleOf(unassignedReport), roster: await roster(unassigned) });

const agent = USERS.agent; // extension 6080, department Sales
const own = await report(agent, { zeroCallAgents: 1 });
check('an agent gets their own row and nobody else',
  same(extensionsOf(own), ['6080']), extensionsOf(own));
const peeking = await report(agent, { zeroCallAgents: 1, agents: ['6082', '6083'] });
check('an agent naming other extensions still gets only their own',
  same(extensionsOf(peeking), ['6080']), extensionsOf(peeking));

const idleAgent = { ...USERS.agent, extension: '6082' }; // Grace: Sales, no calls
const ownIdle = await report(idleAgent, { zeroCallAgents: 1 });
check('an agent who took no call gets their own row of zeros',
  same(extensionsOf(ownIdle), ['6082']) && same(idleOf(ownIdle), ['6082']), rowsOf(ownIdle));

/* USERS.basic_user is extension 6082 with a blank department, while the
 * directory has 6082 in Sales: api/agents.php lists nobody for that user, and
 * so does this. */
const basic = USERS.basic_user;
const basicReport = await report(basic, { zeroCallAgents: 1 });
check('a user whose department does not match their directory entry is sent no idle row',
  basicReport.status === 200 && rowsOf(basicReport).length === 0 && (await roster(basic)).length === 0,
  { rows: extensionsOf(basicReport), roster: await roster(basic) });

/* ------------------------------------------- the two functions, called bare */

console.log('\n== agentPerformance() / agentExtensionsInScope() ==');
const raw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$directory = [
    '6080' => ['extension' => '6080', 'name' => 'Ada Lovelace', 'department' => 'Sales', 'site' => 'HQ', 'serviceCode' => ''],
    '6082' => ['extension' => '6082', 'name' => 'Grace Hopper', 'department' => 'Sales', 'site' => 'HQ', 'serviceCode' => ''],
    '6090' => ['extension' => '6090', 'name' => 'Zero Dept', 'department' => '0', 'site' => '0', 'serviceCode' => ''],
    '700' => ['extension' => '700', 'name' => 'Sales Queue', 'department' => 'Sales', 'site' => 'HQ', 'serviceCode' => 'system-queue'],
];
$filters = static fn(array $over = []): array => $over + ['department' => '', 'site' => '', 'agents' => []];
$manager = ['role' => 'office_manager', 'department' => '', 'extension' => '1000'];
$extensions = static fn(array $rows): array => array_map(static fn(array $row): string => (string)$row['extension'], $rows);
echo json_encode([
    /* three arguments: what every existing caller passes */
    'legacy' => agentPerformance([], $directory, []),
    'listed' => $extensions(agentPerformance([], $directory, [], ['6082', '700', '', '6082', '7777', 6080])),
    'unknown' => agentPerformance([], $directory, [], ['7777']),
    'scopeAll' => agentExtensionsInScope($directory, $filters(), $manager),
    'scopeZeroDepartment' => agentExtensionsInScope($directory, $filters(['department' => '0']), $manager),
    'scopeZeroSite' => agentExtensionsInScope($directory, $filters(['site' => '0']), $manager),
    'scopeAgents' => agentExtensionsInScope($directory, $filters(['agents' => ['6082', '700']]), $manager),
    'scopeNoRole' => agentExtensionsInScope($directory, $filters(), []),
    'scopeTypes' => array_map('gettype', agentExtensionsInScope($directory, $filters(), $manager)),
]);
`);
let bare = {};
try {
  bare = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
} catch {
  console.log('  FAIL could not parse the script output:', raw.slice(0, 600));
  process.exit(1);
}
check('agentPerformance() with three arguments and no calls is still an empty list',
  same(bare.legacy, []), bare.legacy);
check('a listed extension gets one row: duplicates, blanks and service users add none',
  same([...(bare.listed || [])].sort(), ['6080', '6082', '7777']), bare.listed);
check('a listed extension the directory does not know is a row named by its number',
  Array.isArray(bare.unknown) && bare.unknown.length === 1 && bare.unknown[0].name === '7777' && bare.unknown[0].extension === '7777',
  bare.unknown);
check('the scope is every ordinary extension, in directory order, as strings',
  same(bare.scopeAll, ['6080', '6082', '6090']) && bare.scopeTypes.every(type => type === 'string'),
  { scope: bare.scopeAll, types: bare.scopeTypes });
check('a department called "0" is a filter, not "no filter"',
  same(bare.scopeZeroDepartment, ['6090']), bare.scopeZeroDepartment);
check('a site called "0" is a filter, not "no filter"',
  same(bare.scopeZeroSite, ['6090']), bare.scopeZeroSite);
check('the agents filter keeps the ordinary extensions it names',
  same(bare.scopeAgents, ['6082']), bare.scopeAgents);
check('a user record with no role is not read as a manager',
  same(bare.scopeNoRole, []), bare.scopeNoRole);

/* ------------------------------------------------------------------ summary */

console.log('\n' + '-'.repeat(72));
if (failures.length) {
  console.log(`ZERO-CALL AGENTS FAILED — ${failures.length} check(s):`);
  for (const label of failures) console.log('  -', label);
  process.exit(1);
}
console.log('ZERO-CALL AGENTS OK — every extension in scope has a row, and only those');
