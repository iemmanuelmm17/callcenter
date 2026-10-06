/* Auto-attendant list plus the calls sheet.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { NavIcon, skel } from './ui.js';
import { fmt } from '../lib/format.js';
import { h, keyActivate, useEffect, useEscape, useRef, useState } from '../lib/react.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';

function AutoAttendants({
    filters,
    items,
    listLoading,
    selectedAutoAttendants,
    onAutoAttendantsChange
}) {

    const [autoAttendants, setAutoAttendants] =
        useState([]);

    const [term, setTerm] =
        useState('');

    const [selected, setSelected] =
        useState(
            Array.isArray(selectedAutoAttendants)
                ? selectedAutoAttendants
                : []
        );

    const [loading, setLoading] =
        useState(true);

    const [collapsed, setCollapsed] =
        useState(false);


    /*
     * =========================================================
     * SYNC SELECTION
     * =========================================================
     */

    useEffect(() => {

        setSelected(
            Array.isArray(selectedAutoAttendants)
                ? selectedAutoAttendants
                : []
        );

    }, [
        selectedAutoAttendants
    ]);


    /*
     * =========================================================
     * LOAD AUTO ATTENDANTS
     * =========================================================
     */

    useEffect(() => {
        if (!Array.isArray(items)) return;
        setAutoAttendants(items);
        setLoading(false);
    }, [items]);


    /*
     * =========================================================
     * CALL COUNT
     * =========================================================
     */

    const getCallCount = aa => {

        if (
            aa.totalCalls !== undefined &&
            aa.totalCalls !== null
        ) {
            return Number(
                aa.totalCalls
            ) || 0;
        }

        return 0;
    };


    /*
     * =========================================================
     * ADDITIONAL TIER COUNT
     * =========================================================
     */

    const getAdditionalCount = aa => {

        if (
            aa.additionalTierCalls !== undefined &&
            aa.additionalTierCalls !== null
        ) {
            return Number(
                aa.additionalTierCalls
            ) || 0;
        }

        return 0;
    };


    /*
     * =========================================================
     * SEARCH
     * =========================================================
     */

    const searchTerm =
        term
            .trim()
            .toLowerCase();

    const visible =
        autoAttendants.filter(
            aa => {

                const value =
                    String(
                        aa.name || ''
                    ) +
                    ' ' +
                    String(
                        aa.extension || ''
                    );

                return value
                    .toLowerCase()
                    .includes(
                        searchTerm
                    );
            }
        ).slice().sort((a, b) => getCallCount(b) - getCallCount(a));


    /*
     * =========================================================
     * SELECTION
     * =========================================================
     */

    const audioRef = useRef(null);
    const [playingExt, setPlayingExt] = useState('');

    const applySelection = ids => {
		setSelected(ids);

		if (onAutoAttendantsChange) {
			onAutoAttendantsChange(ids);
		}
	};

    const selectAutoAttendant = extension => {
        applySelection([String(extension)]);
    };

    const playGreeting = (event, aa) => {
        event.stopPropagation();
        event.preventDefault();

        const url = String(aa.audioUrl || '').trim();
        if (!url) {
            return;
        }

        const ext = String(aa.extension);

        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        if (playingExt === ext) {
            setPlayingExt('');
            return;
        }

        const audio = new Audio(url);
        audioRef.current = audio;
        setPlayingExt(ext);
        audio.play().catch(() => setPlayingExt(''));
        audio.onended = () => {
            if (audioRef.current === audio) {
                audioRef.current = null;
            }
            setPlayingExt('');
        };
        audio.onerror = () => {
            setPlayingExt('');
        };
    };

    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);


    /*
     * =========================================================
     * RENDER
     * =========================================================
     */

    return h(
        'aside',
        {
            className:
                'aa-side ' + (collapsed ? 'is-collapsed' : '')
        },

        h(
            'div',
            {
                className: 'aa-side-head'
            },
            collapsed ? null : h('h2', {className: 'font-semibold text-slate-200'}, 'Auto Attendants'),
            h('button', {
                type: 'button',
                title: collapsed ? 'Expand attendants' : 'Collapse attendants',
                onClick: () => setCollapsed(c => !c),
                className: 'aa-side-toggle'
            }, collapsed ? '›' : '‹')
        ),

        collapsed ? null : h(
            'input',
            {
                value: term,
                onChange: e => setTerm(e.target.value),
                placeholder: 'Find AA or extension…',
                className: 'aa-side-search'
            }
        ),


        (listLoading || loading)

            ?

            /*
             * LOADING
             */

            h(
                'div',
                {
                    className:
                        'space-y-1 pt-2'
                },

                ...Array.from({length: 8}, (_, i) =>
                    h('div', {
                        key: i,
                        className: 'grid grid-cols-[20px_1fr_auto] items-center gap-2 border-b border-slate-800 py-3'
                    },
                        skel('h-3 w-3'),
                        h('div', {className: 'space-y-1'},
                            skel('h-2.5 w-28'),
                            skel('h-2 w-16')
                        ),
                        skel('h-2.5 w-8')
                    )
                )
            )


            :

            /*
             * RESULTS
             */

            h(
                'div',
                {
                    className:
                        'aa-side-list'
                },

                visible.length === 0

                    ?

                    h(
                        'div',
                        {
                            className:
                                'py-8 text-center text-xs text-slate-500'
                        },
                        'No Auto Attendants found.'
                    )

                    :

                    /*
                     * IMPORTANT:
                     * The spread is INSIDE h().
                     * Do not put ...visible.map()
                     * directly inside the ternary.
                     */

                    h(
                        'div',
                        null,

                        ...visible.map(
                            aa => {

                                const extension =
                                    String(
                                        aa.extension
                                    );

                                const calls =
                                    getCallCount(
                                        aa
                                    );

                                const additional =
                                    getAdditionalCount(
                                        aa
                                    );

                                const isSelected =
                                    selected.includes(extension);

                                const audioUrl =
                                    String(aa.audioUrl || '').trim();

                                const isPlaying =
                                    playingExt === extension;

                                return h(
                                    'div',
                                    {
                                        key:
                                            extension,

                                        role:
                                            'button',

                                        tabIndex:
                                            0,

                                        onClick: () =>
                                            selectAutoAttendant(extension),

                                        onKeyDown:
                                            keyActivate(() => selectAutoAttendant(extension)),

                                        className:
                                            'aa-side-item ' + (isSelected ? 'is-active' : '')
                                    },

                                    collapsed
                                        ? h('div', {className:'aa-side-glyph', title: (aa.name || extension)},
                                            String(aa.name || extension).slice(0, 1).toUpperCase())
                                        : h('div', {className:'aa-side-row'},
                                            h('button', {
                                                type: 'button',
                                                title: audioUrl
                                                    ? (isPlaying ? 'Stop greeting' : 'Play greeting')
                                                    : 'No greeting audio',
                                                disabled: !audioUrl,
                                                onClick: e => playGreeting(e, aa),
                                                className:
                                                    'aa-side-play' + (isPlaying ? ' is-on' : '')
                                            },
                                                h(NavIcon, {name: isPlaying ? 'stop' : 'play', size: 14, className: ''})
                                            ),
                                            h('div', {className:'min-w-0 flex-1'},
                                                h('div', {className:'truncate text-sm font-medium text-slate-100'}, aa.name || extension),
                                                h('div', {className:'truncate text-[11px] text-slate-500'},
                                                    extension + ' · ' + String(calls) + ' calls')
                                            )
                                        )
                                );
                            }
                        )
                    )
            )
    );
}

