/* The Agents page: the roster sidebar and its selection state.
 *
 * Split out of the single-file assets/js/src/app.js by
 * tools/split-js-file.mjs, then out of components/agents.js when that file
 * reached four views in one. Every function body below is byte-identical to the
 * original — the split is verified by hashing the declaration before and after
 * (see CHANGES.md, QA round 2). */

import { api } from '../lib/api.js';
import { h, useEffect, useState } from '../lib/react.js';
import { skel } from './ui.js';

function Agents({filters,role,selectedAgents,onAgentsChange,onData,singleSelect}) {
    const [agents,setAgents] = useState([]);
    const [term,setTerm] = useState('');
    const [selected,setSelected] = useState(Array.isArray(selectedAgents) ? selectedAgents : []);
    const [loading,setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        setSelected(Array.isArray(selectedAgents) ? selectedAgents : []);
    }, [selectedAgents]);

    useEffect(() => {
        let active = true;
        setLoading(true);
        api('agents', filters)
            .then(r => {
                if (!active) return;
                const data = Array.isArray(r?.data) ? r.data : [];
                setAgents(data);
                if (onData) onData(data);
            })
            .catch(() => {
                if (!active) return;
                setAgents([]);
                if (onData) onData([]);
            })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [filters.start, filters.end, filters.department, filters.site]);

    const visible = agents
        .filter(x =>
            (String(x.name || '') + String(x.extension || '')).toLowerCase().includes(term.toLowerCase())
        )
        .slice()
        .sort((a, b) => Number(b.totalCalls || b.total || 0) - Number(a.totalCalls || a.total || 0));

    useEffect(() => {
        if (!singleSelect || loading || !visible.length) return;
        const current = Array.isArray(selected) ? selected : [];
        if (current.length === 1 && visible.some(a => a.extension === current[0])) return;
        const pick = visible[0].extension;
        setSelected([pick]);
        onAgentsChange([pick]);
    }, [singleSelect, loading, agents, term]);

    const applySelection = ids => {
        const next = singleSelect ? ids.slice(0, 1) : ids;
        setSelected(next);
        onAgentsChange(next);
    };

    const toggleAgent = extension => {
        if (singleSelect) {
            applySelection([extension]);
            return;
        }
        const next = selected.includes(extension)
            ? selected.filter(x => x !== extension)
            : [...selected, extension];
        applySelection(next);
    };

    return h('aside', {className: 'agent-side' + (collapsed ? ' is-collapsed' : '')},
        h('div', {className: 'aa-side-head'},
            collapsed ? null : h('h2', {className: 'text-sm font-semibold text-slate-100'}, 'Agents'),
            h('button', {
                type: 'button',
                title: collapsed ? 'Expand agents' : 'Collapse agents',
                onClick: () => setCollapsed(c => !c),
                className: 'aa-side-toggle'
            }, collapsed ? '›' : '‹')
        ),
        collapsed ? null : h('div', {className: 'px-3 pb-1 flex items-center justify-between'},
            singleSelect
                ? h('span', {className: 'text-[10px] text-slate-500'}, 'Select one')
                : h('div', {className: 'flex gap-2 text-[11px]'},
                    h('button', {type: 'button', onClick: () => applySelection(visible.map(a => a.extension)), className: 'text-cyan-400 hover:text-cyan-300'}, 'Select all'),
                    h('button', {type: 'button', onClick: () => applySelection([]), className: 'text-slate-500 hover:text-slate-300'}, 'Clear')
                )
        ),
        collapsed ? null : h('input', {
            value: term,
            onChange: e => setTerm(e.target.value),
            placeholder: 'Find agent or extension…',
            className: 'aa-side-search'
        }),
        loading
            ? h('div', {className: 'space-y-1 px-3 pt-1'},
                ...Array.from({length: 8}, (_, i) => h('div', {key: i, className: 'mb-1'}, skel('h-12'))))
            : h('div', {className: 'agent-side-list'},
                ...visible.map(a => {
                    const on = selected.includes(a.extension);
                    const label = a.name || a.extension;
                    return h('button', {
                        key: a.extension,
                        type: 'button',
                        title: label,
                        onClick: () => toggleAgent(a.extension),
                        className: 'agent-pick ' + (on ? 'is-on' : '')
                    },
                        collapsed
                            ? h('span', {className: 'aa-side-glyph'}, String(label).slice(0, 1).toUpperCase())
                            : h(React.Fragment, null,
                                h('span', {className: 'agent-pick-av', 'aria-hidden': 'true'},
                                    String(label).trim().slice(0, 1).toUpperCase() || '?'),
                                h('span', {className: 'min-w-0 flex-1 text-left'},
                                    h('span', {className: 'agent-pick-name truncate'}, label),
                                    h('span', {className: 'agent-pick-ext truncate'}, a.extension)
                                )
                              )
                    );
                })
            )
    );
}

export { Agents };
