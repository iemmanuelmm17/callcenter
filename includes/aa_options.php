<?php
declare(strict_types=1);

require_once 'aa_list.php';


/*
 * =============================================================
 * SETTINGS
 * =============================================================
 */

const AA_OPTIONS_CACHE_TTL = 3600;

/*
 * PERF: debug logging switch.
 *
 * The rebuild path logged on every auto attendant (and dumped the whole
 * AA list as JSON), which is synchronous file I/O inside the hot loop.
 * Useful while this was being built; now it is opt-in.
 *
 * Enable with AA_DEBUG=1 in the environment, or by defining
 * AA_DEBUG_LOG before this file is included.
 */
if (!defined('AA_DEBUG_LOG')) {
    define('AA_DEBUG_LOG', (string)getenv('AA_DEBUG') === '1');
}

/*
 * Debug-only logger. Real errors keep using appLog() directly so they
 * are never silenced by the flag.
 */
function aaDebugLog(string $message): void
{
    if (AA_DEBUG_LOG) {
        appLog($message);
    }
}

/*
 * =============================================================
 * CACHE FILE
 * =============================================================
 */

function aaOptionsCacheFile(
    string $domain
): string {

    $directory =
        __DIR__ .
        '/../cache/aa';


    if (
        !is_dir($directory)
    ) {

        if (
            !mkdir(
                $directory,
                0775,
                true
            ) &&
            !is_dir($directory)
        ) {

            throw new RuntimeException(
                'Unable to create AA cache directory'
            );
        }
    }


    $safeDomain =
        preg_replace(
            '/[^a-zA-Z0-9._-]/',
            '_',
            $domain
        );


    if (
        $safeDomain === null ||
        $safeDomain === ''
    ) {

        $safeDomain = 'default';
    }


    return $directory .
        DIRECTORY_SEPARATOR .
        $safeDomain .
        '.json';
}


/*
 * =============================================================
 * LOAD CACHE
 * =============================================================
 */

function loadAaOptionsCache(
    string $domain
): ?array {

    $file =
        aaOptionsCacheFile(
            $domain
        );


    if (
        !is_file($file)
    ) {

        return null;
    }


    if (
        (time() - filemtime($file))
        >= AA_OPTIONS_CACHE_TTL
    ) {

        return null;
    }


    $json =
        file_get_contents(
            $file
        );


    if (
        $json === false ||
        trim($json) === ''
    ) {

        return null;
    }


    $data =
        json_decode(
            $json,
            true
        );


    if (
        !is_array($data)
    ) {

        return null;
    }


    return $data;
}


/*
 * =============================================================
 * SAVE CACHE
 * =============================================================
 */

function saveAaOptionsCache(
    string $domain,
    array $data
): void {

    $file = aaOptionsCacheFile($domain);

    aaDebugLog('AA CACHE SAVE FILE=' . $file);

    $dir = dirname($file);

    if (!is_dir($dir)) {

        aaDebugLog('AA CACHE DIRECTORY DOES NOT EXIST=' . $dir);

        if (!mkdir($dir, 0775, true)) {
            appLog(
                'AA CACHE mkdir FAILED: ' .
                $dir
            );

            return;
        }

        aaDebugLog(
            'AA CACHE DIRECTORY CREATED=' .
            $dir
        );
    }

    $json = json_encode(
        $data,
        JSON_PRETTY_PRINT |
        JSON_UNESCAPED_SLASHES
    );

    if ($json === false) {

        appLog(
            'AA CACHE JSON ENCODE FAILED: ' .
            json_last_error_msg()
        );

        return;
    }

    $tmp = $file . '.tmp';

    $result = file_put_contents(
        $tmp,
        $json,
        LOCK_EX
    );

    aaDebugLog(
        'AA CACHE file_put_contents result=' .
        var_export($result, true)
    );

    if ($result === false) {

        appLog(
            'AA CACHE WRITE FAILED: ' .
            $tmp
        );

        return;
    }

    if (!rename($tmp, $file)) {

        appLog(
            'AA CACHE RENAME FAILED: ' .
            $tmp .
            ' -> ' .
            $file
        );

        return;
    }

    aaDebugLog(
        'AA CACHE SAVED SUCCESSFULLY=' .
        $file
    );
}

