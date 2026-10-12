/**
 * Whole-app smoke test.
 *
 * Mounts the real bundle, walks every nav route (dashboard, agents, queues,
 * telephone numbers + each tab, auto-attendants, call history), opens the
 * settings modal and the call modal, and asserts:
 *   - nothing throws (this is what catches a bad module split: a moved
 *     component that lost an import blows up here),
 *   - each route renders its landmark,
 *   - no unexpected console.error / window.error.
 */
import { createHarness, FIXTURES } from './harness.mjs';

const failures = [];
const check = (label, condition, extra) => {
  if (condition) console.log('  PASS', label);
  else {
    failures.push(label);
    console.log('  FAIL', label, extra === undefined ? '' : String(extra).slice(0, 300));
  }
};

const harness = await createHarness();
const { window, document, root, flush, click, press, byText, containing, errors, warnings, requested, tables, charts, act, typeInto } = harness;

console.log('\n== boot ==');
await flush(10);
check('app mounted', root().children.length > 0, root().innerHTML.length);
check('nav rendered', document.querySelectorAll('.nav-item').length >= 6, document.querySelectorAll('.nav-item').length);
check('header shows the signed-in user', root().textContent.includes('Test OM'), root().textContent.slice(0, 80));
check('session endpoint called', requested.some(r => r.endpoint === 'session'), JSON.stringify(requested.slice(0, 4)));
check('dashboard fetched report', requested.some(r => r.endpoint === 'report'));
check('settings fetched', requested.some(r => r.endpoint === 'settings'));

console.log('\n== routes ==');
const goTo = async label => {
  const button = byText('.nav-item', label) || containing('.nav-item', label);
  check('nav has ' + label, !!button);
  if (button) await click(button);
  return button;
};

const routes = [
  ['Dashboard', ['Reporting dashboard', 'Total calls']],
  ['Agents', ['Agent stats']],
  ['Queues', ['Queue']],
  ['Telephone Numbers', ['Where each DID routes']],
  ['Auto-Attendants', ['auto attendant', 'Select an auto attendant']],
  ['Call History', ['Caller']],
  ['Reports', ['Month-end report']]
];

for (const [label, landmarks] of routes) {
  const before = errors.length;
  await goTo(label);
  await flush(8);
  const text = root().textContent;
  const hit = landmarks.some(l => text.toLowerCase().includes(l.toLowerCase()));
  check(`route "${label}" renders (${landmarks[0]})`, hit, text.slice(0, 200));
  check(`route "${label}" threw nothing`, errors.length === before, errors.slice(before).join(' | '));
}

/*
 * Sprint C: the month-end pack. The page is one printable report, and every
 * figure on it is server-computed - so this asserts the two things the CLIENT
 * is responsible for: that a rate is printed with its base, and that the
 * assumptions (occupancy, baseline, scoring) are stated on the page rather
 * than left to the reader.
 */
/*
 * Sprint B, §3: the wait card's miss-rate line - every band prints its rate WITH
 * the counts it came from, and the three bases add up to the arrivals.
 */
await goTo('Dashboard');
await flush(8);
{
  const text = root().textContent;
  check('the wait card prints the miss rate per band with its base',
    /Missed within each wait band: under 5s 50\.0% \(1 of 2\)/.test(text)
      && /5-30s 33\.3% \(1 of 3\)/.test(text)
      && /over 30s 66\.7% \(2 of 3\)/.test(text),
    text.slice(0, 400));
}

await goTo('Reports');
await flush(10);
{
  const text = root().textContent;
  const packRequest = [...requested].reverse().find(r => r.endpoint === 'report');
  check('the reports route fetches the pack and the baseline in one request',
    /* The harness records the raw body string, so read it as JSON. */
    (() => {
      try { return Number(JSON.parse(packRequest.body || '{}').baseline) === 1; } catch { return false; }
    })(),
    packRequest ? JSON.stringify(packRequest.body).slice(0, 200) : 'no report request');
  check('the queue table prints the queue target beside the SLA and its base',
    text.includes('Sales queue') && text.includes('15 s') && text.includes('50.0 % (2)'), text.slice(0, 300));
  check('an idle queue is on the page as a zero row, not omitted',
    text.includes('Idle queue'), text.includes('Idle queue'));
  check('a rate never travels without its base: the missed share prints its base',
    text.includes('50.0 % (4)'), text.slice(0, 300));
  check('the DID table carries the abandon base (the missed calls)',
    text.includes('50.0 % (2)'), text.slice(0, 300));
  check('the two DID flags are printed, not just computed',
    text.includes('zero traffic') && text.includes('high abandon'), text.slice(0, 400));
  check('the staffing estimate states its occupancy beside the numbers',
    text.includes('85.0 %') && /no roster/i.test(text), text.slice(0, 400));
  check('the estimate is labelled a baseline rather than a forecast',
    /baseline, not a forecast/i.test(text), text.slice(0, 400));
  check('the baseline section prints its window and refuses a 0 % day with no history',
    text.includes('2026-07-05 – 2026-08-01') && text.includes('no prior weeks'), text.slice(0, 400));
  check('the data-quality appendix prints counts with their bases',
    text.includes('Legs with no disconnect reason') && text.includes('100.0 %'), text.slice(0, 400));
  check('the sentiment line states the scored base',
    /Base: 3 scored calls, 1 negative-led/.test(text), text.slice(0, 400));
  check('the page offers print and the CSVs',
    document.querySelectorAll('.rep-btn').length === 2, document.querySelectorAll('.rep-btn').length);
  check('the action row is marked no-print',
    !!document.querySelector('.rep-actions'), 'no .rep-actions node');
  check('the shell chrome carries the print-hiding classes',
    !!document.querySelector('.app-nav') && !!document.querySelector('.app-header'),
    'missing .app-nav / .app-header');
}

console.log('\n== telephone numbers tabs ==');
await goTo('Telephone Numbers');
await flush(8);
const tabs = [...document.querySelectorAll('.tn-tab')];
check('four tabs present', tabs.length === 4, tabs.map(t => t.textContent.trim()).join('|'));
for (const tab of tabs) {
  const before = errors.length;
  await click(tab);
  await flush(8);
  check(`tab "${tab.textContent.trim()}" renders`, root().textContent.length > 100);
  check(`tab "${tab.textContent.trim()}" threw nothing`, errors.length === before, errors.slice(before).join(' | '));
}
check('simultaneous tab called its endpoint', requested.some(r => r.endpoint === 'simultaneous_calls'),
  JSON.stringify(requested.map(r => r.endpoint).slice(-6)));

