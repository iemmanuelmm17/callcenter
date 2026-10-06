/**
 * Unit tests for the totals-row / denominator arithmetic (lib/totals.js).
 *
 * The review's §5 rules are arithmetic, and the two that a spreadsheet-minded
 * manager checks first are here by name:
 *
 *   - a totals row recomputes a RATE from the summed numerator and denominator
 *     (never the mean of the per-row percentages);
 *   - an average column is weighted by volume, so a nine-call agent cannot move
 *     it as much as a nine-hundred-call one.
 *
 * The same rules are exercised through the rendered grids in tests/js/smoke.mjs;
 * this file pins the arithmetic itself, including the zero-denominator and
 * broken-row cases that a live grid hits on a quiet Sunday.
 */
import {
  countBy, denomText, maxBy, pctWithBase, sumBy, weightedMean, weightedPct
} from '../../assets/js/src/lib/totals.js';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};
const close = (a, b, tolerance = 1e-9) => Math.abs(Number(a) - Number(b)) < tolerance;

console.log('== sums treat a missing or broken field as zero ==');
check('sumBy adds the field', sumBy([{ mc: 2 }, { mc: 3 }], 'mc') === 5);
check('sumBy of an empty set is 0, not NaN', sumBy([], 'mc') === 0 && sumBy(null, 'mc') === 0);
check('a non-numeric field does not poison the total',
  sumBy([{ mc: 2 }, { mc: 'nonsense' }, { mc: null }, {}], 'mc') === 2,
  sumBy([{ mc: 2 }, { mc: 'nonsense' }, { mc: null }, {}], 'mc'));
check('maxBy reports the longest, not the sum',
  maxBy([{ ibLtt: 300 }, { ibLtt: 900 }, { ibLtt: 12 }], 'ibLtt') === 900);
check('countBy counts rows that have a value', countBy([{ site: 'HQ' }, { site: '' }, { site: 'Branch' }], 'site') === 2);

console.log('\n== a totals rate is recomputed, never averaged ==');
/*
 * Agent A: 1 missed of 100 offered (1.0%). Agent B: 99 missed of 1,000 offered
 * (9.9%). The mean of the two rates is 5.45%; the true rate is 100 ÷ 1,100 =
 * 9.0909%. A totals row that averages percentages understates the desk by
 * nearly half here — this is the review's complaint, written as a test.
 */
const agents = [{ mc: 1, ab: 0, ib: 99, offered: 100 }, { mc: 99, ab: 0, ib: 901, offered: 1000 }];
const recomputed = weightedPct(agents, 'mc', 'offered');
check('weightedPct is Σmissed ÷ Σoffered, not (1.0% + 9.9%) ÷ 2',
  close(recomputed, 9.090909090909092), recomputed);
check('and it is demonstrably not the mean of the rates',
  !close(recomputed, 5.45, 0.01), recomputed);
check('a numerator of two fields is summed before the division (5 missed of 100 = 5%)',
  close(weightedPct([{ mc: 1, ab: 4, offered: 50 }, { mc: 0, ab: 0, offered: 50 }], ['mc', 'ab'], 'offered'), 5),
  weightedPct([{ mc: 1, ab: 4, offered: 50 }, { mc: 0, ab: 0, offered: 50 }], ['mc', 'ab'], 'offered'));
check('a single numerator key still works',
  close(weightedPct([{ ab: 4, offered: 100 }], 'ab', 'offered'), 4));
check('no denominator means 0%, not NaN or Infinity',
  weightedPct([{ mc: 3, offered: 0 }], 'mc', 'offered') === 0
    && Number.isFinite(weightedPct([{ mc: 3, offered: 0 }], 'mc', 'offered')));

console.log('\n== average columns are weighted by volume ==');
/*
 * A 60-second AHT on 1 call and a 120-second AHT on 99 calls is a 119.4-second
 * desk, not the 90-second midpoint. The dashboard's own AHT KPI already weighs
 * by inbound volume; the totals row must agree with the KPI above it.
 */
