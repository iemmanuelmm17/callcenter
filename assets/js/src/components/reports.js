/*
 * The month-end report (Sprint C).
 *
 * One page that prints to PDF, plus the CSVs behind it. Everything on it is
 * either a figure the server computed (report.php summary / comparison /
 * pack / dataQuality) or arithmetic on those figures done here in the open —
 * no second definition of a published number lives in this file.
 *
 * The layout rules:
 *
 *   - a rate never appears without its base, and the base is printed in the
 *     same cell or the line under it;
 *   - the page says what it is comparing against, and when the comparison has
 *     not loaded yet it says THAT rather than showing a zero;
 *   - the staffing estimate prints the occupancy assumption beside it, because
 *     there is no roster in this system and the number would otherwise read as
 *     measured occupancy;
 *   - the baseline is labelled a baseline, not a forecast;
 *   - sentiment counts only the calls that were scored, and the footnote says
 *     an abandoned call is never scored.
 *
 * Printing: the shell's chrome carries app-nav / app-header / filters-bar and
 * those are hidden in print (custom.css), so the printed page is the report.
 */
import { api } from '../lib/api.js';
import { fmt, fmtNum } from '../lib/format.js';
import { h, useEffect, useState } from '../lib/react.js';
import { skel } from './ui.js';
import { WeekHourHeatmap } from './heatmap.js';

const pct = (part, base) => (Number(base) > 0 ? ((Number(part) / Number(base)) * 100) : 0);
const one = value => Number(value || 0).toFixed(1);