/*
 * =============================================================
 * NORMALIZE OPTIONS
 * =============================================================
 *
 * Converts:
 *
 *     option-1
 *     option-2
 *     option-7
 *
 * into:
 *
 *     1
 *     2
 *     7
 *
 * while preserving the complete option data.
 *
 */

function normalizeAaOptions(
    array $configuration
): array {

    $options = [];


    $aa =
        $configuration['auto-attendant']
        ?? null;


    if (
        !is_array($aa)
    ) {

        return $options;
    }


    foreach (
        $aa as $key => $option
    ) {

        if (
            !preg_match(
                '/^option-(\d+)$/i',
                (string)$key,
                $matches
            )
        ) {

            continue;
        }


        if (
            !is_array($option)
        ) {

            continue;
        }


        $digit =
            (string)$matches[1];


        $options[$digit] =
            $option;
    }


    return $options;
}


/*
 * =============================================================
 * ADD NESTED AA LINKS
 * =============================================================
 *
 * If an option contains another Auto Attendant,
 * add the prompt that the option opens.
 *
 * Example:
 *
 * option-7
 *     auto-attendant
 *     audio.ordinal-order = 800431
 *
 * becomes:
 *
 * option 7
 *     nextPrompt = Prompt_800431
 *
 */

function addNestedAaLinks(
    array &$configuration
): void {

    if (
        !isset(
            $configuration['options']
        ) ||
        !is_array(
            $configuration['options']
        )
    ) {

        return;
    }


    foreach (
        $configuration['options']
        as $digit => &$option
    ) {

        if (
            !is_array($option)
        ) {

            continue;
        }


        $nestedAa =
            $option['auto-attendant']
            ?? null;


        if (
            !is_array($nestedAa)
        ) {

            continue;
        }


        $audio =
            $option['audio']
            ?? null;


        if (
            !is_array($audio)
        ) {

            continue;
        }


        $ordinal =
            trim(
                (string)(
                    $audio['ordinal-order']
                    ?? ''
                )
            );


        if (
            $ordinal === ''
        ) {

            continue;
        }


        $option['nextPrompt'] =
            'Prompt_' .
            $ordinal;
    }


    unset($option);
}


/*
 * =============================================================
 * FIND NESTED PROMPTS
 * =============================================================
 *
 * Recursively discovers nested Auto Attendants.
 *
 * Example:
 *
 * Prompt_800201
 *     option-7
 *         auto-attendant
 *         audio.ordinal-order = 800431
 *
 * becomes:
 *
 * Prompt_800431
 *     parent-prompt = Prompt_800201
 *     parent-option = 7
 *
 */

