<?php
declare(strict_types=1);

/*
 * ==========================================================================
 * WHICH DID IS A CALL ABOUT, AND WHAT EACH DID DID (moved out of the API)
 * ==========================================================================
 *
 * These four functions used to live in api/telephone_numbers.php. They are the
 * domain's definition of two things - how a CDR is mapped onto one of the
 * customer's numbers, and how a number's traffic is bucketed - and the *report*
 * needs both: the month-end pack prints a per-number roll-up that has to agree
 * with the Telephone Numbers screen down to the abandon count.
 *
 * Two copies of a mapping rule is how one DID becomes two rows. One copy, kept
 * with the rest of the reporting arithmetic, is how they cannot disagree.
 *
 * Nothing here depends on the API layer: the normaliser (numberKey) and the
 * miss/abandon classifier (callMissedBucket) are in this module, and the
 * inventory keys the callers pass in are already numberKey() values.
 */

function didCandidatesFromCdr(array $call): array
{
    $fields = [
        'call-orig-to-user',
        'call-orig-request-user',
        'call-orig-request-uri',
        'call-orig-to-uri',
        'call-term-to-uri',
        'dialed',
        'to',
        'call-term-to-user',
    ];

    $out = [];

    foreach ($fields as $field) {

        $raw = (string)($call[$field] ?? '');

        if ($raw === '') {
            continue;
        }

        /* numberKey() is the one normaliser (support.php): a leading country
         * code is dropped, so "+1 800 555 1212" and "8005551212" cannot become
         * two rows for one line. */
        $key = numberKey((string)$raw);

        if (strlen($key) >= 10) {
            $out[$key] = true;
        }
    }

    return array_map(
        static fn($key): string => (string)$key,
        array_keys($out)
    );
}


function resolveDidKey(array $call, array $inventoryKeys): string
{
    $candidates = didCandidatesFromCdr($call);

    foreach ($candidates as $candidate) {

        $candidate = (string)$candidate;

        if (
            $candidate !== '' &&
            isset($inventoryKeys[$candidate])
        ) {
            return $candidate;
        }
    }

    if ($candidates !== []) {
        return (string)$candidates[0];
    }

    return numberKey(phoneNumberFromCdr($call));
}


/*
 * $directory and $queueIds are what callMissedBucket() needs to tell an abandon
 * (a caller who reached a queue or the auto attendant and hung up) from a call
 * that merely rang out. They are passed in rather than re-derived here so the
 * DID grid uses the same classification as the dashboard instead of a second
 * definition that can drift.
 */
function buildNumberStats(array $cdrs, array $inventoryKeys = [], array $directory = [], array $queueIds = []): array
{
    $stats = [];

    foreach ($cdrs as $call) {

        if (!is_array($call)) {
            continue;
        }

        $key = resolveDidKey($call, $inventoryKeys);

        if ($key === '') {
            continue;
        }

        if (!isset($stats[$key])) {

            $stats[$key] = [
                'total' => 0,
                'inbound' => 0,
                'outbound' => 0,
                'missed' => 0,
                'abandoned' => 0,
                'onnet' => 0,
                'talkSeconds' => 0,
                'firstCall' => null,
                'lastCall' => null
            ];
        }

        /*
         * Same buckets as dashboard report.summary.counts:
         * inbound / outbound / missed / onnet are exclusive.
         */
        $type = callType($call);

        if ($type === 'missed') {
            $stats[$key]['missed']++;
            /* The abandon subset, by the one shared definition. */
            if (callMissedBucket($call, $directory, $queueIds) === 'abandon') {
                $stats[$key]['abandoned']++;
            }
        } elseif ($type === 'inbound') {
            $stats[$key]['inbound']++;
        } elseif ($type === 'outbound') {
            $stats[$key]['outbound']++;
        } elseif ($type === 'onnet') {
            $stats[$key]['onnet']++;
        }

        $stats[$key]['total']++;

        $talkSeconds = seconds($call, 'call-talking-duration-seconds');

        $stats[$key]['talkSeconds'] += $talkSeconds;

        $timestamp = (string)(
            $call['startedAt']
            ?? $call['call-start-datetime']
            ?? ''
        );

        if ($timestamp !== '') {

            if (
                $stats[$key]['firstCall'] === null ||
                safeTimestamp($timestamp) < safeTimestamp($stats[$key]['firstCall'])
            ) {
                $stats[$key]['firstCall'] = $timestamp;
            }

            if (
                $stats[$key]['lastCall'] === null ||
                safeTimestamp($timestamp) > safeTimestamp($stats[$key]['lastCall'])
            ) {
                $stats[$key]['lastCall'] = $timestamp;
            }
        }
    }

    return $stats;
}


/**
 * strtotime() but 0 instead of false, so two unparseable timestamps compare as
 * equal rather than as "earlier than everything". Moved here with the rest of
 * the DID arithmetic; it is what buildNumberStats() uses to find a number's
 * first and last call.
 */
function safeTimestamp(string $value): int {
    $timestamp = strtotime($value);

    return $timestamp === false ? 0 : $timestamp;
}
