/*
 * The service-desk settings: opening hours, per-queue service targets and the
 * roster.
 *
 * These are the three settings the manager review asked for that decide what a
 * number MEANS rather than how it is coloured:
 *
 *   - opening hours, without which a 02:00 abandon counts as a service failure
 *     on a desk that closed at 18:00;
 *   - a target per queue, because a sales queue staffed for 15 seconds and a
 *     support queue staffed for 45 cannot share one number;
 *   - the roster, which is the only way occupancy (talk time / scheduled time)
 *     can be computed at all — the CDR alone cannot tell an underworked agent
 *     from a short shift.
 *
 * All three are stored in the domain settings the server already validates
 * (includes/reporting/settings.php), and this component is a controlled editor:
 * it holds no state of its own, so the Settings dialog owns the payload and
 * cannot save something different from what is on screen.
 *
 * Role rule (QA-5): supervisors may read all of this, only an office manager
 * may change it — `canSave` is the only thing that enables the inputs, and the
 * server enforces the same rule.
 */

import { h } from '../lib/react.js';

/* ISO-8601 weekday numbers, the same ones settings.php stores. */
const DAYS = [
  [1, 'Monday', 'Mon'],
  [2, 'Tuesday', 'Tue'],
  [3, 'Wednesday', 'Wed'],
  [4, 'Thursday', 'Thu'],
  [5, 'Friday', 'Fri'],
  [6, 'Saturday', 'Sat'],
  [7, 'Sunday', 'Sun']
];

/* 08:00-18:00 Monday to Friday, weekends closed: the review's own answer, and
 * the grid the server ships as its default. */
function defaultBusinessHours() {
  const days = {};
  for (const [n] of DAYS) {
    days[n] = n <= 5
      ? { closed: false, open: '08:00', close: '18:00' }
      : { closed: true, open: '', close: '' };
  }
  return { enabled: false, days, holidays: [] };
}

/** The stored calendar, with all seven days present however partial the data. */
function normalizeHours(stored) {
  const base = defaultBusinessHours();
  if (!stored || typeof stored !== 'object') return base;
  const days = { ...base.days };
  const storedDays = stored.days || {};
  for (const [n] of DAYS) {
    const day = storedDays[n] || storedDays[String(n)];
    if (day && typeof day === 'object') {
      days[n] = {
        closed: !!day.closed,
        open: typeof day.open === 'string' ? day.open : '',
        close: typeof day.close === 'string' ? day.close : ''
      };
    }
  }
  return {
    enabled: !!stored.enabled,
    days,
    holidays: Array.isArray(stored.holidays) ? stored.holidays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : []
  };
}

/** At least one day open with both times set — what the server requires to enable. */
function hoursHaveOpenDay(hours) {
  return DAYS.some(([n]) => {
    const day = hours.days[n];
    return day && !day.closed && day.open && day.close;
  });
}

