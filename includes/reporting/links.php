<?php
declare(strict_types=1);

/**
 * One call, many legs: identity, transfers, callbacks and repeat callers.
 *
 * A PBX call is not a row. One customer interaction is a tree of legs - the
 * trunk leg, the queue leg, each agent leg, the leg to the second agent after a
 * transfer - and NetSapiens exports each of them with its own id and a
 * `call-parent-call-id` pointing at the leg that spawned it. Every screen in
 * this app has to answer the same question before it can count anything: which
 * rows are the SAME conversation?
 *
 * Three separate answers to that question had grown in the tree:
 *
 *   - api/queue.php and api/cradle.php each carried their own copy of the same
 *     union-find (`$cdrIdBag`, `$ufFind`, `$ufUnion`) - and the cradle copy was
 *     missing queue.php's numeric-id fix, so a purely numeric call id (which PHP
 *     silently casts to int as an array key) would fatal there and not there;
 *   - includes/reporting/rows.php had a third id list in findRelatedCdrs(),
 *     reading six fields where the endpoints read eight, so the two disagreed
 *     about which legs belonged together;
 *   - nothing computed transfers, callbacks or repeat callers at all, which is
 *     why the manager review could not ask "how often do we bounce a caller
 *     between two agents" or "how many of yesterday's missed calls did we
 *     return".
 *
 * This module is the one definition. The union-find is deliberately shflattened
 * into a plain array structure (cdrLegIndex) rather than a class, because the
 * callers build it once per request and then treat it as data.
 *
 * Vocabulary used throughout:
 *
 *   leg          one CDR row = one physical leg of a call
 *   interaction  all the legs joined by shared ids = one customer conversation
 *   root         the index key identifying an interaction
 *   offered      one interaction, counted once, from the customer's side
 *   transfer     an interaction where more than one agent/queue leg answered
 */

/**
 * Every id on a leg, de-duplicated, as strings.
 *
 * The fields are listed widest-first on purpose: `call-id` and `cdr-id` are the
 * ones queue.php/cradle.php read and rows.php's findRelatedCdrs() did not, and
 * dropping them split interactions apart.
 *
 * BUGFIX (carried over from api/queue.php, where it was found the hard way):
 * PHP casts numeric-string array keys to int, so a purely numeric call id like
 * "20260115143022" comes back from array_keys() as an int, and under
 * declare(strict_types=1) that fatals in any string-typed helper it reaches.
 * array_map('strval', ...) keeps numeric and alphanumeric ids behaving alike.
 */
function cdrIdBag(array $row): array
{
    $ids = [];
    foreach ([
        'call-orig-call-id',
        'call-parent-call-id',
        'call-parent-cdr-id',
        'call-through-call-id',
        'call-term-call-id',
        'call-id',
        'cdr-id',
        'id',
    ] as $field) {
        $value = trim((string)($row[$field] ?? ''));
        if ($value !== '') {
            $ids[$value] = true;
        }
    }
    return array_map('strval', array_keys($ids));
}

/**
 * A stable per-leg key, used when a leg carries no call id at all.
 *
 * The first id if there is one, else the row's own id, else a fingerprint of
 * the fields that describe the same physical event. Two export rows with the
 * same direction, start, caller and terminus ARE the same event duplicated
 * (the PBX does this for trunk and terminus views), so merging them is right;
 * two different events cannot collide without sharing all four.
 */
function cdrLegFingerprint(array $row): string
{
    $ids = cdrIdBag($row);
    if ($ids !== []) {
        return $ids[0];
    }
    $own = trim((string)($row['id'] ?? ''));
    if ($own !== '') {
        return $own;
    }
    return 'fp:' . md5(implode('|', [
        (string)($row['call-direction'] ?? ''),
        (string)($row['call-start-datetime'] ?? $row['call-batch-start-datetime'] ?? ''),
        callFromNumber($row),
        (string)($row['call-term-user'] ?? ''),
    ]));
}

/**
 * Group raw legs into interactions.
 *
 * Returns:
 *   root      map id => root key (union-find result, for any id in cdrIdBag)
 *   byRoot    root key => [leg, leg, ...]
 *   byOrig    call-orig-call-id (or parent) => [leg, leg, ...]
 *   rowsById  id => [index => true] into $raw, for cheap related-leg lookups
 *   order     the order legs were indexed in, so row order never changes
 *
 * A leg with no ids at all is its own interaction ("row:N"), which is the
 * conservative choice: it is never merged with anything else by accident.
 */
