import { api } from '../lib/api.js';
import { intelligenceMonthRange } from '../lib/intelligence-month.js';
import { recordRangeLabel } from '../lib/pagination.js';
import { date, formatCallDate, formatCallTime, parseCallInstant } from '../lib/time.js';
import { h, useEffect, useState } from '../lib/react.js';

const LOOKUP_CONCURRENCY = 4;

function IntelligenceDashboard({ filters }) {
    const reportToday = date(new Date());
    const [watches, setWatches] = useState('');
    const [selectedMonth, setSelectedMonth] = useState(() => reportToday.slice(0, 7));
    const [overrideMonth, setOverrideMonth] = useState('');
    const [appliedOverride, setAppliedOverride] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [rows, setRows] = useState([]);
    const [missing, setMissing] = useState(0);
    const [missingReasons, setMissingReasons] = useState({});
    const [cacheIncomplete, setCacheIncomplete] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [topic, setTopic] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(30);
    const [selected, setSelected] = useState([]);
    const [recipients, setRecipients] = useState('');
    const [busy, setBusy] = useState(false);
    const scopeKey = JSON.stringify({ department: filters.department || '', site: filters.site || '', agents: filters.agents || [], hours: filters.hours || 'all' });
    const monthRange = intelligenceMonthRange(selectedMonth, reportToday);

    useEffect(() => {
        let active = true;
        api('intelligence', { action: 'watches' }).then(r => { if (active) setWatches(r.watches.join('\n')); }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let active = true;
        setRows([]); setSelected([]); setTopic(''); setPage(1); setMissing(0); setMissingReasons({}); setCacheIncomplete(false); setError('');
        if (!monthRange) { setProgress(''); setError('Choose a valid month that is not in the future.'); return () => { active = false; }; }
        setProgress('Preparing call history…');
        (async () => {
            try {
                /* Warm the selected month in bounded batches instead of asking a
                 * single report request to fetch an entire cold month at once. */
                let status;
                try {
                    status = await api('cache_job', { ...monthRange, action: 'status' });
                    let attempts = 0, partialAttempts = 0;
                    while (active && status && !status.complete && attempts++ < 16) {
                        setProgress('Preparing call history: ' + (status.ready || 0) + ' of ' + (status.total || 0) + ' days ready…');
                        const warmed = await api('cache_job', { ...monthRange, action: 'warm', batch: 5 });
                        status = warmed;
                        // A partial day can resume from its stored offset, but don't
                        // keep hammering an unreachable PBX indefinitely.
                        partialAttempts = warmed?.batch?.stopped === 'partial' ? partialAttempts + 1 : 0;
                        if (partialAttempts >= 3) break;
                    }
                } catch (e) {
                    if (!active) return;
                    setError('Could not fully prepare call history: ' + e.message);
                    status = { complete: false };
                }
                if (!active) return;
                if (status && !status.complete) setCacheIncomplete(true);
                setProgress('Loading calls…');
                const scope = JSON.parse(scopeKey);
                const list = await api('intelligence', { ...scope, ...monthRange, action: 'list', month: appliedOverride });
                if (!active) return;
                setMissing(list.missing);
                setMissingReasons(list.missingReasons || {});
                setCacheIncomplete(!list.cacheStatus?.complete || !!(status && !status.complete));
                const items = list.calls.map(c => ({ ...c, topics: c.topicsHint || [], matches: c.matchesHint || [], status: c.reference ? 'waiting' : (c.status || 'unavailable') })).sort((a, b) => {
                    const at = parseCallInstant(a.startedAt)?.getTime() || 0;
                    const bt = parseCallInstant(b.startedAt)?.getTime() || 0;
                    return bt - at || String(a.reference || a.rowKey).localeCompare(String(b.reference || b.rowKey));
                });
                setRows(items.slice());
                const candidates = items.map((item, i) => item.reference ? i : -1).filter(i => i >= 0);
                let cursor = 0, completed = 0;
                const worker = async () => {
                    while (active && cursor < candidates.length) {
                        const i = candidates[cursor++];
                        try {
                            const result = await api('intelligence', { action: 'lookup', reference: items[i].reference });
                            if (result.status === 'partial' && !(result.topics || []).length && items[i].topicsHint?.length) {
                                result.topics = items[i].topicsHint;
                                const existing = result.matches || [];
                                result.matches = [...existing, ...(items[i].matchesHint || []).filter(m => !existing.some(x => x.keyword === m.keyword))];
                            }
                            items[i] = { ...items[i], ...result };
                        } catch (e) { items[i] = { ...items[i], status: 'error', detail: e.message }; }
                        completed++;
                        if (active && (completed === 1 || completed % 10 === 0 || completed === candidates.length)) {
                            setRows(items.slice());
                            setProgress('Checked ' + completed + ' of ' + candidates.length + ' transcription jobs…');
                        }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, candidates.length) }, worker));
                if (active) { setRows(items.slice()); setProgress(''); }
            } catch (e) { if (active) { setError(e.message); setProgress(''); } }
        })();
        return () => { active = false; };
    }, [scopeKey, selectedMonth, reportToday, appliedOverride, refresh]);

    const saveWatches = async () => {
        setBusy(true); setError(''); setMessage('');
        try {
            const r = await api('intelligence', { action: 'save_watches', watches: watches.split(/\r?\n/) });
            setWatches(r.watches.join('\n')); setMessage('Watched phrases saved. Rechecking calls.'); setRefresh(x => x + 1);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const send = async () => {
        setBusy(true); setError(''); setMessage('');
        try {
            await api('intelligence', { action: 'send', references: selected, recipients: recipients.split(/[,;\s]+/).filter(Boolean) });
            setMessage('Email accepted by the SMTP server.'); setSelected([]);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const counts = new Map();
    rows.forEach(row => (row.topics || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    const topics = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    /* CDR topics remain visible when a transcription is pending or unavailable. */
    const visible = rows.filter(r => (r.topics || []).length > 0 && (!topic || r.topics.includes(topic)));
    const failures = rows.filter(r => ['error', 'pending', 'partial', 'unavailable'].includes(r.status)).length;
    const jobs = rows.filter(r => r.reference).length;
    const noTopics = rows.filter(r => r.status === 'finished' && !(r.topics || []).length).length;
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * pageSize;
    const pageRows = visible.slice(startIndex, startIndex + pageSize);
    const changeTopic = value => { setTopic(value); setPage(1); };
    const paginationButton = (label, target, disabled) => h('button', { type: 'button', className: 'rep-btn', disabled, onClick: () => setPage(target), key: label }, label);

    return h('div', { className: 'rep intelligence-report' },
        h('div', { className: 'intel-head' },
            h('div', null, h('h1', { className: 'rep-title' }, 'Topics & summaries'),
                h('p', { className: 'rep-note' }, 'Office managers only · Calls with topics, newest first · Department, site, agent and hours filters apply.')),
            h('div', { className: 'intel-month' }, h('label', null, 'Report month ',
                h('input', { type: 'month', value: selectedMonth, max: reportToday.slice(0, 7), onChange: e => setSelectedMonth(e.target.value), className: 'intelligence-input', 'aria-label': 'Report month' })),
                h('button', { type: 'button', className: 'rep-btn', disabled: !!progress, onClick: () => setRefresh(x => x + 1) }, 'Reload'))),
        h('p', { className: 'rep-note' }, monthRange ? 'Report period: ' + monthRange.start + ' – ' + monthRange.end + (selectedMonth === reportToday.slice(0, 7) ? ' (month to date)' : '') + '. Hours: ' + (filters.hours || 'all') + '.' : 'Choose a report month.'),
        h('section', { className: 'rep-sec intel-settings' },
            h('h2', { className: 'rep-sec-title' }, 'Keyword watch'),
            h('p', { className: 'rep-note' }, 'One phrase per line. Case-insensitive substring search across transcript, summary and topics. Matching calls are highlighted red.'),
            h('textarea', { value: watches, onChange: e => setWatches(e.target.value), rows: 3, 'aria-label': 'Watched phrases', className: 'intelligence-input intel-watch-input' }),
            h('div', { className: 'intel-actions' },
                h('button', { type: 'button', className: 'rep-btn', disabled: busy, onClick: saveWatches }, 'Save watched phrases'),
                h('details', null, h('summary', null, 'PBX lookup month override'),
                    h('p', { className: 'rep-note' }, 'Optional YYYYMM used for every lookup; leave blank to use the PBX link or server configuration. This does not change the report month.'),
                    h('label', null, 'Override ', h('input', { value: overrideMonth, onChange: e => setOverrideMonth(e.target.value), placeholder: 'YYYYMM', maxLength: 6, className: 'intelligence-input' })), ' ',
                    h('button', { type: 'button', className: 'rep-btn', onClick: () => { setAppliedOverride(overrideMonth.trim()); setRefresh(x => x + 1); } }, 'Apply override')))),
        h('section', { className: 'intel-status', 'aria-live': 'polite' },
            h('p', { className: 'rep-note' }, progress || ('Checked ' + jobs + ' jobs; ' + failures + ' unavailable or incomplete; ' + noTopics + ' finished without topics; ' + missing + ' CDR rows without a usable lookup.')),
            progress ? h('p', { className: 'rep-note' }, 'Results and topic counts update as jobs are checked.') : null,
            missing > 0 && Object.keys(missingReasons).length ? h('p', { className: 'rep-note' }, 'Missing: job ID ' + (missingReasons.jobId || 0) + ', PBX server ' + (missingReasons.server || 0) + ', call ID ' + (missingReasons.callId || 0) + ', lookup month ' + (missingReasons.month || 0) + '. Older CDR caches may need refreshing.') : null,
            cacheIncomplete ? h('p', { role: 'alert', className: 'rep-error' }, 'The CDR month is not fully loaded; this report is incomplete.') : null,
            error ? h('p', { role: 'alert', className: 'rep-error' }, error) : null,
            message ? h('p', { role: 'status' }, message) : null),
        h('section', { className: 'rep-sec' },
            h('h2', { className: 'rep-sec-title' }, 'Topics'),
            h('p', { className: 'rep-note' }, 'Counts include CDR topics and are provisional while jobs are being checked. Select a topic to filter the calls below.'),
            h('div', { className: 'intel-topics' },
                h('button', { type: 'button', className: 'rep-btn', 'aria-pressed': topic === '', onClick: () => changeTopic('') }, 'All topics'),
                ...topics.map(([name, count]) => h('button', { key: name, type: 'button', className: 'rep-btn', 'aria-pressed': topic === name, onClick: () => changeTopic(name) }, name + ' (' + count + ')')))),
        h('section', { className: 'rep-sec' },
            h('div', { className: 'intel-table-heading' }, h('div', null,
                h('h2', { className: 'rep-sec-title' }, topic ? 'Calls: ' + topic : 'Calls with topics'),
                h('p', { className: 'rep-note' }, 'Select up to 10 matching calls across pages. Email excerpts may contain sensitive information.')),
                h('label', { className: 'intel-page-size' }, 'Rows per page ', h('select', { value: pageSize, className: 'intelligence-input', 'aria-label': 'Rows per page', onChange: e => { setPageSize(Number(e.target.value)); setPage(1); } }, ...[30, 50, 100].map(n => h('option', { key: n, value: n }, n))))),
            h('div', { className: 'intel-email' },
                h('label', null, 'Recipients ', h('input', { value: recipients, onChange: e => setRecipients(e.target.value), placeholder: 'name@example.com', className: 'intelligence-input' })),
                h('button', { type: 'button', className: 'rep-btn', disabled: busy || !selected.length || !!progress, onClick: send }, 'Email selected (' + selected.length + ')')),
            h('div', { className: 'intel-table-wrap' },
                h('table', { className: 'intel-table' },
                    h('thead', null, h('tr', null, ...['Select', 'When / PBX reference', 'Topics', 'Summary', 'Watch matches'].map(x => h('th', { key: x, scope: 'col' }, x)))),
                    h('tbody', null, ...pageRows.map(row => h('tr', { key: row.reference || row.rowKey, className: row.matches?.length ? 'is-matched' : '' },
                        h('td', null, row.status === 'finished' && row.matches?.length ? h('input', { type: 'checkbox', 'aria-label': 'Select call ' + row.callId, checked: selected.includes(row.reference), disabled: !selected.includes(row.reference) && selected.length >= 10, onChange: e => setSelected(s => e.target.checked ? [...s, row.reference] : s.filter(x => x !== row.reference)) }) : null),
                        h('td', null, h('strong', null, formatCallDate(row.startedAt) || row.startedAt), h('div', { className: 'intel-muted' }, formatCallTime(row.startedAt)), h('div', { className: 'intel-reference' }, (row.callIdField ? row.callIdField + ': ' : '') + row.callId)),
                        h('td', null, h('div', { className: 'intel-topic-list' }, ...(row.topics || []).map(t => h('span', { key: t, className: 'intel-topic' }, t)))),
                        h('td', { className: 'intel-summary' }, row.summary || 'Summary unavailable'),
                        h('td', null, row.matches?.length ? h('span', { className: 'intel-match-label' }, 'Matched: ' + row.matches.map(m => m.keyword).join(', ')) : (row.status === 'finished' ? 'No match' : 'Not fully checked'),
                            row.status !== 'finished' ? h('div', { className: 'intel-muted' }, 'Incomplete check · ' + row.status + (row.detail ? ': ' + row.detail : '')) : null,
                            row.matches?.length ? h('details', null, h('summary', null, 'Matching excerpts'), ...row.matches.map(m => h('p', { key: m.keyword }, m.keyword + ' (' + m.source + '): ' + m.excerpt))) : null)))))),
            !pageRows.length ? h('p', { className: 'intel-empty' }, progress ? 'Checking calls for topics…' : (topic ? 'No calls with this topic.' : 'No calls with topics in this month.')) : null,
            h('div', { className: 'intel-pagination', 'aria-label': 'Call table pagination' },
                h('span', null, recordRangeLabel(visible.length, startIndex, Math.min(startIndex + pageSize, visible.length))),
                h('div', { className: 'intel-page-buttons' },
                    paginationButton('First', 1, currentPage === 1), paginationButton('Previous', currentPage - 1, currentPage === 1),
                    h('span', null, 'Page ' + currentPage + ' of ' + totalPages),
                    paginationButton('Next', currentPage + 1, currentPage === totalPages), paginationButton('Last', totalPages, currentPage === totalPages)))));
}
export { IntelligenceDashboard };
