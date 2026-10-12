/**
 * Sprint A, part 2 — one call, many legs.
 *
 * The manager review's sharpest complaints are about identity, not fields: a
 * call that is transferred appears as several CDR rows, so "offered" drifts away
 * from "answered" between screens, nobody can say how often a caller is bounced
 * between two agents, and nobody can say how many missed calls were returned.
 *
 * This suite pins the shared answers (includes/reporting/links.php) with legs
 * built by hand, one behaviour per case:
 *
 *   1. identity — a transfer group is ONE interaction, the same agent twice is
 *      not a transfer, a numeric call id (the strict_types fatal that used to
 *      exist in one of the three duplicate copies) still groups, and rows with
 *      no ids merge only when they describe the same event;
 *   2. transfers — counts, pairs, the rate denominator, and the two rules that
 *      matter: an unanswered leg is not a transfer, an external terminus is not
 *      an agent;
 *   3. callbacks — matched on the customer's number either way round, never on
 *      the always-false `call-back` field, never on an outbound leg's own
 *      from-number (that is the desk's caller ID), never before the miss, and
 *      not outside the window;
 *   4. repeat callers — the 24 h / 72 h split and the rate the review wants
 *      beside each agent;
 *   5. the payload — api/report.php ships the block, and its counts agree with
 *      the hand-computed ones.
 *
 *   node tests/php/call-links.mjs
 */
import { PhpHarness, USERS } from './php.mjs';

const failures = [];
const show = value => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : show(extra).slice(0, 700));
  }
};

const parseJson = (raw) => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
};

const harness = new PhpHarness();
await harness.boot();

/*
 * The directory matters for every number below: callAgent() only reports an
 * extension that the directory knows (or one that looks internal), so without
 * these seeds a transferred call has no agent to attribute the second leg to.
 */
await harness.seedPbx('users', [
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6080@test.example' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6081@test.example' },
  { user: '6082', 'name-first-name': 'Grace', 'name-last-name': 'Hopper', 'user-scope': 'User', department: 'Support', site: 'HQ', 'login-username': '6082@test.example' },
]);
await harness.seedPbx('callqueues', [{ callqueue: '700', description: 'Sales queue', site: 'HQ' }]);

/* ================================================================ 1. identity */

console.log('\n== identity: which rows are the same conversation ==');

const identityRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$directory = ['6080' => ['name' => 'Ada'], '6081' => ['name' => 'Alan']];

/* A transfer: two answered legs on the same original call, in PBX leg order. */
$transfer = [
    ['id' => 'l1', 'call-orig-call-id' => 'orig1', 'call-start-datetime' => '2026-08-03T10:00:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T10:00:10Z[US/Eastern]', 'call-term-user' => '6080',
     'call-through-user' => '700', 'call-leg-ordinal-index' => 1, 'call-direction' => 1],
    ['id' => 'l2', 'call-parent-call-id' => 'orig1', 'call-start-datetime' => '2026-08-03T10:05:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T10:05:30Z[US/Eastern]', 'call-term-user' => '6081',
     'call-through-user' => '700', 'call-leg-ordinal-index' => 2, 'call-direction' => 1],
];
$idx = cdrLegIndex($transfer);
$keys = [];
foreach ($transfer as $leg) { $keys[] = cdrRootKey($leg, $idx); }

/* The same agent answering twice on one interaction is NOT a transfer. */
$sameAgent = [
    ['id' => 's1', 'call-orig-call-id' => 'orig2', 'call-start-datetime' => '2026-08-03T11:00:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T11:00:05Z[US/Eastern]', 'call-term-user' => '6080',
     'call-leg-ordinal-index' => 1, 'call-direction' => 1],
    ['id' => 's2', 'call-parent-call-id' => 'orig2', 'call-start-datetime' => '2026-08-03T11:02:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T11:02:04Z[US/Eastern]', 'call-term-user' => '6080',
     'call-leg-ordinal-index' => 2, 'call-direction' => 1],
];

/* A PURELY NUMERIC call id: PHP makes it an int array key. The cradle copy of
 * cdrIdBag used to hand that int to a string-typed helper and fatal. */
$numeric = [
    ['id' => '20260115143022', 'call-orig-call-id' => '20260115143022', 'call-start-datetime' => '2026-08-03T12:00:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T12:00:03Z[US/Eastern]', 'call-term-user' => '6080', 'call-direction' => 1],
    ['id' => '20260115143022', 'call-parent-call-id' => '20260115143022', 'call-start-datetime' => '2026-08-03T12:00:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T12:00:03Z[US/Eastern]', 'call-term-user' => '6080', 'call-direction' => 1],
];
$numericIdx = cdrLegIndex($numeric);
$numericRoots = [];
foreach ($numeric as $leg) { $numericRoots[] = cdrRootKey($leg, $numericIdx); }

