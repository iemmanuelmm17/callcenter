<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/reporting.php';
requireMethod('POST');
try {
    $user = currentUser();
    if ($user['role'] !== 'office_manager') jsonResponse(['error' => 'Not authorized'], 403);
    $input = readJsonBody();
    $cursor = max(HISTORICAL_CDR_START_DATE, (string)($input['cursor'] ?? HISTORICAL_CDR_START_DATE));
    $days = min(31, max(1, (int)($input['days'] ?? 14)));
    $end = min((new DateTimeImmutable($cursor))->modify('+' . ($days - 1) . ' days'), (new DateTimeImmutable('yesterday', new DateTimeZone(DEFAULT_TIMEZONE))));
    if ($end < new DateTimeImmutable($cursor)) jsonResponse(['complete' => true]);
    loadRawCdrs($user, ['start'=>$cursor, 'end'=>$end->format('Y-m-d')]);
    $next = $end->modify('+1 day')->format('Y-m-d');
    auditView($user, ['start'=>$cursor, 'end'=>$end->format('Y-m-d')], 'warm-domain-cdr-cache');
    jsonResponse(['complete'=>$next > (new DateTimeImmutable('yesterday', new DateTimeZone(DEFAULT_TIMEZONE)))->format('Y-m-d'), 'nextCursor'=>$next, 'cachedThrough'=>$end->format('Y-m-d')]);
} catch (Throwable $e) { appLog('Cache warm: ' . $e->getMessage()); jsonResponse(['error'=>'Unable to warm the CDR cache.'], 502); }
