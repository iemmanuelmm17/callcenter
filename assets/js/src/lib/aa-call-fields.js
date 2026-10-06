/* Pure CDR field readers for the Auto-Attendant report (QA-11).
 *
 * These were closures inside AutoAttendantReport — 85 lines of the 1,789-line
 * component. Nothing here touches React or the DOM: each function takes one
 * call object and returns a value, so it lives in its own module and is
 * unit-tested directly (tests/js/aa-fields.mjs) rather than only through the
 * rendered page.
 *
 * Fallback order matters: the normalised name (what api/aa.php sends) is tried
 * first, the raw PBX field name last, and a present-but-empty value never
 * shadows a later one.
 */

const value = (call, ...keys) => {

    for (const key of keys) {

        if (
            call[key] !== undefined &&
            call[key] !== null &&
            String(call[key]).trim() !== ''
        ) {
            return call[key];
        }
    }

    return '';
};

const getCaller = call =>
    value(
        call,
        'caller',
        'origCaller',
        'call-orig-caller-id'
    );

const getCase = call =>
    String(
        value(call, 'case')
    ).trim();

const getAdditionalTier = call =>
    String(
        value(call, 'additionalTier')
    ).trim();

const getAdditionalPrompt = call =>
    String(
        value(call, 'additionalPrompt')
    ).trim();

const getAdditionalCase = call =>
    String(
        value(call, 'additionalCase')
    ).trim();

const getQueue = call =>
    String(
        value(call, 'queue')
    ).trim();

const getDestination = call =>
    String(
        value(call, 'destination')
    ).trim();

const getStart = call =>
    value(
        call,
        'start',
        'call-start-datetime'
    );

const getAnswer = call =>
    value(
        call,
        'answer',
        'call-answer-datetime'
    );

const getEnd = call =>
    value(
        call,
        'end',
        'call-disconnect-datetime'
    );

const getTalkSeconds = call =>
    Number(
        value(
            call,
            'talkSeconds',
            'call-talking-duration-seconds'
        )
    ) || 0;

const getTotalSeconds = call =>
    Number(
        value(
            call,
            'totalSeconds',
            'call-total-duration-seconds'
        )
    ) || 0;

const getDisconnectReason = call =>
    String(
        value(
            call,
            'disconnectReason',
            'call-disconnect-reason-text'
        )
    ).trim();

const getDirection = call =>
    Number(
        value(
            call,
            'direction',
            'call-direction'
        )
    );

/* A call that reached the additional-tier prompt. */
const isAdditionalTier = call =>
    getAdditionalTier(call) !== '';

export {
    getAdditionalCase,
    getAdditionalPrompt,
    getAdditionalTier,
    getAnswer,
    getCaller,
    getCase,
    getDestination,
    getDirection,
    getDisconnectReason,
    getEnd,
    getQueue,
    getStart,
    getTalkSeconds,
    getTotalSeconds,
    isAdditionalTier,
    value
};
