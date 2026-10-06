/**
 * jsdom harness for the dashboard front end.
 *
 * Loads the BUILT bundle (assets/js/app.js) into a jsdom window with real
 * React 18, a Chart.js stub and stubbed network responses that mirror the
 * documented shapes of api/*.php. Tests therefore exercise the real component
 * tree — the same code the browser runs — while staying hermetic.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = path.join(ROOT, 'assets/js/app.js');

/* ------------------------------------------------------------------ fixtures */

const HOURS = Array.from({ length: 24 }, (_, h) => Math.round(20 + 30 * Math.sin(h / 3.4)));
const DAYS = { '2026-08-02': 812, '2026-08-03': 655, '2026-08-04': 590 };

const panel = (label, hours, days) => ({
  label,
  total: hours.reduce((a, b) => a + b, 0),
  answered: 100, missed: 20, abandoned: 5,
  avgRing: 12, avgTalk: 180, avgHandle: 192,
  slaPct: 82.5, abandonPct: 4.8,
  hours, days,
});

export const FIXTURES = {
  session: {
    user: { username: 'om@7826.DynaCloud', displayName: 'Test OM', role: 'office_manager', domain: '7826.DynaCloud', extension: '1000', department: '', site: '' },
    remaining: 1800, warningAt: 900, tokenRemaining: 3600
  },
  settings: { slaSeconds: 20, slaPct: 80, abandonPct: 10, missedPct: 20, ahtMinutes: 5, ahtOutboundMinutes: 5, topAgentAhtMinutes: 5, topAgentMinCalls: 20 },
  filters: { departments: ['Sales', 'Support', 'Billing'], sites: ['HQ', 'Branch'] },
  cache_job: { complete: true, ready: 5, total: 5, percent: 100, next: null, start: '2026-08-02', end: '2026-08-06', warming: false },
  report: {
    filters: { start: '2026-08-02', end: '2026-08-06', department: '', site: '', agents: [] },
    callTypes: { inbound: true, outbound: true, missed: true, onnet: true },
    summary: {
      counts: { total: 2057, inbound: 1400, outbound: 480, missed: 130, onnet: 47 },
      inbound: panel('Inbound', HOURS, DAYS),
      outbound: panel('Outbound', HOURS, DAYS),
      hours: HOURS,
      days: DAYS,
      outcomes: { answered: 1400, missed: 130, busy: 12, failed: 6 },
      duration: [{ label: '0–30s', count: 120 }, { label: '30–60s', count: 90 }],
      heatmap: Array.from({ length: 7 }, () => HOURS.map(n => Math.round(n / 3)))
    },
    comparison: {
      previous: {
        start: '2026-07-27', end: '2026-07-31',
        counts: { total: 1900, inbound: 1300, outbound: 450, missed: 120, onnet: 30 },
        hours: HOURS
      }
    },
    trends: { total: 8.2, inbound: 7.7, missed: 8.3, outbound: 6.6, onnet: 56.6 },
    topAgents: [{ extension: '6080', name: 'Ada Lovelace', calls: 240, answered: 230, missed: 10, talkSeconds: 48200, aht: 210, slaPct: 91.2 }],
    agentPerformance: [
      { extension: '6080', name: 'Ada Lovelace', department: 'Sales', site: 'HQ', inbound: 200, outbound: 40, missed: 10, onnet: 5, talkSeconds: 48200, ringSeconds: 2400, aht: 210, slaPct: 91.2, answered: 230, total: 255 },
      { extension: '6081', name: 'Alan Turing', department: 'Support', site: 'HQ', inbound: 150, outbound: 20, missed: 12, onnet: 3, talkSeconds: 31000, ringSeconds: 2100, aht: 190, slaPct: 84.4, answered: 165, total: 185 }
    ],
    inventory: { agents: 2, totalNumbers: 4, enabledNumbers: 3, autoAttendants: 2, aaCalls: 300, queues: 3 },
    timezone: 'US/Eastern'
  },
  agents: { data: [
    { extension: '6080', name: 'Ada Lovelace', department: 'Sales', site: 'HQ', calls: 255, answered: 230, missed: 10, talkSeconds: 48200, aht: 210, slaPct: 91.2 },
    { extension: '6081', name: 'Alan Turing', department: 'Support', site: 'HQ', calls: 185, answered: 165, missed: 12, talkSeconds: 31000, aht: 190, slaPct: 84.4 }
  ], total: 2, page: 1, size: 25, last_page: 1 },
  telephone_numbers: {
    numbers: [
      { id: '1', number: '8457620002', type: 'Local DID', enabled: true,
        calls: { inbound: 812, missed: 143, outbound: 12, talkSeconds: 41230, firstCall: '2026-08-02T10:00:00Z', lastCall: '2026-08-02T18:00:00Z' },
        destination: { name: 'Main line', extension: '2000', department: 'Support', site: 'HQ' },
        routing: { application: 'to-callqueue' } },
      { id: '2', number: '8005551212', type: 'Toll-Free', enabled: false,
        calls: { inbound: 130, missed: 12, outbound: 0, talkSeconds: 8040 },
        destination: { name: 'Sales', extension: '2200', department: 'Sales', site: 'Branch' },
        routing: { application: 'to-user' } }
    ],
    summary: { totalNumbers: 2, enabledNumbers: 1, totalCalls: 942, totalInbound: 942, totalMissed: 155, totalTalkSeconds: 49270 },
    charts: { hours: HOURS, days: DAYS, outcomes: { answered: 942, missed: 155, busy: 0, failed: 0 }, duration: [{ label: '0–30s', count: 40 }], heatmap: Array.from({ length: 7 }, () => HOURS) },
    repeatCallers: [{ caller: '8454259810', calls: 3, answered: 2, missed: 1, dids: [{ number: '8457620002', calls: 3, answered: 2, missed: 1 }] }],
    departments: ['Support', 'Sales'], sites: ['HQ', 'Branch']
  },
  simultaneous_calls: {
    summary: {
      peak: 8, peakDate: '2026-08-02', peakTime: '14:15', peakEndTime: '14:30', average: 1.42,
      inbound: 1400, missed: 130, totalCalls: 1530, excludedOnnet: 47, excludedOutbound: 480,
      intervalMinutes: 15, intervalCount: 5, zeroIntervals: 0,
      busiestDay: { date: '2026-08-02', peak: 8, time: '14:15' },
      busiestHour: { hour: 14, peak: 8, label: '14:00' },
      timezone: 'US/Eastern', start: '2026-08-02', end: '2026-08-06', department: '', site: '', agents: []
    },
    intervals: Array.from({ length: 5 }, (_, i) => ({
      date: '2026-08-0' + (i + 2), time: '14:1' + i, endTime: '14:3' + i, label: 'Aug ' + (i + 2) + ', 14:1' + i,
      hour: 14, simultaneous: 8 - i, average: 1.2, started: 12
    })),
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, label: String(h).padStart(2, '0') + ':00', peak: h === 14 ? 8 : 3, average: 1.1, started: 40 })),
    byDay: [
      { date: '2026-08-02', peak: 8, time: '14:15', endTime: '14:30', average: 1.4, started: 812 },
      { date: '2026-08-03', peak: 6, time: '11:30', endTime: '11:45', average: 1.2, started: 655 }
    ],
    insight: 'Busiest moment: 8 simultaneous inbound calls on 2026-08-02 at 14:15.'
  },
  queue: {
    queues: [{ callqueue: '700', description: 'Sales queue', site: 'HQ', agentsOnline: 4, agentsTotal: 6, waiting: 2, calls: 240, slaPct: 88 }],
    selected: '700',
    queue: { callqueue: '700', description: 'Sales queue', site: 'HQ', dispatchType: 'simultaneous' },
    kpis: { waiting: 2, agentsAvailable: 4, agentsTotal: 6, totalCalls: 240, avgWait: 18, sla: 88.4, abandonRate: 3.2, aht: 205, longestWait: 74 },
    charts: { hours: HOURS, days: DAYS, outcomes: { answered: 240, missed: 20, busy: 1, failed: 0 }, duration: [{ label: '0–30s', count: 30 }], heatmap: Array.from({ length: 7 }, () => HOURS) },
    agents: [{ extension: '6080', name: 'Ada Lovelace', calls: 120, answered: 118, missed: 2, talkSeconds: 24000, aht: 200, slaPct: 92 }],
    recent: [{ id: 'c1', startedAt: '2026-08-02T14:15:00Z[US/Eastern]', from: 'Ada', fromNumber: '8454259810', to: '700', outcome: 'answered', ringing: 12, talking: 180, queue: '700' }],
    leaderboard: [{ extension: '6080', name: 'Ada Lovelace', calls: 120, answered: 118, aht: 200 }],
    timezone: 'US/Eastern'
  },
  cradle: {
    kpis: { totalCalls: 240, answered: 220, missed: 20, abandoned: 5, avgRing: 12, avgTalk: 180, avgHandle: 192, slaPct: 88.4, abandonPct: 3.2 },
    cradle: [{ label: '0–10s', count: 60 }, { label: '10–20s', count: 40 }],
    hours: HOURS, days: DAYS,
    agents: [{ extension: '6080', name: 'Ada Lovelace', calls: 120, answered: 118, aht: 200, slaPct: 92 }],
    queues: [{ callqueue: '700', description: 'Sales queue', calls: 240, slaPct: 88 }],
    timeline: [{ at: '2026-08-02T14:15:00Z[US/Eastern]', kind: 'ring', label: 'Ring', agent: '6080', queue: '700' }],
    timezone: 'US/Eastern'
  },
  call_history: {
    data: [{
      id: 'c1', type: 'inbound', startedAt: '2026-08-02T14:15:00Z[US/Eastern]', disconnectedAt: '2026-08-02T14:18:00Z[US/Eastern]',
      from: 'Ada', fromNumber: '8454259810', dialed: '8457620002', to: 'Main line', agent: '6080', agentName: 'Ada Lovelace',
      throughUser: '700', outcome: 'answered', ringing: 12, talking: 180, disconnectReason: 'Orig: Bye',
      origCallId: 'o1', termCallId: 't1', traceApi: '/ns-api/v2/sipflow?callid=o1', servers: 'nms1',
      hasRecording: true
    }],
    total: 1, page: 1, size: 25, last_page: 1,
    stats: { total: 1, answered: 1, missed: 0, abandoned: 0, avgRing: 12, avgTalk: 180 },
    insight: { text: 'Answered rate 100%.', tone: 'good' }
  },
  aa: {
    autoAttendants: [{ extension: '900', name: 'Main IVR', site: 'HQ', calls: 300, answered: 280, missed: 20, talkSeconds: 12000, aht: 40 }],
    rows: [{ extension: '900', name: 'Main IVR', calls: 300, answered: 280, missed: 20, talkSeconds: 12000, aht: 40, options: 4, dtmf: 120 }],
    calls: [{ id: 'aa1', startedAt: '2026-08-02T14:15:00Z[US/Eastern]', fromNumber: '8454259810', digit: '1', option: 'Sales', outcome: 'answered', ringing: 8, talking: 120 }],
    structures: {}, structuresDeferred: true, rosterOnly: false,
    kpis: { totalCalls: 300, answered: 280, missed: 20, dtmfHits: 120, avgRing: 8, avgTalk: 40, uniqueCallers: 180 },
    charts: { hours: HOURS, days: DAYS, outcomes: { answered: 280, missed: 20, busy: 0, failed: 0 }, duration: [{ label: '0–30s', count: 200 }], heatmap: Array.from({ length: 7 }, () => HOURS) },
    options: [{ digit: '1', label: 'Sales', calls: 120, destinationType: 'Queue' }],
    flow: { nodes: [], edges: [] },
    timezone: 'US/Eastern'
  },
  alerts: { data: { settings: { missedPct: 20, slaPct: 80, abandonPct: 10 }, items: [], count: 0 }, items: [], count: 0, settings: {} },
  calls: { data: [{ id: 'c1', startedAt: '2026-08-02T14:15:00Z[US/Eastern]', fromNumber: '8454259810', from: 'Ada', dialed: '8457620002', to: 'Main line', agent: '6080', agentName: 'Ada Lovelace', outcome: 'answered', ringing: 12, talking: 180, type: 'inbound', disconnectReason: 'Orig: Bye' }], total: 1, page: 1, size: 25, last_page: 1 },
  call_flow: { data: { steps: [{ ts: '2026-08-02 14:15:00', kind: 'ring', label: 'Ring start', diff_ts: '+0s' }], count: 1 }, steps: [], count: 1 },
  recording: { data: { url: 'https://pbx.example/ns-api/rec?callid=c1', duration: 180, status: 'available', callId: 'c1' } },
  audio: { data: { url: '', duration: 0, status: '', callId: '' } },
  login: { user: { username: 'om@7826.DynaCloud', displayName: 'Test OM', role: 'office_manager', domain: '7826.DynaCloud', extension: '1000' } },
  logout: { ok: true }
};

