<?php
declare(strict_types=1);

/* Centralized deployment configuration. Change these values when relocating folders or PBX hosts. */
const APP_ROOT = __DIR__ . '/..';
const API_DIR = APP_ROOT . '/api';
const ASSETS_DIR = APP_ROOT . '/assets';
const CACHE_DIR = APP_ROOT . '/cache';
const LOG_DIR = APP_ROOT . '/logs';
const DEFAULT_TIMEZONE = 'US/Eastern';
const CACHE_TTL_SECONDS = 31536000; // Closed CDR days are immutable; expire after one year as a safety net.
const SESSION_IDLE_SECONDS = 1800;
const SESSION_WARNING_SECONDS = 900;
const CDR_PAGE_SIZE = 250;
const TREND_NOISE_THRESHOLD = 2.0;
// Set this to the first date your tenant retained CDRs. Historical days are cached raw per domain/day.
const HISTORICAL_CDR_START_DATE = '2021-01-01';

const PBX_SERVERS = [
    'nms1' => 'https://nms1.nyc.birns.net',
    'nms2' => 'https://nms2.nyc.birns.net',
];

// Prefer environment variables in production; these defaults intentionally contain no credentials.
const PBX_CLIENT_ID = 'report';
const PBX_CLIENT_SECRET = 'daffafeef50bf0562ddf5b158a75c5d6';

define('PBX_RATE_LIMIT_REQUESTS', 5);
define('PBX_RATE_LIMIT_WINDOW', 1.0);