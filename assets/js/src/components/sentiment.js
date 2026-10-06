/*
 * Sentiment for the period (Sprint B).
 *
 * The call-intelligence fields (call-intelligence-percent-*) were rendered only
 * as a live donut on Queues → Overview: no period, no base, no way to ask "which
 * week was bad, and about what". This card puts the same three figures on the
 * dashboard for the selected range, with the two facts a reader needs before
 * quoting them - how many calls were actually scored, and how many of them came
 * out negative - and the topics the period's calls were tagged with.
 *
 * Every number here is the server's (summary.sentiment); the card computes
 * nothing, so the figure it shows and the figure the export writes cannot drift.
 */
import { h } from '../lib/react.js';
import { Tooltip, skelPanel } from './ui.js';

function SentimentCard({sentiment, loading, onTopicClick, onNegativeClick}) {
    if (loading) return h('section', {className: 'ops-card'}, skelPanel(3));
    const s = sentiment && typeof sentiment === 'object' ? sentiment : null;
    if (!s) return null;

    const scored = Number(s.scored || 0);
    const negativeCalls = Number(s.negativeCalls || 0);
    const topics = Array.isArray(s.topics) ? s.topics : [];

    const bar = (label, value, colour) => h('div', {className: 'ops-sent-row'},
        h('span', {className: 'ops-sent-k'}, label),
        h('div', {className: 'ops-sent-track'},
            h('div', {className: 'ops-sent-fill', style: {width: Math.max(1, Math.min(100, Number(value) || 0)) + '%', background: colour}})),
        h('span', {className: 'ops-sent-v'}, Number(value || 0).toFixed(1) + '%')
    );

    return h('section', {className: 'ops-card ops-sent'},
        h('div', {className: 'ops-label'}, 'Sentiment',
            h(Tooltip, {text: 'Average call-intelligence positive / neutral / negative across the calls in this range that carry sentiment at all. A call nobody scored is not a neutral call, so it is left out of the averages and out of the base below.'},
                h('span', {className: 'cursor-help border-b border-dotted border-slate-600 text-[10px] font-normal text-slate-500'}, '?'))),
        scored === 0
            ? h('div', {className: 'ops-hint'}, 'No sentiment data in this range — the PBX did not score these calls. Nothing is inferred from their absence.')
            : h('div', null,
                bar('Positive', s.positive, '#35D0A0'),
                bar('Neutral', s.neutral, '#8892A0'),
                bar('Negative', s.negative, '#F0555A'),
                h('div', {className: 'ops-sent-foot'},
                    /* The base first, then the count that leads somewhere: the
                     * negative worklist is the action this card exists for. */
                    h('span', null, fmtBase(scored, negativeCalls)),
                    negativeCalls > 0 && onNegativeClick
                        ? h('button', {
                            type: 'button',
                            className: 'ops-sent-link',
                            onClick: onNegativeClick,
                            title: 'Scope every figure to the ' + negativeCalls + ' call(s) whose negative share leads'
                        }, 'Open the negative calls →')
                        : null
                ),
                topics.length
                    ? h('div', {className: 'ops-sent-topics'},
                        h('span', {className: 'ops-sent-k'}, 'Topics'),
                        ...topics.map(t => onTopicClick
                            ? h('button', {
                                key: t.topic,
                                type: 'button',
                                className: 'ops-sent-topic',
                                title: 'Tagged on ' + Number(t.count || 0) + ' scored call(s) in this range',
                                onClick: () => onTopicClick(t.topic)
                            }, t.topic + ' · ' + Number(t.count || 0))
                            : h('span', {key: t.topic, className: 'ops-sent-topic'}, t.topic + ' · ' + Number(t.count || 0))))
                    : null
            )
    );
}

const fmtBase = (scored, negativeCalls) =>
    scored + (scored === 1 ? ' scored call' : ' scored calls') + ' · ' + negativeCalls + ' negative';

export { SentimentCard };
