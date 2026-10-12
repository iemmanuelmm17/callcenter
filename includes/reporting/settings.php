<?php
declare(strict_types=1);

/**
 * Extracted from includes/reporting.php — includes/reporting/settings.php.
 *
 * Every function here is loaded by the facade (includes/reporting.php), which
 * is what the endpoints and the other includes require; nothing else changed.
 * The split is deliberately mechanical: same code, same order, same guards.
 */

function domainSettingsFile(string $domain): string {
    return CACHE_DIR . '/settings-' . hash('sha256', 'v1|' . $domain) . '.json';
}

function defaultDomainSettings(): array {
    return [
        /*
         * The zone the desk's day is measured in (review, finding C7).
         *
         * Every date in this app is a wall-clock date in THIS zone: the day a
         * CDR belongs to, the hour buckets, the opening-hours calendar below,
         * the "Today" the filter bar opens with. DEFAULT_TIMEZONE in
         * includes/config.php is the deployment-wide fallback; a desk staffed
         * in another region used to need a config edit and a redeploy to change
         * it, and until then its day BOUNDARIES - not just its labels - followed
         * New York.
         *
         * Changing it re-fetches the day cache on purpose: the zone is part of
         * every cache filename, so a day's rows are never read under the wrong
         * date. Default is deliberately the value every install has always had.
         */
        'timezone' => 'US/Eastern',
        'slaSeconds' => 20,
        'slaPct' => 80.0,
        'missedPct' => 20.0,
        'abandonPct' => 10.0,
        'ahtMinutes' => 5.0,
        'ahtOutboundMinutes' => 5.0,
        /*
         * Sprint B: the outbound contact-rate floor, connects ÷ attempts. It is
         * a floor rather than a ceiling (more connects is better), which is the
         * opposite of every other threshold here, so the agent table colours a
         * contact rate below it - and only when the agent actually dialled.
         */
        'contactPct' => 50.0,
        /*
         * Top-agent qualification, used by the "Lowest AHT" ranking on
         * the operations overview. An agent only earns a medal when
         * their inbound AHT is UNDER topAgentAhtMinutes AND they handled
         * MORE than topAgentMinCalls inbound calls.
         *
         * The volume floor matters: without it a single lucky 12-second
         * call outranks an agent who handled three hundred.
         */
        'topAgentAhtMinutes' => 5.0,
        'topAgentMinCalls' => 20,

        /*
         * The desk's opening hours (manager review, Sprint A).
         *
         * Every SLA / abandon / ASA figure in the app is computed over the
         * calls in the selected period. On a desk that is staffed Monday to
         * Friday, a 02:00 abandon is not a service failure - it is a caller
         * outside opening hours - and counting it makes every published number
         * worse than the desk really is. So the calendar lives here and the
         * reports can be scoped to it.
         *
         * `enabled` is deliberately FALSE on a fresh install: switching it on
         * changes every headline number, so it is an explicit manager decision
         * in Settings rather than something that arrives with a deploy. Once it
         * is on, the report filter defaults to `business`.
         *
         * The calendar is expressed in the desk's own timezone (the `timezone`
         * setting above, US/Eastern until a manager says otherwise) because
         * that is how CDR timestamps are resolved everywhere else in the
         * reporting layer. An 08:00 opening means nothing without it.
         */
        'businessHours' => [
            'enabled' => false,
            /* ISO-8601 weekday numbers: 1 = Monday ... 7 = Sunday. */
            'days' => [
                1 => ['closed' => false, 'open' => '08:00', 'close' => '18:00'],
                2 => ['closed' => false, 'open' => '08:00', 'close' => '18:00'],
                3 => ['closed' => false, 'open' => '08:00', 'close' => '18:00'],
                4 => ['closed' => false, 'open' => '08:00', 'close' => '18:00'],
                5 => ['closed' => false, 'open' => '08:00', 'close' => '18:00'],
                6 => ['closed' => true, 'open' => '', 'close' => ''],
                7 => ['closed' => true, 'open' => '', 'close' => ''],
            ],
            /* Y-m-d, local dates: holidays the desk is closed. */
            'holidays' => [],
        ],

        /*
         * Service-level target per queue, in seconds, keyed by the queue's
         * identifier as the PBX reports it (falling back to its extension and
         * then its name - see resolveQueueSlaSeconds()). A queue that is not
         * listed uses `slaSeconds` above.
         */
        'queueSla' => [],

        /*
         * Who is scheduled when (Sprint C). One entry per agent: extension,
         * name, team, supervisor, the ISO weekdays they work and their shift.
         * This is what makes occupancy (talk / scheduled) and calls-per-hour
         * possible at all - the CDR alone cannot tell an underworked agent from
         * a short shift.
         */
        'roster' => [],
    ];
}

