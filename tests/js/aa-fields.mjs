/**
 * Unit tests for the Auto-Attendant report's CDR field readers.
 *
 * These were closures inside AutoAttendantReport until QA-11 moved them to
 * lib/aa-call-fields.js. Importing the module directly (no bundle, no jsdom)
 * is the point of the move: the fallback order can be pinned exactly.
 */
import * as f from '../../assets/js/src/lib/aa-call-fields.js';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

console.log('== aa-call-fields: value() fallback order ==');
check('first present key wins', f.value({a: '1', b: '2'}, 'a', 'b') === '1');
check('a blank value does not shadow a later key', f.value({a: '  ', b: '2'}, 'a', 'b') === '2');
check('null/undefined are skipped', f.value({a: null, b: undefined, c: '3'}, 'a', 'b', 'c') === '3');
check('nothing matches -> empty string', f.value({}, 'a') === '');
check('zero and false are values, not blanks', f.value({a: 0}, 'a') === 0 && f.value({a: false}, 'a') === false);

console.log('\n== normalised name first, raw PBX field last ==');
check('caller: caller > origCaller > call-orig-caller-id',
  f.getCaller({caller: 'A'}) === 'A' &&
    f.getCaller({origCaller: 'B'}) === 'B' &&
    f.getCaller({'call-orig-caller-id': 'C'}) === 'C');
check('start: start > call-start-datetime',
  f.getStart({start: 'S'}) === 'S' &&
    f.getStart({'call-start-datetime': 'RAW'}) === 'RAW');
check('answer: answer > call-answer-datetime',
  f.getAnswer({answer: 'A'}) === 'A' &&
    f.getAnswer({'call-answer-datetime': 'RAW'}) === 'RAW');
check('end: end > call-disconnect-datetime',
  f.getEnd({end: 'E'}) === 'E' &&
    f.getEnd({'call-disconnect-datetime': 'RAW'}) === 'RAW');
check('a blank normalised field falls through to the raw one',
  f.getTalkSeconds({talkSeconds: '  ', 'call-talking-duration-seconds': '42'}) === 42);

console.log('\n== trimming and coercion ==');
check('getCase/getQueue/getDestination trim', 
  f.getCase({case: '  1 '}) === '1' && f.getQueue({queue: ' 700 '}) === '700' &&
    f.getDestination({destination: ' Sales '}) === 'Sales');
check('getDisconnectReason trims', f.getDisconnectReason({disconnectReason: ' Orig: Bye '}) === 'Orig: Bye');
check('durations coerce, junk -> 0',
  f.getTalkSeconds({talkSeconds: '42'}) === 42 &&
    f.getTalkSeconds({talkSeconds: 'x'}) === 0 &&
    f.getTotalSeconds({'call-total-duration-seconds': '90'}) === 90);
check('direction is numeric', f.getDirection({'call-direction': '1'}) === 1);

console.log('\n== additional tier ==');
check('tier present -> true', f.isAdditionalTier({additionalTier: '2'}) === true);
check('blank tier -> false', f.isAdditionalTier({additionalTier: ' '}) === false);
check('missing tier -> false', f.isAdditionalTier({}) === false);
check('getAdditionalCase trims', f.getAdditionalCase({additionalCase: ' 7 '}) === '7');

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAA FIELDS OK — the extracted readers keep their contract');
process.exit(0);
