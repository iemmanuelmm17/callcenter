<?php
declare(strict_types=1);

/**
 * Canonical call outcomes — the single definition of answered / abandoned /
 * voicemail / no-answer that every report derives from.
 *
 * Why this file exists: "missed" and "abandoned" used to be computed in five
 * places with five rules, so the same call could be abandoned on the Dashboard
 * and missed on the Queues screen, and the Agents table's Abandoned column was
 * never filled in at all. Everything now goes through the functions below.
 *
 * == Two dimensions ==
 *
 * TYPE (what kind of traffic the call is) — classifyCdrType():
 *     inbound | outbound | onnet | missed | other
 *
 * OUTCOME (how the call ended) — callOutcome():
 *     answered | abandoned | voicemail | noanswer
 *
 * `type === 'missed'` is exactly `outcome !== 'answered'` for the missed
 * family, and the outcome is the reason breakdown inside it.
 *
 * == The rules ==
 *
 * answered
 *     A live conversation. True when the CDR carries an answer timestamp
 *     (call-answer-datetime or call-batch-answer-datetime — queue legs often
 *     only carry the batch one) or any talking seconds.
 *
 *     This is the same test the Queues screen has always used
 *     (`answerAt !== '' || talk > 0`); the classifier used to ignore talking
 *     seconds and the batch timestamp, which is why an answered queue call
 *     could still be reported as missed on the Dashboard, Agents, Telephone
 *     Numbers and Call History.
 *
 * abandoned
 *     Not answered, and the caller was inside a queue or the auto attendant:
 *     the CDR went through a queue / service user / IVR application, or it
 *     carries a queue batch leg. "Touched a queue or IVR" is the signal that
 *     works on non-queue reports (they have no batch fields); the batch leg is
 *     the stronger signal the Queues screen has.
 *
 * voicemail
 *     Not answered, and the call ended in a mailbox: the voicemail-ish CDR
 *     fields (vmbox/voicemail URIs, term user, disconnect text) or
 *     call-direction 2.
 *
 *     Checked BEFORE the answered test on purpose: a caller recording a
 *     message produces talking seconds, but nobody answered the call — the
 *     old code turned those into "no answer", the wrong bucket.
 *
 * noanswer
 *     Not answered, and the call never reached a queue, an IVR or a mailbox:
 *     it rang a phone (or a hunt group) and stopped.
 *
 * == What is reported where ==
 *
 *   Dashboard      counts.missed / inbound (types) + missedBreakdown (outcomes)
 *   Agents         mc = missed minus abandoned, ab = abandoned
 *                  (mc + ab = every missed call handed to that agent)
 *   Queues         answered / abandoned / missed, all three from the outcomes
 *   Tel. numbers   calls.missed = every missed call on the number
 *   Auto attendant per call: outcome, plus the caller-hangup sub-reason
 *   Call history   outcome column: answered / abandoned / missed
 *   Alerts         missed % and abandon % from the outcomes
 *
 * In every one of them `abandoned` uses callIsAbandoned() and `missed` means
 * "missed and not abandoned", so a call is never in two buckets or none.
 */

/** Statuses the outcome dimension can take. */
function callOutcomeKinds(): array
{
    return ['answered', 'abandoned', 'voicemail', 'noanswer'];
}

/**
 * Is there an answer timestamp on either leg?
 *
 * The batch leg matters: a call answered by a queue agent often carries only
 * call-batch-answer-datetime, and the old code looked at
 * call-answer-datetime alone.
 */
function callHasAnswerTimestamp(array $row): bool
{
    foreach (['call-answer-datetime', 'call-batch-answer-datetime'] as $field) {
        if (trim((string)($row[$field] ?? '')) !== '') {
            return true;
        }
    }
    return false;
}

/**
 * Did a human end up talking on this call?
 *
 * Answer timestamp (plain or queue batch leg) or talking seconds. See the file
 * header for why both timestamps and the talking seconds are needed.
 */
