<?php
declare(strict_types=1);

/**
 * Facade for the reporting layer.
 * 
 * includes/reporting.php used to be 2,348 lines holding the day cache, time
 * helpers, CDR field accessors, row sets, PBX-list caches, cradle helpers and
 * domain settings. It is now a facade over the modules below; every function
 * keeps its name, signature and behaviour, so no caller changed.
 * 
 * Module map (see tools/split-php-file.mjs, which produced the split):
 *   reporting/cache.php     day cache read/write, range status, warming, raw load
 *   reporting/support.php   timezone/date maths, durations, logging
 *   reporting/cdr_fields.php per-CDR accessors and call classification
 *   reporting/rows.php      row sets, aggregation, SLA resolution, AA/inventory reads
 *   reporting/inventory.php PBX list caches, phone normalisation, user directory
 *   reporting/cradle.php    cradle path helpers (guarded: also defined elsewhere)
 *   reporting/settings.php  domain settings file handling
 * 
 * Adding a reporting function? Put it in the module that matches its concern
 * and make sure includes/reporting.php still requires that module.
 */
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/PbxClient.php';

if (!defined('CDR_PAGE_SIZE')) {
    define('CDR_PAGE_SIZE', 250);
}

/*
 * The implementation lives in includes/reporting/*.php. This file stays as the
 * single entry point every caller already requires, so no call site changed.
 */
require_once __DIR__ . '/reporting/cache.php';
require_once __DIR__ . '/reporting/support.php';
require_once __DIR__ . '/reporting/cdr_fields.php';
require_once __DIR__ . '/reporting/rows.php';
require_once __DIR__ . '/reporting/inventory.php';
require_once __DIR__ . '/reporting/cradle.php';
require_once __DIR__ . '/reporting/settings.php';