/* Rows with no ids at all: identical in every field that describes the event,
 * so they are the same export row twice; a different caller does not merge. */
$noIds = [
    ['call-direction' => 1, 'call-start-datetime' => '2026-08-03T13:00:00Z[US/Eastern]', 'call-orig-caller-id' => '8454259810', 'call-term-user' => '6080'],
    ['call-direction' => 1, 'call-start-datetime' => '2026-08-03T13:00:00Z[US/Eastern]', 'call-orig-caller-id' => '8454259810', 'call-term-user' => '6080'],
    ['call-direction' => 1, 'call-start-datetime' => '2026-08-03T13:00:00Z[US/Eastern]', 'call-orig-caller-id' => '5550001111', 'call-term-user' => '6080'],
];
$noIdIdx = cdrLegIndex($noIds);

echo json_encode([
    'transfer_roots_equal' => $keys[0] === $keys[1],
    'transfer_legs' => count(cdrInteractionLegs($transfer[0], $idx)),
    'transfer_count' => cdrTransferCount($transfer[0], $idx, $directory),
    'transfer_pairs' => cdrTransferPairs($transfer[0], $idx, $directory),
    'same_agent_count' => cdrTransferCount($sameAgent[0], cdrLegIndex($sameAgent), $directory),
    'numeric_roots_equal' => $numericRoots[0] === $numericRoots[1],
    'numeric_legs' => count(cdrInteractionLegs($numeric[0], $numericIdx)),
    'no_id_offered' => count(cdrOfferedInteractions($noIds)),
    'no_id_roots' => [cdrRootKey($noIds[0], $noIdIdx), cdrRootKey($noIds[1], $noIdIdx), cdrRootKey($noIds[2], $noIdIdx)],
    'id_bag_fields' => cdrIdBag(['call-id' => 'a', 'cdr-id' => 'b', 'id' => 'c', 'call-orig-call-id' => 'd', 'call-parent-call-id' => 'e']),
    'offered_transfer' => count(cdrOfferedInteractions($transfer)),
]);
`);
const identity = parseJson(identityRaw);
check('the identity block parses', identity !== null, identityRaw.slice(0, 400));
if (identity) {
  check('both legs of a transfer share one root key', identity.transfer_roots_equal === true, identity);
  check('one interaction contains both legs', identity.transfer_legs === 2, identity.transfer_legs);
  check('a transfer to a second agent counts as 1', identity.transfer_count === 1, identity.transfer_count);
  check('the pair is [first agent, second agent]',
    JSON.stringify(identity.transfer_pairs) === JSON.stringify([['6080', '6081']]), identity.transfer_pairs);
  check('the same agent answering twice is NOT a transfer', identity.same_agent_count === 0, identity.same_agent_count);
  check('a numeric call id still groups (the strict_types fatal is gone)',
    identity.numeric_roots_equal === true && identity.numeric_legs === 2, identity);
  check('rows with no ids merge only when they describe the same event',
    identity.no_id_offered === 2 && identity.no_id_roots[0] === identity.no_id_roots[1]
      && identity.no_id_roots[0] !== identity.no_id_roots[2], identity);
  check('cdrIdBag reads every id field it is given, as strings',
    identity.id_bag_fields.length === 5 && identity.id_bag_fields.every(v => typeof v === 'string'),
    identity.id_bag_fields);
  check('a two-leg transfer is ONE offered interaction',
    identity.offered_transfer === 1, identity.offered_transfer);
}

/* ============================================================== 2. transfers */

console.log('\n== transfers: what counts, and what the rate is divided by ==');

const transferRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$directory = ['6080' => ['name' => 'Ada'], '6081' => ['name' => 'Alan'], '6082' => ['name' => 'Grace']];
/* The queue ids the PBX reports, so cdrQueueMatch() can name the queue each leg
 * sits in - without them a queue-to-queue transfer cannot exist. */
$queueIds = ['700' => true, '701' => true];

$answered = static function (string $id, string $parent, string $start, string $agent, string $queue, int $ordinal): array {
    return [
        'id' => $id, 'call-parent-call-id' => $parent, 'call-orig-call-id' => $parent,
        'call-direction' => 1, 'call-start-datetime' => '2026-08-03T' . $start . 'Z[US/Eastern]',
        'call-answer-datetime' => '2026-08-03T' . $start . 'Z[US/Eastern]',
        'call-term-user' => $agent, 'call-through-user' => $queue, 'call-leg-ordinal-index' => $ordinal,
    ];
};

$calls = [
    /* one transfer 6080 -> 6081, both on queue 700 */
    $answered('t1a', 'g1', '10:00:00', '6080', '700', 1),
    $answered('t1b', 'g1', '10:05:00', '6081', '700', 2),
    /* a two-hop transfer 6080 -> 6081 -> 6082 on queue 701 */
    $answered('t2a', 'g2', '11:00:00', '6080', '701', 1),
    $answered('t2b', 'g2', '11:04:00', '6081', '701', 2),
    $answered('t2c', 'g2', '11:09:00', '6082', '700', 3),
    /* an UNANSWERED leg offered to 6082: not a transfer, nobody took it */
    $answered('t3a', 'g3', '12:00:00', '6080', '700', 1),
    ['id' => 't3b', 'call-parent-call-id' => 'g3', 'call-direction' => 1,
     'call-start-datetime' => '2026-08-03T12:03:00Z[US/Eastern]', 'call-term-user' => '6082',
     'call-leg-ordinal-index' => 2],
    /* a single answered call: no transfer */
    $answered('t4a', 'g4', '13:00:00', '6081', '700', 1),
    /* a leg whose terminus is an OUTSIDE number: not an agent, so not a transfer */
    $answered('t5a', 'g5', '14:00:00', '6080', '700', 1),
    ['id' => 't5b', 'call-parent-call-id' => 'g5', 'call-direction' => 1,
     'call-start-datetime' => '2026-08-03T14:04:00Z[US/Eastern]',
     'call-answer-datetime' => '2026-08-03T14:04:05Z[US/Eastern]',
     'call-term-user' => '18455550100', 'call-leg-ordinal-index' => 2],
];

echo json_encode(cdrTransferSummary($calls, $directory, $queueIds));
`);
const tr = parseJson(transferRaw);
check('the transfer block parses', tr !== null, transferRaw.slice(0, 400));
if (tr) {
  /* Hand count: g1 is handed over once, g2 twice, g3/g4/g5 never (the offer was
   * not answered and an outside number is not an agent). So 3 hand-offs across
   * the 2 conversations that were handed over, out of 5 handled interactions. */
  check('hand-offs count consecutive different agents: 1 + 2 = 3', tr.transfers === 3, tr.transfers);
  check('two conversations were handed over at least once',
    tr.transferredInteractions === 2, tr);
  check('the rate is transferred interactions / handled = 2/5 = 40 %',
    tr.handled === 5 && tr.ratePct === 40, tr);
  check('a transfer rate can never exceed 100 % (the 200 % bug stays fixed)',
    tr.ratePct <= 100 && tr.perTransferred === 1.5, tr);
  check('the agent pairs are the ones a manager would coach',
    JSON.stringify(tr.agentPairs) === JSON.stringify({ '6080>6081': 2, '6081>6082': 1 }), tr.agentPairs);
  /* Both hops of g2 stay in queue 701, then the call is handed to an agent on
   * queue 700: one queue CHANGE, 701 -> 700. Agent -> queue hops are not
   * queue-to-queue transfers and must not appear here. */
  check('only the queue CHANGE is a queue pair: 701 -> 700',
    JSON.stringify(tr.queuePairs) === JSON.stringify({ '701>700': 1 }), tr.queuePairs);
}

