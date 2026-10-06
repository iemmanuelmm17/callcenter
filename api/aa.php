<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/reporting.php';
require_once __DIR__ . '/../includes/aa_options.php';

requireMethod('POST');

try {

    $user = currentUser();
    requirePageRoles($user, ['office_manager']);

    $domain = trim((string)($user['domain'] ?? ''));

    $requested = readJsonBody();

    $filters = authorizedFilters($requested, $user);

    /*
     * PERF: three-phase load.
     *
     * Phase 1 (rosterOnly=1)
     *   Just the list of auto attendants. No CDRs, no PBX config fetch.
     *   The page renders "Select an auto attendant" from this alone.
     *
     * Phase 2/3 (normal request, optionally scoped by `attendant`)
     *   Overview data and/or the structure tree, computed ONLY for the
     *   selected AA. Computing all of them up front was the bulk of the
     *   cost and almost none of it was ever looked at.
     *
     *   structuresOnly=1 -> return ONLY the structure tree
     *   skipStructures=1 -> return the report without the tree
     *
     * All flags are optional: a caller that sends none gets exactly the
     * old response, so nothing else breaks.
     */
    $rosterOnly     = !empty($requested['rosterOnly']);
    $structuresOnly = !empty($requested['structuresOnly']);

    /*
     * NOTE: structuresOnly must NOT imply skipStructures — that was a
     * bug. It made the structures-only request build an empty tree, so
     * the Structure tab rendered no prompts and no audio at all.
     */
    $skipStructures = !$structuresOnly && !empty($requested['skipStructures']);

    /*
     * Restrict the expensive work to one AA when the UI has a selection.
     * Accepts a single extension or a list.
     */
    $onlyExtensions = [];
    $requestedAttendant = $requested['attendant'] ?? $requested['attendants'] ?? null;
    foreach ((is_array($requestedAttendant) ? $requestedAttendant : [$requestedAttendant]) as $wanted) {
        $wanted = trim((string)$wanted);
        if ($wanted !== '') {
            $onlyExtensions[$wanted] = true;
        }
    }

    $users = cachedUsers($user);

    $aaUsers = [];

    foreach ($users as $item) {
        if (!is_array($item)) {
            continue;
        }

        if (trim((string)($item['service-code'] ?? '')) !== 'system-aa') {
            continue;
        }

        $extension = trim((string)($item['user'] ?? ''));
        if ($extension === '') {
            continue;
        }

        $name = trim(
            (string)($item['name-first-name'] ?? '') . ' ' .
            (string)($item['name-last-name'] ?? '')
        );

        if ($name === '') {
            $name = $extension;
        }

        $aaUsers[$extension] = [
            'extension' => $extension,
            'name' => $name,
            'department' => trim((string)($item['department'] ?? '')),
            'site' => trim((string)($item['site'] ?? '')),
            'totalCalls' => 0,
        ];
    }

    /*
     * =========================================================
     * PHASE 1: ROSTER ONLY
     * =========================================================
     *
     * Returns before touching CDRs or the PBX. This is what the page
     * loads on arrival, so the AA list appears immediately and the main
     * panel can prompt the user to pick one.
     */
    if ($rosterOnly) {

        $roster = array_values($aaUsers);

        usort(
            $roster,
            static function (array $a, array $b): int {
                return strnatcasecmp(
                    (string)$a['extension'],
                    (string)$b['extension']
                );
            }
        );

        jsonResponse([
            'data' => [
                'autoAttendants' => $roster,
                'rosterOnly' => true,
            ],
        ]);
    }

    $aaFilters = $filters;
    $aaFilters['department'] = '';
    $aaFilters['site'] = '';
    $aaFilters['agents'] = [];

    $rawCalls = loadAaCdrs($user, $aaFilters);

    $token = (string)($_SESSION['token'] ?? '');
    $client = new PbxClient($token);

    /*
     * Only resolve config for the AA being viewed. getAaOptions() fetches
     * one PBX configuration per AA, so scoping this to the selection is
     * the single biggest saving on this page.
     *
     * The cache it maintains is domain-wide, so a warm cache still
     * returns everything — the scoping only limits what gets FETCHED.
     */
    $optionUsers = $aaUsers;
    if ($onlyExtensions !== []) {
        $scoped = array_intersect_key($aaUsers, $onlyExtensions);
        if ($scoped !== []) {
            $optionUsers = $scoped;
        }
    }

    $aaCache = ['byPrompt' => [], 'byExtension' => []];
    if (function_exists('getAaOptions')) {
        try {
            $loaded = getAaOptions($domain, $optionUsers, $client);
            if (is_array($loaded)) {
                $aaCache = $loaded;
            }
        } catch (Throwable $e) {
            appExceptionLog('AA options', $e);
        }
    }

    $byPrompt = is_array($aaCache['byPrompt'] ?? null)
        ? $aaCache['byPrompt']
        : [];

    $byExtension = is_array($aaCache['byExtension'] ?? null)
        ? $aaCache['byExtension']
        : [];

    foreach ($aaUsers as $ext => &$aaUser) {
        $promptName = '';
        $listed = $byExtension[$ext] ?? $byExtension[(string)$ext] ?? [];
        if (is_array($listed)) {
            foreach ($listed as $pid) {
                $pid = trim((string)$pid);
                $pd = $byPrompt[$pid] ?? $byPrompt[strtolower($pid)] ?? [];
                $parent = is_array($pd)
                    ? trim((string)($pd['parent-prompt'] ?? ''))
                    : '';
                if ($pid !== '' && $parent === '') {
                    $promptName = $pid;
                    break;
                }
            }
            if ($promptName === '' && $listed) {
                $promptName = trim((string)$listed[0]);
            }
        }

        $promptData = null;
        if ($promptName !== '') {
            $promptData = $byPrompt[$promptName]
                ?? $byPrompt[strtolower($promptName)]
                ?? null;
        }

        if (!is_array($promptData)) {
            foreach ($byPrompt as $pd) {
                if (!is_array($pd)) {
                    continue;
                }
                $owner = trim((string)(
                    $pd['_extension'] ?? $pd['extension'] ?? $pd['user'] ?? ''
                ));
                if ($owner === (string)$ext) {
                    $promptData = $pd;
                    break;
                }
            }
        }

        $audio = is_array($promptData['audio'] ?? null)
            ? $promptData['audio']
            : [];

        $audioUrl = html_entity_decode(
            trim((string)($audio['file-access-url'] ?? '')),
            ENT_QUOTES | ENT_HTML5,
            'UTF-8'
        );

        $aaUser['startingPrompt'] = $promptName !== ''
            ? $promptName
            : trim((string)($promptData['starting-prompt'] ?? ''));
        $aaUser['audioUrl'] = $audioUrl;
        $aaUser['audioFilename'] = trim((string)($audio['filename'] ?? ''));
        $aaUser['audioDuration'] = (int)($audio['file-duration-seconds'] ?? 0);
    }
    unset($aaUser);

    $aaExtensions = array_keys($aaUsers);
    usort(
        $aaExtensions,
        static function ($a, $b): int {
            $a = (string)$a;
            $b = (string)$b;
            $lengthA = strlen($a);
            $lengthB = strlen($b);
            if ($lengthA !== $lengthB) {
                return $lengthB <=> $lengthA;
            }
            return strnatcasecmp($a, $b);
        }
    );

    $promptOwner = [];
    foreach ($byPrompt as $promptKey => $promptData) {
        if (!is_array($promptData)) {
            continue;
        }
        $promptExtension = trim((string)(
            $promptData['_extension']
            ?? $promptData['extension']
            ?? $promptData['user']
            ?? ''
        ));
        if ($promptExtension === '') {
            continue;
        }
        $promptOwner[(string)$promptKey] = $promptExtension;
        $promptOwner[strtolower((string)$promptKey)] = $promptExtension;
    }

    $cdrStart = static function (array $cdr): int {
        $raw = (string)(
            $cdr['call-start-datetime']
            ?? $cdr['call-answer-datetime']
            ?? ''
        );
        if ($raw === '') {
            return 0;
        }
        $ts = strtotime($raw);
        return $ts === false ? 0 : $ts;
    };

    $promptCaseBuckets = [];

    foreach ($rawCalls as $index => $cdr) {
        if (!is_array($cdr)) {
            continue;
        }

        $cdrUri = trim((string)($cdr['call-term-pre-routing-uri'] ?? ''));

        if (!preg_match('/^(Prompt_\d+)\.Case_(\d+)$/i', $cdrUri, $matches)) {
            continue;
        }

        $start = $cdrStart($cdr);
        if ($start === 0) {
            continue;
        }

        $caller = trim((string)($cdr['call-orig-caller-id'] ?? ''));
        $bucketKey = strtolower($matches[1]) . "\0" . $caller;

        $promptCaseBuckets[$bucketKey][] = [
            'index' => $index,
            'case' => (string)$matches[2],
            'start' => $start,
        ];
    }

    foreach ($promptCaseBuckets as &$bucket) {
        usort(
            $bucket,
            static function (array $a, array $b): int {
                return $a['start'] <=> $b['start'];
            }
        );
    }
    unset($bucket);

    $mergedCdrIndexes = [];
    $additionalMergeMap = [];

    foreach ($rawCalls as $sourceIndex => $sourceCall) {
        if (!is_array($sourceCall)) {
            continue;
        }

        $additionalTier = extractDtmfCase($sourceCall);
        if ($additionalTier === '') {
            continue;
        }

        $extension = trim((string)($sourceCall['call-through-user'] ?? ''));
        if ($extension === '' || !isset($aaUsers[$extension])) {
            continue;
        }

        $additionalPath = resolveAaAdditionalTier(
            $aaCache,
            $extension,
            $additionalTier
        );

        $additionalPrompt = trim((string)($additionalPath['prompt'] ?? ''));
        if ($additionalPrompt === '') {
            continue;
        }

        $sourceCaller = trim((string)($sourceCall['call-orig-caller-id'] ?? ''));
        if ($sourceCaller === '') {
            continue;
        }

        $sourceStart = $cdrStart($sourceCall);
        if ($sourceStart === 0) {
            continue;
        }

        $owner = $promptOwner[$additionalPrompt]
            ?? $promptOwner[strtolower($additionalPrompt)]
            ?? null;

        if ($owner !== $extension) {
            continue;
        }

        $bucketKey = strtolower($additionalPrompt) . "\0" . $sourceCaller;
        $candidates = $promptCaseBuckets[$bucketKey] ?? [];
        if ($candidates === []) {
            continue;
        }

        $windowEnd = $sourceStart + 600;
        $bestCandidate = null;

        foreach ($candidates as $candidate) {
            $candidateStart = (int)$candidate['start'];
            if ($candidateStart <= $sourceStart) {
                continue;
            }
            if ($candidateStart > $windowEnd) {
                break;
            }

            $candidateIndex = $candidate['index'];
            if ($candidateIndex === $sourceIndex) {
                continue;
            }
            if (isset($mergedCdrIndexes[$candidateIndex])) {
                continue;
            }

            $bestCandidate = $candidate;
            break;
        }

        if ($bestCandidate === null) {
            continue;
        }

        $candidateIndex = $bestCandidate['index'];
        $additionalCall = $rawCalls[$candidateIndex] ?? null;
        if (!is_array($additionalCall)) {
            continue;
        }

        $mergedCdrIndexes[$candidateIndex] = true;

        $additionalMergeMap[$sourceIndex] = [
            'candidateIndex' => $candidateIndex,
            'additionalCase' => (string)($bestCandidate['case'] ?? ''),
            'additionalCall' => $additionalCall,
        ];
    }

    $grouped = [];
    $calls = [];

    foreach ($rawCalls as $index => $call) {
        if (!is_array($call)) {
            continue;
        }

        if (isset($mergedCdrIndexes[$index])) {
            continue;
        }

        $uri = trim((string)($call['call-term-pre-routing-uri'] ?? ''));
        $throughUser = trim((string)($call['call-through-user'] ?? ''));

        $extension = '';
        $prompt = '';
        $case = '';

        if ($throughUser !== '' && isset($aaUsers[$throughUser])) {
            $extension = $throughUser;
        }

        if (preg_match('/^(Prompt_\d+)(?:\.Case_(\d+))?/i', $uri, $matches)) {
            $prompt = $matches[1];
            if (isset($matches[2])) {
                $case = (string)$matches[2];
            }

            $promptExtension = $promptOwner[$prompt]
                ?? $promptOwner[strtolower($prompt)]
                ?? '';

            if ($promptExtension !== '' && isset($aaUsers[$promptExtension])) {
                $extension = $promptExtension;
            }
        }

        if ($extension === '' && $prompt !== '') {
            if (preg_match('/^Prompt_(\d+)/i', $prompt, $matches)) {
                $promptNumber = $matches[1];
                foreach ($aaExtensions as $aaExtension) {
                    $aaExtension = (string)$aaExtension;
                    if (strncmp($promptNumber, $aaExtension, strlen($aaExtension)) === 0) {
                        $extension = $aaExtension;
                        break;
                    }
                }
            }
        }

        if ($extension === '') {
            continue;
        }

        $additionalTier = extractDtmfCase($call);

        $aaPath = resolveAaCallPath($aaCache, $prompt, $case);

        $additionalPath = resolveAaAdditionalTier(
            $aaCache,
            $extension,
            $additionalTier
        );

        $additionalPrompt = trim((string)($additionalPath['prompt'] ?? ''));

        $additionalCase = '';
        $additionalCall = null;

        $additionalMerge = $additionalMergeMap[$index] ?? null;
        if (is_array($additionalMerge)) {
            $additionalCase = (string)($additionalMerge['additionalCase'] ?? '');
            $additionalCall = $additionalMerge['additionalCall'] ?? null;
        }

        $displayCase = $case !== '' ? $case : $additionalTier;

        $queue = $throughUser !== '' ? $throughUser : '-';

        $destination = trim((string)($call['call-term-user'] ?? ''));
        if ($destination === '') {
            $destination = '-';
        }

        if (is_array($additionalCall)) {
            $additionalQueue = trim((string)($additionalCall['call-through-user'] ?? ''));
            if ($additionalQueue !== '') {
                $queue = $additionalQueue;
            }

            $additionalDestination = trim((string)($additionalCall['call-term-user'] ?? ''));
            if ($additionalDestination !== '') {
                $destination = $additionalDestination;
            }
        }

        $start = $call['call-start-datetime']
            ?? $call['call-answer-datetime']
            ?? '';

        $talkSeconds = seconds($call, 'call-talking-duration-seconds');
        $totalSeconds = seconds($call, 'call-total-duration-seconds');

        if (is_array($additionalCall)) {
            $talkSeconds += seconds($additionalCall, 'call-talking-duration-seconds');
            $totalSeconds += seconds($additionalCall, 'call-total-duration-seconds');
        }

        $calls[] = [
            'id' => $call['id'] ?? '',
            'extension' => $extension,
            'prompt' => $prompt,
            'case' => $displayCase,
            'additionalTier' => $additionalTier,
            'additionalPrompt' => $additionalPrompt,
            'additionalCase' => $additionalCase,
            'additionalDescription' => $additionalPath['description'] ?? '',
            'additionalDestinationApplication' => $additionalPath['destinationApplication'] ?? '',
            'additionalDestinationUser' => $additionalPath['destinationUser'] ?? '',
            'optionDescription' => $aaPath['optionDescription'] ?? '',
            'destinationApplication' => $aaPath['destinationApplication'] ?? '',
            'destinationUser' => $aaPath['destinationUser'] ?? '',
            'nextPrompt' => $aaPath['nextPrompt'] ?? '',
            'caller' => (string)($call['call-orig-caller-id'] ?? ''),
            'queue' => $queue,
            'throughUser' => $throughUser,
            'termUser' => trim((string)($call['call-term-user'] ?? '')),
            'destination' => $destination,
            'abandoned' => $throughUser !== '' && $destination !== '-' && $throughUser === $destination,
            'totalSeconds' => $totalSeconds,
            'start' => $start,
            'disconnectReason' => (string)($call['call-disconnect-reason-text'] ?? ''),
            '_server' => $call['_server'] ?? '',
        ];

        $key = $extension . '|' . $displayCase . '|' . $additionalTier . '|' .
            $additionalCase . '|' . $queue . '|' . $destination;

        if (!isset($grouped[$key])) {
            $grouped[$key] = [
                'extension' => $extension,
                'name' => $aaUsers[$extension]['name'],
                'case' => $displayCase,
                'additionalTier' => $additionalTier,
                'additionalPrompt' => $additionalPrompt,
                'additionalCase' => $additionalCase,
                'additionalDescription' => $additionalPath['description'] ?? '',
                'additionalDestinationApplication' => $additionalPath['destinationApplication'] ?? '',
                'additionalDestinationUser' => $additionalPath['destinationUser'] ?? '',
                'queue' => $queue,
                'destination' => $destination,
                'calls' => 0,
                'talkSeconds' => 0,
            ];
        }

        $grouped[$key]['calls']++;
        $grouped[$key]['talkSeconds'] += $talkSeconds;
    }

    $rows = array_values($grouped);

    foreach ($rows as $row) {
        $extension = trim((string)($row['extension'] ?? ''));
        if ($extension === '' || !isset($aaUsers[$extension])) {
            continue;
        }
        $aaUsers[$extension]['totalCalls'] += (int)($row['calls'] ?? 0);
    }

    usort(
        $rows,
        static function (array $a, array $b): int {
            $result = strnatcasecmp((string)$a['extension'], (string)$b['extension']);
            if ($result !== 0) {
                return $result;
            }
            $result = strnatcasecmp((string)$a['case'], (string)$b['case']);
            if ($result !== 0) {
                return $result;
            }
            $result = strnatcasecmp(
                (string)($a['additionalTier'] ?? ''),
                (string)($b['additionalTier'] ?? '')
            );
            if ($result !== 0) {
                return $result;
            }
            $result = strnatcasecmp(
                (string)($a['additionalCase'] ?? ''),
                (string)($b['additionalCase'] ?? '')
            );
            if ($result !== 0) {
                return $result;
            }
            $result = strnatcasecmp((string)$a['queue'], (string)$b['queue']);
            if ($result !== 0) {
                return $result;
            }
            return strnatcasecmp((string)$a['destination'], (string)$b['destination']);
        }
    );

    usort(
        $calls,
        static function (array $a, array $b): int {
            return strcmp((string)($b['start'] ?? ''), (string)($a['start'] ?? ''));
        }
    );

    $aaUsers = array_values($aaUsers);

    usort(
        $aaUsers,
        static function (array $a, array $b): int {
            return strnatcasecmp((string)$a['extension'], (string)$b['extension']);
        }
    );

    auditView($user, $filters, 'auto_attendants');

    $structures = [];

    /*
     * Build only what is needed: nothing when deferred, otherwise just
     * the selected AA (or all of them when no selection was sent).
     */
    $structureUsers = $skipStructures ? [] : $aaUsers;
    if ($structureUsers !== [] && $onlyExtensions !== []) {
        $scopedStructures = array_intersect_key($structureUsers, $onlyExtensions);
        if ($scopedStructures !== []) {
            $structureUsers = $scopedStructures;
        }
    }

    foreach ($structureUsers as $aaUser) {
        if (!is_array($aaUser)) {
            continue;
        }
        $ext = (string)($aaUser['extension'] ?? '');
        if ($ext === '') {
            continue;
        }

        $promptIds = [];

        /*
         * BUGFIX: match the defensive lookup used earlier in this file.
         * PHP turns numeric-string array keys into ints, and this map has
         * been through a JSON cache round-trip, so try both spellings
         * rather than assuming one.
         */
        $listed = $byExtension[$ext]
            ?? $byExtension[(string)$ext]
            ?? (ctype_digit($ext) ? ($byExtension[(int)$ext] ?? []) : []);

        if (is_array($listed)) {
            foreach ($listed as $pid) {
                $pid = trim((string)$pid);
                if ($pid !== '') {
                    $promptIds[$pid] = true;
                }
            }
        }
        foreach ($byPrompt as $pid => $pd) {
            if (!is_array($pd)) {
                continue;
            }
            $owner = trim((string)($pd['_extension'] ?? $pd['extension'] ?? $pd['user'] ?? ''));
            if ($owner === $ext) {
                $promptIds[(string)$pid] = true;
            }
        }

        /*
         * BUGFIX: last-resort fallback for "has a prompt but shows none".
         *
         * getAaList() indexes by starting-prompt and drops rows without
         * one, so an AA can be absent from byExtension while its prompt
         * data is present in byPrompt (e.g. multi-timeframe attendants,
         * where only one timeframe is indexed). Recover by matching the
         * prompt id against the extension, which is how the PBX names
         * them: extension 8002 -> Prompt_800201.
         */
        if ($promptIds === []) {
            $startingPrompt = trim((string)($aaUser['startingPrompt'] ?? ''));
            if ($startingPrompt !== '' && isset($byPrompt[$startingPrompt])) {
                $promptIds[$startingPrompt] = true;
            }

            if ($promptIds === []) {
                foreach ($byPrompt as $pid => $pd) {
                    $pidStr = (string)$pid;
                    if (stripos($pidStr, $ext) !== false) {
                        $promptIds[$pidStr] = true;
                    }
                }
            }
        }

        $prompts = [];
        foreach (array_keys($promptIds) as $pid) {
            $pd = $byPrompt[$pid] ?? $byPrompt[strtolower($pid)] ?? [];
            if (!is_array($pd)) {
                $pd = [];
            }
            $audio = is_array($pd['audio'] ?? null) ? $pd['audio'] : [];
            $optionsIn = is_array($pd['options'] ?? null) ? $pd['options'] : [];
            $options = [];
            foreach ($optionsIn as $digit => $opt) {
                if (!is_array($opt)) {
                    continue;
                }
                $options[] = [
                    'digit' => (string)$digit,
                    'description' => trim((string)($opt['description'] ?? $opt['option-description'] ?? '')),
                    'destinationApplication' => trim((string)(
                        $opt['destination-application']
                        ?? $opt['destinationApplication']
                        ?? $opt['application']
                        ?? ''
                    )),
                    'destinationUser' => trim((string)(
                        $opt['destination-user']
                        ?? $opt['destinationUser']
                        ?? $opt['user']
                        ?? ''
                    )),
                    'nextPrompt' => trim((string)(
                        $opt['next-prompt']
                        ?? $opt['nextPrompt']
                        ?? $opt['prompt']
                        ?? ''
                    )),
                ];
            }
            usort($options, static function (array $a, array $b): int {
                return strnatcasecmp($a['digit'], $b['digit']);
            });
            $prompts[] = [
                'id' => (string)$pid,
                'name' => trim((string)($pd['attendant-name'] ?? $pd['name'] ?? $pid)),
                'starting' => trim((string)($pd['starting-prompt'] ?? '')) === (string)$pid
                    || trim((string)($aaUser['startingPrompt'] ?? '')) === (string)$pid,
                'parentPrompt' => trim((string)($pd['parent-prompt'] ?? $pd['parentPrompt'] ?? '')),
                'parentOption' => trim((string)($pd['parent-option'] ?? $pd['parentOption'] ?? '')),
                'audioUrl' => html_entity_decode(trim((string)($audio['file-access-url'] ?? '')), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
                'audioFilename' => trim((string)($audio['filename'] ?? '')),
                'audioDuration' => (int)($audio['file-duration-seconds'] ?? 0),
                'options' => $options,
            ];
        }

        $structures[$ext] = [
            'extension' => $ext,
            'name' => (string)($aaUser['name'] ?? $ext),
            'startingPrompt' => (string)($aaUser['startingPrompt'] ?? ''),
            'prompts' => $prompts,
        ];
    }

    /*
     * Structure-tab request: return just the tree. The caller already
     * has the report from the initial load, so re-sending it would
     * double the payload for no reason.
     */
    if ($structuresOnly) {
        jsonResponse([
            'data' => [
                'structures' => $structures,
            ],
        ]);
    }

    jsonResponse([
        'data' => [
            'autoAttendants' => $aaUsers,
            'rows' => $rows,
            'calls' => $calls,
            /*
             * Omitted (not empty) when deferred, so the client can tell
             * "not fetched yet" from "genuinely no structures".
             */
            'structures' => $skipStructures ? null : $structures,
            'structuresDeferred' => $skipStructures,
        ],
    ]);

} catch (Throwable $e) {

    appExceptionLog('Auto Attendants', $e);

    jsonResponse(
        [
            'error' => 'Unable to load auto attendants.',
        ],
        502
    );
}