function cdrLegIndex(array $raw): array
{
    $parent = [];
    $find = static function (string $x) use (&$parent, &$find): string {
        if (!isset($parent[$x]) || (string)$parent[$x] === $x) {
            $parent[$x] = $x;
            return $x;
        }
        $parent[$x] = $find((string)$parent[$x]);
        return (string)$parent[$x];
    };
    $union = static function (string $a, string $b) use (&$parent, $find): void {
        $ra = $find($a);
        $rb = $find($b);
        if ($ra !== $rb) {
            $parent[$rb] = $ra;
        }
    };

    $byRoot = [];
    $byOrig = [];
    $rowsById = [];
    $order = [];

    foreach ($raw as $i => $row) {
        if (!is_array($row)) {
            continue;
        }
        $first = cdrLegFingerprint($row);
        $ids = cdrIdBag($row);
        if ($ids === []) {
            $ids = [$first];
        }
        foreach ($ids as $id) {
            $union($first, $id);
        }
        $oid = trim((string)($row['call-orig-call-id'] ?? ''));
        if ($oid === '') {
            $oid = trim((string)($row['call-parent-call-id'] ?? ''));
        }
        if ($oid !== '') {
            $byOrig[$oid][] = $row;
        }
        foreach ($ids as $id) {
            $rowsById[$id][$i] = true;
        }
        $order[$i] = $first;
    }

    $root = [];
    foreach ($parent as $id => $_) {
        $root[$id] = $find((string)$id);
    }
    foreach ($order as $i => $first) {
        $byRoot[$find((string)$first)][] = $raw[$i];
    }

    return [
        'root' => $root,
        'byRoot' => $byRoot,
        'byOrig' => $byOrig,
        'rowsById' => $rowsById,
    ];
}

/** The interaction key for one leg, given an index from cdrLegIndex(). */
function cdrRootKey(array $row, array $index): string
{
    $key = cdrLegFingerprint($row);
    $root = $index['root'] ?? [];
    return (string)($root[$key] ?? $key);
}

/**
 * Every leg of the same interaction, earliest first.
 *
 * Legs are ordered by call-leg-ordinal-index when both sides have one (that is
 * the PBX's own order, which is the only honest way to say "then it went to
 * agent B"), and by start time otherwise.
 */
function cdrInteractionLegs(array $row, array $index): array
{
    $key = cdrRootKey($row, $index);
    $legs = $key !== '' ? (array)($index['byRoot'][$key] ?? []) : [];
    if ($legs === []) {
        return [$row];
    }
    usort($legs, static function (array $a, array $b): int {
        $oa = (int)($a['call-leg-ordinal-index'] ?? 0);
        $ob = (int)($b['call-leg-ordinal-index'] ?? 0);
        if ($oa !== $ob && $oa > 0 && $ob > 0) {
            return $oa <=> $ob;
        }
        return strcmp(
            (string)($a['call-start-datetime'] ?? $a['call-batch-start-datetime'] ?? ''),
            (string)($b['call-start-datetime'] ?? $b['call-batch-start-datetime'] ?? '')
        );
    });
    return $legs;
}

/**
 * A leg that a person actually handled.
 *
 * Two conditions, both necessary: the direction is not outbound (an outbound leg
 * is the desk calling out, it is not part of the customer's journey through the
 * desk), and there is an agent on it (callAgent() - the directory-checked
 * terminus/origin/through user). A queue leg with no agent is the queue ringing,
 * not a person answering.
 */
function cdrIsAnsweredAgentLeg(array $leg, array $directory = []): bool
{
    if (callPartyIsOutbound($leg)) {
        return false;
    }
    if (!callAnswered($leg)) {
        return false;
    }
    $agent = callAgent($leg);
    if ($agent === '') {
        return false;
    }
    return isset($directory[$agent]) || cdrIsInternalParty($leg);
}

