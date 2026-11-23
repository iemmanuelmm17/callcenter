<?php
declare(strict_types=1);

/**
 * Template for includes/config.local.php — copy it to config.local.php on the
 * server (that filename is git-ignored, this one is committed).
 *
 * Everything here is optional: config.php defines a safe default for every
 * constant and only skips a definition when this file already made it, so you
 * can set one value without restating the others. Some constants also read
 * environment variables; the SMTP and monitor constants below do not.
 */

/* --- PBX endpoints ------------------------------------------------------- */
// define('PBX_SERVERS', [
//     'nms1' => 'https://nms1.example.com',
//     'nms2' => 'https://nms2.example.com',
// ]);

/* --- NS API credentials (used to refresh the OAuth token) ---------------- */
// define('PBX_CLIENT_ID', 'your-client-id');
// define('PBX_CLIENT_SECRET', 'your-client-secret');

/* --- SIP flow / cradle-to-grave API ------------------------------------- */
// Only needed if that PBX endpoint expects its own token; leave unset to keep
// sending the request without one.
// define('PBX_SIP_TOKEN', 'your-sip-token');

/* --- Recording playback hosts ------------------------------------------ */
/**
 * Recording URLs are only fetched from the hosts in PBX_SERVERS (and, unless
 * this list is set, any sub-domain of a PBX host such as nms1.example.com).
 * If the PBX hands out recording links on a CDN or object-storage host, list
 * those hosts here — exactly, comma separated. Setting this also disables the
 * sub-domain wildcard, so the list is then the complete set of allowed hosts.
 *
 * Downloads from these hosts never carry the PBX bearer token.
 */
// define('PBX_RECORDING_HOSTS', 'recordings.example-cdn.net,storage.example-cdn.net');

/* --- CDR cache backend -------------------------------------------------- */
/**
 * Day cache storage: 'auto' (SQLite when pdo_sqlite is available, else JSON
 * files), 'sqlite' or 'json'. See tools/cdr-cache.php for the migration.
 */
// define('CDR_CACHE_DRIVER', 'sqlite');
// define('CDR_STORE_FILE', '/var/lib/callscope/cdrs.sqlite');

/* --- Other tunables (defaults shown) ------------------------------------ */
/* DEFAULT_TIMEZONE is the FALLBACK only: each tenant's reporting clock is the
 * `timezone` row in Settings -> Service desk, which is what decides day
 * boundaries, hour buckets, the business-hours match and the day-cache key.
 * See includes/timezone.php and README, "Dates, days and the time zone". */
// define('DEFAULT_TIMEZONE', 'US/Eastern');
// define('SESSION_IDLE_SECONDS', 1800);
// define('HISTORICAL_CDR_START_DATE', '2021-01-01');

/* --- Topics and summaries ----------------------------------------------- */
/* The PBX's prefilled-transcription-api, when present and valid, supplies its
 * own month. Otherwise convert the CDR start instant to this IANA timezone.
 * Leave unset until the PBX month basis has been confirmed; the manager can
 * enter a YYYYMM override on the report instead. Offset-less CDR timestamps
 * are interpreted in the desk timezone before conversion. */
// define('INTELLIGENCE_MONTH_TIMEZONE', 'America/New_York');
/* Optional CDR field for the transcription call ID if no validated prefilled
 * link or call-id field is present. Confirm the field with your PBX vendor. */
// define('INTELLIGENCE_CALL_ID_FIELD', 'call-orig-call-id');
/* Only needed when CDRs have no recorded source server (for example, old
 * imported JSONL). Set to a key in PBX_SERVERS after confirming the source. */
// define('INTELLIGENCE_PBX_SERVER', 'nms1');

/* Authenticated SMTP with mandatory STARTTLS and certificate verification.
 * Store these only on the server, never in the repository. */
// define('INTELLIGENCE_SMTP_HOST', 'smtp.example.com');
// define('INTELLIGENCE_SMTP_PORT', 587);
// define('INTELLIGENCE_SMTP_USERNAME', 'user@example.com');
// define('INTELLIGENCE_SMTP_PASSWORD', 'set-on-server');
// define('INTELLIGENCE_SMTP_FROM', 'callscope@example.com');

/* Scheduled automatic alerts (global configuration, server-only).
 * The key needs permission to read CDRs, transcriptions and recordings for every enabled
 * domain. Never commit credentials. Office managers enable each domain in the
 * Keyword Watch panel, where each domain also saves its alert recipients.
 * Install the task described in README.md. */
// define('INTELLIGENCE_MONITOR_API_KEY', 'set-on-server');

/* CDR discovery window for automatic alerts, shared by enabled domains.
 * Whole minutes from 1 to 1440; default 10. Longer windows increase PBX load.
 * Must be at least the task interval and longer than expected call durations. */
// define('INTELLIGENCE_CDR_LOOKBACK_MINUTES', 10);

/* Public HTTPS endpoint for automatic-alert recording downloads. Use the full
 * externally reachable deployment URL; never derive it from an HTTP Host header.
 * Links grant anyone who has them access for 30 days. If unset/invalid, alerts
 * still send without a recording button. Protect CACHE_DIR from web access. */
// define('INTELLIGENCE_RECORDING_URL', 'https://calls.example.com/api/intelligence-recording.php');