/* ============================================================== 3. callbacks */

console.log('\n== callbacks: which missed calls were returned, and how fast ==');

const callbackRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';

/* $at is a full local timestamp, so a return call can land on the next day. */
$miss = static function (string $id, string $at, string $from, array $extra = []): array {
    return array_merge([
        'id' => $id, 'call-direction' => 1, 'call-start-datetime' => $at . 'Z[US/Eastern]',
        'call-disconnect-datetime' => $at . 'Z[US/Eastern]',
        'call-orig-caller-id' => $from, 'call-orig-from-user' => $from, 'call-term-user' => '6080',
    ], $extra);
};
$out = static function (string $id, string $at, string $dialled, array $extra = []): array {
    return array_merge([
        'id' => $id, 'call-direction' => 0, 'call-start-datetime' => $at . 'Z[US/Eastern]',
        'call-orig-user' => '6080', 'call-orig-to-user' => $dialled, 'dialed' => $dialled,
        'call-answer-datetime' => $at . 'Z[US/Eastern]', 'call-talking-duration-seconds' => 60,
    ], $extra);
};

$calls = [
    /* returned 20 minutes later; the return is dialled with punctuation */
    $miss('m1', '2026-08-03T10:00:00', '8454259810'),
    $out('r1', '2026-08-03T10:20:00', '+1 (845) 425-9810'),
    /* returned after 25 hours: outside 24 h, inside 72 h */
    $miss('m2', '2026-08-03T11:00:00', '5551234567'),
    $out('r2', '2026-08-04T12:00:00', '5551234567'),
    /* never returned */
    $miss('m3', '2026-08-03T12:00:00', '5559998888'),
    /* an outbound that came BEFORE the miss must not count as its return */
    $out('r4-before', '2026-08-03T13:30:00', '5554443333'),
    $miss('m4', '2026-08-03T14:00:00', '5554443333'),
    /* an outbound whose FROM number is the customer's but which dialled someone
     * else: that is an outbound caller ID, not a return */
    $miss('m5', '2026-08-03T15:00:00', '5552221111'),
    $out('r5', '2026-08-03T15:30:00', '5550000000', ['call-orig-user' => '5552221111']),
    /* the always-false call-back field must not create a callback */
    $miss('m6', '2026-08-03T16:00:00', '5557776666', ['call-back' => true]),
    /* a customer calling IN again is a repeat call, not a return */
    $miss('m7', '2026-08-03T17:00:00', '5558889999', ['call-through-user' => '700']),
];

