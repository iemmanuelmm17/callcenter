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
const { window, document, root, flush, click, press, byText, containing, errors, warnings, requested } = harness;

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