/**
 * Is any party on this leg an internal extension (i.e. one of ours)?
 *
 * Used to decide whether `call-term-user` is a person or an outside number when
 * the directory does not list it. A leg whose terminus is a 10-digit number the
 * directory does not know is an external party, not an agent.
 */
function cdrIsInternalParty(array $leg): bool
{
    foreach (['_agent'] as $marker) {
        if (trim((string)($leg[$marker] ?? '')) !== '') {
            return true;
        }
    }
    foreach (['call-term-user', 'call-orig-user', 'call-through-user'] as $field) {
        $value = cdrExtractExt((string)($leg[$field] ?? ''));
        if ($value === '') {
            continue;
        }
        /* Internal extensions in these exports are short (3-6 digits) or an
         * alphanumeric user; a dialled PSTN number is 10+ digits. */
        if (strlen($value) <= 6 || preg_match('/\D/', $value)) {
            return true;
        }
    }
    return false;
}

/**
 * The customer's number on a leg, whichever side of the call they are on.
 *
 * For an inbound/missed leg the customer is the caller: callFromNumber().
 * For an outbound leg the customer is the one dialled: the to-uri / dialled
 * fields, with callFromNumber() only as a last resort (an outbound leg's
 * from-number is usually the desk's own caller ID, and matching on it would
 * "return" a missed call to the first number in the outbound caller-ID pool).
 *
 * Returned normalised to digits, so "+1 845 425 9810", "8454259810" and
 * "sip:8454259810@pbx" are one customer.
 */
function callCustomerNumber(array $row): string
{
    if (!callPartyIsOutbound($row)) {
        return normalizeCallNumber(callFromNumber($row));
    }
    foreach (['call-orig-to-user', 'call-term-to-user', 'call-orig-to-uri', 'call-term-to-uri', 'dialed', 'call-orig-request-user'] as $field) {
        $value = trim((string)($row[$field] ?? ''));
        if ($value === '') {
            continue;
        }
        $digits = normalizeCallNumber($value);
        if (strlen($digits) >= 7) {
            return $digits;
        }
    }
    return normalizeCallNumber(callFromNumber($row));
}

/**
 * A leg's start time as an epoch, in the desk's timezone, or null.
 *
 * Used for every "how long after" question (callback delay, repeat gap), so they
 * all measure the same clock the rest of the app prints.
 */
function callLocalTimestamp(array $row): ?int
{
    $at = parseEasternDateTime((string)($row['call-start-datetime'] ?? $row['call-batch-start-datetime'] ?? ''));
    return $at instanceof DateTimeImmutable ? $at->getTimestamp() : null;
}

/**
 * One canonical form per customer number, so two spellings compare equal.
 *
 * Digits only, with the country code removed: the PBX writes the same customer
 * as "+1 (845) 425-9810" on the trunk leg and "8454259810" on the agent leg, and
 * comparing the raw strings makes a returned call look unreturned. This is not
 * a formality - it turned every callback into a miss in testing until the two
 * spellings were reduced to one.
 *
 *   +1 845 425 9810     -> 8454259810     (NANP: 11 digits, leading 1)
 *   00 44 20 7946 0958  -> 442079460958  (international 00 prefix)
 *   sip:8454259810@pbx  -> 8454259810
 *
 * Anything that is not a plausible number comes back as its digits, so callers
 * can still apply their own "too short to match" rule.
 */
function normalizeCallNumber(string $value): string
{
    $digits = preg_replace('/\D+/', '', $value) ?? '';
    if ($digits === '') {
        return '';
    }
    if (strlen($digits) === 11 && $digits[0] === '1') {
        return substr($digits, 1);
    }
    if (str_starts_with($digits, '00') && strlen($digits) > 4) {
        return substr($digits, 2);
    }
    return $digits;
}

/**
 * The agent/queue hop order inside one interaction.
 *
 * Returns the answered legs in leg order, each as
 *   ['agent' => extension, 'queue' => queue id, 'leg' => row, 'at' => timestamp]
 *
 * Only answered legs that a person handled appear, because "it was transferred
 * to agent B" is a claim about people, not about rows. A queue leg that rang
 * nobody never moves the caller.
 */
