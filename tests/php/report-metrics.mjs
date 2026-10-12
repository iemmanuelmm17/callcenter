/**
 * Sprint A, part 1 — the numbers a manager is allowed to quote.
 *
 * The manager review asked for four things that did not exist: opening hours,
 * a wait-time split for abandons, hold time, and per-queue service targets.
 * Each one changes a published figure, so each one is checked here against a
 * hand-computed answer rather than against the code that produced it:
 *
 *   1. the calendar — clock normalisation, the seven-day grid surviving a
 *      partial stored file, open-inclusive/close-exclusive boundaries, closed
 *      weekdays, holidays, a shift that crosses midnight, and one guard
 *      against a save that would silence every figure (enabled + nothing open);
 *
 *   2. ringSeconds() on split legs — the case that used to publish a
 *      zero-second wait for a call that waited, plus proof that the ordinary
 *      single-leg value is untouched;
 *
 *   3. summary() — wait buckets, abandon buckets, hold totals and per-queue
 *      targets, all recomputed by hand from a fixture whose arithmetic is
 *      written out in the assertions;
 *
 *   4. end-to-end scoping — api/report.php with hours=all|business|after over a
 *      seed containing a 03:00 Saturday call and a 10:00 Monday call, where
 *      business + after must equal all, exactly, every time.
 *
 *   node tests/php/report-metrics.mjs
 */
import { PhpHarness, USERS } from './php.mjs';

const failures = [];
const show = value => (typeof value === 'object' && value !== null
  ? JSON.stringify(value)
  : String(value));
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : show(extra).slice(0, 700));
  }
};

const parseJson = (raw, open, close) => {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
};

const harness = new PhpHarness();
await harness.boot();

/* ============================================================== 1. calendar */

console.log('\n== opening hours: clock normalisation and the stored grid ==');

const calRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$clocks = [];
foreach (['8:5','08:05','8','0800',' 18:00 ','25:00','8:70','','nonsense','9:60'] as $v) {
    $clocks[$v === '' ? '(empty)' : $v] = normalizeClock($v);
}
/* A file written before some days existed still yields all seven. */
$partial = normalizeBusinessHours(['enabled' => true, 'days' => [1 => ['open' => '9:00', 'close' => '17:30']], 'holidays' => ['2026-12-25', 'not-a-date', '2026-12-25']]);
$defaults = defaultDomainSettings();
echo json_encode([
    'clocks' => $clocks,
    'partialDays' => array_keys($partial['days']),
    'partialMonday' => $partial['days'][1],
    'partialSundayClosed' => $partial['days'][7]['closed'],
    'holidays' => $partial['holidays'],
    'enabledByDefault' => $defaults['businessHours']['enabled'],
    'queueSlaByDefault' => $defaults['queueSla'],
    'rosterByDefault' => $defaults['roster'],
    'defaultMonday' => $defaults['businessHours']['days'][1],
    'defaultSaturdayClosed' => $defaults['businessHours']['days'][6]['closed'],
]);
`);
const cal = parseJson(calRaw, '{', '}');
check('the block parses', cal !== null, calRaw.slice(0, 400));

if (cal) {
  check("'8:5' normalises to 08:05", cal.clocks['8:5'] === '08:05', cal.clocks['8:5']);
  check("'08:05' is left alone", cal.clocks['08:05'] === '08:05', cal.clocks['08:05']);
  check("'8' normalises to 08:00", cal.clocks['8'] === '08:00', cal.clocks['8']);
  check("'0800' normalises to 08:00", cal.clocks['0800'] === '08:00', cal.clocks['0800']);
  check("' 18:00 ' trims", cal.clocks[' 18:00 '] === '18:00', cal.clocks[' 18:00 ']);
  check("'25:00' is rejected as empty", cal.clocks['25:00'] === '', cal.clocks['25:00']);
  check("'8:70' is rejected as empty", cal.clocks['8:70'] === '', cal.clocks['8:70']);
  check('empty stays empty', cal.clocks['(empty)'] === '', cal.clocks['(empty)']);
  check("'9:60' is rejected as empty", cal.clocks['9:60'] === '', cal.clocks['9:60']);
  check('a partial file still has all seven days',
    JSON.stringify(cal.partialDays) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), cal.partialDays);
  check('the stored Monday is kept and padded to 08:00/17:30',
    cal.partialMonday.open === '09:00' && cal.partialMonday.close === '17:30', cal.partialMonday);
  check('days absent from the file fall back to closed-on-weekend',
    cal.partialSundayClosed === true, cal.partialSundayClosed);
  check('holidays are de-duplicated and validated',
    JSON.stringify(cal.holidays) === JSON.stringify(['2026-12-25']), cal.holidays);
  check('opening hours are OFF on a fresh install (they would rewrite every number)',
    cal.enabledByDefault === false, cal.enabledByDefault);
  check('queue SLA starts as an empty map (domain default applies)',
    JSON.stringify(cal.queueSlaByDefault) === '[]', cal.queueSlaByDefault);
  check('the roster starts empty', JSON.stringify(cal.rosterByDefault) === '[]', cal.rosterByDefault);
  check('the shipped grid is Mon-Fri 08:00-18:00 with Sat/Sun closed',
    cal.defaultMonday.open === '08:00' && cal.defaultMonday.close === '18:00'
      && cal.defaultSaturdayClosed === true, cal.defaultMonday);
}

console.log('\n== opening hours: which calls are inside them ==');

const withinRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
/*
 * Mon-Fri 08:00-18:00, closed Sat/Sun, with one holiday and one night desk
 * (22:00-06:00) used to prove the cross-midnight reading.
 */
$settings = ['businessHours' => normalizeBusinessHours([
    'enabled' => true,
    'days' => [
        1 => ['open' => '08:00', 'close' => '18:00'],
        2 => ['open' => '08:00', 'close' => '18:00'],
        3 => ['open' => '08:00', 'close' => '18:00'],
        4 => ['open' => '08:00', 'close' => '18:00'],
        5 => ['open' => '08:00', 'close' => '18:00'],
        6 => ['closed' => true],
        7 => ['closed' => true],
    ],
    'holidays' => ['2026-12-25'],
])];
$night = ['businessHours' => normalizeBusinessHours([
    'enabled' => true,
    'days' => [
        1 => ['open' => '22:00', 'close' => '06:00'],
        2 => ['open' => '22:00', 'close' => '06:00'],
        3 => ['open' => '22:00', 'close' => '06:00'],
        4 => ['open' => '22:00', 'close' => '06:00'],
        5 => ['open' => '22:00', 'close' => '06:00'],
        6 => ['closed' => true],
        7 => ['closed' => true],
    ],
    'holidays' => [],
])];
$case = static function (array $s, string $local) {
    return callWithinBusinessHours(['call-start-datetime' => '2026-01-01T00:00:00Z[US/Eastern]'], ['businessHours' => $s['businessHours']]) === null;
};
/* Uses the local wall clock of the timestamp: 2026-08-03 is a Monday. */
$at = static function (array $settings, string $local): bool {
    return callWithinBusinessHours(
        ['call-start-datetime' => $local . 'Z[US/Eastern]'],
        $settings
    );
};
$answers = [
    'mon_0959' => $at($settings, '2026-08-03T09:59:00'),
    'mon_open_boundary' => $at($settings, '2026-08-03T08:00:00'),
    'mon_close_boundary' => $at($settings, '2026-08-03T18:00:00'),
    'mon_1759' => $at($settings, '2026-08-03T17:59:59'),
    'mon_0300' => $at($settings, '2026-08-03T03:00:00'),
    'sat_1000' => $at($settings, '2026-08-08T10:00:00'),
    'sun_1000' => $at($settings, '2026-08-09T10:00:00'),
    'holiday_1000' => $at($settings, '2026-12-25T10:00:00'),
    'holiday_eve_1000' => $at($settings, '2026-12-24T10:00:00'),
    'no_timestamp' => callWithinBusinessHours([], $settings),
    'unparseable' => callWithinBusinessHours(['call-start-datetime' => 'not-a-date'], $settings),
    /* The same clock time on a Saturday, on a Friday and on a Thursday, which
     * pins the weekday mapping to the ISO numbering the grid uses. */
    'friday_0300' => $at($settings, '2026-08-07T03:00:00'),
    'saturday_0300' => $at($settings, '2026-08-08T03:00:00'),
    'night_mon_2300' => $at($night, '2026-08-03T23:00:00'),
    'night_tue_0300' => $at($night, '2026-08-04T03:00:00'),
    'night_tue_1200' => $at($night, '2026-08-04T12:00:00'),
    'night_mon_0600' => $at($night, '2026-08-03T06:00:00'),
    'disabled_is_everything' => callWithinBusinessHours(
        ['call-start-datetime' => '2026-08-08T03:00:00Z[US/Eastern]'],
        ['businessHours' => normalizeBusinessHours(['enabled' => false])]
    ),
    'configured_false_when_disabled' => businessHoursConfigured(['businessHours' => normalizeBusinessHours(['enabled' => false])]),
    'configured_true_when_enabled' => businessHoursConfigured($settings),
    'configured_false_when_all_closed' => businessHoursConfigured(['businessHours' => normalizeBusinessHours([
        'enabled' => true,
        'days' => [1 => ['closed' => true], 2 => ['closed' => true], 3 => ['closed' => true], 4 => ['closed' => true], 5 => ['closed' => true], 6 => ['closed' => true], 7 => ['closed' => true]],
    ])]),
];
echo json_encode($answers);
`);
const w = parseJson(withinRaw, '{', '}');
check('the within-hours block parses', w !== null, withinRaw.slice(0, 400));
if (w) {
  const expected = {
    mon_0959: true,
    mon_open_boundary: true,
    /* close is exclusive: a call that starts at 18:00:00 is after hours */
    mon_close_boundary: false,
    mon_1759: true,
    mon_0300: false,
    sat_1000: false,
    sun_1000: false,
    holiday_1000: false,
    holiday_eve_1000: true,
    /* a call with no usable timestamp is never hidden from a report */
    no_timestamp: true,
    unparseable: true,
    friday_0300: false,
    saturday_0300: false,
    /* 22:00-06:00 crosses midnight: 23:00 and 03:00 are inside, noon and
     * exactly 06:00 are not */
    night_mon_2300: true,
    night_tue_0300: true,
    night_tue_1200: false,
    night_mon_0600: false,
    disabled_is_everything: true,
    configured_false_when_disabled: false,
    configured_true_when_enabled: true,
    configured_false_when_all_closed: false,
  };
  for (const [name, want] of Object.entries(expected)) {
    check(`business hours: ${name} = ${want}`, w[name] === want, `got ${w[name]}`);
  }
}

console.log('\n== per-queue service targets: precedence ==');

const slaRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$settings = defaultDomainSettings();
$settings['slaSeconds'] = 30;
$settings['queueSla'] = ['700' => 15, 'sales' => 45, 'bad' => 0, 'huge' => 5000];
echo json_encode([
    /* the queue's own number wins */
    'by_id' => resolveQueueSlaSeconds($settings, '700'),
    /* extension, then name, are the fallbacks when no id match exists */
    'by_name' => resolveQueueSlaSeconds($settings, '', '', 'sales'),
    /* an unlisted queue gets the domain default */
    'unlisted' => resolveQueueSlaSeconds($settings, '701'),
    'null_queue' => resolveQueueSlaSeconds($settings, null),
    /* a nonsense stored value (0) is ignored rather than published */
    'zero_override_falls_back' => resolveQueueSlaSeconds($settings, 'bad'),
    /* and the same for one outside the 1..120 clamp */
    'huge_override_clamped' => resolveQueueSlaSeconds($settings, 'huge'),
    'no_map' => resolveQueueSlaSeconds(defaultDomainSettings(), '700'),
]);
`);
const sla = parseJson(slaRaw, '{', '}');
check('the per-queue SLA block parses', sla !== null, slaRaw.slice(0, 400));
if (sla) {
  check('a queue override beats the domain default (700 -> 15)', sla.by_id === 15, sla.by_id);
  check('a queue name can carry the override (sales -> 45)', sla.by_name === 45, sla.by_name);
  check('an unlisted queue uses the domain default (30)', sla.unlisted === 30, sla.unlisted);
  check('a call with no queue uses the domain default', sla.null_queue === 30, sla.null_queue);
  check('a zero override falls back instead of publishing 0s', sla.zero_override_falls_back === 30, sla.zero_override_falls_back);
  check('an override above 120 is clamped to 120', sla.huge_override_clamped === 120, sla.huge_override_clamped);
  check('with no map at all the default applies', sla.no_map === 20, sla.no_map);
}

/* ============================================================ 2. ring / wait */

console.log('\n== ringSeconds(): split legs, and the single-leg value untouched ==');

const ringRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$r = [];
/* Ordinary answered leg: ringing 10:00:00, answer 10:00:12 -> 12 s. */
$r['answered_same_leg'] = ringSeconds([
    'call-ringing-datetime' => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-answer-datetime'  => '2026-08-03T10:00:12Z[US/Eastern]',
]);
/* Durations are still trusted first: 60 total - 0 hold - 0 talk = 60 s. */
$r['from_total_duration'] = ringSeconds([
    'call-total-duration-seconds' => 60,
    'call-talking-duration-seconds' => 0,
]);
/* Batch leg wins over total: 120 - (20 hold + 40 talk) = 60 s. */
$r['from_batch_duration'] = ringSeconds([
    'call-batch-total-duration-seconds' => 120,
    'call-batch-on-hold-duration-seconds' => 20,
    'call-talking-duration-seconds' => 40,
]);
/*
 * The defect: this row's ringing belongs to a later leg than the answer (a
 * transfer / re-queue), so answer - ringing is negative. Old code clamped it to
 * 0 and published "answered instantly" for a call that waited 45 s.
 */
$r['split_legs_wait'] = ringSeconds([
    'call-start-datetime'    => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-answer-datetime'   => '2026-08-03T10:00:45Z[US/Eastern]',
    'call-ringing-datetime'  => '2026-08-03T10:00:50Z[US/Eastern]',
]);
/* No answer at all: the caller gave up after 33 s (start -> disconnect). */
$r['abandon_wait'] = ringSeconds([
    'call-start-datetime'      => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-disconnect-datetime' => '2026-08-03T10:00:33Z[US/Eastern]',
]);
/* Genuinely instant, and genuinely empty, must both stay 0. */
$r['zero_wait'] = ringSeconds([
    'call-ringing-datetime' => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-answer-datetime'  => '2026-08-03T10:00:00Z[US/Eastern]',
]);
$r['no_timestamps'] = ringSeconds([]);
$r['wait_is_ring'] = waitSeconds([
    'call-start-datetime'      => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-disconnect-datetime' => '2026-08-03T10:00:04Z[US/Eastern]',
]);
$r['hold_reads_batch_field'] = holdSeconds(['call-batch-on-hold-duration-seconds' => 37]);
$r['hold_absent'] = holdSeconds([]);
echo json_encode($r);
`);
const ring = parseJson(ringRaw, '{', '}');
check('the ring block parses', ring !== null, ringRaw.slice(0, 400));
if (ring) {
  check('single leg: ringing -> answer = 12 s', ring.answered_same_leg === 12, ring.answered_same_leg);
  check('duration arithmetic still wins (total 60 -> 60 s)', ring.from_total_duration === 60, ring.from_total_duration);
  check('batch arithmetic still wins (120 - 20 hold - 40 talk = 60 s)', ring.from_batch_duration === 60, ring.from_batch_duration);
  check('split legs: the wait is start -> answer = 45 s, not a published zero',
    ring.split_legs_wait === 45, ring.split_legs_wait);
  check('an abandoned call waits start -> disconnect = 33 s', ring.abandon_wait === 33, ring.abandon_wait);
  check('a genuine zero-second answer stays zero', ring.zero_wait === 0, ring.zero_wait);
  check('a row with no timestamps is 0, never a guess', ring.no_timestamps === 0, ring.no_timestamps);
  check('waitSeconds() is ringSeconds() (one definition)', ring.wait_is_ring === 4, ring.wait_is_ring);
  check('holdSeconds() reads the hold field', ring.hold_reads_batch_field === 37, ring.hold_reads_batch_field);
  check('holdSeconds() on a row without hold is 0', ring.hold_absent === 0, ring.hold_absent);
}