const aht = [{ ibAht: 60, ib: 1 }, { ibAht: 120, ib: 99 }];
const weightedAht = weightedMean(aht, 'ibAht', 'ib');
check('weightedMean weights by the volume column', close(weightedAht, 119.4), weightedAht);
check('and is not the plain mean of the two agents',
  !close(weightedAht, 90, 0.01), weightedAht);
check('rows with no weight fall back to a plain mean',
  close(weightedMean([{ ibAht: 60, ib: 0 }, { ibAht: 120, ib: 0 }], 'ibAht', 'ib'), 90),
  weightedMean([{ ibAht: 60, ib: 0 }, { ibAht: 120, ib: 0 }], 'ibAht', 'ib'));
check('a single agent with zero AHT does not drag the mean down',
  close(weightedMean([{ ibAht: 100, ib: 10 }, { ibAht: 0, ib: 0 }], 'ibAht', 'ib'), 100),
  weightedMean([{ ibAht: 100, ib: 10 }, { ibAht: 0, ib: 0 }], 'ibAht', 'ib'));
check('no rows at all is 0, not NaN', weightedMean([], 'ibAht', 'ib') === 0);

console.log('\n== a field can be a selector, for values one level down ==');
check('sumBy takes a selector (the DID grid reads calls.inbound)',
  sumBy([{ calls: { inbound: 3 } }, { calls: { inbound: 4 } }, {}], row => (row && row.calls ? row.calls.inbound : 0)) === 7,
  sumBy([{ calls: { inbound: 3 } }, { calls: { inbound: 4 } }, {}], row => (row && row.calls ? row.calls.inbound : 0)));
check('maxBy takes one too',
  maxBy([{ calls: { talk: 300 } }, { calls: { talk: 900 } }], row => (row.calls || {}).talk) === 900);
check('countBy takes one too',
  countBy([{ calls: { inbound: 3 } }, { calls: { inbound: 0 } }], row => (row.calls || {}).inbound) === 2);

console.log('\n== a field can be a selector, for values one level down ==');
check('sumBy takes a selector (the DID grid reads calls.inbound)',
  sumBy([{ calls: { inbound: 3 } }, { calls: { inbound: 4 } }, {}], row => (row && row.calls ? row.calls.inbound : 0)) === 7,
  sumBy([{ calls: { inbound: 3 } }, { calls: { inbound: 4 } }, {}], row => (row && row.calls ? row.calls.inbound : 0)));
check('maxBy takes one too',
  maxBy([{ calls: { talk: 300 } }, { calls: { talk: 900 } }], row => (row.calls || {}).talk) === 900);
check('countBy takes one too',
  countBy([{ calls: { inbound: 3 } }, { calls: { inbound: 0 } }], row => (row.calls || {}).inbound) === 2);

console.log('\n== a rate carries its base ==');
check('denomText states the base in words',
  denomText(34, 280, 'offered') === '34 of 280 offered', denomText(34, 280, 'offered'));
check('pctWithBase shows the rate and the base',
  pctWithBase(12.4, 34, 280, 'offered') === '12.4% (34 of 280 offered)',
  pctWithBase(12.4, 34, 280, 'offered'));
check('a rate with no base shows only the percentage',
  pctWithBase(0, 0, 0, 'offered') === '0.0%', pctWithBase(0, 0, 0, 'offered'));
check('0.0% is spelled out, never an empty cell',
  pctWithBase(0, 0, 10, 'answered') === '0.0% (0 of 10 answered)',
  pctWithBase(0, 0, 10, 'answered'));

console.log('');
if (failures.length) {
  console.log('TOTALS FAILED — ' + failures.length + ' check(s): ' + failures.join(' | '));
  process.exit(1);
}
console.log('TOTALS OK — totals rows add up and every rate keeps its base');
