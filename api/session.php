<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
/* Read directly rather than through includes/reporting.php: this endpoint runs
 * on a timer and only needs the domain settings file. See portal.php, which
 * requires it for the same reason. */
require_once __DIR__ . '/../includes/reporting/settings.php';
if (empty($_SESSION['user']) || empty($_SESSION['last_activity'])) {
    jsonResponse(['authenticated' => false]);
}
$user = currentUser(false);
/* The zone this session's dates are read in, applied here because
 * authorizedFilters - which normally does this - is not in the path of a session
 * poll (see the header of includes/timezone.php). */
$timezone = setReportingTimezone(
    loadDomainSettings((string)($user['domain'] ?? ''))['timezone'] ?? null
);
jsonResponse([
    'user' => $user,
    /*
     * The desk's timezone (review, finding C7), so the client can re-seat its
     * clock on a poll that happens before any report has been fetched. The
     * value is what this request's scope resolved to; when no tenant setting
     * exists it is DEFAULT_TIMEZONE, exactly what the reports use.
     */
    'timezone' => $timezone,
    'remaining' => max(0, SESSION_IDLE_SECONDS - (time() - (int)$_SESSION['last_activity'])),
    'warningAt' => SESSION_WARNING_SECONDS,
    'tokenRemaining' => max(0, (int)($_SESSION['token_expires_at'] ?? 0) - time()),
]);
