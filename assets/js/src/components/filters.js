/* The global filter bar and the call-type toggles.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { DateRangePicker } from './date-range-picker.js';
import { api } from '../lib/api.js';
import { h, useEffect, useState } from '../lib/react.js';
import { today } from '../lib/time.js';
import {
  MAX_RANGE_DAYS,
  addDays,
  daysSpan,
  monthStart,
  quarterStart,
  shiftMonths,
  weekStart,
  yearStart
} from '../lib/date-range.js';

function CallTypeFilters({callTypes,setCallTypes}) {

    const toggle = type => {

        setCallTypes(prev => ({
            ...prev,
            [type]: !prev[type]
        }));

    };

    const selectAll = () => {

        setCallTypes({
            inbound: true,
            outbound: true,
            missed: true,
            onnet: true
        });

    };

    const unselectAll = () => {

        setCallTypes({
            inbound: false,
            outbound: false,
            missed: false,
            onnet: false
        });

    };

    /*
     * Each type carries its own tint so an active pill reads as that
     * call type, matching the colours used across the charts.
     */
    const items = [
        ['inbound',  'Inbound',  '#35D0A0'],
        ['outbound', 'Outbound', '#7C93F8'],
        ['missed',   'Missed',   '#F0555A'],
        ['onnet',    'On-net',   '#B98CE0']
    ];

    return h(
        'div',
        {
            className:
                'flex flex-wrap items-center gap-2 border-b border-slate-700 bg-slate-900 px-3 py-2'
        },

        h(
            'span',
            {
                className:
                    'text-[10px] uppercase tracking-wide text-slate-500 mr-1'
            },
            'Call types'
        ),

        /*
         * Pill toggles instead of checkboxes: the active state is legible
         * at a glance from the fill, not a 13px tick box.
         */
        ...items.map(
            ([key,label,tint]) => {

                const on = !!callTypes[key];

                return h(
                    'button',
                    {
                        key: key,
                        type: 'button',
                        role: 'switch',
                        'aria-checked': on ? 'true' : 'false',
                        'aria-label': label + ' calls',
                        title: (on ? 'Hide ' : 'Show ') + label.toLowerCase() + ' calls',
                        onClick: () => toggle(key),
                        style: { '--ctf-tint': tint },
                        className: 'ctf-pill' + (on ? ' is-on' : '')
                    },

                    h('span', {className: 'ctf-dot', 'aria-hidden': 'true'}, on ? '\u2713' : ''),

                    label
                );
            }
        ),

        h(
            'span',
            {
                className:
                    'mx-1 h-4 w-px bg-slate-700'
            }
        ),

        h(
            'button',
            {
                type: 'button',

                onClick: selectAll,

                className:
                    'text-[11px] text-cyan-400 hover:text-cyan-300'
            },
            'Select all'
        ),

        h(
            'button',
            {
                type: 'button',

                onClick: unselectAll,

                className:
                    'text-[11px] text-slate-500 hover:text-slate-300'
            },
            'Unselect all'
        )
    );
}

/* Older API responses can contain numbers for numeric PHP array keys. */
function filterOptions(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .sort((a, b) => a.localeCompare(b));
}

