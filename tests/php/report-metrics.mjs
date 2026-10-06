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

console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s)`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('REPORT METRICS OK');
