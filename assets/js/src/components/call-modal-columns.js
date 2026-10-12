/* The drill-down table's columns (QA-11).
 *
 * These 330 lines lived inside CallModal, which is where the P7 regressions
 * hid (a formatter returning a raw string, a dropped field). They now sit in
 * one function that receives exactly what they read: the SLA window the screen
 * used, the ref that marks the row being played, and the two callbacks the Rec
 * and SIP-flow buttons fire. tests/js/smoke.mjs asserts the built table's
 * column titles, fields and formatters.
 */
import { fmt, formatPhoneNumber } from '../lib/format.js';
import { slaRingHtml } from '../lib/sla.js';
import { formatCallDate, formatCallTime } from '../lib/time.js';

/*
 * SEC-9: Tabulator applies a string formatter result with
 * `element.innerHTML = val`, so a formatter that echoes CDR text would parse
 * it as HTML. Caller-ID names are attacker-influenced, so every text
 * formatter returns a Text node instead — Tabulator appends Nodes safely.
 */
const asText = value =>
    document.createTextNode(
        String(
            value == null
                ? ''
                : value
        )
    );

function buildCallColumns({slaSeconds, playingRef, onPlay, onFlow}) {
    return [

        /*
         * DATE
         */

        {
            title:
                'Date',

            field:
                'startedAt',

            minWidth:
                85,

            formatter: cell => {
                const v = cell.getValue();
                const formatted = formatCallDate(v);
                return formatted || '';
            }
        },


        /*
         * TIME
         */

        {
            title:
                'Time',

            field:
                'startedAt',

            minWidth:
                85,

            formatter: cell => {
                const formatted = formatCallTime(cell.getValue());
                return formatted || '';
            }
        },


        /*
         * TYPE
         */

        {
            title:
                'Type',

            field:
                'type',

            minWidth:
                52,

            hozAlign:
                'center',

            headerHozAlign:
                'center',

            formatter: cell => {
                const t = String(cell.getValue() || '').toLowerCase();
                const phone = 'M1.885.511a1.745 1.745 0 0 1 2.612.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.678.678 0 0 0 .178.643l2.457 2.457a.678.678 0 0 0 .644.178l2.189-.547a1.745 1.745 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.634 18.634 0 0 1-7.01-4.42 18.634 18.634 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877L1.885.511z';
                const inboundArrow = 'M15.854.146a.5.5 0 0 1 0 .708L11.707 5H14.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 1 0v2.793L15.146.146a.5.5 0 0 1 .708 0z';
                const outboundArrow = 'M11.5 1a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2.707l-4.146 4.147a.5.5 0 0 1-.708-.708L14.293 2H12a.5.5 0 0 1-.5-.5z';
                const missed = 'M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.57 17.57 0 0 0 4.168 6.608 17.57 17.57 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328zM13.78.22a.75.75 0 0 1 0 1.06L4.28 10.78a.75.75 0 1 1-1.06-1.06L12.72.22a.75.75 0 0 1 1.06 0z';
                let color = '#94a3b8';
                let label = String(cell.getValue() || '');
                let paths = [phone];
                if (t === 'inbound' || t === 'incoming') {
                    color = '#38bdf8';
                    label = 'Inbound';
                    paths = [phone, inboundArrow];
                } else if (t === 'outbound' || t === 'outgoing') {
                    color = '#34d399';
                    label = 'Outbound';
                    paths = [phone, outboundArrow];
                } else if (t === 'missed') {
                    color = '#f87171';
                    label = 'Missed';
                    paths = [missed];
                } else if (t === 'onnet') {
                    color = '#a78bfa';
                    label = 'On-net';
                    paths = [phone];
                }
                const wrap = document.createElement('span');
                wrap.title = label;
                wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:100%;color:' + color;
                /* SVG namespace, and setAttribute for path data, so no
                 * markup is ever parsed from a string (SEC-9). */
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '16');
                svg.setAttribute('height', '16');
                svg.setAttribute('viewBox', '0 0 16 16');
                svg.setAttribute('fill', 'currentColor');
                svg.setAttribute('aria-hidden', 'true');
                paths.forEach(d => {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', d);
                    svg.appendChild(path);
                });
                wrap.appendChild(svg);
                return wrap;
            }
        },


        /*
         * FROM NAME
         */

        {
            title:
                'From Name',

            field:
                'from',

            minWidth:
                120,

            formatter:
                cell =>
                    asText(
                        cell.getValue()
                    )
        },


        /*
         * FROM
         */

        {
            title:
                'From',

            field:
                'fromNumber',

            minWidth:
                100,

            formatter:
                cell =>
                    asText(
                        formatPhoneNumber(
                            cell.getValue()
                        )
                    )
        },


        /*
         * DIALED
         */

        {
            title:
                'Dialed',

            field:
                'dialed',

            minWidth:
                100,

            formatter:
                cell =>
                    asText(
                        formatPhoneNumber(
                            cell.getValue()
                        )
                    )
        },


        /*
         * TO
         */

        {
            title:
                'To',

            field:
                'to',

            minWidth:
                90,

            formatter:
                cell =>
                    asText(
                        formatPhoneNumber(
                            cell.getValue()
                        )
                    )
        },


        {
            title: 'Talk',
            field: 'talking',
            minWidth: 70,
            formatter: cell => fmt(cell.getValue())
        },
        {
            title: 'Ring',
            field: 'ringing',
            minWidth: 70,
            formatter: cell => slaRingHtml(cell.getValue(), slaSeconds)
        },
        {
            title: 'Reason',
            field: 'disconnectReason',
            minWidth: 140,
            formatter: cell => asText(cell.getValue())
        },

        /*
         * TOTAL
         */

        {
            title:
                'Total',

            field:
                'total',

            minWidth:
                80,

            formatter:
                cell =>
                    fmt(
                        cell.getValue()
                    )
        },


        /*
         * CALLBACK
         *
         * Whether this missed call was returned, in the same words the
         * Follow-ups card counts it in. The answer comes from the server
         * (`callback`) because it needs the whole scoped row set — the return
         * leg is a different call row, and a modal narrowed to one agent, one
         * hour or one type cannot see it and would call a returned miss
         * "not returned".
         *
         * The column exists because the card is only a count: opening the
         * calls behind "2 missed calls not returned" used to show a table with
         * nothing in it that said why the row was there, so the list could not
         * be checked against the number. A null (not a missed call) prints a
         * dash rather than "not returned" — an answered call was not ignored,
         * and the outbound leg IS the return call.
         */
        {
            title:
                'Callback',

            field:
                'callback',

            minWidth:
                104,

            formatter:
                cell => {
                    const value = cell.getValue();
                    const badge = document.createElement('span');
                    if (value !== true && value !== false) {
                        badge.className = 'cm-callback is-na';
                        badge.textContent = '—';
                        badge.title = 'Only a missed call can be left unreturned';
                        return badge;
                    }
                    badge.className = 'cm-callback ' + (value ? 'is-yes' : 'is-no');
                    badge.textContent = value ? 'Returned' : 'Not returned';
                    badge.title = value
                        ? 'An outbound call to this customer number followed the miss'
                        : 'No outbound call to this customer number after the miss';
                    return badge;
                }
        },


        /*
         * RECORDING
         *
         * The cell knows only whether the CDR points at a
         * recording (hasRecordingHint, decided server-side by
         * callHasRecordingHint()). Clicking resolves it —
         * api/recording.php walks every PBX server, so the
         * table never pays for that unless asked — and the
         * player opens in the tray under the table.
         */

        {
            title:
                'Rec',

            field:
                'hasRecordingHint',

            minWidth:
                58,

            hozAlign:
                'center',

            headerHozAlign:
                'center',

            formatter: cell => {
                const row = cell.getRow().getData() || {};
                const has = !!row.hasRecordingHint;
                const id = String(row.id || row.origCallId || '');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cm-attach-btn' +
                    (has ? '' : ' is-off') +
                    (has && playingRef.current === id ? ' is-on' : '');
                btn.disabled = !has;
                btn.title = has
                    ? 'Play the recording of this call'
                    : 'No recording was stored for this call';
                btn.setAttribute('aria-label', has ? 'Play recording' : 'No recording available');
                btn.textContent = has ? '▶' : '—';
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    if (has) onPlay(row);
                });
                return btn;
            }
        },


        /*
         * SIP FLOW
         *
         * Opens the same cradle-to-grave dialog Call history
         * uses (components/call-flow-dialog.js) for this call.
         */

        {
            title:
                'SIP flow',

            field:
                'hasFlowHint',

            minWidth:
                72,

            hozAlign:
                'center',

            headerHozAlign:
                'center',

            formatter: cell => {
                const row = cell.getRow().getData() || {};
                const has = !!row.hasFlowHint;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cm-attach-btn' + (has ? '' : ' is-off');
                btn.disabled = !has;
                btn.title = has
                    ? 'Open the cradle-to-grave SIP flow for this call'
                    : 'No SIP trace was recorded for this call';
                btn.setAttribute('aria-label', has ? 'Open SIP flow' : 'No SIP flow available');
                btn.textContent = has ? 'Flow' : '—';
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    if (has) onFlow(row);
                });
                return btn;
            }
        }
    ];
}

export { buildCallColumns };