function cdrHopSequence(array $row, array $index, array $directory = [], array $queueIds = []): array
{
    $hops = [];
    foreach (cdrInteractionLegs($row, $index) as $leg) {
        if (!cdrIsAnsweredAgentLeg($leg, $directory)) {
            continue;
        }
        $agent = callAgent($leg);
        if ($agent === '') {
            continue;
        }
        $hops[] = [
            'agent' => $agent,
            'queue' => $queueIds !== [] ? cdrQueueMatch($leg, $queueIds) : '',
            'leg' => $leg,
            'at' => (string)($leg['call-answer-datetime'] ?? $leg['call-start-datetime'] ?? ''),
        ];
    }
    return $hops;
}

/**
 * How many times this interaction was handed to a different agent.
 *
 * The first answered leg is the answer, not a transfer: a call handled by one
 * agent has zero transfers. Each subsequent answered leg is one transfer, and
 * consecutive legs handled by the SAME agent (a re-answer after a hold, or the
 * same agent's second leg) do not count - that is the same person still on the
 * call, and counting it would inflate the rate the review wants to act on.
 *
 * Consequence, stated because it matters: a transfer to an agent who never
 * answers is NOT counted here. "Offered to agent B" is a different, softer
 * metric than "handed to agent B", and mixing them would let an unanswered
 * transfer inflate a coaching conversation.
 */
function cdrTransferCount(array $row, array $index, array $directory = []): int
{
    $hops = cdrHopSequence($row, $index, $directory);
    $count = 0;
    $previous = null;
    foreach ($hops as $hop) {
        if ($previous !== null && $hop['agent'] !== $previous) {
            $count++;
        }
        $previous = $hop['agent'];
    }
    return $count;
}

/**
 * The transfer pairs in one interaction: [from agent, to agent] in order.
 */
function cdrTransferPairs(array $row, array $index, array $directory = []): array
{
    $pairs = [];
    $previous = null;
    foreach (cdrHopSequence($row, $index, $directory) as $hop) {
        if ($previous !== null && $hop['agent'] !== $previous) {
            $pairs[] = [$previous, $hop['agent']];
        }
        $previous = $hop['agent'];
    }
    return $pairs;
}

/**
 * The interactions in a period, each counted once.
 *
 * This is the denominator the app never had. Counting CDR rows counts legs, so a
 * call that rang two agents and was transferred once could appear three times -
 * which is how "offered" and "answered" drift apart between screens. One entry
 * per interaction, keyed on the root, taken from the leg that represents the
 * customer's first contact with the desk (the earliest inbound/missed leg).
 *
 * Returns [root => leg], so callers keep the O(1) shape they expect.
 */
function cdrOfferedInteractions(array $calls): array
{
    $index = cdrLegIndex($calls);
    $offered = [];
    foreach ($calls as $row) {
        if (!is_array($row)) {
            continue;
        }
        $type = callType($row);
        if ($type !== 'inbound' && $type !== 'missed') {
            continue;
        }
        $key = cdrRootKey($row, $index);
        $stamp = (string)($row['call-start-datetime'] ?? $row['call-batch-start-datetime'] ?? '');
        if (!isset($offered[$key]) || $stamp < (string)($offered[$key]['call-start-datetime'] ?? '')) {
            $offered[$key] = $row;
        }
    }
    return $offered;
}

/**
 * The customer callbacks in a period: missed calls that were returned.
 *
 * The manager review calls this "the single most useful daily metric I do not
 * have". The rule, and why each part of it is the way it is:
 *
 *   - only OUTBOUND legs can return a call. An inbound leg is the customer
 *     calling again, which is a repeat call, not a callback, and counting it
 *     would flatter every desk;
 *   - the match is on the customer's number, not on an id: the return call is a
 *     new call. callCustomerNumber() reads the dialled number on an outbound
 *     leg, so an agent dialling the customer from a softphone, from a queue
 *     callback list, or through a dialler all match;
 *   - the `call-back` CDR field is deliberately not used. It is always false in
 *     the exports this app reads (verified across the fixtures and the live
 *     sample the review was written from), so trusting it would report "nothing
 *     was returned" forever - the most dangerous possible answer;
 *   - a return call must come AFTER the missed one, and within a window
 *     (24 h by default, 72 h for the weekly review), because a call a week later
 *     is a new order, not a callback.
 *
 * Returns one entry per returned miss:
 *   ['missed' => leg, 'returned' => leg, 'seconds' => int, 'number' => digits]
 * plus, under 'unreturned', the misses with no matching outbound leg.
 * Both lists are keyed on the interaction root of the missed call, so a missed
 * call with two legs is still one miss.
 */