function ServiceSettings({value, onChange, canSave, agents, queues}) {
  const hours = normalizeHours(value && value.businessHours);
  const queueSla = (value && value.queueSla) || {};
  const roster = Array.isArray(value && value.roster) ? value.roster : [];

  const patch = next => onChange({
    businessHours: hours,
    queueSla,
    roster,
    ...next
  });

  const setDay = (n, changes) => {
    const next = { ...hours.days, [n]: { ...hours.days[n], ...changes } };
    patch({ businessHours: { ...hours, days: next } });
  };

  const setTarget = (queueId, seconds) => {
    const next = { ...queueSla };
    if (seconds === '' || seconds === null) delete next[queueId];
    else next[queueId] = Math.max(1, Math.min(120, Number(seconds) || 0));
    patch({ queueSla: next });
  };

  const setRosterRow = (index, changes) => {
    const next = roster.map((row, i) => (i === index ? { ...row, ...changes } : row));
    patch({ roster: next });
  };

  const addRosterRow = () => {
    const first = (agents && agents[0]) || {};
    patch({
      roster: roster.concat([{
        extension: first.extension || '',
        name: first.name || '',
        team: first.department || '',
        supervisor: '',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '17:00'
      }])
    });
  };

  const addHoliday = date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (hours.holidays.includes(date)) return;
    patch({ businessHours: { ...hours, holidays: hours.holidays.concat([date]).sort() } });
  };

  const input = 'set-input';
  const disabled = !canSave;

  /*
   * ---------------------------------------------------------------- hours card
   */
  const hoursWarning = hours.enabled && !hoursHaveOpenDay(hours)
    ? h('div', { className: 'set-warn' },
        'At least one day must be open before opening hours can be switched on. ' +
        'The server refuses this on purpose: an enabled calendar with every day ' +
        'closed would report zero calls.')
    : null;

  const hoursCard = h('div', { className: 'set-card' },
    h('div', { className: 'set-card-head' },
      h('label', { className: 'set-toggle' },
        h('input', {
          type: 'checkbox',
          checked: hours.enabled,
          disabled,
          onChange: e => patch({ businessHours: { ...hours, enabled: e.target.checked } })
        }),
        h('span', null, 'Opening hours')
      ),
      h('span', { className: 'set-hint' },
        hours.enabled
          ? 'Reports count opening-hours calls by default; the after-hours view is one click away.'
          : 'Off: every call counts, exactly as before this setting existed.')
    ),
    h('div', { className: 'set-days' },
      ...DAYS.map(([n, label, short]) => {
        const day = hours.days[n];
        const open = !day.closed && day.open && day.close;
        return h('div', { key: n, className: 'set-day' + (open ? ' is-open' : '') },
          h('span', { className: 'set-day-name', title: label }, short),
          h('label', { className: 'set-day-closed' },
            h('input', {
              type: 'checkbox',
              checked: !!day.closed,
              disabled,
              onChange: e => setDay(n, {
                closed: e.target.checked,
                open: e.target.checked ? '' : (day.open || '08:00'),
                close: e.target.checked ? '' : (day.close || '18:00')
              })
            }),
            'closed'
          ),
          h('input', {
            type: 'time',
            className: input,
            value: day.open || '',
            disabled: disabled || day.closed,
            'aria-label': label + ' opens',
            onChange: e => setDay(n, { open: e.target.value })
          }),
          h('span', { className: 'set-dash' }, '–'),
          h('input', {
            type: 'time',
            className: input,
            value: day.close || '',
            disabled: disabled || day.closed,
            'aria-label': label + ' closes',
            onChange: e => setDay(n, { close: e.target.value })
          })
        );
      })
    ),
    h('p', { className: 'set-note' },
      'A shift that closes before it opens (22:00 to 06:00) is read as crossing midnight. ' +
      'Calls are matched on their start time, in US/Eastern.'),
    h('div', { className: 'set-holidays' },
      h('span', { className: 'set-hint' }, 'Closed on'),
      ...(hours.holidays.length === 0
        ? [h('span', { className: 'set-hint' }, 'no holidays added')]
        : hours.holidays.map(date => h('span', { key: date, className: 'set-chip' },
            date,
            canSave
              ? h('button', {
                  type: 'button',
                  title: 'Remove ' + date,
                  onClick: () => patch({
                    businessHours: { ...hours, holidays: hours.holidays.filter(d => d !== date) }
                  })
                }, '×')
              : null
          ))),
      h('input', {
        type: 'date',
        className: input,
        disabled,
        'aria-label': 'Add a holiday',
        onChange: e => {
          addHoliday(e.target.value);
          e.target.value = '';
        }
      })
    ),
    hoursWarning
  );

  /*
   * -------------------------------------------------------------- targets card
   */
  /* Always an array: it is spread into the card, and a single element there
   * crashed the dialog for a tenant with no queues (caught by the smoke test). */
  const targetRows = (queues || []).length === 0
    ? [h('p', { key: 'none', className: 'set-note' }, 'No call queues were returned by the PBX.')]
    : (queues || []).map(queue => h('div', { key: queue.id, className: 'set-target-row' },
        h('span', { className: 'set-target-name', title: queue.id },
          queue.description,
          h('span', { className: 'set-hint' }, ' (' + queue.id + ')')
        ),
        h('input', {
          type: 'number',
          min: 1,
          max: 120,
          className: input,
          placeholder: 'default',
          value: queueSla[queue.id] === undefined ? '' : queueSla[queue.id],
          disabled,
          'aria-label': 'Service target for ' + queue.description + ' in seconds',
          onChange: e => setTarget(queue.id, e.target.value)
        }),
        h('span', { className: 'set-hint' }, 'seconds'),
        /*
         * Steppers, like every other number in this dialog: a one-second nudge
         * is how a target actually gets tuned, and typing into a numeric field
         * cannot be driven by the test harness.
         */
        h('span', { className: 'set-stepper' },
          h('button', {
            type: 'button',
            disabled,
            title: 'Increase ' + queue.description + ' target',
            'data-queue': queue.id,
            'data-step': 'up',
            onClick: () => setTarget(queue.id, (Number(queueSla[queue.id]) || 0) + 1)
          }, '▴'),
          h('button', {
            type: 'button',
            disabled,
            title: 'Decrease ' + queue.description + ' target',
            'data-queue': queue.id,
            'data-step': 'down',
            onClick: () => setTarget(queue.id, Math.max(1, (Number(queueSla[queue.id]) || 1) - 1))
          }, '▾')
        )
      ));

  const targetsCard = h('div', { className: 'set-card' },
    h('div', { className: 'set-card-head' },
      h('span', { className: null }, 'Service target per queue'),
      h('span', { className: 'set-hint' },
        'Blank uses the domain target above. Answered within this many seconds counts as in-SLA.')
    ),
    ...targetRows
  );

  /*
   * -------------------------------------------------------------- roster card
   */
  const agentOptions = (agents || []);
  const rosterCard = h('div', { className: 'set-card' },
    h('div', { className: 'set-card-head' },
      h('span', null, 'Roster'),
      h('span', { className: 'set-hint' },
        'Who is scheduled when. This is what makes occupancy and calls-per-hour possible: ' +
        'the call records alone cannot tell an underworked agent from a short shift.')
    ),
    roster.length === 0
      ? h('p', { className: 'set-note' }, 'No scheduled agents yet.')
      : h('div', { className: 'set-roster' },
          h('div', { className: 'set-roster-head' },
            h('span', null, 'Agent'),
            h('span', null, 'Days'),
            h('span', null, 'From'),
            h('span', null, 'To'),
            h('span', null, 'Team'),
            h('span', null, 'Supervisor'),
            h('span', null, '')
          ),
          ...roster.map((row, index) => h('div', { key: index, className: 'set-roster-row' },
            h('select', {
              className: input,
              value: row.extension || '',
              disabled,
              'aria-label': 'Roster agent ' + (index + 1),
              onChange: e => {
                const agent = agentOptions.find(a => a.extension === e.target.value) || {};
                setRosterRow(index, {
                  extension: e.target.value,
                  name: agent.name || row.name,
                  team: row.team || agent.department || ''
                });
              }
            },
              h('option', { value: '' }, 'select…'),
              ...agentOptions.map(a => h('option', { key: a.extension, value: a.extension },
                a.name ? a.name + ' (' + a.extension + ')' : a.extension))
            ),
            h('span', { className: 'set-weekdays' },
              ...DAYS.map(([n, , short]) => h('label', {
                key: n,
                className: (row.days || []).includes(n) ? 'is-on' : '',
                title: 'Works ' + short
              },
                h('input', {
                  type: 'checkbox',
                  checked: (row.days || []).includes(n),
                  disabled,
                  onChange: e => {
                    const set = new Set(row.days || []);
                    if (e.target.checked) set.add(n); else set.delete(n);
                    setRosterRow(index, { days: Array.from(set).sort((a, b) => a - b) });
                  }
                }),
                short[0]
              ))
            ),
            h('input', { type: 'time', className: input, value: row.start || '', disabled,
              onChange: e => setRosterRow(index, { start: e.target.value }) }),
            h('input', { type: 'time', className: input, value: row.end || '', disabled,
              onChange: e => setRosterRow(index, { end: e.target.value }) }),
            h('input', { type: 'text', className: input, value: row.team || '', disabled,
              placeholder: 'team', onChange: e => setRosterRow(index, { team: e.target.value }) }),
            h('input', { type: 'text', className: input, value: row.supervisor || '', disabled,
              placeholder: 'supervisor', onChange: e => setRosterRow(index, { supervisor: e.target.value }) }),
            canSave
              ? h('button', {
                  type: 'button',
                  className: 'set-remove',
                  title: 'Remove this row',
                  onClick: () => patch({ roster: roster.filter((_, i) => i !== index) })
                }, '×')
              : null
          ))
        ),
    canSave
      ? h('button', { type: 'button', className: 'set-add', onClick: addRosterRow }, '+ Add agent')
      : null
  );

  return h('div', { className: 'set-service' },
    h('h3', { className: 'set-section' }, 'Service desk'),
    hoursCard,
    targetsCard,
    rosterCard
  );
}

export { ServiceSettings, normalizeHours, defaultBusinessHours, hoursHaveOpenDay, DAYS };