/**
 * The stored calendar, with every day present even if the file predates this
 * feature or was written by hand with only some days.
 */
function normalizeBusinessHours($stored): array {
    $base = defaultDomainSettings()['businessHours'];
    if (!is_array($stored)) {
        return $base;
    }
    $days = $base['days'];
    foreach ((array)($stored['days'] ?? []) as $number => $day) {
        $n = (int)$number;
        if ($n < 1 || $n > 7 || !is_array($day)) {
            continue;
        }
        $days[$n] = [
            'closed' => !empty($day['closed']),
            'open' => normalizeClock((string)($day['open'] ?? '')),
            'close' => normalizeClock((string)($day['close'] ?? '')),
        ];
    }
    $holidays = [];
    foreach ((array)($stored['holidays'] ?? []) as $date) {
        $date = trim((string)$date);
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            $holidays[$date] = true;
        }
    }
    return [
        'enabled' => !empty($stored['enabled']),
        'days' => $days,
        'holidays' => array_keys($holidays),
    ];
}

/** '8:5' / '8' / '0800' -> '08:05' / '08:00' / '08:00'; '' stays ''. */
function normalizeClock(string $value): string {
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    /* '8:5' is what a person types into the Settings box; accept it. */
    if (preg_match('/^(\d{1,2}):(\d{1,2})$/', $value, $m)) {
        $hour = (int)$m[1];
        $minute = (int)$m[2];
    } elseif (preg_match('/^(\d{1,2})(\d{2})$/', $value, $m)) {
        $hour = (int)$m[1];
        $minute = (int)$m[2];
    } elseif (preg_match('/^(\d{1,2})$/', $value, $m)) {
        $hour = (int)$m[1];
        $minute = 0;
    } else {
        return '';
    }
    if ($hour > 23 || $minute > 59) {
        return '';
    }
    return str_pad((string)$hour, 2, '0', STR_PAD_LEFT) . ':' . str_pad((string)$minute, 2, '0', STR_PAD_LEFT);
}

function businessHours(array $settings): array {
    return normalizeBusinessHours($settings['businessHours'] ?? null);
}

/** Is the calendar usable? (Enabled AND at least one open day with times.) */
function businessHoursConfigured(array $settings): bool {
    $hours = businessHours($settings);
    if (empty($hours['enabled'])) {
        return false;
    }
    foreach ($hours['days'] as $day) {
        if (empty($day['closed']) && $day['open'] !== '' && $day['close'] !== '') {
            return true;
        }
    }
    return false;
}

/**
 * Is this call inside the desk's opening hours?
 *
 * The call's own local start time decides (US/Eastern, the timezone every other
 * duration/date helper uses). A shift that closes before it opens (22:00 ->
 * 06:00) is treated as crossing midnight, which is how a night desk describes
 * itself. A closed weekday always excludes its calls; a holiday always excludes
 * its calls. A call with no usable timestamp is never hidden from a report.
 */
function callWithinBusinessHours(array $call, array $settings): bool {
    $hours = businessHours($settings);
    if (empty($hours['enabled'])) {
        return true;
    }
    $at = parseEasternDateTime(callStartValue($call));
    if (!$at instanceof DateTimeImmutable) {
        return true;
    }
    $date = $at->format('Y-m-d');
    if (in_array($date, (array)$hours['holidays'], true)) {
        return false;
    }
    $day = $hours['days'][(int)$at->format('N')] ?? null;
    if (!is_array($day) || !empty($day['closed']) || $day['open'] === '' || $day['close'] === '') {
        return false;
    }
    $clock = $at->format('H:i');
    if ($day['close'] <= $day['open']) {
        return $clock >= $day['open'] || $clock < $day['close'];
    }
    /* Open inclusive, close exclusive: a call at exactly 18:00 is after hours. */
    return $clock >= $day['open'] && $clock < $day['close'];
}

/** The local start of a call, as the reporting layers see it. */
function callStartValue(array $call): string {
    return (string)($call['call-start-datetime'] ?? $call['startedAt'] ?? '');
}