function cdrCallbacks(array $calls, int $windowSeconds = 86400): array
{
    $index = cdrLegIndex($calls);
    $missedByNumber = [];
    foreach (cdrOfferedInteractions($calls) as $key => $leg) {
        if (callType($leg) !== 'missed') {
            continue;
        }
        $number = callCustomerNumber($leg);
        if (strlen($number) < 7) {
            continue;
        }
        $missedByNumber[$key] = [
            'leg' => $leg,
            'number' => $number,
            'at' => callLocalTimestamp($leg),
        ];
    }

    $outbound = [];
    foreach ($calls as $row) {
        if (!is_array($row) || callType($row) !== 'outbound') {
            continue;
        }
        $number = callCustomerNumber($row);
        if (strlen($number) < 7) {
            continue;
        }
        $at = callLocalTimestamp($row);
        if ($at === null) {
            continue;
        }
        $outbound[$number][] = ['leg' => $row, 'at' => $at];
    }

    $returned = [];
    $unreturned = [];
    foreach ($missedByNumber as $key => $miss) {
        $best = null;
        foreach ($outbound[$miss['number']] ?? [] as $candidate) {
            if ($miss['at'] === null) {
                continue;
            }
            $delta = $candidate['at'] - $miss['at'];
            if ($delta < 0 || $delta > $windowSeconds) {
                continue;
            }
            if ($best === null || $delta < $best['seconds']) {
                $best = ['seconds' => $delta, 'leg' => $candidate['leg']];
            }
        }
        if ($best === null) {
            $unreturned[$key] = $miss;
            continue;
        }
        $returned[$key] = [
            'missed' => $miss['leg'],
            'returned' => $best['leg'],
            'seconds' => $best['seconds'],
            'number' => $miss['number'],
        ];
    }

    return [
        'returned' => $returned,
        'unreturned' => $unreturned,
        'windowSeconds' => $windowSeconds,
        /* counts, so an endpoint can publish the rate without walking twice */
        'counts' => [
            'missed' => count($missedByNumber),
            'returned' => count($returned),
            'unreturned' => count($unreturned),
        ],
    ];
}

/**
 * Repeat callers: the same customer number calling in twice or more.
 *
 * The honest first-call-resolution proxy the review asks for. Two windows are
 * returned because the answer changes the story: inside 24 h it is "we did not
 * resolve it today", inside 72 h it may be a follow-up. Only inbound/missed
 * interactions count as "calling in" - the desk calling the customer is a
 * callback, not a repeat.
 *
 * Returns:
 *   callers        number => ['calls' => n, 'within24' => bool, 'within72' => bool, 'agents' => [..]]
 *   counts         24 h / 72 h caller totals and the repeat counts
 */
function cdrRepeatCallers(array $calls): array
{
    $byNumber = [];
    foreach (cdrOfferedInteractions($calls) as $key => $leg) {
        $number = callCustomerNumber($leg);
        if (strlen($number) < 7) {
            continue;
        }
        $at = callLocalTimestamp($leg);
        $byNumber[$number][] = ['at' => $at, 'leg' => $leg, 'root' => $key];
    }

    $callers = [];
    $repeat24 = 0;
    $repeat72 = 0;
    $agentsAny = [];
    foreach ($byNumber as $number => $entries) {
        $stamps = array_values(array_filter(array_map(static fn($e) => $e['at'], $entries), static fn($t) => $t !== null));
        sort($stamps);
        $within24 = false;
        $within72 = false;
        for ($i = 1; $i < count($stamps); $i++) {
            $gap = $stamps[$i] - $stamps[$i - 1];
            if ($gap <= 86400) {
                $within24 = true;
            }
            if ($gap <= 259200) {
                $within72 = true;
            }
        }
        $agents = [];
        foreach ($entries as $entry) {
            $agent = callAgent($entry['leg']);
            if ($agent !== '') {
                $agents[$agent] = true;
            }
        }
        $callers[$number] = [
            'calls' => count($entries),
            'within24' => $within24,
            'within72' => $within72,
            'agents' => array_keys($agents),
        ];
        if ($within24) {
            $repeat24++;
        }
        if ($within72) {
            $repeat72++;
        }
        foreach (array_keys($agents) as $agent) {
            $agentsAny[$agent] = true;
        }
    }

    return [
        'callers' => $callers,
        'counts' => [
            'callers' => count($callers),
            'repeat24' => $repeat24,
            'repeat72' => $repeat72,
            /* the rate the review wants beside each agent: repeat / distinct */
            'rate24' => count($callers) > 0 ? round(($repeat24 / count($callers)) * 100, 1) : 0.0,
            'rate72' => count($callers) > 0 ? round(($repeat72 / count($callers)) * 100, 1) : 0.0,
            'agents' => count($agentsAny),
        ],
    ];
}