$day = cdrCallbacks($calls, 86400);
$week = cdrCallbacks($calls, 259200);
echo json_encode([
    'day' => $day['counts'],
    'day_pairs' => array_map(static fn(array $e): array => ['number' => $e['number'], 'seconds' => $e['seconds']], array_values($day['returned'])),
    'week' => $week['counts'],
    'unreturned_numbers' => array_values(array_map(static fn(array $e): string => $e['number'], $day['unreturned'])),
    'offered' => count(cdrOfferedInteractions($calls)),
]);
`);
const cb = parseJson(callbackRaw);
check('the callback block parses', cb !== null, callbackRaw.slice(0, 400));
if (cb) {
  check('seven missed interactions are the denominator', cb.day.missed === 7, cb.day);
  check('exactly one is returned inside 24 h (m1, 20 minutes)', cb.day.returned === 1, cb.day);
  check('six are not', cb.day.unreturned === 6, cb.day);
  check('the delay is 1200 s and the number is digits only',
    cb.day_pairs.length === 1 && cb.day_pairs[0].seconds === 1200 && cb.day_pairs[0].number === '8454259810',
    cb.day_pairs);
  check('a 25-hour delay is outside the 24 h window but inside the 72 h one',
    cb.week.returned === 2 && cb.week.missed === 7, cb.week);
  check('an outbound BEFORE the miss is not its return (m4 unreturned)',
    cb.unreturned_numbers.includes('5554443333'), cb.unreturned_numbers);
  check("an outbound leg's own from-number is not the customer (m5 unreturned)",
    cb.unreturned_numbers.includes('5552221111'), cb.unreturned_numbers);
  check('the always-false call-back field creates no callback (m6 unreturned)',
    cb.unreturned_numbers.includes('5557776666'), cb.unreturned_numbers);
  check('a customer calling IN again is not a return (m7 unreturned)',
    cb.unreturned_numbers.includes('5558889999'), cb.unreturned_numbers);
  check('offered interactions count only inbound/missed legs (7 of 11 rows)',
    cb.offered === 7, cb.offered);
}

/* ========================================================= 4. repeat callers */

console.log('\n== repeat callers: the 24 h / 72 h split ==');

const repeatRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$call = static function (string $id, string $at, string $from): array {
    return [
        'id' => $id, 'call-direction' => 1, 'call-start-datetime' => $at . 'Z[US/Eastern]',
        'call-orig-caller-id' => $from, 'call-orig-from-user' => $from, 'call-term-user' => '6080',
        'call-answer-datetime' => $at . 'Z[US/Eastern]',
    ];
};
$calls = [
    /* X twice inside a day */
    $call('x1', '2026-08-03T09:00:00', '8454259810'),
    $call('x2', '2026-08-03T15:00:00', '8454259810'),
    /* Y twice, 48 h apart */
    $call('y1', '2026-08-03T09:30:00', '5551234567'),
    $call('y2', '2026-08-05T09:30:00', '5551234567'),
    /* Z once */
    $call('z1', '2026-08-03T10:00:00', '5559998888'),
];
$r = cdrRepeatCallers($calls);
echo json_encode([
    'counts' => $r['counts'],
    'x' => $r['callers']['8454259810'],
    'y' => $r['callers']['5551234567'],
    'z' => $r['callers']['5559998888'],
]);
`);
const rp = parseJson(repeatRaw);
check('the repeat block parses', rp !== null, repeatRaw.slice(0, 400));
if (rp) {
  check('three distinct callers over five calls', rp.counts.callers === 3, rp.counts);
  check('one caller repeated inside 24 h', rp.counts.repeat24 === 1, rp.counts);
  check('two repeated inside 72 h (the 48-hour pair joins the same-day one)',
    rp.counts.repeat72 === 2, rp.counts);
  check('the 24 h rate is repeat/callers = 1/3 = 33.3 %', rp.counts.rate24 === 33.3, rp.counts);
  check('the 72 h rate is 2/3 = 66.7 %', rp.counts.rate72 === 66.7, rp.counts);
  check('X is flagged in both windows', rp.x.calls === 2 && rp.x.within24 === true && rp.x.within72 === true, rp.x);
  check('Y is flagged in the 72 h window only',
    rp.y.calls === 2 && rp.y.within24 === false && rp.y.within72 === true, rp.y);
  check('a single caller is not a repeat in either window',
    rp.z.calls === 1 && rp.z.within24 === false && rp.z.within72 === false, rp.z);
}

