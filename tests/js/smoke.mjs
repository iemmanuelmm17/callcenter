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
const { window, document, root, flush, click, byText, containing, errors, warnings, requested } = harness;

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