/**
 * The service-level target for one queue: its own override if the manager set
 * one, otherwise the domain default. Keys are tried in the order the PBX
 * identifies a queue (id, then extension, then name) so a Settings screen can
 * offer whichever it has.
 */
function resolveQueueSlaSeconds(array $settings, ?string $queueId, ?string $queueExtension = null, ?string $queueName = null): int {
    $default = (int)($settings['slaSeconds'] ?? 20);
    if ($default < 1) {
        $default = 20;
    }
    $map = is_array($settings['queueSla'] ?? null) ? $settings['queueSla'] : [];
    foreach ([$queueId, $queueExtension, $queueName] as $key) {
        $key = trim((string)$key);
        if ($key === '' || !array_key_exists($key, $map)) {
            continue;
        }
        $value = (int)$map[$key];
        if ($value >= 1) {
            return max(1, min(120, $value));
        }
    }
    return $default;
}

function loadDomainSettings(string $domain): array {
    $base = defaultDomainSettings();
    if ($domain === '') {
        return $base;
    }
    $file = domainSettingsFile($domain);
    if (!is_file($file)) {
        return $base;
    }
    $raw = json_decode((string)@file_get_contents($file), true);
    if (!is_array($raw)) {
        return $base;
    }
    $merged = array_merge($base, array_intersect_key($raw, $base));
    /* The calendar is the one nested setting: a file written before a day
     * existed (or edited by hand) still yields all seven days. */
    $merged['businessHours'] = normalizeBusinessHours($raw['businessHours'] ?? null);
    return $merged;
}