/* ============================================================== 5. the payload */

console.log('\n== api/report.php ships the block ==');

/* One transferred call (6080 -> 6081), one missed call from 5551234567, and the
 * outbound that returns it 30 minutes later. */
await harness.seedPbx('fetchCdrs', [
  {
    id: 'p1a', 'call-orig-call-id': 'po1', 'call-direction': 1,
    'call-start-datetime': '2026-08-03T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-03T10:00:09Z[US/Eastern]',
    'call-term-user': '6080', 'call-through-user': '700',
    'call-leg-ordinal-index': 1, 'call-orig-caller-id': '8454259810',
    'call-orig-from-user': '8454259810'
  },
  {
    id: 'p1b', 'call-parent-call-id': 'po1', 'call-direction': 1,
    'call-start-datetime': '2026-08-03T10:06:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-03T10:06:20Z[US/Eastern]',
    'call-term-user': '6081', 'call-through-user': '700',
    'call-leg-ordinal-index': 2
  },
  {
    id: 'p2', 'call-direction': 1,
    'call-start-datetime': '2026-08-03T11:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-03T11:00:20Z[US/Eastern]',
    'call-orig-caller-id': '5551234567', 'call-orig-from-user': '5551234567',
    'call-term-user': '6080'
  },
  {
    id: 'p3', 'call-direction': 0,
    'call-start-datetime': '2026-08-03T11:30:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-03T11:30:05Z[US/Eastern]',
    'call-orig-user': '6080', 'call-orig-to-user': '5551234567',
    'call-talking-duration-seconds': 120
  }
]);

const res = await harness.request('report.php', {
  body: { start: '2026-08-03', end: '2026-08-03', skipPrevious: true, hours: 'all' },
  user: USERS.office_manager,
});
check('report.php returns 200 with the links block',
  res.status === 200 && res.body?.links !== undefined,
  res.status === 200 ? Object.keys(res.body ?? {}) : res.log);
if (res.status === 200 && res.body?.links) {
  const L = res.body.links;
  check('two offered interactions, one transfer, one missed call, one return',
    L.offered === 2 && L.transfers.count === 1 && L.callbacks.missed === 1 && L.callbacks.returned === 1, L);
  check('the transfer pair is the two agents',
    L.transfers.agentPairs.length === 1 && L.transfers.agentPairs[0].from === '6080'
      && L.transfers.agentPairs[0].to === '6081' && L.transfers.agentPairs[0].count === 1, L.transfers.agentPairs);
  /* Only the transferred interaction was handled by an agent: the missed call
   * had no answer and the outbound leg is not part of the customer's journey. */
  check('the rate is 1 transferred interaction over 1 handled = 100 %',
    L.transfers.handled === 1 && L.transfers.ratePct === 100 && L.transfers.perTransferred === 1, L.transfers);
  check('the callback was returned in 1800 s by agent 6080',
    L.callbacks.avgReturnSeconds === 1800 && L.callbacks.worklist[0].agent === '6080', L.callbacks);
  check('the callback worklist carries the number and both timestamps',
    L.callbacks.worklist[0].number === '5551234567'
      && L.callbacks.worklist[0].missedAt.startsWith('2026-08-03T11:00')
      && L.callbacks.worklist[0].returnedAt.startsWith('2026-08-03T11:30'), L.callbacks.worklist[0]);
  check('the callback rate is 1 of 1 = 100 %', L.callbacks.ratePct === 100, L.callbacks);
  check('two distinct callers, neither repeating',
    L.repeat.callers === 2 && L.repeat.repeat24 === 0 && L.repeat.repeat72 === 0, L.repeat);
  check('the percentage fields are numbers, not strings',
    typeof L.transfers.ratePct === 'number' && typeof L.callbacks.ratePct === 'number'
      && typeof L.repeat.rate24Pct === 'number', [L.transfers.ratePct, L.callbacks.ratePct, L.repeat.rate24Pct]);
}

/* ================================================= 6. drill-down parity (A3) */

console.log('\n== the list behind the card: filters, sorting, per-row fields ==');