function collectNestedAaPrompts(
    array $configuration,
    string $rootExtension,
    string $parentPrompt = '',
    string $parentOption = ''
): array {

    $result = [];


    $aa =
        $configuration['auto-attendant']
        ?? null;


    if (
        !is_array($aa)
    ) {

        return $result;
    }


    foreach (
        $aa as $key => $option
    ) {

        if (
            !preg_match(
                '/^option-(\d+)$/i',
                (string)$key,
                $matches
            )
        ) {

            continue;
        }


        if (
            !is_array($option)
        ) {

            continue;
        }


        $digit =
            (string)$matches[1];


        /*
         * =====================================================
         * CHECK FOR NESTED AUTO ATTENDANT
         * =====================================================
         */

        $nestedAa =
            $option['auto-attendant']
            ?? null;


        if (
            !is_array($nestedAa)
        ) {

            continue;
        }


        /*
         * =====================================================
         * GET AUDIO
         * =====================================================
         */

        $audio =
            $option['audio']
            ?? null;


        if (
            !is_array($audio)
        ) {

            continue;
        }


        /*
         * =====================================================
         * GET ORDINAL
         * =====================================================
         *
         * This comes directly from the PBX configuration.
         *
         */

        $ordinal =
            trim(
                (string)(
                    $audio['ordinal-order']
                    ?? ''
                )
            );


        if (
            $ordinal === ''
        ) {

            continue;
        }


        $prompt =
            'Prompt_' .
            $ordinal;


        /*
         * =====================================================
         * BUILD NESTED CONFIGURATION
         * =====================================================
         *
         * IMPORTANT:
         *
         * The current option is the parent option.
         *
         * Example:
         *
         * Prompt_800201
         *     option 7
         *         -> Prompt_800431
         *
         * Therefore Prompt_800431 gets:
         *
         * parent-prompt = Prompt_800201
         * parent-option = 7
         *
         */

        $nestedConfiguration = [

            'user' =>
                $rootExtension,

            'starting-prompt' =>
                $prompt,

            'parent-prompt' =>
                $parentPrompt,

            'parent-option' =>
                $digit,

            'audio' =>
                $audio,

            'auto-attendant' =>
                $nestedAa
        ];


        /*
         * =====================================================
         * NORMALIZE NESTED OPTIONS
         * =====================================================
         */

        $nestedConfiguration['options'] =
            normalizeAaOptions(
                $nestedConfiguration
            );


        /*
         * Add nextPrompt to nested options.
         */

        addNestedAaLinks(
            $nestedConfiguration
        );


        /*
         * =====================================================
         * INTERNAL METADATA
         * =====================================================
         */

        $nestedConfiguration['_extension'] =
            $rootExtension;

        $nestedConfiguration['_prompt'] =
            $prompt;


        /*
         * =====================================================
         * ADD NESTED PROMPT
         * =====================================================
         */

        $result[$prompt] =
            $nestedConfiguration;


        /*
         * =====================================================
         * RECURSE
         * =====================================================
         *
         * If this nested AA contains another AA,
         * THIS prompt becomes the parent.
         *
         * Example:
         *
         * Prompt_800431
         *     option 3
         *         -> Prompt_800999
         *
         * Then:
         *
         * Prompt_800999
         *     parent-prompt = Prompt_800431
         *     parent-option = 3
         *
         */

        $children =
            collectNestedAaPrompts(
                $nestedConfiguration,
                $rootExtension,
                $prompt,
                $digit
            );


        foreach (
            $children as $childPrompt => $child
        ) {

            if (
                isset(
                    $result[$childPrompt]
                )
            ) {

                continue;
            }


            $result[$childPrompt] =
                $child;
        }
    }


    return $result;
}


/*
 * =============================================================
 * BUILD AA CACHE
 * =============================================================
 */

/*
 * =============================================================
 * CACHE COVERAGE
 * =============================================================
 *
 * True when the cached index already holds an entry for every auto
 * attendant the caller asked about.
 *
 * Needed because getAaOptions() can now be called with a subset of the
 * domain (the AA dashboard scopes the fetch to the selected attendant),
 * while the cache file itself is shared by the whole domain.
 *
 * NOTE: PHP casts all-numeric array keys to int, and this map has been
 * through a JSON round-trip, so compare as strings rather than relying
 * on isset() with a string subscript.
 */
function aaCacheCovers(
    array $cached,
    array $aaUsers
): bool {

    $byExtension = is_array($cached['byExtension'] ?? null)
        ? $cached['byExtension']
        : [];

    $fetchedAt = is_array($cached['fetchedAt'] ?? null)
        ? $cached['fetchedAt']
        : [];

    $now = time();

    $have = [];

    foreach (array_keys($byExtension) as $cachedExtension) {

        /*
         * An entry with no timestamp predates per-entry ageing (a cache
         * file written by the previous version). The file-level TTL in
         * loadAaOptionsCache() already vouched for it, so accept it.
         */
        if (isset($fetchedAt[$cachedExtension])
            && ($now - (int)$fetchedAt[$cachedExtension]) >= AA_OPTIONS_CACHE_TTL
        ) {
            continue;
        }

        $have[trim((string)$cachedExtension)] = true;
    }

    foreach (array_keys($aaUsers) as $wantedExtension) {

        $wantedExtension = trim((string)$wantedExtension);

        if ($wantedExtension === '') {
            continue;
        }

        if (!isset($have[$wantedExtension])) {
            return false;
        }
    }

    return true;
}


