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
  settings: {
    slaSeconds: 20, slaPct: 80, abandonPct: 10, missedPct: 20,
    ahtMinutes: 5, ahtOutboundMinutes: 5, contactPct: 50, topAgentAhtMinutes: 5, topAgentMinCalls: 20,
    /* Sprint A: the service-desk block. The calendar ships OFF, exactly as a
     * fresh install does, with the Mon-Fri grid pre-filled. */
    businessHours: {
      enabled: false,
      days: {
        1: { closed: false, open: '08:00', close: '18:00' },
        2: { closed: false, open: '08:00', close: '18:00' },
        3: { closed: false, open: '08:00', close: '18:00' },
        4: { closed: false, open: '08:00', close: '18:00' },
        5: { closed: false, open: '08:00', close: '18:00' },
        6: { closed: true, open: '', close: '' },
        7: { closed: true, open: '', close: '' }
      },
      holidays: []
    },
    queueSla: { 700: 15 },
    roster: [{ extension: '6080', name: 'Ada Lovelace', team: 'Sales', supervisor: 'Sup', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]
  },
  /*
   * Mirrors api/filters.php: departments/sites plus the metric catalog from
   * includes/reporting/metrics.php. The `total` title is a sentinel on
   * purpose — the smoke test asserts the dialog shows THIS wording, which
   * proves the client reads the server catalog instead of a local copy
   * (QA-8). The real catalog is asserted in tests/php/outcomes.mjs.
   */
  filters: {
    departments: ['Sales', 'Support', 'Billing'],
    sites: ['HQ', 'Branch'],
    agents: [
      { extension: '6080', name: 'Ada Lovelace', department: 'Sales', site: 'HQ' },
      { extension: '6081', name: 'Alan Turing', department: 'Support', site: 'HQ' }
    ],
    queues: [
      { id: '700', description: 'Sales queue' },
      { id: '701', description: 'Support queue' }
    ],
    businessHours: {
      enabled: false,
      configured: false,
      days: {
        1: { closed: false, open: '08:00', close: '18:00' },
        2: { closed: false, open: '08:00', close: '18:00' },
        3: { closed: false, open: '08:00', close: '18:00' },
        4: { closed: false, open: '08:00', close: '18:00' },
        5: { closed: false, open: '08:00', close: '18:00' },
        6: { closed: true, open: '', close: '' },
        7: { closed: true, open: '', close: '' }
      },
      holidays: []
    },
    metrics: {
      total: {label: 'All calls', title: 'All calls (served by api/filters.php)'},
      missed: {label: 'Missed', title: 'Missed'}
    }
  },
  cache_job: { complete: true, ready: 5, total: 5, percent: 100, next: null, start: '2026-08-02', end: '2026-08-06', warming: false },
  report: {
    links: {
      offered: 12,
      transfers: {
        count: 3, transferredInteractions: 2, handled: 10, ratePct: 20, perTransferred: 1.5,
        agentPairs: [{ from: '6080', to: '6081', count: 2 }], queuePairs: []
      },
      callbacks: {
        windowSeconds: 86400, missed: 5, returned: 3, unreturned: 2, ratePct: 60,
        avgReturnSeconds: 1500, fastest: null, slowest: null, worklist: [], unreturnedList: []
      },
      repeat: { callers: 10, repeat24: 3, repeat72: 4, rate24Pct: 30, rate72Pct: 40, top: [] }
    },
    filters: { start: '2026-08-02', end: '2026-08-06', department: '', site: '', agents: [] },
    callTypes: { inbound: true, outbound: true, missed: true, onnet: true },
    summary: {
      counts: { total: 2057, inbound: 1400, outbound: 480, missed: 130, onnet: 47 },
      /* Sums to counts.missed on purpose: the front end must never have to
       * guess which bucket a missed call is in. */
      missedBreakdown: { noanswer: 55, voicemail: 15, abandon: 60 },
      inbound: panel('Inbound', HOURS, DAYS),
      outbound: panel('Outbound', HOURS, DAYS),
      hours: HOURS,
      /*
       * AHT by hour (Sprint A). Two busy hours and twenty-two empty ones — the
       * shape a real quiet week has. Hour 9 carries the outbound/on-net talk
       * that must NOT enter AHT: 60 s of inbound talk over 1 answered call,
       * which is why the hour reads 60 s rather than 487 s.
       */
      hourly: Array.from({ length: 24 }, (_, h) => (
        h === 8 ? { hour: 8, calls: 3, answered: 2, missed: 1, talkSeconds: 300, aht: 150 }
          : h === 9 ? { hour: 9, calls: 4, answered: 1, missed: 1, talkSeconds: 60, aht: 60 }
            : { hour: h, calls: 0, answered: 0, missed: 0, talkSeconds: 0, aht: 0 }
      )),
      days: DAYS,
      outcomes: { answered: 1400, missed: 130, busy: 12, failed: 6 },
      duration: [{ label: '0–30s', count: 120 }, { label: '30–60s', count: 90 }],
      heatmap: Array.from({ length: 7 }, () => HOURS.map(n => Math.round(n / 3))),
      /* Sprint A: the wait bands, the hold nobody used to see, and the links
       * block (transfers / returned calls / repeat callers). */
      waitBuckets: { '0-30': 6, '31-60': 3, '61-120': 2, '120+': 1 },
      missedWaitBuckets: { lt5: 1, '5-30': 2, gt30: 2 },
      abandonWaitBuckets: { lt5: 1, '5-30': 1, gt30: 2 },
      hold: { totalSeconds: 480, calls: 3, avgSeconds: 160 }
    },
    comparison: {
      /* F3: the baseline's own name and length, as the server publishes them. */
      mode: 'previous',
      label: 'previous 5 days',
      days: 5,
      previous: {
        start: '2026-07-27', end: '2026-07-31',
        counts: { total: 1900, inbound: 1300, outbound: 450, missed: 120, onnet: 30 },
        missedBreakdown: { noanswer: 50, voicemail: 12, abandon: 58 },
        hours: HOURS
      }
    },
    trends: { total: 8.2, inbound: 7.7, missed: 8.3, outbound: 6.6, onnet: 56.6 },
    topAgents: [{ extension: '6080', name: 'Ada Lovelace', calls: 240, answered: 230, missed: 10, talkSeconds: 48200, aht: 210, slaPct: 91.2 }],
    /*
     * Real agentPerformance() field names (see includes/reporting/rows.php):
     * mc is missed-and-not-abandoned, ab is abandoned, offered is
     * ib + mc + ab, mcRate is every missed call ÷ offered.
     */
    agentPerformance: [
      { extension: '6080', name: 'Ada Lovelace', department: 'Sales', site: 'HQ', total: 245, ib: 200, ob: 40, mc: 24, ab: 16, onnet: 5, ibAht: 210, ibAat: 12, ibLtt: 900, ibTct: 42000, obArt: 8, obAat: 10, obLtt: 300, obTct: 1200, offered: 240, mcRate: 16.7, abRate: 6.7, obConnected: 29, obConnectPct: 72.5, holdTotal: 900, holdCalls: 30, holdAvg: 30 },
      { extension: '6081', name: 'Alan Turing', department: 'Support', site: 'HQ', total: 185, ib: 150, ob: 20, mc: 20, ab: 15, onnet: 3, ibAht: 190, ibAat: 14, ibLtt: 700, ibTct: 28500, obArt: 9, obAat: 11, obLtt: 240, obTct: 800, offered: 185, mcRate: 18.9, abRate: 8.1, obConnected: 8, obConnectPct: 40, holdTotal: 120, holdCalls: 4, holdAvg: 30 }
    ],
    inventory: { agents: 2, totalNumbers: 4, enabledNumbers: 3, autoAttendants: 2, aaCalls: 300, queues: 3 },
    timezone: 'US/Eastern'
  },
  agents: { data: [
    { extension: '6080', name: 'Ada Lovelace', department: 'Sales', site: 'HQ', total: 245, ib: 200, ob: 40, mc: 24, ab: 16, onnet: 5, ibAht: 210, ibAat: 12, ibLtt: 900, ibTct: 42000, obArt: 8, obAat: 10, obLtt: 300, obTct: 1200, obConnected: 29, obConnectPct: 72.5, holdTotal: 900, holdCalls: 30, holdAvg: 30 },
    { extension: '6081', name: 'Alan Turing', department: 'Support', site: 'HQ', total: 185, ib: 150, ob: 20, mc: 20, ab: 15, onnet: 3, ibAht: 190, ibAat: 14, ibLtt: 700, ibTct: 28500, obArt: 9, obAat: 11, obLtt: 240, obTct: 800, obConnected: 8, obConnectPct: 40, holdTotal: 120, holdCalls: 4, holdAvg: 30 }
  ], total: 2, page: 1, size: 25, last_page: 1 },
  telephone_numbers: {
    numbers: [
      { id: '1', number: '8457620002', type: 'Local DID', enabled: true,
        calls: { inbound: 812, missed: 143, abandoned: 58, outbound: 12, talkSeconds: 41230, firstCall: '2026-08-02T10:00:00Z', lastCall: '2026-08-02T18:00:00Z' },
        destination: { name: 'Main line', extension: '2000', department: 'Support', site: 'HQ' },
        routing: { application: 'to-callqueue' } },
      { id: '2', number: '8005551212', type: 'Toll-Free', enabled: false,
        calls: { inbound: 130, missed: 12, abandoned: 2, outbound: 0, talkSeconds: 8040 },
        destination: { name: 'Sales', extension: '2200', department: 'Sales', site: 'Branch' },
        routing: { application: 'to-user' } }
    ],
    summary: { totalNumbers: 2, enabledNumbers: 1, totalCalls: 942, totalInbound: 942, totalMissed: 155, totalAbandoned: 60, totalTalkSeconds: 49270 },
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
    /*
     * Two queues for the Queue stats grid, with numbers chosen so the totals
     * row can be checked by hand and so a WRONG aggregate is visibly wrong:
     * the weighted average ring time is (20x70 + 10x45) / 115 = 16 s, while the
     * mean of the two averages would be 15 s, and the SLA rate is
     * (80x100 + 90x60) / 160 = 83.8 % (weighted by the larger of offered and
     * legs, the page's own rule) rather than the 85 % mean of 80 and 90.
     */
    queueStats: [
      { callqueue: '700', description: 'Sales queue', site: 'HQ', totalCalls: 100, offered: 80, handled: 70,
        slaMiss: 14, sla: 80, abandoned: 10, abandonRate: 12.5,
        avgRing: 20, maxRing: 90, avgTalk: 180, maxTalk: 600, totalTalk: 20000,
        holdCalls: 6, holdAvg: 45, holdTotal: 270 },
      { callqueue: '701', description: 'Support queue', site: 'HQ', totalCalls: 60, offered: 50, handled: 45,
        slaMiss: 5, sla: 90, abandoned: 5, abandonRate: 10,
        avgRing: 10, maxRing: 60, avgTalk: 120, maxTalk: 400, totalTalk: 8000,
        holdCalls: 0, holdAvg: 0, holdTotal: 0 }
    ],
    /*
     * Service level by interval (Sprint A): two busy intervals, so the card's
     * totals line can be checked by hand.
     *   09:00  6 offered, 5 answered, 1 abandoned, asa 20 s, sla 80 %, 1 missed
     *   10:00  2 offered, 2 answered, 0 abandoned, asa 40 s, sla 50 %, 1 missed
     * Totals: 8 offered / 7 answered / 1 abandoned; weighted ASA
     * (5x20 + 2x40) / 7 = 25.7 s; SLA (7 - 2) / 7 = 71.4 % (NOT the 65 % mean).
     */
    intervalMinutes: 60,
    intervalSla: [
      { from: '09:00', to: '10:00', offered: 6, answered: 5, abandoned: 1, asa: 20, sla: 80, slaMiss: 1 },
      { from: '10:00', to: '11:00', offered: 2, answered: 2, abandoned: 0, asa: 40, sla: 50, slaMiss: 1 }
    ],
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
  /*
   * Two rows, because the Rec / SIP flow columns have to render BOTH states:
   * c1 points at a recording and a trace, c2 at neither. The field set is the
   * one callsRow() builds (api/calls.php).
   */
  calls: {
    data: [
      { id: 'c1', startedAt: '2026-08-02T14:15:00Z[US/Eastern]', disconnectedAt: '2026-08-02T14:18:00Z[US/Eastern]',
        fromNumber: '8454259810', from: 'Ada', dialed: '8457620002', to: 'Main line', agent: '6080', agentName: 'Ada Lovelace',
        outcome: 'answered', ringing: 12, talking: 180, type: 'inbound', disconnectReason: 'Orig: Bye',
        origCallId: 'c1-orig', termCallId: 'c1-term', origUser: '8454259810', termUser: '6080',
        recordingCallId: 'c1-term', recordingUser: '6080', traceApi: '/ns-api/v2/sipflow?call=c1', servers: 'pbx.example',
        hasRecordingHint: true, hasFlowHint: true },
      { id: 'c2', startedAt: '2026-08-02T14:30:00Z[US/Eastern]', disconnectedAt: '2026-08-02T14:31:00Z[US/Eastern]',
        fromNumber: '8454259811', from: 'Bob', dialed: '8457620002', to: 'Main line', agent: '6080', agentName: 'Ada Lovelace',
        outcome: 'missed', ringing: 20, talking: 0, type: 'missed', disconnectReason: 'Orig: Bye',
        origCallId: 'c2-orig', termCallId: '', origUser: '8454259811', termUser: '6080',
        recordingCallId: '', recordingUser: '6080', traceApi: '', servers: '',
        hasRecordingHint: false, hasFlowHint: false }
    ],
    total: 2, page: 1, size: 25, last_page: 1
  },
  call_flow: { data: { steps: [{ ts: '2026-08-02 14:15:00', kind: 'ring', label: 'Ring start', diff_ts: '+0s' }], count: 1 }, steps: [], count: 1 },
  recording: { data: { url: 'https://pbx.example/ns-api/rec?callid=c1', duration: 180, status: 'available', callId: 'c1' } },
  audio: { data: { url: '', duration: 0, status: '', callId: '' } },
  login: { user: { username: 'om@7826.DynaCloud', displayName: 'Test OM', role: 'office_manager', domain: '7826.DynaCloud', extension: '1000' } },
  logout: { ok: true }
};

/* ------------------------------------------------------------------- harness */

const CHART_STUB = `
window.__charts = [];
class ChartStub {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config || {};
    this.data = this.config.data || { datasets: [] };
    this.options = this.config.options || {};
    /* Charts are clickable (hour bars, intervals); keep them reachable. */
    window.__charts.push(this);
  }
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

    /*
     * A fixture tagged {__status: 502, ...} is answered with that status, so a
     * test can force a panel failure, restore the fixture, and assert the
     * Retry button recovers (QA-9).
     */
    if (fixture && typeof fixture === 'object' && fixture.__status) {
      const {__status, ...body} = fixture;
      return jsonResponse(body, __status);
    }

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
  /*
   * The page loads the full react-dom UMD build, which carries createPortal as
   * well as createRoot. The client-only entry point has no createPortal, so
   * every portalled dialog (the call modal, the date-range popup, the AA sheet)
   * used to explode the moment this suite opened one — merge both.
   */
  const ReactDOMFull = await import('react-dom');
  const ReactDOMClient = await import('react-dom/client');
  const ReactDOM = { ...ReactDOMFull, ...ReactDOMClient };
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
  /*
   * Tabulator renders its own DOM, so the stub cannot be exercised for real —
   * but it CAN remember the options it was constructed with, which is how the
   * suite inspects the column definitions (titles, fields, formatters) the
   * modal passes in.
   */
  window.__tabulatorTables = [];
  window.Tabulator = class {
    constructor(el, options) {
      this.el = el;
      this.options = options || {};
      this.handlers = {};
      window.__tabulatorTables.push(this);
    }
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

  /*
   * Type into a controlled input the way React can see it.
   *
   * Setting element.value directly updates React's own value tracker, so the
   * change is swallowed as a no-op: the DOM shows the new text and the component
   * never hears about it. Going through the native setter is what a real
   * keystroke does.
   */
  const typeInto = async (element, value) => {
    const proto = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    await act(async () => {
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };

  return {
    dom, window, document: window.document, React, ReactDOM, flush, click, press,
    byText, containing, root, errors, warnings, requested, typeInto,
    /* Every Tabulator the app constructed, oldest first. */
    tables: window.__tabulatorTables,
    /* Every Chart the app constructed, oldest first. */
    charts: window.__charts,
    /* Chart options.onClick handlers run outside React's act() otherwise. */
    act: async fn => { await act(async () => { await fn(); }); }
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