/* ================================================== 3. summary() arithmetic */

console.log('\n== summary(): wait buckets, abandon buckets, hold, per-queue target ==');

/*
 * Hand-computed fixture. All calls are inbound on Monday 2026-08-03 (a weekday)
 * unless stated; queues are 700 (target 15) and 701 (unlisted -> 30).
 *
 *   a1  10:00:00 -> 10:00:10  answered, queue 700, ring 10  -> in SLA (<=15)
 *   a2  10:05:00 -> 10:05:45  answered, queue 700, ring 45  -> OUT of SLA
 *   a3  10:10:00 -> 10:11:40  answered, queue 700, ring 100 -> OUT of SLA
 *   a4  10:15:00 -> 10:17:30  answered, queue 701, ring 150 -> OUT of SLA (30)
 *   a5  10:20:00 -> 10:20:20  answered, queue 701, ring 20  -> in SLA (<=30)
 *   a6  10:25:00 -> 10:27:05  answered, queue 701, ring 125 -> OUT of SLA
 *   m1  10:30:00 gave up at 10:30:03   -> abandon, waited 3 s   (<5)
 *   m2  10:35:00 gave up at 10:35:20   -> abandon, waited 20 s  (5-30)
 *   m3  10:40:00 gave up at 10:41:10   -> abandon, waited 70 s  (>30)
 *   m4  10:45:00 voicemail at 10:45:08 -> voicemail, waited 8 s
 *   m5  10:50:00 no answer -> wait 0   -> noanswer, <5 band
 *   o1  11:00:00 outbound, 0 hold
 *
 * Hold: a2 carries 12 s, a4 carries 8 s -> total 20 s, 2 calls, avg 10.
 * Answered rings = [10,45,100,150,20,125] -> sorted 10,20,45,100,125,150; n=6.
 *   p50: rank 0.5*(6-1) = 2.5 -> halfway between 45 and 100 -> 72.5 -> 73
 *   p90: rank 0.9*5      = 4.5 -> halfway between 125 and 150 -> 137.5 -> 138
 * (The interpolated percentile is the spreadsheet's; see support.php.)
 * Wait buckets (answered, by target-agnostic bands):
 *   <=30: a1, a5            = 2
 *   <=60: a2                = 1
 *   <=120: a3 (100)         = 1
 *   >120: a4 (150), a6 (125)= 2
 * Missed wait bands: <5 = m1,m5 = 2; 5-30 = m2,m4 = 2; >30 = m3 = 1.
 * Abandon-only bands: <5 = 1; 5-30 = 1; >30 = 1.
 * Per-queue SLA (settings map {700:15, 701:30}):
 *   in-SLA = a1 (10<=15), a5 (20<=30) = 2 of 6 = 33.3 %.
 * With no per-queue map and the stored default 30: a1,a5 in = 2 of 6 = 33.3 %
 *   -> for the assertion below the stored default is 15 instead, giving
 *      a1 (10<=15) and a2 (45>15), a5 (20>15): 1 of 6 = 16.7 %.
 * Hold: also verified that the outbound leg's hold counts (hold is a property
 * of the caller's experience, not of the direction).
 */
const summaryRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$D = '2026-08-03T';
$at = static fn(string $t): string => '2026-08-03T' . $t . 'Z[US/Eastern]';
$inbound = static function (string $id, string $start, string $end, string $queue) use ($at): array {
    return [
        'id' => $id,
        'call-direction' => 1,
        'call-start-datetime' => $at($start),
        'call-disconnect-datetime' => $at($end),
        'call-term-user' => '6080',
        'call-through-user' => $queue,
    ];
};
$answered = static function (string $id, string $start, string $answer, string $queue, int $hold = 0) use ($at): array {
    $row = [
        'id' => $id,
        'call-direction' => 1,
        'call-start-datetime' => $at($start),
        'call-answer-datetime' => $at($answer),
        'call-term-user' => '6080',
        'call-through-user' => $queue,
        'call-talking-duration-seconds' => 30,
    ];
    if ($hold > 0) $row['call-batch-on-hold-duration-seconds'] = $hold;
    return $row;
};
$calls = [
    $answered('a1', '10:00:00', '10:00:10', '700'),
    $answered('a2', '10:05:00', '10:05:45', '700', 12),
    $answered('a3', '10:10:00', '10:11:40', '700'),
    $answered('a4', '10:15:00', '10:17:30', '701', 8),
    $answered('a5', '10:20:00', '10:20:20', '701'),
    $answered('a6', '10:25:00', '10:27:05', '701'),
    $inbound('m1', '10:30:00', '10:30:03', '700'),
    $inbound('m2', '10:35:00', '10:35:20', '700'),
    $inbound('m3', '10:40:00', '10:41:10', '700'),
    /* A voicemail box on a line that never reached a queue: voicemail. A bare
     * no-answer with no queue either: noanswer. Neither is an abandon, or the
     * abandon split below would be measuring the wrong calls. */
    array_merge($inbound('m4', '10:45:00', '10:45:08', ''), ['call-term-to-uri' => 'sip:vm6080@pbx.example']),
    $inbound('m5', '10:50:00', '10:50:00', ''),
    [
        'id' => 'o1',
        'call-direction' => 0,
        'call-start-datetime' => $at('11:00:00'),
        'call-talking-duration-seconds' => 20,
        'call-batch-on-hold-duration-seconds' => 5,
        'call-orig-user' => '6081',
        'dialed' => '8454259810',
    ],
];
$directory = ['6080' => ['department' => 'Sales'], '6081' => ['department' => 'Sales']];
$queueIds = ['700' => true, '701' => true];

$settings = defaultDomainSettings();
$settings['slaSeconds'] = 30;
$settings['queueSla'] = ['700' => 15, '701' => 30];
$plain = summary($calls, 30, $directory, $queueIds);
$perQueue = summary($calls, 30, $directory, $queueIds, $settings);
$singleTarget = summary($calls, 15, $directory, $queueIds, defaultDomainSettings());
echo json_encode([
    'plain' => $plain,
    'perQueue' => $perQueue,
    'singleTarget' => $singleTarget,
    'sla_seconds' => resolveSlaSeconds(['slaSeconds' => 25], ['domain' => 'test.example']),
]);
`);
const sum = parseJson(summaryRaw, '{', '}');
check('the summary block parses', sum !== null, summaryRaw.slice(0, 500));

if (sum) {
  const p = sum.plain;
  const q = sum.perQueue;
  check('counts: 6 inbound, 5 missed, 1 outbound, 12 total',
    p.counts.inbound === 6 && p.counts.missed === 5 && p.counts.outbound === 1 && p.counts.total === 12,
    p.counts);
  check('missed breakdown: 3 abandons, 1 voicemail, 1 no-answer',
    p.missedBreakdown.abandon === 3 && p.missedBreakdown.voicemail === 1 && p.missedBreakdown.noanswer === 1,
    p.missedBreakdown);
  check('p50 ring = 73 s (median of 10,20,45,100,125,150 is 72.5)',
    p.serviceLevel.p50Ring === 73, p.serviceLevel.p50Ring);
  check('p90 ring = 138 s (rank 4.5 sits between 125 and 150)',
    p.serviceLevel.p90Ring === 138, p.serviceLevel.p90Ring);
  check('p50/p90 wait are the same numbers under the word a manager uses',
    p.serviceLevel.p50Wait === 73 && p.serviceLevel.p90Wait === 138, p.serviceLevel);
  check('wait buckets: <=30 s = 2, <=60 s = 1, <=120 s = 1, >120 s = 2',
    p.waitBuckets['0-30'] === 2 && p.waitBuckets['31-60'] === 1
      && p.waitBuckets['61-120'] === 1 && p.waitBuckets['120+'] === 2, p.waitBuckets);
  check('every answered call lands in exactly one wait bucket',
    Object.values(p.waitBuckets).reduce((a, b) => a + b, 0) === p.counts.inbound, p.waitBuckets);
  check('missed wait bands: <5 s = 2 (misdials), 5-30 s = 2, >30 s = 1',
    p.missedWaitBuckets.lt5 === 2 && p.missedWaitBuckets['5-30'] === 2 && p.missedWaitBuckets.gt30 === 1,
    p.missedWaitBuckets);
  check('abandon-only wait bands: 1 / 1 / 1 — the staffing-failure split',
    p.abandonWaitBuckets.lt5 === 1 && p.abandonWaitBuckets['5-30'] === 1 && p.abandonWaitBuckets.gt30 === 1,
    p.abandonWaitBuckets);
  check('every missed call lands in exactly one band',
    Object.values(p.missedWaitBuckets).reduce((a, b) => a + b, 0) === p.counts.missed, p.missedWaitBuckets);
  check('abandon bands never exceed the missed bands',
    p.abandonWaitBuckets.lt5 <= p.missedWaitBuckets.lt5
      && p.abandonWaitBuckets['5-30'] <= p.missedWaitBuckets['5-30']
      && p.abandonWaitBuckets.gt30 <= p.missedWaitBuckets.gt30, [p.abandonWaitBuckets, p.missedWaitBuckets]);
  check('hold: 20 s over 2 calls, average 10 s (the outbound 5 s is counted too)',
    p.hold.totalSeconds === 25 && p.hold.calls === 3 && p.hold.avgSeconds === 8,
    p.hold);
  check('without a per-queue map the report target is used: 2 of 6 in SLA (33.3 %)',
    p.serviceLevel.sla === 33.3 && p.serviceLevel.answeredInSla === 2, p.serviceLevel);
  check('a per-queue map is applied: 700->15, 701->30 = 2 of 6 (33.3 %)',
    q.serviceLevel.sla === 33.3 && q.serviceLevel.answeredInSla === 2, q.serviceLevel);
  check('the per-queue payload flags that targets were mixed',
    q.serviceLevel.perQueue === true && q.serviceLevel.targetsUsed === 2, q.serviceLevel);
  check('the mean target actually applied is 22.5 -> 23 s ((15*3 + 30*3)/6)',
    q.serviceLevel.avgTargetSeconds === 23, q.serviceLevel.avgTargetSeconds);
  check('the plain payload says one target was in play',
    p.serviceLevel.perQueue === false && p.serviceLevel.targetsUsed === 1, p.serviceLevel);
  check('one flat 15 s target leaves only a1 inside (1 of 6 = 16.7 %), and says so',
    sum.singleTarget.serviceLevel.sla === 16.7 && sum.singleTarget.serviceLevel.answeredInSla === 1
      && sum.singleTarget.serviceLevel.targetsUsed === 1, sum.singleTarget.serviceLevel);
  check('so a per-queue map with 701 at 30 s really does help 701 (2 of 6 vs 1 of 6)',
    q.serviceLevel.answeredInSla === 2 && sum.singleTarget.serviceLevel.answeredInSla === 1,
    [q.serviceLevel.answeredInSla, sum.singleTarget.serviceLevel.answeredInSla]);
  check('resolveSlaSeconds() still reads the request over the stored default',
    sum.sla_seconds === 25, sum.sla_seconds);

  /*
   * Pin the classifier's rule order, because it decides money: an unanswered
   * call that reached a queue is an ABANDON even when it ended in a mailbox
   * (the mailbox is the queue's overflow, and counting it as handled voicemail
   * would hide the failure). The outcome suite pins voicemail-without-a-queue;
   * this pins the queue-then-mailbox case so a future refactor cannot quietly
   * move those calls into the voicemail column.
   */
  const orderRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$row = [
    'call-direction' => 1,
    'call-start-datetime' => '2026-08-03T10:00:00Z[US/Eastern]',
    'call-term-user' => '6080',
    'call-through-user' => '700',
    'call-term-to-uri' => 'sip:vm6080@pbx.example',
];
echo json_encode([
    'with_queue' => callOutcome($row, ['6080' => ['department' => 'Sales']], ['700' => true]),
    'without_queue' => callOutcome($row, ['6080' => ['department' => 'Sales']], []),
]);
`);
  const order = parseJson(orderRaw, '{', '}');
  check('an unanswered call that reached a queue is an abandon even if it hit a mailbox',
    order?.with_queue === 'abandoned', order);
  check('the same call with no queue is voicemail', order?.without_queue === 'voicemail', order);
}

/* ================================================ 4. settings save guards */

console.log('\n== settings: a save can never silently silence the reports ==');

const saveRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$domain = 'metrics-save.example';
$file = domainSettingsFile($domain);
@unlink($file);

