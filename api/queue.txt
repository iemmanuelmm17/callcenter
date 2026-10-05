<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

try {
    $user = currentUser();
    /*
     * SEC-6 FIX: enforce the same roles the UI exposes (office managers and
     * supervisors). Agent / basic_user sessions are dashboard-only and must
     * not be able to pull domain-wide queue data via the API.
     */
    requirePageRoles($user, ['office_manager', 'supervisor']);
    /* FUNC-17: malformed JSON bodies are a 422, never a silent "no filters". */
    $requested = readJsonBody();
    $filters = authorizedFilters($requested, $user);
    if ($filters['end'] < $filters['start']) {
        jsonResponse(['error' => 'Invalid date range'], 422);
    }

    $selectedQueue = trim((string)($requested['queue'] ?? ''));
    /*
     * FUNC-16/FUNC-27: SLA window resolved by the shared helper
     * (domain settings default, clamped 1..120). Was: hard-coded 30 —
     * a different default from calls.php/report.php (20).
     */
    $slaSeconds = resolveSlaSeconds($requested, $user);

    $queues = cachedCallQueues($user);
    $allQueueIds = [];
    foreach ($queues as $q) {
        $id = trim((string)($q['callqueue'] ?? ''));
        if ($id !== '') {
            $allQueueIds[$id] = true;
        }
    }
    $siteFilter = trim((string)($filters['site'] ?? ''));
    if ($siteFilter !== '') {
        $queues = array_values(array_filter(
            $queues,
            static function (array $q) use ($siteFilter): bool {
                return trim((string)($q['site'] ?? '')) === $siteFilter;
            }
        ));
    }

    $queueIds = [];
    foreach ($queues as $q) {
        $id = trim((string)($q['callqueue'] ?? ''));
        if ($id !== '') {
            $queueIds[$id] = true;
        }
    }

    $extractExt = static function (string $value): string {
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        $value = preg_replace('/^(?:sip:|tel:)/i', '', $value) ?? $value;
        if (str_contains($value, '@')) {
            $value = explode('@', $value, 2)[0];
        }
        $value = trim($value, "<> \t");
        if (str_contains($value, ':')) {
            $value = explode(':', $value, 2)[0];
        }
        return $value;
    };

    $cdrIdBag = static function (array $row): array {
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
            $v = trim((string)($row[$field] ?? ''));
            if ($v !== '') {
                $ids[$v] = true;
            }
        }
        /*
         * BUGFIX: array_map('strval', ...) is required.
         *
         * PHP silently casts numeric-string array keys to int, so a
         * purely numeric call id like "20260115143022" comes back from
         * array_keys() as an INT. Under declare(strict_types=1) that
         * then fatals in the string-typed helpers below:
         *
         *   {closure}(): Argument #1 ($a) must be of type string,
         *   int given  (queue.php line 213, called from line 233)
         *
         * Forcing every id back to string keeps $ufUnion/$ufFind and the
         * id index working for both numeric and alphanumeric call ids.
         */
        return array_map('strval', array_keys($ids));
    };

    $directory = userDirectory($user);
    $agentNames = [];
    foreach ($directory as $ext => $person) {
        $agentNames[(string)$ext] = (string)($person['name'] ?? $ext);
    }

    $rosterAgents = [];
    if ($selectedQueue !== '') {
        $rosterAgents = cachedCallQueueAgents($user, $selectedQueue);
        foreach ($rosterAgents as $agent) {
            if (!is_array($agent)) {
                continue;
            }
            $aid = trim((string)($agent['callqueue-agent-id'] ?? ''));
            if ($aid === '') {
                continue;
            }
            $name = trim((string)($agent['name-full-name'] ?? ''));
            if ($name !== '') {
                $agentNames[$aid] = $name;
            }
        }
    }

    $raw = loadRawCdrs($user, $filters);
    /*
     * SEC-6 FIX: the raw CDR cache is domain-wide by design, so it must be
     * scoped before any stats are computed — exactly the way
     * reportingCdrRows() does it in calls.php / call_history.php / agents.php:
     * scopedCdrs(normalizeCdrs(loadRawCdrs(...))). For supervisors this
     * forces their own department (authorizedFilters already sets it); for
     * office managers it honors the requested department/site/agent filters.
     */
    $raw = scopedCdrs(normalizeCdrs($raw, $directory), $filters, $directory);

    $allQueueRows = [];
    $matched = [];
    foreach ($raw as $row) {
        if (!is_array($row)) {
            continue;
        }
        $through = cdrQueueMatch($row, $queueIds);
        if ($through === '') {
            continue;
        }
        $row['_queue'] = $through;
        $allQueueRows[] = $row;
        if ($selectedQueue === '' || $through === $selectedQueue) {
            $matched[] = $row;
        }
    }

    $waitSeconds = static function (array $row): int {
        $ring = ringSeconds($row);
        if ($ring > 0) {
            return $ring;
        }
        $start = parseEasternDateTime((string)($row['call-batch-start-datetime'] ?? ''));
        $answer = parseEasternDateTime((string)($row['call-batch-answer-datetime'] ?? ''));
        if ($start instanceof DateTimeImmutable && $answer instanceof DateTimeImmutable) {
            return max(0, $answer->getTimestamp() - $start->getTimestamp());
        }
        $ringAt = parseEasternDateTime((string)($row['call-ringing-datetime'] ?? ''));
        $answerAt = parseEasternDateTime((string)($row['call-answer-datetime'] ?? $row['call-batch-answer-datetime'] ?? ''));
        if ($ringAt instanceof DateTimeImmutable && $answerAt instanceof DateTimeImmutable) {
            return max(0, $answerAt->getTimestamp() - $ringAt->getTimestamp());
        }
        return max(0, seconds($row, 'call-total-duration-seconds') - seconds($row, 'call-talking-duration-seconds'));
    };

    $hours = array_fill(0, 24, 0);
    $answered = 0;
    $abandoned = 0;
    $missed = 0;
    $waitSum = 0;
    $waitN = 0;
    $talkSum = 0;
    $talkN = 0;
    $slaHit = 0;
    $posSum = 0;
    $neuSum = 0;
    $negSum = 0;
    $sentN = 0;
    $topics = [];
    $reasons = [];
    $byAgent = [];
    $recent = [];
    $queueStats = [];
    foreach ($queues as $q) {
        $id = trim((string)($q['callqueue'] ?? ''));
        if ($id === '') {
            continue;
        }
        $queueStats[$id] = [
            'callqueue' => $id,
            'description' => trim((string)($q['description'] ?? $id)),
            'site' => trim((string)($q['site'] ?? '')),
            'totalCalls' => 0,
            'answered' => 0,
            'abandoned' => 0,
            'slaHit' => 0,
            'slaMiss' => 0,
            'waitN' => 0,
            'waitSum' => 0,
            'waitMax' => 0,
            'talkSum' => 0,
            'talkN' => 0,
            'talkMax' => 0,
        ];
    }

    $ufParent = [];
    /*
     * BUGFIX: these take mixed, not string.
     *
     * PHP casts numeric-string array keys to int, so values read back
     * out of $ufParent (and out of $cdrIdBag) can be ints even though
     * every id was written as a string. Under declare(strict_types=1)
     * the old `string $x` signature fataled on the first all-digit call
     * id. Casting on entry also removes a latent correctness trap: when
     * the stored parent originates from array_keys() it is an int, so
     * the root test `$ufParent[$x] === $x` compares int against string
     * and is never true. The (string) casts make both the type check and
     * the identity check behave for numeric and alphanumeric ids alike.
     */
    $ufFind = static function ($x) use (&$ufParent, &$ufFind): string {
        $x = (string)$x;
        if (!isset($ufParent[$x]) || (string)$ufParent[$x] === $x) {
            $ufParent[$x] = $x;
            return $x;
        }
        $ufParent[$x] = $ufFind($ufParent[$x]);
        return (string)$ufParent[$x];
    };
    $ufUnion = static function ($a, $b) use (&$ufParent, $ufFind): void {
        $ra = $ufFind($a);
        $rb = $ufFind($b);
        if ($ra !== $rb) {
            $ufParent[$rb] = $ra;
        }
    };

    $legsByOrig = [];
    $legsByRoot = [];
    foreach ($raw as $i => $row) {
        if (!is_array($row)) {
            continue;
        }
        $ids = $cdrIdBag($row);
        if ($ids === []) {
            $ids[] = 'row:' . $i;
        }
        $first = $ids[0];
        foreach ($ids as $id) {
            $ufUnion($first, $id);
        }
        $oid = trim((string)($row['call-orig-call-id'] ?? ''));
        if ($oid === '') {
            $oid = trim((string)($row['call-parent-call-id'] ?? ''));
        }
        if ($oid !== '') {
            $legsByOrig[$oid][] = $row;
        }
    }
    foreach ($raw as $i => $row) {
        if (!is_array($row)) {
            continue;
        }
        $ids = $cdrIdBag($row);
        $key = $ids !== [] ? $ufFind($ids[0]) : ('row:' . $i);
        $legsByRoot[$key][] = $row;
    }

    /*
     * PERF: call-id -> rows index.
     *
     * This replaces findRelatedCdrs($raw, $row), which walked EVERY raw
     * CDR for EVERY matched row. That is O(matched x raw): on a wide
     * range (~150k raw / ~12k matched) it is ~1.8 billion inner field
     * reads, which blew the PHP time limit and surfaced in the browser
     * as a 502 from queue.php's catch-all. Recent ranges stayed small
     * enough to squeak through, which is why only old/large ranges
     * failed while other dashboards loaded fine.
     *
     * Built once here, then each row does a handful of hash lookups.
     */
    $rowsById = [];
    foreach ($raw as $i => $row) {
        if (!is_array($row)) {
            continue;
        }
        foreach ($cdrIdBag($row) as $id) {
            $rowsById[$id][$i] = true;
        }
    }

    /*
     * Same contract as findRelatedCdrs(): every raw CDR sharing any call
     * id with $row, sorted by start time. Duplicates are collapsed by
     * index, and the caller additionally de-dupes via $byStamp.
     */
    $relatedCdrs = static function (array $row) use ($raw, $rowsById, $cdrIdBag): array {
        $hits = [];
        foreach ($cdrIdBag($row) as $id) {
            if (!isset($rowsById[$id])) {
                continue;
            }
            foreach ($rowsById[$id] as $idx => $_) {
                $hits[$idx] = true;
            }
        }
        if ($hits === []) {
            return [];
        }
        $out = [];
        foreach (array_keys($hits) as $idx) {
            $out[] = $raw[$idx];
        }
        usort($out, static function (array $a, array $b): int {
            return strcmp(
                (string)($a['call-start-datetime'] ?? ''),
                (string)($b['call-start-datetime'] ?? '')
            );
        });
        return $out;
    };

    $hopFields = [
        'call-through-user',
        'call-term-pre-routing-uri',
        'call-orig-pre-routing-uri',
        'call-through-uri',
        'uid',
        'call-term-user',
    ];

    $buildHops = static function (array $legs) use ($extractExt, $allQueueIds, $agentNames, $hopFields): array {
        usort($legs, static function (array $a, array $b): int {
            $oa = (int)($a['call-leg-ordinal-index'] ?? 0);
            $ob = (int)($b['call-leg-ordinal-index'] ?? 0);
            if ($oa !== $ob && $oa && $ob) {
                return $oa <=> $ob;
            }
            return strcmp(
                (string)($a['call-start-datetime'] ?? $a['call-batch-start-datetime'] ?? ''),
                (string)($b['call-start-datetime'] ?? $b['call-batch-start-datetime'] ?? '')
            );
        });
        $hops = [];
        $seen = [];
        $lastAgent = null;
        foreach ($legs as $leg) {
            if (!is_array($leg)) {
                continue;
            }
            foreach ($hopFields as $field) {
                $ext = $extractExt((string)($leg[$field] ?? ''));
                if ($ext === '' || isset($seen[$ext])) {
                    continue;
                }
                if (isset($allQueueIds[$ext])) {
                    $seen[$ext] = true;
                    $hops[] = [
                        'kind' => 'queue',
                        'id' => $ext,
                        'label' => 'Queue ' . $ext,
                    ];
                } elseif ($field === 'call-term-user') {
                    $lastAgent = $ext;
                }
            }
        }
        if ($lastAgent !== null && !isset($seen[$lastAgent]) && !isset($allQueueIds[$lastAgent])) {
            $hops[] = [
                'kind' => 'agent',
                'id' => $lastAgent,
                'label' => 'Agent ' . ($agentNames[$lastAgent] ?? $lastAgent),
            ];
        }
        return $hops;
    };

    foreach ($allQueueRows as $row) {
        $through = (string)($row['_queue'] ?? '');
        $batchStart = trim((string)($row['call-batch-start-datetime'] ?? ''));
        $answerAt = trim((string)($row['call-answer-datetime'] ?? ''));
        $talk = seconds($row, 'call-talking-duration-seconds');
        $wait = $waitSeconds($row);
        $answeredCall = $answerAt !== '' || $talk > 0;
        $abandonedCall = !$answeredCall && $batchStart !== '';
        if (!isset($queueStats[$through])) {
            continue;
        }
        $queueStats[$through]['totalCalls']++;
        if ($answeredCall) {
            $queueStats[$through]['answered']++;
            $queueStats[$through]['waitSum'] += $wait;
            $queueStats[$through]['waitN']++;
            if ($wait > (int)$queueStats[$through]['waitMax']) {
                $queueStats[$through]['waitMax'] = $wait;
            }
            if ($wait <= $slaSeconds) {
                $queueStats[$through]['slaHit']++;
            } else {
                $queueStats[$through]['slaMiss']++;
            }
            if ($talk > 0) {
                $queueStats[$through]['talkSum'] += $talk;
                $queueStats[$through]['talkN']++;
                if ($talk > (int)$queueStats[$through]['talkMax']) {
                    $queueStats[$through]['talkMax'] = $talk;
                }
            }
        } elseif ($abandonedCall) {
            $queueStats[$through]['abandoned']++;
        }
    }

    foreach ($matched as $row) {
        $through = (string)($row['_queue'] ?? '');
        $batchStart = trim((string)($row['call-batch-start-datetime'] ?? ''));
        $answerAt = trim((string)($row['call-answer-datetime'] ?? ''));
        $talk = seconds($row, 'call-talking-duration-seconds');
        $wait = $waitSeconds($row);
        $answeredCall = $answerAt !== '' || $talk > 0;
        $abandonedCall = !$answeredCall && $batchStart !== '';

        if ($answeredCall) {
            $answered++;
            $waitSum += $wait;
            $waitN++;
            if ($wait <= $slaSeconds) {
                $slaHit++;
            }
            if ($talk > 0) {
                $talkSum += $talk;
                $talkN++;
            }
        } elseif ($abandonedCall) {
            $abandoned++;
        } else {
            $missed++;
        }

        $startRaw = (string)($row['call-batch-start-datetime'] ?? $row['call-start-datetime'] ?? '');
        $at = parseEasternDateTime($startRaw);
        if ($at instanceof DateTimeImmutable) {
            $hours[(int)$at->format('G')]++;
        }

        $pos = (float)($row['call-intelligence-percent-positive'] ?? 0);
        $neu = (float)($row['call-intelligence-percent-neutral'] ?? 0);
        $neg = (float)($row['call-intelligence-percent-negative'] ?? 0);
        if ($pos || $neu || $neg) {
            $posSum += $pos;
            $neuSum += $neu;
            $negSum += $neg;
            $sentN++;
        }
        $topic = trim((string)($row['call-intelligence-topics-top'] ?? ''));
        if ($topic !== '') {
            foreach (preg_split('/[,;|]+/', $topic) ?: [] as $piece) {
                $piece = trim($piece);
                if ($piece === '') {
                    continue;
                }
                $topics[$piece] = ($topics[$piece] ?? 0) + 1;
            }
        }

        $reason = trim((string)($row['call-disconnect-reason-text'] ?? ''));
        if ($reason !== '') {
            $reasons[$reason] = ($reasons[$reason] ?? 0) + 1;
        }

        $agentExt = trim((string)($row['call-term-user'] ?? ''));
        if ($agentExt !== '' && !isset($queueIds[$agentExt])) {
            if (!isset($byAgent[$agentExt])) {
                $byAgent[$agentExt] = [
                    'extension' => $agentExt,
                    'name' => $agentNames[$agentExt] ?? $agentExt,
                    'calls' => 0,
                    'talk' => 0,
                    'sentiment' => 0,
                    'sentN' => 0,
                ];
            }
            $byAgent[$agentExt]['calls']++;
            $byAgent[$agentExt]['talk'] += $talk;
            if ($pos || $neg) {
                $byAgent[$agentExt]['sentiment'] += ($pos - $neg);
                $byAgent[$agentExt]['sentN']++;
            }
        }

        $ending = strtolower(trim((string)($row['ending_sentiment'] ?? '')));
        $sentDot = 'neutral';
        if ($ending === 'positive' || ($pos > $neg && $pos > $neu)) {
            $sentDot = 'positive';
        } elseif ($ending === 'negative' || ($neg > $pos && $neg > $neu)) {
            $sentDot = 'negative';
        }

        $ids = $cdrIdBag($row);
        $origKey = trim((string)($row['call-orig-call-id'] ?? $row['call-parent-call-id'] ?? ''));
        $parentKey = $origKey !== '' ? $origKey : ($ids !== [] ? $ufFind($ids[0]) : '');
        $legs = [];
        if ($origKey !== '' && isset($legsByOrig[$origKey])) {
            $legs = $legsByOrig[$origKey];
        }
        if ($ids !== []) {
            $root = $ufFind($ids[0]);
            if (isset($legsByRoot[$root])) {
                $legs = array_merge($legs, $legsByRoot[$root]);
            }
        }
        /* Indexed lookup — was findRelatedCdrs($raw, $row), an O(n) rescan. */
        $related = $relatedCdrs($row);
        $byStamp = [];
        foreach (array_merge([$row], $legs, $related) as $leg) {
            if (!is_array($leg)) {
                continue;
            }
            $stamp = implode('|', [
                (string)($leg['id'] ?? ''),
                (string)($leg['call-start-datetime'] ?? ''),
                (string)($leg['call-through-user'] ?? ''),
                (string)($leg['call-term-user'] ?? ''),
            ]);
            $byStamp[$stamp] = $leg;
        }
        $legs = array_values($byStamp);
        $hops = $buildHops($legs);
        if (!$hops) {
            $hops[] = [
                'kind' => 'queue',
                'id' => $through,
                'label' => 'Queue ' . $through,
            ];
            if ($agentExt !== '' && !isset($queueIds[$agentExt])) {
                $hops[] = [
                    'kind' => 'agent',
                    'id' => $agentExt,
                    'label' => 'Agent ' . ($agentNames[$agentExt] ?? $agentExt),
                ];
            }
        }
        $pathParts = [];
        foreach ($hops as $hop) {
            $pathParts[] = (string)$hop['label'];
        }
        $recent[] = [
            'caller' => (string)($row['namenumber'] ?? callFrom($row)),
            'agent' => $agentNames[$agentExt] ?? $agentExt,
            'wait' => $wait,
            'talk' => $talk,
            'sentiment' => $sentDot,
            'reason' => $reason,
            'startedAt' => $startRaw,
            'parentId' => $parentKey,
            'path' => implode(' → ', $pathParts),
            'hops' => $hops,
        ];
    }

    usort($recent, static function (array $a, array $b): int {
        return strcmp((string)$b['startedAt'], (string)$a['startedAt']);
    });
    $recent = array_slice($recent, 0, 200);

    $total = $answered + $abandoned + $missed;
    $offered = $total;

    arsort($topics);
    arsort($reasons);
    $topTopics = [];
    foreach (array_slice($topics, 0, 8, true) as $name => $count) {
        $topTopics[] = ['topic' => (string)$name, 'count' => (int)$count];
    }
    $topReasons = [];
    foreach (array_slice($reasons, 0, 8, true) as $name => $count) {
        $topReasons[] = ['reason' => (string)$name, 'count' => (int)$count];
    }

    $topAgents = [];
    foreach ($byAgent as $row) {
        $n = (int)$row['calls'];
        $topAgents[] = [
            'extension' => $row['extension'],
            'name' => $row['name'],
            'calls' => $n,
            'aht' => $n ? (int)round($row['talk'] / $n) : 0,
            'sentiment' => $row['sentN'] ? round($row['sentiment'] / $row['sentN'], 1) : 0,
        ];
    }
    usort($topAgents, static fn(array $a, array $b): int => $b['calls'] <=> $a['calls']);
    $topAgents = array_slice($topAgents, 0, 10);

    $sidebar = [];
    $waitingTotal = 0;
    $availTotal = 0;
    $agentCountTotal = 0;
    $statusCounts = ['available' => 0, 'oncall' => 0, 'unavailable' => 0, 'offline' => 0];
    $roster = [];
    $queueIndex = [];

    foreach ($queues as $q) {
        $id = trim((string)($q['callqueue'] ?? ''));
        $queueIndex[$id] = $q;
        $waiting = (int)($q['active-queued-calls-total-current'] ?? 0);
        $avail = (int)($q['callqueue-count-agents-available'] ?? 0);
        $totalAgents = (int)($q['callqueue-count-agents-total'] ?? 0);
        $waitingTotal += $waiting;
        $availTotal += $avail;
        $agentCountTotal += $totalAgents;

        $dot = 'ok';
        if ($waiting > 0) {
            $dot = 'busy';
        } elseif ($avail <= 0) {
            $dot = 'empty';
        }

        $sidebar[] = [
            'callqueue' => $id,
            'description' => trim((string)($q['description'] ?? $id)),
            'site' => trim((string)($q['site'] ?? '')),
            'dispatchType' => trim((string)($q['callqueue-dispatch-type'] ?? '')),
            'waiting' => $waiting,
            'agentsAvailable' => $avail,
            'agentsTotal' => $totalAgents,
            'dot' => $dot,
        ];
    }

    foreach ($rosterAgents as $agent) {
        if (!is_array($agent)) {
            continue;
        }
        $aid = trim((string)($agent['callqueue-agent-id'] ?? ''));
        $disp = strtolower(trim((string)($agent['callqueue-agent-availability-for-dispatch'] ?? '')));
        $active = (int)($agent['active-calls-total-current'] ?? 0);
        $registered = $agent['callqueue-agent-has-registered-devices'] ?? false;
        $hasDevice = $registered === true || $registered === 1 || $registered === '1'
            || strtolower((string)$registered) === 'yes'
            || strtolower((string)$registered) === 'true';

        if ($active > 0) {
            $status = 'oncall';
        } elseif (!$hasDevice) {
            $status = 'offline';
        } elseif ($disp === 'available' || $disp === 'ready') {
            $status = 'available';
        } else {
            $status = 'unavailable';
        }
        $statusCounts[$status] = ($statusCounts[$status] ?? 0) + 1;
        $roster[] = [
            'id' => $aid,
            'name' => trim((string)($agent['name-full-name'] ?? $aid)),
            'department' => trim((string)($agent['agent-department'] ?? '')),
            'status' => $status,
            'activeCalls' => $active,
            'lastDispatch' => (string)($agent['last-callqueue-dispatch-datetime'] ?? ''),
        ];
    }

    usort($sidebar, static fn(array $a, array $b): int => strcasecmp($a['description'], $b['description']));
    $selectedMeta = $selectedQueue !== '' ? ($queueIndex[$selectedQueue] ?? null) : null;

    jsonResponse([
        'data' => [
            'queues' => $sidebar,
            'selected' => $selectedQueue,
            'queue' => $selectedMeta ? [
                'callqueue' => (string)($selectedMeta['callqueue'] ?? ''),
                'description' => (string)($selectedMeta['description'] ?? ''),
                'site' => (string)($selectedMeta['site'] ?? ''),
                'dispatchType' => (string)($selectedMeta['callqueue-dispatch-type'] ?? ''),
            ] : null,
            'kpis' => [
                'waiting' => $selectedQueue === '' ? $waitingTotal : (int)($selectedMeta['active-queued-calls-total-current'] ?? 0),
                'agentsAvailable' => $selectedQueue === '' ? $availTotal : (int)($selectedMeta['callqueue-count-agents-available'] ?? 0),
                'agentsTotal' => $selectedQueue === '' ? $agentCountTotal : (int)($selectedMeta['callqueue-count-agents-total'] ?? 0),
                'totalCalls' => $total,
                'avgWait' => $waitN ? (int)round($waitSum / $waitN) : 0,
                'sla' => $waitN ? round(($slaHit / $waitN) * 100, 1) : 0,
                'abandonRate' => $offered ? round(($abandoned / $offered) * 100, 1) : 0,
                'avgTalk' => $talkN ? (int)round($talkSum / $talkN) : 0,
                'answerRate' => $offered ? round(($answered / $offered) * 100, 1) : 0,
                'slaSeconds' => $slaSeconds,
            ],
            'hours' => $hours,
            'outcomes' => [
                'answered' => $answered,
                'abandoned' => $abandoned,
                'missed' => $missed,
            ],
            'agentStatus' => $statusCounts,
            'roster' => $roster,
            'topAgents' => $topAgents,
            'disconnectReasons' => $topReasons,
            'sentiment' => [
                'positive' => $sentN ? round($posSum / $sentN, 1) : 0,
                'neutral' => $sentN ? round($neuSum / $sentN, 1) : 0,
                'negative' => $sentN ? round($negSum / $sentN, 1) : 0,
                'score' => $sentN ? round(($posSum - $negSum) / $sentN, 1) : 0,
                'topics' => $topTopics,
            ],
            'recent' => $recent,
            'queueStats' => array_values(array_map(static function (array $st) use ($slaSeconds): array {
                $n = (int)$st['totalCalls'];
                $waitN = (int)$st['waitN'];
                $talkN = (int)$st['talkN'];
                $abandoned = (int)$st['abandoned'];
                $handled = (int)$st['answered'];
                $offered = $handled + $abandoned;
                return [
                    'callqueue' => $st['callqueue'],
                    'description' => $st['description'],
                    'site' => $st['site'],
                    'totalCalls' => $n,
                    'offered' => $offered,
                    'handled' => $handled,
                    'slaMiss' => (int)$st['slaMiss'],
                    'sla' => $waitN ? round(($st['slaHit'] / $waitN) * 100, 1) : 0,
                    'abandoned' => $abandoned,
                    'abandonRate' => $offered ? round(($abandoned / $offered) * 100, 1) : 0,
                    'avgRing' => $waitN ? (int)round($st['waitSum'] / $waitN) : 0,
                    'maxRing' => (int)$st['waitMax'],
                    'avgTalk' => $talkN ? (int)round($st['talkSum'] / $talkN) : 0,
                    'maxTalk' => (int)$st['talkMax'],
                    'totalTalk' => (int)$st['talkSum'],
                ];
            }, $queueStats)),
        ],
    ]);
} catch (Throwable $e) {
    appExceptionLog('Queues', $e);
    jsonResponse(['error' => 'Unable to load queue data.'], 502);
}