function getAaOptions(
    string $domain,
    array $aaUsers,
    PbxClient $client
): array {

    /*
     * =========================================================
     * 1. CHECK CACHE
     * =========================================================
     */

    $cached =
        loadAaOptionsCache(
            $domain
        );

    /*
     * The cache file is DOMAIN-wide, but the caller may only have asked
     * for a subset of the domain's auto attendants. Serving a partial
     * cache to a request for an AA that is not in it renders that AA
     * with no prompts at all, so only accept the cache when it actually
     * covers every extension being asked for.
     *
     * BUGFIX: a scoped rebuild used to overwrite the whole-domain cache
     * with a single AA, and every other attendant then showed
     * "No prompt map is available" for the rest of the cache TTL.
     */
    if (
        $cached !== null &&
        aaCacheCovers($cached, $aaUsers)
    ) {
        return $cached;
    }

    /*
     * Partial hit: keep what is already known so the rebuild ADDS to it
     * instead of replacing it.
     */
    $existing = is_array($cached) ? $cached : [];


    /*
     * =========================================================
     * 2. GET DOMAIN AA LIST
     *
     * This is now the authoritative source for:
     *
     *   extension -> starting prompt
     *
     * Example:
     *
     *   8002 -> Prompt_800201
     * =========================================================
     */

    $aaList =
        getAaList(
            $domain,
            $client
        );


aaDebugLog(
    'AA DEBUG: AA LIST RESULT=' .
    json_encode(
        $aaList,
        JSON_UNESCAPED_SLASHES
    )
);

aaDebugLog(
    'AA DEBUG: AA USERS COUNT=' .
    count($aaUsers)
);

    /*
     * =========================================================
     * 3. CACHE EXPIRED / MISSING
     * =========================================================
     */

    $byExtension = [];

    $byPrompt = [];


    /*
     * =========================================================
     * 3b. RESOLVE STARTING PROMPTS, THEN FETCH IN PARALLEL
     * =========================================================
     *
     * PERF: this used to be one blocking $client->autoAttendants()
     * call per AA inside the loop below - N serial PBX round-trips
     * before the dashboard could show anything (~180 ms x 40 AAs
     * = ~7 s on a cold cache).
     *
     * Resolving the starting prompt is pure array lookup, so it is
     * hoisted here and every configuration is fetched concurrently in
     * bounded batches. The processing loop below is unchanged: it now
     * reads from $configurations instead of making a request.
     */
    $startingPrompts = [];

    /*
     * job key -> ['extension' => ..., 'prompt' => ...]
     *
     * A day/night attendant has one starting prompt PER TIMEFRAME and
     * they must all be fetched, so jobs are keyed "extension|prompt"
     * rather than by extension alone (which could only ever hold one).
     */
    $promptJobs = [];

    foreach ($aaUsers as $lookupExtension => $lookupUser) {

        $lookupExtension = trim((string)$lookupExtension);

        if ($lookupExtension === '') {
            continue;
        }

        $lookupDefinition = $aaList[$lookupExtension] ?? null;

        if (!is_array($lookupDefinition)) {
            continue;
        }

        /*
         * Prefer the full list added by getAaList(); fall back to the
         * single scalar so an older/cached AA list still works.
         */
        $lookupPrompts = is_array($lookupDefinition['startingPrompts'] ?? null)
            ? $lookupDefinition['startingPrompts']
            : [];

        if ($lookupPrompts === []) {
            $lookupPrompts = [
                (string)($lookupDefinition['startingPrompt'] ?? '')
            ];
        }

        foreach ($lookupPrompts as $lookupPrompt) {

            $lookupPrompt = trim((string)$lookupPrompt);

            if ($lookupPrompt === '') {
                continue;
            }

            $jobKey = $lookupExtension . '|' . $lookupPrompt;

            $startingPrompts[$jobKey] = $lookupPrompt;

            $promptJobs[$jobKey] = [
                'extension' => $lookupExtension,
                'prompt'    => $lookupPrompt,
            ];
        }
    }

    $configurations = [];

    if ($startingPrompts !== []) {

        $aaConcurrency = defined('AA_FETCH_CONCURRENCY')
            ? (int)AA_FETCH_CONCURRENCY
            : 6;

        try {

            if (method_exists($client, 'autoAttendantsBatch')) {

                /*
                 * autoAttendantsBatch() builds its request path from the
                 * ARRAY KEY, so it can only carry one prompt per
                 * extension per call.
                 *
                 * Jobs are therefore dealt into ROUNDS: round 1 takes
                 * each extension's first prompt, round 2 the second, and
                 * so on. Every round is still fetched fully in parallel,
                 * and since the overwhelming majority of attendants have
                 * a single timeframe there is normally exactly one round
                 * - i.e. identical to the previous behaviour.
                 *
                 * Keeping the batch signature untouched also means an
                 * already-deployed PbxClient.php keeps working.
                 */
                $rounds = [];

                foreach ($promptJobs as $jobKey => $job) {

                    $roundIndex = 0;

                    while (isset($rounds[$roundIndex][$job['extension']])) {
                        $roundIndex++;
                    }

                    $rounds[$roundIndex][$job['extension']] = $jobKey;
                }

                foreach ($rounds as $round) {

                    $roundPrompts = [];

                    foreach ($round as $roundExtension => $jobKey) {
                        $roundPrompts[$roundExtension] =
                            $promptJobs[$jobKey]['prompt'];
                    }

                    $batchResult = $client->autoAttendantsBatch(
                        $domain,
                        $roundPrompts,
                        $aaConcurrency
                    );

                    if (!is_array($batchResult)) {
                        continue;
                    }

                    foreach ($round as $roundExtension => $jobKey) {
                        if (isset($batchResult[$roundExtension])) {
                            $configurations[$jobKey] =
                                $batchResult[$roundExtension];
                        }
                    }
                }

            } else {

                /*
                 * Fallback for an older PbxClient without the batch
                 * method: behave exactly as before (serial).
                 */
                foreach ($promptJobs as $jobKey => $job) {
                    try {
                        $configurations[$jobKey] = $client->autoAttendants(
                            $domain,
                            $job['extension'],
                            $job['prompt']
                        );
                    } catch (Throwable $e) {
                        appLog(
                            "AA configuration {$domain}/{$job['extension']}/" .
                            "{$job['prompt']}: " . $e->getMessage()
                        );
                    }
                }
            }

        } catch (Throwable $e) {

            appLog('AA batch configuration fetch: ' . $e->getMessage());
        }
    }


    /*
     * =========================================================
     * 4. PROCESS EVERY AUTO ATTENDANT
     * =========================================================
     */

    /*
     * Iterates JOBS (extension + one timeframe prompt), not extensions,
     * so a day/night attendant contributes every one of its prompts
     * instead of only the last row getAaList() happened to keep.
     */
    foreach ($promptJobs as $jobKey => $job) {

        $extension = trim((string)$job['extension']);

        if ($extension === '') {
            continue;
        }

        $startingPrompt = trim((string)$job['prompt']);

        if ($startingPrompt === '') {
            continue;
        }


        aaDebugLog(
            'AA ROOT ' .
            $domain .
            '/' .
            $extension .
            ' = ' .
            $startingPrompt
        );


        /*
         * =====================================================
         * 5. GET EXACT ROOT CONFIGURATION
         * =====================================================
         */

        /*
         * Already fetched above, in parallel. A missing entry means every
         * PBX server failed for this AA; that was already logged by the
         * batch fetch, so just skip it as the serial version did.
         */
        $configuration = $configurations[$jobKey] ?? null;

        if (!is_array($configuration)) {

            aaDebugLog(
                "AA configuration {$domain}/{$extension}/{$startingPrompt}: unavailable"
            );

            continue;
        }


        if (
            !is_array($configuration) ||
            !$configuration
        ) {

            aaDebugLog(
                "AA configuration {$domain}/{$extension}/{$startingPrompt}: empty"
            );

            continue;
        }


        /*
         * =====================================================
         * 6. ROOT METADATA
         * ===================================================== */

        $configuration['_extension'] =
            $extension;

        $configuration['_prompt'] =
            $startingPrompt;


        /*
         * =====================================================
         * 7. ROOT OPTIONS
         * ===================================================== */

        $configuration['options'] =
            normalizeAaOptions(
                $configuration
            );


        addNestedAaLinks(
            $configuration
        );


        /*
         * =====================================================
         * 8. EXTENSION INDEX
         * ===================================================== */

        if (
            !isset(
                $byExtension[$extension]
            )
        ) {

            $byExtension[$extension] =
                [];
        }


        $byExtension[$extension][] =
            $startingPrompt;


        /*
         * =====================================================
         * 9. ROOT PROMPT INDEX
         * ===================================================== */

        $byPrompt[$startingPrompt] =
            $configuration;


        /*
         * =====================================================
         * 10. NESTED AA PROMPTS
         * ===================================================== */

        $nestedPrompts =
            collectNestedAaPrompts(
                $configuration,
                $extension,
                $startingPrompt,
                ''
            );


        foreach (
            $nestedPrompts as $prompt => $nested
        ) {

            /*
             * Do not overwrite an already indexed prompt.
             */

            if (
                isset(
                    $byPrompt[$prompt]
                )
            ) {

                continue;
            }


            $byPrompt[$prompt] =
                $nested;


            /*
             * Same extension can have multiple prompts.
             */

            if (
                !isset(
                    $byExtension[$extension]
                )
            ) {

                $byExtension[$extension] =
                    [];
            }


            if (
                !in_array(
                    $prompt,
                    $byExtension[$extension],
                    true
                )
            ) {

                $byExtension[$extension][] =
                    $prompt;
            }
        }
    }


    /*
     * =========================================================
     * 11. SORT EXTENSION PROMPTS
     * =========================================================
     */

    foreach (
        $byExtension as &$prompts
    ) {

        sort(
            $prompts,
            SORT_NATURAL
        );
    }

    unset($prompts);


    /*
     * =========================================================
     * 12. BUILD RESULT
     * =========================================================
     */

    /*
     * MERGE, do not replace.
     *
     * This rebuild only covers $aaUsers, which may be a single selected
     * attendant. Anything previously cached for the other attendants in
     * this domain is still valid and must survive, otherwise a scoped
     * rebuild wipes them and they render with no prompts.
     *
     * Freshly built entries win on conflict.
     */
    $mergedByExtension = is_array($existing['byExtension'] ?? null)
        ? $existing['byExtension']
        : [];

    $mergedByPrompt = is_array($existing['byPrompt'] ?? null)
        ? $existing['byPrompt']
        : [];

    $mergedFetchedAt = is_array($existing['fetchedAt'] ?? null)
        ? $existing['fetchedAt']
        : [];

    /*
     * Drop carried-over entries that have outlived the TTL on their own.
     *
     * The file-level check in loadAaOptionsCache() is not enough once we
     * merge: every partial rebuild rewrites the file and so refreshes
     * its mtime. On a busy dashboard that would keep resetting the clock
     * and an entry fetched once could be served forever. Age is
     * therefore tracked per extension.
     */
    $now = time();

    $expiredExtensions = [];

    foreach ($mergedFetchedAt as $agedExtension => $agedAt) {

        if (($now - (int)$agedAt) >= AA_OPTIONS_CACHE_TTL) {
            $expiredExtensions[$agedExtension] = true;
        }
    }

    if ($expiredExtensions !== []) {

        /*
         * Nested prompts are SHARED: collectNestedAaPrompts() skips a
         * prompt that is already indexed, so two attendants can list the
         * same prompt id. Dropping every prompt named by an expired
         * extension would therefore break a live one that still points
         * at it. Only drop prompts nothing surviving references.
         */
        $stillReferenced = [];

        foreach ($mergedByExtension as $keepExtension => $keepPrompts) {

            if (isset($expiredExtensions[$keepExtension])) {
                continue;
            }

            foreach ((array)$keepPrompts as $keepPrompt) {
                $stillReferenced[$keepPrompt] = true;
            }
        }

        foreach (array_keys($expiredExtensions) as $agedExtension) {

            foreach (($mergedByExtension[$agedExtension] ?? []) as $agedPrompt) {

                if (isset($stillReferenced[$agedPrompt])) {
                    continue;
                }

                unset($mergedByPrompt[$agedPrompt]);
            }

            unset(
                $mergedByExtension[$agedExtension],
                $mergedFetchedAt[$agedExtension]
            );

            aaDebugLog(
                'AA CACHE: expired stale entry for extension ' .
                trim((string)$agedExtension)
            );
        }
    }

    foreach ($byExtension as $mergeExtension => $mergePrompts) {
        $mergedByExtension[$mergeExtension] = $mergePrompts;
        $mergedFetchedAt[$mergeExtension] = $now;
    }

    foreach ($byPrompt as $mergePrompt => $mergeConfiguration) {
        $mergedByPrompt[$mergePrompt] = $mergeConfiguration;
    }

    /*
     * Negative caching, but ONLY for an attendant the domain AA list
     * genuinely reports no starting prompt for. Those are cheap to
     * re-derive and would otherwise be re-fetched on every page load.
     *
     * BUGFIX: this used to memoise EVERY asked-for extension that
     * produced nothing, including ones whose PBX fetch had just failed.
     * That turned a transient error into an hour of
     * "No prompt map is available", and the entry was a cache HIT so it
     * never retried. A failed fetch is now left uncached and simply
     * retried on the next request.
     */
    foreach (array_keys($aaUsers) as $askedExtension) {

        $askedExtension = trim((string)$askedExtension);

        if ($askedExtension === ''
            || isset($mergedByExtension[$askedExtension])
        ) {
            continue;
        }

        $askedDefinition = $aaList[$askedExtension] ?? null;

        $askedPrompts = is_array($askedDefinition['startingPrompts'] ?? null)
            ? array_filter($askedDefinition['startingPrompts'])
            : array_filter([
                (string)($askedDefinition['startingPrompt'] ?? '')
            ]);

        /*
         * Had prompts to fetch but nothing came back => the fetch
         * failed. Leave it out of the cache so it is retried.
         */
        if ($askedPrompts !== []) {

            aaDebugLog(
                'AA CACHE: not caching failed fetch for extension ' .
                $askedExtension
            );

            continue;
        }

        $mergedByExtension[$askedExtension] = [];
        $mergedFetchedAt[$askedExtension] = $now;
    }

    $result = [

        'updatedAt' =>
            date('c'),

        'byExtension' =>
            $mergedByExtension,

        'byPrompt' =>
            $mergedByPrompt,

        'fetchedAt' =>
            $mergedFetchedAt
    ];


    /*
     * =========================================================
     * 13. SAVE CACHE
     * =========================================================
     */

    aaDebugLog(
        'AA CACHE: ABOUT TO SAVE=' .
        json_encode(
            $result,
            JSON_UNESCAPED_SLASHES
        )
    );

aaDebugLog(
    'AA DEBUG: AFTER SAVE OPTIONS CACHE'
);

    saveAaOptionsCache(
        $domain,
        $result
    );


    /*
     * =========================================================
     * 14. RETURN
     * =========================================================
     */

    return $result;
}