/* Save a calendar and a queue map. */
$saved = saveDomainSettings($domain, [
    'businessHours' => ['enabled' => true, 'days' => [
        1 => ['open' => '07:30', 'close' => '16:15'],
        2 => ['open' => '07:30', 'close' => '16:15'],
        3 => ['open' => '07:30', 'close' => '16:15'],
        4 => ['open' => '07:30', 'close' => '16:15'],
        5 => ['open' => '07:30', 'close' => '16:15'],
        6 => ['closed' => true],
        7 => ['closed' => true],
    ], 'holidays' => ['2026-07-04']],
    'queueSla' => ['700' => 12, '701' => '', '702' => 999, 'bad key with spaces' => 20],
    'roster' => [
        ['extension' => '6080', 'name' => 'A', 'team' => 'T1', 'supervisor' => 'S', 'days' => [1,2,3,4,5], 'start' => '9:00', 'end' => '17:30'],
        /* dropped: no shift */
        ['extension' => '6081', 'days' => [1], 'start' => '', 'end' => '17:00'],
        /* dropped: no day */
        ['extension' => '6082', 'days' => [], 'start' => '09:00', 'end' => '17:00'],
        /* dropped: no extension (nothing to join a CDR on) */
        ['name' => 'no extension', 'days' => [1], 'start' => '09:00', 'end' => '17:00'],
        /* dropped: zero-length shift */
        ['extension' => '6083', 'days' => [1], 'start' => '09:00', 'end' => '09:00'],
    ],
]);
$afterFirst = loadDomainSettings($domain);

/* A save that omits the calendar entirely must not wipe it. */
saveDomainSettings($domain, ['slaSeconds' => 25]);
$afterPartial = loadDomainSettings($domain);

/* A save that enables a calendar with every day closed is refused. */
$allClosed = [
    1 => ['closed' => true], 2 => ['closed' => true], 3 => ['closed' => true],
    4 => ['closed' => true], 5 => ['closed' => true], 6 => ['closed' => true], 7 => ['closed' => true],
];
$refused = saveDomainSettings($domain, ['businessHours' => ['enabled' => true, 'days' => $allClosed]]);
$afterRefusal = loadDomainSettings($domain);

/* Explicitly turning it off IS allowed. */
$off = saveDomainSettings($domain, ['businessHours' => ['enabled' => false, 'days' => $allClosed]]);

echo json_encode([
    'first' => $afterFirst,
    'partial' => $afterPartial,
    'refused' => $refused,
    'afterRefusal' => $afterRefusal,
    'off' => $off,
]);
`);
const save = parseJson(saveRaw, '{', '}');
check('the save block parses', save !== null, saveRaw.slice(0, 500));
if (save) {
  const f = save.first;
  check('the calendar round-trips with normalised clocks',
    f.businessHours.enabled === true && f.businessHours.days[1].open === '07:30'
      && f.businessHours.days[1].close === '16:15' && f.businessHours.days[6].closed === true,
    f.businessHours);
  check('the holiday list round-trips', JSON.stringify(f.businessHours.holidays) === JSON.stringify(['2026-07-04']),
    f.businessHours.holidays);
  check('queue SLA clamps at 120 and drops blank values',
    f.queueSla['700'] === 12 && !('701' in f.queueSla) && f.queueSla['702'] === 120, f.queueSla);
  check('a queue key with spaces is kept verbatim (the PBX may name it that way)',
    f.queueSla['bad key with spaces'] === 20, f.queueSla);
  check('roster rows without a shift, a day or an extension are dropped, the good one is kept',
    f.roster.length === 1 && f.roster[0].extension === '6080'
      && JSON.stringify(f.roster[0].days) === JSON.stringify([1, 2, 3, 4, 5])
      && f.roster[0].start === '09:00' && f.roster[0].end === '17:30', f.roster);
  check('a save that omits the calendar keeps it (the old clobber bug stays fixed)',
    save.partial.businessHours.enabled === true
      && save.partial.businessHours.days[1].open === '07:30'
      && JSON.stringify(save.partial.businessHours.holidays) === JSON.stringify(['2026-07-04']),
    save.partial.businessHours);
  check('a save that omits the queue map keeps it',
    save.partial.queueSla['700'] === 12, save.partial.queueSla);
  check('the partial save still applied its own change (slaSeconds 25)',
    save.partial.slaSeconds === 25, save.partial.slaSeconds);
  check('enabling a fully closed calendar is refused (it would zero every number)',
    save.refused.businessHours.enabled === false, save.refused.businessHours);
  check('the refusal keeps the times that were already stored',
    save.afterRefusal.businessHours.days[1].open === '07:30'
      && save.afterRefusal.businessHours.days[1].close === '16:15',
    save.afterRefusal.businessHours.days[1]);
  check('turning opening hours off explicitly is allowed',
    save.off.businessHours.enabled === false, save.off.businessHours);
}

/* ============================================ 5. end-to-end hours scoping */

console.log('\n== api/report.php: hours=all|business|after add up exactly ==');

const D = '2026-08-03';
const at = hhmm => `${D}T${hhmm}:00Z[US/Eastern]`;

/*
 * One weekday file. Queue 700. Monday 08:00-18:00 is open; the seed puts two
 * calls inside those hours (09:00, 17:00) and two outside (03:00, 20:00).
 */
const seed = [
  { id: 'k1', 'call-direction': 1, 'call-start-datetime': at('09:00'), 'call-answer-datetime': at('09:00:10'),
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 30,
    'call-batch-on-hold-duration-seconds': 9 },
  { id: 'k2', 'call-direction': 1, 'call-start-datetime': at('17:00'), 'call-answer-datetime': at('17:00:20'),
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 30 },
  { id: 'k3', 'call-direction': 1, 'call-start-datetime': at('03:00'), 'call-answer-datetime': at('03:00:45'),
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 30 },
  { id: 'k4', 'call-direction': 1, 'call-start-datetime': at('20:00'), 'call-answer-datetime': at('20:00:50'),
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 30 },
];

/* The harness PBX stub serves the CDR fetch from 'fetchCdrs' (php.mjs). */
await harness.seedPbx('fetchCdrs', seed);
/* Set the calendar through the real save path, for the manager's own domain. */
const saved = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
saveDomainSettings('test.example', [
    'businessHours' => ['enabled' => true, 'days' => [
        1 => ['open' => '08:00', 'close' => '18:00'],
        2 => ['open' => '08:00', 'close' => '18:00'],
        3 => ['open' => '08:00', 'close' => '18:00'],
        4 => ['open' => '08:00', 'close' => '18:00'],
        5 => ['open' => '08:00', 'close' => '18:00'],
        6 => ['closed' => true],
        7 => ['closed' => true],
    ]],
]);
$s = loadDomainSettings('test.example');
echo json_encode(['enabled' => $s['businessHours']['enabled']]);
`);
check('the calendar is saved for the reporting domain',
  parseJson(saved, '{', '}')?.enabled === true, saved.slice(0, 200));

const runReport = async (extra) => {
  const res = await harness.request('report.php', {
    body: Object.assign({ start: D, end: D, department: '', agents: [], skipPrevious: true }, extra),
    user: USERS.office_manager,
  });
  return res;
};

const all = await runReport({ hours: 'all' });
const business = await runReport({ hours: 'business' });
const after = await runReport({ hours: 'after' });
check('hours=all returns 200', all.status === 200, all.log ?? all.status);
check('hours=business returns 200', business.status === 200, business.log ?? business.status);
check('hours=after returns 200', after.status === 200, after.log ?? after.status);

if (all.status === 200 && business.status === 200 && after.status === 200) {
  const A = all.body;
  const B = business.body;
  const C = after.body;
  check('all four calls are inbound', A.summary.counts.inbound === 4, A.summary.counts.inbound);
  check('business hours keep exactly the two calls inside 08:00-18:00',
    B.summary.counts.inbound === 2, B.summary.counts.inbound);
  check('the after-hours view keeps exactly the 03:00 and 20:00 calls',
    C.summary.counts.inbound === 2, C.summary.counts.inbound);
  check('business + after = all, exactly',
    B.summary.counts.inbound + C.summary.counts.inbound === A.summary.counts.inbound,
    [B.summary.counts.inbound, C.summary.counts.inbound, A.summary.counts.inbound]);
  check('the endpoint reports which scoping it applied',
    A.filters?.hours === 'all' && B.filters?.hours === 'business' && C.filters?.hours === 'after',
    [A.filters?.hours, B.filters?.hours, C.filters?.hours]);
  check('the SLA denominator follows the scope (no stale totals)',
    B.summary.serviceLevel.answered === B.summary.counts.inbound
      && C.summary.serviceLevel.answered === C.summary.counts.inbound, [B.summary.serviceLevel, C.summary.serviceLevel]);
  check('hold time is published (9 s on k1, 0 elsewhere)',
    A.summary.hold.totalSeconds === 9 && A.summary.hold.calls === 1, A.summary.hold);
  check('hold is scoped with the calls: k1 is inside hours',
    B.summary.hold.totalSeconds === 9 && C.summary.hold.totalSeconds === 0,
    [B.summary.hold, C.summary.hold]);
  check('wait buckets sum to the inbound count in every scope',
    Object.values(B.summary.waitBuckets).reduce((a, b) => a + b, 0) === B.summary.counts.inbound
      && Object.values(C.summary.waitBuckets).reduce((a, b) => a + b, 0) === C.summary.counts.inbound,
    [B.summary.waitBuckets, C.summary.waitBuckets]);
  check('the split is real: the 45 s and 50 s waits are in the after-hours view only',
    C.summary.waitBuckets['31-60'] === 2 && B.summary.waitBuckets['31-60'] === 0,
    [B.summary.waitBuckets, C.summary.waitBuckets]);
  /* Drill-down parity: the calls endpoint must agree with the summary. */
  const calls = await harness.request('calls.php', {
    body: { start: D, end: D, hours: 'business', page: 1, perPage: 50, metric: 'total' },
    user: USERS.office_manager,
  });
  const drilled = calls.body.data ?? calls.body.calls ?? calls.body.rows ?? [];
  check('the drill-down list agrees with the scoped summary (2 calls, same scope)',
    calls.status === 200 && drilled.length === 2 && calls.body.total === 2,
    calls.status === 200 ? { total: calls.body.total, rows: drilled.length } : calls.log);
}

/* ======================= 6. per-queue targets, ASA by interval, data quality */

console.log('\n== per-queue targets and ASA by interval ==');

/*
 * A fresh day (2026-08-17) so the day cache cannot serve an earlier fixture.
 *
 *   queue 700 (target 15 s): answered after 10 s (in), after 20 s (out), 1 abandon
 *   queue 701 (target 30 s): answered after 20 s (in), after 40 s (out)
 *
 * Hand count: 700 sla = 1/2 = 50 %, 701 sla = 1/2 = 50 %.
 * Mean target over the 5 matched rows = (15*3 + 30*2)/5 = 21 s.
 * Interval 09:00 (60-minute buckets) holds every one of them: 5 offered,
 * 4 answered, 1 abandoned, asa = (10+20+20+40)/4 = 22.5 -> 23 s.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'q1', 'call-direction': 1, 'call-start-datetime': '2026-08-17T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-17T09:00:10Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 30, 'call-orig-caller-id': '5552000001' },
  { id: 'q2', 'call-direction': 1, 'call-start-datetime': '2026-08-17T09:05:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-17T09:05:20Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 30, 'call-orig-caller-id': '5552000002' },
  { id: 'q3', 'call-direction': 1, 'call-start-datetime': '2026-08-17T09:10:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-17T09:11:00Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5552000003' },
  { id: 'q4', 'call-direction': 1, 'call-start-datetime': '2026-08-17T09:20:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-17T09:20:20Z[US/Eastern]', 'call-term-user': '6081',
    'call-through-user': '701', 'call-talking-duration-seconds': 30, 'call-orig-caller-id': '5552000004' },
  { id: 'q5', 'call-direction': 1, 'call-start-datetime': '2026-08-17T09:30:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-17T09:30:40Z[US/Eastern]', 'call-term-user': '6081',
    'call-through-user': '701', 'call-talking-duration-seconds': 30, 'call-orig-caller-id': '5552000005' }
]);
await harness.seedPbx('callqueues', [
  { callqueue: '700', description: 'Sales queue', site: 'HQ' },
  { callqueue: '701', description: 'Support queue', site: 'HQ' }
]);

const queued = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
saveDomainSettings('test.example', ['queueSla' => ['700' => 15, '701' => 30]]);
echo json_encode(loadDomainSettings('test.example')['queueSla']);
`);
check('the queue targets are stored', parseJson(queued, '{', '}')?.['700'] === 15, queued.slice(0, 200));

const queueRes = await harness.request('queue.php', {
  body: { start: '2026-08-17', end: '2026-08-17', intervalMinutes: 60 },
  user: USERS.office_manager,
});
check('queue.php returns 200', queueRes.status === 200, queueRes.log ?? queueRes.status);
if (queueRes.status === 200) {
  const Q = queueRes.body.data;
  const byId = Object.fromEntries((Q.queueStats ?? []).map(r => [r.callqueue, r]));
  check('each queue row carries the target it was measured against',
    byId['700']?.slaSeconds === 15 && byId['701']?.slaSeconds === 30,
    { 700: byId['700']?.slaSeconds, 701: byId['701']?.slaSeconds });
  check('queue 700 is judged against 15 s: 1 of 2 answered in SLA = 50 %',
    byId['700']?.sla === 50, byId['700']);
  check('queue 701 is judged against 30 s: 1 of 2 answered in SLA = 50 %',
    byId['701']?.sla === 50, byId['701']);
  check('the mean target actually applied is 21 s ((15*3 + 30*2)/5)',
    Q.kpis.avgTargetSeconds === 21, Q.kpis);
  check('the payload says per-queue targets are in play',
    Q.kpis.perQueueTargets === true && Q.kpis.slaSeconds === 20, Q.kpis);
  /* The 09:00 interval holds all five calls; asa = (10+20+20+40)/4 = 22.5 -> 23 */
  const nine = (Q.intervalSla ?? []).find(b => b.from === '09:00');
  check('ASA by interval: 09:00 holds 5 offered / 4 answered / 1 abandoned',
    nine && nine.offered === 5 && nine.answered === 4 && nine.abandoned === 1, nine);
  check('the interval ASA is 23 s and its SLA is 2 of 4 = 50 %',
    nine && nine.asa === 23 && nine.sla === 50, nine);
  check('24 hourly buckets are published for intervalMinutes=60',
    (Q.intervalSla ?? []).length === 24, (Q.intervalSla ?? []).length);
  check('the interval buckets add up to the queue total',
    (Q.intervalSla ?? []).reduce((a, b) => a + b.offered, 0) === Q.kpis.totalCalls,
    { offered: (Q.intervalSla ?? []).reduce((a, b) => a + b.offered, 0), total: Q.kpis.totalCalls });
}

const quarter = await harness.request('queue.php', {
  body: { start: '2026-08-17', end: '2026-08-17', intervalMinutes: 15 },
  user: USERS.office_manager,
});
check('intervalMinutes=15 produces 96 buckets',
  quarter.status === 200 && (quarter.body.data.intervalSla ?? []).length === 96,
  quarter.status === 200 ? (quarter.body.data.intervalSla ?? []).length : quarter.log);