/* ------------------------------------------------------------------- harness */

const CHART_STUB = `
class ChartStub {
  constructor(canvas, config) { this.canvas = canvas; this.config = config || {}; this.data = this.config.data || { datasets: [] }; this.options = this.config.options || {}; }
  destroy() {}
  update() {}
  resize() {}
  static register() {}
}
window.Chart = ChartStub;
window.Chart.defaults = { font: {}, color: '', plugins: {} };
`;

export async function createHarness(options = {}) {
  const { user = FIXTURES.session.user, search = '' } = options;

  /* jsdom's default virtual console prints "Not implemented" noise (canvas,
   * navigation) that is irrelevant here; keep the run output readable. */
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost:8080/' + (search ? '?' + search : ''),
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole
  });
  const { window } = dom;

  const errors = [];    // hard failures: render crashes, thrown TypeErrors
  const warnings = [];  // React dev warnings (missing keys, deprecations)
  window.addEventListener('error', event => errors.push('window.error: ' + (event.message || event.error)));
  window.console.error = (...args) => {
    const text = args.map(a => (a && a.message) ? a.message : String(a)).join(' ');
    if (/not wrapped in act|deprecated|ReactDOMTestUtils/i.test(text)) return;
    if (/Warning:/.test(text)) warnings.push(text.split('\n')[0].slice(0, 200));
    else errors.push('console.error: ' + text.slice(0, 300));
  };
  window.console.warn = () => {};

  /* Chart.js needs a 2d context; jsdom has no canvas package installed. Our
   * Chart stub never touches it, but app code probes getContext() in a try. */
  window.HTMLCanvasElement.prototype.getContext = () => null;

  /* --- network --------------------------------------------------------- */
  const requested = [];
  window.fetch = async (url, init = {}) => {
    const href = String(url);
    const name = (href.match(/api\/([a-z_-]+)\.php/i) || [])[1] || href;
    requested.push({ endpoint: name, method: init.method || 'GET', body: init.body });

    if (href.includes('/api/logout.php') && init.method === 'POST') {
      return jsonResponse(FIXTURES.logout);
    }
    const fixture = FIXTURES[name];
    if (fixture === undefined) {
      if (/^https?:/.test(href)) return binaryResponse('');
      return jsonResponse({ error: 'harness: no fixture for ' + name }, 404);
    }
    if (name === 'session') return jsonResponse({ ...FIXTURES.session, user });

    /* Export requests are answered the way the real endpoint answers them:
     * a CSV attachment, not JSON. */
    if (String(init.body || '').includes('"export":true')) {
      const stamp = new Date().toISOString().slice(0, 10);
      return csvResponse('callscope-' + name + '-' + stamp + '.csv');
    }

    if (/^https?:/.test(href)) return binaryResponse('');
    return jsonResponse(fixture);
  };

  const jsonResponse = (body, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  });
  const csvResponse = filename => ({
    ok: true,
    status: 200,
    text: async () => 'a,b\n1,2\n',
    blob: async () => new window.Blob(['a,b\n1,2\n'], { type: 'text/csv;charset=utf-8' }),
    headers: { get: name => (String(name).toLowerCase() === 'content-disposition' ? 'attachment; filename="' + filename + '"' : 'text/csv') },
    downloads: []
  });
  const binaryResponse = text => ({
    ok: true, status: 200, text: async () => text,
    arrayBuffer: async () => new window.ArrayBuffer(0),
    blob: async () => new window.Blob([]),
    headers: { get: () => 'audio/mpeg' }
  });

  window.XMLHttpRequest = window.XMLHttpRequest || class { open() {} send() {} setRequestHeader() {} };
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};

  /* --- globals + libraries --------------------------------------------- */
  const React = (await import('react')).default;
  const ReactDOM = await import('react-dom/client');
  const g = globalThis;
  g.window = window;
  g.document = window.document;
  Object.defineProperty(g, 'navigator', { value: window.navigator, configurable: true });
  g.HTMLElement = window.HTMLElement;
  g.Element = window.Element;
  g.Node = window.Node;
  g.Event = window.Event;
  g.MouseEvent = window.MouseEvent;
  g.KeyboardEvent = window.KeyboardEvent;
  g.CustomEvent = window.CustomEvent;
  g.Blob = window.Blob;
  g.FormData = window.FormData;
  g.DOMRect = window.DOMRect;
  g.localStorage = window.localStorage;
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  g.IS_REACT_ACT_ENVIRONMENT = true;

  window.React = React;
  window.ReactDOM = ReactDOM;
  window.eval(CHART_STUB);
  window.Tabulator = class {
    constructor() { this.handlers = {}; }
    on() { return this; } setData() { return this; } setColumns() { return this; }
    destroy() {} redraw() { return this; } setHeight() { return this; } setFilter() { return this; }
  };
  g.Chart = window.Chart;
  g.Tabulator = window.Tabulator;

  /* --- the app under test ---------------------------------------------- */
  const bundle = readFileSync(BUNDLE, 'utf8');
  window.eval(bundle);

  const { act } = await import('react-dom/test-utils');
  const flush = async (rounds = 6) => {
    await act(async () => {
      for (let i = 0; i < rounds; i++) await Promise.resolve();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await act(async () => { await Promise.resolve(); });
  };

  const click = async element => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
  };

  /* Keyboard activation: rows and list items carry tabIndex + onKeyDown, and
   * the dialogs listen for Escape on `document`, so the target can be any
   * element or the document itself. */
  const press = async (target, key = 'Enter') => {
    await act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await flush();
  };

  const byText = (selector, text) =>
    [...window.document.querySelectorAll(selector)].find(el => el.textContent.trim() === text);
  const containing = (selector, text) =>
    [...window.document.querySelectorAll(selector)].find(el => el.textContent.includes(text));
  const root = () => window.document.getElementById('root');

  return { dom, window, document: window.document, React, ReactDOM, flush, click, press, byText, containing, root, errors, warnings, requested };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
