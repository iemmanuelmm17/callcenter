<?php
declare(strict_types=1);

/*
 * ==========================================================================
 * THE MONTH-END PACK ROW SETS (Sprint C)
 * ==========================================================================
 *
 * Two tables the printable report needs that no payload published as rows: the
 * per-queue line (with the target it was judged against) and the DID portfolio
 * roll-up (with the two flags the review asked for - zero traffic, and an
 * abandon share worth a phone call).
 *
 * Both are built from the SAME scoped call list as every other figure in the
 * response, and with the same helpers the screens use (callAnswered(),
 * callOutcome(), ringSeconds(), holdSeconds(), buildNumberStats()), so the pack
 * cannot disagree with the dashboard it was printed from. They live here rather
 * than in api/report.php because that file is already long and these are closed
 * pieces of arithmetic with their own test surface.
 */

/**
 * One row per queue that saw traffic in the scope, plus the queues that saw
 * none when the caller knows them (a zero row is a finding: the queue was
 * staffed and silent, or mis-mapped).
 *
 * SLA is measured against the queue's own target when one is configured and the
 * domain default otherwise - the same resolution summary() uses, through the
 * same helper - and `slaBase` is published beside `sla`, so a rate never
 * travels without the count it was computed from.
 */
function packQueueRows(array $calls, array $directory, array $queueIds, ?array $settings = null, array $knownQueues = []): array
{
    $blank = static fn(string $id, string $label): array => [
        'callqueue' => $id,
        'description' => $label,
        'offered' => 0,
        'answered' => 0,
        'missed' => 0,
        'abandoned' => 0,
        'slaHit' => 0,
        'waitN' => 0,
        'waitSum' => 0,
        'talkN' => 0,
        'talkSum' => 0,
        'holdSum' => 0,
        'holdN' => 0,
        'slaSeconds' => 0,
    ];

    $rows = [];
    foreach ($knownQueues as $id => $label) {
        $id = trim((string)$id);
        if ($id !== '') {
            $rows[$id] = $blank($id, (string)$label);
        }
    }

    $defaultTarget = max(1, min(120, (int)($settings['slaSeconds'] ?? 20)));

    foreach ($calls as $call) {
        $through = trim((string)($call['call-through-user'] ?? ''));
        if ($through === '' || !isset($queueIds[$through])) {
            continue;
        }
        if (!isset($rows[$through])) {
            $rows[$through] = $blank($through, $through);
        }
        /* The queue's own override, else the domain default - one helper, so a
         * row cannot be judged against a target the dashboard did not use. */
        $rows[$through]['slaSeconds'] = ($settings !== null && !empty($settings['queueSla']))
            ? resolveQueueSlaSeconds($settings, $through)
            : $defaultTarget;
        $target = (int)$rows[$through]['slaSeconds'];
        $answered = callAnswered($call);
        $outcome = callOutcome($call, $directory, $queueIds, $answered);
        $wait = ringSeconds($call);
        $talk = seconds($call, 'call-talking-duration-seconds');
        $hold = holdSeconds($call);

        $rows[$through]['offered']++;
        if ($answered) {
            $rows[$through]['answered']++;
            $rows[$through]['waitN']++;
            $rows[$through]['waitSum'] += $wait;
            if ($wait <= $target) {
                $rows[$through]['slaHit']++;
            }
            if ($talk > 0) {
                $rows[$through]['talkN']++;
                $rows[$through]['talkSum'] += $talk;
            }
        } elseif ($outcome === 'abandoned') {
            $rows[$through]['abandoned']++;
        } else {
            $rows[$through]['missed']++;
        }
        /* A call with no hold is never averaged in, exactly as on the queues
         * screen: the average is over the calls that actually held. */
        if ($hold > 0) {
            $rows[$through]['holdN']++;
            $rows[$through]['holdSum'] += $hold;
        }
    }

    $out = [];
    foreach ($rows as $row) {
        $waitN = (int)$row['waitN'];
        $talkN = (int)$row['talkN'];
        $holdN = (int)$row['holdN'];
        $offered = (int)$row['offered'];
        $out[] = [
            'callqueue' => $row['callqueue'],
            'description' => $row['description'],
            'slaSeconds' => (int)($row['slaSeconds'] ?: $defaultTarget),
            'offered' => $offered,
            'answered' => (int)$row['answered'],
            'missed' => (int)$row['missed'],
            'abandoned' => (int)$row['abandoned'],
            'sla' => $waitN > 0 ? round(((int)$row['slaHit'] / $waitN) * 100, 1) : 0.0,
            'slaBase' => $waitN,
            'abandonRate' => $offered > 0 ? round(((int)$row['abandoned'] / $offered) * 100, 1) : 0.0,
            'avgRing' => $waitN > 0 ? (int)round((int)$row['waitSum'] / $waitN) : 0,
            'avgTalk' => $talkN > 0 ? (int)round((int)$row['talkSum'] / $talkN) : 0,
            'totalTalk' => (int)$row['talkSum'],
            'holdAvg' => $holdN > 0 ? (int)round((int)$row['holdSum'] / $holdN) : 0,
            'holdTotal' => (int)$row['holdSum'],
        ];
    }
    usort($out, static fn(array $a, array $b): int => $b['offered'] <=> $a['offered']);
    return $out;
}

