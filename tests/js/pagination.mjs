/**
 * Unit tests for the call list's pagination arithmetic.
 *
 * buildPages/clampPage/recordRangeLabel were closures inside the 1,140-line
 * CallModal; the ellipsis window in particular had no test at all, and it is
 * the kind of code that only misbehaves on page 4 of 7. tests/js/smoke.mjs
 * drives the real footer on top of this.
 */
import { PAGE_SIZES, buildPages, clampPage, recordRangeLabel } from '../../assets/js/src/lib/pagination.js';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  }
};
const shape = pages => pages.map(p => (typeof p === 'string' ? '…' : p)).join(' ');

console.log('== page size choices ==');
check('the footer offers the same four sizes, ascending',
  PAGE_SIZES.join(',') === '10,25,50,100', PAGE_SIZES);

console.log('\n== seven pages or fewer are all shown ==');
check('one page', shape(buildPages(1, 1)) === '1', shape(buildPages(1, 1)));
check('seven pages', shape(buildPages(7, 4)) === '1 2 3 4 5 6 7', shape(buildPages(7, 4)));
check('no ellipsis is ever emitted when the window fits',
  buildPages(7, 1).every(p => typeof p === 'number'));

console.log('\n== ten pages, near the beginning (page <= 4) ==');
check('page 1', shape(buildPages(10, 1)) === '1 2 3 4 5 … 10', shape(buildPages(10, 1)));
check('page 4 still counts as "near the beginning"',
  shape(buildPages(10, 4)) === '1 2 3 4 5 … 10', shape(buildPages(10, 4)));
check('page 5 moves to the windowed form',
  shape(buildPages(10, 5)) === '1 … 4 5 6 … 10', shape(buildPages(10, 5)));

console.log('\n== ten pages, near the end (page >= totalPages - 3) ==');
check('page 7', shape(buildPages(10, 7)) === '1 … 6 7 8 9 10', shape(buildPages(10, 7)));
check('the last page has one leading ellipsis and no trailing one',
  shape(buildPages(10, 10)) === '1 … 6 7 8 9 10', shape(buildPages(10, 10)));

console.log('\n== the shape holds for an arbitrary page count ==');
const middle = buildPages(40, 20);
check('the first and last page are always present',
  middle[0] === 1 && middle[middle.length - 1] === 40, middle);
check('the current page is always present', middle.includes(20), middle);
check('never more than five numbers plus two markers',
  middle.length <= 7, middle);
check('the markers are the two the footer renders',
  buildPages(40, 20).filter(p => typeof p === 'string').join(',') === 'ellipsis-left,ellipsis-right',
  buildPages(40, 20).filter(p => typeof p === 'string'));
check('numbers stay strictly ascending',
  buildPages(40, 20).filter(p => typeof p === 'number').every((n, i, arr) => i === 0 || n > arr[i - 1]));

console.log('\n== clampPage ==');
check('a page below the range becomes the first page', clampPage(0, 9) === 1 && clampPage(-5, 9) === 1);
check('a page above the range becomes the last page', clampPage(10, 9) === 9 && clampPage(1e6, 9) === 9);
check('a page inside the range is left alone', clampPage(4, 9) === 4);
check('a single page stays a single page', clampPage(3, 1) === 1);

console.log('\n== record range wording ==');
check('an empty result says 0 of 0', recordRangeLabel(0, 0, 0) === 'Showing 0 of 0', recordRangeLabel(0, 0, 0));
check('the first page starts at 1 and uses an en dash',
  recordRangeLabel(1234, 0, 25) === 'Showing 1–25 of 1,234', recordRangeLabel(1234, 0, 25));
check('a later page reports its own first row',
  recordRangeLabel(1234, 25, 50) === 'Showing 26–50 of 1,234', recordRangeLabel(1234, 25, 50));
check('a partial last page ends on the last record',
  recordRangeLabel(1234, 1225, 1234) === 'Showing 1226–1234 of 1,234', recordRangeLabel(1234, 1225, 1234));

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPAGINATION OK — the footer arithmetic is pinned');
process.exit(0);