/**
 * Transfer totals for a period: one rate, and the pairs worth a conversation.
 *
 * Sorted by count descending, so the top pair in the payload is the one to
 * raise at the huddle. `queuePairs` records a queue CHANGE inside one
 * interaction, not the agent who happened to be on the leg.
 *
 * Two different numbers, deliberately both published:
 *
 *   transfers               how many hand-offs happened (a call routed through
 *                           three agents counts 2)
 *   transferredInteractions how many conversations were handed over at least
 *                           once - this is the RATE's numerator
 *
 * The rate is `transferredInteractions / handled`, so it cannot exceed 100 %.
 * Dividing the hand-off count by the same denominator does, the moment one call
 * is bounced twice: the first version of this function published "200 %" for a
 * two-hop transfer, which is the kind of figure that discredits a whole page.
 * `perTransferred` keeps the hidden count honest beside it (1.5 = the average
 * bounced call is handed over one and a half times).
 * Only interactions that were handled at all are counted
 * in the denominator (transfersOf / handledInteractions) - a call that nobody
 * answered cannot be transferred, and dividing by all offers would understate
 * the rate.
 */
function cdrTransferSummary(array $calls, array $directory = [], array $queueIds = []): array
{
    $index = cdrLegIndex($calls);
    $pairs = [];
    $queuePairs = [];
    $transfers = 0;
    $transferred = 0;
    $handled = 0;
    $seen = [];
    foreach ($calls as $row) {
        if (!is_array($row)) {
            continue;
        }
        $key = cdrRootKey($row, $index);
        if ($key === '' || isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $hops = cdrHopSequence($row, $index, $directory, $queueIds);
        if ($hops === []) {
            continue;
        }
        $handled++;
        $count = 0;
        $previous = null;
        $previousQueue = null;
        foreach ($hops as $hop) {
            $queue = (string)($hop['queue'] ?? '');
            if ($previous !== null && $hop['agent'] !== $previous) {
                $count++;
                $pairs[$previous . '>' . $hop['agent']] = ($pairs[$previous . '>' . $hop['agent']] ?? 0) + 1;
                /* Queue -> queue is its own question ("we hand calls between the
                 * sales and support queues"), so it is only recorded when the
                 * queue the call sits in actually changed. */
                if ($previousQueue !== null && $queue !== '' && $queue !== $previousQueue) {
                    $queuePairs[$previousQueue . '>' . $queue] = ($queuePairs[$previousQueue . '>' . $queue] ?? 0) + 1;
                }
            }
            $previous = $hop['agent'];
            if ($queue !== '') {
                $previousQueue = $queue;
            }
        }
        $transfers += $count;
        if ($count > 0) {
            $transferred++;
        }
    }

    arsort($pairs);
    arsort($queuePairs);

    return [
        'transfers' => $transfers,
        'transferredInteractions' => $transferred,
        'handled' => $handled,
        'ratePct' => $handled > 0 ? round(($transferred / $handled) * 100, 1) : 0.0,
        'perTransferred' => $transferred > 0 ? round($transfers / $transferred, 2) : 0.0,
        'agentPairs' => $pairs,
        'queuePairs' => $queuePairs,
    ];
}

/**
 * Everything the links layer publishes about a period, in one call.
 *
 * One assembler on purpose: the dashboard, the queue screen, the DID page and
 * the printable pack must not each decide how to count a returned call, or the
 * same month will report two different callback rates. Endpoints call this and
 * put the result in their payload unchanged.
 *
 * $top caps the worklists (the pairs and callers a person will actually read);
 * the counts are always complete. $callbackWindow is in seconds: 24 h is the
 * daily review's question ("did we return yesterday's calls?"), 72 h the weekly
 * one.
 */
function callLinkReport(array $calls, array $directory = [], array $queueIds = [], int $callbackWindow = 86400, int $top = 20): array
{
    $transfers = cdrTransferSummary($calls, $directory, $queueIds);
    $callbacks = cdrCallbacks($calls, $callbackWindow);
    $repeat = cdrRepeatCallers($calls);

    $delays = [];
    $worklist = [];
    foreach ($callbacks['returned'] as $entry) {
        $delays[] = $entry['seconds'];
        $worklist[] = [
            'number' => $entry['number'],
            'missedAt' => (string)($entry['missed']['call-start-datetime'] ?? ''),
            'returnedAt' => (string)($entry['returned']['call-start-datetime'] ?? ''),
            'seconds' => $entry['seconds'],
            'agent' => callAgent($entry['returned']),
        ];
    }
    usort($worklist, static fn(array $a, array $b): int => $a['seconds'] <=> $b['seconds']);

    $unreturned = [];
    foreach ($callbacks['unreturned'] as $entry) {
        $unreturned[] = [
            'number' => $entry['number'],
            'missedAt' => (string)($entry['leg']['call-start-datetime'] ?? ''),
        ];
    }
    usort($unreturned, static fn(array $a, array $b): int => strcmp($b['missedAt'], $a['missedAt']));

    $topCallers = [];
    foreach ($repeat['callers'] as $number => $info) {
        if ($info['calls'] < 2) {
            continue;
        }
        $topCallers[] = [
            'number' => $number,
            'calls' => $info['calls'],
            'within24' => $info['within24'],
            'within72' => $info['within72'],
            'agents' => $info['agents'],
        ];
    }
    usort($topCallers, static function (array $a, array $b): int {
        return $b['calls'] <=> $a['calls'];
    });

    $pairList = static function (array $pairs, int $limit): array {
        $out = [];
        foreach (array_slice($pairs, 0, $limit, true) as $pair => $count) {
            [$from, $to] = array_pad(explode('>', (string)$pair, 2), 2, '');
            $out[] = ['from' => $from, 'to' => $to, 'count' => $count];
        }
        return $out;
    };

    return [
        'offered' => count(cdrOfferedInteractions($calls)),
        'transfers' => [
            'count' => $transfers['transfers'],
            'transferredInteractions' => $transfers['transferredInteractions'],
            'handled' => $transfers['handled'],
            'ratePct' => $transfers['ratePct'],
            'perTransferred' => $transfers['perTransferred'],
            'agentPairs' => $pairList($transfers['agentPairs'], $top),
            'queuePairs' => $pairList($transfers['queuePairs'], $top),
        ],
        'callbacks' => [
            'windowSeconds' => $callbacks['windowSeconds'],
            'missed' => $callbacks['counts']['missed'],
            'returned' => $callbacks['counts']['returned'],
            'unreturned' => $callbacks['counts']['unreturned'],
            'ratePct' => $callbacks['counts']['missed'] > 0
                ? round(($callbacks['counts']['returned'] / $callbacks['counts']['missed']) * 100, 1)
                : 0.0,
            'avgReturnSeconds' => $delays !== [] ? (int)round(array_sum($delays) / count($delays)) : 0,
            'fastest' => $worklist !== [] ? $worklist[0] : null,
            'slowest' => $worklist !== [] ? $worklist[count($worklist) - 1] : null,
            'worklist' => array_slice($worklist, 0, $top),
            'unreturnedList' => array_slice($unreturned, 0, $top),
        ],
        'repeat' => [
            'callers' => $repeat['counts']['callers'],
            'repeat24' => $repeat['counts']['repeat24'],
            'repeat72' => $repeat['counts']['repeat72'],
            'rate24Pct' => $repeat['counts']['rate24'],
            'rate72Pct' => $repeat['counts']['rate72'],
            'top' => array_slice($topCallers, 0, $top),
        ],
    ];
}