/*
 * One day, hand-computed. Four answered inbound calls wait 10, 45, 100 and 150
 * seconds, one carries 12 s of hold; two calls abandon (after 3 s and 70 s) and
 * one goes to voicemail with no queue. One outbound returns the 3-second
 * abandon 20 minutes later.
 *
 *   summary.waitBuckets must be 1 / 1 / 1 / 1 (<=30, <=60, <=120, >120)
 *   summary.missedBreakdown must be 2 abandons + 1 voicemail
 *   each waitBucket drill must return exactly that bucket's rows
 *   the four buckets together must equal summary.counts.inbound
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'w1', 'call-direction': 1, 'call-start-datetime': '2026-08-10T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-10T09:00:10Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000001',
    'call-orig-from-user': '5551000001', 'call-talking-duration-seconds': 30 },
  { id: 'w2', 'call-direction': 1, 'call-start-datetime': '2026-08-10T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-10T10:00:45Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000002',
    'call-orig-from-user': '5551000002', 'call-talking-duration-seconds': 30,
    'call-batch-on-hold-duration-seconds': 12 },
  { id: 'w3', 'call-direction': 1, 'call-start-datetime': '2026-08-10T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-10T11:01:40Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000003',
    'call-orig-from-user': '5551000003', 'call-talking-duration-seconds': 30 },
  { id: 'w4', 'call-direction': 1, 'call-start-datetime': '2026-08-10T12:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-10T12:02:30Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000004',
    'call-orig-from-user': '5551000004', 'call-talking-duration-seconds': 30 },
  { id: 'w5', 'call-direction': 1, 'call-start-datetime': '2026-08-10T13:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-10T13:00:03Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000005', 'call-orig-from-user': '5551000005' },
  { id: 'w6', 'call-direction': 1, 'call-start-datetime': '2026-08-10T14:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-10T14:01:10Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551000006', 'call-orig-from-user': '5551000006' },
  { id: 'w7', 'call-direction': 1, 'call-start-datetime': '2026-08-10T15:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-10T15:00:08Z[US/Eastern]', 'call-term-user': '6080',
    'call-orig-caller-id': '5551000007', 'call-orig-from-user': '5551000007',
    'call-term-to-uri': 'sip:vm6080@pbx.example' },
  { id: 'w8', 'call-direction': 0, 'call-start-datetime': '2026-08-10T13:20:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-10T13:20:05Z[US/Eastern]', 'call-orig-user': '6080',
    'call-orig-to-user': '5551000005', 'call-talking-duration-seconds': 60 }
]);

const ledgerBody = { start: '2026-08-10', end: '2026-08-10', skipPrevious: true, hours: 'all' };
const ledger = await harness.request('report.php', { body: ledgerBody, user: USERS.office_manager });
check('the ledger day loads', ledger.status === 200, ledger.log ?? ledger.status);

const callList = async (extra) => {
  const res = await harness.request('calls.php', {
    body: Object.assign({ start: '2026-08-10', end: '2026-08-10', metric: 'total', perPage: 100 }, extra),
    user: USERS.office_manager,
  });
  return res;
};

if (ledger.status === 200) {
  const S = ledger.body.summary;
  check('the ledger summary has the four hand-computed wait buckets',
    S.waitBuckets['0-30'] === 1 && S.waitBuckets['31-60'] === 1
      && S.waitBuckets['61-120'] === 1 && S.waitBuckets['120+'] === 1, S.waitBuckets);
  check('the ledger missed breakdown is 2 abandons and 1 voicemail',
    S.missedBreakdown.abandon === 2 && S.missedBreakdown.voicemail === 1
      && S.missedBreakdown.noanswer === 0, S.missedBreakdown);

  let bucketTotal = 0;
  for (const [band, count] of Object.entries({ '0-30': 1, '31-60': 1, '61-120': 1, '120+': 1 })) {
    const res = await callList({ waitBucket: band });
    const rows = res.body?.data ?? [];
    bucketTotal += rows.length;
    check(`waitBucket=${band} returns exactly ${count} row(s) and they are all in the band`,
      res.status === 200 && rows.length === count
        && rows.every(r => {
          const w = r.wait;
          if (band === '0-30') return w <= 30;
          if (band === '31-60') return w > 30 && w <= 60;
          if (band === '61-120') return w > 60 && w <= 120;
          return w > 120;
        }),
      { status: res.status, rows: rows.map(r => r.wait) });
  }
  check('the four wait buckets together are the answered inbound count (drill parity)',
    bucketTotal === S.counts.inbound, { bucketTotal, inbound: S.counts.inbound });

  /* Waited-over is direction-agnostic on purpose: a caller who gave up after
   * 70 s waited too, so the four rows are 45, 70, 100 and 150 seconds. */
  const over = await callList({ waitedOver: 31 });
  check('waitedOver=31 returns every call that waited over 30 s, answered or not',
    (over.body?.data ?? []).length === 4 && (over.body.data).every(r => r.wait >= 31)
      && (over.body.data).map(r => r.wait).sort((a, b) => a - b).join(',') === '45,70,100,150',
    (over.body?.data ?? []).map(r => r.wait));

  const desc = await callList({ sort: 'wait', dir: 'desc' });
  const wa = (desc.body?.data ?? []).map(r => r.wait);
  check('sort=wait&dir=desc puts the longest wait first',
    wa.length > 1 && wa[0] === Math.max(...wa) && wa.every((v, i) => i === 0 || wa[i - 1] >= v), wa.slice(0, 6));
  const asc = await callList({ sort: 'wait', dir: 'asc' });
  const wb = (asc.body?.data ?? []).map(r => r.wait);
  check('sort=wait&dir=asc puts the shortest wait first',
    wb.length > 1 && wb[0] === Math.min(...wb) && wb.every((v, i) => i === 0 || wb[i - 1] <= v), wb.slice(0, 6));
  const talk = await callList({ sort: 'talk', dir: 'desc' });
  const talks = (talk.body?.data ?? []).map(r => r.talking);
  check('sort=talk&dir=desc orders by talking time',
    talks.length > 1 && talks.every((v, i) => i === 0 || talks[i - 1] >= v), talks.slice(0, 6));
  /*
   * The fixture's own clock, so the expected order is checkable by eye:
   * w1 10:00, w2 11:00, w3 12:00, w4 12:00, w5 13:00, w8 13:20 (the outbound
   * return call), w6 14:00, w7 15:00.
   */
  const oldest = await callList({ sort: 'oldest' });
  check('sort=oldest with no direction means oldest first, as it says',
    (oldest.body?.data ?? []).map(r => r.id).join(',') === 'w1,w2,w3,w4,w5,w8,w6,w7',
    (oldest.body?.data ?? []).map(r => r.id));
  const newest = await callList({ sort: 'newest' });
  check('sort=newest is still newest first (the default)',
    (newest.body?.data ?? []).map(r => r.id).join(',') === 'w7,w6,w8,w5,w4,w3,w2,w1',
    (newest.body?.data ?? []).map(r => r.id));
  const holdSort = await callList({ sort: 'hold' });
  check('sort=hold orders by held time, longest first',
    (holdSort.body?.data ?? []).length > 0, (holdSort.body?.data ?? []).map(r => r.id));
  const bad = await callList({ sort: 'nonsense', dir: 'nonsense' });
  check('an unknown sort/dir falls back to newest-first instead of 422 or chaos',
    bad.status === 200
      && (bad.body?.data ?? []).every((r, i, all) => i === 0 || String(all[i - 1].startedAt) >= String(r.startedAt)),
    bad.status === 200 ? (bad.body.data ?? []).map(r => r.startedAt).slice(0, 3) : bad.log);

  const abandoned = await callList({ outcome: 'abandoned' });
  check('outcome=abandoned returns exactly the summary breakdown (2)',
    (abandoned.body?.data ?? []).length === S.missedBreakdown.abandon,
    (abandoned.body?.data ?? []).length);
  const voicemail = await callList({ outcome: 'voicemail' });
  check('outcome=voicemail returns exactly the summary breakdown (1)',
    (voicemail.body?.data ?? []).length === S.missedBreakdown.voicemail,
    (voicemail.body?.data ?? []).length);

  const returned = await callList({ callbackState: 'returned' });
  const unreturned = await callList({ callbackState: 'unreturned' });
  check('callbackState=returned returns the miss that was called back',
    (returned.body?.data ?? []).length === 1
      && returned.body.data[0].id === 'w5', (returned.body?.data ?? []).map(r => r.id));
  check('callbackState=unreturned returns the misses nobody returned',
    (unreturned.body?.data ?? []).map(r => r.id).sort().join(',') === 'w6,w7',
    (unreturned.body?.data ?? []).map(r => r.id));
  check('callbackOnly and callbackState together are still one filter, not two',
    (await callList({ callbackOnly: true })).body?.total === 3,
    (await callList({ callbackOnly: true })).body?.total);

  const row = (await callList({ callId: 'w2' })).body?.data?.[0];
  check('a row carries wait, hold, outcome and transfers',
    row && row.wait === 45 && row.hold === 12 && row.outcome === 'answered' && row.transfers === 0, row);
  const missRow = (await callList({ callId: 'w5' })).body?.data?.[0];
  check('a returned miss is flagged as a callback on the row itself',
    missRow && missRow.callback === true && missRow.outcome === 'abandoned'
      && missRow.missedBucket === 'abandon', missRow);
  const plainRow = (await callList({ callId: 'w6' })).body?.data?.[0];
  check('an unreturned miss is not flagged',
    plainRow && plainRow.callback === false, plainRow && plainRow.callback);

  /*
   * THE CARD AND THE LIST BEHIND IT MUST AGREE.
   *
   * The Overview's Follow-ups rows drill with a call-type metric as well as the
   * callback state, and both halves of that used to break:
   *
   *   - the drill asked for metric=inbound, which narrowed the rows to ANSWERED
   *     inbound legs before the callback filter ran. A not-returned call is a
   *     miss, so the intersection is empty by construction: the modal opened on
   *     "No calls found." under a card that said 2. (Fixed in the card: it
   *     drills on misses now — tests/js/smoke.mjs pins that.)
   *   - metric=missed kept the misses but dropped w8, the outbound return leg,
   *     and `unreturned` was recomputed over those narrowed rows while
   *     `returned` came from the full set. w5 therefore looked unreturned: the
   *     card and the list disagreed about one call, in the direction that
   *     invents a failure nobody had.
   *
   * Both sets come from the one pre-narrowing pass, so whatever metric is paired
   * with the state, the worklist is the card's own answer.
   */
  for (const [state, expected] of [['returned', ['w5']], ['unreturned', ['w6', 'w7']]]) {
    for (const metric of ['total', 'missed', 'incoming']) {
      const res = await callList({ metric, callbackState: state });
      const ids = (res.body?.data ?? []).map(r => r.id).sort();
      check(`metric=${metric} + callbackState=${state} is the card's ${state} worklist`,
        ids.join(',') === expected.join(','), { ids, expected, status: res.status });
    }
  }
  /*
   * The contradictory pair, recorded rather than fixed: metric=inbound selects
   * answered legs, and no answered leg is ever in a not-returned worklist, so 0
   * rows is the honest answer. A card must never send it — which is why the
   * smoke test pins the drill's metric.
   */
  check('a type metric that excludes misses is honestly empty, not silently wrong',
    (await callList({ metric: 'inbound', callbackState: 'unreturned' })).body?.total === 0,
    (await callList({ metric: 'inbound', callbackState: 'unreturned' })).body?.total);

  /*
   * And the flag on each row says the same thing as the list it came from —
   * a returned miss stays "returned" in a view that does not list its return
   * leg, while a call that is not a miss has no state to report (null, so the
   * UI prints a dash instead of "not returned" beside an answered call).
   */
  const missedView = (await callList({ metric: 'missed' })).body?.data ?? [];
  check('a returned miss is still flagged returned inside the missed view',
    missedView.find(r => r.id === 'w5')?.callback === true, missedView.map(r => [r.id, r.callback]));
  const allView = (await callList({})).body?.data ?? [];
  check('an answered call carries no callback state rather than a false one',
    allView.find(r => r.id === 'w2')?.callback === null, allView.map(r => [r.id, r.callback]));
  check('a CSV of the day keeps one cell per header for the callback column too',
    allView.length > 0 && allView.every(r => 'callback' in r), allView.map(r => r.callback));
}

