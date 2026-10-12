/**
 * The desk's clock, on the client (review finding C7).
 *
 * The app used to carry two clocks: the server resolved every CDR timestamp in
 * DEFAULT_TIMEZONE (one constant for the whole deployment, overridable only in a
 * config file), the browser picked its own zone for "Today", and lib/time.js
 * formatted everything in a hard-coded 'America/New_York'. A desk outside New
 * York therefore opened on the wrong DAY, asked for the wrong 24-hour window,
 * and put its hour chart in the wrong buckets — while every label insisted it was
 * looking at its own local time.
 *
 * Now the zone is a per-domain setting, the server names it in every payload
 * (`timezone`, applied by lib/api.js) and in the page shell (the app-clock
 * island), and these tests pin the client half of that hand-off:
 *
 *   1. the helpers format and parse in the CURRENT zone, not the one the module
 *      happened to load with;
 *   2. `today` — the date the filter bar opens with — follows the zone;
 *   3. the window sent to the PBX for a date range is the desk's day;
 *   4. a zone the runtime cannot resolve is refused, never installed.
 *
 *   node tests/js/timezone.mjs
 */
/*
 * lib/time.js uses React's createElement for the one formatter that returns
 * markup, so the same global the browser supplies (and tests/js/harness.mjs sets
 * for the rendered suites) has to exist before the module is imported.
 */
globalThis.React = (await import('react')).default;
const time = await import('../../assets/js/src/lib/time.js');
/*
 * Through the namespace object, NOT destructured: `today` and `APP_TZ` are
 * exported bindings the module reassigns when the desk's zone changes, and a
 * destructured copy is the value at import time — which is exactly the drift
 * check #2 below is about. (An app module gets this for free from its static
 * `import { today }`, which stays live.)
 */
const { APP_TZ, applyServerTimezone, date, formatCallTime, parseCallInstant, rangeDateTimes } = time;

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

/* One instant, two desks: 2026-09-21T22:00Z is 18:00 on Monday the 21st in New
 * York (UTC-4 in September) and 06:00 on Tuesday the 22nd in Manila (UTC+8). */
const INSTANT = new Date('2026-09-21T22:00:00Z');

console.log('== the client clock starts on the deployment default ==');
check('lib/time.js defaults to Eastern, as the server does', APP_TZ === 'America/New_York', APP_TZ);
check('so an evening call is still the 21st', date(INSTANT) === '2026-09-21', date(INSTANT));

console.log('\n== adopting the desk\'s zone moves every derived value ==');
{
  const applied = applyServerTimezone('Asia/Manila');
  check('the setter answers with the zone now in effect', applied === 'Asia/Manila', applied);
  check('the same instant is now the next day', date(INSTANT) === '2026-09-22', date(INSTANT));
  check('and 06:00, not 18:00', formatCallTime('2026-09-22T06:00:00Z[Asia/Manila]') === '6:00 AM',
    formatCallTime('2026-09-22T06:00:00Z[Asia/Manila]'));
  check('a timestamp the PBX labels in the desk zone lands on the desk\'s date',
    date(parseCallInstant('2026-09-22T06:00:00Z[Asia/Manila]')) === '2026-09-22',
    date(parseCallInstant('2026-09-22T06:00:00Z[Asia/Manila]')));
  /*
   * `today` is a live binding that the setter recomputes. This is the whole
   * point of applying the zone in the page shell, before the first render: the
   * filter bar opens on the desk's date, so the default range is the day the
   * server will slice its cache by.
   */
  /*
   * The clock is FROZEN for this one, because "did the default range follow the
   * zone?" is otherwise a question about the hour this suite happens to run at:
   * Eastern and Manila only disagree about the date for part of every day. With
   * the instant pinned, the assertion is a fact rather than a race — and the
   * reassignment has to reach the exported binding, not just the module's own
   * copy, which is what the app's `import { today }` reads.
   */
  {
    const RealDate = globalThis.Date;
    const frozen = new RealDate('2026-09-21T22:00:00Z').getTime();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [frozen])); }
      static now() { return frozen; }
    };
    try {
      applyServerTimezone('US/Eastern');
      check('a frozen 22:00Z on 21 September is the 21st for an Eastern desk',
        time.today === '2026-09-21', time.today);
      applyServerTimezone('Asia/Manila');
      check('and the 22nd for a Manila desk, with no re-import in between',
        time.today === '2026-09-22', time.today);
    } finally {
      globalThis.Date = RealDate;
    }
    /* Back to Manila for the checks below. */
    applyServerTimezone('Asia/Manila');
  }
  check('the report window carries the desk\'s zone into the request',
    JSON.stringify(rangeDateTimes('2026-09-21', '2026-09-22')) === JSON.stringify({
      timezone: 'Asia/Manila',
      datetimeStart: '2026-09-21T00:00:00Z[Asia/Manila]',
      datetimeEnd: '2026-09-22T23:59:59Z[Asia/Manila]'
    }), rangeDateTimes('2026-09-21', '2026-09-22'));
}

console.log('\n== a zone the runtime cannot resolve is never installed ==');
{
  /* Every one of these would throw inside Intl.DateTimeFormat downstream, which
   * is not a label problem but a blank screen: the guard has to be here. */
  for (const bad of ['', null, undefined, 'Mars/Olympus_Mons', 'not a zone', '+08:00', 42,
                    'Asia/Manil; drop', 'x'.repeat(80)]) {
    check('refused: ' + JSON.stringify(bad), applyServerTimezone(bad) === 'Asia/Manila',
      applyServerTimezone(bad));
  }
  check('the clock never moved while they were tried', date(INSTANT) === '2026-09-22', date(INSTANT));
}

console.log('\n== and back again: the setting is a choice, not a one-way door ==');
{
  check('the server\'s spelling (US/Eastern) is accepted verbatim',
    applyServerTimezone('US/Eastern') === 'US/Eastern');
  check('the evening call is on the 21st again', date(INSTANT) === '2026-09-21', date(INSTANT));
  check('the window says so too',
    rangeDateTimes('2026-09-21', '2026-09-21').datetimeEnd === '2026-09-21T23:59:59Z[US/Eastern]',
    rangeDateTimes('2026-09-21', '2026-09-21'));
  /* Two spellings of one zone (US/Eastern and America/New_York) must agree, but
   * they are NOT interchangeable in a cache key — the name is hashed verbatim, so
   * the Settings list offers one id per desk and the server stores what it gets. */
  applyServerTimezone('America/New_York');
  check('the canonical id reads the same instant as the alias',
    date(INSTANT) === '2026-09-21' && rangeDateTimes('2026-09-21', '2026-09-21')
      .datetimeStart === '2026-09-21T00:00:00Z[America/New_York]', rangeDateTimes('2026-09-21', '2026-09-21'));
  check('a zone with no DST of its own is a legitimate choice',
    applyServerTimezone('Asia/Kolkata') === 'Asia/Kolkata'
      && date(new Date('2026-09-21T22:00:00Z')) === '2026-09-22', date(new Date('2026-09-21T22:00:00Z')));
}

console.log('\n' + '-'.repeat(72));
if (failures.length) {
  console.log(`DESK CLOCK FAILED — ${failures.length} check(s):`);
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('DESK CLOCK OK — one zone, from the setting to the filter bar');
