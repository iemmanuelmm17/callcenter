<?php
declare(strict_types=1);

const AA_LIST_CACHE_TTL = 3600;

/*
 * PERF: debug logging switch (see aa_options.php). These traces ran on
 * every request and one of them dumped the entire AA list as JSON.
 */
if (!defined('AA_DEBUG_LOG')) {
    define('AA_DEBUG_LOG', (string)getenv('AA_DEBUG') === '1');
}

if (!function_exists('aaDebugLog')) {
    function aaDebugLog(string $message): void
    {
        if (AA_DEBUG_LOG) {
            appLog($message);
        }
    }
}

function aaListCacheFile(
    string $domain
): string {

    $dir =
        __DIR__ .
        '/../cache/aa';

    if (!is_dir($dir)) {
        mkdir(
            $dir,
            0775,
            true
        );
    }

    $safeDomain =
        preg_replace(
            '/[^a-zA-Z0-9._-]/',
            '_',
            $domain
        );

    return
        $dir .
        '/' .
        ($safeDomain ?: 'default') .
        '-list.json';
}

function loadAaListCache(
    string $domain
): ?array {

    $file =
        aaListCacheFile($domain);

    if (
        !is_file($file)
    ) {
        return null;
    }

    if (
        (time() - filemtime($file))
        > AA_LIST_CACHE_TTL
    ) {
        return null;
    }

    $json =
        file_get_contents($file);

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

    return
        is_array($data)
            ? $data
            : null;
}

function saveAaListCache(
    string $domain,
    array $data
): void {

    $file =
        aaListCacheFile($domain);

    $tmp =
        $file . '.tmp';

    $json =
        json_encode(
            $data,
            JSON_PRETTY_PRINT |
            JSON_UNESCAPED_SLASHES
        );

    if ($json === false) {
        return;
    }

    if (
        file_put_contents(
            $tmp,
            $json,
            LOCK_EX
        ) === false
    ) {
        return;
    }

    rename(
        $tmp,
        $file
    );
}

function getAaList(
    string $domain,
    PbxClient $client
): array {

    aaDebugLog(
        'AA LIST: START ' . $domain
    );

    $cached =
        loadAaListCache(
            $domain
        );

    if (
        $cached !== null
    ) {

        aaDebugLog(
            'AA LIST: CACHE HIT ' .
            $domain .
            ' COUNT=' .
            count($cached)
        );

        return $cached;
    }

    aaDebugLog(
        'AA LIST: CACHE MISS ' .
        $domain
    );


    try {

        $rows =
            $client->autoAttendantList(
                $domain
            );

    } catch (Throwable $e) {

        appLog(
            'AA LIST: API EXCEPTION ' .
            $domain .
            ': ' .
            $e->getMessage()
        );

        return [];
    }


    aaDebugLog(
        'AA LIST: API RESULT ' .
        $domain .
        ' = ' .
        json_encode(
            $rows,
            JSON_UNESCAPED_SLASHES
        )
    );


    $result = [];

    foreach ($rows as $row) {

        if (!is_array($row)) {
            continue;
        }

        $extension =
            trim(
                (string)(
                    $row['user'] ?? ''
                )
            );

        $startingPrompt =
            trim(
                (string)(
                    $row['starting-prompt'] ?? ''
                )
            );

        if ($extension === '') {
            continue;
        }

        /*
         * BUGFIX: this endpoint returns ONE ROW PER TIMEFRAME, so a
         * day/night attendant appears several times under the same
         * extension.
         *
         * The old code did two things that lost attendants:
         *
         *   1. it skipped any row with an empty starting-prompt, and
         *   2. it assigned $result[$extension] = ..., so the LAST row
         *      won and every other timeframe was discarded.
         *
         * Downstream (getAaOptions section 4) then found either no entry
         * at all or only one timeframe's prompt, and the Structure tab
         * rendered "No prompt map is available" for an attendant that
         * plainly has options configured.
         *
         * The single-value keys are kept exactly as they were so nothing
         * downstream has to change; 'startingPrompts' is added
         * alongside, accumulating every prompt seen for this extension.
         */
        if (!isset($result[$extension])) {

            $result[$extension] = [
                'extension' =>
                    $extension,

                'name' =>
                    trim(
                        (string)(
                            $row['attendant-name'] ?? ''
                        )
                    ),

                'startingPrompt' =>
                    $startingPrompt,

                'startingPrompts' =>
                    [],

                'readPath' =>
                    trim(
                        (string)(
                            $row['read-path'] ?? ''
                        )
                    ),

                'timeframes' =>
                    []
            ];
        }

        /*
         * First non-empty prompt wins for the scalar field, so an empty
         * row can never blank out a good value recorded earlier.
         */
        if ($startingPrompt !== ''
            && trim((string)$result[$extension]['startingPrompt']) === ''
        ) {
            $result[$extension]['startingPrompt'] = $startingPrompt;
        }

        if ($startingPrompt !== ''
            && !in_array(
                $startingPrompt,
                $result[$extension]['startingPrompts'],
                true
            )
        ) {
            $result[$extension]['startingPrompts'][] = $startingPrompt;
        }

        if (trim((string)$result[$extension]['name']) === '') {
            $result[$extension]['name'] =
                trim((string)($row['attendant-name'] ?? ''));
        }

        if (trim((string)$result[$extension]['readPath']) === '') {
            $result[$extension]['readPath'] =
                trim((string)($row['read-path'] ?? ''));
        }

        if (is_array($row['timeframes'] ?? null)) {
            foreach ($row['timeframes'] as $rowTimeframe) {
                $result[$extension]['timeframes'][] = $rowTimeframe;
            }
        }
    }

    /*
     * An attendant whose every row had an empty starting-prompt is kept
     * (so callers know it exists) but carries no prompts to fetch.
     */


    aaDebugLog(
        'AA LIST: NORMALIZED COUNT=' .
        count($result)
    );


    saveAaListCache(
        $domain,
        $result
    );


    aaDebugLog(
        'AA LIST: CACHE SAVE COMPLETE ' .
        $domain
    );


    return $result;
}