/**
 * The DID portfolio: one row per dialled number, in the SAME buckets the
 * Telephone Numbers screen shows - it is computed by buildNumberStats(), the
 * function that screen itself uses (includes/reporting/dids.php), so the pack
 * cannot present a number differently from the screen it was printed from.
 *
 * The review asked for two flags, and both are derived here rather than
 * re-derived by the printer:
 *
 *   zeroTraffic   the number is live in the inventory but took no call at all in
 *                 the scope. Only a number the caller actually has can be
 *                 silently dead; an unlisted number that appears in the CDRs is
 *                 a mapping question, so it is never flagged.
 *   highAbandon   at least PACK_HIGH_ABANDON_MIN_MISSED missed calls AND an
 *                 abandon share at or over PACK_HIGH_ABANDON_PCT, where the
 *                 share's base is the MISSED calls - the calls that could have
 *                 been abandoned. A three-call line is not a finding, hence the
 *                 floor.
 *
 * `missedRate` and `abandonRate` travel with `calls` and `missed`, the counts
 * they were computed from.
 */
const PACK_HIGH_ABANDON_PCT = 20.0;
const PACK_HIGH_ABANDON_MIN_MISSED = 5;

function packNumberRows(array $calls, array $directory, array $queueIds = [], array $knownNumbers = []): array
{
    /* Display spelling per key: the inventory's own formatting wins, so the
     * printed page shows the number the way the customer's list writes it. */
    $labels = [];
    $enabled = [];
    foreach ($knownNumbers as $number) {
        $key = numberKey((string)$number);
        if ($key === '') {
            continue;
        }
        if (!isset($labels[$key])) {
            $labels[$key] = trim((string)$number);
        }
        $enabled[$key] = true;
    }

    $inventoryKeys = [];
    foreach (array_keys($labels) as $key) {
        $inventoryKeys[$key] = true;
    }

    $stats = buildNumberStats($calls, $inventoryKeys, $directory, $queueIds);

    $out = [];
    foreach ($stats as $key => $row) {
        $callsCount = (int)($row['total'] ?? 0);
        $missed = (int)($row['missed'] ?? 0);
        $abandoned = (int)($row['abandoned'] ?? 0);
        /* `calls` is every call type on the line (what the Telephone Numbers
         * screen calls its volume). The missed SHARE is over the calls that
         * ARRIVED - inbound + missed, the screen's own "incoming" - because an
         * outbound leg the desk placed is not a chance to miss anybody. */
        $arrived = (int)($row['inbound'] ?? 0) + $missed;
        $out[] = [
            'number' => $labels[$key] ?? (string)$key,
            'key' => (string)$key,
            'calls' => $callsCount,
            'inbound' => (int)($row['inbound'] ?? 0),
            'missed' => $missed,
            'abandoned' => $abandoned,
            'missedBase' => $arrived,
            'missedRate' => $arrived > 0 ? round(($missed / $arrived) * 100, 1) : 0.0,
            'abandonRate' => $missed > 0 ? round(($abandoned / $missed) * 100, 1) : 0.0,
            'totalTalk' => (int)($row['talkSeconds'] ?? 0),
            'zeroTraffic' => isset($enabled[$key]) && $callsCount === 0,
            'highAbandon' => $missed >= PACK_HIGH_ABANDON_MIN_MISSED
                && round(($abandoned / $missed) * 100, 1) >= PACK_HIGH_ABANDON_PCT,
        ];
    }

    /* A live number that took no traffic has no CDR row to be built from, so it
     * is added after the fact - with zeroes, and flagged, because that IS the
     * finding the flag exists for. */
    foreach (array_keys($enabled) as $key) {
        if (isset($stats[$key])) {
            continue;
        }
        $out[] = [
            'number' => $labels[$key],
            'key' => (string)$key,
            'calls' => 0,
            'inbound' => 0,
            'missed' => 0,
            'abandoned' => 0,
            'missedBase' => 0,
            'missedRate' => 0.0,
            'abandonRate' => 0.0,
            'totalTalk' => 0,
            'zeroTraffic' => true,
            'highAbandon' => false,
        ];
    }

    usort($out, static fn(array $a, array $b): int => $b['calls'] <=> $a['calls']);
    return $out;
}