/*
 * =============================================================
 * RESOLVE AA CALL PATH
 * =============================================================
 */

function resolveAaCallPath(
    array $aaCache,
    string $prompt,
    string $case
): array {

    $result = [

        'prompt' =>
            $prompt,

        'case' =>
            $case,

        'optionDescription' =>
            '',

        'destinationApplication' =>
            '',

        'destinationUser' =>
            '',

        'nextPrompt' =>
            '',

        'parentPrompt' =>
            '',

        'parentCase' =>
            '',

        'path' =>
            []
    ];


    /*
     * =========================================================
     * INVALID PROMPT
     * =========================================================
     */

    if (
        $prompt === '' ||
        !isset(
            $aaCache['byPrompt'][$prompt]
        )
    ) {

        return $result;
    }


    /*
     * =========================================================
     * CURRENT PROMPT
     * =========================================================
     */

    $config =
        $aaCache['byPrompt'][$prompt];


    /*
     * =========================================================
     * PARENT INFORMATION
     * =========================================================
     */

    $result['parentPrompt'] =
        trim(
            (string)(
                $config['parent-prompt']
                ?? ''
            )
        );

    $result['parentCase'] =
        trim(
            (string)(
                $config['parent-option']
                ?? ''
            )
        );


    /*
     * =========================================================
     * BUILD PARENT PATH
     * =========================================================
     *
     * Walk backwards through:
     *
     * Prompt_800431
     *     parent = Prompt_800201
     *     parentCase = 7
     *
     * Then:
     *
     * Prompt_800201
     *     parent = ...
     */

    $parents = [];

    $currentPrompt =
        $prompt;

    $visited = [];


    while (
        $currentPrompt !== '' &&
        isset(
            $aaCache['byPrompt'][$currentPrompt]
        )
    ) {

        /*
         * Prevent accidental circular references.
         */

        if (
            isset(
                $visited[$currentPrompt]
            )
        ) {
            break;
        }

        $visited[$currentPrompt] = true;


        $currentConfig =
            $aaCache['byPrompt'][$currentPrompt];


        $parentPrompt =
            trim(
                (string)(
                    $currentConfig[
                        'parent-prompt'
                    ]
                    ?? ''
                )
            );

        $parentCase =
            trim(
                (string)(
                    $currentConfig[
                        'parent-option'
                    ]
                    ?? ''
                )
            );


        if (
            $parentPrompt === ''
        ) {
            break;
        }


        $parents[] = [

            'prompt' =>
                $parentPrompt,

            'case' =>
                $parentCase
        ];


        $currentPrompt =
            $parentPrompt;
    }


    /*
     * Reverse so the path starts at the root.
     */

    $parents =
        array_reverse(
            $parents
        );


    /*
     * Add current prompt.
     */

    $result['path'] =
        $parents;

    $result['path'][] = [

        'prompt' =>
            $prompt,

        'case' =>
            $case
    ];


    /*
     * =========================================================
     * FIND CURRENT CASE
     * =========================================================
     */

    $options =
        $config['options']
        ?? [];


    if (
        $case === '' ||
        !isset(
            $options[$case]
        )
    ) {

        return $result;
    }


    $option =
        $options[$case];


    /*
     * =========================================================
     * DESCRIPTION
     * =========================================================
     */

    $result['optionDescription'] =
        trim(
            (string)(
                $option['description']
                ?? ''
            )
        );


    /*
     * =========================================================
     * DESTINATION APPLICATION
     * =========================================================
     */

    $result['destinationApplication'] =
        trim(
            (string)(
                $option[
                    'destination-application'
                ]
                ?? ''
            )
        );


    /*
     * =========================================================
     * DESTINATION USER
     * =========================================================
     */

    $result['destinationUser'] =
        trim(
            (string)(
                $option[
                    'destination-user'
                ]
                ?? ''
            )
        );


    /*
     * =========================================================
     * NEXT PROMPT
     * =========================================================
     */

    $result['nextPrompt'] =
        trim(
            (string)(
                $option['nextPrompt']
                ?? ''
            )
        );


    return $result;
}