function Filters({filters,setFilters,role,rangeLocked,maxRangeDays}) {
  const [departments,setDepartments] = useState([]);
  const [sites,setSites] = useState([]);
  const [hoursConfigured,setHoursConfigured] = useState(false);
  const [loadingDepartments,setLoadingDepartments] = useState(false);

  useEffect(() => {
    if (role !== 'office_manager') {
      return;
    }

    let active = true;

    setLoadingDepartments(true);

    api('filters')
      .then(r => {
        if (!active) return;

        setDepartments(
          filterOptions(r.departments)
        );

        setSites(
          filterOptions(r.sites)
        );

        /*
         * The hours scope is only offered when a calendar exists: an "Opening
         * hours" option that silently returns everything would be worse than no
         * option at all. `configured` is the server's own answer.
         */
        setHoursConfigured(
          !!(r.businessHours && r.businessHours.configured)
        );
      })
      .catch(() => {
        if (active) {
          setDepartments([]);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingDepartments(false);
        }
      });

    return () => {
      active = false;
    };
  }, [role]);

  const range = (label,start,end) =>
    h(
      'button',
      {
        key: label,

        onClick: () =>
          setFilters({
            ...filters,
            start,
            end
          }),

        className:
          'border border-slate-700 px-2 py-1 text-[11px] hover:border-cyan-500'
      },
      label
    );

  /*
   * Every preset boundary is calendar arithmetic on today's Eastern date (F2).
   * See lib/date-range.js: building these as Date objects from the browser's
   * local midnight and labelling them with the app's formatter is how "This
   * month" ends up asking for the last day of the previous month.
   */
  const yesterday = addDays(today, -1);

  const wk = weekStart(today);
  const lastWk = addDays(wk, -7);
  const lastWkEnd = addDays(wk, -1);

  const thisMonth = monthStart(today);
  const lastMonth = shiftMonths(thisMonth, -1);
  const lastMonthEnd = addDays(thisMonth, -1);

/*
 * F2 presets. Quarter-to-date and year-to-date start on the calendar boundary;
 * "Last 90 days" is a rolling window, which is what a trend question actually
 * means. Each is clamped to the role's span cap the same way a calendar pick is
 * (see maxRangeDaysFor) so a preset can never ask for a range the API refuses.
 */
const spanCap = Number(maxRangeDays) > 0 ? Number(maxRangeDays) : MAX_RANGE_DAYS;
const last90Start = addDays(today, -89);
const qtdStart = quarterStart(today);
const ytdStart = yearStart(today);
/*
 * A preset is offered only when its WHOLE span fits the role's cap. A "Last 90
 * days" button that quietly means 31 days is worse than no button: the label is
 * the range. Quarter-to-date on 5 October genuinely is five days, so it is
 * offered whenever the calendar boundary is the real start.
 */
const fits = start => daysSpan(start, today) <= spanCap;

  return h(
    'div',
    {
      className:
        'filters-bar flex flex-wrap items-center gap-2 border-b border-slate-700 bg-slate-900 px-3 py-2'
    },

    h(
      'span',
      {
        className:
          'text-[10px] uppercase tracking-wide text-slate-500'
      },
      'Range'
    ),

    h(
		DateRangePicker,
		{
			start: filters.start,
			end: filters.end,
			disabled: !!rangeLocked,
			onChange: (start, end) =>
				setFilters({
					...filters,
					start,
					end
				})
		}
	),

    range(
      'Today',
      today,
      today
    ),

    range(
      'Yesterday',
      yesterday,
      yesterday
    ),

    range(
      'This week',
      wk,
      today
    ),

    range(
      'Last week',
      lastWk,
      lastWkEnd
    ),

	range(
	  'This month',
	  thisMonth,
	  today
	),

	range(
	  'Last month',
	  lastMonth,
	  lastMonthEnd
	),

    fits(last90Start) &&
      range('Last 90 days', last90Start, today),

    fits(qtdStart) && range('Quarter to date', qtdStart, today),

    fits(ytdStart) && range('Year to date', ytdStart, today),

    role === 'office_manager' &&
      h(
        'select',
        {
          value: filters.department || '',

          disabled: loadingDepartments,

          onChange: e =>
            setFilters({
              ...filters,
              department: e.target.value
            }),

          className:
            'ml-auto border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400 disabled:opacity-60'
        },

        h(
          'option',
          {
            value: ''
          },
          'All Departments'
        ),

        ...departments
          .map(department =>
            h(
              'option',
              {
                key: department,
                value: department
              },
              department
            )
          )
      ),

    /*
     * SITE (the review's F4). The server has scoped reports by site all along
     * (authorizedFilters + callSite), and app-shell already carries the value —
     * there was simply no control to set it, so a multi-site tenant could not
     * ask "how did the Albany office do?".
     *
     * Manager-only, because it is the only role that is offered more than one
     * site to choose from: api/filters.php returns the whole directory's sites
     * to a manager and just the viewer's own site to anyone else, and a
     * one-option dropdown whose two entries mean the same thing is worse than
     * no dropdown.
     */
    role === 'office_manager' && sites.length > 0 &&
      h(
        'select',
        {
          value: filters.site || '',
          disabled: loadingDepartments,
          onChange: e =>
            setFilters({
              ...filters,
              site: e.target.value
            }),
          className:
            'border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400 disabled:opacity-60',
          title: 'Restrict every report to one site'
        },
        h('option', { value: '' }, 'All Sites'),
        ...sites
          .map(site => h('option', { key: site, value: site }, site))
      ),

    /*
     * OPENING HOURS (Sprint A). Only shown once a calendar is configured, and
     * it defaults to the server's own default (`business`), so a manager who
     * turns opening hours on sees published numbers by default while the
     * after-hours view stays one click away.
     */
    hoursConfigured &&
      h(
        'select',
        {
          value: filters.hours || 'business',
          onChange: e =>
            setFilters({
              ...filters,
              hours: e.target.value
            }),
          className:
            'border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400',
          title: 'Opening hours were set in Settings: choose which calls to count'
        },
        h('option', { value: 'business' }, 'Opening hours'),
        h('option', { value: 'after' }, 'After hours'),
        h('option', { value: 'all' }, 'All hours')
      ),

    /*
     * SENTIMENT (Sprint B): the call-intelligence fields were rendered only on
     * the live Queues donut, so "who was unhappy this week" could not be asked
     * of a period. Negative means the call's negative share beats its positive
     * share and the call was scored at all - see callIsNegative().
     */
    h(
      'select',
      {
        value: filters.sentiment || '',
        onChange: e =>
          setFilters({
            ...filters,
            sentiment: e.target.value
          }),
        className:
          'border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400',
        title: 'Scope every figure to calls whose sentiment came out one way'
      },
      h('option', { value: '' }, 'Any sentiment'),
      h('option', { value: 'negative' }, 'Negative only'),
      h('option', { value: 'positive' }, 'Positive only')
    ),

    /*
     * OUTCOME (Sprint A): the canonical vocabulary, so "show me only the
     * abandons" does not require reading a column and guessing.
     */
    h(
      'select',
      {
        value: filters.outcome || '',
        onChange: e =>
          setFilters({
            ...filters,
            outcome: e.target.value
          }),
        className:
          'border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:border-cyan-400',
        title: 'Filter by how the call ended'
      },
      h('option', { value: '' }, 'Any outcome'),
      h('option', { value: 'answered' }, 'Answered'),
      h('option', { value: 'abandoned' }, 'Abandoned'),
      h('option', { value: 'voicemail' }, 'Voicemail'),
      h('option', { value: 'noanswer' }, 'No answer')
    )
  );
}

export { CallTypeFilters, Filters };
