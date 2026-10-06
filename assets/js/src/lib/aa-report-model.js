/* The Auto-Attendant report's derived numbers (QA-11 split).
 *
 * Everything here is a pure function of the filtered call list: counts,
 * abandonment, the outcome buckets, the digit and destination breakdowns, and
 * the hourly peak. That is ~270 lines of closures that used to sit inside the
 * 1,698-line AutoAttendantReport component; as a module the arithmetic can be
 * reasoned about (and tested) without mounting the page.
 *
 * `calls` is already filtered by the selected attendants, so this function is
 * the single place the report's numbers come from.
 */
import {
    getCaller,
    getCase,
    getDestination,
    getDisconnectReason,
    getStart,
    getTotalSeconds,
    isAdditionalTier,
} from './aa-call-fields.js';
import { APP_TZ, parseCallInstant, tzParts } from '../lib/time.js';

function buildAaReportModel(calls) {

    /*
     * =========================================================
     * HELPERS
     * =========================================================
     */

    /*
     * Field readers (getCaller, getStart, ...) live in lib/aa-call-fields.js
     * so they can be unit-tested without rendering this page (QA-11).
     */

    /*
     * =========================================================
     * ADDITIONAL TIER
     * =========================================================
     */

    const additionalTierCalls =
        calls.filter(isAdditionalTier);

    /*
     * =========================================================
     * SUMMARY
     * =========================================================
     */

    const totalCalls = calls.length;

    const uniqueCallers =
        new Set(
            calls
                .map(getCaller)
                .map(x => String(x).trim())
                .filter(Boolean)
        ).size;

    const totalDurationSeconds =
        calls.reduce(
            (total, call) =>
                total +
                getTotalSeconds(call),
            0
        );

    const averageDurationSeconds =
        totalCalls
            ? totalDurationSeconds / totalCalls
            : 0;

    /*
     * =========================================================
     * ABANDONMENT
     * =========================================================
     *
     * One definition, shared with every other report
     * (includes/reporting/outcomes.php): the caller reached the attendant and
     * the call was never answered by a person.
     *
     * `api/aa.php` decides that and sends it as `call.abandoned`. The screen
     * used to re-derive it from the disconnect-reason text on top of the
     * backend flag (`caller hung up` AND never engaged), which is why the Auto
     * Attendant abandonment rate disagreed with the Dashboard, Agents, Queues
     * and Alerts screens for the same calls: calls the PBX released with a
     * different reason string, or that never produced one, were silently left
     * out here.
     *
     * The disconnect reason is still shown per call (and in the outcome
     * breakdown) — it explains a call, it no longer decides the number.
     */

    const isAbandoned = call => call.abandoned === true;

    const abandonedCalls = calls.filter(isAbandoned);
    const abandonedCount = abandonedCalls.length;

    const abandonmentRate =
        totalCalls
            ? (abandonedCount / totalCalls) * 100
            : 0;

    /*
     * =========================================================
     * OUTCOME
     * =========================================================
     */

    const outcomeMap = {};

    calls.forEach(call => {

        let reason =
            getDisconnectReason(call);

        if (!reason) {
            reason = 'Unknown';
        }

        let label = reason;

        if (/no digit/i.test(reason)) {
            label = 'No Digit';
        }
        else if (/no queue/i.test(reason)) {
            label = 'No Queue';
        }
        else if (/dtmf/i.test(reason)) {
            label = 'DTMF';
        }
        else if (/orig:\s*bye/i.test(reason)) {
            label = 'Caller Hangup';
        }

        if (call.abandoned === true) {
            label = 'Abandoned';
        }

        outcomeMap[label] =
            (outcomeMap[label] || 0) + 1;
    });

    const outcomeRows =
        Object.entries(outcomeMap)
            .map(
                ([outcome, count]) => ({
                    outcome,
                    count
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            );

    /*
     * =========================================================
     * DIGITS / CASE
     * =========================================================
     */

    const digitMap = {};

    calls.forEach(call => {

        const digit =
            getCase(call) || '-';

        if (!digitMap[digit]) {
            digitMap[digit] = {
                digit,
                calls: 0
            };
        }

        digitMap[digit].calls++;
    });

    const digitRows =
        Object.values(digitMap)
            .sort((a, b) => {

                if (a.digit === '-') {
                    return 1;
                }

                if (b.digit === '-') {
                    return -1;
                }

                return (
                    Number(a.digit) -
                    Number(b.digit)
                );
            });

    /*
     * =========================================================
     * DESTINATIONS
     * =========================================================
     */

    const destinationMap = {};

    calls.forEach(call => {

        const destination =
            getDestination(call) || '-';

        destinationMap[destination] =
            (destinationMap[destination] || 0) + 1;
    });

    const destinationRows =
        Object.entries(destinationMap)
            .map(
                ([destination, count]) => ({
                    destination,
                    count
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            )
            .slice(0, 10);

    /*
     * =========================================================
     * HOURLY
     * =========================================================
     */

    const hourCounts = Array.from({length: 24}, () => 0);

    calls.forEach(call => {
        const start = getStart(call);
        if (!start) return;
        const instant = parseCallInstant(start);
        if (!instant) return;
        const hour = Number(tzParts(instant, APP_TZ).hour);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
            hourCounts[hour]++;
        }
    });

    const hourlyRows = hourCounts.map((count, hour) => ({
        hour: String(hour).padStart(2, '0') + ':00',
        count
    }));

    /*
     * =========================================================
     * PEAK TRAFFIC
     * =========================================================
     *
     * Which hours actually carry the load, so staffing and trunk capacity
     * can be pointed at them. Ranked by volume; empty hours are dropped so
     * a quiet day cannot report "midnight" as a peak just because it sorts
     * first. Ties break toward the earlier hour, which keeps the label
     * stable between refreshes.
     */

    const peakHours = hourCounts
        .map((count, hour) => ({hour, count}))
        .filter(entry => entry.count > 0)
        .sort((a, b) => (b.count - a.count) || (a.hour - b.hour))
        .slice(0, 3);

    const peakHour = peakHours[0] || null;

    const formatHourLabel = hour => {
        const value = Number(hour);
        if (!Number.isInteger(value) || value < 0 || value > 23) return '-';
        if (value === 0) return '12 AM';
        if (value === 12) return '12 PM';
        return (value > 12 ? value - 12 : value) + (value >= 12 ? ' PM' : ' AM');
    };

    /* Calls landing inside any of the three peak hours. */
    const peakHourSet = new Set(peakHours.map(entry => entry.hour));

    const callsInPeakHours = () => calls.filter(call => {
        const start = getStart(call);
        if (!start) return false;
        const instant = parseCallInstant(start);
        if (!instant) return false;
        return peakHourSet.has(Number(tzParts(instant, APP_TZ).hour));
    });
    return {
        additionalTierCalls,
        totalCalls,
        uniqueCallers,
        averageDurationSeconds,
        abandonedCalls,
        abandonedCount,
        abandonmentRate,
        outcomeMap,
        outcomeRows,
        digitMap,
        digitRows,
        destinationMap,
        destinationRows,
        hourCounts,
        hourlyRows,
        peakHours,
        peakHour,
        formatHourLabel,
        peakHourSet,
        callsInPeakHours
    };
}

export { buildAaReportModel };
