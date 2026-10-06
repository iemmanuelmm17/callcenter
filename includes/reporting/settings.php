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
        'slaSeconds' => 20,
        'slaPct' => 80.0,
        'missedPct' => 20.0,
        'abandonPct' => 10.0,
        'ahtMinutes' => 5.0,
        'ahtOutboundMinutes' => 5.0,
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
    ];
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
    return array_merge($base, array_intersect_key($raw, $base));
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
