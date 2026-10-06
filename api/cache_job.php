<?php
declare(strict_types=1);

$reporting = __DIR__ . '/../includes/reporting.php';
if (!is_file($reporting)) {
    $reporting = __DIR__ . '/reporting.php';
}
require_once $reporting;

requireMethod('POST');

try {
    $user = currentUser();
    $requested = readJsonBody();
    $filters = authorizedFilters($requested, $user);

    if (($filters['end'] ?? '') < ($filters['start'] ?? '')) {
        jsonResponse(['error' => 'Invalid date range'], 422);
    }

    $action = trim((string)($requested['action'] ?? 'status'));
    $status = cdrRangeCacheStatus($user, (string)$filters['start'], (string)$filters['end']);

    /*
     * F2: `warm` fills a batch of days per request (default 5, or until the
     * time budget), so a manager's >31-day range does not need one round-trip
     * per day. The response reports what the batch did in `batch`, and `status`
     * is the range's state after it - the UI keeps polling until `complete`.
     */
    $batch = null;
    if ($action === 'warm' && empty($status['complete']) && !empty($status['next'])) {
        set_time_limit(120);
        $batch = warmCdrBatch(
            $user,
            (string)$filters['start'],
            (string)$filters['end'],
            (int)($requested['batch'] ?? 5),
            20
        );
        $status = $batch['status'];
        unset($batch['status']);
    }

    $status['start'] = $filters['start'];
    $status['end'] = $filters['end'];
    /* Which backend is warming the range; the UI shows the progress bar for
     * both, this only makes it visible in the response/audit trail. */
    $status['driver'] = cdrCacheDriver();
    $status['warming'] = $action === 'warm' && empty($status['complete']);
    $status['batch'] = $batch;

    jsonResponse($status);
} catch (Throwable $e) {
    appExceptionLog('Cache job', $e);
    jsonResponse(['error' => 'Unable to prepare call history cache.'], 502);
}