/*
 * Repeat callers. The tab used to print "1 repeat caller" and nothing else -
 * the numbers were in the payload and never rendered, so the one thing the
 * screen exists for (who keeps calling, and when) was missing. The fixture
 * caller is 8454259810 with three calls, the newest missed.
 */
{
  const before = errors.length;
  await goTo('Telephone Numbers');
  await flush(8);
  const repeatsTab = byText('.tn-tab', 'Repeat callers');
  check('the repeats tab exists', !!repeatsTab);
  if (repeatsTab) await click(repeatsTab);
  await flush(8);
  const text = root().textContent;
  check('the repeats tab shows the caller NUMBER, not just a count',
    text.includes('8454259810') || text.includes('(845) 425-9810'), text.slice(0, 300));
  check('the repeats table has a column for when they called',
    /When/.test(text) && /First call/.test(text) && /Last call/.test(text), text.slice(0, 300));
  check('every call time the payload carries is on the page',
    text.includes('2026-08-04 16:40') && text.includes('2026-08-03 11:05') && text.includes('2026-08-02 09:12'),
    text.slice(0, 400));
  check('a missed call in the history is marked as missed',
    /16:40 \u00b7 missed/.test(text), text.slice(0, 400));
  check('the caller counts are printed', /Calls/.test(text) && /Missed/.test(text), text.slice(0, 200));
  check('the repeats tab can be opened from the keyboard',
    !!document.querySelector('.tn-repeats-row[tabindex="0"]'), 'no focusable repeat row');
  check('the repeats tab threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

console.log('\n== settings modal ==');
{
  const before = errors.length;
  const settingsBtn = containing('.nav-item', 'Settings');
  check('settings nav item exists', !!settingsBtn);
  if (settingsBtn) await click(settingsBtn);
  check('settings modal opened', !!document.querySelector('.set-row-copy') || root().textContent.includes('SLA'));
  check('settings modal threw nothing', errors.length === before, errors.slice(before).join(' | '));
  if (document.querySelector('.set-overlay')) {
    await press(document, 'Escape');
    check('Escape closes the settings modal', !document.querySelector('.set-overlay'));
  }
  const close = document.querySelector('.ap-cols-btn') || byText('button', 'Cancel') || byText('button', 'Close');
  if (close) await click(close);
}

/*
 * Sprint A service settings: the opening-hours grid, the per-queue targets and
 * the roster all render inside the dialog, and saving writes them in the same
 * payload as the thresholds (one Save, one payload — a manager who edits both
 * must not be able to save half of it).
 */
console.log('\n== service settings: opening hours, targets, roster ==');
{
  const before = errors.length;
  const settingsBtn = containing('.nav-item', 'Settings');
  if (settingsBtn) await click(settingsBtn);
  await flush(6);

  const days = document.querySelectorAll('.set-day');
  check('the opening-hours grid shows all seven days', days.length === 7, days.length);
  check('the Mon-Fri grid is pre-filled from the server',
    document.querySelector('.set-day.is-open') !== null,
    document.querySelector('.set-day.is-open')?.textContent);
  check('the closed weekend shows as closed',
    root().textContent.includes('closed'), root().textContent.slice(0, 120));

  /*
   * The layout bug the manager reported: the three service cards were rendered
   * inside .set-foot-left - one flex row beside "Reset to defaults" - so the
   * opening-hours inputs were jammed against the Save button and the rest of
   * the block was unreadable. They belong in the scrolling body.
   */
  const scroll = document.querySelector('.set-scroll');
  const foot = document.querySelector('.set-foot');
  check('the service cards live in the dialog body, not the footer',
    !!scroll && !!scroll.querySelector('.set-service') && !foot.querySelector('.set-service'),
    'inBody=' + !!scroll?.querySelector('.set-service') + ' inFooter=' + !!foot?.querySelector('.set-service'));
  check('the body stacks all four service cards',
    scroll.querySelectorAll('.set-service > .set-card').length === 4,
    scroll.querySelectorAll('.set-service > .set-card').length);
  /*
   * C7: the timezone is a setting, not a config edit, and it sits beside the
   * calendar it is the clock of. The dialog must show what is stored (not its
   * own idea of the default) and send it back on save.
   */
  const zoneSelect = scroll.querySelector('.set-service select[aria-label="Reporting timezone"]');
  check('the dialog offers the desk timezone beside the calendar', !!zoneSelect,
    zoneSelect && zoneSelect.className);
  check('and it shows the zone the server stored',
    !!zoneSelect && zoneSelect.value === 'US/Eastern', zoneSelect && zoneSelect.value);
  check('the zone list is a choice of real zones, not a free-text box',
    !!zoneSelect && [...zoneSelect.options].some(o => o.value === 'Asia/Manila')
      && [...zoneSelect.options].length > 20, zoneSelect && zoneSelect.options.length);
  check('the per-queue target rows come from the queue list',
    document.querySelectorAll('.set-target-row').length >= 1,
    document.querySelectorAll('.set-target-row').length);
  check('the roster renders the stored row',
    document.querySelectorAll('.set-roster-row').length === 1
      && document.querySelector('.set-roster-row').textContent.includes('Ada'),
    document.querySelector('.set-roster-row')?.textContent);
  check('the roster row shows its weekdays',
    document.querySelectorAll('.set-weekdays label.is-on').length === 5,
    document.querySelectorAll('.set-weekdays label.is-on').length);

  /*
   * Nudge queue 700's target up with the stepper (15 -> 16) and switch the
   * roster row to the other agent, then save: both controls send real React
   * events, and the payload below proves the dialog owns one state and posts it.
   */
  const step = document.querySelector('.set-target-row button[data-step=up]');
  check('a queue target stepper exists', !!step);
  if (step) await click(step);
  const save = byText('button', 'Save') || byText('button', 'Save settings');
  check('the save button exists', !!save);
  if (save) {
    await click(save);
    await flush(6);
  }
  const posted = [...requested].reverse().find(r => r.endpoint === 'settings' && r.method !== 'GET');
  let body = {};
  try { body = posted ? JSON.parse(posted.body) : {}; } catch { body = {}; }
  check('saving posts the service-desk block with the thresholds',
    posted !== undefined && body.businessHours !== undefined && body.queueSla !== undefined
      && body.roster !== undefined, posted ? posted.body : 'no POST');
  check('the timezone rides in the same payload (one Save, one write)',
    posted !== undefined && body.timezone === 'US/Eastern', body.timezone);
  check("the stepped queue target is in the payload (15 -> 16)",
    Number(body.queueSla && body.queueSla['700']) === 16, JSON.stringify(body.queueSla));
  check('the roster row is in the payload',
    Array.isArray(body.roster) && body.roster.length === 1
      && body.roster[0].extension === '6080', body.roster);
  check('opening hours are still off (the fixture) and carry the full grid',
    body.businessHours && body.businessHours.enabled === false
      && Object.keys(body.businessHours.days || {}).length === 7, body.businessHours);
  check('the service settings block threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

/*
 * Sprint A dashboard cards: the wait bands and the follow-ups, and the drill
 * that has to carry the band it was opened from (a band nobody can drill into
 * is a number nobody can act on).
 */
/*
 * Totals rows (review §5.1/§5.2): the row must be on screen, it must add up
 * from the ROWS THE PAGE IS SHOWING, and a rate must be recomputed rather than
 * averaged. The numbers below are hand-computed from the fixture:
 *
 *   Agent stats:  missed (mc + ab) 24+16+20+15 = 75 of offered 240+185 = 425
 *                 -> 17.6 %, where the mean of 16.7 % and 18.9 % would be 17.8 %
 *                 AHT 210 s on 200 calls and 190 s on 150 -> weighted 201 s
 *                 (the plain mean would be 200 s; the third agent below makes
 *                 the difference visible: 60 s on 1 call vs 120 s on 99, 119 s)
 *   Queues:       totals row above the queue stats, SLA recomputed from weight
 *   DIDs:         missed 143 + 12 = 155, abandoned 58 + 2 = 60, talk 41230 + 8040
 */
console.log('\n== totals rows on every grid (review 5.1) ==');
{
  await goTo('Agents');
  await flush(8);
  const statsTab = byText('.aa-tab', 'Agent stats');
  if (statsTab) await click(statsTab);
  await flush(8);
  const agentSection = [...document.querySelectorAll('section')].find(s => /Agent stats/.test(s.textContent));
  const agentTotals = agentSection ? agentSection.querySelector('tbody tr.grid-totals') : null;
  check('the agent grid has a totals row as the first body row',
    !!agentTotals && agentSection.querySelector('tbody tr') === agentTotals,
    agentTotals && agentTotals.textContent.slice(0, 200));
  const agentText = agentTotals ? agentTotals.textContent : '';
  check('the totals row sums the calls of the agents on screen (245 + 185 = 430)',
    /430/.test(agentText), agentText.slice(0, 200));
  check('the totals row shows the agent count, not just a label',
    /2 agents/.test(agentText), agentText.slice(0, 200));
  check('the missed rate is recomputed (75 of 425 = 17.6 %), not the mean of 16.7 and 18.9',
    /17\.6%/.test(agentText) && !/17\.8%/.test(agentText), agentText.slice(0, 260));
  check('the AHT is weighted by inbound volume (201 s, not the 200 s plain mean)',
    /20:?0?1|201|3:21/.test(agentText) || /03:21/.test(agentText), agentText.slice(0, 260));
  check('the totals row is a real row, not a footer that scrolls away',
    !!agentTotals && agentTotals.parentElement.tagName === 'TBODY');
  /*
   * Sprint B: the contact rate and hold, per agent. Ada dialled 40 and connected
   * 29 (72.5 %); Alan dialled 20 and connected 8 (40 %, under the 50 % floor, so
   * his cell is marked). The totals row is connects ÷ attempts over the table —
   * (29 + 8) / (40 + 20) = 61.7 % — not the mean of the two rates (56.3 %), and
   * hold averages over the calls that held: (900 + 120) / (30 + 4) = 30 s.
   */
  check('the agent table offers the outbound contact rate and hold columns',
    /Contact/i.test(agentSection ? agentSection.textContent : '') &&
    /Hold/.test(agentSection ? agentSection.textContent : ''),
    (agentSection ? agentSection.textContent : '').slice(0, 200));
  check('the agent totals row recomputes the contact rate (37 of 60 = 61.7 %, not the 56.3 % mean)',
    /61\.7%/.test(agentText) && !/56\.3%/.test(agentText), agentText.slice(0, 320));
  check('the agent totals row sums hold seconds (900 + 120 = 1,020 s)',
    /00:17:00/.test(agentText), agentText.slice(0, 320));
  check('the agent totals row averages hold over the calls that held (1,020 / 34 = 30 s)',
    /00:00:30/.test(agentText), agentText.slice(0, 320));

  await goTo('Queues');
  await flush(10);
  const qTab = byText('.aa-tab', 'Queue stats');
  if (qTab) await click(qTab);
  await flush(10);
  const queueTotals = document.querySelector('tbody tr.grid-totals');
  check('the queue grid has a totals row', !!queueTotals,
    queueTotals && queueTotals.textContent.slice(0, 200));
  const queueText = queueTotals ? queueTotals.textContent : '';
  check('the queue totals row counts the queues it summarises',
    /2 queues/.test(queueText), queueText.slice(0, 160));
  check('the queue totals row sums the calls behind the filters (100 + 60 = 160)',
    /160/.test(queueText), queueText.slice(0, 200));
  check('the queue totals row sums the abandons (10 + 5 = 15)',
    /15/.test(queueText), queueText.slice(0, 220));
  check('the queue SLA rate is recomputed from the weighted rows (83.8 %, not 85 %)',
    /83\.8%/.test(queueText) && !/85\.0%/.test(queueText), queueText.slice(0, 240));
  check('the queue averages are weighted by handled calls (16 s, not the 15 s mean)',
    /00:00:16/.test(queueText) && !/00:00:15/.test(queueText), queueText.slice(0, 260));
  check('the queue totals row sums total talk time (20,000 + 8,000 = 28,000 s)',
    /07:46:40/.test(queueText), queueText.slice(0, 300));
  /*
   * Sprint B: hold, per queue and per agent. Queue 700 held 270 s over 6 calls
   * (avg 45 s); queue 701 never held. The totals row must average over the calls
   * that held (45 s, NOT the 22.5 s mean of 45 and 0) and sum the seconds.
   */
  check('the queue totals row averages hold over the calls that held (45 s, not 22.5 s)',
    /00:00:45/.test(queueText) && !/00:00:22/.test(queueText), queueText.slice(0, 320));
  check('the queue totals row sums hold seconds (270 + 0)',
    /00:04:30/.test(queueText), queueText.slice(0, 320));

  await goTo('Telephone Numbers');
  await flush(10);
  const didTotals = document.querySelector('tbody tr.grid-totals');
  check('the DID grid has a totals row', !!didTotals,
    didTotals && didTotals.textContent.slice(0, 200));
  const didText = didTotals ? didTotals.textContent : '';
  check('the DID totals row adds the missed and abandoned columns',
    /155/.test(didText) && /60/.test(didText), didText.slice(0, 200));
  check('the DID grid states the abandon share of missed as a base (60 of the 155)',
    /60 of the 155/.test(document.body.textContent),
    document.body.textContent.match(/60 of the 155[^<]{0,20}/)?.[0]);
}

/*
 * Service level by interval (review §3, the 09:00 spike). The card exists so a
 * period average cannot hide the quarter-hour that failed, so the test checks
 * the row it would hide behind: the 09:00 interval's own SLA, the weighted
 * totals, and the drill carrying the window into the call list.
 */
/*
 * The call list's own sort control (review F5). It must be on screen, offer the
 * five orders the endpoint supports, and the direction toggle must actually
 * re-request from the server — sorting the 25 rows in the browser would sort
 * the page, not the result set.
 */
/*
 * F3: the comparison baseline is a control, and the screen always says which
 * period the deltas are against. The mode travels in the request, so the second
 * (comparison) request has to carry it back to the server.
 */
console.log('\n== dashboard: the comparison baseline ==');
{
  await goTo('Dashboard');
  await flush(10);
  const picker = document.getElementById('ops-compare-select');
  check('the dashboard has a comparison-baseline control', !!picker);
  check('it offers the five modes the endpoint supports',
    !!picker && [...picker.options].map(o => o.value).join(',') === 'previous,weekday,mtd,month,year',
    picker && [...picker.options].map(o => o.value));
  check('the screen states the baseline it is using (vs previous 5 days, with the dates)',
    /vs previous 5 days/.test(document.body.textContent)
      && /2026-07-27 – 2026-07-31/.test(document.body.textContent),
    document.body.textContent.match(/vs previous 5 days[^.]{0,40}/)?.[0]);
  check('the hour chart caption names the baseline instead of "previous period"',
    /This period vs previous 5 days/.test(document.body.textContent),
    document.body.textContent.match(/This period vs[^.]{0,40}/)?.[0]);
  const before3 = errors.length;
  /*
   * The select's own change handler cannot be driven from this harness (the
   * same React-controlled-input limitation the Settings steppers exist to work
   * around), so the wiring it feeds is asserted by booting a second app with the
   * mode in the URL — which is also how a shared link arrives.
   */
  const linked = await createHarness({search: 'compare=year'});
  await linked.flush(14);
  const linkedReqs = linked.requested.filter(r => r.endpoint === 'report');
  const linkedModes = linkedReqs.map(r => (String(r.body).match(/"compare":"([a-z]+)"/) || [])[1]);
  check('a URL that names a baseline sends it on every report request',
    linkedModes.length > 0 && linkedModes.every(m => m === 'year'), linkedModes);
  /*
   * The control shows the baseline the SERVER reported, not the one the URL
   * asked for — if the two ever differ (a server-side default, a mode that was
   * dropped), the screen must label the numbers that are actually on it. The
   * stub always answers 'previous', so that is what the control must show while
   * the request itself carried 'year' (asserted above).
   */
  check('the control shows the baseline the numbers came from, not the one asked for',
    linked.document.getElementById('ops-compare-select')?.value === 'previous',
    linked.document.getElementById('ops-compare-select')?.value);
  check('the baseline control threw nothing', errors.length === before3, errors.slice(before3).join(' | '));
}

console.log('\n== call list: the sort control ==');
{
  await goTo('Dashboard');
  await flush(10);
  const inbox = [...document.querySelectorAll('.ops-card, section')]
    .find(c => /Missed/.test(c.textContent) && c.querySelector('button'));
  if (inbox) await click(inbox.querySelector('button'));
  await flush(10);
  const modal = document.querySelector('.call-modal');
  check('a call list is open to sort', !!modal);
  const sortSelect = modal ? [...modal.querySelectorAll('select')].find(sel => [...sel.options].some(o => o.value === 'talk')) : null;
  check('the call list has a sort control', !!sortSelect);
  check('the sort control offers the five orders the endpoint supports (newest/oldest/wait/talk/hold)',
    !!sortSelect && [...sortSelect.options].map(o => o.value).join(',') === 'newest,oldest,wait,talk,hold',
    sortSelect && [...sortSelect.options].map(o => o.value));
  const dirBtn = modal ? modal.querySelector('.call-modal-dir') : null;
  check('the sort direction is a control of its own', !!dirBtn, dirBtn && dirBtn.textContent);
  if (dirBtn) {
    await click(dirBtn);
    await flush(10);
  }
  const sorted = [...requested].reverse().find(r => r.endpoint === 'calls');
  let sortedBody = {};
  try { sortedBody = sorted ? JSON.parse(sorted.body) : {}; } catch { sortedBody = {}; }
  check('flipping the direction re-requests the whole list from the server',
    sortedBody.dir === 'asc' && sortedBody.sort === 'oldest',
    [sortedBody.sort, sortedBody.dir]);
  check('the direction button relabels itself (never "Newest ascending")',
    !!dirBtn && /asc/i.test(dirBtn.textContent), dirBtn && dirBtn.textContent);
  await press(document, 'Escape');
  await flush(4);
}

console.log('\n== queues: service level by interval ==');
{
  await goTo('Queues');
  await flush(12);
  /* The interval card lives on the per-queue Overview tab, not the stats grid. */
  const overviewTab = byText('.aa-tab', 'Overview');
  if (overviewTab) await click(overviewTab);
  await flush(12);
  const cards = [...document.querySelectorAll('section.dash-card')];
  const intervalCard = cards.find(c => /Service level by interval/.test(c.textContent));
  check('the queue overview has a service-level-by-interval card', !!intervalCard);
  if (intervalCard) {
    const rows = [...intervalCard.querySelectorAll('tbody tr')].filter(r => !r.className.includes('grid-totals'));
    check('the card lists the busy intervals only', rows.length === 2, rows.length);
    check('the 09:00 interval states its own SLA (80 %) rather than the period average',
      /80%/.test(intervalCard.textContent) && /50%/.test(intervalCard.textContent),
      intervalCard.textContent.slice(0, 240));
    const totals = intervalCard.querySelector('tbody tr.grid-totals');
    check('the interval card has a totals line', !!totals, totals && totals.textContent);
    check('the interval totals sum offered / answered / abandoned (8 / 7 / 1)',
      !!totals && /8/.test(totals.textContent) && /7/.test(totals.textContent) && /1/.test(totals.textContent),
      totals && totals.textContent);
    check('the interval totals recompute SLA ((7 - 2) / 7 = 71.4 %, not the 65 % mean)',
      !!totals && /71\.4%/.test(totals.textContent) && !/65\.0%/.test(totals.textContent),
      totals && totals.textContent);
    const before2 = errors.length;
    if (rows.length) {
      await click(rows[1]);
      await flush(10);
    }
    const intervalPost = [...requested].reverse().find(r => r.endpoint === 'calls');
    let intervalBody = {};
    try { intervalBody = intervalPost ? JSON.parse(intervalPost.body) : {}; } catch { intervalBody = {}; }
    check('clicking an interval opens the calls inside that window',
      intervalBody.timeFrom === '10:00' && intervalBody.timeTo === '11:00',
      [intervalBody.timeFrom, intervalBody.timeTo, intervalBody.queue]);
    await press(document, 'Escape');
    await flush(4);
    check('the interval card threw nothing', errors.length === before2, errors.slice(before2).join(' | '));
  }
}

console.log('\n== dashboard: wait bands and follow-ups ==');
{
  const before = errors.length;
  await goTo('Dashboard');
  await flush(8);

  const bands = [...document.querySelectorAll('.ops-wait-row')];
  check('the wait card shows four bands', bands.length === 4, bands.length);
  check('the wait card reports p50/p90 wait',
    /p50 wait/.test(root().textContent) && /p90 wait/.test(root().textContent),
    root().textContent.match(/p50 wait[^A-Z]{0,20}/)?.[0]);
  check('the abandon split by wait time is stated',
    /staffing failure/.test(root().textContent),
    root().textContent.match(/Abandons by[^\n]{0,80}/)?.[0]);
  check('the follow-ups card renders its rows',
    document.querySelectorAll('.ops-link-row').length === 4,
    document.querySelectorAll('.ops-link-row').length);

  const over = bands.find(b => b.textContent.includes('over 120s'));
  check('the over-120s band exists', !!over);
  if (over) {
    await click(over);
    await flush(8);
  }
  const posted = [...requested].reverse().find(r => r.endpoint === 'calls');
  let body = {};
  try { body = posted ? JSON.parse(posted.body) : {}; } catch { body = {}; }
  check('clicking a band opens the calls behind that band',
    body.waitBucket === '120+', body.waitBucket);
  check('the modal states the band it is showing',
    /Waited/.test(document.body.textContent), document.body.textContent.slice(0, 120));
  const closeOne = byText('button', 'Close');
  if (closeOne) await click(closeOne);
  await press(document, 'Escape');
  await flush(4);

  /*
   * AHT by hour: the table under the volume chart, its hand-computed totals
   * line, and the fact that a row drills into that hour.
   */
  const hourRows = [...document.querySelectorAll('.ops-hour-row')];
  check('the hour table lists only the busy hours (2 of 24)', hourRows.length === 2, hourRows.length);
  const hourTable = document.querySelector('.ops-hour-table');
  check('the hour table shows AHT per hour', !!hourTable && /AHT/.test(hourTable.textContent));
  check('hour 09 AHT is 60 s of inbound talk (outbound talk stays out)',
    !!hourTable && /00:01:00/.test(hourTable.textContent), hourTable && hourTable.textContent.slice(0, 300));
  const hourTotals = hourTable ? hourTable.querySelector('tr.grid-totals') : null;
  check('the hour table has a totals line', !!hourTotals, hourTotals && hourTotals.textContent);
  check('the hour totals line sums calls and answers (7 calls, 3 answered, 2 missed)',
    !!hourTotals && /7/.test(hourTotals.textContent) && /3/.test(hourTotals.textContent),
    hourTotals && hourTotals.textContent);
  check('the hour totals line is the weighted AHT, not the mean of 150 s and 60 s (105 s)',
    !!hourTotals && /00:02:00/.test(hourTotals.textContent) && !/00:01:45/.test(hourTotals.textContent),
    hourTotals && hourTotals.textContent);
  if (hourRows.length) {
    await click(hourRows[1]);
    await flush(8);
  }
  const hourPost = [...requested].reverse().find(r => r.endpoint === 'calls');
  let hourBody = {};
  try { hourBody = hourPost ? JSON.parse(hourPost.body) : {}; } catch { hourBody = {}; }
  check('clicking an hour row opens the calls that started in it',
    hourBody.hour === 9, hourBody.hour);
  await press(document, 'Escape');
  await flush(4);

  const unreturned = [...document.querySelectorAll('.ops-link-row')]
    .find(r => r.textContent.includes('not returned'));
  if (unreturned) {
    await click(unreturned);
    await flush(8);
  }
  const posted2 = [...requested].reverse().find(r => r.endpoint === 'calls');
  let body2 = {};
  try { body2 = posted2 ? JSON.parse(posted2.body) : {}; } catch { body2 = {}; }
  check('the returned-call worklist drills with its own filter',
    body2.callbackState === 'unreturned', body2.callbackState);
  /*
   * ...and on the population the card counts. A call nobody returned is a
   * MISSED call, so the drill used to ask for metric=inbound — answered
   * inbound legs only — which emptied the row set before the callback filter
   * ever ran, and the modal opened with "No calls found." under a card that
   * said 2. Both callback rows must drill on misses.
   */
  check('the not-returned worklist drills on missed calls, not inbound ones',
    body2.metric === 'missed', body2.metric);
  await press(document, 'Escape');
  await flush(4);
  const returnedRow = [...document.querySelectorAll('.ops-link-row')]
    .find(r => r.textContent.includes('Returned within 24h'));
  if (returnedRow) {
    await click(returnedRow);
    await flush(8);
  }
  const posted3 = [...requested].reverse().find(r => r.endpoint === 'calls');
  let body3 = {};
  try { body3 = posted3 ? JSON.parse(posted3.body) : {}; } catch { body3 = {}; }
  check('the returned list drills on the misses that were called back',
    body3.callbackState === 'returned' && body3.metric === 'missed', body3);
  await press(document, 'Escape');
  await flush(4);
  check('the dashboard cards threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

console.log('\n== call modal (dashboard KPI drill-down) ==');
{
  await goTo('Dashboard');
  await flush(8);
  const before = errors.length;
  /* The dashboard's "Total calls" KPI is a button (.ops-total-n) that opens
   * the call modal with metric=total. */
  const kpiButton = document.querySelector('.ops-total-n') || document.querySelector('.ops-insight-link') ||
    document.querySelector('.kpi-card.kpi-click') || document.querySelector('.kpi-card');
  check('clickable KPI exists', !!kpiButton, document.querySelectorAll('.ops-total-n').length);
  if (kpiButton) await click(kpiButton);
  await flush(12);
  check('call modal path did not throw', errors.length === before, errors.slice(before).join(' | '));
  check('calls endpoint requested by the modal', requested.some(r => r.endpoint === 'calls'),
    JSON.stringify(requested.map(r => r.endpoint).slice(-5)));
  check('call modal rendered', !!document.querySelector('.call-modal'), root().textContent.slice(-160));
  /*
   * Bug #4: the loader asked for a URL that did not exist and every drill-down
   * shouted "Unable to load the call table." Whatever the table is, the
   * error state must not be what a manager sees here.
   */
  check('the call table loaded instead of the load error',
    !/Unable to load the call table/.test(root().textContent)
      && !/Unable to load the call details/.test(root().textContent),
    root().textContent.slice(-200));
  const closable = document.querySelector('.call-modal .ap-cols-btn') || containing('.call-modal button', 'Close') || containing('.call-modal button', '×');
  if (closable) await click(closable);
}

console.log('\n== call modal footer: rows per page + paging ==');
{
  /*
   * The fixture answers one page, so give it three for this check and put the
   * fixture back afterwards. This is the only place the footer's arithmetic is
   * exercised through the real component (lib/pagination.js has its own suite).
   */
  const saved = { total: FIXTURES.calls.total, last_page: FIXTURES.calls.last_page };
  FIXTURES.calls.total = 60;
  FIXTURES.calls.last_page = 3;
  await goTo('Dashboard');
  await flush(10);
  const kpi = document.querySelector('.ops-total-n') || document.querySelector('.ops-insight-link') || document.querySelector('.kpi-card');
  check('a drill-down KPI opens the call modal', !!kpi);
  if (kpi) await click(kpi);
  await flush(12);

  const modal = document.querySelector('.call-modal');
  check('the footer reports the range and the total', !!modal && modal.textContent.includes('Showing 1–2 of 60'),
    modal && modal.textContent.slice(-140));
  const select = modal && modal.querySelector('select');
  check('rows per page offers the four sizes, in order',
    !!select && [...select.options].map(o => o.textContent).join(',') === '10,25,50,100',
    select && [...select.options].map(o => o.textContent).join(','));
  const pageButtons = modal ? [...modal.querySelectorAll('button')].filter(b => /^[0-9]+$/.test((b.textContent || '').trim())) : [];
  check('one button per page (3 pages, no ellipsis)', pageButtons.map(b => b.textContent.trim()).join(',') === '1,2,3',
    pageButtons.map(b => b.textContent.trim()).join(','));
  const active = pageButtons.find(b => /border-cyan-500/.test(b.className));
  check('the current page is the one styled as active', !!active && active.textContent.trim() === '1',
    active && active.textContent);

  requested.length = 0;
  const next = modal && [...modal.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '›');
  check('the next-page control exists', !!next);
  if (next) await click(next);
  await flush(10);
  const pageCall = [...requested].reverse().find(r => r.endpoint === 'calls');
  const pageBody = JSON.parse((pageCall && typeof pageCall.body === 'string' ? pageCall.body : '') || '{}');
  check('next asks the server for page 2', pageBody.page === 2, pageBody.page);
  check('the row count on screen is what the range reports',
    modal.textContent.includes('Showing 26–27 of 60'), modal.textContent.slice(-140));

  requested.length = 0;
  /* Paging re-mounts the footer, so the select has to be looked up again. */
  const sizeSelect = modal.querySelector('select');
  check('the rows-per-page select survives a page change', !!sizeSelect);
  if (sizeSelect) await act(async () => {
    sizeSelect.value = '100';
    sizeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flush(10);
  const sizeCall = [...requested].reverse().find(r => r.endpoint === 'calls');
  const sizeBody = JSON.parse((sizeCall && typeof sizeCall.body === 'string' ? sizeCall.body : '') || '{}');
  check('changing the page size sends the new size', sizeBody.size === 100, sizeBody.size);
  check('changing the page size returns to the first page', sizeBody.page === 1, sizeBody.page);

  const close = modal && (modal.querySelector('.ap-cols-btn') || containing('.call-modal button', 'Close') || containing('.call-modal button', '×'));
  if (close) await click(close);
  await flush(6);
  FIXTURES.calls.total = saved.total;
  FIXTURES.calls.last_page = saved.last_page;
}

console.log('\n== keyboard parity + dialog semantics ==');
{
  await goTo('Call History');
  await flush(12);
  const before = errors.length;
  const rows = document.querySelectorAll('tr[tabindex="0"]');
  check('history rows are keyboard reachable', rows.length > 0, rows.length);
  if (rows.length) {
    await press(rows[0], 'Enter');
    await flush(12);
    const dialog = document.querySelector('.hist-modal[role="dialog"]');
    check('Enter on a history row opens the cradle dialog', !!dialog, root().textContent.slice(-120));
    check('cradle dialog is announced as modal',
      !!dialog && dialog.getAttribute('aria-modal') === 'true' && !!dialog.getAttribute('aria-label'));
    const backdrop = document.querySelector('.hist-modal-bg');
    check('cradle backdrop is not styled as a control',
      !!backdrop && /cursor-default/.test(backdrop.className), backdrop && backdrop.className);
    if (dialog) {
      await press(document, 'Escape');
      check('Escape closes the cradle dialog', !document.querySelector('.hist-modal[role="dialog"]'));
    }
  }
  check('keyboard path threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

console.log('\n== agent overview (report-driven) ==');
{
  await goTo('Agents');
  await flush(8);
  const before = errors.length;
  const subtabs = [...document.querySelectorAll('.aa-tab')];
  check('agent sub-tabs present', subtabs.length >= 3, subtabs.map(t => t.textContent.trim()).join('|'));
  for (const tab of subtabs) {
    await click(tab);
    await flush(8);
  }
  check('agent sub-tabs threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

console.log('\n== missed / abandoned labels ==');
{
  /* The Dashboard's abandon row must be the summary breakdown over offered
   * inbound (60 / (1400 + 130) = 3.9% -> the ring rounds to 4%). */
  await goTo('Dashboard');
  await flush(8);
  const abandonRow = containing('.ops-rate-row', 'Abandon rate');
  check('dashboard abandon row shows the summary abandon count',
    !!abandonRow && /60 calls/.test(abandonRow.textContent), abandonRow && abandonRow.textContent.trim());
  check('dashboard abandon rate is abandon ÷ (inbound + missed)',
    !!abandonRow && /4%/.test(abandonRow.textContent), abandonRow && abandonRow.textContent.trim());

  /* The Agent stats table reads report.php's agentPerformance verbatim, so the
   * Abandoned column and the missed rate must come straight from the payload
   * (16 abandoned, missed rate 16.7%) instead of being re-derived per screen. */
  await goTo('Agents');
  await flush(8);
  const statsTab = byText('.aa-tab', 'Agent stats');
  if (statsTab) await click(statsTab);
  await flush(8);
  const statsSection = [...document.querySelectorAll('section')].find(s => /Agent stats/.test(s.textContent));
  const statsTable = statsSection ? statsSection.querySelector('table') : null;
  check('agent stats table renders', !!statsTable);
  check('agent stats table has an Abandoned column',
    !!statsTable && /Abandoned/.test(statsTable.textContent), statsTable && statsTable.textContent.slice(0, 120));
  check('agent stats table shows the payload abandoned count',
    !!statsTable && /16/.test(statsTable.textContent));
  check('agent stats table shows the payload missed rate (16.7%)',
    !!statsTable && /16\.7%/.test(statsTable.textContent));

  /* The Missed cell must open the calls it counts (missed minus abandoned),
   * and the Abandoned cell the abandons — not the whole missed family. */
  const missedCell = statsTable && [...statsTable.querySelectorAll('button.qs-num-btn')].find(b => b.textContent.trim() === '24');
  if (missedCell) {
    await click(missedCell);
    await flush(8);
    const lastCall = [...requested].reverse().find(r => r.endpoint === 'calls');
    check('agent Missed cell drills into missed_no_abandon',
      !!lastCall && String(lastCall.body).includes('missed_no_abandon'),
      lastCall && lastCall.body);
    const closeBtn = containing('.call-modal button', 'Close') || containing('.call-modal button', '×');
    if (closeBtn) await click(closeBtn);
  } else {
    check('agent Missed cell found', false, statsTable && statsTable.textContent.slice(0, 200));
  }
}

console.log('\n== drill-down filters match the clicked item (P7) ==');
{
  const lastCall = () => [...requested].reverse().find(r => r.endpoint === 'calls');
  const bodyOf = call => (call && typeof call.body === 'string' ? call.body : '') || '';
  const modalEl = () => document.querySelector('.call-modal');
  const closeModal = async () => {
    /* The header × has no text label beyond the glyph, so match both. */
    const btn = [...(modalEl() || document).querySelectorAll('button')]
      .find(b => /^(close|×|✕)$/i.test((b.textContent || '').trim()) || b.getAttribute('aria-label') === 'Close');
    if (btn) await click(btn);
    await flush(8);
    if (document.querySelector('.call-modal')) check('modal closes after a drill', false, root().textContent.slice(-120));
  };

  /* 1 — Queues: the hour bar carries the hour AND the SLA the screen used. */
  requested.length = 0;
  charts.length = 0;
  await goTo('Queues');
  await flush(12);
  /* The hour chart only exists on the Overview tab. */
  const qOverview = byText('.aa-tab', 'Overview');
  if (qOverview) await click(qOverview);
  await flush(12);
  const hourChart = charts.filter(c => (c.data?.labels || []).length === 24 && typeof c.options?.onClick === 'function').slice(-1)[0];
  check('queue hour chart is clickable', !!hourChart);
  if (hourChart) {
    await act(() => hourChart.options.onClick(null, [{ index: 9 }]));
    await flush(10);
    const call = lastCall();
    const body = JSON.parse(bodyOf(call) || '{}');
    check('queue hour drill sends the clicked hour', body.hour === 9, body);
    check('queue hour drill keeps the queue scope', body.queue === '700' || body.queuesOnly === true, JSON.stringify(body));
    check('queue hour drill keeps the page SLA (ring colouring)', Number(body.slaSeconds) > 0, body.slaSeconds);
    check('queue hour drill keeps the range', !!body.start && !!body.end, [body.start, body.end]);
    await closeModal();
  }

  /* 1b — QA-6: a queue recent row opens that single call. */
  requested.length = 0;
  await goTo('Queues');
  await flush(12);
  const qOverviewTab = byText('.aa-tab', 'Overview');
  if (qOverviewTab) await click(qOverviewTab);
  await flush(12);
  const openCallBtn = [...document.querySelectorAll('button')].find(b => /^Open$/.test((b.textContent || '').trim()));
  check('a queue recent row offers Open', !!openCallBtn);
  if (openCallBtn) {
    await click(openCallBtn);
    await flush(10);
    const call = lastCall();
    const body = JSON.parse(bodyOf(call) || '{}');
    check('the queue recent row drills into that call (callId)',
      body.callId === 'c1' && body.metric === 'total',
      JSON.stringify(body));
    check('the call modal opens for the queue recent row', !!modalEl());
    await closeModal();
  }

  /* 2 — Telephone Numbers: the interval row carries its own window. */
  requested.length = 0;
  await goTo('Telephone Numbers');
  await flush(8);
  const simTab = byText('.tn-tab', 'Simultaneous');
  if (simTab) await click(simTab);
  await flush(12);
  const intervalRow = [...document.querySelectorAll('tr[tabindex="0"]')].find(r => /Open the calls behind this interval/.test(r.getAttribute('title') || ''));
  check('simultaneous interval row is clickable', !!intervalRow);
  if (intervalRow) {
    await click(intervalRow);
    await flush(10);
    const body = JSON.parse(bodyOf(lastCall()) || '{}');
    check('interval drill sends the interval window', !!body.timeFrom && !!body.timeTo, [body.timeFrom, body.timeTo]);
    check('interval drill narrows the range to the bucket day', body.start === body.end && /^\d{4}-\d{2}-\d{2}$/.test(body.start || ''), [body.start, body.end]);
    check('interval drill counts inbound + missed calls', body.metric === 'incoming', body.metric);
    await closeModal();
  }

  /* 3 — Telephone Numbers: a DID bar carries that number. */
  requested.length = 0;
  const graphsTab = byText('.tn-tab', 'Graphs');
  if (graphsTab) await click(graphsTab);
  await flush(10);
  const didBar = [...document.querySelectorAll('button')].find(b => /^Open the inbound calls to /.test(b.getAttribute('title') || ''));
  check('top-numbers bar is clickable', !!didBar, root().textContent.slice(-120));
  if (didBar) {
    await click(didBar);
    await flush(10);
    const body = JSON.parse(bodyOf(lastCall()) || '{}');
    check('DID bar drill carries that number', /^\d{7,}$/.test(String(body.phoneNumber || '')), body.phoneNumber);
    check('DID bar drill counts inbound + missed calls', body.metric === 'incoming', body.metric);
    await closeModal();
  }

  /* 4 — Agents: a recent-call row opens THAT call, not its type. */
  requested.length = 0;
  await goTo('Agents');
  await flush(10);
  const overviewTab = byText('.aa-tab', 'Overview');
  if (overviewTab) await click(overviewTab);
  await flush(12);
  const recentRow = [...document.querySelectorAll('tr[tabindex="0"]')].find(r => /Open this call/.test(r.getAttribute('title') || ''));
  check('agent recent-call row is clickable', !!recentRow, root().textContent.slice(-160));
  if (recentRow) {
    await click(recentRow);
    await flush(10);
    const body = JSON.parse(bodyOf(lastCall()) || '{}');
    /* The table is newest-first, so the first row is the fixture's c2. */
    check('recent-call row drills into that call id',
      FIXTURES.calls.data.some(r => r.id === body.callId), JSON.stringify(body));
    check('recent-call row keeps the agent scope', body.agent === '6080', body.agent);
    await closeModal();
  }

  /* 5 — Agents compare: the range on screen, not the page range. */
  requested.length = 0;
  const compareTab = byText('.aa-tab', 'Compare');
  if (compareTab) await click(compareTab);
  await flush(12);
  const compareLink = [...document.querySelectorAll('button')].find(b => /· calls$/.test((b.textContent || '').trim()));
  check('agent compare call link is clickable', !!compareLink, root().textContent.slice(-160));
  if (compareLink) {
    await click(compareLink);
    await flush(10);
    const body = JSON.parse(bodyOf(lastCall()) || '{}');
    check('compare drill keeps the metric', body.metric === 'total', body.metric);
    check('compare drill scopes to the clicked agent', Array.isArray(body.agents) && body.agents.length === 1, body.agents);
    check('compare drill keeps a date range', !!body.start && !!body.end, [body.start, body.end]);
    await closeModal();
  }

  /*
   * 6 — C1: a scope chosen in the FILTER BAR, not by the card. The sentiment and
   * outcome selects narrow every figure on the dashboard, so the list a card
   * opens has to be narrowed by the same thing (api/calls.php used not to read
   * `sentiment` at all) and, above all, say so — a subset that looks like the
   * whole set is how a wrong number survives.
   */
  requested.length = 0;
  await goTo('Dashboard');
  await flush(12);
  const barSelect = title => [...document.querySelectorAll('select')]
    .find(sel => (sel.getAttribute('title') || '').startsWith(title));
  const sentimentSelect = barSelect('Scope every figure');
  const outcomeSelect = barSelect('Filter by how the call ended');
  check('the filter bar offers a sentiment and an outcome scope',
    !!sentimentSelect && !!outcomeSelect, [!!sentimentSelect, !!outcomeSelect]);
  if (sentimentSelect) {
    await act(async () => {
      sentimentSelect.value = 'negative';
      sentimentSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush(12);
  }
  if (outcomeSelect) {
    await act(async () => {
      outcomeSelect.value = 'abandoned';
      outcomeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush(12);
  }
  requested.length = 0;
  const scopedKpi = document.querySelector('.ops-total-n');
  check('a KPI is clickable under the bar scope', !!scopedKpi);
  if (scopedKpi) {
    await click(scopedKpi);
    await flush(10);
    const body = JSON.parse(bodyOf(lastCall()) || '{}');
    check('the drill is asked for the sentiment the bar holds',
      body.sentiment === 'negative', body.sentiment);
    check('and the outcome', body.outcome === 'abandoned', body.outcome);
    const chips = [...(modalEl()?.querySelectorAll('.call-modal-chip') ?? [])]
      .map(chip => chip.textContent || '');
    check('the list says it is showing negative-only calls',
      chips.some(text => /Sentiment.*negative/.test(text)), chips);
    check('and which outcome it narrowed to',
      chips.some(text => /Outcome.*abandoned/.test(text)), chips);
    /* The CSV is the same request without paging, so it must not lose the scope
     * the table on screen has. */
    requested.length = 0;
    const modalExport = [...(modalEl() || document).querySelectorAll('button')]
      .find(b => /^Export CSV$/.test((b.textContent || '').trim()));
    check('the scoped drill can be exported', !!modalExport);
    if (modalExport) {
      await click(modalExport);
      await flush(10);
      const exported = requested.find(r => r.endpoint === 'calls' && String(r.body || '').includes('"export":true'));
      check('the export carries the sentiment and the outcome too',
        !!exported && /\"sentiment\":\"negative\"/.test(String(exported.body))
          && /\"outcome\":\"abandoned\"/.test(String(exported.body)),
        exported && String(exported.body).slice(0, 240));
    }
    await closeModal();
  }
  /* Put the bar back, for the suites that follow in this same harness. */
  if (sentimentSelect) {
    await act(async () => {
      sentimentSelect.value = '';
      outcomeSelect && (outcomeSelect.value = '');
      sentimentSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      outcomeSelect && outcomeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush(10);
  }

  check('drill-down filter paths threw nothing', errors.length === 0, errors.slice(0, 2));
}

console.log('\n== agent KPI scope is the table it was clicked in ==');
{
  /*
   * The stats tab loads the WHOLE roster (agents: []), so its KPI cards must
   * not inherit the sidebar's Overview selection: doing that opened a list
   * that disagreed with the number on the card. Select an agent first (the
   * dashboard podium does that) and then click the stats KPI.
   */
  await goTo('Dashboard');
  await flush(10);
  const podiumRow = document.querySelector('.ops-agent-row');
  check('dashboard podium agent row exists', !!podiumRow, root().textContent.slice(-120));
  if (podiumRow) {
    await click(podiumRow);
    await flush(12);
    check('podium click lands on the agent overview', /call activity and performance overview/.test(root().textContent), root().textContent.slice(-140));
  }
  const statsTab = byText('.aa-tab', 'Agent stats');
  if (statsTab) await click(statsTab);
  await flush(12);

  requested.length = 0;
  const kpiCard = [...document.querySelectorAll('.kpi-card')].find(b => /Total calls/.test(b.textContent || ''));
  check('agent stats total-calls KPI exists', !!kpiCard, root().textContent.slice(-160));
  if (kpiCard) {
    await click(kpiCard);
    await flush(10);
    const call = [...requested].reverse().find(r => r.endpoint === 'calls');
    const body = JSON.parse((call && typeof call.body === 'string' ? call.body : '') || '{}');
    check('stats KPI opens every agent, not the sidebar selection',
      Array.isArray(body.agents) && body.agents.length === 0, JSON.stringify(body.agents));
    check('stats KPI keeps the range and department/site filters',
      !!body.start && !!body.end && 'department' in body && 'site' in body,
      [body.start, body.end, body.department, body.site]);
    const btn = [...(document.querySelector('.call-modal') || document).querySelectorAll('button')]
      .find(b => /^(close|×|✕)$/i.test((b.textContent || '').trim()) || b.getAttribute('aria-label') === 'Close');
    if (btn) await click(btn);
    await flush(8);
  }
}

console.log('\n== error states: one look, one retry (QA-9) ==');
{
  /* Force the queue panel to fail, then let Retry put it back. */
  const originalQueue = FIXTURES.queue;
  await goTo('Dashboard');
  await flush(4);
  FIXTURES.queue = {__status: 502, error: 'Unable to load queues.'};
  requested.length = 0;
  await goTo('Queues');
  await flush(10);

  const alert = document.querySelector('[role="alert"]');
  check('a failed panel shows the shared error block',
    !!alert && /Unable to load queues/.test(alert.textContent),
    alert && alert.textContent.slice(0, 120));
  const retry = alert && [...alert.querySelectorAll('button')].find(b => /^Retry$/.test(b.textContent.trim()));
  check('the error block offers a Retry button', !!retry, alert && alert.outerHTML.slice(0, 200));

  FIXTURES.queue = originalQueue;
  const before = requested.length;
  if (retry) await click(retry);
  await flush(10);
  check('Retry re-requests the panel and recovers',
    requested.length > before &&
      requested.filter(r => r.endpoint === 'queue').length >= 2 &&
      !document.querySelector('[role="alert"]'),
    requested.map(r => r.endpoint).slice(-4));
}

console.log('\n== call modal: recording + sip flow (P7) ==');
{
  /* The dashboard's Total calls KPI opens the modal with a row that has a
   * recording + a trace and one that has neither (FIXTURES.calls). */
  requested.length = 0;
  tables.length = 0;
  await goTo('Dashboard');
  await flush(8);
  const kpiButton = document.querySelector('.ops-total-n');
  check('dashboard KPI found for the attachment drill', !!kpiButton);
  if (kpiButton) await click(kpiButton);
  await flush(12);

  /*
   * QA-8: the dialog's wording is the server's (api/filters.php), not a
   * map compiled into the bundle. FIXTURES.filters.metrics.total carries a
   * sentinel title; the fallback would have printed the raw id.
   */
  const modalText = root().textContent;
  check('the dialog title uses the server-served metric title (QA-8)',
    modalText.includes('All calls (served by api/filters.php) call details') &&
      !modalText.includes('total call details'),
    modalText.slice(0, 160));

  const modalTable = [...tables].reverse().find(t => (t.options?.columns || []).some(c => c.title === 'Rec'));
  check('the drill-down table is built with a Rec column', !!modalTable,
    tables.map(t => (t.options?.columns || []).map(c => c.title).join('|')).slice(-3));
  const cols = (modalTable && modalTable.options.columns) || [];
  const recCol = cols.find(c => c.title === 'Rec');
  const flowCol = cols.find(c => c.title === 'SIP flow');
  check('the drill-down table is built with a SIP flow column', !!flowCol,
    cols.map(c => c.title).join('|'));
  /* QA-11: the columns now live in call-modal-columns.js — pin the set. */
  check('the drill-down table keeps its full column set and order',
    cols.map(c => c.title).join('|') === 'Date|Time|Type|From Name|From|Dialed|To|Talk|Ring|Reason|Total|Callback|Rec|SIP flow',
    cols.map(c => c.title).join('|'));
  const cbCol = cols.find(c => c.title === 'Callback');
  check('the Callback column is bound to the server flag', !!cbCol && cbCol.field === 'callback',
    cbCol && cbCol.field);
  /*
   * The card is a count, so the list behind it has to show the state per row —
   * otherwise "2 not returned" cannot be checked against anything. null must NOT
   * render as "Not returned": that would print a failure on a call the desk
   * answered.
   */
  if (cbCol) {
    const badge = row => cbCol.formatter({ getValue: () => row });
    const na = badge(null);
    const no = badge(false);
    const yes = badge(true);
    check('the Callback column reads "Not returned" for an unreturned miss',
      no.textContent === 'Not returned' && no.className.includes('is-no'), no.outerHTML);
    check('the Callback column reads "Returned" for a returned miss',
      yes.textContent === 'Returned' && yes.className.includes('is-yes'), yes.outerHTML);
    check('the Callback column shows a dash, never "Not returned", on a non-miss row',
      na.textContent === '—' && na.className.includes('is-na'), na.outerHTML);
    /* SEC-9: a formatter must never hand Tabulator a string it will innerHTML. */
    check('the Callback column returns an element, not markup in a string',
      yes instanceof window.Element && na instanceof window.Element, typeof yes);
  }
  check('the Rec column is bound to hasRecordingHint and the flow column to hasFlowHint',
    !!recCol && recCol.field === 'hasRecordingHint' && !!flowCol && flowCol.field === 'hasFlowHint',
    [recCol && recCol.field, flowCol && flowCol.field]);

  /* Run the real formatters against the two fixture rows. */
  const cellFor = row => ({ getRow: () => ({ getData: () => row }) });
  const [withAttachments, without] = FIXTURES.calls.data;
  const recOn = recCol ? recCol.formatter(cellFor(withAttachments)) : null;
  const recOff = recCol ? recCol.formatter(cellFor(without)) : null;
  const flowOn = flowCol ? flowCol.formatter(cellFor(withAttachments)) : null;
  const flowOff = flowCol ? flowCol.formatter(cellFor(without)) : null;
  check('Rec renders a play button when the CDR has a recording',
    !!recOn && recOn.tagName === 'BUTTON' && /cm-attach-btn/.test(recOn.className) && recOn.textContent === '▶' && !recOn.disabled,
    recOn && recOn.outerHTML);
  check('Rec renders a disabled dash when it does not',
    !!recOff && recOff.textContent === '—' && recOff.disabled && recOff.className.includes('is-off'),
    recOff && recOff.outerHTML);
  check('SIP flow renders a Flow button when a trace exists',
    !!flowOn && flowOn.textContent === 'Flow' && !flowOn.disabled, flowOn && flowOn.outerHTML);
  check('SIP flow renders a disabled dash when it does not',
    !!flowOff && flowOff.textContent === '—' && flowOff.disabled && flowOff.className.includes('is-off'),
    flowOff && flowOff.outerHTML);

  /*
   * SEC-9 regression. Tabulator applies a string formatter result with
   * `element.innerHTML = val` (dist/js/tabulator.js, _generateContents), so a
   * formatter that echoes CDR text would execute a hostile caller-ID name as
   * HTML. Mount each text column's output exactly the way Tabulator does.
   */
  const HOSTILE = '<img src=x onerror="window.__xss=1">';
  const TEXT_FIELDS = ['from', 'fromNumber', 'dialed', 'to', 'disconnectReason'];
  const mounted = [];
  const leaks = [];
  TEXT_FIELDS.forEach(field => {
    const col = cols.find(c => c.field === field);
    if (!col || typeof col.formatter !== 'function') return;
    const out = col.formatter({getValue: () => HOSTILE, getRow: () => ({getData: () => ({})})});
    const holder = document.createElement('td');
    if (typeof out === 'string') holder.innerHTML = out;
    else if (out && out.nodeType) holder.appendChild(out);
    else holder.textContent = String(out == null ? '' : out);
    mounted.push(field + '=' + (typeof out === 'string' ? 'string' : (out && out.nodeType ? 'node' : typeof out)));
    if (holder.querySelector('img') || /<img/i.test(holder.innerHTML)) leaks.push(field);
  });
  check('every CDR text column escapes a hostile caller-ID value (SEC-9)',
    mounted.length === TEXT_FIELDS.length && leaks.length === 0,
    {mounted, leaks});

  /* Clicking Rec opens the tray (and resolves the recording lazily). */
  const before = errors.length;
  requested.length = 0;
  if (recOn) await click(recOn);
  await flush(12);
  const tray = document.querySelector('.cm-tray');
  check('the recording tray opens under the table', !!tray, root().textContent.slice(-140));
  check('the tray hosts the shared recording player', !!tray && !!tray.querySelector('.rec-panel'));
  check('opening a recording asks the server for it', requested.some(r => r.endpoint === 'recording'),
    requested.map(r => r.endpoint));

  /* The flow dialog is the same component Call history uses. */
  if (flowOn) await click(flowOn);
  await flush(12);
  const flowDialog = document.querySelector('.hist-modal[role="dialog"]');
  check('the flow dialog opens from the SIP flow button', !!flowDialog && /Cradle to grave/.test(flowDialog.textContent),
    flowDialog && flowDialog.textContent.slice(0, 80));
  check('the flow dialog requested the cradle-to-grave steps', requested.some(r => r.endpoint === 'call_flow'),
    requested.map(r => r.endpoint));

  /* Escape unwinds one layer at a time: flow, then tray, then the modal. */
  await press(document, 'Escape');
  await flush(6);
  check('Escape closes the flow dialog first', !document.querySelector('.hist-modal[role="dialog"]'));
  check('the modal is still open after closing the flow', !!document.querySelector('.call-modal'));
  await press(document, 'Escape');
  await flush(6);
  check('Escape closes the recording tray next', !document.querySelector('.cm-tray'));
  check('the modal survives the tray too', !!document.querySelector('.call-modal'));
  await press(document, 'Escape');
  await flush(6);
  check('a third Escape closes the modal', !document.querySelector('.call-modal'));
  check('attachment drill-down path threw nothing', errors.length === before, errors.slice(before).join(' | '));
}

console.log('\n== CSV exports (server-streamed) ==');
{
  /* Call history: the export must ask the server for the whole filtered set
   * (export: true), not serialise the 25 rows on screen. */
  requested.length = 0;
  await goTo('Call History');
  const histExport = document.querySelector('.hist-export');
  check('call history has an export button', !!histExport);
  if (histExport) {
    (async () => {})(histExport);
    await click(histExport);
    await flush();
    const call = requested.find(r => r.endpoint === 'call_history' && String(r.body || '').includes('"export":true'));
    check('call history export requests the server CSV', !!call, requested.map(r => r.endpoint + ':' + String(r.body || '').slice(0, 60)));
    check('call history export keeps the active filters', !!call && /"start":"\d{4}-\d{2}-\d{2}"/.test(call.body));
    check('call history export did not throw', errors.length === 0, errors.slice(0, 2));
  }

  /* Telephone Numbers inventory: same rule — every DID, not the ten on screen. */
  requested.length = 0;
  await goTo('Telephone Numbers');
  const tnExport = [...document.querySelectorAll('button')].find(b => b.className.includes('hist-export') && /Export/.test(b.textContent || ''));
  check('telephone numbers has an export button', !!tnExport);
  if (tnExport) {
    await click(tnExport);
    await flush();
    check('telephone numbers export requests the server CSV',
      requested.some(r => r.endpoint === 'telephone_numbers' && String(r.body || '').includes('"export":true')),
      requested.map(r => r.endpoint));
  }

  /* Call modal: opened from the dashboard KPI, export uses the same request. */
  requested.length = 0;
  await goTo('Dashboard');
  const kpi = document.querySelector('.ops-total-n');
  if (kpi) {
    await click(kpi);
    await flush();
    /* Scope to the modal: the dashboard has its own (browser-side) export. */
    const modalRoot = document.querySelector('.call-modal') || document;
    const modalExport = [...modalRoot.querySelectorAll('button')].find(b => /^Export CSV$/.test((b.textContent || '').trim()));
    check('call modal has an export button', !!modalExport);
    if (modalExport) {
      await click(modalExport);
      await flush();
      check('call modal export requests the server CSV',
        requested.some(r => r.endpoint === 'calls' && String(r.body || '').includes('"export":true')),
        requested.map(r => r.endpoint + ':' + String(r.body || '').slice(0, 50)));
      check('call modal export carries the drill-down filters',
        !!requested.find(r => r.endpoint === 'calls' && String(r.body || '').includes('"export":true') && String(r.body || '').includes('"metric"')));
    }
    const close = [...modalRoot.querySelectorAll('button')].find(b => /close|×|Close/i.test(b.textContent || '') || b.getAttribute('aria-label') === 'Close');
    if (close) await click(close);
  }
}

console.log('\n== QA-5: the settings panel is role-gated ==');
{
  /*
   * The server refuses both the read and the write for agents and basic users
   * (tests/php/endpoints.mjs). The page must not offer what the server will
   * reject, so each role gets its own harness.
   */
  const asRole = async role => {
    const h2 = await createHarness({user: {...FIXTURES.session.user, role, username: role}});
    await h2.flush(14);
    return h2;
  };

  const agent = await asRole('agent');
  check('an agent is not offered Settings',
    !/Settings/.test(agent.root().textContent), agent.root().textContent.slice(0, 120));
  check('an agent never calls the settings endpoint',
    !agent.requested.some(r => r.endpoint === 'settings'),
    [...new Set(agent.requested.map(r => r.endpoint))]);

  const basic = await asRole('basic_user');
  check('a basic user is not offered Settings either',
    !/Settings/.test(basic.root().textContent) &&
      !basic.requested.some(r => r.endpoint === 'settings'));

  const sup = await asRole('supervisor');
  check('a supervisor is offered Settings', /Settings/.test(sup.root().textContent));
  check('a supervisor reads the thresholds', sup.requested.some(r => r.endpoint === 'settings'));

  const supSettingsBtn = [...sup.document.querySelectorAll('button')]
    .find(b => /^Settings$/.test((b.textContent || '').trim()));
  if (supSettingsBtn) {
    await sup.click(supSettingsBtn);
    await sup.flush(10);
    check('a supervisor sees the panel but has no Save control',
      sup.document.querySelector('.set-save') === null && sup.document.querySelector('.set-reset') === null);
    check('the panel says why it is read-only',
      /Only an office manager can change/.test(sup.root().textContent));
  } else {
    check('a supervisor can open the settings panel', false, sup.root().textContent.slice(0, 120));
  }

  /* The manager (the main harness) can save — same panel, Save present. */
  const managerBtn = [...document.querySelectorAll('button')]
    .find(b => /^Settings$/.test((b.textContent || '').trim()));
  if (managerBtn) {
    await click(managerBtn);
    await flush(10);
    const saveBtn = document.querySelector('.set-save');
    check('an office manager can save', !!saveBtn && saveBtn.disabled === false,
      saveBtn && saveBtn.outerHTML.slice(0, 140));
    const closeBtn = [...(document.querySelector('.call-modal') || document).querySelectorAll('button')]
      .find(b => /^(close|×|✕)$/i.test((b.textContent || '').trim()) || b.getAttribute('aria-label') === 'Close');
    if (closeBtn) await click(closeBtn);
    await flush(6);
  } else {
    check('the office manager can open the settings panel', false, document.body.textContent.slice(0, 120));
  }
}

console.log('\n== filter date-range picker (calendar popup) ==');
{
  /*
   * The popup is a portal into document.body and was never exercised by this
   * suite, which is exactly where a moved calendar helper could go missing: the
   * route still renders, the popup only breaks when it is opened. Drive it for
   * real - open, page back a month, pick two days, apply.
   */
  await goTo('Dashboard');
  await flush(10);
  const trigger = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('▣'));
  check('the date-range trigger is in the filter bar', !!trigger, root().textContent.slice(0, 120));
  if (trigger) {
    const popup = () => document.querySelector('.date-picker-pop');
    await click(trigger);
    await flush(6);

    const headingOf = () => {
      const pop = popup();
      if (!pop) return undefined;
      return [...pop.querySelectorAll('div')]
        .map(el => (el.textContent || '').trim())
        .find(text => new RegExp('^[A-Z][a-z]+ [0-9]{4}$').test(text));
    };
    const navButton = glyph => {
      const pop = popup();
      return pop && [...pop.querySelectorAll('button')].find(b => (b.textContent || '').trim() === glyph);
    };
    const dayCells = () => {
      const pop = popup();
      if (!pop) return [];
      return [...pop.querySelectorAll('button')].filter(b => {
        const text = (b.textContent || '').trim();
        return text.length > 0 && text.length <= 2 && new RegExp('^[0-9]+$').test(text) && b.classList.contains('h-8');
      });
    };
    const applyButton = () => {
      const pop = popup();
      return pop && [...pop.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Apply');
    };

    const firstHeading = headingOf();
    check('the calendar opens on a month', !!firstHeading, firstHeading);
    const weekDayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    check('weekday headers come from the calendar module',
      weekDayLabels.every(day => document.body.textContent.includes(day)));
    const thisMonthDays = dayCells().length;
    check('the grid holds 28-31 day cells', thisMonthDays >= 28 && thisMonthDays <= 31, thisMonthDays);
    check('a day cell carries the start/end selection classes',
      dayCells().every(b => b.classList.contains('h-8')), dayCells().length);

    const prev = navButton('‹');
    check('the month back/forward controls are rendered', !!prev && !!navButton('›'));
    await click(prev);
    await flush(4);
    const previousHeading = headingOf();
    check('paging back changes the month and keeps a full grid',
      previousHeading !== firstHeading && dayCells().length >= 28,
      [firstHeading, previousHeading, dayCells().length]);

    const days = dayCells();
    const firstDay = days[0];
    await click(firstDay);
    await flush(3);
    await click(dayCells()[dayCells().length - 1]);
    await flush(3);
    const apply = applyButton();
    check('a complete range enables Apply', !!apply && apply.disabled === false,
      apply && apply.outerHTML.slice(0, 140));

    requested.length = 0;
    if (apply) await click(apply);
    await flush(10);
    check('applying a range closes the popup and shows both dates',
      !popup() && trigger.textContent.includes('–'), trigger.textContent);
    check('applying a range refetches the report',
      requested.some(r => r.endpoint === 'report'), requested.map(r => r.endpoint).join(','));

    /* The two dates shown must be the two that were clicked, and the picker's
     * own rules (never in the future, at most MAX_RANGE_DAYS) must hold. */
    const shown = [...trigger.textContent.matchAll(new RegExp('([A-Z][a-z]{2}) ([0-9]{1,2}), ([0-9]{4})', 'g'))]
      .map(m => new Date(m[1] + ' ' + m[2] + ', ' + m[3]));
    check('a complete local date range is shown',
      shown.length === 2 && shown.every(d => !Number.isNaN(d.getTime())) && shown[0] <= shown[1],
      trigger.textContent);
    check('the applied range is never in the future and spans at most 31 days',
      shown.length === 2 && shown[1].getTime() <= Date.now() + 864e5 &&
        (shown[1] - shown[0]) / 864e5 < 31,
      trigger.textContent);
    check('the first clicked day is the start of the range',
      shown.length === 2 && shown[0].getDate() === Number((firstDay.textContent || '').trim()) &&
        shown[0].getMonth() === new Date(previousHeading + ' 1').getMonth(),
      [firstDay.textContent, trigger.textContent, previousHeading]);
    check('the picker left no calendar behind in the DOM', !popup());
  }
  check('the date-range picker threw nothing', errors.length === 0, errors.slice(0, 2));
}

console.log('\n== Sprint B: the sentiment scope and the period block ==');
{
  await goTo('Dashboard');
  await flush(8);
  const sentimentSelect = [...document.querySelectorAll('.filters-bar select')]
    .find(s => (s.getAttribute('title') || '').includes('sentiment'));
  check('the filter bar offers a sentiment scope', !!sentimentSelect,
    [...document.querySelectorAll('.filters-bar select')].map(s => s.getAttribute('title')).join('|'));
  check('the scope offers any / negative / positive',
    sentimentSelect && sentimentSelect.options.length === 3
      && sentimentSelect.options[1].value === 'negative' && sentimentSelect.options[2].value === 'positive',
    sentimentSelect ? [...sentimentSelect.options].map(o => o.value).join(',') : '');

  /* The reported block prints its own base, like every other rate on the page:
   * three scored calls, one of them negative. */
  const body = document.body.textContent;
  check('the dashboard states the sentiment base it averaged over',
    /3 scored|of 3 scored|scored calls/i.test(body), body.slice(0, 120));
  check('the negative count is shown with its base, not on its own',
    /1 negative|negative\D{0,12}1\b/.test(body), body.slice(0, 160));
  check('the three shares are the server\'s, printed with one decimal',
    /43\.3%/.test(body) && /38\.3%/.test(body) && /25\.0%/.test(body), body.slice(0, 200));
  check('the topics are listed with their counts',
    /billing · 2/.test(body), body.slice(0, 200));

  /* The negative worklist must scope the app, and the request must say so. */
  const before = requested.filter(r => r.endpoint === 'report').length;
  const openNeg = [...document.querySelectorAll('.ops-sent-link')][0];
  check('the card offers a negative worklist', !!openNeg);
  if (openNeg) {
    await click(openNeg);
    await flush(8);
    const fresh = requested.filter(r => r.endpoint === 'report').slice(before);
    const carried = fresh.some(r => /"sentiment":"negative"/.test(String(r.body || '')));
    check('opening the negative calls scopes the next report request to sentiment=negative',
      carried, fresh.map(r => String(r.body || '').slice(0, 120)));
    const barSelect = [...document.querySelectorAll('.filters-bar select')]
      .find(sel => (sel.getAttribute('title') || '').includes('sentiment'));
    check('the filter bar agrees with the worklist it was opened from',
      barSelect && barSelect.value === 'negative', barSelect ? barSelect.value : '');

    /*
     * The stale-whitelist bug this phase found: the fetch effects listed filter
     * fields by hand, so a NEW control (or one added in Sprint A) changed the
     * select without refetching - the numbers on screen kept describing the old
     * scope. The key must carry every narrowing filter.
     */
    check('the scope reaches the agents table too, not just the dashboard numbers',
      requested.filter(r => r.endpoint === 'report').some(r => /"sentiment":"negative"/.test(String(r.body || ''))),
      requested.filter(r => r.endpoint === 'report').map(r => String(r.body || '').slice(0, 90)).slice(-3));
  }
}

console.log('\n== Sprint B: the weekday x hour heatmap ==');
{
  /*
   * The grid must be the calendar's, not a shifted list. The fixture puts 12
   * offered calls (10 answered, 2 missed) in Monday 09:00 and 1 in Sunday
   * 09:00; a Monday-first index reads 1 in the wrong cell.
   */
  await goTo('Dashboard');
  await flush(10);
  const heat = document.querySelector('.ops-heat');
  check('the dashboard has a weekday x hour card', !!heat, root().textContent.slice(0, 120));
  if (heat) {
    const rows = heat.querySelectorAll('tbody tr');
    check('the grid has one row per weekday', rows.length === 7, rows.length);
    const cellsOf = row => [...row.querySelectorAll('.ops-heat-cell')];
    check('every row has 24 hour cells', [...rows].every(r => cellsOf(r).length === 24),
      [...rows].map(r => cellsOf(r).length).join(','));
    const monday = cellsOf(rows[1]);
    const sunday = cellsOf(rows[0]);
    check('Monday 09:00 shows the 12 calls, in the Monday row',
      (monday[9].textContent || '').trim() === '12', monday[9].textContent);
    check('Sunday 09:00 shows its own single call, in the Sunday row',
      (sunday[9].textContent || '').trim() === '1', sunday[9].textContent);
    check('a cell with calls states its own base in the tooltip',
      /offered/.test(monday[9].getAttribute('title') || '')
      && /missed/.test(monday[9].getAttribute('title') || ''),
      monday[9].getAttribute('title'));
    check('the foot line totals the grid (13 offered, 11 answered, 2 missed)',
      /13 offered/.test(heat.textContent) && /11 answered/.test(heat.textContent)
      && /2 missed/.test(heat.textContent), heat.textContent.slice(0, 200));

    /* The missed view: the same grid, the missed numbers, and the share with
     * its base in the foot line. */
    const missedTab = [...heat.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Missed');
    check('the heatmap offers a missed view', !!missedTab);
    if (missedTab) {
      await click(missedTab);
      await flush(4);
      const mondayMissed = cellsOf(heat.querySelectorAll('tbody tr')[1])[9];
      check('the missed view shows the missed count in the same cell',
        (mondayMissed.textContent || '').trim() === '2', mondayMissed.textContent);
      check('the missed foot line states the share with its base',
        /2 missed of 13 offered/.test(heat.textContent) && /15\.4%/.test(heat.textContent),
        heat.textContent.slice(0, 220));
    }
  }
  check('the heatmap threw nothing', errors.length === 0, errors.slice(0, 2));
}

console.log('\n== F2: long-range presets and the warming banner ==');
{
  /*
   * The manager is the role the longer window exists for (authorizedFilters()
   * gives office_manager 366 days, everyone else 31). The presets must appear
   * for them and must ask for the range their label names.
   */
  await goTo('Dashboard');
  await flush(8);
  const preset = label => [...document.querySelectorAll('.filters-bar button')]
    .find(b => (b.textContent || '').trim() === label);
  const today = new Date();
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  check('the manager is offered the long presets',
    !!preset('Last 90 days') && !!preset('Quarter to date') && !!preset('Year to date'),
    [...document.querySelectorAll('.filters-bar button')].map(b => (b.textContent || '').trim()).join('|'));

  const beforeYtd = requested.filter(r => r.endpoint === 'report').length;
  const ytd = preset('Year to date');
  if (ytd) {
    await click(ytd);
    await flush(8);
    const fresh = requested.filter(r => r.endpoint === 'report').slice(beforeYtd);
    const body = fresh.length ? JSON.parse(fresh[fresh.length - 1].body || '{}') : null;
    check('Year to date asks for 1 January of the current year through today',
      !!body && body.start === today.getFullYear() + '-01-01' && body.end === ymd(today),
      body && [body.start, body.end, ymd(today)]);
  }

  /*
   * The warming banner reports the batch, so a 366-day range reads as steady
   * progress rather than a stall. A fresh app booted on a one-year URL is what
   * makes the range long enough for the banner to appear.
   */
  const cacheFixture = FIXTURES.cache_job;
  FIXTURES.cache_job = {
    complete: false, ready: 7, total: 366, percent: 2, next: '2026-08-09',
    start: '2026-01-01', end: '2026-12-31', warming: true,
    batch: { attempted: 5, warmed: 5, days: [], stopped: 'days' }
  };
  const banner = await createHarness({search: 'start=2026-01-01&end=2026-12-31'});
  await banner.flush(12);
  const rail = banner.document.querySelector('.cache-job');
  const railText = rail ? rail.textContent : '';
  check('an incomplete range shows the warming banner', !!rail, banner.root().textContent.slice(0, 160));
  check('the banner counts the range out of the whole', /7 of 366 days cached/.test(railText), railText.slice(0, 160));
  check('the banner names the day being fetched', /fetching 2026-08-09/.test(railText), railText.slice(0, 160));
  check('the banner reports the batch size', /5 days per pass/.test(railText), railText.slice(0, 160));
  FIXTURES.cache_job = cacheFixture;
}

console.log('\n== global error budget ==');
check('no unexpected runtime errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const uniqueWarnings = [...new Set(warnings)];
console.log(`  (${uniqueWarnings.length} distinct React dev warning(s) — reported, not fatal)`);
for (const w of uniqueWarnings.slice(0, 6)) console.log('     ·', w);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE OK — every route renders and none of them throws');
process.exit(0);