function saveDomainSettings(string $domain, array $in): array {
    $cur = defaultDomainSettings();

    /*
     * Fall back to the CURRENT stored value rather than the hard default
     * when a key is absent from the request.
     *
     * BUGFIX: every clamp below used a literal default, so a payload
     * that omitted a key silently reset it. 'ahtOutboundMinutes' was
     * never assigned at all, which meant it was wiped back to 5.0 on
     * every single save even though the UI collected it.
     */
    $existing = loadDomainSettings($domain);

    /*
     * The nested settings start from what is stored, exactly like $pick does for
     * the scalars. Without this, a save that did not mention the calendar wrote
     * $cur's default over the stored one: the same class of bug as the old
     * "omitted field resets to default" scalars, and worse here, because it would
     * silently switch opening hours off (or empty the queue targets and the
     * roster) on any partial save.
     */
    $cur['businessHours'] = businessHours($existing);
    $cur['queueSla'] = is_array($existing['queueSla'] ?? null) ? $existing['queueSla'] : [];
    $cur['roster'] = is_array($existing['roster'] ?? null) ? $existing['roster'] : [];

    $pick = static function (string $key, $fallback) use ($in, $existing) {
        if (array_key_exists($key, $in) && $in[$key] !== null && $in[$key] !== '') {
            return $in[$key];
        }
        return $existing[$key] ?? $fallback;
    };

    $cur['slaSeconds'] = max(5, min(120, (int)$pick('slaSeconds', 20)));
    $cur['slaPct'] = max(1, min(100, (float)$pick('slaPct', 80)));
    $cur['missedPct'] = max(1, min(100, (float)$pick('missedPct', 20)));
    $cur['abandonPct'] = max(1, min(100, (float)$pick('abandonPct', 10)));
    $cur['ahtMinutes'] = max(1, min(120, (float)$pick('ahtMinutes', 5)));
    $cur['ahtOutboundMinutes'] = max(1, min(120, (float)$pick('ahtOutboundMinutes', 5)));
    $cur['contactPct'] = max(1, min(100, (float)$pick('contactPct', 50)));

    /*
     * Qualifying AHT is allowed below one minute (0.5 min = 30 s) —
     * unlike the alert thresholds, a fast-handling target of well under
     * a minute is legitimate for short transactional queues.
     */
    $cur['topAgentAhtMinutes'] = max(0.5, min(120, (float)$pick('topAgentAhtMinutes', 5)));

    /*
     * Zero is meaningful here: it means "no minimum", so the floor is 0
     * rather than 1.
     */
    $cur['topAgentMinCalls'] = max(0, min(10000, (int)$pick('topAgentMinCalls', 20)));

    /*
     * The desk's timezone (finding C7), validated rather than clamped: an id
     * the runtime does not know is dropped silently by every date helper
     * downstream, so the honest answer here is the deployment default and a
     * Settings screen that re-reads what was actually stored. Like $pick, an
     * OMITTED key keeps the stored value - the thresholds dialog saves without
     * mentioning the calendar or the roster, and it must not reset the clock
     * either.
     */
    $timezone = normalizeTimezoneName((string)$pick('timezone', ''));
    if ($timezone === '') {
        $timezone = normalizeTimezoneName(defined('DEFAULT_TIMEZONE') ? DEFAULT_TIMEZONE : 'US/Eastern');
    }
    $cur['timezone'] = $timezone !== '' ? $timezone : 'US/Eastern';

    /*
     * Opening hours. The $pick rule above (a missing key keeps the stored
     * value) was written after a bug where an omitted field silently reset to
     * its default; the day grid is the exception, replaced wholesale because
     * the Settings screen always submits all seven days.
     */
    if (array_key_exists('businessHours', $in) && is_array($in['businessHours'])) {
        $normalized = normalizeBusinessHours($in['businessHours']);
        /* An enabled calendar with every day closed would silently report zero
         * calls. Refuse it and keep the times already stored, so the mismatch
         * is visible in the UI instead of in an empty dashboard. */
        $anyOpen = false;
        foreach ($normalized['days'] as $day) {
            if (empty($day['closed']) && $day['open'] !== '' && $day['close'] !== '') {
                $anyOpen = true;
                break;
            }
        }
        if (!empty($normalized['enabled']) && !$anyOpen) {
            $current = businessHours($cur);
            $normalized['enabled'] = false;
            $normalized['days'] = $current['days'];
            $normalized['holidays'] = $current['holidays'];
        }
        $cur['businessHours'] = $normalized;
    }

    /*
     * Per-queue SLA: seconds per queue id/extension/name, clamped like the
     * global target. A blank value removes the override.
     */
    if (array_key_exists('queueSla', $in) && is_array($in['queueSla'])) {
        $map = [];
        foreach ($in['queueSla'] as $key => $value) {
            $key = trim((string)$key);
            if ($key === '' || strlen($key) > 120) {
                continue;
            }
            if ($value === '' || $value === null) {
                continue;
            }
            $map[$key] = max(1, min(120, (int)$value));
        }
        $cur['queueSla'] = $map;
    }

    /*
     * Roster: one row per scheduled agent. Times are normalised like the
     * calendar, weekdays are clamped to 1..7, and a row with no usable day, no
     * usable shift or no extension (the link to a CDR) is dropped rather than
     * stored half-formed.
     */
    if (array_key_exists('roster', $in) && is_array($in['roster'])) {
        $roster = [];
        foreach (array_slice($in['roster'], 0, 500) as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $extension = trim((string)($entry['extension'] ?? ''));
            if ($extension === '') {
                continue;
            }
            $days = [];
            foreach ((array)($entry['days'] ?? []) as $day) {
                $n = (int)$day;
                if ($n >= 1 && $n <= 7) {
                    $days[$n] = true;
                }
            }
            $start = normalizeClock((string)($entry['start'] ?? ''));
            $end = normalizeClock((string)($entry['end'] ?? ''));
            if ($days === [] || $start === '' || $end === '' || $start === $end) {
                continue;
            }
            $roster[] = [
                'extension' => $extension,
                'name' => trim((string)($entry['name'] ?? '')),
                'team' => trim((string)($entry['team'] ?? '')),
                'supervisor' => trim((string)($entry['supervisor'] ?? '')),
                'days' => array_map('intval', array_keys($days)),
                'start' => $start,
                'end' => $end,
            ];
        }
        $cur['roster'] = $roster;
    }

    $json = json_encode($cur);

    if ($json === false) {
        appLog('SETTINGS: json_encode failed for ' . $domain . ': ' . json_last_error_msg());
        return $cur;
    }

    /*
     * Report a failed write instead of swallowing it — the endpoint
     * returns 200 with the new values either way, so a silent failure
     * looks exactly like a successful save until the next page load.
     */
    if (@file_put_contents(domainSettingsFile($domain), $json, LOCK_EX) === false) {
        appLog('SETTINGS: write FAILED for ' . $domain . ' -> ' . domainSettingsFile($domain));
        throw new RuntimeException('Unable to write settings file.');
    }

    return $cur;
}