function AaCallsSheet({title, rows, onClose}) {
  useEscape(true, onClose);
  const list = Array.isArray(rows) ? rows : [];
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    setPage(1);
  }, [rows, pageSize]);

  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(page, pages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const slice = list.slice(start, end);

  const fmtPhone = input => {
    const digits = String(input || '').replace(/\D/g, '');
    if (digits.length === 10) return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
    if (digits.length === 11 && digits.startsWith('1')) return '(' + digits.slice(1,4) + ') ' + digits.slice(4,7) + '-' + digits.slice(7);
    return input || '—';
  };

  const sheet = h('div', {
    className: 'aa-call-sheet fixed inset-0 p-5 cursor-default',
    role: 'presentation',
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2147483646,
      background: 'color-mix(in srgb, var(--color-slate-950) 85%, transparent)'
    },
    onClick: onClose
  },
    h('div', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Call details',
      className: 'call-modal cursor-default flex w-full max-w-[1100px] flex-col overflow-hidden border border-slate-700 bg-slate-950 shadow-2xl',
      style: {maxHeight: '88vh', display: 'flex', flexDirection: 'column'},
      onClick: e => e.stopPropagation()
    },
      h('div', {className: 'flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3'},
        h('div', null,
          h('div', {className: 'text-sm font-semibold text-slate-100'}, title || 'Calls'),
          h('div', {className: 'text-[11px] text-slate-500'}, total.toLocaleString() + ' related calls')
        ),
        h('button', {type: 'button', onClick: onClose, className: 'text-2xl font-light leading-none text-slate-500 hover:text-slate-200'}, '×')
      ),
      h('div', {className: 'min-h-0 flex-1 overflow-auto'},
        total === 0
          ? h('div', {className: 'grid h-40 place-items-center text-xs text-slate-500'}, 'No matching calls.')
          : h('table', {className: 'w-full text-xs'},
              h('thead', {className: 'sticky top-0 z-10 border-b border-slate-800 bg-slate-900 text-left text-[10px] uppercase text-slate-500'},
                h('tr', null,
                  ...['Time', 'Caller', 'Digit', 'Destination', 'Outcome', 'Talk'].map(lab =>
                    h('th', {key: lab, className: 'px-3 py-2'}, lab))
                )
              ),
              h('tbody', null,
                ...slice.map((c, i) => h('tr', {key: String(c.id || start + i), className: 'border-b border-slate-800'},
                  h('td', {className: 'whitespace-nowrap px-3 py-2 text-slate-400'},
                    ((formatCallDate(c.start || c.startedAt) + ' ' + formatCallTime(c.start || c.startedAt)).trim()) || '—'),
                  h('td', {className: 'px-3 py-2 text-slate-300'}, fmtPhone(c.caller || c.origCaller)),
                  h('td', {className: 'px-3 py-2 font-mono text-cyan-300'}, c.case || c.additionalCase || '—'),
                  h('td', {className: 'px-3 py-2 text-slate-300'}, c.destination || c.queue || '—'),
                  h('td', {className: 'px-3 py-2 text-slate-400'}, c.disconnectReason || '—'),
                  h('td', {className: 'px-3 py-2 font-mono text-slate-400'}, fmt(c.talkSeconds || 0))
                ))
              )
            )
      ),
      total === 0 ? null : h('div', {
        className: 'flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400'
      },
        h('div', {className: 'flex items-center gap-2'},
          'Rows per page:',
          h('select', {
            value: pageSize,
            onChange: e => { setPageSize(Number(e.target.value)); setPage(1); },
            className: 'cursor-pointer rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200'
          },
            h('option', {value: 10}, '10'),
            h('option', {value: 25}, '25'),
            h('option', {value: 50}, '50'),
            h('option', {value: 100}, '100')
          ),
          h('span', {className: 'text-slate-500'},
            'Showing ' + (start + 1) + '–' + end + ' of ' + total.toLocaleString())
        ),
        h('div', {className: 'flex items-center gap-1'},
          h('button', {
            type: 'button',
            disabled: safePage <= 1,
            onClick: () => setPage(p => Math.max(1, p - 1)),
            className: 'cursor-pointer rounded border border-slate-700 bg-slate-950 px-3 py-1 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
          }, 'Prev'),
          h('span', {className: 'px-2 text-slate-300'}, 'Page ' + safePage + ' of ' + pages),
          h('button', {
            type: 'button',
            disabled: safePage >= pages,
            onClick: () => setPage(p => Math.min(pages, p + 1)),
            className: 'cursor-pointer rounded border border-slate-700 bg-slate-950 px-3 py-1 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
          }, 'Next')
        )
      )
    )
  );

  return ReactDOM.createPortal(sheet, document.body);
}

export { AaCallsSheet, AutoAttendants };
