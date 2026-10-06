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
const { window, document, root, flush, click, press, byText, containing, errors, warnings, requested, tables, charts, act } = harness;

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

  const modalTable = [...tables].reverse().find(t => (t.options?.columns || []).some(c => c.title === 'Rec'));
  check('the drill-down table is built with a Rec column', !!modalTable,
    tables.map(t => (t.options?.columns || []).map(c => c.title).join('|')).slice(-3));
  const cols = (modalTable && modalTable.options.columns) || [];
  const recCol = cols.find(c => c.title === 'Rec');
  const flowCol = cols.find(c => c.title === 'SIP flow');
  check('the drill-down table is built with a SIP flow column', !!flowCol,
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