function downloadCsv(filename, header, rows) {
    const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const csv = [header, ...rows].map(row => row.map(cell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

function repTable(headCells, bodyRows, footRow) {
    const head = h('tr', null, ...headCells.map((c, i) =>
        h('th', { key: String(i), className: c.num ? 'rep-th rep-num' : 'rep-th' }, c.label)));
    const rows = bodyRows.map((cells, r) =>
        h('tr', { key: String(r) }, ...cells.map((cell, i) => {
            const spec = typeof cell === 'object' && cell !== null ? cell : { value: cell };
            const classes = ['rep-td'];
            if (spec.num) classes.push('rep-num');
            if (spec.bad) classes.push('rep-flag-bad');
            if (spec.warn) classes.push('rep-flag-warn');
            return h('td', { key: String(i), className: classes.join(' ') }, spec.value);
        })));
    return h('table', { className: 'rep-table' },
        h('thead', null, head),
        h('tbody', null, ...rows),
        footRow ? h('tfoot', null, footRow) : null);
}

function repSection(title, note, body) {
    return h('section', { className: 'rep-sec' },
        h('h2', { className: 'rep-sec-title' }, title),
        note ? h('p', { className: 'rep-note' }, note) : null,
        body);
}

function ReportsDashboard({filters, user, loading: shellLoading}) {
    const [report, setReport] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    /*
     * One request, the pack included. Deliberately NOT skipPrevious: this page
     * is the month-end pack and its whole point is the "vs last month / last
     * year" line, so it fetches the comparison in the same call rather than
     * painting half a report and filling it in later.
     */
    useEffect(() => {
        let active = true;
        setLoading(true);
        api('report', { ...filters, baseline: 1 })
            .then(r => {
                if (!active) return;
                const payload = r && r.data ? r.data : r;
                setReport(payload || null);
                setError('');
            })
            .catch(e => { if (active) setError(String(e && e.message ? e.message : e)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [JSON.stringify(filters)]);

    if (loading || shellLoading) {
        return h('div', { className: 'rep' }, skel('h-64 w-full'));
    }
    if (error) {
        return h('div', { className: 'rep' },
            h('div', { className: 'rep-error' }, 'The report could not be loaded: ' + error));
    }
    if (!report || !report.summary) return null;

    const S = report.summary || {};
    const counts = S.counts || {};
    const mb = S.missedBreakdown || {};
    const sla = S.sla || {};
    const prev = report.comparison?.previous || {};
    const prevCounts = prev.counts || {};
    const prevMb = prev.missedBreakdown || {};
    const pack = report.pack || {};
    const quality = pack.quality || {};
    const staffing = pack.staffing || {};
    const baseline = pack.baseline || null;
    const sentiment = S.sentiment || {};
    const dq = report.dataQuality || {};
    const hours = S.hourly || [];
    const answered = Number(counts.inbound || 0);
    const missed = Number(counts.missed || 0);
    const arrived = answered + missed;
    const abandoned = Number(mb.abandon || 0);
    const prevArrived = Number(prevCounts.inbound || 0) + Number(prevCounts.missed || 0);
    const periodLabel = filters.start === filters.end ? filters.start : filters.start + ' – ' + filters.end;
    const scopeBits = [
        filters.department ? 'department ' + filters.department : '',
        filters.site ? 'site ' + filters.site : '',
        'hours ' + (filters.hours && filters.hours !== 'all' ? filters.hours : 'all'),
        filters.sentiment ? 'sentiment ' + filters.sentiment : ''
    ].filter(Boolean);
    const csvStamp = (filters.start || '') + '_' + (filters.end || '');

    const delta = (now, before) => {
        const a = Number(now || 0);
        const b = Number(before || 0);
        if (!b) return a ? '+100 %' : '—';
        return (a >= b ? '+' : '') + one(((a - b) / b) * 100) + ' %';
    };

    const headKpis = [
        ['Offered calls', fmtNum(arrived), 'answered + missed'],
        ['Answered', fmtNum(answered), one(pct(answered, arrived)) + ' % of offered'],
        ['Missed', fmtNum(missed), one(pct(missed, arrived)) + ' % of offered'],
        ['Abandoned', fmtNum(abandoned), one(pct(abandoned, arrived)) + ' % of offered'],
        ['Service level', one(sla.sla20) + ' %',
            sla.perQueue ? 'mean target ' + sla.avgTargetSeconds + ' s (per queue)'
                : 'within ' + (sla.avgTargetSeconds || 20) + ' s · base ' + fmtNum(answered) + ' answered'],
        ['Inbound AHT', fmt(S.inbound?.avgHandle || 0), 'answered inbound · base ' + fmtNum(answered)],
        ['Hold', fmt(S.hold?.avgSeconds || 0),
            'avg over ' + fmtNum(S.hold?.calls || 0) + ' held calls · ' + fmt(S.hold?.totalSeconds || 0) + ' total']
    ];

    const kpiRow = h('div', { className: 'rep-kpis' },
        ...headKpis.map(([label, value, sub], i) => h('div', { key: String(i), className: 'rep-kpi' },
            h('div', { className: 'rep-kpi-label' }, label),
            h('div', { className: 'rep-kpi-value' }, value),
            h('div', { className: 'rep-kpi-sub' }, sub))));

    const compareRows = [
        ['Total calls', counts.total || 0, prevCounts.total || 0],
        ['Offered (answered + missed)', arrived, prevArrived],
        ['Answered', answered, prevCounts.inbound || 0],
        ['Missed', missed, prevCounts.missed || 0],
        ['Abandoned', abandoned, prevMb.abandon || 0],
        ['Outbound', counts.outbound || 0, prevCounts.outbound || 0],
        ['On-net', counts.onnet || 0, prevCounts.onnet || 0]
    ].map(([label, now, before]) =>
        [{ value: label }, { value: fmtNum(now), num: true }, { value: fmtNum(before), num: true },
            { value: delta(now, before), num: true }]);

    const queueRows = (pack.queues || []).map(q => [
        { value: q.description || q.callqueue },
        { value: q.slaSeconds + ' s', num: true },
        { value: fmtNum(q.offered), num: true },
        { value: fmtNum(q.answered), num: true },
        { value: fmtNum(q.missed), num: true },
        { value: fmtNum(q.abandoned), num: true },
        { value: one(q.sla) + ' % (' + fmtNum(q.slaBase) + ')', num: true },
        { value: one(q.abandonRate) + ' %', num: true },
        { value: fmt(q.avgRing) + ' / ' + fmt(q.avgTalk), num: true },
        { value: fmt(q.holdAvg) + ' (' + fmt(q.holdTotal) + ')', num: true }
    ]);

    const numberRows = (pack.numbers || []).map(n => [
        { value: n.number },
        { value: fmtNum(n.calls), num: true },
        { value: fmtNum(n.inbound), num: true },
        { value: fmtNum(n.missed), num: true },
        { value: fmtNum(n.abandoned), num: true },
        { value: one(n.missedRate) + ' % (' + fmtNum(n.missedBase) + ')', num: true },
        { value: one(n.abandonRate) + ' % (' + fmtNum(n.missed) + ')', num: true },
        { value: n.zeroTraffic ? 'zero traffic' : (n.highAbandon ? 'high abandon' : ''), bad: !!n.highAbandon, warn: !!n.zeroTraffic }
    ]);

    const dayRows = (baseline?.days || []).map(d => [
        { value: d.date },
        { value: d.volume === 0 ? 'no calls' : fmtNum(d.volume), num: true },
        { value: d.baseline === null ? 'no prior weeks' : fmtNum(d.baseline), num: true },
        { value: d.index === null ? '—' : one(d.index) + ' %', num: true }
    ]);

    const staffRows = hours.filter(x => Number(x.answered || 0) + Number(x.missed || 0) > 0).map(x => {
        const offered = Number(x.answered || 0) + Number(x.missed || 0);
        const row = (staffing.hours || []).find(s => Number(s.hour) === Number(x.hour)) || {};
        return [
            { value: String(x.hour).padStart(2, '0') + ':00' },
            { value: fmtNum(offered), num: true },
            { value: fmt(x.aht), num: true },
            { value: fmtNum(row.workSeconds), num: true },
            { value: row.agents === undefined ? '—' : Number(row.agents).toFixed(2), num: true }
        ];
    });

    const qualRows = [
        ['Calls that connected with no answer moment', quality.missingAnswerTime],
        ['Answered calls with zero talk time', quality.zeroTalkAnswered],
        ['Legs with no disconnect reason', quality.missingDisconnectReason],
        ['Duplicate legs in the day files', quality.duplicateLegs]
    ].map(([label, q]) => [
        { value: label },
        { value: q ? fmtNum(q.count) : '—', num: true },
        { value: q ? fmtNum(q.base) : '—', num: true },
        { value: q ? one(q.pct) + ' %' : '—', num: true }
    ]);

    const dqDays = dq.days || {};
    const dqRows = Object.keys(dqDays).sort().map(date => {
        const d = dqDays[date] || {};
        return [
            { value: date },
            { value: fmtNum(d.records || 0), num: true },
            { value: d.complete ? 'complete' : 'partial', warn: !d.complete }
        ];
    });

    const printPage = () => { window.print(); };

    const exportAll = () => {
        downloadCsv('month-end-summary-' + csvStamp + '.csv',
            ['metric', 'value'],
            [['period', periodLabel], ['scope', scopeBits.join('; ')],
                ['offered', arrived], ['answered', answered], ['missed', missed], ['abandoned', abandoned],
                ['missed_noanswer', mb.noanswer || 0], ['missed_voicemail', mb.voicemail || 0],
                ['sla_pct', sla.sla20 || 0], ['sla_base_answered', answered],
                ['sla_mean_target_seconds', sla.avgTargetSeconds || 0],
                ['aht_seconds', S.inbound?.avgHandle || 0],
                ['hold_avg_seconds', S.hold?.avgSeconds || 0], ['hold_calls', S.hold?.calls || 0],
                ['sentiment_scored', sentiment.scored || 0], ['sentiment_positive', sentiment.positive || 0],
                ['sentiment_neutral', sentiment.neutral || 0], ['sentiment_negative', sentiment.negative || 0]]);
        downloadCsv('queues-' + csvStamp + '.csv',
            ['queue', 'target_s', 'offered', 'answered', 'missed', 'abandoned', 'sla_pct', 'sla_base', 'abandon_pct', 'avg_ring_s', 'avg_talk_s', 'hold_avg_s', 'hold_total_s'],
            (pack.queues || []).map(q => [q.description || q.callqueue, q.slaSeconds, q.offered, q.answered, q.missed,
                q.abandoned, q.sla, q.slaBase, q.abandonRate, q.avgRing, q.avgTalk, q.holdAvg, q.holdTotal]));
        downloadCsv('numbers-' + csvStamp + '.csv',
            ['number', 'key', 'calls', 'inbound', 'missed', 'abandoned', 'missed_pct', 'missed_base', 'abandon_pct', 'zero_traffic', 'high_abandon'],
            (pack.numbers || []).map(n => [n.number, n.key, n.calls, n.inbound, n.missed, n.abandoned,
                n.missedRate, n.missedBase, n.abandonRate, n.zeroTraffic ? 1 : 0, n.highAbandon ? 1 : 0]));
        downloadCsv('hourly-' + csvStamp + '.csv',
            ['hour', 'calls', 'answered', 'missed', 'talk_seconds', 'aht_seconds'],
            hours.map(x => [x.hour, x.calls, x.answered, x.missed, x.talkSeconds, x.aht]));
        if (baseline) {
            downloadCsv('baseline-' + csvStamp + '.csv',
                ['date', 'weekday', 'volume', 'weekday_baseline', 'index_pct'],
                (baseline.days || []).map(d => [d.date, d.weekday, d.volume, d.baseline === null ? '' : d.baseline, d.index === null ? '' : d.index]));
        }
        downloadCsv('data-quality-' + csvStamp + '.csv',
            ['date', 'records', 'complete'],
            Object.keys(dqDays).sort().map(date => [date, dqDays[date]?.records || 0, dqDays[date]?.complete ? 1 : 0]));
    };

    return h('div', { className: 'rep' },
        h('div', { className: 'rep-actions' },
            h('button', { type: 'button', className: 'rep-btn', onClick: printPage }, 'Print / save as PDF'),
            h('button', { type: 'button', className: 'rep-btn', onClick: exportAll }, 'Download the CSVs'),
            h('span', { className: 'rep-hint' }, 'Print hides the navigation, the filter bar and these buttons.')),

        h('header', { className: 'rep-head' },
            h('h1', { className: 'rep-title' }, 'Month-end report'),
            h('div', { className: 'rep-meta' },
                h('span', null, periodLabel),
                scopeBits.length ? h('span', null, ' · ' + scopeBits.join(' · ')) : null,
                h('span', null, ' · generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
                h('span', null, ' · ' + (user?.displayName || user?.username || '')))),

        h('div', { className: 'rep-kpi-wrap' }, kpiRow),

        repSection('Against the baseline period',
            report.comparison?.label
                ? 'Baseline: ' + report.comparison.label + ' (' + (prev.start || '') + ' – ' + (prev.end || '') + '). Change is against a baseline, not a forecast.'
                : 'The comparison period has not loaded.',
            repTable([{ label: 'Measure' }, { label: 'This period', num: true }, { label: 'Baseline', num: true }, { label: 'Change', num: true }], compareRows)),

        repSection('By queue',
            'SLA is measured against each queue\'s own target when one is configured, and the domain default otherwise; the bracketed figure is the base (answered calls the percentage was taken over). Abandon % is over the calls offered to that queue. Hold is averaged only over calls that actually held.',
            repTable([
                { label: 'Queue' }, { label: 'Target', num: true }, { label: 'Offered', num: true },
                { label: 'Answered', num: true }, { label: 'Missed', num: true }, { label: 'Abandoned', num: true },
                { label: 'SLA (base)', num: true }, { label: 'Abandon %', num: true },
                { label: 'Ring / talk', num: true }, { label: 'Hold avg (total)', num: true }
            ], queueRows)),

        repSection('By number',
            'Volume is every call type on the line, as on the Telephone Numbers screen. The missed share is over the calls that arrived (inbound + missed) — an outbound leg the desk placed is not a chance to miss anybody. Abandon % is over that line\'s missed calls. Flags: zero traffic = live and never called in this period; high abandon = at least ' + 5 + ' missed calls and 20 % or more of them abandoned.',
            repTable([
                { label: 'Number' }, { label: 'Calls', num: true }, { label: 'Inbound', num: true },
                { label: 'Missed', num: true }, { label: 'Abandoned', num: true },
                { label: 'Missed % (base)', num: true }, { label: 'Abandon % (base)', num: true },
                { label: 'Flag' }
            ], numberRows)),

        repSection('Sentiment',
            'Averages are over the calls that were scored (the base is printed), and only calls that connected can be scored — an abandoned call is never in these numbers.',
            h('div', { className: 'rep-inline' },
                h('span', null, 'Positive ' + one(sentiment.positive) + ' %'),
                h('span', null, 'Neutral ' + one(sentiment.neutral) + ' %'),
                h('span', null, 'Negative ' + one(sentiment.negative) + ' %'),
                h('span', null, 'Score ' + one(sentiment.score)),
                h('span', null, 'Base: ' + fmtNum(sentiment.scored) + ' scored calls, ' + fmtNum(sentiment.negativeCalls) + ' negative-led'))),

        baseline
            ? repSection('Daily volume vs the same weekday in the prior weeks',
                'Baseline: ' + baseline.label + ' (' + (baseline.windowFrom || '') + ' – ' + (baseline.windowTo || '') + '; days with data: ' + (baseline.from || 'none') + ' – ' + (baseline.to || 'none') + '). Index = the day\'s arrivals ÷ its weekday baseline. A day with no prior-week data says so rather than showing 0 %.',
                h('div', null,
                    repTable([{ label: 'Day' }, { label: 'Arrivals', num: true }, { label: 'Weekday baseline', num: true }, { label: 'Index', num: true }], dayRows),
                    h('div', { className: 'rep-inline rep-inline-wrap' },
                        ...(baseline.byWeekday || []).map(w =>
                            h('span', { key: String(w.weekday) }, w.label + ' ' + one(w.avg) + ' (' + w.weeks + ' wk)')))))
            : null,

        repSection('Staffing estimate',
            'Baseline, not a forecast: offered calls × the AHT actually observed ÷ the interval ÷ ' + one(staffing.occupancyPct) + ' % occupancy. ' + (staffing.basis || '') + ' ' + (staffing.label || ''),
            h('div', null,
                repTable([{ label: 'Hour' }, { label: 'Offered', num: true }, { label: 'AHT', num: true }, { label: 'Work seconds', num: true }, { label: 'Agents at ' + one(staffing.occupancyPct) + ' %', num: true }], staffRows),
                h('div', { className: 'rep-inline' },
                    h('span', null, 'Total work ' + fmtNum(staffing.totalWorkHours) + ' h'),
                    h('span', null, 'Agent-hours ' + fmtNum(staffing.totalAgentHours) + ' h'),
                    h('span', null, 'Formula: ' + (staffing.formula || ''))))),

        repSection('Data quality',
            'Before quoting the month: the four ways a CDR set lies, each with the base it was counted over. A partial day is one whose fetch stopped before the end of the day file, so its calls are missing rather than zero.',
            h('div', null,
                repTable([{ label: 'Check' }, { label: 'Count', num: true }, { label: 'Base', num: true }, { label: '%', num: true }], qualRows),
                h('div', { className: 'rep-inline' },
                    h('span', null, 'Days fetched ' + fmtNum(Object.keys(dqDays).length)),
                    h('span', null, 'Partial ' + fmtNum(dq.incompleteDays || 0)),
                    h('span', null, 'Empty ' + fmtNum(dq.emptyDays || 0)),
                    h('span', null, 'Calls audited ' + fmtNum(quality.calls))),
                dqRows.length
                    ? h('div', { className: 'rep-days' }, repTable([{ label: 'Day' }, { label: 'Records', num: true }, { label: 'Fetch' }], dqRows))
                    : null)),

        repSection('Weekday × hour', 'Calls started in each weekday/hour across the period (inbound + missed). Cells are not clickable — the call list filters an hour but not a weekday.', null),
        h(WeekHourHeatmap, { heatmap: S.heatmap, loading: false }),

        h('footer', { className: 'rep-foot' },
            h('div', null, 'Definitions: offered = answered inbound + missed. Missed = a call that never reached a person, split into abandoned (reached a queue or the auto-attendant and hung up), voicemail and rang-out. AHT is talking time on answered inbound calls only; outbound and on-net talk is excluded. On-net legs are internal extensions. Every rate on this page prints its base.'),
            h('div', null, 'Source: PBX CDRs for the selected period, cached per day. Scope: ' + (scopeBits.join(' · ') || 'all calls') + '. Timezone US/Eastern.')));
}

export { ReportsDashboard, downloadCsv };
