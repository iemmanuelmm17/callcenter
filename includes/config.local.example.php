<?php
declare(strict_types=1);

/**
 * Template for includes/config.local.php — copy it to config.local.php on the
 * server (that filename is git-ignored, this one is committed).
 *
 * Everything here is optional: config.php defines a safe default for every
 * constant and only skips a definition when this file already made it, so you
 * can set one value without restating the others. Environment variables work
 * too and take effect when this file does not define the constant.
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
// define('DEFAULT_TIMEZONE', 'US/Eastern');
// define('SESSION_IDLE_SECONDS', 1800);
// define('HISTORICAL_CDR_START_DATE', '2021-01-01');
