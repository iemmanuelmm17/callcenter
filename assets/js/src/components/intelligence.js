import { api } from '../lib/api.js';
import { h, useEffect, useState } from '../lib/react.js';

function IntelligenceDashboard({ filters }) {
    const [watches, setWatches] = useState('');
    const [month, setMonth] = useState('');
    const [appliedMonth, setAppliedMonth] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [rows, setRows] = useState([]);
    const [missing, setMissing] = useState(0);
    const [cacheIncomplete, setCacheIncomplete] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [topic, setTopic] = useState('');
    const [selected, setSelected] = useState([]);
    const [recipients, setRecipients] = useState('');
    const [busy, setBusy] = useState(false);
    const filterKey = JSON.stringify(filters);

    useEffect(() => {
        let active = true;
        api('intelligence', { action: 'watches' }).then(r => { if (active) setWatches(r.watches.join('\n')); }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        let active = true;
        setRows([]); setSelected([]); setTopic(''); setMissing(0); setCacheIncomplete(false); setError('');
        setProgress('Loading calls…');
        (async () => {
            try {
                const list = await api('intelligence', { ...filters, action: 'list', month: appliedMonth });
                if (!active) return;
                setMissing(list.missing);
                setCacheIncomplete(!list.cacheStatus?.complete);
                const items = list.calls.map(c => ({ ...c, status: 'waiting' }));
                setRows(items.slice());
                for (let i = 0; i < items.length && active; i++) {
                    setProgress('Checking transcription ' + (i + 1) + ' of ' + items.length + '…');
                    try {
                        const result = await api('intelligence', { action: 'lookup', reference: items[i].reference });
                        items[i] = { ...items[i], ...result };
                    } catch (e) { items[i] = { ...items[i], status: 'error', detail: e.message }; }
                    if (active) setRows(items.slice());
                }
                if (active) setProgress('');
            } catch (e) { if (active) { setError(e.message); setProgress(''); } }
        })();
        return () => { active = false; };
    }, [filterKey, appliedMonth, refresh]);

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
    const visible = topic ? rows.filter(r => (r.topics || []).includes(topic)) : rows;
    const failures = rows.filter(r => r.status !== 'finished' && r.status !== 'waiting').length;
    return h('div', { className: 'rep' },
        h('h1', { className: 'rep-title' }, 'Topics & summaries'),
        h('p', { className: 'rep-note' }, 'Office managers only. Counts cover loaded call-intelligence jobs, not all calls. Date, department, site, agent and business-hours filters apply; other global filters do not.'),
        h('section', { className: 'rep-sec' },
            h('h2', { className: 'rep-sec-title' }, 'Keyword watch'),
            h('p', { className: 'rep-note' }, 'One phrase per line. Case-insensitive substring search across transcript, summary and topics. Tags reflect the current domain watch list.'),
            h('textarea', { value: watches, onChange: e => setWatches(e.target.value), rows: 4, 'aria-label': 'Watched phrases', className: 'intelligence-input', style: { width: '100%' } }),
            h('button', { type: 'button', className: 'rep-btn', disabled: busy, onClick: saveWatches }, 'Save watched phrases')),
        h('section', { className: 'rep-sec' },
            h('h2', { className: 'rep-sec-title' }, 'Transcription lookup'),
            h('label', null, 'Override month (YYYYMM; blank uses PBX link or server configuration) ', h('input', { value: month, onChange: e => setMonth(e.target.value), placeholder: 'YYYYMM', maxLength: 6, className: 'intelligence-input' })), ' ',
            h('button', { type: 'button', className: 'rep-btn', onClick: () => { setAppliedMonth(month.trim()); setRefresh(x => x + 1); } }, 'Load report'),
            h('p', { className: 'rep-note' }, progress || ('Checked ' + rows.length + ' jobs; ' + failures + ' unavailable or incomplete; ' + missing + ' CDR rows lack a usable job, call ID, server, or lookup month; configure the month timezone if needed. Older CDR caches may need refreshing.')),
            cacheIncomplete ? h('p', { role: 'alert', className: 'rep-error' }, 'The CDR date range is not fully loaded; this report is incomplete.') : null,
            error ? h('p', { role: 'alert', className: 'rep-error' }, error) : null,
            message ? h('p', { role: 'status' }, message) : null),
        h('section', { className: 'rep-sec' },
            h('h2', { className: 'rep-sec-title' }, 'Topics'),
            h('p', { className: 'rep-note' }, 'Counts are provisional until all lookups finish. Select a topic to filter the calls below.'),
            h('button', { type: 'button', className: 'rep-btn', onClick: () => setTopic('') }, 'All calls'), ' ',
            ...topics.map(([name, count]) => h('button', { key: name, type: 'button', className: 'rep-btn', 'aria-pressed': topic === name, onClick: () => setTopic(name) }, name + ' (' + count + ') '))),
        h('section', { className: 'rep-sec' },
            h('h2', { className: 'rep-sec-title' }, topic ? 'Calls: ' + topic : 'Calls'),
            h('p', { className: 'rep-note' }, 'Select up to 10 tagged calls and enter up to 10 recipients. Emails include matching text excerpts; verify recipients before sending.'),
            h('label', null, 'Recipients ', h('input', { value: recipients, onChange: e => setRecipients(e.target.value), placeholder: 'name@example.com', className: 'intelligence-input', style: { width: '20em', maxWidth: '100%' } })), ' ',
            h('button', { type: 'button', className: 'rep-btn', disabled: busy || !selected.length || !!progress, onClick: send }, 'Email selected (' + selected.length + ')'),
            h('table', { className: 'rep-table' },
                h('thead', null, h('tr', null, ...['Select', 'Call / time', 'Topics', 'Summary', 'Watch tags / status'].map(x => h('th', { key: x, className: 'rep-th' }, x)))),
                h('tbody', null, ...visible.map(row => h('tr', { key: row.reference },
                    h('td', { className: 'rep-td' }, row.status === 'finished' && row.matches?.length ? h('input', { type: 'checkbox', 'aria-label': 'Select call ' + row.callId, checked: selected.includes(row.reference), disabled: !selected.includes(row.reference) && selected.length >= 10, onChange: e => setSelected(s => e.target.checked ? [...s, row.reference] : s.filter(x => x !== row.reference)) }) : null),
                    h('td', { className: 'rep-td' }, row.callId, h('br'), row.startedAt, h('br'), 'Lookup month: ' + row.month),
                    h('td', { className: 'rep-td' }, (row.topics || []).join(', ') || '—'),
                    h('td', { className: 'rep-td' }, row.summary || '—'),
                    h('td', { className: 'rep-td' }, (row.matches || []).map(m => m.keyword).join(', ') + (row.status === 'finished' ? ((row.matches || []).length ? '' : 'No match') : ' ' + row.status + (row.detail ? ': ' + row.detail : '')), (row.matches || []).length ? h('details', null, h('summary', null, 'Matching excerpts'), ...row.matches.map(m => h('p', { key: m.keyword }, m.keyword + ' (' + m.source + '): ' + m.excerpt))) : null)))))));
}
export { IntelligenceDashboard };