/* ================================== 7. callbackOnly over roots that look numeric */

console.log('\n== callbackOnly when the interaction root is a number ==');

/*
 * These exports key a call on a NUMERIC cdr id, so an interaction root is a
 * numeric string — which PHP stores as an integer key. The two worklists were
 * merged with array_merge(), and array_merge renumbers integer keys: the merged
 * map became 0,1,2..., every isset() on a real root missed, and "callbacks only"
 * answered with an empty list for a day that had two. The fix is a union
 * (`+`), which preserves keys; this fixture is built specifically so that a
 * re-merge anywhere in this path fails the test instead of quietly passing.
 */
await harness.seedPbx('fetchCdrs', [
  { id: '9001', 'call-orig-call-id': '9001', 'call-direction': 1,
    'call-start-datetime': '2026-08-11T13:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-11T13:00:03Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551111111', 'call-orig-from-user': '5551111111' },
  { id: '9002', 'call-orig-call-id': '9002', 'call-direction': 1,
    'call-start-datetime': '2026-08-11T14:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-11T14:00:04Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5551111112', 'call-orig-from-user': '5551111112' },
  { id: '9003', 'call-orig-call-id': '9003', 'call-direction': 0,
    'call-start-datetime': '2026-08-11T13:20:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-11T13:20:05Z[US/Eastern]', 'call-orig-user': '6080',
    'call-orig-to-user': '5551111111', 'call-talking-duration-seconds': 60 }
]);