check('an unsupported intervalMinutes falls back to hourly',
  await (async () => {
    const odd = await harness.request('queue.php', {
      body: { start: '2026-08-17', end: '2026-08-17', intervalMinutes: 7 },
      user: USERS.office_manager,
    });
    return odd.status === 200 && (odd.body.data.intervalSla ?? []).length === 24;
  })(), 'expected 24 buckets');

const cradleRes = await harness.request('cradle.php', {
  body: { start: '2026-08-17', end: '2026-08-17', queue: '700' },
  user: USERS.office_manager,
});
check('cradle.php applies the same per-queue target',
  cradleRes.status === 200 && cradleRes.body.data.kpis.sla === 50
    && cradleRes.body.data.kpis.perQueueTargets === true, cradleRes.status === 200 ? cradleRes.body.data.kpis : cradleRes.log);

console.log('\n== data quality: what the reader cannot see from the numbers ==');

const quality = await harness.request('report.php', {
  body: { start: '2026-08-17', end: '2026-08-17', skipPrevious: true },
  user: USERS.office_manager,
});
check('report.php ships cacheStatus and dataQuality',
  quality.status === 200 && quality.body.cacheStatus && quality.body.dataQuality, quality.status);
if (quality.status === 200) {
  const D = quality.body.dataQuality;
  check('one data-quality entry per requested day',
    Object.keys(D.days).length === 1 && D.days['2026-08-17'] !== undefined, Object.keys(D.days));
  check('a fully fetched day is marked complete with its record count',
    D.days['2026-08-17'].complete === true && D.days['2026-08-17'].records === 5, D.days['2026-08-17']);
  check('no incomplete or empty days are claimed', D.incompleteDays === 0 && D.emptyDays === 0, D);
  /*
   * A Monday-Friday calendar was saved earlier in this suite, so this request
   * with no explicit scope must default to `business` and say so in the
   * appendix - and, because all five calls sit at 09:xx, the numbers must be
   * identical to the unscoped view.
   */
  check('a configured calendar makes business hours the default scope, and the appendix says so',
    D.hours === 'business' && D.businessHoursConfigured === true, D);
  check('cacheStatus agrees the range is complete',
    quality.body.cacheStatus.complete === true && quality.body.cacheStatus.total === 1,
    quality.body.cacheStatus);
  const explicitAll = await harness.request('report.php', {
    body: { start: '2026-08-17', end: '2026-08-17', skipPrevious: true, hours: 'all' },
    user: USERS.office_manager,
  });
  check('asking for hours=all reports all, and finds the same calls (all are inside 08:00-18:00)',
    explicitAll.status === 200 && explicitAll.body.dataQuality.hours === 'all'
      && explicitAll.body.summary.counts.total === quality.body.summary.counts.total,
    explicitAll.status === 200
      ? { hours: explicitAll.body.dataQuality.hours, total: explicitAll.body.summary.counts.total, business: quality.body.summary.counts.total }
      : explicitAll.log);
  const explicitAfter = await harness.request('report.php', {
    body: { start: '2026-08-17', end: '2026-08-17', skipPrevious: true, hours: 'after' },
    user: USERS.office_manager,
  });
  check('hours=after on the same day finds nothing, and says so rather than erroring',
    explicitAfter.status === 200 && explicitAfter.body.summary.counts.total === 0
      && explicitAfter.body.dataQuality.hours === 'after',
    explicitAfter.status === 200 ? explicitAfter.body.summary.counts.total : explicitAfter.log);
}

/* ================================================= A6. hourly detail / AHT by hour */

console.log('\n== hourly detail: AHT by hour, and the numbers the grid adds up ==');

/*
 * A fresh day (2026-08-18, a Tuesday) with a deliberately shaped fixture: the
 * 08:00 hour holds two answered inbound calls and one miss; the 09:00 hour holds
 * ONE answered inbound call, one miss, one OUTBOUND call with 500 s of talk and
 * one ON-NET call with 900 s of talk.
 *
 * The outbound and on-net legs are there to fail loudly if AHT is ever computed
 * over "calls with talk time" instead of answered inbound calls: the hour would
 * read (60 + 500 + 900) ÷ 3 = 487 s instead of 60 s. AHT is the desk's answering
 * speed, so an outbound campaign's talk time must not enter it.
 *
 * Hand count, hour 8: calls 3, answered 2, missed 1, talk 300, aht 150.
 * Hand count, hour 9: calls 4, answered 1, missed 1, talk 60, aht 60.
 * Period: 7 calls, 3 inbound, 2 missed, 1 outbound, 1 on-net.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'h1', 'call-direction': 1, 'call-start-datetime': '2026-08-18T08:15:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-18T08:15:10Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 100, 'call-orig-caller-id': '5553000001' },
  { id: 'h2', 'call-direction': 1, 'call-start-datetime': '2026-08-18T08:30:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-18T08:30:15Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 200, 'call-orig-caller-id': '5553000002' },
  { id: 'h3', 'call-direction': 1, 'call-start-datetime': '2026-08-18T08:45:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-18T08:45:20Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-orig-caller-id': '5553000003' },
  { id: 'h4', 'call-direction': 1, 'call-start-datetime': '2026-08-18T09:10:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-18T09:10:05Z[US/Eastern]', 'call-term-user': '6081',
    'call-through-user': '701', 'call-talking-duration-seconds': 60, 'call-orig-caller-id': '5553000004' },
  { id: 'h5', 'call-direction': 0, 'call-start-datetime': '2026-08-18T09:20:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-18T09:20:05Z[US/Eastern]', 'call-orig-user': '6080',
    'call-orig-to-user': '5553000005', 'call-talking-duration-seconds': 500 },
  { id: 'h6', 'call-direction': 2, 'call-start-datetime': '2026-08-18T09:30:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-18T09:30:10Z[US/Eastern]', 'call-term-user': '6081',
    'call-through-user': '701', 'call-orig-caller-id': '5553000006' },
  { id: 'h7', 'call-direction': 3, 'call-start-datetime': '2026-08-18T09:40:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-18T09:40:05Z[US/Eastern]', 'call-term-user': '6081',
    'call-talking-duration-seconds': 900 }
]);

const hourly = await harness.request('report.php', {
  body: { start: '2026-08-18', end: '2026-08-18', skipPrevious: true, hours: 'all' },
  user: USERS.office_manager
});
const H = hourly.body?.summary || {};
const hourAt = n => (H.hourly || [])[n] || {};
check('the report publishes 24 hourly entries',
  Array.isArray(H.hourly) && H.hourly.length === 24, Array.isArray(H.hourly) ? H.hourly.length : H.hourly);
check('hour 08 counts the three calls that started in it',
  hourAt(8).calls === 3 && hourAt(8).answered === 2 && hourAt(8).missed === 1,
  hourAt(8));
check('hour 08 AHT is 300 s of inbound talk over 2 answered calls = 150 s',
  hourAt(8).talkSeconds === 300 && hourAt(8).aht === 150, hourAt(8));
check('hour 09 counts four calls but only the one answered inbound call in AHT',
  hourAt(9).calls === 4 && hourAt(9).answered === 1 && hourAt(9).missed === 1, hourAt(9));
check('OUTBOUND and ON-NET talk time stays out of AHT (60 s, not 487 s)',
  hourAt(9).talkSeconds === 60 && hourAt(9).aht === 60, hourAt(9));
check('the hour index agrees with the plain hours series the chart draws',
  (H.hours || [])[8] === 3 && (H.hours || [])[9] === 4, (H.hours || []).slice(6, 12));
check('the hourly entries add up to the period counts',
  (H.hourly || []).reduce((a, h) => a + h.calls, 0) === H.counts?.total
    && (H.hourly || []).reduce((a, h) => a + h.answered, 0) === H.counts?.inbound
    && (H.hourly || []).reduce((a, h) => a + h.missed, 0) === H.counts?.missed,
  [H.counts, (H.hourly || []).reduce((a, h) => a + h.calls, 0)]);
check('an hour nobody called is a zero row, not a missing one',
  hourAt(3).calls === 0 && hourAt(3).aht === 0 && hourAt(3).talkSeconds === 0, hourAt(3));
check('every answered hour has talk time behind its AHT',
  (H.hourly || []).every(h => h.answered === 0 || h.talkSeconds > 0 || h.aht === 0),
  (H.hourly || []).filter(h => h.answered > 0 && h.talkSeconds === 0));

/* ============================================ A7. comparison modes (review F3) */

console.log('\n== comparison modes: the date arithmetic, by hand ==');

/*
 * Every mode is a pure function of the range, so the ranges themselves are
 * checkable without any CDR at all. August 2026 has 31 days; September has 30.
 */
const modesRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$out = [];
$range = static fn(string $m): array => comparePeriodFilters(['start' => '2026-09-15', 'end' => '2026-09-15'], $m);
foreach (compareModes() as $m) {
    $c = $range($m);
    $out[$m] = ['start' => $c['start'], 'end' => $c['end'], 'days' => $c['days'], 'label' => $c['label']];
}
/* A month-long range, where "the same dates last month" is a real shift. */
$month = comparePeriodFilters(['start' => '2026-08-01', 'end' => '2026-08-31'], 'month');
$out['august_as_month'] = ['start' => $month['start'], 'end' => $month['end'], 'days' => $month['days']];
/* Month-end clamping, where PHP's own -1 month overflows. */
$out['mar31'] = shiftMonthsClamped('2026-03-31', -1);
$out['jan31'] = shiftMonthsClamped('2026-01-31', -1);
$out['feb29'] = shiftMonthsClamped('2028-02-29', -12);
$out['dec31'] = shiftMonthsClamped('2026-12-31', -1);
/* An unknown mode is the previous period, never an error. */
$out['unknown'] = comparePeriodFilters(['start' => '2026-09-15', 'end' => '2026-09-15'], 'nonsense')['mode'];
$out['blank'] = normalizeCompareMode('');
echo json_encode($out);
`);
const modes = parseJson(modesRaw, '{', '}');
check('the comparison modes block parses', modes !== null, modesRaw.slice(0, 300));
if (modes) {
  check('previous is the equal-length period immediately before',
    modes.previous.start === '2026-09-14' && modes.previous.end === '2026-09-14' && modes.previous.days === 1,
    modes.previous);
  check('and it says so: "previous 1 day" (singular, not "1 days")',
    modes.previous.label === 'previous 1 day', modes.previous.label);
  check('weekday is the same date a week earlier, so the weekday matches',
    modes.weekday.start === '2026-09-08' && modes.weekday.end === '2026-09-08'
      && modes.weekday.label === 'same weekday last week',
    modes.weekday);
  check('month is the same date a month earlier',
    modes.month.start === '2026-08-15' && modes.month.end === '2026-08-15', modes.month);
  check('mtd is the same point last month',
    modes.mtd.start === '2026-08-15' && modes.mtd.label === 'same point last month', modes.mtd);
  check('year is the same date a year earlier',
    modes.year.start === '2025-09-15' && modes.year.end === '2025-09-15', modes.year);
  check('a month-long range compares against the whole previous month (31 days)',
    modes.august_as_month.start === '2026-07-01' && modes.august_as_month.end === '2026-07-31'
      && modes.august_as_month.days === 31,
    modes.august_as_month);
  check('31 March minus one month is 28 February, not 3 March (PHP overflow)',
    modes.mar31 === '2026-02-28', modes.mar31);
  check('31 January minus one month is 31 December', modes.jan31 === '2025-12-31', modes.jan31);
  check('29 February minus a year lands on 28 February',
    modes.feb29 === '2027-02-28', modes.feb29);
  check('31 December minus one month is 30 November', modes.dec31 === '2026-11-30', modes.dec31);
  check('an unknown mode falls back to previous instead of erroring',
    modes.unknown === 'previous' && modes.blank === 'previous', [modes.unknown, modes.blank]);
}

console.log('\n== comparison modes: the endpoint fetches the range it named ==');

/*
 * 2026-09-15 carries 3 calls (2 answered, 1 missed); 2026-08-15 carries 2 (both
 * answered); 2026-09-14 and 2026-09-08 carry nothing. So each mode's comparison
 * count is a fingerprint of WHICH range was fetched - a mode that quietly fell
 * back to the previous day would read 0 instead of 2.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'm1', 'call-direction': 1, 'call-start-datetime': '2026-09-15T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-09-15T10:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'm2', 'call-direction': 1, 'call-start-datetime': '2026-09-15T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-09-15T11:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'm3', 'call-direction': 1, 'call-start-datetime': '2026-09-15T12:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-09-15T12:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'm4', 'call-direction': 1, 'call-start-datetime': '2026-08-15T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-15T10:00:05Z[US/Eastern]', 'call-term-user': '6081' },
  { id: 'm5', 'call-direction': 1, 'call-start-datetime': '2026-08-15T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-15T11:00:05Z[US/Eastern]', 'call-term-user': '6081' }
]);

const compareBody = { start: '2026-09-15', end: '2026-09-15', hours: 'all' };
const compareRequest = async (mode) => {
  const res = await harness.request('report.php', {
    body: Object.assign({}, compareBody, mode ? { compare: mode } : {}),
    user: USERS.office_manager
  });
  return res.body?.comparison || {};
};
const sameDay = await compareRequest('previous');
const sameWeekday = await compareRequest('weekday');
const sameMonth = await compareRequest('month');
const sameYear = await compareRequest('year');
const defaultMode = await compareRequest(null);

check('the current period is the three calls on the 15th',
  (await harness.request('report.php', { body: Object.assign({}, compareBody, { skipPrevious: true }), user: USERS.office_manager }))
    .body?.summary?.counts?.total === 3);
check('compare=previous looks at 2026-09-14, which is empty',
  sameDay.previous?.start === '2026-09-14' && sameDay.previous?.counts?.total === 0,
  [sameDay.previous?.start, sameDay.previous?.counts]);
check('compare=month looks at 2026-08-15 and finds its two calls',
  sameMonth.previous?.start === '2026-08-15' && sameMonth.previous?.counts?.total === 2
    && sameMonth.previous.counts.inbound === 2,
  [sameMonth.previous?.start, sameMonth.previous?.counts]);
check('compare=weekday looks at 2026-09-08, not at the previous day',
  sameWeekday.previous?.start === '2026-09-08' && sameWeekday.previous?.counts?.total === 0,
  [sameWeekday.previous?.start, sameWeekday.previous?.counts]);
check('compare=year looks at 2025-09-15 and finds nothing',
  sameYear.previous?.start === '2025-09-15' && sameYear.previous?.counts?.total === 0,
  [sameYear.previous?.start, sameYear.previous?.counts]);
check('every response states the baseline it used',
  sameMonth.mode === 'month' && sameMonth.label === 'same 1 day last month' && sameMonth.days === 1,
  [sameMonth.mode, sameMonth.label, sameMonth.days]);
check('omitting compare keeps the old behaviour (the day before)',
  defaultMode.mode === 'previous' && defaultMode.previous?.start === '2026-09-14',
  [defaultMode.mode, defaultMode.previous?.start]);
check('an unknown compare value also keeps the old behaviour',
  (await compareRequest('nonsense')).previous?.start === '2026-09-14');
check('the comparison carries the same breakdown as the period it compares to',
  sameMonth.previous?.missedBreakdown !== undefined && Array.isArray(sameMonth.previous?.hours)
    && sameMonth.previous.hours.length === 24,
  Object.keys(sameMonth.previous || {}));

/*
 * A day whose fetch stopped at the page cap is SHORT, and the whole point of
 * the appendix is to say so. This writes the partial day the way the fetcher
 * would and reads the flag back through the same helper the endpoint uses; the
 * wiring itself is asserted above.
 */
const partialRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$day = '2026-08-17';
cdrDayCacheWrite('test.example', $day, [['id' => 'only-one']], false, 250, true);
$meta = cdrDayCacheMeta('test.example', $day);
echo json_encode(['complete' => !empty($meta['complete']), 'records' => (int)($meta['records'] ?? 0), 'nextOffset' => (int)($meta['nextOffset'] ?? 0)]);
`);
const partial = parseJson(partialRaw, '{', '}');
check('a partial fetch is recorded as incomplete with its resume point',
  partial && partial.complete === false && partial.records === 1 && partial.nextOffset === 250, partial);

