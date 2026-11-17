import { api } from '../lib/api.js';
import { downloadIntelligenceWorkbook } from '../lib/intelligence-export.js';
import { intelligenceMonthRange } from '../lib/intelligence-month.js';
import { recordRangeLabel } from '../lib/pagination.js';
import { APP_TZ, date, formatCallDate, formatCallTime, parseCallInstant } from '../lib/time.js';
import { h, useEffect, useState } from '../lib/react.js';

const LOOKUP_CONCURRENCY = 4;

function IntelligenceDashboard({ filters }) {
    const reportToday = date(new Date());
    const [watches, setWatches] = useState('');
    const [savedWatches, setSavedWatches] = useState([]);
    const [matchFilter, setMatchFilter] = useState('all');
    const [keywordFilter, setKeywordFilter] = useState('');
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
        api('intelligence', { action: 'watches' }).then(r => { if (active) { setWatches(r.watches.join('\n')); setSavedWatches(r.watches); } }).catch(e => { if (active) setError(e.message); });
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
            setWatches(r.watches.join('\n')); setSavedWatches(r.watches); setKeywordFilter(''); setMessage('Watched phrases saved. Rechecking calls.'); setRefresh(x => x + 1);
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
                await api('intelligence', { action: 'send', references: batch.map(row => row.emailReference), recipients: recipientsList });
                sent += batch.length;
                const sentKeys = new Set(batch.map(row => row.reference || row.rowKey));
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
    const displayedTopics = (showAllTopics || query ? filteredTopics : topics.slice(0, 10)).slice();
    if ((showAllTopics || query) && topicSort === 'alphabetical') displayedTopics.sort((a, b) => a[0].localeCompare(b[0]));
    /* CDR topics remain visible when a transcription is pending or unavailable. */
    const visible = rows.filter(r => {
        if (!(r.topics || []).length || (topic && !r.topics.includes(topic))) return false;
        if (matchFilter === 'matched' && !(r.matches || []).length) return false;
        if (matchFilter === 'unmatched' && (r.status !== 'finished' || (r.matches || []).length)) return false;
        if (matchFilter === 'incomplete' && r.status === 'finished') return false;
        return !keywordFilter || (r.matches || []).some(m => m.keyword === keywordFilter);
    });
    const failures = rows.filter(r => ['error', 'pending', 'partial', 'unavailable'].includes(r.status)).length;
    const jobs = rows.filter(r => r.reference).length;
    const noTopics = rows.filter(r => r.status === 'finished' && !(r.topics || []).length).length;
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * pageSize;
    const pageRows = visible.slice(startIndex, startIndex + pageSize);
    const changeTopic = value => { setTopic(value); setPage(1); };
    const visibleKeys = visible.map(row => row.reference || row.rowKey);
    const selectedKeys = new Set(selected);
    const visibleSelected = visibleKeys.filter(key => selectedKeys.has(key)).length;
    const selectAllFiltered = () => setSelected(current => [...new Set([...current, ...visibleKeys])]);
    const unselectFiltered = () => { const keys = new Set(visibleKeys); setSelected(current => current.filter(key => !keys.has(key))); };
    const paginationButton = (label, target, disabled) => h('button', { type: 'button', className: 'rep-btn', disabled, onClick: () => setPage(target), key: label }, label);
    const exportCalls = () => {
        try {
            setError('');
            downloadIntelligenceWorkbook(visible, [
                ['Report month', selectedMonth], ['Period', monthRange.start + ' – ' + monthRange.end], ['Timezone', APP_TZ],
                ['Department', filters.department || 'All'], ['Site', filters.site || 'All'], ['Agents', (filters.agents || []).join(', ') || 'All'],
                ['Hours', filters.hours || 'all'], ['Topic', topic || 'All'], ['Match filter', matchFilter], ['Watched keyword', keywordFilter || 'All'],
                ['Exported calls', String(visible.length)], ['CDR cache', cacheIncomplete ? 'Incomplete' : 'Complete'],
                ['Unavailable or incomplete checks', String(failures)], ['CDR rows without usable lookup', String(missing)],
                ['Generated (UTC)', new Date().toISOString()],
                ['Privacy', 'Contains summaries and matching excerpts. Handle as sensitive information.']
            ], selectedMonth);
        } catch (e) { setError('Excel export failed: ' + e.message); }
    };

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
            h('div', { className: 'intel-topic-controls' },
                h('label', { className: 'intel-topic-search' }, 'Search topics',
                    h('input', { type: 'search', className: 'intelligence-input', value: topicSearch, onChange: e => setTopicSearch(e.target.value), placeholder: 'Search all topics', 'aria-label': 'Search topics' })),
                h('label', { className: 'intel-topic-sort' }, 'Sort all topics',
                    h('select', { className: 'intelligence-input', value: topicSort, onChange: e => setTopicSort(e.target.value), 'aria-label': 'Sort topics' },
                        h('option', { value: 'count' }, 'Most calls'), h('option', { value: 'alphabetical' }, 'Alphabetical'))),
                h('button', { type: 'button', className: 'rep-btn', 'aria-expanded': showAllTopics, 'aria-controls': 'intelligence-topic-list', onClick: () => setShowAllTopics(value => !value) }, showAllTopics ? 'Show top topics' : 'Show all topics')),
            h('p', { className: 'rep-note', 'aria-live': 'polite' }, query
                ? 'Found ' + filteredTopics.length + ' of ' + topics.length + ' topics.'
                : showAllTopics ? 'Showing all ' + topics.length + ' topics.' : 'Showing top ' + displayedTopics.length + ' of ' + topics.length + ' topics by call count.'),
            h('div', { className: 'intel-topics', id: 'intelligence-topic-list', 'aria-label': 'Topic choices' },
                ...displayedTopics.map(([name, count]) => h('button', { key: name, type: 'button', className: 'rep-btn', 'aria-pressed': topic === name, onClick: () => changeTopic(name) }, name + ' (' + count + ')'))),
            !displayedTopics.length ? h('p', { className: 'rep-note' }, query ? 'No topics match your search.' : (progress ? 'Checking calls for topics…' : 'No topics found for this month.')) : null),
        h('section', { className: 'rep-sec' },
            topic ? h('div', { className: 'intel-active-filter' },
                h('span', null, 'Selected topic: ', h('strong', null, topic)),
                h('button', { type: 'button', className: 'rep-btn', onClick: () => changeTopic('') }, 'Clear filter')) : null,
            h('div', { className: 'intel-table-heading' }, h('div', null,
                h('h2', { className: 'rep-sec-title' }, topic ? 'Calls: ' + topic : 'Calls with topics'),
                h('p', { className: 'rep-note' }, 'Select any calls across pages and filters. Emails are sent in batches of up to 10 calls and may contain sensitive information.')),
                h('label', { className: 'intel-page-size' }, 'Rows per page ', h('select', { value: pageSize, className: 'intelligence-input', 'aria-label': 'Rows per page', onChange: e => { setPageSize(Number(e.target.value)); setPage(1); } }, ...[30, 50, 100].map(n => h('option', { key: n, value: n }, n))))),
            h('div', { className: 'intel-call-filters' },
                h('label', null, 'Match status ', h('select', { className: 'intelligence-input', value: matchFilter, 'aria-label': 'Match status', onChange: e => { setMatchFilter(e.target.value); setPage(1); } },
                    h('option', { value: 'all' }, 'All calls'), h('option', { value: 'matched' }, 'Matched'), h('option', { value: 'unmatched' }, 'No match (checked)'), h('option', { value: 'incomplete' }, 'Incomplete / not checked'))),
                h('label', null, 'Watched keyword ', h('select', { className: 'intelligence-input', value: keywordFilter, 'aria-label': 'Watched keyword', onChange: e => { setKeywordFilter(e.target.value); setPage(1); } },
                    h('option', { value: '' }, 'All keywords'), ...savedWatches.map(w => h('option', { key: w, value: w }, w)))),
                h('button', { type: 'button', className: 'rep-btn', disabled: !!progress || !visible.length, onClick: exportCalls }, 'Export filtered calls to Excel')),
            h('p', { className: 'rep-note' }, 'Matched includes known matches from incomplete checks; No match includes only fully checked calls. Filters combine. Excel exports all filtered pages, including sensitive summaries and matching excerpts.'),
            progress ? h('p', { className: 'rep-note', role: 'status' }, 'Excel export becomes available after all transcription jobs have been checked. ' + progress) :
                (!visible.length ? h('p', { className: 'rep-note' }, 'Excel export is unavailable because there are no calls matching the current filters.') : null),
            h('div', { className: 'intel-call-filters' },
                h('button', { type: 'button', className: 'rep-btn', disabled: busy || !visible.length || visibleSelected === visibleKeys.length, onClick: selectAllFiltered }, 'Select all filtered calls'),
                h('button', { type: 'button', className: 'rep-btn', disabled: busy || !visibleSelected, onClick: unselectFiltered }, 'Unselect filtered calls'),
                h('button', { type: 'button', className: 'rep-btn', disabled: busy || !selected.length, onClick: () => setSelected([]) }, 'Clear all selections'),
                h('span', null, selected.length + ' selected total; ' + visibleSelected + ' in the current filter' + (progress ? ' (currently loaded calls only)' : '') + '.')),
            h('div', { className: 'intel-email' },
                h('label', null, 'Recipients ', h('input', { value: recipients, onChange: e => setRecipients(e.target.value), placeholder: 'name@example.com', className: 'intelligence-input' })),
                h('button', { type: 'button', className: 'rep-btn', disabled: busy || !selected.length, onClick: send }, 'Email selected (' + selected.length + ')')),
            emailProgress ? h('p', { className: 'rep-note', role: 'status' }, emailProgress) : (!selected.length ? h('p', { className: 'rep-note' }, 'Select calls to enable email.') : null),
            h('div', { className: 'intel-table-wrap', role: 'region', 'aria-label': 'Scrollable calls table', tabIndex: 0 },
                h('table', { className: 'intel-table' },
                    h('thead', null, h('tr', null, ...['Select', 'When / PBX reference', 'Topics', 'Summary', 'Watch matches'].map(x => h('th', { key: x, scope: 'col' }, x)))),
                    h('tbody', null, ...pageRows.map(row => h('tr', { key: row.reference || row.rowKey, className: row.matches?.length ? 'is-matched' : '' },
                        h('td', null, h('input', { type: 'checkbox', 'aria-label': 'Select call ' + row.callId, checked: selectedKeys.has(row.reference || row.rowKey), disabled: busy, onChange: e => { const key = row.reference || row.rowKey; const checked = e.target.checked; setSelected(s => checked ? [...new Set([...s, key])] : s.filter(x => x !== key)); } })),
                        h('td', null, h('strong', null, formatCallDate(row.startedAt) || row.startedAt), h('div', { className: 'intel-muted' }, formatCallTime(row.startedAt)), h('div', { className: 'intel-reference' }, (row.callIdField ? row.callIdField + ': ' : '') + row.callId)),
                        h('td', null, h('div', { className: 'intel-topic-list' }, ...(row.topics || []).map(t => h('span', { key: t, className: 'intel-topic' }, t)))),
                        h('td', { className: 'intel-summary' }, row.summary || 'Summary unavailable'),
                        h('td', null, row.matches?.length ? h('span', { className: 'intel-match-label' }, 'Matched: ' + row.matches.map(m => m.keyword).join(', ')) : (row.status === 'finished' ? 'No match' : 'Not fully checked'),
                            row.status !== 'finished' ? h('div', { className: 'intel-muted' }, 'Incomplete check · ' + row.status + (row.detail ? ': ' + row.detail : '')) : null,
                            row.matches?.length ? h('details', null, h('summary', null, 'Matching excerpts'), ...row.matches.map(m => h('p', { key: m.keyword }, m.keyword + ' (' + m.source + '): ' + m.excerpt))) : null)))))),
            !pageRows.length ? h('p', { className: 'intel-empty' }, progress ? 'Checking calls for topics…' : (topic || matchFilter !== 'all' || keywordFilter ? 'No calls match the current filters.' : 'No calls with topics in this month.')) : null,
            h('div', { className: 'intel-pagination', 'aria-label': 'Call table pagination' },
                h('span', null, recordRangeLabel(visible.length, startIndex, Math.min(startIndex + pageSize, visible.length))),
                h('div', { className: 'intel-page-buttons' },
                    paginationButton('First', 1, currentPage === 1), paginationButton('Previous', currentPage - 1, currentPage === 1),
                    h('span', null, 'Page ' + currentPage + ' of ' + totalPages),
                    paginationButton('Next', currentPage + 1, currentPage === totalPages), paginationButton('Last', totalPages, currentPage === totalPages)))));
}
export { IntelligenceDashboard };