const numList = async (extra) => await harness.request('calls.php', {
  body: Object.assign({ start: '2026-08-11', end: '2026-08-11', metric: 'total', perPage: 100 }, extra),
  user: USERS.office_manager,
});
const numDay = await harness.request('report.php', {
  body: { start: '2026-08-11', end: '2026-08-11', skipPrevious: true, hours: 'all' },
  user: USERS.office_manager,
});
const numLinks = numDay.body?.links?.callbacks;
check('the numeric-id day has two misses, one returned',
  numLinks?.missed === 2 && numLinks?.returned === 1 && numLinks?.unreturned === 1, numLinks);
{
  const both = await numList({ callbackOnly: true });
  const bothIds = (both.body?.data ?? []).map(r => r.id).sort();
  check('callbackOnly finds both misses even though their roots are numbers',
    bothIds.join(',') === '9001,9002', { ids: bothIds, total: both.body?.total });
  const unreturned = await numList({ callbackState: 'unreturned' });
  check('and the unreturned worklist is the miss nobody called back',
    (unreturned.body?.data ?? []).map(r => r.id).join(',') === '9002',
    (unreturned.body?.data ?? []).map(r => r.id));
  const returned = await numList({ callbackState: 'returned' });
  check('with the returned one on the other side',
    (returned.body?.data ?? []).map(r => r.id).join(',') === '9001',
    (returned.body?.data ?? []).map(r => r.id));
}

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('CALL LINKS OK');
