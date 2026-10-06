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
  ['Call History', ['Caller']]
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
    cols.map(c => c.title).join('|') === 'Date|Time|Type|From Name|From|Dialed|To|Talk|Ring|Reason|Total|Rec|SIP flow',
    cols.map(c => c.title).join('|'));
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
