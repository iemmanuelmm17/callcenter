import { api } from '../lib/api.js';
import { IntelligenceOverlay } from './intelligence-overlay.js';
import { downloadIntelligenceWorkbook } from '../lib/intelligence-export.js';
import { intelligenceMonthRange } from '../lib/intelligence-month.js';
import { parseWatchedPhrases, formatWatchedPhrases } from '../lib/intelligence-watch.js';
import { recordRangeLabel } from '../lib/pagination.js';
import { APP_TZ, date, formatCallDate, formatCallTime, parseCallInstant } from '../lib/time.js';
import { h, useEffect, useState } from '../lib/react.js';

const DEFAULT_LOOKUP_CONCURRENCY = 8;
const PROGRESS_UPDATE_MS = 500;

/* Render watched phrases as text nodes and marks, never as HTML. */
function markedSummary(text, phrases) {
    if (!text) return 'Summary unavailable';
    const patterns = phrases.filter(Boolean).slice().sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!patterns.length) return text;
    const expression = new RegExp(patterns.join('|'), 'giu');
    const parts = []; let from = 0;
    for (const match of text.matchAll(expression)) {
        if (match.index > from) parts.push(text.slice(from, match.index));
        parts.push(h('mark', { key: match.index, className: 'intel-mark' }, match[0]));
        from = match.index + match[0].length;
    }
    parts.push(text.slice(from));
    return parts;
}

function ReviewDetails({ reviews, busy, onAcknowledge }) {
    if (!reviews.length) return h('span', { className: 'intel-muted' }, 'No review recorded');
    return h('div', { className: 'intel-review-items' }, ...reviews.map(item => h('div', { key: item.id, className: 'intel-review-item' },
        h('strong', null, 'Needs review'), h('p', null, item.reason),
        h('button', { type: 'button', className: 'intel-text-btn', disabled: busy, onClick: () => onAcknowledge(item.id), 'aria-label': 'Mark review ' + (item.callid || item.id) + ' reviewed' }, 'Mark reviewed'))));
}

function IntelligenceRow({ row, checked, busy, onSelect, topic, onTopic, onCopy, watches, reviews, onAcknowledge }) {
    const [expanded, setExpanded] = useState(false);
    const rowTopics = row.topics || [];
    const badge = t => h('button', { key: t, type: 'button', className: 'intel-topic', 'aria-pressed': topic === t, onClick: () => onTopic(topic === t ? '' : t) }, t);
    return h('tr', { className: row.matches?.length ? 'is-matched' : '' },
        h('td', null, h('input', { type: 'checkbox', 'aria-label': 'Select call ' + row.callId, checked, disabled: busy || !row.emailReference, title: row.emailReference ? '' : 'This limited review record has no email snapshot.', onChange: e => onSelect(row, e.target.checked) })),
        h('td', null, h('strong', { className: 'intel-date' }, formatCallDate(row.startedAt) || (row.reviewOnly ? 'Unknown call date' : 'Unknown')),
            h('div', { className: 'intel-muted' }, formatCallTime(row.startedAt) || 'Unknown'),
            h('button', { type: 'button', className: 'intel-ref-pill', title: (row.callIdField ? row.callIdField + ': ' : '') + row.callId,
                'aria-label': 'Copy PBX reference ' + row.callId, onClick: () => onCopy(row.callId) },
                '#' + String(row.callId || '').slice(-8), ' ', h('i', { className: 'fa-regular fa-copy', 'aria-hidden': 'true' }))),
        h('td', { className: 'intel-party' }, row.callerNumber || 'Unknown'),
        h('td', { className: 'intel-party' }, row.dialedNumber || 'Unknown'),
        h('td', { className: 'intel-party' }, row.destinationNumber || 'Unknown'),
        h('td', null, h('div', { className: 'intel-topic-list' }, !rowTopics.length ? h('span', { className: 'intel-muted' }, 'No topics available') : null, ...rowTopics.slice(0, 5).map(badge),
            rowTopics.length > 5 ? h('details', { className: 'intel-more-topics' }, h('summary', null, '+' + (rowTopics.length - 5) + ' more'),
                h('div', { className: 'intel-topic-list' }, ...rowTopics.slice(5).map(badge))) : null)),
        h('td', { className: 'intel-summary' },
            h('div', { className: expanded ? 'intel-summary-text' : 'intel-summary-text is-clamped' }, markedSummary(row.summary, watches)),
            row.summary && row.summary.length > 80 ? h('button', { type: 'button', className: 'intel-text-btn', 'aria-expanded': expanded, onClick: () => setExpanded(x => !x) }, expanded ? 'Show less' : 'Show full summary') : null),
        h('td', null, row.matches?.length ? h('div', { className: 'intel-match-pills' }, ...row.matches.map(m => h('span', { key: m.keyword, className: 'intel-match-label' }, 'Matched: ' + m.keyword))) : h('span', { className: 'intel-muted' }, row.status === 'finished' ? 'No match' : 'Not fully checked'),
            row.status !== 'finished' ? h('div', { className: 'intel-muted' }, 'Incomplete check · ' + row.status + (row.detail ? ': ' + row.detail : '')) : null,
            row.matches?.length ? h('details', { className: 'intel-excerpts' }, h('summary', null, 'Matching excerpts'), ...row.matches.map(m => h('p', { key: m.keyword }, m.keyword + ' (' + m.source + '): ' + m.excerpt))) : null),
        h('td', { className: 'intel-party' }, row.emailStatus ? h('div', null, h('strong', null, 'SMTP accepted (' + row.emailStatus.kind + ')'), h('div', null, new Intl.DateTimeFormat(undefined, { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.emailStatus.time * 1000))), h('div', null, (row.emailStatus.recipients || []).join(', '))) : h('span', { className: 'intel-muted' }, 'No email recorded')),
        h('td', { className: 'intel-review-cell' }, h(ReviewDetails, { reviews, busy, onAcknowledge })));
}

