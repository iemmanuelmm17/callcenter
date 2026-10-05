<?php
declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');

error_reporting(E_ALL);

require_once __DIR__ . '/../includes/reporting.php';

requireMethod('POST');

try {

    $user = currentUser();

    $requested = json_decode(
        file_get_contents('php://input'),
        true
    ) ?: [];

    $filters = authorizedFilters(
        $requested,
        $user
    );

    if ($filters['end'] < $filters['start']) {
        jsonResponse(
            ['error' => 'Invalid date range'],
            422
        );
    }

    $directory = userDirectory($user);

    $calls = scopedCdrs(
        normalizeCdrs(
            loadRawCdrs(
                $user,
                $filters
            ),
            $directory
        ),
        $filters,
        $directory
    );

    /*
     * Generate agent performance.
     */
    $agents = agentPerformance(
        $calls,
        $directory
    );

    auditView(
        $user,
        $filters,
        'agent-performance'
    );

    jsonResponse([
        'filters' => $filters,
        'agents' => $agents,
        'timezone' => DEFAULT_TIMEZONE
    ]);

} catch (Throwable $e) {

    appLog(
        'Agent Performance: ' .
        $e->getMessage() .
        "\n" .
        $e->getFile() .
        ':' .
        $e->getLine()
    );

    jsonResponse(
        [
            'error' => 'Unable to load agent performance data.'
        ],
        502
    );
}