/* ============ 8. sentiment: the period block and the negative filter */

console.log('\n== sentiment for the period, and the negative-only scope ==');

/*
 * A fresh day (2026-08-24) with four scored calls and one unscored one:
 *
 *   s1  neg 70 / pos 10   -> negative (70 > 10)
 *   s2  neg 40 / pos 45   -> positive, NOT negative: the positive share leads,
 *                            where a "more than zero" rule would wrongly call
 *                            this a complaint
 *   s3  neg 20 / pos 60   -> positive
 *   s4  0/0/0             -> unscored: excluded from both scopes and from the
 *                            averages' base, which must stay 3
 *   s5  no fields at all  -> unscored
 *
 * Averages over the 3 scored calls: positive (10+45+60)/3 = 38.3,
 * neutral (20+35+20)/3 = 25.0, negative (70+40+20)/3 = 43.3.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 's1', 'call-direction': 1, 'call-start-datetime': '2026-08-24T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-24T09:00:05Z[US/Eastern]', 'call-term-user': '6080',
    'call-intelligence-percent-positive': 10, 'call-intelligence-percent-neutral': 20,
    'call-intelligence-percent-negative': 70, 'call-intelligence-topics-top': 'billing' },
  { id: 's2', 'call-direction': 1, 'call-start-datetime': '2026-08-24T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-24T10:00:05Z[US/Eastern]', 'call-term-user': '6080',
    'call-intelligence-percent-positive': 45, 'call-intelligence-percent-neutral': 35,
    'call-intelligence-percent-negative': 40 },
  { id: 's3', 'call-direction': 1, 'call-start-datetime': '2026-08-24T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-24T11:00:05Z[US/Eastern]', 'call-term-user': '6081',
    'call-intelligence-percent-positive': 60, 'call-intelligence-percent-neutral': 20,
    'call-intelligence-percent-negative': 20, 'call-intelligence-topics-top': 'billing' },
  { id: 's4', 'call-direction': 1, 'call-start-datetime': '2026-08-24T12:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-24T12:00:05Z[US/Eastern]', 'call-term-user': '6081',
    'call-intelligence-percent-positive': 0, 'call-intelligence-percent-neutral': 0,
    'call-intelligence-percent-negative': 0 },
  { id: 's5', 'call-direction': 1, 'call-start-datetime': '2026-08-24T13:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-24T13:00:05Z[US/Eastern]', 'call-term-user': '6081' }
]);

const sentDay = { start: '2026-08-24', end: '2026-08-24', hours: 'all', skipPrevious: true };
const sentAll = await harness.request('report.php', { body: sentDay, user: USERS.office_manager });
check('report.php answers for the sentiment day', sentAll.status === 200, sentAll.log ?? sentAll.status);
if (sentAll.status === 200) {
  const S = sentAll.body.summary.sentiment;
  check('the period carries its sentiment block with a base', S.scored === 3, S);
  check('the averages are over the calls that were scored, not all five',
    S.positive === 38.3 && S.neutral === 25 && S.negative === 43.3, S);
  check('the block counts the calls whose negative share leads', S.negativeCalls === 1, S.negativeCalls);
  check('topics are published with their counts', Array.isArray(S.topics)
    && S.topics[0]?.topic === 'billing' && S.topics[0]?.count === 2, S.topics);

  const sentNeg = await harness.request('report.php', {
    body: Object.assign({}, sentDay, { sentiment: 'negative' }),
    user: USERS.office_manager
  });
  check('sentiment=negative keeps exactly the one negative call',
    sentNeg.status === 200 && sentNeg.body.summary.counts.total === 1,
    sentNeg.status === 200 ? sentNeg.body.summary.counts : sentNeg.log);
  check('the response says which sentiment scope produced it',
    sentNeg.body?.appliedFilters?.sentiment === 'negative', sentNeg.body?.appliedFilters);
  check('the scope is applied to the same row set as everything else (counts and drill agree)',
    sentNeg.body.summary.counts.total === sentNeg.body.summary.sentiment.scored,
    [sentNeg.body.summary.counts.total, sentNeg.body.summary.sentiment.scored]);
  check('the unscored calls are in neither scope',
    sentAll.body.summary.counts.total === 5 && sentNeg.body.summary.counts.total === 1,
    [sentAll.body.summary.counts.total, sentNeg.body.summary.counts.total]);

  const sentPos = await harness.request('report.php', {
    body: Object.assign({}, sentDay, { sentiment: 'positive' }),
    user: USERS.office_manager
  });
  /*
   * Both scopes use the same rule with the sign flipped, so the two sets
   * PARTITION the scored calls: s2 (40 negative vs 45 positive) belongs to
   * positive only, s1 to negative only, s3 to positive. A tie would be in
   * neither, which is the honest answer for a 50/50 call.
   */
  check('sentiment=positive keeps the calls whose positive share leads (s2 and s3)',
    sentPos.status === 200 && sentPos.body.summary.counts.total === 2,
    sentPos.status === 200 ? sentPos.body.summary.counts : sentPos.log);
  check('the two scopes partition the scored calls (1 negative + 2 positive = 3 scored)',
    sentNeg.body.summary.counts.total + sentPos.body.summary.counts.total === sentAll.body.summary.sentiment.scored,
    [sentNeg.body.summary.counts.total, sentPos.body.summary.counts.total, sentAll.body.summary.sentiment.scored]);

  const sentBad = await harness.request('report.php', {
    body: Object.assign({}, sentDay, { sentiment: 'furious' }),
    user: USERS.office_manager
  });
  check('an unknown sentiment value scopes nothing rather than emptying the report',
    sentBad.status === 200 && sentBad.body.summary.counts.total === 5
      && sentBad.body.appliedFilters.sentiment === '',
    sentBad.status === 200 ? [sentBad.body.summary.counts.total, sentBad.body.appliedFilters] : sentBad.log);
}

/* ================= 9. weekday x hour heatmap (Sprint B) */

console.log('\n== the weekday x hour grid ==');

/*
 * 2026-08-20 is a Thursday and 2026-08-23 a Sunday, so one fixture proves both
 * the hour AND the day index. Hand count:
 *
 *   Thu 20 Aug  09:00  two answered  -> volume 2, answered 2, missed 0
 *   Thu 20 Aug  14:00  one missed    -> volume 1, answered 0, missed 1
 *   Sun 23 Aug  09:00  one missed    -> volume 1, answered 0, missed 1
 *   (an outbound leg is in the seed and must change nothing)
 *
 * Totals: volume 4, answered 2, missed 2. Row 4 (Thursday) must hold 3 and row
 * 0 (Sunday) 1 - a Monday-first grid would put them in rows 3 and 6.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'g1', 'call-direction': 1, 'call-start-datetime': '2026-08-20T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-20T09:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'g2', 'call-direction': 1, 'call-start-datetime': '2026-08-20T09:30:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-20T09:30:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'g3', 'call-direction': 1, 'call-start-datetime': '2026-08-20T14:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-20T14:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'g4', 'call-direction': 1, 'call-start-datetime': '2026-08-23T09:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-23T09:00:30Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'g5', 'call-direction': 0, 'call-start-datetime': '2026-08-20T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-20T11:00:10Z[US/Eastern]', 'call-orig-user': '6080', 'dialed': '8454259810' }
]);

const heatRes = await harness.request('report.php', {
  body: { start: '2026-08-20', end: '2026-08-23', hours: 'all', skipPrevious: true },
  user: USERS.office_manager
});
check('report.php answers for the heatmap range', heatRes.status === 200, heatRes.log ?? heatRes.status);
if (heatRes.status === 200) {
  const H = heatRes.body.summary.heatmap;
  check('the grid is seven rows of 24 hours', Array.isArray(H.volume) && H.volume.length === 7
    && H.volume.every(row => row.length === 24), H.volume && H.volume.map(r => r.length));
  check('Thursday 09:00 holds the two answered calls',
    H.volume[4][9] === 2 && H.answered[4][9] === 2 && H.missed[4][9] === 0,
    [H.volume[4][9], H.answered[4][9], H.missed[4][9]]);
  check('Thursday 14:00 holds the missed call', H.volume[4][14] === 1 && H.missed[4][14] === 1, H.volume[4][14]);
  check('Sunday 09:00 is in row 0, the calendar day, not a shifted list',
    H.volume[0][9] === 1 && H.missed[0][9] === 1, H.volume[0][9]);
  check('every cell of the grid is inbound or missed: 4 offered, 2 answered, 2 missed',
    H.total === 4 && H.answered.flat().reduce((a, b) => a + b, 0) === 2
      && H.missed.flat().reduce((a, b) => a + b, 0) === 2,
    [H.total, H.answered.flat().reduce((a, b) => a + b, 0), H.missed.flat().reduce((a, b) => a + b, 0)]);
  check('the outbound leg is not in the grid (volume is offered calls)',
    H.volume.flat().reduce((a, b) => a + b, 0) === 4, H.volume.flat().reduce((a, b) => a + b, 0));
  check('the grid total equals the dashboard offered count for the same range',
    H.total === heatRes.body.summary.counts.inbound + heatRes.body.summary.counts.missed,
    [H.total, heatRes.body.summary.counts.inbound, heatRes.body.summary.counts.missed]);
  check('the grid carries the day labels it is indexed by',
    Array.isArray(H.days) && H.days.length === 7 && H.days[0] === 'Sunday' && H.days[4] === 'Thursday', H.days);
  check('the grid says its own peak, so a cell colour has a scale',
    H.maxCell === 2, H.maxCell);
}

/* ============ 10. per-agent hold time and outbound contact rate (Sprint B) */

console.log('\n== hold time and contact rate, per agent ==');

/*
 * A fresh day (2026-08-19) so no earlier fixture can answer. The arithmetic is
 * small enough to state in full, and every figure below is the one a reader
 * would get by adding the rows up by hand:
 *
 *   6080 (Ada)   inbound answered a1 (hold 30) + a2 (hold 20)
 *                -> holdTotal 50 over 2 calls that used hold, holdAvg 25
 *                -> no outbound at all, so the contact rate has no denominator
 *   6081 (Alan)  inbound answered a3 (no hold)
 *                outbound o1 answered, o2 never answered, o3 no answer
 *                timestamp but 15 s of talking (a human answered)
 *                -> 3 attempts, 2 connected = 66.7 %
 *   6080 + 6081  the day's hold is 50 s over 2 calls (the dashboard summary's
 *                own line, so the per-agent rows add up to it)
 */
