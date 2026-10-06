/*
 * Weekday x hour heatmap (Sprint B).
 *
 * The hourly chart answers "when is it busy across the range"; this answers the
 * Monday-specific question it cannot, because averaging every Monday into every
 * other day hides the 09:00 spike a supervisor is actually short-staffed for.
 *
 * Two views, one grid:
 *   volume  calls started in that weekday/hour (inbound + missed)
 *   missed  the same cells as missed calls, with the share of the cell printed
 *           in the tooltip - so a rate never appears without its base
 *
 * Rows are indexed by the server's `w` (0 = Sunday) and labelled from the
 * payload's own `days` array, so the grid cannot drift out of step with the
 * calendar. A cell is NOT clickable: the call list can filter by hour but not by
 * weekday, and a drill that opened a different set of calls than the cell it was
 * started from is worse than no drill at all (that rule is why the hourly chart
 * row does carry one). The tooltip says so.
 */
import { fmtNum } from '../lib/format.js';
import { h, useState } from '../lib/react.js';
import { Tooltip } from './ui.js';

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));

function gridFrom(source) {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    if (!Array.isArray(source)) return grid;
    source.forEach((row, day) => {
        if (day < 0 || day > 6 || !Array.isArray(row)) return;
        row.forEach((value, hour) => {
            if (hour >= 0 && hour < 24) grid[day][hour] = Number(value || 0);
        });
    });
    return grid;
}

function WeekHourHeatmap({heatmap, loading}) {
    const [view, setView] = useState('volume');
    if (heatmap === null || heatmap === undefined) return null;
    /*
     * An array is the pre-Sprint-B shape (a bare 7x24 volume grid); a stale
     * cached response must not blank the card, so it is read as the volume grid
     * with no missed split rather than dropped.
     */
    const payload = Array.isArray(heatmap) ? {volume: heatmap} : heatmap;
    if (typeof payload !== 'object') return null;

    const labels = Array.isArray(payload.days) && payload.days.length === 7
        ? payload.days
        : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const volume = gridFrom(payload.volume);
    const missed = gridFrom(payload.missed);
    const answered = gridFrom(payload.answered);
    /* The two foot figures, computed once from the same grids the cells use, so
     * the line under the grid cannot disagree with it. */
    const offeredTotal = volume.flat().reduce((sum, n) => sum + n, 0);
    const answeredTotal = answered.flat().reduce((sum, n) => sum + n, 0);
    const grid = view === 'missed' ? missed : volume;
    /* A shared scale across the two views would make the missed view look empty
     * and the volume view saturate; each view's own maximum is the honest
     * colour scale, and the legend says which one is showing. */
    const max = Math.max(1, ...grid.flat());
    const total = grid.flat().reduce((sum, n) => sum + n, 0);

    const cellTitle = (day, hour) => {
        const at = labels[day] + ' ' + HOUR_LABELS[hour] + ':00';
        const offered = volume[day][hour];
        const gone = missed[day][hour];
        const taken = answered[day][hour];
        if (offered === 0) return at + ' — no calls in this range.';
        const share = ((gone / offered) * 100).toFixed(1);
        return at + ' — ' + fmtNum(offered) + ' offered, ' + fmtNum(taken) + ' answered, '
            + fmtNum(gone) + ' missed (' + share + '% of ' + fmtNum(offered) + ').'
            + ' Not clickable: the call list can filter an hour but not a weekday, so there is no drill that opens exactly this cell.';
    };

    const headCells = HOUR_LABELS.map(hour => h('th', {key: hour, className: 'ops-heat-hour'}, hour));
    const bodyRows = labels.map((label, day) => {
        const cells = HOUR_LABELS.map((_, hour) => {
            const value = grid[day][hour];
            const level = value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 5));
            return h('td', {
                key: hour,
                className: 'ops-heat-cell ops-heat-l' + level,
                title: cellTitle(day, hour),
                'aria-label': cellTitle(day, hour)
            }, value === 0 ? '' : fmtNum(value));
        });
        return h('tr', {key: label},
            h('th', {className: 'ops-heat-day', scope: 'row'}, label.slice(0, 3)),
            ...cells);
    });
    const heatGridTable = h('div', {className: 'ops-heat-scroll'},
        h('table', {className: 'ops-heat-table'},
            h('thead', null, h('tr', null,
                h('th', {className: 'ops-heat-day'}, ''),
                ...headCells)),
            h('tbody', null, ...bodyRows)));

    return h('section', {className: 'ops-card ops-heat'},
        h('div', {className: 'ops-label'}, 'Weekday × hour',
            /* The same help affordance every other card on this dashboard uses,
             * rather than a second style for the same thing. */
            h(Tooltip, {text: 'Calls started in each weekday/hour across the selected range. Averages hide the day this is for: a Monday 09:00 spike disappears in a range-wide hourly chart. Cells are not clickable — the call list filters an hour but not a weekday, so no drill would open exactly this cell.'},
                h('span', {className: 'cursor-help border-b border-dotted border-slate-600 text-[10px] font-normal text-slate-500'}, '?'))),
        h('div', {className: 'ops-heat-head'},
            h('div', {className: 'ops-rank-tabs', role: 'group', 'aria-label': 'Heatmap measure'},
                [['volume', 'Calls'], ['missed', 'Missed']].map(([id, label]) =>
                    h('button', {
                        key: id,
                        type: 'button',
                        className: 'ops-rank-tab' + (view === id ? ' is-on' : ''),
                        'aria-pressed': view === id,
                        onClick: () => setView(id)
                    }, label))),
            h('div', {className: 'ops-hint'},
                view === 'volume'
                    ? 'Inbound + missed calls per cell. Darker is busier.'
                    : 'Missed calls per cell (abandons included). Darker is worse.')
        ),
        loading
            ? h('div', {className: 'ops-heat-loading'}, 'Loading…')
            : heatGridTable,
        h('div', {className: 'ops-heat-foot'},
            h('span', null, view === 'volume'
                ? fmtNum(offeredTotal) + ' offered, ' + fmtNum(answeredTotal) + ' answered, '
                    + fmtNum(offeredTotal - answeredTotal) + ' missed'
                    + (offeredTotal > 0 ? ' (' + (((offeredTotal - answeredTotal) / offeredTotal) * 100).toFixed(1) + '% of offered)' : '')
                : fmtNum(total) + ' missed of ' + fmtNum(offeredTotal) + ' offered'
                    + (offeredTotal > 0 ? ' (' + ((total / offeredTotal) * 100).toFixed(1) + '%)' : '')),
            h('span', {className: 'ops-heat-legend'},
                'Less',
                ...[0, 1, 2, 3, 4, 5].map(level => h('i', {key: level, className: 'ops-heat-swatch ops-heat-l' + level})),
                'More'
            )
        )
    );
}

export { WeekHourHeatmap };
