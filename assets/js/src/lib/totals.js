/* Totals rows and the denominators behind every rate.
 *
 * The review's §5 is about trust rather than features:
 *
 *   1. a totals row on the agent, queue-stats and DID grids, computed from the
 *      rows ON SCREEN for the current filters — sums for counts and durations,
 *      recomputed weighted rates, never a mean of percentages;
 *   2. a rate without its base is how "best agent" turns out to be the person
 *      who took nine calls, so every rate card carries "34 of 280 offered".
 *
 * Both rules are arithmetic, not markup, so the arithmetic lives here — one
 * definition, used by every grid, next to the tests that prove a weighted rate
 * is not an average of rates (tests/js/totals.mjs).
 *
 * Every function treats a missing or non-numeric field as 0 rather than
 * propagating NaN into a published number: a grid with one broken row must not
 * blank its own total.
 */

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/*
 * A "field" is a field name, or a selector for a value that lives one level
 * down. `sumBy(rows, 'mc')` is the same call as `sumBy(rows, row => row.mc)`,
 * and the selector form is what the DID grid needs — its counts hang off
 * `row.calls.*`, one property deeper than every other grid.
 */
const reader = key => (typeof key === 'function' ? key : row => (row ? row[key] : 0));

/** Sum of one field across rows. */
function sumBy(rows, key) {
  const value = reader(key);
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => total + num(value(row)), 0);
}

/** Largest value of one field (the honest total for a "longest" column). */
function maxBy(rows, key) {
  const value = reader(key);
  return (Array.isArray(rows) ? rows : []).reduce((best, row) => Math.max(best, num(value(row))), 0);
}

/** How many rows have a non-empty value for a field — "3 agents", "5 sites". */
function countBy(rows, key) {
  const value = reader(key);
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const field = value(row);
    return field !== null && field !== undefined && String(field).trim() !== '';
  }).length;
}

/**
 * A weighted mean: Σ(value × weight) ÷ Σ(weight).
 *
 * This is the correct aggregate for every average column (AHT, AAT, ASAs): the
 * mean of per-agent averages would weight a nine-call agent the same as a
 * nine-hundred-call one. Falls back to a plain mean when no weights are usable,
 * so a grid with no counts still shows something rather than a zero.
 */
function weightedMean(rows, key, weightKey) {
  const list = Array.isArray(rows) ? rows : [];
  const value = reader(key);
  const weight = reader(weightKey);
  let weighted = 0;
  let total = 0;
  let plain = 0;
  let seen = 0;
  for (const row of list) {
    const v = num(value(row));
    const w = Math.max(0, num(weight(row)));
    weighted += v * w;
    total += w;
    if (v > 0) {
      plain += v;
      seen += 1;
    }
  }
  if (total > 0) return weighted / total;
  return seen > 0 ? plain / seen : 0;
}

/**
 * A recomputed percentage: Σ(numerator) ÷ Σ(denominator) × 100.
 *
 * Never the mean of the per-row percentages — the review's exact complaint.
 *
 * `numKey` may be one field or several: the missed-call rate's numerator is
 * missed + abandoned, and summing them first (rather than adding two finished
 * percentages) is the whole point.
 */
function weightedPct(rows, numKey, denKey) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = Array.isArray(numKey) ? numKey : [numKey];
  const den = sumBy(list, denKey);
  if (!(den > 0)) return 0;
  const numerator = keys.reduce((total, key) => total + sumBy(list, key), 0);
  return (numerator / den) * 100;
}

/**
 * "34 of 280 offered" — the base of a rate, for a card or a tooltip.
 *
 * `label` names the denominator in the reader's words ("offered", "answered"),
 * because "34 of 280" leaves the question the base was meant to answer.
 */
function denomText(numerator, denominator, label) {
  const n = num(numerator);
  const d = num(denominator);
  return n + ' of ' + d + (label ? ' ' + label : '');
}

/** A percentage with its base: "12.4% (34 of 280 offered)". */
function pctWithBase(percent, numerator, denominator, label) {
  const pct = num(percent);
  /* The review's rule for a percentage: always the base, unless there is none. */
  return pct.toFixed(1) + '%' + (num(denominator) > 0 ? ' (' + denomText(numerator, denominator, label) + ')' : '');
}

export { countBy, denomText, maxBy, pctWithBase, sumBy, weightedMean, weightedPct };
