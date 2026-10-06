<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap.php';
requireMethod('POST');
/*
 * Destroy only a session that actually exists.
 *
 * A caller with an expired or missing session cookie still gets a 200 and a
 * clean JSON body: without the guard PHP prints "Trying to destroy
 * uninitialized session" BEFORE the payload, and on a host with display_errors
 * on that turns a successful sign-out into "Server returned invalid JSON" in
 * the browser. (jsonResponse() also drops stray buffers, but a warning that
 * PHP prints into the output stream still costs the request its body shape on
 * a misconfigured host, so both ends are covered.)
 */
if (session_status() === PHP_SESSION_ACTIVE) {
    session_unset();
    session_destroy();
}
jsonResponse(['ok' => true]);