await harness.seedPbx('users', [
  { user: '6080', 'name-first-name': 'Ada', 'name-last-name': 'Lovelace', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6080@test.example' },
  { user: '6081', 'name-first-name': 'Alan', 'name-last-name': 'Turing', 'user-scope': 'User', department: 'Sales', site: 'HQ', 'login-username': '6081@test.example' }
]);
await harness.seedPbx('fetchCdrs', [
  { id: 'h1', 'call-direction': 1, 'call-start-datetime': '2026-08-19T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-19T10:00:05Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 60, 'call-batch-on-hold-duration-seconds': 30 },
  { id: 'h2', 'call-direction': 1, 'call-start-datetime': '2026-08-19T10:30:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-19T10:30:05Z[US/Eastern]', 'call-term-user': '6080',
    'call-through-user': '700', 'call-talking-duration-seconds': 40, 'call-batch-on-hold-duration-seconds': 20 },
  { id: 'h3', 'call-direction': 1, 'call-start-datetime': '2026-08-19T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-19T11:00:05Z[US/Eastern]', 'call-term-user': '6081',
    'call-through-user': '701', 'call-talking-duration-seconds': 30 },
  { id: 'h4', 'call-direction': 0, 'call-start-datetime': '2026-08-19T13:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-19T13:00:20Z[US/Eastern]', 'call-orig-user': '6081',
    'dialed': '8454259810', 'call-talking-duration-seconds': 40 },
  { id: 'h5', 'call-direction': 0, 'call-start-datetime': '2026-08-19T13:10:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-19T13:10:25Z[US/Eastern]', 'call-orig-user': '6081',
    'dialed': '8454259811' },
  { id: 'h6', 'call-direction': 0, 'call-start-datetime': '2026-08-19T13:20:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-19T13:20:30Z[US/Eastern]', 'call-orig-user': '6081',
    'dialed': '8454259812', 'call-talking-duration-seconds': 15 }
]);

const holdDay = { start: '2026-08-19', end: '2026-08-19', hours: 'all' };
const agentRes = await harness.request('agents.php', { body: holdDay, user: USERS.office_manager });
const agentRows = (agentRes.body?.data || []).reduce((acc, row) => Object.assign(acc, { [row.extension]: row }), {});
const ada = agentRows['6080'] || {};
const alan = agentRows['6081'] || {};
check('agents.php answers with both agents for the day',
  agentRes.status === 200 && !!agentRows['6080'] && !!agentRows['6081'],
  agentRes.status === 200 ? Object.keys(agentRows) : agentRes.log);

check('hold is summed for the agent that used it', ada.holdTotal === 50 && ada.holdCalls === 2, [ada.holdTotal, ada.holdCalls]);
check('the per-agent hold average is over the calls that used hold', ada.holdAvg === 25, ada.holdAvg);
check('an agent with no hold reports zeroes, not a missing field',
  alan.holdTotal === 0 && alan.holdCalls === 0 && alan.holdAvg === 0, [alan.holdTotal, alan.holdCalls, alan.holdAvg]);
check('the agent hold figures add up to the dashboard summary for the same day',
  (await harness.request('report.php', { body: Object.assign({ skipPrevious: true }, holdDay), user: USERS.office_manager }))
    .body?.summary?.hold?.totalSeconds === 50,
  'summary hold should be 50 s');

check('three outbound attempts are counted', alan.ob === 3, alan.ob);
check('two of the three outbound attempts connected', alan.obConnected === 2, alan.obConnected);
check('the contact rate is connects over attempts', alan.obConnectPct === 66.7, alan.obConnectPct);
check('an attempt that was never answered is not a connect', alan.obConnected < alan.ob);
check('an outbound call with talking seconds but no answer timestamp still counts as a connect',
  alan.obConnected === 2, alan.obConnected);
check('an agent with no outbound calls reports a zero contact rate, not NaN',
  ada.ob === 0 && ada.obConnectPct === 0, [ada.ob, ada.obConnectPct]);

/*
 * The same hold seconds, per QUEUE. Queue 700 took the two held calls (30 s and
 * 20 s), queue 701 none - and the queues endpoint counts hold on every call that
 * reached the queue, so the three figures below are the rows a supervisor reads
 * off the queue grid.
 */
await harness.seedPbx('callqueues', [
  { callqueue: '700', description: 'Sales queue', site: 'HQ' },
  { callqueue: '701', description: 'Support queue', site: 'HQ' }
]);
const holdCradle = await harness.request('cradle.php', {
  body: { start: '2026-08-19', end: '2026-08-19' },
  user: USERS.office_manager
});
check('cradle.php answers for the hold day', holdCradle.status === 200, holdCradle.log ?? holdCradle.status);
if (holdCradle.status === 200) {
  const rows = Object.fromEntries((holdCradle.body.data.queueStats ?? []).map(r => [r.callqueue, r]));
  check('queue 700 carries its own hold seconds', rows['700']?.holdTotal === 50 && rows['700']?.holdCalls === 2, rows['700']);
  check('queue 700 average hold is over the calls that held', rows['700']?.holdAvg === 25, rows['700']?.holdAvg);
  check('a queue that never held reports zeroes, not a missing field',
    rows['701']?.holdTotal === 0 && rows['701']?.holdCalls === 0 && rows['701']?.holdAvg === 0, rows['701']);
  check('the per-queue hold seconds add up to the dashboard summary (50 s)',
    (rows['700']?.holdTotal || 0) + (rows['701']?.holdTotal || 0) === 50,
    [rows['700']?.holdTotal, rows['701']?.holdTotal]);
  check('the per-queue hold equals the per-agent hold for the same calls',
    (rows['700']?.holdTotal || 0) === ada.holdTotal, [rows['700']?.holdTotal, ada.holdTotal]);
}


/* =========== 11. the month-end pack: per-queue and per-number rows */

console.log('\n== the pack row sets: per queue (with its target) and per number ==');

/*
 * A fresh day (2026-08-25) and a DID inventory, so one fixture proves the whole
 * pack. The hand count, in full:
 *
 *   QUEUES          offered  answered  abandoned  target  SLA            ring/talk
 *   Sales (700)        3        2         1        15 s   1 of 2 = 50.0 %   20 / 45
 *   Support (701)      1        1         0        30 s   1 of 1 = 100.0 %  20 / 40
 *   Idle (702)         0        0         0        (never judged)  -        -
 *
 *   NUMBERS                     calls  missed  aband  missedRate  abandonRate  flags
 *   Main line  ...0001            4       2       1     50.0 %       50.0 %   -
 *   Support line ...0002          2       1       0     50.0 %        0.0 %   -
 *   Backline  ...0005             6       5       1     83.3 %       20.0 %   highAbandon
 *   Trial line ...0006            3       3       2    100.0 %       66.7 %   -  (3 missed is
 *                                                                              below the 5-call floor)
 *   unlisted  ...0007             1       0       0      0.0 %        0.0 %   -  (not zeroTraffic)
 *   Silent line ...0004           0       0       0        -            -      zeroTraffic
 *   Retired line ...0003          - absent: disabled and silent is not a finding
 *
 * "missed" here is the same bucket the dashboard counts: a call that never
 * reached a person, split into abandoned (it reached a queue or an AA) and rung
 * out. The DID rows come from buildNumberStats() - the function the Telephone
 * Numbers screen itself uses - so the two screens cannot disagree.
 */
await harness.seedPbx('callqueues', [
  { callqueue: '700', description: 'Sales queue', site: 'HQ' },
  { callqueue: '701', description: 'Support queue', site: 'HQ' },
  { callqueue: '702', description: 'Idle queue', site: 'HQ' }
]);
/*
 * The inventory is CACHED for an hour, and the earlier queue section already
 * cached a two-queue list - so the third queue would be invisible and the pack
 * would look wrong when it is the cache that is stale. Drop both caches, the
 * way a changed PBX list does after its TTL.
 */
await harness.script(`
foreach (glob(CACHE_DIR . '/callqueues-*.json') ?: [] as $file) { @unlink($file); }
foreach (glob(CACHE_DIR . '/phonenumbers-*.json') ?: [] as $file) { @unlink($file); }
`);
await harness.seedPbx('phonenumbers', [
  { phonenumber: '8457620001', description: 'Main line', enabled: 'yes' },
  { phonenumber: '8457620002', description: 'Support line', enabled: 'yes' },
  { phonenumber: '8457620003', description: 'Retired line', enabled: 'no' },
  { phonenumber: '8457620004', description: 'Silent line', enabled: 'yes' },
  { phonenumber: '8457620005', description: 'Backline', enabled: 'yes' },
  { phonenumber: '8457620006', description: 'Trial line', enabled: 'yes' }
]);
await harness.seedPbx('fetchCdrs', [
  /* Sales queue: ring 10 (inside 15 s), ring 30 (outside), then an abandon. */
  { id: 'q1', 'call-direction': 1, 'call-start-datetime': '2026-08-25T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T09:00:10Z[US/Eastern]', 'call-orig-to-user': '8457620001',
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 60 },
  { id: 'q2', 'call-direction': 1, 'call-start-datetime': '2026-08-25T09:10:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T09:10:30Z[US/Eastern]', 'call-orig-to-user': '8457620001',
    'call-term-user': '6080', 'call-through-user': '700', 'call-talking-duration-seconds': 30 },
  { id: 'q3', 'call-direction': 1, 'call-start-datetime': '2026-08-25T09:20:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T09:20:25Z[US/Eastern]', 'call-orig-to-user': '8457620001',
    'call-through-user': '700' },
  { id: 'q4', 'call-direction': 1, 'call-start-datetime': '2026-08-25T09:30:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T09:30:25Z[US/Eastern]', 'call-orig-to-user': '8457620001' },
  /* Support queue: one answered call, judged against the DOMAIN default (30 s). */
  { id: 'q5', 'call-direction': 1, 'call-start-datetime': '2026-08-25T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T10:00:20Z[US/Eastern]', 'call-orig-to-user': '8457620002',
    'call-term-user': '6081', 'call-through-user': '701', 'call-talking-duration-seconds': 40 },
  { id: 'q6', 'call-direction': 1, 'call-start-datetime': '2026-08-25T10:10:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T10:10:20Z[US/Eastern]', 'call-orig-to-user': '8457620002' },
  /* Backline: 6 calls, 5 missed, 1 of them abandoned -> flagged at exactly the bar. */
  { id: 'b1', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T11:00:05Z[US/Eastern]', 'call-orig-to-user': '8457620005',
    'call-term-user': '6081', 'call-talking-duration-seconds': 25 },
  { id: 'b2', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:10:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T11:10:20Z[US/Eastern]', 'call-orig-to-user': '8457620005',
    'call-batch-start-datetime': '2026-08-25T11:10:05Z[US/Eastern]' },
  { id: 'b3', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:20:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T11:20:20Z[US/Eastern]', 'call-orig-to-user': '8457620005' },
  { id: 'b4', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:30:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T11:30:20Z[US/Eastern]', 'call-orig-to-user': '8457620005' },
  { id: 'b5', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:40:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T11:40:20Z[US/Eastern]', 'call-orig-to-user': '8457620005' },
  { id: 'b6', 'call-direction': 1, 'call-start-datetime': '2026-08-25T11:50:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T11:50:20Z[US/Eastern]', 'call-orig-to-user': '8457620005' },
  /* Trial line: a worse RATE than the Backline but a smaller base -> not flagged. */
  { id: 't1', 'call-direction': 1, 'call-start-datetime': '2026-08-25T12:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T12:00:20Z[US/Eastern]', 'call-orig-to-user': '8457620006',
    'call-batch-start-datetime': '2026-08-25T12:00:05Z[US/Eastern]' },
  { id: 't2', 'call-direction': 1, 'call-start-datetime': '2026-08-25T12:10:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T12:10:20Z[US/Eastern]', 'call-orig-to-user': '8457620006',
    'call-batch-start-datetime': '2026-08-25T12:10:05Z[US/Eastern]' },
  { id: 't3', 'call-direction': 1, 'call-start-datetime': '2026-08-25T12:20:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-08-25T12:20:20Z[US/Eastern]', 'call-orig-to-user': '8457620006' },
  /* A number the customer does NOT have: it must appear, but never as "silent". */
  { id: 'u1', 'call-direction': 1, 'call-start-datetime': '2026-08-25T13:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T13:00:30Z[US/Eastern]', 'call-orig-to-user': '8457620007',
    'call-term-user': '6080', 'call-talking-duration-seconds': 15 },
  /*
   * An OUTBOUND leg the desk placed to its own main line. It belongs in the
   * line's call volume (that is what the Telephone Numbers screen shows) but it
   * is not a chance to miss anybody, so it must NOT move the missed share.
   */
  { id: 'o1', 'call-direction': 0, 'call-start-datetime': '2026-08-25T14:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-08-25T14:00:10Z[US/Eastern]', 'call-orig-user': '6081',
    'dialed': '8457620001', 'call-talking-duration-seconds': 20 }
]);

const packSettings = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
/* Sales is judged against its own 15 s; Support against the domain's 30 s. */
saveDomainSettings('test.example', ['slaSeconds' => 30, 'queueSla' => ['700' => 15]]);
$s = loadDomainSettings('test.example');
echo json_encode(['sla' => $s['slaSeconds'], 'queueSla' => $s['queueSla']]);
`);
check('the pack day is set up with one queue override and a 30 s domain default',
  parseJson(packSettings, '{', '}')?.sla === 30
    && parseJson(packSettings, '{', '}')?.queueSla?.['700'] === 15, packSettings.slice(0, 200));

const packRes = await harness.request('report.php', {
  body: { start: '2026-08-25', end: '2026-08-25', hours: 'all', skipPrevious: true },
  user: USERS.office_manager
});
check('report.php answers with the pack row sets', packRes.status === 200, packRes.log ?? packRes.status);

if (packRes.status === 200) {
  const Q = Object.fromEntries((packRes.body.pack?.queues ?? []).map(r => [r.callqueue, r]));
  const N = Object.fromEntries((packRes.body.pack?.numbers ?? []).map(r => [r.key ?? r.number, r]));

  /* ---- queues ---- */
  check('three queues are published, including the one that saw no traffic',
    Object.keys(Q).length === 3 && !!Q['702'], Object.keys(Q));
  check('the sales row carries the counts the dashboard counts (3 offered, 2 answered, 1 abandoned)',
    Q['700']?.offered === 3 && Q['700']?.answered === 2 && Q['700']?.abandoned === 1, Q['700']);
  check('the sales row is judged against ITS OWN 15 s target',
    Q['700']?.slaSeconds === 15, Q['700']?.slaSeconds);
  check('the sales SLA is 1 of 2 answered inside 15 s = 50 % with its base',
    Q['700']?.sla === 50 && Q['700']?.slaBase === 2, [Q['700']?.sla, Q['700']?.slaBase]);
  check('the sales abandon share is over the calls offered (1 of 3 = 33.3 %)',
    Q['700']?.abandonRate === 33.3, Q['700']?.abandonRate);
  check('the sales ring and talk averages are over the calls that produced them ((10+30)/2 and (60+30)/2)',
    Q['700']?.avgRing === 20 && Q['700']?.avgTalk === 45, [Q['700']?.avgRing, Q['700']?.avgTalk]);
  check('a queue with no override is judged against the domain default (30 s)',
    Q['701']?.slaSeconds === 30, Q['701']?.slaSeconds);
  check('the support row is 1 offered / 1 answered inside 30 s = 100 %',
    Q['701']?.offered === 1 && Q['701']?.answered === 1 && Q['701']?.sla === 100, Q['701']);
  check('an idle queue is published as zeroes rather than omitted',
    Q['702']?.offered === 0 && Q['702']?.answered === 0 && Q['702']?.sla === 0, Q['702']);

  /* ---- numbers ---- */
  check('every live number plus the unlisted one gets a row (7 = 6 listed of 7 enabled, one of them silent, + 1 unlisted)',
    Object.keys(N).length === 6, Object.keys(N));
  check('the disabled number is absent: a retired line taking no calls is not a finding',
    !N['8457620003'], Object.keys(N));
  check('the main line carries 5 calls (4 in + 1 out), 2 missed, 1 abandoned',
    N['8457620001']?.calls === 5 && N['8457620001']?.missed === 2 && N['8457620001']?.abandoned === 1,
    N['8457620001']);
  check("the outbound leg is in the volume but not in the missed share's base (2 of 4, not 2 of 5)",
    N['8457620001']?.missedBase === 4 && N['8457620001']?.missedRate === 50, N['8457620001']);
  check('the main line abandon share is over its MISSED calls (1 of 2 = 50 %)',
    N['8457620001']?.abandonRate === 50, N['8457620001']?.abandonRate);
  check('a line with 5 missed calls and 20 % abandoned is flagged',
    N['8457620005']?.highAbandon === true && N['8457620005']?.missed === 5
      && N['8457620005']?.abandonRate === 20, N['8457620005']);
  check('the same abandon rate on a 3-call base is NOT flagged (the floor is 5 missed)',
    N['8457620006']?.highAbandon === false && N['8457620006']?.abandonRate === 66.7, N['8457620006']);
  check('a silent but live line is flagged zero-traffic',
    N['8457620004']?.zeroTraffic === true && N['8457620004']?.calls === 0, N['8457620004']);
  check('a number the customer does not have is listed but never called silent',
    N['8457620007']?.calls === 1 && N['8457620007']?.zeroTraffic === false, N['8457620007']);
  check('every call in the scope lands on a number row (the DID volumes add up to the day)',
    Object.values(N).reduce((a, r) => a + r.calls, 0) === packRes.body.summary.counts.total,
    [Object.values(N).reduce((a, r) => a + r.calls, 0), packRes.body.summary.counts.total]);
  check("the number rows' inbound and missed counts are the dashboard's",
    Object.values(N).reduce((a, r) => a + r.inbound, 0) === packRes.body.summary.counts.inbound
      && Object.values(N).reduce((a, r) => a + r.missed, 0) === packRes.body.summary.counts.missed,
    [Object.values(N).reduce((a, r) => a + r.inbound, 0), packRes.body.summary.counts.inbound,
      Object.values(N).reduce((a, r) => a + r.missed, 0), packRes.body.summary.counts.missed]);
  check('the queue rows add up to the calls that reached a queue',
    Object.values(Q).reduce((a, r) => a + r.offered, 0) === 4,
    Object.values(Q).map(r => [r.callqueue, r.offered]));
}


/* ====== 10b. repeat callers carry the times they called (report §5) */

console.log('\n== repeat callers: the number, and every time they called ==');

/*
 * Three calls from the same number on 2026-07-20 (a day nothing else owns), on
 * two different DIDs, one of them missed and newest-last in the fixture so the
 * sort is actually exercised:
 *
 *   r1  09:12  inbound, DID ...0001
 *   r2  11:05  missed,  DID ...0001
 *   r3  16:40  inbound, DID ...0002
 *
 * The caller must come back with calls 3 / answered 2 / missed 1, the first and
 * last stamp, and the three times NEWEST FIRST (16:40, 11:05, 09:12) with the
 * type and the DID of each. A number that called once is not a repeat caller.
 */
await harness.seedPbx('phonenumbers', [
  { phonenumber: '8457620001', description: 'Main line', enabled: 'yes' },
  { phonenumber: '8457620002', description: 'Support line', enabled: 'yes' },
  { phonenumber: '8457620003', description: 'Quiet line', enabled: 'yes' }
]);
await harness.seedPbx('fetchCdrs', [
  { id: 'r1', 'call-direction': 1, 'call-start-datetime': '2026-07-20T09:12:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-20T09:12:07Z[US/Eastern]', 'call-orig-to-user': '8457620001',
    'call-orig-caller-id': '8454259810', 'call-term-user': '6080', 'call-talking-duration-seconds': 40 },
  { id: 'r2', 'call-direction': 1, 'call-start-datetime': '2026-07-20T11:05:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-07-20T11:05:30Z[US/Eastern]', 'call-orig-to-user': '8457620001',
    'call-orig-caller-id': '8454259810' },
  { id: 'r3', 'call-direction': 1, 'call-start-datetime': '2026-07-20T16:40:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-20T16:40:09Z[US/Eastern]', 'call-orig-to-user': '8457620002',
    'call-orig-caller-id': '8454259810', 'call-term-user': '6081', 'call-talking-duration-seconds': 25 },
  /* A different number, once: it must NOT appear in the repeat list. */
  { id: 'r4', 'call-direction': 1, 'call-start-datetime': '2026-07-20T12:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-20T12:00:04Z[US/Eastern]', 'call-orig-to-user': '8457620002',
    'call-orig-caller-id': '8454259999', 'call-term-user': '6080', 'call-talking-duration-seconds': 10 }
]);

const repeats = await harness.request('telephone_numbers.php', {
  body: { start: '2026-07-20', end: '2026-07-20' },
  user: USERS.office_manager
});
check('telephone_numbers.php answers for the repeat day', repeats.status === 200, repeats.log ?? repeats.status);
if (repeats.status === 200) {
  const rows = repeats.body.data?.repeatCallers ?? repeats.body.repeatCallers ?? [];
  const row = rows.find(r => r.caller === '8454259810');
  check('the repeat caller is in the list with their counts',
    !!row && row.calls === 3 && row.answered === 2 && row.missed === 1, row);
  check('a number that called once is not a repeat caller',
    rows.length === 1 && !rows.some(r => r.caller === '8454259999'), rows.map(r => r.caller));
  check('the row carries every time they called, newest first',
    (row?.times ?? []).map(t => t.at).join('|') === '2026-07-20 16:40|2026-07-20 11:05|2026-07-20 09:12',
    row?.times);
  check('each time says whether the call was answered or missed',
    (row?.times ?? []).map(t => t.type).join(',') === 'inbound,missed,inbound',
    (row?.times ?? []).map(t => t.type));
  check('each time says which DID they dialled',
    (row?.times ?? [])[0]?.number === '8457620002' && (row?.times ?? [])[1]?.number === '8457620001',
    (row?.times ?? []).map(t => t.number));
  check('the first and last stamps bracket the times',
    row?.firstCall === '2026-07-20 09:12' && row?.lastCall === '2026-07-20 16:40',
    [row?.firstCall, row?.lastCall]);
  check('the row does not claim to be capped when it is not', row?.timesCapped === false, row?.timesCapped);
}

/* ====== 11b. the miss rate inside each wait band (Sprint B, §3) */

console.log('\n== miss rate per wait band, each with its own base ==');

/*
 * A fixture nothing else owns (Monday 2026-07-13), so the bands are stated in
 * full and hand-checked:
 *
 *   w1  answered after  2 s   band under 5s     } 2 arrivals, 1 missed = 50.0 %
 *   w2  gave up after   3 s   band under 5s     }
 *   w3  answered after 10 s   band 5-30s        }
 *   w4  answered after 20 s   band 5-30s        } 3 arrivals, 1 missed = 33.3 %
 *   w5  gave up after   8 s   band 5-30s        }
 *   w6  answered after 40 s   band over 30s     }
 *   w7  gave up after  40 s   band over 30s     } 3 arrivals, 2 missed = 66.7 %
 *   w8  gave up after  60 s   band over 30s     }
 *
 * The three bases must sum to the period's arrivals (4 answered + 4 missed), and
 * every band must print the base its rate came from.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'w1', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-13T09:00:02Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w2', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:05:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-07-13T09:05:03Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w3', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:10:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-13T09:10:10Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w4', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:15:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-13T09:15:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w5', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:20:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-07-13T09:20:08Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w6', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:25:00Z[US/Eastern]',
    'call-answer-datetime': '2026-07-13T09:25:40Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w7', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:30:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-07-13T09:30:40Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'w8', 'call-direction': 1, 'call-start-datetime': '2026-07-13T09:35:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-07-13T09:36:00Z[US/Eastern]', 'call-term-user': '6080' }
]);

const bandRes = await harness.request('report.php', {
  body: { start: '2026-07-13', end: '2026-07-13', hours: 'all', skipPrevious: true },
  user: USERS.office_manager
});
check('the band request answers', bandRes.status === 200, bandRes.log ?? bandRes.status);
if (bandRes.status === 200) {
  const mix = bandRes.body.summary.waitBandMix || [];
  const byBand = Object.fromEntries(mix.map(b => [b.band, b]));
  check('three bands are published, in order, with their labels',
    mix.length === 3 && byBand.lt5 && byBand['5-30'] && byBand.gt30, mix.map(b => b.band));
  check('under 5s: 2 arrivals, 1 missed = 50 %',
    byBand.lt5.offered === 2 && byBand.lt5.answered === 1 && byBand.lt5.missed === 1
      && byBand.lt5.missPct === 50, byBand.lt5);
  check('5-30s: 3 arrivals, 1 missed = 33.3 % (answered at 10 s and 20 s, out at 8 s)',
    byBand['5-30'].offered === 3 && byBand['5-30'].answered === 2 && byBand['5-30'].missed === 1
      && byBand['5-30'].missPct === 33.3, byBand['5-30']);
  check('over 30s: 3 arrivals, 2 missed = 66.7 % (answered at 40 s, out at 40 s and 60 s)',
    byBand.gt30.offered === 3 && byBand.gt30.answered === 1 && byBand.gt30.missed === 2
      && byBand.gt30.missPct === 66.7, byBand.gt30);
  check('a band with no arrivals would still be a zero row, not an omission',
    mix.every(b => typeof b.offered === 'number' && typeof b.missPct === 'number'), mix);
  check('the bands partition every arrival (bases sum to answered + missed for the day)',
    mix.reduce((a, b) => a + b.offered, 0)
      === bandRes.body.summary.counts.inbound + bandRes.body.summary.counts.missed,
    [mix.map(b => b.offered), bandRes.body.summary.counts]);
  check("every band's rate is its own count over its own base",
    mix.every(b => b.missPct === (b.offered > 0 ? Math.round((b.missed / b.offered) * 1000) / 10 : 0)), mix);
  check('each band\'s answered + missed adds up to its base',
    mix.every(b => b.answered + b.missed === b.offered), mix);
  check('the missed-only buckets still agree with the bands they extend',
    (bandRes.body.summary.missedWaitBuckets || {}).lt5 === byBand.lt5.missed
      && (bandRes.body.summary.missedWaitBuckets || {})['5-30'] === byBand['5-30'].missed
      && (bandRes.body.summary.missedWaitBuckets || {}).gt30 === byBand.gt30.missed,
    bandRes.body.summary.missedWaitBuckets);
}

/* ====== 12. the pack's trust blocks: quality, staffing, 4-week baseline */

console.log('\n== the appendix: data quality, staffing estimate, weekday baseline ==');

/*
 * The same 2026-08-25 day (17 calls: the 16 arrivals plus the one outbound leg
 * added above), asked for with baseline=1.
 *
 *   QUALITY    the four F7 checks over those 17 rows. The fixture carries an
 *              answer moment and talking seconds on every call it answers, and
 *              no leg twice - so three counts must be 0 - but it carries no
 *              disconnect reasons, and the appendix must say 17 of 17 rather
 *              than quietly show nothing.
 *
 *   STAFFING   offered = answered + missed per hour, and agents = offered x AHT
 *              / 3600 / 0.85. At 09:00: q1 + q2 answered (60 s + 30 s -> AHT
 *              45) and q3 + q4 missed = 4 offered; 4 x 45 = 180 work-seconds;
 *              180 / (3600 x 0.85) = 0.0588 -> 0.06 agents. The check that
 *              matters is not the tiny number but that the assumption rides
 *              WITH it (85 %, 60-minute intervals) and that the total is the
 *              same formula over every hour.
 *
 *   BASELINE   structural checks here, arithmetic on a self-contained fixture
 *              below: every weekday is published, a weekday's average is its
 *              total over its weeks (never diluted by weeks it did not appear
 *              in), and a day is indexed against its own weekday's baseline
 *              where one exists and carries null where it does not.
 */
const packDeep = await harness.request('report.php', {
  body: { start: '2026-08-25', end: '2026-08-25', hours: 'all', skipPrevious: true, baseline: 1 },
  user: USERS.office_manager
});
check('a pack request with baseline=1 answers', packDeep.status === 200, packDeep.log ?? packDeep.status);

if (packDeep.status === 200) {
  const Q = packDeep.body.pack || {};
  const qual = Q.quality || {};
  check('the appendix counts the calls it audited (16 arrivals + 1 outbound leg)', qual.calls === 17, qual.calls);
  check('every quality count carries the base it was taken over',
    qual.missingAnswerTime?.base === 17 && qual.zeroTalkAnswered?.base === qual.answered
      && qual.missingDisconnectReason?.base === 17 && qual.duplicateLegs?.base === 17, qual);
  check("the fixture's answered calls all have an answer moment (no false 'missing' flag)",
    qual.missingAnswerTime?.count === 0, qual.missingAnswerTime);
  check('no answered call in the fixture has zero talk time',
    qual.zeroTalkAnswered?.count === 0, qual.zeroTalkAnswered);
  check('the fixture carries no duplicate legs', qual.duplicateLegs?.count === 0, qual.duplicateLegs);
  check('missing disconnect reasons are counted, not glossed (17 of 17 = 100 %)',
    qual.missingDisconnectReason?.count === 17 && qual.missingDisconnectReason?.pct === 100,
    qual.missingDisconnectReason);

  const staff = Q.staffing || {};
  check('the staffing estimate states the occupancy it assumed',
    staff.occupancyPct === 85 && staff.intervalMinutes === 60, [staff.occupancyPct, staff.intervalMinutes]);
  check('the estimate says it is a baseline and why it is not occupancy',
    staff.label === 'baseline, not a forecast' && /no roster/i.test(String(staff.basis)), staff);
  const nine = (staff.hours || []).find(h => h.hour === 9);
  check('09:00: 4 offered at AHT 45 -> 180 work-seconds -> 0.06 agents at 85 %',
    nine && nine.offered === 4 && nine.aht === 45 && nine.workSeconds === 180 && nine.agents === 0.06, nine);
  check('a row with no offered calls asks for no agents rather than dividing by zero',
    (staff.hours || []).every(h => h.offered > 0 || h.agents === 0), (staff.hours || []).filter(h => h.agents));
  check('the total agent-hours are the same formula over the whole period',
    Math.abs(staff.totalAgentHours - (staff.hours || []).reduce((a, h) => a + h.workSeconds, 0) / 3600 / 0.85) < 0.02,
    [staff.totalAgentHours, (staff.hours || []).reduce((a, h) => a + h.workSeconds, 0) / 3600 / 0.85]);

  const base = Q.baseline || {};
  check('the baseline names its four-week window and the days inside it that had data',
    /prior weeks/i.test(String(base.label))
      && base.windowFrom === '2026-07-28' && base.windowTo === '2026-08-24'
      && base.from >= base.windowFrom && base.to <= base.windowTo,
    [base.label, base.windowFrom, base.windowTo, base.from, base.to]);
  check('all seven weekdays are published even with no data',
    (base.byWeekday || []).length === 7, (base.byWeekday || []).length);
  check("a weekday's average is its total over the weeks it appeared in",
    (base.byWeekday || []).every(d => d.weeks > 0 ? d.avg === Math.round((d.total / d.weeks) * 10) / 10 : d.avg === 0),
    base.byWeekday);
  check('a day is indexed against its weekday where a baseline exists, and null where none does',
    (base.days || []).every(d => {
      const wd = (base.byWeekday || []).find(w => w.weekday === d.weekday) || { weeks: 0 };
      if (wd.weeks === 0) return d.baseline === null && d.index === null;
      return d.baseline === wd.avg && d.index === Math.round((d.volume / wd.avg) * 1000) / 10;
    }), base.days);
  check('the period days carry the arrival volume (inbound + missed, no outbound)',
    (base.days || []).length === 1 && base.days[0].date === '2026-08-25'
      && base.days[0].volume === packDeep.body.summary.counts.inbound + packDeep.body.summary.counts.missed,
    base.days);
}

/*
 * The baseline arithmetic on a fixture nothing else owns: Monday 2026-06-01
 * carries four arrivals; the period Monday 2026-06-15 carries six. So the
 * Monday baseline is 4.0 over one week and the 15th is indexed at 150 %.
 * Neither June day appears anywhere else in this suite.
 */
await harness.seedPbx('fetchCdrs', [
  { id: 'x1', 'call-direction': 1, 'call-start-datetime': '2026-06-01T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-06-01T09:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'x2', 'call-direction': 1, 'call-start-datetime': '2026-06-01T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-06-01T10:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'x3', 'call-direction': 1, 'call-start-datetime': '2026-06-01T11:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-06-01T11:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'x4', 'call-direction': 1, 'call-start-datetime': '2026-06-01T12:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-06-01T12:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y1', 'call-direction': 1, 'call-start-datetime': '2026-06-15T09:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-06-15T09:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y2', 'call-direction': 1, 'call-start-datetime': '2026-06-15T10:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-06-15T10:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y3', 'call-direction': 1, 'call-start-datetime': '2026-06-15T11:00:00Z[US/Eastern]',
    'call-answer-datetime': '2026-06-15T11:00:05Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y4', 'call-direction': 1, 'call-start-datetime': '2026-06-15T12:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-06-15T12:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y5', 'call-direction': 1, 'call-start-datetime': '2026-06-15T13:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-06-15T13:00:20Z[US/Eastern]', 'call-term-user': '6080' },
  { id: 'y6', 'call-direction': 1, 'call-start-datetime': '2026-06-15T14:00:00Z[US/Eastern]',
    'call-disconnect-datetime': '2026-06-15T14:00:20Z[US/Eastern]', 'call-term-user': '6080' }
]);
const baseRes = await harness.request('report.php', {
  body: { start: '2026-06-15', end: '2026-06-15', hours: 'all', skipPrevious: true, baseline: 1 },
  user: USERS.office_manager
});
check('the baseline request for 15 June answers', baseRes.status === 200, baseRes.log ?? baseRes.status);
if (baseRes.status === 200) {
  const base = baseRes.body.pack?.baseline || {};
  const byWd = Object.fromEntries((base.byWeekday || []).map(d => [d.weekday, d]));
  check('the four June 1st arrivals are the Monday baseline (1 week, avg 4.0)',
    byWd[1]?.weeks === 1 && byWd[1]?.total === 4 && byWd[1]?.avg === 4, byWd[1]);
  check('weekdays with no prior traffic are published with zero weeks, not invented averages',
    byWd[3]?.weeks === 0 && byWd[3]?.total === 0 && byWd[3]?.avg === 0, byWd[3]);
  const day = (base.days || [])[0];
  check('the period Monday carries its own volume and is indexed against its weekday baseline (6 / 4 = 150 %)',
    day && day.date === '2026-06-15' && day.volume === 6 && day.baseline === 4 && day.index === 150, day);
}


/* ================================= 9. the desk's own timezone (review finding C7) */

console.log('\n== the desk\'s timezone: the setting, the boundaries it moves, the cache it keys ==');

/*
 * DEFAULT_TIMEZONE (includes/config.php) used to be the only answer, so one
 * constant decided the calendar of every tenant on the box and the only way to
 * change it was a config edit and a redeploy. The setting is per domain now, and
 * this section pins the four things it has to touch — none of them a label:
 *
 *   1. the day a call belongs to (`callLocalDate`, which `filterCallsByLocalDate`
 *      and every card on the screen are built on);
 *   2. the hour bucket the drill-down filters by;
 *   3. the window the day is fetched from the PBX with (`easternDayWindow`);
 *   4. the day-cache filename and the Settings round-trip, including the rule
 *      that an omitted or unusable value must not move the clock.
 *
 * The arithmetic, by hand: 1790028000 is 2026-09-21T22:00:00Z, which is 18:00 on
 * Monday the 21st in US/Eastern (UTC-4 in September) and 06:00 on Tuesday the
 * 22nd in Asia/Manila (UTC+8, no DST). Same record, different report. That date
 * is used by no other section of this file, on purpose: the day cache answers
 * from whatever was cached for a day first, so a shared day would make this
 * section read another section's fixture.
 */
const ONE_INSTANT = '1790028000';
/* Monday 17:00-23:00 open, every other day closed: the instant above is inside
 * Monday in New York and outside Tuesday in Manila, so the two desks have to
 * disagree about whether anyone was at the desk when it rang. */
const HOURS_PHP = `['enabled' => true, 'days' => [
        1 => ['closed' => false, 'open' => '17:00', 'close' => '23:00'],
        2 => ['closed' => true, 'open' => '', 'close' => ''],
        3 => ['closed' => true, 'open' => '', 'close' => ''],
        4 => ['closed' => true, 'open' => '', 'close' => ''],
        5 => ['closed' => true, 'open' => '', 'close' => ''],
        6 => ['closed' => true, 'open' => '', 'close' => ''],
        7 => ['closed' => true, 'open' => '', 'close' => ''],
    ], 'holidays' => []]`;

const tzEastRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$domain = 'tz-move.example';
@unlink(domainSettingsFile($domain));
$row = ['call-start-datetime' => '${ONE_INSTANT}'];
echo json_encode([
    'default_setting' => defaultDomainSettings()['timezone'],
    /* Nothing has claimed a zone: the deployment answer, in every form. */
    'name' => reportingTimezoneName(),
    'window' => easternDayWindow('2026-09-21'),
    'local_date' => callLocalDate($row),
    'hour' => (int) parseEasternDateTime('${ONE_INSTANT}')->format('G'),
    'in_hours' => callWithinBusinessHours($row, ['businessHours' => ${HOURS_PHP}]),
    'day_file' => basename(cdrDayCacheFile($domain, '2026-09-21')),
    /* A timezone the runtime does not know is refused, and refused without
     * taking the rest of the save down with it. */
    'refused' => saveDomainSettings($domain, ['timezone' => 'Mars/Olympus_Mons', 'slaSeconds' => 25]),
    /* A UTC offset is not a timezone: no DST rules, so it would move the desk's
     * hours twice a year on its own. Rejected on the way in, not on the chart. */
    'offset_refused' => saveDomainSettings($domain, ['timezone' => '+08:00'])['timezone'],
]);
`);
const tzEast = parseJson(tzEastRaw, '{', '}');
check('the eastern block parses', tzEast !== null, tzEastRaw.slice(0, 400));
if (tzEast) {
  check('a fresh install is measured in the zone every install has always used',
    tzEast.default_setting === 'US/Eastern' && tzEast.name === 'US/Eastern', tzEast);
  check('the day window is built in the desk zone, not hard-coded',
    tzEast.window[0] === '2026-09-21T00:00:00Z[US/Eastern]'
      && tzEast.window[1] === '2026-09-21T23:59:59Z[US/Eastern]', tzEast.window);
  check('22:00Z is 18:00 on Monday the 21st for an Eastern desk',
    tzEast.local_date === '2026-09-21' && tzEast.hour === 18, tzEast);
  check('and that is inside a Monday 17:00-23:00 desk', tzEast.in_hours === true, tzEast);
  check('an unusable timezone falls back to the deployment default',
    tzEast.refused?.timezone === 'US/Eastern', tzEast.refused);
  check('a bare UTC offset is refused the same way',
    tzEast.offset_refused === 'US/Eastern', tzEast.offset_refused);
  check('while the rest of that same save is kept (a refused key is not a rolled-back save)',
    tzEast.refused?.slaSeconds === 25, tzEast.refused);
}

const tzManilaRaw = await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
$domain = 'tz-move.example';
$row = ['call-start-datetime' => '${ONE_INSTANT}'];
/* The name the Eastern process used, read here before anything is applied: the
 * two halves of the cache claim, from one domain and one day. */
$before = basename(cdrDayCacheFile($domain, '2026-09-21'));
@unlink(domainSettingsFile($domain));
$saved = saveDomainSettings($domain, ['timezone' => 'Asia/Manila', 'businessHours' => ${HOURS_PHP}]);
$stored = loadDomainSettings($domain);
$applied = setReportingTimezone($stored['timezone'] ?? null);
echo json_encode([
    'stored' => $saved['timezone'],
    'loaded' => $stored['timezone'],
    'applied' => $applied,
    'day_file_eastern' => $before,
    'day_file' => basename(cdrDayCacheFile($domain, '2026-09-21')),
    'name' => reportingTimezoneName(),
    'window' => easternDayWindow('2026-09-21'),
    'local_date' => callLocalDate($row),
    'hour' => (int) parseEasternDateTime('${ONE_INSTANT}')->format('G'),
    'in_hours' => callWithinBusinessHours($row, $stored),
    /* A save that does not mention the clock must not move it back. */
    'omitted' => saveDomainSettings($domain, ['slaSeconds' => 30])['timezone'],
    'empty' => saveDomainSettings($domain, ['timezone' => ''])['timezone'],
    'null' => saveDomainSettings($domain, ['timezone' => null])['timezone'],
    /* And the calendar the zone is expressed in survives beside it. */
    'hours_kept' => saveDomainSettings($domain, ['timezone' => 'Asia/Manila'])['businessHours']['days'][1]['open'],
]);
`);
const tzManila = parseJson(tzManilaRaw, '{', '}');
check('the manila block parses', tzManila !== null, tzManilaRaw.slice(0, 400));
if (tzManila && tzEast) {
  check('the setting round-trips, and setReportingTimezone reports what it applied',
    tzManila.stored === 'Asia/Manila' && tzManila.loaded === 'Asia/Manila'
      && tzManila.applied === 'Asia/Manila' && tzManila.name === 'Asia/Manila', tzManila);
  check('the day the PBX is asked for follows the desk, not the box',
    tzManila.window[0] === '2026-09-21T00:00:00Z[Asia/Manila]', tzManila.window);
  check('the same instant is 06:00 on Tuesday the 22nd for a Manila desk',
    tzManila.local_date === '2026-09-22' && tzManila.hour === 6, tzManila);
  check('so the call that was inside Monday in New York is outside Tuesday in Manila',
    tzManila.in_hours === false && tzEast.in_hours === true, tzManila);
  /*
   * Same domain, same day, two zones, two files — and the Manila process read the
   * Eastern name back first, so the difference is the zone and not the test data.
   */
  check('a day is cached per timezone, so switching cannot reuse the other day',
    tzManila.day_file_eastern === tzEast.day_file
      && tzManila.day_file !== tzManila.day_file_eastern,
    { manila: tzManila.day_file, eastern: tzManila.day_file_eastern });
  check('omitting the key on a later save keeps the zone (the $pick rule)',
    tzManila.omitted === 'Asia/Manila' && tzManila.empty === 'Asia/Manila'
      && tzManila.null === 'Asia/Manila', tzManila);
  check('and the calendar it is stored with survives beside it',
    tzManila.hours_kept === '17:00', tzManila.hours_kept);
}

/*
 * End to end, with the tenant's Settings file holding the zone: one seeded call
 * at 2026-09-21T22:00Z, asked about on both days. The card, the hour drill and
 * the zone the payload names have to move together, because they are one setting
 * read three times — which is what the rest of the app never did.
 */
const tzCall = {
  id: 'tz1',
  'call-direction': 1,
  'call-start-datetime': ONE_INSTANT,
  'call-answer-datetime': '1790028010',
  'call-disconnect-datetime': '1790028060',
  'call-talking-duration-seconds': 40,
  'call-total-duration-seconds': 60,
  'call-term-user': '6080',
  'call-through-user': '700',
  'call-orig-caller-id': '5557000001',
  'call-orig-from-user': '5557000001'
};
await harness.seedPbx('fetchCdrs', [tzCall]);
const tzRequest = async (day) => await harness.request('report.php', {
  body: { start: day, end: day, hours: 'all', skipPrevious: true },
  user: USERS.office_manager
});
/* `hours: 'all'` explicitly: an earlier section of this file gave this tenant a
 * Mon-Fri 08:00-18:00 calendar, which the drill would otherwise default to, and
 * a call at 18:00 / 06:00 is outside it in either zone. This section is about
 * the clock, not the calendar. */
const tzList = async (extra = {}) => await harness.request('calls.php', {
  body: Object.assign({ start: '2026-09-21', end: '2026-09-22', hours: 'all', size: 50 }, extra),
  user: USERS.office_manager
});

await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
saveDomainSettings('test.example', ['timezone' => 'Asia/Manila']);
`);
{
  const on21 = await tzRequest('2026-09-21');
  const on22 = await tzRequest('2026-09-22');
  check('a Manila tenant answers with the zone it used',
    on21.status === 200 && on21.body?.timezone === 'Asia/Manila', on21.body?.timezone ?? on21.log);
  check('its 21 September has nothing, because the call rang at 06:00 on the 22nd',
    (on21.body?.summary?.counts?.total ?? -1) === 0, on21.body?.summary?.counts);
  check('and its 22 September has the call',
    (on22.body?.summary?.counts?.total ?? -1) === 1, on22.body?.summary?.counts);
  const hour6 = await tzList({ hour: 6 });
  const hour18 = await tzList({ hour: 18 });
  check('the hour drill-down buckets the day in the desk zone too (06:00 Manila)',
    (hour6.body?.data ?? []).map(r => r.id).join(',') === 'tz1', (hour6.body?.data ?? []).map(r => r.id));
  check('while 18:00 — the hour the same record shows in New York — is empty',
    (hour18.body?.data ?? []).length === 0, (hour18.body?.data ?? []).map(r => r.id));
  const session = await harness.request('session.php', { user: USERS.office_manager });
  check('session.php carries the clock, so the first "Today" is the desk\'s',
    session.status === 200 && session.body?.timezone === 'Asia/Manila', session.body ?? session.log);
}

await harness.script(`
require_once TEST_TMP . '/includes/reporting.php';
saveDomainSettings('test.example', ['timezone' => 'US/Eastern']);
`);
{
  const on21 = await tzRequest('2026-09-21');
  const on22 = await tzRequest('2026-09-22');
  const hour18 = await tzList({ hour: 18 });
  check('the same seed and the same request on an Eastern desk put the call on the 21st',
    (on21.body?.summary?.counts?.total ?? -1) === 1 && (on22.body?.summary?.counts?.total ?? -1) === 0,
    { d21: on21.body?.summary?.counts, d22: on22.body?.summary?.counts });
  check('and 18:00 is its hour',
    (hour18.body?.data ?? []).map(r => r.id).join(',') === 'tz1', (hour18.body?.data ?? []).map(r => r.id));
  const settings = await harness.request('settings.php', { user: USERS.office_manager });
  check('settings.php reads the stored zone back to the dialog that edits it',
    settings.status === 200 && settings.body?.data?.timezone === 'US/Eastern'
      && settings.body?.timezone === 'US/Eastern', settings.body ?? settings.log);
}

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('REPORT METRICS OK');