function IntelligenceDashboard({ filters }) {
    const reportToday = date(new Date());
    const [watches, setWatches] = useState('');
    const [savedWatches, setSavedWatches] = useState([]);
    const [matchFilter, setMatchFilter] = useState('all');
    const [keywordFilter, setKeywordFilter] = useState('');
    const [reviewFilter, setReviewFilter] = useState('all');
    const [unscopedReviews, setUnscopedReviews] = useState(0);
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
    const [topicSearch, setTopicSearch] = useState('');
    const [showAllTopics, setShowAllTopics] = useState(false);
    const [watchOpen, setWatchOpen] = useState(false);
    const [monitor, setMonitor] = useState(null);
    const [acknowledged, setAcknowledged] = useState([]);
    const [alertRecipients, setAlertRecipients] = useState('');
    const [syncOpen, setSyncOpen] = useState(false);
    const [sync, setSync] = useState({ stage: 'loading', done: 0, total: 0 });
    const [topicSort, setTopicSort] = useState('count');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(30);
    const [selected, setSelected] = useState([]);
    const [recipients, setRecipients] = useState('');
    const [busy, setBusy] = useState(false);
    const [emailProgress, setEmailProgress] = useState('');
    const scopeKey = JSON.stringify({ department: filters.department || '', site: filters.site || '', agents: filters.agents || [], hours: filters.hours || 'all' });
    const monthRange = intelligenceMonthRange(selectedMonth, reportToday);

    useEffect(() => {
        let active = true;
        api('intelligence', { action: 'monitor_status' }).then(r => { if (active) { setMonitor(r); setAlertRecipients((r.recipients || []).join('; ')); } }).catch(() => { if (active) setMonitor({ unavailable: true }); });
        api('intelligence', { action: 'watches' }).then(r => { if (active) { setWatches(formatWatchedPhrases(r.watches)); setSavedWatches(r.watches); } }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let active = true;
        setRows([]); setSelected([]); setTopic(''); setPage(1); setMissing(0); setMissingReasons({}); setUnscopedReviews(0); setCacheIncomplete(false); setError(''); setSync({ stage: 'loading', done: 0, total: 0 });
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
                        setSync({ stage: 'cache', done: status.ready || 0, total: status.total || 0 });
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
                setUnscopedReviews(list.unscopedReviews || 0);
                setMissingReasons(list.missingReasons || {});
                setCacheIncomplete(!list.cacheStatus?.complete || !!(status && !status.complete));
                const items = list.calls.map(c => ({ ...c, topics: c.topicsHint || [], matches: c.matchesHint || [], status: c.reference ? 'waiting' : (c.status || 'unavailable') })).sort((a, b) => {
                    const at = parseCallInstant(a.startedAt)?.getTime() || 0;
                    const bt = parseCallInstant(b.startedAt)?.getTime() || 0;
                    return bt - at || String(a.reference || a.rowKey).localeCompare(String(b.reference || b.rowKey));
                });
                setRows(items.slice());
                // Lookups may finish while a selected-call email is being sent.
                // Preserve its newer status when publishing lookup progress.
                const publish = () => setRows(current => {
                    const statuses = new Map(current.map(row => [row.reference || row.rowKey, row.emailStatus]));
                    return items.map(row => ({ ...row, emailStatus: statuses.get(row.reference || row.rowKey) || row.emailStatus }));
                });
                const candidates = items.map((item, i) => item.reference ? i : -1).filter(i => i >= 0);
                let cursor = 0, completed = 0, lastUpdate = 0;
                setSync({ stage: 'jobs', done: 0, total: candidates.length });
                setProgress('Checked 0 of ' + candidates.length + ' transcription jobs…');
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
                        const now = Date.now();
                        if (active && (completed === 1 || now - lastUpdate >= PROGRESS_UPDATE_MS || completed === candidates.length)) {
                            lastUpdate = now;
                            publish();
                            setSync({ stage: 'jobs', done: completed, total: candidates.length });
                            setProgress('Checked ' + completed + ' of ' + candidates.length + ' transcription jobs…');
                        }
                    }
                };
                const configuredWorkers = Number(list.intelligenceWorkers);
                const concurrency = Number.isInteger(configuredWorkers) && configuredWorkers >= 1 && configuredWorkers <= 32 ? configuredWorkers : DEFAULT_LOOKUP_CONCURRENCY;
                await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
                if (active) { publish(); setSync({ stage: 'complete', done: completed, total: candidates.length }); setProgress(''); }
            } catch (e) { if (active) { setError(e.message); setSync({ stage: 'error', done: 0, total: 0 }); setProgress(''); } }
        })();
        return () => { active = false; };
    }, [scopeKey, selectedMonth, reportToday, appliedOverride, refresh]);

    const saveWatches = async () => {
        setBusy(true); setError(''); setMessage(''); setMessage('');
        try {
            const r = await api('intelligence', { action: 'save_watches', watches: parseWatchedPhrases(watches) });
            setWatches(formatWatchedPhrases(r.watches)); setSavedWatches(r.watches); setKeywordFilter(''); setMessage('Watched phrases saved. Rechecking calls.'); setRefresh(x => x + 1);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const saveAlertRecipients = async () => {
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await api('intelligence', { action: 'monitor_recipients', recipients: alertRecipients });
            setMonitor(result); setAlertRecipients((result.recipients || []).join('; '));
            setMessage(result.recipients?.length ? 'Alert recipients saved for this domain.' : 'Alert recipients cleared; automatic alerts are paused.');
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const toggleMonitor = async () => {
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await api('intelligence', { action: 'monitor_enable', enabled: !monitor.enabled });
            setMonitor(result);
            setMessage(result.enabled ? 'Automatic alerts enabled for new completed calls.' : 'Automatic alerts disabled.');
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const refreshMonitorStatus = async () => {
        try { const result = await api('intelligence', { action: 'monitor_status' }); setMonitor(result); }
        catch (e) { setError('Unable to refresh automatic alert reviews: ' + e.message); }
    };
    const acknowledgeReview = async id => {
        setBusy(true); setError('');
        try {
            const result = await api('intelligence', { action: 'monitor_reviewed', id });
            setAcknowledged(previous => [...previous, id]);
            setMonitor(previous => ({ ...previous, reviews: result.reviews }));
            setMessage('Review marked reviewed. No email was sent or retried.');
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const send = async () => {
        const recipientsList = recipients.split(/[,;\s]+/).filter(Boolean);
        if (!recipientsList.length) { setError('Enter at least one recipient email address.'); return; }
        const selectedSet = new Set(selected);
        const toSend = rows.filter(row => selectedSet.has(row.reference || row.rowKey));
        if (toSend.length !== selected.length || toSend.some(row => !row.emailReference)) {
            setError('A selected call is no longer available for email. Reload the report and select it again.'); return;
        }
        const totalBatches = Math.ceil(toSend.length / 10);
        let sent = 0;
        setBusy(true); setError(''); setMessage('');
        try {
            for (let i = 0; i < toSend.length; i += 10) {
                const batch = toSend.slice(i, i + 10);
                setEmailProgress('Sending email ' + (Math.floor(i / 10) + 1) + ' of ' + totalBatches + '…');
                const response = await api('intelligence', { action: 'send', references: batch.map(row => row.emailReference), recipients: recipientsList });
                sent += batch.length;
                const sentKeys = new Set(batch.map(row => row.reference || row.rowKey));
                if (response.emailStatus) setRows(current => current.map(row => sentKeys.has(row.reference || row.rowKey) ? { ...row, emailStatus: response.emailStatus } : row));
                setSelected(current => current.filter(key => !sentKeys.has(key)));
            }
            setMessage('SMTP accepted ' + totalBatches + ' email' + (totalBatches === 1 ? '' : 's') + ' for ' + sent + ' calls.');
        } catch (e) {
            setError('Email stopped after ' + sent + ' of ' + toSend.length + ' calls were accepted. The failed batch may have been delivered; verify before retrying. ' + e.message);
        } finally { setEmailProgress(''); setBusy(false); }
    };
    const counts = new Map();
    rows.forEach(row => (row.topics || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    const topics = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const query = topicSearch.trim().toLocaleLowerCase();
    const filteredTopics = query ? topics.filter(([name]) => name.toLocaleLowerCase().includes(query)) : topics;
    // The collapsed, unsearched view is always the most common ten topics.
    const displayedTopics = query ? filteredTopics : topics.slice(0, 10);
    const browserTopics = filteredTopics.slice();
    if (topicSort === 'alphabetical') browserTopics.sort((a, b) => a[0].localeCompare(b[0]));
    const acknowledgedSet = new Set(acknowledged);
    const activeReviews = row => (row.reviews || []).filter(item => !acknowledgedSet.has(item.id));
    /* Topic-less calls appear only when filtering for outstanding reviews. */
    const visible = rows.filter(r => {
        const hasReview = activeReviews(r).length > 0;
        if (reviewFilter === 'review' && !hasReview) return false;
        if (!(r.topics || []).length && !(reviewFilter === 'review' && hasReview)) return false;
        if (topic && !(r.topics || []).includes(topic)) return false;
        if (matchFilter === 'matched' && !(r.matches || []).length) return false;
        if (matchFilter === 'unmatched' && (r.status !== 'finished' || (r.matches || []).length)) return false;
        if (matchFilter === 'incomplete' && r.status === 'finished') return false;
        return !keywordFilter || (r.matches || []).some(m => m.keyword === keywordFilter);
    });
    const failures = rows.filter(r => !r.reviewOnly && ['error', 'pending', 'partial', 'unavailable'].includes(r.status)).length;
    const jobs = rows.filter(r => r.reference).length;
    const noTopics = rows.filter(r => r.status === 'finished' && !(r.topics || []).length).length;
    const partialExport = !!progress || cacheIncomplete || sync.stage === 'error' || failures > 0 || missing > 0 || visible.some(row => row.reviewOnly) || (reviewFilter === 'review' && unscopedReviews > 0);
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * pageSize;
    const pageRows = visible.slice(startIndex, startIndex + pageSize);
    const changeTopic = value => { setTopic(value); setPage(1); };
    const visibleKeys = visible.filter(row => row.emailReference).map(row => row.reference || row.rowKey);
    const selectedKeys = new Set(selected);
    const visibleSelected = visibleKeys.filter(key => selectedKeys.has(key)).length;
    const selectAllFiltered = () => setSelected(current => [...new Set([...current, ...visibleKeys])]);
    const unselectFiltered = () => { const keys = new Set(visibleKeys); setSelected(current => current.filter(key => !keys.has(key))); };
    const paginationButton = (label, target, disabled) => h('button', { type: 'button', className: 'rep-btn', disabled, onClick: () => setPage(target), key: label }, label);
    const exportCalls = () => {
        try {
            setError('');
            downloadIntelligenceWorkbook(visible.map(row => ({ ...row, reviews: activeReviews(row) })), [
                ['Report month', selectedMonth], ['Period', monthRange.start + ' – ' + monthRange.end], ['Timezone', APP_TZ],
                ['Department', filters.department || 'All'], ['Site', filters.site || 'All'], ['Agents', (filters.agents || []).join(', ') || 'All'],
                ['Hours', filters.hours || 'all'], ['Topic', topic || 'All'], ['Match filter', matchFilter], ['Review filter', reviewFilter], ['Watched keyword', keywordFilter || 'All'],
                ['Exported calls', String(visible.length)], ['CDR cache', cacheIncomplete ? 'Incomplete' : 'Complete'],
                ['Transcription checking', progress ? 'In progress: ' + progress : (sync.stage === 'complete' ? 'Complete' : 'Unavailable')],
                ['Export coverage', partialExport ? 'Partial / incomplete' : 'Available checked results'],
                ['Unavailable or incomplete checks', String(failures)], ['CDR rows without usable lookup', String(missing)],
                ['Generated (UTC)', new Date().toISOString()],
                ['Privacy', 'Contains summaries and matching excerpts. Handle as sensitive information.']
            ], selectedMonth, partialExport);
            if (progress) setMessage('Partial Excel export downloaded. Checking is still in progress; results may be incomplete.');
        } catch (e) { setError('Excel export failed: ' + e.message); }
    };

    const resetFilters = () => { setTopic(''); setMatchFilter('all'); setReviewFilter('all'); setKeywordFilter(''); setPage(1); };
    const toggleRow = (row, checked) => {
        const key = row.reference || row.rowKey;
        setSelected(current => checked ? [...new Set([...current, key])] : current.filter(x => x !== key));
    };
    const copyReference = async value => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable in this browser.');
            await navigator.clipboard.writeText(String(value || ''));
            setMessage('PBX reference copied.');
        } catch (e) { setError('Could not copy automatically. PBX reference: ' + String(value || '')); }
    };
    const topicButton = ([name, count], closeBrowser = false) => h('button', { key: name, type: 'button', className: 'intel-quick-pill', 'aria-pressed': topic === name,
        onClick: () => { changeTopic(topic === name ? '' : name); if (closeBrowser) setShowAllTopics(false); } }, name + ' ', h('span', null, '(' + count.toLocaleString() + ')'));
    const syncLabel = sync.stage === 'cache' ? 'Cache ' + sync.done.toLocaleString() + ' / ' + sync.total.toLocaleString() :
        sync.stage === 'loading' ? 'Preparing calls…' : sync.stage === 'error' ? 'Sync unavailable' : 'Checked ' + sync.done.toLocaleString() + ' / ' + sync.total.toLocaleString();
    const pct = sync.total ? Math.min(100, Math.round(sync.done * 100 / sync.total)) : (sync.stage === 'complete' ? 100 : 0);
    const diagnostic = 'Missing: job ID ' + (missingReasons.jobId || 0) + ', PBX server ' + (missingReasons.server || 0) + ', call ID ' + (missingReasons.callId || 0) + ', lookup month ' + (missingReasons.month || 0) + '.';

    return h('div', { className: 'rep intelligence-report' + (selected.length ? ' has-selection' : '') },
        h('header', { className: 'intel-redesign-head' },
            h('div', { className: 'intel-title-block' },
                h('div', { className: 'intel-title-line' }, h('h1', null, 'Topics & summaries'), h('span', { className: 'intel-manager-badge' }, 'Managers only')),
                h('p', null, monthRange ? 'Report period: ' + monthRange.start + ' — ' + monthRange.end + (selectedMonth === reportToday.slice(0, 7) ? ' (MTD)' : '') + ' • Newest first • ' + ((filters.hours || 'all') === 'all' ? 'All hours' : filters.hours + ' hours') : 'Choose a report month.')),
            h('div', { className: 'intel-header-actions' },
                h('div', { className: 'intel-sync-wrap' },
                    h('button', { type: 'button', className: 'intel-sync-pill', 'aria-expanded': syncOpen, 'aria-describedby': 'intel-sync-diagnostics', onClick: () => setSyncOpen(v => !v) },
                        h('span', { className: 'intel-sync-dot' + (sync.stage === 'error' ? ' is-error' : (partialExport ? ' is-pending' : '')), 'aria-hidden': 'true' }), syncLabel,
                        h('span', { className: 'intel-sync-track', 'aria-hidden': 'true' }, h('span', { style: { width: pct + '%' } }))),
                    h('div', { id: 'intel-sync-diagnostics', role: 'tooltip', className: 'intel-sync-pop' + (syncOpen ? ' is-open' : '') },
                        h('strong', null, 'Transcription sync'), h('p', null, progress || ('Checked ' + jobs + ' jobs; ' + failures + ' unavailable or incomplete; ' + noTopics + ' finished without topics.')),
                        h('p', null, missing + ' CDR rows without a usable lookup. ' + diagnostic),
                        h('p', null, 'Counts include CDR topics and can change while checking. Older CDR caches may need refreshing.'))),
                h('button', { type: 'button', className: 'intel-action-btn', onClick: () => setWatchOpen(true) }, h('i', { className: 'fa-solid fa-bell', 'aria-hidden': 'true' }), ' Keyword Watch ', h('span', { className: 'intel-counter' }, savedWatches.length)),
                h('div', { className: 'intel-month-control' },
                    h('input', { type: 'month', value: selectedMonth, max: reportToday.slice(0, 7), onChange: e => setSelectedMonth(e.target.value), 'aria-label': 'Report month' }),
                    h('button', { type: 'button', className: 'intel-icon-btn', disabled: !!progress, onClick: () => { setRefresh(x => x + 1); refreshMonitorStatus(); }, title: progress ? 'Wait for current checking to finish' : 'Reload report', 'aria-label': 'Reload' }, h('i', { className: 'fa-solid fa-rotate-right', 'aria-hidden': 'true' }))))),
        cacheIncomplete ? h('p', { role: 'alert', className: 'intel-warning' }, 'The CDR month is not fully loaded; this report is incomplete.') : null,
        error && !watchOpen ? h('p', { role: 'alert', className: 'intel-warning' }, error) : null,
        monitor?.unavailable ? h('p', { role: 'alert', className: 'intel-warning' }, 'Unable to load automatic alert status. Refresh the report and contact an administrator if the issue continues.') : null,
        message ? h('p', { role: 'status', className: 'intel-notice' }, message) : null,
        h('section', { className: 'intel-filter-card', 'aria-label': 'Topic and call filters' },
            h('div', { className: 'intel-ribbon-row' },
                h('span', { className: 'intel-ribbon-label' }, 'Topics ', h('b', null, '(' + topics.length.toLocaleString() + ')')),
                h('div', { className: 'intel-quick-scroll', id: 'intelligence-topic-list', 'aria-label': 'Topic choices' },
                    ...displayedTopics.map(item => topicButton(item)), !displayedTopics.length ? h('span', { className: 'intel-muted' }, query ? 'No matching topics' : 'No topics yet') : null),
                h('div', { className: 'intel-ribbon-tools' },
                    h('input', { type: 'search', className: 'intelligence-input intel-inline-search', value: topicSearch, onChange: e => setTopicSearch(e.target.value), placeholder: 'Filter topics…', 'aria-label': 'Search topics' }),
                    h('button', { type: 'button', className: 'intel-action-btn', onClick: () => setShowAllTopics(true) }, 'Browse all'))),
            h('div', { className: 'intel-filter-row' },
                h('div', { className: 'intel-filter-left' },
                    h('label', { className: 'intel-filter-label' }, 'Match status', h('select', { className: 'intelligence-input', value: matchFilter, 'aria-label': 'Match status', onChange: e => { setMatchFilter(e.target.value); setPage(1); } },
                        h('option', { value: 'all' }, 'All calls'), h('option', { value: 'matched' }, 'Matched'), h('option', { value: 'unmatched' }, 'No match (checked)'), h('option', { value: 'incomplete' }, 'Incomplete / not checked'))),
                    h('label', { className: 'intel-filter-label' }, 'Review status', h('select', { className: 'intelligence-input', value: reviewFilter, 'aria-label': 'Review status', onChange: e => { setReviewFilter(e.target.value); setPage(1); } },
                        h('option', { value: 'all' }, 'All calls'), h('option', { value: 'review' }, 'For review'))),
                    h('label', { className: 'intel-filter-label' }, 'Watched keyword', h('select', { className: 'intelligence-input', value: keywordFilter, 'aria-label': 'Watched keyword', onChange: e => { setKeywordFilter(e.target.value); setPage(1); } },
                        h('option', { value: '' }, 'All keywords'), ...savedWatches.map(w => h('option', { key: w, value: w }, w)))),
                    topic || matchFilter !== 'all' || reviewFilter !== 'all' || keywordFilter ? h('button', { type: 'button', className: 'intel-text-btn', onClick: resetFilters }, 'Reset filters') : null,
                    topic ? h('span', { className: 'intel-filter-active', title: topic }, 'Topic: ' + topic) : null),
                h('div', { className: 'intel-filter-right' },
                    h('label', { className: 'intel-filter-label' }, 'Rows', h('select', { value: pageSize, className: 'intelligence-input', 'aria-label': 'Rows per page', onChange: e => { setPageSize(Number(e.target.value)); setPage(1); } }, ...[30, 50, 100].map(n => h('option', { key: n, value: n }, n)))),
                    h('button', { type: 'button', className: 'intel-export-btn', disabled: !visible.length, title: !visible.length ? 'No filtered calls are available yet.' : (partialExport ? 'Export available results; checking or coverage is incomplete and the file will be marked partial.' : 'Export all filtered calls including sensitive excerpts.'), onClick: exportCalls }, h('i', { className: 'fa-solid fa-file-excel', 'aria-hidden': 'true' }), partialExport && visible.length ? ' Export Excel (partial)' : ' Export Excel')))),
        partialExport && visible.length ? h('p', { className: 'intel-partial-note', role: 'status' }, (progress ? 'Checking is in progress. ' : 'Some call data is unavailable. ') + 'Export contains currently available calls and is marked partial.') :
            (!visible.length ? h('p', { className: 'intel-partial-note', role: 'status' }, 'Excel export is unavailable until at least one filtered call is available.') : null),
        reviewFilter === 'review' ? h('p', { className: 'intel-partial-note', role: 'status' },
            'Shows reviews for this report month and records with unknown call dates. Limited-detail records cannot be selected for email.' +
            (unscopedReviews ? ' ' + unscopedReviews + ' reviews have unknown site, department, agent or hours; clear those filters to see them.' : '')) : null,
        h('section', { className: 'intel-results', 'aria-label': reviewFilter === 'review' ? 'Calls for review' : 'Calls with topics' },
            h('div', { className: 'intel-results-head' }, h('div', null, h('h2', null, topic ? 'Calls: ' + topic : (reviewFilter === 'review' ? 'Calls for review' : 'Calls with topics')), h('span', null, visible.length.toLocaleString() + ' calls')), h('span', null, 'Newest first')),
            h('div', { className: 'intel-table-wrap', role: 'region', 'aria-label': 'Scrollable calls table', tabIndex: 0 },
                h('table', { className: 'intel-table' },
                    h('thead', null, h('tr', null,
                        h('th', { scope: 'col' }, h('input', { type: 'checkbox', 'aria-label': 'Select all filtered calls', title: 'Select or unselect all currently loaded filtered calls across pages', disabled: busy || !visibleKeys.length,
                            checked: visibleKeys.length > 0 && visibleSelected === visibleKeys.length,
                            ref: el => { if (el) el.indeterminate = visibleSelected > 0 && visibleSelected < visibleKeys.length; },
                            onChange: e => e.target.checked ? selectAllFiltered() : unselectFiltered() })),
                        ...['Date / time / PBX reference', 'Caller number', 'Originally dialed', 'Final destination', 'Topics', 'Summary', 'Watch matches', 'Email status', 'Automatic alert review'].map(x => h('th', { key: x, scope: 'col' }, x)))),
                    h('tbody', null, ...pageRows.map(row => h(IntelligenceRow, { key: row.reference || row.rowKey, row, checked: selectedKeys.has(row.reference || row.rowKey), busy, onSelect: toggleRow, topic, onTopic: changeTopic, onCopy: copyReference, watches: savedWatches, reviews: activeReviews(row), onAcknowledge: acknowledgeReview }))))),
            !pageRows.length ? h('p', { className: 'intel-empty' }, progress ? 'Checking calls for topics…' : (topic || matchFilter !== 'all' || reviewFilter !== 'all' || keywordFilter ? 'No calls match the current filters.' : 'No calls with topics in this month.')) : null,
            h('div', { className: 'intel-pagination', 'aria-label': 'Call table pagination' },
                h('span', null, recordRangeLabel(visible.length, startIndex, Math.min(startIndex + pageSize, visible.length))),
                h('div', { className: 'intel-page-buttons' }, paginationButton('First', 1, currentPage === 1), paginationButton('Previous', currentPage - 1, currentPage === 1),
                    h('span', null, 'Page ' + currentPage + ' of ' + totalPages), paginationButton('Next', currentPage + 1, currentPage === totalPages), paginationButton('Last', totalPages, currentPage === totalPages)))),
        selected.length ? h('div', { className: 'intel-bulk-dock', role: 'region', 'aria-label': 'Selected call actions' },
            h('div', { className: 'intel-selection-badge' }, h('strong', null, selected.length.toLocaleString() + ' selected'), h('span', null, visibleSelected.toLocaleString() + ' in current filter' + (progress ? ' · loaded only' : ''))),
            h('button', { type: 'button', className: 'intel-action-btn', disabled: busy || !visibleKeys.length || visibleSelected === visibleKeys.length, onClick: selectAllFiltered }, 'Select all filtered calls'),
            h('button', { type: 'button', className: 'intel-text-btn', disabled: busy || !visibleSelected, onClick: unselectFiltered }, 'Unselect filtered calls'),
            h('button', { type: 'button', className: 'intel-text-btn', disabled: busy, onClick: () => setSelected([]) }, 'Clear all selections'),
            h('label', { className: 'intel-email-label' }, h('span', { className: 'intel-sr-only' }, 'Recipients'), h('input', { value: recipients, onChange: e => setRecipients(e.target.value), placeholder: 'name@example.com', className: 'intelligence-input', 'aria-label': 'Recipients' })),
            h('button', { type: 'button', className: 'intel-export-btn', disabled: busy, onClick: send }, 'Email (' + selected.length.toLocaleString() + ')'),
            emailProgress ? h('span', { role: 'status', className: 'intel-muted' }, emailProgress) : null) : null,
        watchOpen ? h(IntelligenceOverlay, { title: 'Keyword Watch', drawer: true, onClose: () => setWatchOpen(false) },
            error ? h('p', { role: 'alert', className: 'intel-warning' }, error) : null,
            message.startsWith('Watched phrases saved') ? h('p', { role: 'status', className: 'intel-notice' }, message) : null,
            h('p', { className: 'intel-drawer-copy' }, 'Separate phrases with commas or new lines. To keep a comma in a phrase, enclose it in double quotes. Matching ignores case and searches transcripts, summaries and topics.'),
            h('label', { className: 'intel-drawer-label' }, 'Watched phrases', h('textarea', { value: watches, onChange: e => setWatches(e.target.value), rows: 8, 'aria-label': 'Watched phrases', className: 'intelligence-input intel-watch-input' })),
            h('button', { type: 'button', className: 'intel-export-btn', disabled: busy, onClick: saveWatches }, 'Save watched phrases'),
            h('details', { className: 'intel-override' }, h('summary', null, 'Automatic keyword email alerts'),
                h('p', { className: 'intel-drawer-copy' }, 'A Windows scheduled task polls recent CDRs, checks these phrases and emails this domain’s saved recipients. Calls outside the discovery window can be missed. Completed report checks are skipped, even if no alert was sent. Unready jobs are retried for 24 hours.'),
                monitor?.unavailable ? h('p', { className: 'intel-warning' }, 'Unable to load automatic alert status.') : null,
                monitor && !monitor.unavailable && monitor.recordingLinksConfigured === false ? h('p', { className: 'intel-warning' }, 'Recording links are unavailable until the server administrator configures the public recording URL. Alerts will still be sent.') : null,
                monitor?.lookbackMinutes ? h('p', { className: 'intel-drawer-copy' }, 'CDR discovery window: ' + monitor.lookbackMinutes + ' minutes (configured on the server).') : null,
                h('label', { className: 'intel-drawer-label' }, 'Alert recipients for this domain', h('input', { type: 'text', value: alertRecipients, onChange: e => setAlertRecipients(e.target.value), placeholder: 'first@example.com; second@example.com', className: 'intelligence-input intel-watch-input', 'aria-label': 'Automatic alert recipients', disabled: busy || !monitor || monitor.unavailable })),
                h('p', { className: 'intel-drawer-copy' }, 'Separate up to 10 email addresses with semicolons. Clearing the list pauses automatic alerts for this domain.'),
                h('button', { type: 'button', className: 'intel-action-btn', disabled: busy || !monitor || monitor.unavailable, onClick: saveAlertRecipients }, 'Save alert recipients'),
                monitor?.paused ? h('p', { className: 'intel-warning', role: 'status' }, 'Automatic alerts are paused until this domain has saved recipients. Pending calls older than 24 hours will require review.') : null,
                message.startsWith('Alert recipients') ? h('p', { role: 'status', className: 'intel-notice' }, message) : null,
                monitor && !monitor.unavailable ? h('p', { className: 'intel-drawer-copy' }, 'Status: ' + (monitor.enabled ? 'Enabled' : 'Disabled') + (monitor.configured ? '' : ' · server configuration incomplete')) : null,
                monitor?.enabled && !monitor.lastRun ? h('p', { className: 'intel-drawer-copy' }, 'No scheduled scan has completed yet. Verify the Windows task is running.') : null,
                monitor?.lastRun ? h('p', { className: 'intel-drawer-copy' }, 'Last run: ' + new Date(monitor.lastRun.time * 1000).toLocaleString() + ' · ' + (monitor.lastRun.error || ('sent ' + (monitor.lastRun.counts?.sent || 0) + ' · pending ' + (monitor.lastRun.counts?.pending || 0)))) : null,
                message.startsWith('Automatic alerts') ? h('p', { role: 'status', className: 'intel-notice' }, message) : null,
                monitor && !monitor.unavailable ? h('button', { type: 'button', className: 'intel-action-btn', disabled: busy || (!monitor.enabled && (!monitor.configured || !monitor.recipients?.length)), onClick: toggleMonitor }, monitor.enabled ? 'Disable automatic alerts' : 'Enable automatic alerts') : null),
            h('details', { className: 'intel-override' }, h('summary', null, 'PBX lookup month override'),
                h('p', { className: 'intel-drawer-copy' }, 'Optional YYYYMM used for every lookup; leave blank to use the PBX link or server configuration. This does not change the report month.'),
                h('label', { className: 'intel-drawer-label' }, 'Override', h('input', { value: overrideMonth, onChange: e => setOverrideMonth(e.target.value), placeholder: 'YYYYMM', maxLength: 6, className: 'intelligence-input' })),
                h('button', { type: 'button', className: 'intel-action-btn', onClick: () => { setAppliedOverride(overrideMonth.trim()); setRefresh(x => x + 1); } }, 'Apply override'))) : null,
        showAllTopics ? h(IntelligenceOverlay, { title: 'Browse topics', onClose: () => setShowAllTopics(false) },
            h('div', { className: 'intel-browser-controls' },
                h('label', { className: 'intel-drawer-label' }, 'Search topics', h('input', { type: 'search', className: 'intelligence-input', value: topicSearch, onChange: e => setTopicSearch(e.target.value), placeholder: 'Filter topics…', 'aria-label': 'Search all topics' })),
                h('label', { className: 'intel-drawer-label' }, 'Sort topics', h('select', { className: 'intelligence-input', value: topicSort, onChange: e => setTopicSort(e.target.value), 'aria-label': 'Sort topics' }, h('option', { value: 'count' }, 'Most calls'), h('option', { value: 'alphabetical' }, 'Alphabetical')))),
            h('p', { className: 'intel-drawer-copy', 'aria-live': 'polite' }, 'Showing ' + browserTopics.length.toLocaleString() + ' of ' + topics.length.toLocaleString() + ' topics' + (progress ? ' · counts are provisional' : '') + '.'),
            h('div', { className: 'intel-browser-list' }, ...browserTopics.map(item => topicButton(item, true)), !browserTopics.length ? h('p', null, 'No topics match your search.') : null)) : null);
}
export { IntelligenceDashboard };
