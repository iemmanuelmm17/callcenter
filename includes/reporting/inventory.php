<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/inventory.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

function cachedUsers(array $user): array {
    $file = CACHE_DIR . '/users-' . hash('sha256', 'v3|' . $user['domain']) . '.json';
    if (is_file($file) && (time() - filemtime($file)) < 3600) $users = json_decode((string)file_get_contents($file), true);
    if (empty($users) || !is_array($users)) {
        $users = (new PbxClient($_SESSION['token']))->users($user['domain']);
        if (@file_put_contents($file, json_encode($users), LOCK_EX) === false) appLog("Could not write user cache {$file}");
    }
    return $users;
}

function cachedCallQueues(array $user): array
{
    $domain = (string)($user['domain'] ?? '');
    $file = CACHE_DIR . '/callqueues-' . hash('sha256', 'v1|' . $domain) . '.json';

    if (is_file($file) && (time() - filemtime($file)) < 3600) {
        $queues = json_decode((string)file_get_contents($file), true);
        if (is_array($queues) && $queues !== []) {
            return $queues;
        }
        @unlink($file);
    }

    try {
        $client = new PbxClient((string)($_SESSION['token'] ?? ''));
        $rows = $client->callqueues($domain);
    } catch (Throwable $e) {
        appLog('cachedCallQueues list: ' . $e->getMessage());
        return [];
    }

    $queues = [];
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        $id = trim((string)($row['callqueue'] ?? ''));
        if ($id === '') {
            continue;
        }
        $queues[] = $row;
    }

    if ($queues !== []) {
        if (@file_put_contents($file, json_encode($queues, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
            appLog("Could not write call queue cache {$file}");
        }
    }

    return $queues;
}

function cachedCallQueueAgents(array $user, string $queue): array
{
    $queue = trim($queue);
    if ($queue === '') {
        return [];
    }
    $domain = (string)($user['domain'] ?? '');
    $file = CACHE_DIR . '/callqueue-agents-' . hash('sha256', 'v1|' . $domain . '|' . $queue) . '.json';
    if (is_file($file) && (time() - filemtime($file)) < 3600) {
        $agents = json_decode((string)file_get_contents($file), true);
        if (is_array($agents)) {
            return $agents;
        }
    }
    try {
        $agents = (new PbxClient((string)($_SESSION['token'] ?? '')))
            ->callqueueAgents($domain, $queue);
    } catch (Throwable $e) {
        appLog('cachedCallQueueAgents ' . $queue . ': ' . $e->getMessage());
        return [];
    }
    if (!is_array($agents)) {
        return [];
    }
    if (@file_put_contents($file, json_encode($agents, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        appLog("Could not write call queue agent cache {$file}");
    }
    return $agents;
}

function phoneNumberCacheFile(string $domain): string {


    return CACHE_DIR .
        '/phonenumbers-' .
        hash(
            'sha256',
            'v1|' . $domain
        ) .
        '.json';
}

function cachedPhoneNumbers(array $user): array
{
    $file = phoneNumberCacheFile(
        $user['domain']
    );

    /*
     * -------------------------------------------------------------
     * USE CACHE
     * -------------------------------------------------------------
     *
     * Only accept the cache when it contains actual numbers.
     * An empty array is NOT considered a valid cache.
     */

    if (
        is_file($file) &&
        (time() - filemtime($file)) < 3600
    ) {

        $numbers = json_decode(
            (string)file_get_contents($file),
            true
        );

        if (
            is_array($numbers) &&
            count($numbers) > 0
        ) {
            return $numbers;
        }

        /*
         * Cache exists but is empty/invalid.
         * Delete it so the PBX is queried again.
         */
        @unlink($file);
    }


    /*
     * -------------------------------------------------------------
     * CACHE MISS
     * -------------------------------------------------------------
     */

    $numbers =
        (new PbxClient($_SESSION['token']))
        ->phonenumbers(
            $user['domain']
        );


    /*
     * -------------------------------------------------------------
     * VALIDATE API RESPONSE
     * -------------------------------------------------------------
     */

    if (
        !is_array($numbers)
    ) {
        appLog(
            'Telephone number API returned a non-array response.'
        );

        return [];
    }


    if (
        count($numbers) > 0
    ) {

        if (
            @file_put_contents(
                $file,
                json_encode(
                    $numbers,
                    JSON_UNESCAPED_SLASHES |
                    JSON_UNESCAPED_UNICODE
                ),
                LOCK_EX
            ) === false
        ) {

            appLog(
                "Could not write phone number cache {$file}"
            );
        }
    }


    return $numbers;
}

function normalizePhoneNumber(string $value): string {
	$value = trim($value);

    if ($value === '') {
        return '';
    }

    /*
     * Remove SIP / TEL prefixes.
     */
    $value = preg_replace(
        '/^(?:sip:|tel:)/i',
        '',
        $value
    );

    /*
     * Remove anything after @.
     *
     * Example:
     * sip:18773962546@7261.DynaCloud
     */
    if (str_contains($value, '@')) {
        $value = explode('@', $value, 2)[0];
    }

    /*
     * Keep digits only.
     */
    $digits = preg_replace(
        '/\D+/',
        '',
        $value
    );

    if ($digits === '') {
        return '';
    }

    /*
     * US 11-digit number:
     *
     * 18773962546
     *
     * becomes:
     *
     * 8773962546
     */
    if (
        strlen($digits) === 11 &&
        str_starts_with($digits, '1')
    ) {
        $digits = substr($digits, 1);
    }

    return $digits;
}

function userDirectory(array $user): array
{
    $directory = [];

    foreach (cachedUsers($user) as $person) {

        if (!is_array($person)) {
            continue;
        }

        $extension = trim(
            (string)($person['user'] ?? '')
        );

        if ($extension === '') {
            continue;
        }

        $firstName = trim(
            (string)($person['name-first-name'] ?? '')
        );

        $lastName = trim(
            (string)($person['name-last-name'] ?? '')
        );

        $name = trim(
            $firstName . ' ' . $lastName
        );

        if ($name === '') {
            $name = $extension;
        }

        $directory[$extension] = [

            'extension' => $extension,

            'name' => $name,

            'firstName' => $firstName,

            'lastName' => $lastName,

            'department' =>
                trim((string)($person['department'] ?? '')),

            'site' =>
                trim((string)($person['site'] ?? '')),

            'serviceCode' =>
                trim((string)($person['service-code'] ?? ''))
        ];
    }

    return $directory;
}
