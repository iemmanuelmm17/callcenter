<?php
declare(strict_types=1);

/*
 * SEC-6 FIX — RETIRED 2026-09-10.
 *
 * This endpoint (GET) served CDR data for ANY caller-supplied extension
 * without going through authorizedFilters(), i.e. it bypassed department /
 * agent scoping entirely, and it overlaps aa.php (which IS
 * office_manager-only). The current client (app.js) does not call it at all.
 *
 * It now answers 410 Gone so any stale consumer fails loudly instead of
 * reading unscoped data. The previous implementation is preserved in VCS
 * history; if a scoped version is ever needed, re-implement it with
 * authorizedFilters() + requirePageRoles() (see aa.php as the reference).
 */
require_once __DIR__ . '/../includes/auth.php';

jsonResponse(['error' => 'Endpoint retired (2026-09-10). Use aa.php.'], 410);
