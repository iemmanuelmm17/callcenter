<?php
declare(strict_types=1);

/**
 * The desk's timezone (review, finding C7).
 *
 * DEFAULT_TIMEZONE (includes/config.php) is the DEPLOYMENT default. A tenant
 * whose calls arrive in another zone sets its own in Settings -> Service desk
 * (`timezone`, per domain, next to the opening-hours calendar that depends on
 * it), and every boundary in the reporting layer resolves there instead: the day
 * window a cache file is fetched for, the hour buckets, the business-hours test,
 * the `timezone` the API echoes back, the name inside every day-cache filename,
 * and the front end's clock.
 *
 * This file exists on its own, rather than inside includes/bootstrap.php or
 * includes/reporting/support.php, for one reason: includes/bootstrap.php is
 * replaced by a test double (tests/php/php.mjs, BOOTSTRAP_STUB) and the
 * reporting layer is not loaded by the three pages that answer about the
 * session - portal.php, api/login.php, api/session.php. A require of this file
 * is all either side needs, so the tests exercise the real resolver instead of a
 * copy of it that can drift.
 *
 * The value is per request, like the session it belongs to: it is applied once
 * the signed-in user's domain is known (authorizedFilters, which every reporting
 * endpoint runs through) and never carried over from one request to the next.
 * The rule for anyone adding a date computation is deliberately boring: whoever
 * resolves a date resolves the zone first.
 */

function normalizeTimezoneName($name): string
{
    $name = trim((string)$name);
    /*
     * An IANA id is a short string of letters, digits, '_', '+', '-' and the
     * '/' between Region and City ('Asia/Manila', 'Etc/GMT+8',
     * 'America/Argentina/Buenos_Aires'). The length and character guards are not
     * about injection - nothing here reaches SQL or a shell - they keep a
     * hand-edited settings file from smuggling a 4 KB string into every cache
     * filename and log line that quotes the zone back. Numeric UTC offsets
     * ('+08:00') are deliberately NOT accepted: they have no DST rules, and a
     * desk that stops observing DST at a date the fixed offset cannot see gets
     * an hour of wrong numbers twice a year - which is the whole reason this
     * setting exists.
     */
    if ($name === '' || strlen($name) > 64 || preg_match('#[^A-Za-z0-9_+/\-]#', $name)) {
        return '';
    }
    try {
        new DateTimeZone($name);
    } catch (Throwable $e) {
        return '';
    }
    return $name;
}

/** The zone every timestamp in this request is read in. */
function reportingTimezoneName(?string $apply = null): string
{
    static $name = null;
    if ($apply !== null && $apply !== '') {
        $name = $apply;
    }
    if ($name === null) {
        $name = normalizeTimezoneName(defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'US/Eastern');
        if ($name === '') {
            /* A DEFAULT_TIMEZONE the runtime does not know is a misconfiguration
             * worth a log line; the reports still have to answer, so the zone
             * every install has always used takes it. */
            $name = 'US/Eastern';
            if (function_exists('appLog')) {
                appLog('DEFAULT_TIMEZONE "' . substr((string)constant('DEFAULT_TIMEZONE'), 0, 64) . '" is not a timezone this PHP knows; reporting in ' . $name);
            }
        }
    }
    return $name;
}

/**
 * Point the reporting clock at a domain's timezone and answer with the zone
 * actually used. An empty or unusable name is not an error - the deployment
 * default keeps it - so a settings file written before this setting existed,
 * or edited by hand, cannot take the dashboard down.
 */
function setReportingTimezone($name): string
{
    $clean = normalizeTimezoneName($name);
    return $clean === '' ? reportingTimezoneName() : reportingTimezoneName($clean);
}

/** The same value as a DateTimeZone, for the code that needs the object. */
function reportingTimezone(): DateTimeZone
{
    return new DateTimeZone(reportingTimezoneName());
}
