# CHANGES — Simultaneous calls (concurrency) report (2026-10-06)

**New view:** Telephone Numbers → **Simultaneous** tab (graph + interval summary table).
**Files:** `api/simultaneous_calls.php` (new), `assets/js/app.js`, `assets/css/app.css`.
No config, schema, PBX or cache changes; nothing else is touched.

## What it shows

* **Definition of "simultaneous"** — an inbound call occupies capacity from the
  moment it starts ringing until it disconnects, so a call that is never answered
  still counts while it rings. Counted types: **inbound + missed**; outbound and
  on-net legs are excluded (matches the `incoming` metric used by the call modal).
* **Graphs** — simultaneous calls over the range (line), peak by hour of day (24
  bars), peak by day (one bar per day in range).
* **Summary table** — one row per interval with **Date and Time as separate
  columns** (`Date | Time | Simultaneous | Average | Calls started`), sortable,
  searchable, paginated, CSV export, peak interval highlighted. Day labels use the
  Call History formatting (`histDayLabel`, `hist-time`); 24-hour API times are
  rendered as 12-hour `9:45 AM – 10:00 AM` like the rest of the UI.
* **KPIs** — peak simultaneous (with day + time), average simultaneous, busiest
  day, inbound calls counted. Chart points, day/hour bars, table rows and KPIs
  drill into `api/calls.php` (`metric: incoming`, that bucket's day + hour).
* **Filters apply** — the view is fetched with the page's shared `filters`
  (date range, department, site) and the endpoint runs them through
  `authorizedFilters()` + `reportingCdrRows()`, i.e. exactly the pipeline
  `telephone_numbers.php` uses. Bucket size is selectable (5/10/15/30/60 min).

## Endpoint — `api/simultaneous_calls.php`

* Role gate `requirePageRoles($user, ['office_manager'])` — the same SEC-6 pattern
  as `telephone_numbers.php`, since the page is OM-only and the series is
  domain-wide.
* `POST` (JSON body, FUNC-17 422 on malformed JSON) or `GET` for bookmarked links;
  other methods → 405. `end < start` → 422.
* **Exact sweep-line concurrency**, not a per-bucket call count: `+1` at ring
  start, `-1` at disconnect, segments accumulated into buckets — so one 4-minute
  call spanning two 15-minute buckets is one concurrent call in each, and a call
  ending the same second another starts is a handoff (decrements sort first).
  Each bucket carries peak, average (call-seconds ÷ bucket length) and calls
  started; the response also has `byHour` (24), `byDay` (per day) and a summary
  with `peak/peakDate/peakTime`, `average`, `busiestDay`, `busiestHour`, counts.
  Missing `call-disconnect-datetime` falls back to the longest reported duration
  (total, batch, or talk + ring); calls are clipped to the loaded range.
* Payload guard: buckets are widened step by step if a range would exceed 5 000
  buckets (31 days at 5 min → 10 min); the effective size is echoed back in
  `summary.intervalMinutes` and the UI follows it.
* `auditView($user, $filters, 'simultaneous_calls')` — same audit trail as the
  other CDR-serving view endpoints (calls, call_history, report, agents, aa).

## Verification

1. **Math vs an independent oracle** — the real `buildSimultaneousSeries()` code
   (extracted mechanically from the endpoint, run under PHP 8.4 via php-wasm)
   was diffed against a **per-second brute-force** recomputation over real cached
   CDRs: single day (862 rows), 5 days (4 185 rows), 5 days at 5/15/60 min, a
   31-day 5-min range (20 379 rows) and a synthetic edge-case set (midnight-span,
   bucket-boundary span, handoff tie, missing disconnect, missing start, zero
   length, out-of-range clipping, excluded on-net/outbound). Every bucket's
   date/time/endTime/hour/peak/average/started, all 24 byHour rows, every byDay
   row and the whole summary matched — `PASS` on all six fixtures.
2. **Endpoint behaviour** (real `api/simultaneous_calls.php` + real
   `auth.php`/`reporting.php` scoping helpers, PHP 8.4): 200 + expected shape;
   department and site filters change the scoped peak; an empty scope returns
   zeros; supervisor → **403**, agent → **403**; malformed JSON → **422**;
   `DELETE` → **405**; `interval=7` → 5-min; 31-day `interval=5` → 10-min,
   4 464 buckets.
3. **UI** (jsdom + React 18, real components extracted verbatim from `app.js`):
   fetch on mount with the shared filters, 3 charts, KPI ribbon, separate
   Date/Time columns, 12-hour time ranges, search / min-simultaneous / Peak-only
   filters, sorting, pagination, interval switching, CSV export button, row and
   chart drill-down, filter-change refetch, error state and recovery — 32/32
   checks; plus a page-level run that opens the Telephone Numbers page, clicks
   the new tab, and confirms only one endpoint call per tab (13/13 checks).
4. `php -l`-equivalent parse check (php-parser 8.3 grammar) clean; `node --check`
   clean on `app.js`.
5. Deployment note: nothing to migrate. `assets/css/app.css` gains a self-contained
   `.sim-*` block (the compiled Tailwind bundle in this tree is stale, so the new
   styles are written as plain CSS rather than new utility classes).

---

# CHANGES — SEC-4 / SEC-5 / SEC-6 security fixes (2026-09-10)

**Deploy tree:** `/home/user/deploy/` — 29 PHP files (24 `api/`, 5 `includes/`).
**Changed files: 5 of 29.** All other files verified byte-identical (`cmp`) to the reviewed originals.
**Syntax:** `php -l` clean on all 29 files (PHP 8.4.23).
**Per-file diffs:** in `deploy/diffs/`.

---

## 1. `api/login.php` — SEC-5 + SEC-4

### SEC-5 — client credentials no longer accepted from the browser
**Before** (lines 6-7):
```php
$clientId = trim((string)($input['clientId'] ?? getenv('PBX_CLIENT_ID') ?: PBX_CLIENT_ID));
$clientSecret = (string)($input['clientSecret'] ?? getenv('PBX_CLIENT_SECRET') ?: PBX_CLIENT_SECRET);
```
**After** (lines 14-15):
```php
$clientId = trim((string)(getenv('PBX_CLIENT_ID') ?: (defined('PBX_CLIENT_ID') ? PBX_CLIENT_ID : '')));
$clientSecret = (string)(getenv('PBX_CLIENT_SECRET') ?: (defined('PBX_CLIENT_SECRET') ? PBX_CLIENT_SECRET : ''));
```
- Request-body `clientId`/`clientSecret` are ignored (zero references remain — verified).
- Env var preferred, constant as fallback — same precedence as before, minus the browser path.
- `defined()` guards fix the latent PHP 8 fatal: with the env var empty and the constant undefined, the old code threw `Error: Undefined constant` (500 on login); the new code resolves to `''` and the existing `if (!$clientId || …)` check returns a clean **422**.

### SEC-4 — session ID rotated after successful auth
```php
$extension = explode('@', (string)($token['login'] ?? $username))[0];
if (session_status() === PHP_SESSION_ACTIVE) {
    session_regenerate_id(true);
}
$_SESSION['last_activity'] = time();
```
Runs **after** PBX token validation (`access_token`/`domain` checks) and **before** `$_SESSION['user']` is written — so a pre-login planted session ID is discarded before it can be tied to an authenticated user. `session_regenerate_id(true)` also deletes the old session file.

## 2. `api/queue.php` — SEC-6

- **Role gate** (line 15): `requirePageRoles($user, ['office_manager', 'supervisor'])` — matches the UI's route policy; `agent`/`basic_user` now get 403 instead of the full domain queue dashboard.
- **Scoping** (line 123): raw CDRs now flow through the same pipeline as `calls.php`/`call_history.php`/`agents.php`:
```php
$raw = loadRawCdrs($user, $filters);
$raw = scopedCdrs(normalizeCdrs($raw, $directory), $filters, $directory);
```
  `$directory` (line 90) is already loaded at this point. For supervisors, `authorizedFilters` forces their department, so other departments' queue stats, rosters, leaderboards and recent callers are excluded; office managers keep full visibility (and can filter by department/site/agents as before).

## 3. `api/cradle.php` — SEC-6

Identical two-part fix (role gate line 15, scoping line 123).

> **Reconstruction note (read before deploying this file):** your re-uploaded `cradle.txt` arrived as a **0-byte file**, overwriting the 627-line original. This file was reconstructed from `queue.php` plus the complete `diff queue.txt cradle.txt` captured during review round 2 (12 hunks; the line-count arithmetic 646 − 19 = 627 confirms no hunks were missed). Every hunk was content-asserted during reconstruction. **Before deploying, please `diff` this file against the copy on your server** (or re-upload the original) to confirm byte parity of the reconstruction; the SEC-6 patch itself is applied on top and is identical to `queue.php`'s.

## 4. `api/telephone_numbers.php` — SEC-6

- **Role gate** (line 22): `requirePageRoles($user, ['office_manager'])` — the page is OM-only in the UI (`ROLE_ROUTES`) and the DID inventory it returns is domain-wide, so the API now matches. Supervisors get 403 (they were never shown this page either).

## 5. `api/auto_attendant.php` — SEC-6 (retired)

Replaced with a **410 Gone** stub. Rationale: the GET endpoint served CDR data for any caller-supplied extension **without `authorizedFilters` at all**, overlaps `aa.php` (which is properly OM-gated), and is not called by the current client. A 410 makes any stale consumer fail loudly instead of reading unscoped data; the old implementation remains in VCS history and can be re-implemented behind `authorizedFilters()` + `requirePageRoles()` if ever needed.

---

## Verification evidence

**1. Syntax — `php -l` on all 29 files: 0 errors (PHP 8.4.23).**

**2. Blast-radius check — every unmodified file `cmp`-identical to the original upload** (24/24), so this deploy changes exactly 5 endpoints.

**3. Functional tests** (`tests/harness/`): the patched endpoints run end-to-end against a stubbed I/O layer (fake PBX: 2 departments, 2 queues, 2 agents) while the **real** scoping code (`normalizeCdrs`, `scopedCdrs`, `callAgent/callDepartment/callSite`, `classifyCdrType`, plus the party/type helpers — all extracted **verbatim** from the production `reporting.php` and diff-verified) does the filtering. Results:

```
== queue.php as agent        → 403  (was: full domain-wide queue data)
== queue.php as supervisor   → 200  own-dept queue intact (totalCalls=1);
                                     other-dept queue scoped out (0);
                                     KPI totals scoped; leaderboard has no
                                     other-dept agents
== queue.php as office_mngr  → 200  full-domain visibility unchanged (2/2)
== cradle.php as agent       → 403
== cradle.php as supervisor  → 200  scoped (same assertions, all pass)
== cradle.php as office_mngr → 200  unchanged (2/2)
== telephone_numbers.php as agent       → 403 (was: domain-wide DID inventory)
== telephone_numbers.php as supervisor  → 403
== telephone_numbers.php as office_mngr → 200 inventory still served (2 numbers)
== auto_attendant.php (any role)        → 410 Gone
```

**4. login.php tests:**
```
PASS: no env, no const  → no PHP fatal; resolves to '' (clean 422 path)
PASS: const fallback    → PBX_CLIENT_ID/SECRET defined() fallback works
PASS: env precedence    → env wins over const (unchanged behavior)
PASS: env only          → env used with no constant defined
PASS: session_regenerate_id(true) placed after auth success, before $_SESSION['user'] write
PASS: zero client-supplied clientId/clientSecret references remain
```

**5. Negative control (pre-fix behavior, for the record):** the same harness against the *original* `queue.php` serves the supervisor both queues (totalCalls=1 each) and the agent the full dashboard — i.e., the tests distinguish fixed from unfixed.

## Deploy checklist

1. **`config.php` is deliberately NOT in this tree.** The uploaded `config.txt` contains the live `PBX_CLIENT_SECRET` (SEC-1) — that file should stay as-is on the server until the secret is rotated and moved to env vars. Do not copy `deploy/` over `config.php`.
2. **`cradle.php`:** confirm the reconstruction against your server copy first (note above) — everything else can go in the same deploy.
3. Smoke test after deploy (2 minutes, as an agent account): `POST api/queue.php` → expect `403 Forbidden`; `GET api/auto_attendant.php` → expect `410`; login/logout once → session cookie ID changes after login.
4. **Still open (out of scope for this change, do not forget):** SEC-1 (rotate both hardcoded credentials), SEC-2 (recording.php SSRF / token exfiltration), SEC-3 (call_flow traceApi path injection) — plus the DATA-1/DATA-2 data-correctness fixes from the QA report.

## Test harness (kept for regression)

- `tests/harness/includes/reporting.php` — stub I/O + verbatim production scoping logic
- `tests/harness/api/` — copies of the 5 patched endpoints
- `tests/harness/run.php <api> <scenario>` — re-runnable: `php run.php queue.php supervisor`
- `scripts/reconstruct_cradle.py` — the assertion-based cradle reconstruction (also regenerates the pre-patch baseline)