function callAnswered(array $row): bool
{
    return callHasAnswerTimestamp($row) || seconds($row, 'call-talking-duration-seconds') > 0;
}

/**
 * The "unanswered" test the TYPE classifier uses.
 *
 * Same as !callAnswered(), with one exception: a mailbox call (voicemail-ish
 * fields / direction 2) is unanswered even when it has talking seconds, because
 * the seconds are the caller recording a message, not a conversation.
 *
 * A mailbox call that DOES carry an answer timestamp is left alone — that is
 * "agent picked up, then the caller was sent to voicemail", which stays
 * inbound. Without this split a voicemail with talk seconds was reported as
 * answered inbound and disappeared from the dashboard's missed breakdown.
 */
function callUnansweredForType(array $row): bool
{
    if (callHasAnswerTimestamp($row)) {
        return false;
    }
    if (callIsVoicemail($row)) {
        return true;
    }
    return seconds($row, 'call-talking-duration-seconds') <= 0;
}

/** Did a queue batch (the queue leg itself) start for this call? */
function callIsQueueBatch(array $row): bool
{
    return trim((string)($row['call-batch-start-datetime'] ?? '')) !== '';
}

/**
 * Was this call abandoned?
 *
 * `$answered` lets a caller that already computed it pass it in (the Queues
 * and Calls screens classify in a loop over thousands of rows). When omitted it
 * is computed here.
 */
function callIsAbandoned(array $row, array $directory = [], array $queueIds = [], ?bool $answered = null): bool
{
    $answered = $answered ?? callAnswered($row);
    if ($answered) {
        return false;
    }
    return callWentQueueOrAa($row, $directory, $queueIds) || callIsQueueBatch($row);
}

/**
 * Is this call a mailbox call? (voicemail-ish fields, or call-direction 2)
 */
function callIsVoicemail(array $row): bool
{
    if (cdrLooksLikeVoicemail($row)) {
        return true;
    }
    return (int)($row['call-direction'] ?? $row['direction'] ?? -1) === 2;
}

/**
 * The one outcome classifier. See the file header for the rules.
 *
 * `$answered` / `$queueOrAa` may be passed in by callers that already computed
 * them; leaving them null computes them here, which is what the tests do.
 */
function callOutcome(
    array $row,
    array $directory = [],
    array $queueIds = [],
    ?bool $answered = null,
    ?bool $queueOrAa = null
): string {
    $answered = $answered ?? callAnswered($row);

    if ($answered) {
        /* Voicemail records talking seconds but was never answered by a
         * person; the mailbox check wins over the answered test so the caller
         * messaging is counted as voicemail, not as a handled call. */
        return callIsVoicemail($row) ? 'voicemail' : 'answered';
    }

    $queueOrAa = $queueOrAa ?? (callWentQueueOrAa($row, $directory, $queueIds) || callIsQueueBatch($row));
    if ($queueOrAa) {
        return 'abandoned';
    }
    if (callIsVoicemail($row)) {
        return 'voicemail';
    }
    return 'noanswer';
}

/**
 * The missed-call reason, in the vocabulary the reports and the UI already use:
 * one of 'abandon', 'voicemail', 'noanswer' — or 'answered' for a call the
 * classifier called missed but which a person actually handled (data quirk;
 * counted, never abandoned).
 *
 * This replaced missedKind(), which had its own rules.
 */
function callMissedReason(array $row, array $directory = [], array $queueIds = []): string
{
    return match (callOutcome($row, $directory, $queueIds)) {
        'abandoned' => 'abandon',
        'voicemail' => 'voicemail',
        'answered' => 'answered',
        default => 'noanswer',
    };
}

/**
 * Bucket key for the missed breakdown, with the same three keys the UI reads.
 * Anything the reports do not understand falls back to the 'noanswer' bucket,
 * which is never an abandon — the safe direction for an alert.
 */
function callMissedBucket(array $row, array $directory = [], array $queueIds = []): string
{
    $reason = callMissedReason($row, $directory, $queueIds);
    return $reason === 'answered' ? 'noanswer' : $reason;
}
