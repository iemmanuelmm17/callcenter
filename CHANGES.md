# CHANGES — UI quality pass: cursors, keyboard parity, dialogs, skeletons, lazy Tabulator (2026-10-06)

**Scope:** presentation only. No endpoint, no response shape, no query changed;
the PHP suite is untouched and still passes.

**Files:** `assets/js/src/app.js` (+ `assets/js/app.js` rebuilt),
`portal.php`, `assets/css/app.css` (rebuilt), `tests/js/harness.mjs`,
`tests/js/smoke.mjs`, `tests/run.mjs`, `README.md`, new `tools/ui-audit.mjs`.

## New audit tool

`tools/ui-audit.mjs` walks all 1,365 `h(...)` elements in the dashboard source
and reports what a compiler cannot: clickable elements with no cursor styling,
clickable elements with no keyboard path, interactive controls with no tooltip,
JS colour literals that duplicate a theme token, clickable classes with no
stylesheet cursor rule, loading states with no skeleton, hand-rolled
placeholders that bypass the shared shimmer helper, eagerly loaded heavy
dependencies, and the remote assets the shell still pulls.
`tools/ui-audit.mjs --strict` (also part of `npm test`) fails on the four
classes of finding that must stay at zero; it was itself validated by injecting
a violation of each kind and confirming exit 1.

## What it found and what changed

| finding | fix |
| --- | --- |
| 8 clickable backdrops/modals (`hist-modal-bg`, `hist-modal`, `set-overlay`, `set-modal`, `aa-call-sheet`, `call-modal`) with no cursor styling — they inherited the text cursor although a click on them dismisses the dialog | `cursor-default` on all eight; a backdrop must never look like a button |
| 4 clickable table rows (`CallHistory`, simultaneous intervals, queue recent calls, agent activity) and the auto-attendant list item were mouse-only | `tabIndex` + `onKeyDown` through a new `keyActivate()` helper: Tab reaches them, Enter/Space activates (with `preventDefault` so Space does not scroll) |
| dialogs had no semantics: screen readers saw a plain div, and Escape did nothing anywhere | `role="dialog"`, `aria-modal`, `aria-label` on all four dialogs and `role="presentation"` on their backdrops; new `useEscape()` hook closes each dialog with Escape (bound once per open, via a ref) |
| 4 hand-rolled `animate-pulse bg-slate-800` placeholders (agents sidebar, telephone table, agent comparison, auto-attendant list) ignored the light theme and shimmered at a different rate than every other loader | replaced with the shared `skel()` helper |
| Tabulator (≈500 kB JS + its midnight stylesheet) was loaded eagerly from a CDN on every page although only the call modal uses it | `ensureTabulator()` injects the pinned stylesheet and script on first use; the modal waits for the global before creating the table and reports an error instead of hanging if the CDN fails. Shell now loads 3 remote assets instead of 5, all `defer` |

The three remaining components the audit first flagged as "loading without a
skeleton" were false positives of the audit itself: it cut component bodies at
the next `const` declaration, including nested helpers like `const tile = (`.
It now only treats PascalCase declarations as component boundaries, and accepts
`loading` forwarded to a child that renders the skeleton. `CallHistoryDashboard`
and `TelephoneNumbers` always had skeletons.

## Verification

`npm test`: php lint, css coverage, **ui audit --strict**, dead code --strict,
build, js smoke (now also asserts keyboard activation, dialog roles, backdrop
styling and Escape), api matrix 86 checks, url policy 62, csv exports 17 — all
pass. The rebuild of `assets/js/app.js` and `assets/css/app.css` is committed.

---

# CHANGES — Reporting layer split behind a facade, plus the splitter tool (2026-10-06)

**Scope:** structure only. Every function keeps its name, signature, guards and
byte-identical body; no caller changed, no endpoint contract changed.
**Files:** `includes/reporting.php` (2,348 → 41 lines, now a facade),
`includes/reporting/{cache,support,cdr_fields,rows,inventory,cradle,settings}.php`
(new), `tools/split-php-file.mjs` + `tools/reporting-modules.json` (new),
`tests/php/php.mjs`, `README.md`.

## What moved where

| module | lines | contents |
| --- | --- | --- |
| `reporting/cache.php` | 304 | day-cache read/write, TTL, range status, warming, raw CDR load |
| `reporting/support.php` | 186 | timezone/date maths, durations, percentile, exception logging |
| `reporting/cdr_fields.php` | 464 | per-CDR field accessors and call classification |
| `reporting/rows.php` | 901 | row sets, aggregation, SLA resolution, AA/inventory reads |
| `reporting/inventory.php` | 316 | PBX list caches, phone normalisation, user directory |
| `reporting/cradle.php` | 138 | cradle path helpers (the `function_exists` guards are preserved) |
| `reporting/settings.php` | 113 | domain settings file handling |

`includes/reporting.php` still exists and still requires `auth.php` and
`PbxClient.php` first, so all 17 endpoints and every include that requires it
keep working untouched.

## How the split was done, and why that is safe

`tools/split-php-file.mjs` locates each top-level declaration with php-parser
(offsets, not text matching), keeps docblocks attached, preserves the original
order inside each module, and refuses to run unless the map covers every
function exactly once. The map is committed as `tools/reporting-modules.json`.

Verification that nothing was altered: hashing every function's exact source
text before and after gives **74 functions before, 74 after, 0 missing, 0
added, 0 changed bytes**. The full PHP suite then exercises the result: API
matrix 86 checks, CSV exports 17, URL policy 62 — all pass, which means every
endpoint still produces the same responses through the new facade.

The test harness had to learn one thing: `tests/php/php.mjs` now mirrors
`includes/` recursively (it copied only the flat `includes/*.php` before), so
the package is present inside the phpwasm interpreter too.

## Deploy note

`includes/reporting/` is new — the deploy set for this commit is
`includes/reporting.php` **and** `includes/reporting/*.php`. Nothing else.

# CHANGES — CSV exports export everything, not just the visible page (2026-10-06)

**Scope:** export correctness + the bugs found while auditing every export in
the app. No chart, table or endpoint contract changed.
**Files:** `includes/export.php` (new), `api/{call_history,calls,telephone_numbers}.php`,
`assets/js/src/app.js`, `includes/bootstrap.php`, `tests/php/export.mjs` (new),
`tests/js/{harness,smoke}.mjs`, `tests/run.mjs`.

## The bug: "Export CSV" wrote the page, not the data

| where | before | after |
| --- | --- | --- |
| Call History | serialised the 25 rows of the *current page* (a 30 000-row range exported 25 rows, while the KPI above said 30 000) | server streams every row matching the filters |
| Call details modal | re-requested the result 100 rows at a time and rebuilt the CSV in the browser — one full CDR scan **per page** | one request, streamed from the single scan the endpoint already does |
| Telephone Numbers | **no export at all**, and the table only ever renders 10 rows | new export of the complete inventory for the range |

The endpoints now answer `export: true` with `Content-Type: text/csv` and a
`Content-Disposition: attachment` filename; the browser writes the bytes to
disk. Nothing is JSON-encoded on the server for an export or parsed and
re-serialised in the client, and no pagination limit applies.

Row mapping is shared, not duplicated: `histRow()` and `callsRow()` are the
functions the JSON pages already used, so a column can never drift between the
table and the file. Values are formatted exactly like the UI
(`fmt` → `csvDuration`, `formatMmss` → `csvMmss`, `formatPhoneNumber` →
`csvPhone`, `nsTimestampParts`/`formatHistDate` → `csvStamp`/`csvHistStamp`) —
verified against the same inputs in `tests/php/export.mjs`.

## Security and housekeeping for exports

* CSV-injection (`=`, `@` and control characters are neutralised with a leading
  apostrophe): caller-ID names come from the PBX and are attacker-controlled, so
  `=HYPERLINK("http://evil","click")` as a "name" must not execute when the file
  is opened in Excel or Sheets. `+`/`-` are deliberately left alone (country
  codes, negative deltas).
* UTF-8 BOM so Excel reads accented names correctly; `X-Content-Type-Options:
  nosniff`; the filename is sanitised before it reaches the header.
* `CSV_EXPORT_MAX_ROWS` (200 000) bounds a runaway range.
* Exports are audited (`auditView(..., 'call_history_export')`) and inherit the
  existing role gates — a supervisor still cannot export the DID inventory.
* Filters are honoured: search terms, outcome, call types and the page-wide
  range/site/department filters all reach the export. The Telephone Numbers
  export deliberately ignores the *browser-side* toggles (search box, type,
  "Active only") so the file is the complete inventory, which is the point of
  an inventory export.

## Other bugs fixed while auditing

* **Telephone Numbers pagination reset.** `visibleNumbers` was rebuilt on every
  parent render, so the table's `useEffect(..., [data])` reset the page to 1 on
  any unrelated re-render (typing a search, a tab switch, the cache banner).
  Now memoised.
* **Queue summary CSV header** labelled the queue column `extension` while
  writing the queue id into it.
* **Queue "Recent calls" export** silently shipped a server-capped 200-row list
  as if it were the range; the button now says so and points at Call History.
* **Call History export button** was disabled only when the current page was
  empty; it now reflects the real total and shows an "Exporting…" state.

## Suspicions checked and disproved (no change made)

* Dashboard "Agent status" donut: `statusSlices` reads `data.agentStatus`, which
  `api/queue.php` returns — it is served correctly (empty until a queue is
  selected, as its hint says).
* Dashboard export `pctDelta(c.outbound, ...)`: `c` is `report.summary.counts`,
  so `c.outbound === outboundCount` — the same value.
* Call details modal: `api/calls.php` does return `total` and `last_page`, so
  the modal's pagination was never the export's problem.

## Verification

* `npm test` → **ALL SUITES PASSED**: php lint, CSS coverage, dead code,
  build, JS smoke, API matrix 86 checks, URL policy 62 checks, **csv exports 17
  checks**.
* `tests/php/export.mjs` proves on real PHP 8.4: the export row count equals the
  filtered total and ignores `page` (asked for page 2, got all 17 rows); headers
  match the UI columns; `Aug 2, 9:00 AM` / `00:05` / `00:55` identical to the
  table; the formula-like caller name is neutralised; each export is audited;
  and the 403 role gates hold.
* `tests/js/smoke.mjs` clicks all three export buttons in the real bundle and
  asserts each one POSTs `export: true` with the active filters (12 new checks).

# CHANGES — Dead code removal and entry-point cleanup (2026-10-06)

**Scope:** delete what nothing calls, plus the duplicate entry point. No feature
change, no endpoint the front end uses was touched.
**Files:** 5 endpoints deleted, `diffs/` and `portal/` removed, `index.js`
removed, 12 PHP functions and 7 JS declarations removed, `api/aa.php`,
`portal.php`, `tools/dead-code.mjs` (new), `tests/*`.

## Evidence, not memory

`tools/dead-code.mjs` (new) parses every PHP file with php-parser and counts
whole-word references across PHP, JS, tests, tools and markdown; positions come
from the AST, so a declaration is either referenced or it is not. It is now part
of `npm test` in `--strict` mode, so dead code cannot creep back in.

## Endpoints deleted (nothing referenced them)

| file | why |
| --- | --- |
| `api/activity.php` | not called by the front end or any PHP file |
| `api/audit.php` | the audit *reader*; see the note below |
| `api/auto_attendant.php` | superseded by `api/aa.php` (SEC-6 retirement) |
| `api/clear-cache.php` | superseded by `api/cache_job.php` |
| `api/warm-cache.php` | superseded by `api/cache_job.php` |

The front end's endpoint list was extracted from the source rather than assumed:
`aa, agents, alerts, cache_job, call_flow, call_history, calls, cradle, filters,
login, logout, queue, recording, report, session, settings, simultaneous_calls,
telephone_numbers` — every one of those still exists.

**Note on `api/audit.php`:** it was the only reader of the audit trail.
`auditView()` is still called by 8 endpoints and keeps appending to
`logs/audit-YYYY-MM-DD.jsonl`, so the trail is still recorded for forensics but
no longer readable from the UI. If you want it back, it is one gated endpoint.

## PHP functions deleted (never called)

`includes/reporting.php`: `logicalCallKey`, `pickPrimaryLeg`,
`dedupeLogicalCalls`, `cdrInboundMissed`, `durationLabel`,
`telephoneNumberCallStats`, `cdrDisconnectText`, `clearCache` (the last one lost
its only caller, the deleted `clear-cache.php`).
`api/telephone_numbers.php`: `handleUpdate` (a PUT route that never existed) and
`filterCdrsByTimezoneRange`, plus `easternCalendarDate`.
`includes/auth.php`: `routesForRole` — the route policy that actually applies
lives in the front end's `ROLE_ROUTES` and in each endpoint's `requirePageRoles()`.

Also removed: the dead `api/aa_options.php` fallback `require` in `api/aa.php`
(that path has never existed) and, in `PbxClient`, the now-unused `sipTime`,
`sipHostname` and `sipCallids` helpers whose logic moved into
`includes/security.php` in the security phase.

## JS deleted (the bundled source is smaller by ~1.2 kB)

`histOrdinal`, `outcomeTone`, `SkeletonBlock`, `Heatmap`, `TopAgents`,
`formatComparisonDate` — all top-level declarations with exactly one occurrence
(the declaration itself) — and the write-only `cacheGate`/`cacheKey`/
`cacheReady` state in the dashboard, including its five `setCacheGate()` updates
in the cache-warming effect. That effect still reports progress through
`cacheJob` (which the banner renders); nothing ever read the gate.

## Other cleanup

* `index.js` (Tailwind v3 config at the repository root) — nothing referenced it;
  Tailwind v4 is configured in `assets/css/src/app.css`.
* `diffs/` — five stale `.diff` files from earlier work.
* `portal/portal.php` — a stale duplicate shell that required a
  `portal/includes/bootstrap.php` which does not exist, and still loaded the
  Tailwind CDN. `index.php` → `portal.php` is the only entry point.
* `portal.php` — dropped a dead `<link rel="stylesheet" href="https://cloudflare.com">`
  and the Alpine.js CDN script (zero references in the bundle).
* `api/recording.php` still uses Tabulator for one table; the CDN dependency and
  that table are handled with the front-end work in the next phase.

## Verification

* `npm test` → **ALL SUITES PASSED** (php lint, CSS coverage, dead code
  `--strict`, build, JS smoke, API matrix 87 checks, URL policy).
* `tools/dead-code.mjs --strict` → **0 unreferenced PHP functions, 0 unreferenced
  JS declarations, 0 orphan files**.
* The JS smoke test caught a real mistake made while editing: the first attempt
  removed the `cacheGate` state but left five `setCacheGate()` calls behind,
  which threw `ReferenceError: setCacheGate is not defined` on the dashboard.
  The gate state and its calls were removed together and re-verified.
* Rebuilt bundles: `assets/js/app.js` 438.9 kB (was 443.7 kB at the start of
  this phase).

# CHANGES — Security: recording proxy SSRF/token leak, call-flow trace injection, configuration loading (2026-10-06)

**Scope:** security fixes only. No UI change, no endpoint removed from the
front end, no cache format change.
**Files:** `includes/security.php` (new), `includes/PbxClient.php`,
`includes/config.php`, `includes/bootstrap.php`, `includes/auth.php`,
`api/recording.php`, `api/call_flow.php`, `api/agent_performance.php` (deleted),
`includes/config.local.example.php` (new), `tests/php/*`.

## SEC-2 — recording proxy could leak the bearer token

`api/recording.php` accepted a client-supplied `src` URL whenever the host name
merely *contained* `birns.net` **or** the URL contained `/ns-api`. `PbxClient::download()`
then attached `Authorization: Bearer <PBX token>` and followed redirects. So
`src=https://attacker.example/ns-api/x` (or `https://169.254.169.254/…/ns-api/`,
or `https://birns.net.evil.example/ns-api/x`) made the server hand the PBX token
to a third party, or reach inside the network.

Now (all in `includes/security.php`, one policy for the whole app):

* a recording URL must be `https` (the scheme the PBX is configured with), on a
  host that is either listed in `PBX_SERVERS`, listed in the new
  `PBX_RECORDING_HOSTS`, or a sub-domain of a PBX host *when that host has three
  or more labels* (`nms1.example.com` → `*.example.com`; a two-label PBX host
  grants no wildcard). IP literals are only accepted when explicitly configured;
  ports must match the PBX port; `user:pass@` URLs, `/../`, control characters
  and CRLF are refused; the path must start with `/ns-api/`.
* the token is attached **only** to allowlisted hosts. Redirects are no longer
  followed blindly: each hop is re-validated, the token is dropped the moment a
  hop leaves the allowlist, and a hop that is neither a PBX host nor a public
  one is refused (max 3 hops, `CURLINFO_REDIRECT_URL` based).
* a URL the PBX itself returns but that is *not* on the allowlist (a CDN or
  object storage) is still playable through `downloadPublic()`, which never
  sends the token and insists on a public host (private, loopback, link-local,
  CGNAT and reserved ranges are refused; DNS failure means refusal) and port 443.
* a hostile `src` now fails closed with **400** instead of silently falling
  through to a fresh lookup.

## SEC-3 — call flow let the caller choose the PBX request path

`api/call_flow.php` passed a client-supplied `traceApi` straight to
`PbxClient::sipflowCradle()`, which used it as the PBX path+query as long as the
string contained `sipflow`. A supervisor could therefore drive the server's
token at any PBX endpoint (`/ns-api/v2/domains/...`) and inject arbitrary query
parameters.

Now the path is always the canonical `/ns-api/v2/sipflow`; a trace value
contributes **query values only**, filtered to `start_time`, `end_time`,
`callids`, `servers` and `type`, each re-validated (call-id charset, hostname
shape, timestamp shape, `type` from the known list, length caps, no control
characters). Unknown parameters are dropped, duplicates keep the first, and a
trace pointing at another host or another PBX endpoint is refused with **400**
before any request is made.

## Configuration — the promised local file was never loaded

`.gitignore` documented `includes/config.local.php`, but nothing read it, and
the committed `config.php` had `const PBX_SERVERS = ['nms1' => '', ...]` with no
environment support even though its own comment said "prefer environment
variables". `includes/config.php` now:

* loads `includes/config.local.php` first when present (it may `define()`
  anything and wins over the defaults),
* then reads `PBX_SERVERS` (JSON object), `PBX_SERVER_<NAME>`,
  `PBX_CLIENT_ID`, `PBX_CLIENT_SECRET`, `PBX_SIP_TOKEN` and
  `PBX_RECORDING_HOSTS` from the environment,
* and only then defines the safe built-in defaults,
* `includes/config.local.example.php` documents every knob.

Also fixed while there: `includes/auth.php` read `PBX_CLIENT_SECRET` from the
constant only, so a deployment using the environment variable could not refresh
its token; the SIP-flow request had a hardcoded empty bearer token
(`$sipToken = ''`), and now sends `PBX_SIP_TOKEN` when one is configured —
an unset value keeps the previous request byte for byte.

## Deleted

`api/agent_performance.php` — no session/role gate beyond login, no references
anywhere in the codebase (grep for `agent_performance` returns nothing) and
superseded by `api/agents.php`.

## Verification

* `npm test` → **ALL SUITES PASSED**: php lint (35 files), CSS coverage, build,
  JS smoke, API matrix **105 checks**, URL policy **62 checks**.
* New `tests/php/security.mjs` runs the policy functions under real PHP 8.4:
  18 recording-URL verdicts, 8 public-URL verdicts, 8 trace verdicts, allowlist
  derivation, redirect resolution and 6 SIP-flow path-builder cases
  (`evil.example`, `pbx.example.evil.example`, `169.254.169.254`, `file://`,
  `javascript:`, `../`, CRLF — all refused; legitimate PBX URLs still allowed).
* New endpoint-level regressions in `tests/php/endpoints.mjs`: 8 hostile `src`
  values and 3 hostile traces must return 400 **and leave the PBX client
  untouched** (the stub logs every call it receives), while a PBX-hosted
  recording still resolves and streams.
* The harness deployment now configures `PBX_SERVERS` through
  `includes/config.local.php`, which is itself the proof that the local file is
  honoured.

## Review observations recorded but not fixed here (tracked for the next phases)

* audit logging covers 8 endpoints; `call_flow.php`, `recording.php`,
  `telephone_numbers.php`, `calls.php` and the cache endpoints do not call
  `auditView()`. (Design decision, not an exploit — to be decided with you.)
* `api/aa.php` still contains a fallback `require` for `api/aa_options.php`,
  which does not exist — dead code (removed in the dead-code phase).
* `PbxClient::cradle()`, `cradlePortalPath()` and `cradleKeyFromCdr()` are never
  called; `cradle()` builds an unencoded PBX path, so it is removed rather than
  repaired.
* duplicated policy: `routesForRole()` in `includes/auth.php` is never called —
  the real route policy lives in the front end (`ROLE_ROUTES`), and the
  endpoints each repeat `requirePageRoles()`.

## Deploy checklist

1. Copy `includes/` (config.php, bootstrap.php, auth.php, PbxClient.php,
   security.php), `api/` (recording.php, call_flow.php; delete
   agent_performance.php).
2. Nothing to set by default: existing `PBX_SERVERS` in
   `includes/config.local.php` or the environment keeps working. If recordings
   are served from a CDN host, add it to `PBX_RECORDING_HOSTS`.
3. No cache, session or database migration.

# CHANGES — Development toolchain, committed build, test harness (2026-10-06)

**Scope:** engineering hygiene only — no change to what the application does.
**Files:** `package.json`, `package-lock.json`, `README.md`, `tools/build.mjs`,
`tools/css-coverage.mjs`, `tools/php-lint.mjs`, `tests/run.mjs`,
`tests/js/{harness,smoke}.mjs`, `tests/php/{php,endpoints}.mjs`,
`assets/js/src/app.js`, `assets/css/src/{app,custom}.css`,
regenerated `assets/js/app.js` + `assets/css/app.css`, `.gitignore`.

## Why

`app.js` (12 254 lines) and `app.css` were edited directly and had drifted:
105 Tailwind utilities used by the markup were **not** in the committed
stylesheet (the CDN produced them at runtime), 52 custom classes were missing
too, and `app.js` injected 15 KB of CSS at run time. This commit puts both
bundles under a real, reproducible build and adds the harness the rest of the
refactor is verified against.

## The build

* **Split the source out of the artefacts.** The hand-written part of the old
  `app.css` (2 585 lines) now lives in `assets/css/src/custom.css`; the new
  16-line entry `assets/css/src/app.css` imports Tailwind, lists its scan
  sources explicitly, and imports the hand-written file. `assets/js/src/app.js`
  is the bundle entry (the previous `app.js`, unchanged in behaviour).
* `node tools/build.mjs` runs esbuild (IIFE, es2020, banner-marked as
  generated) and the Tailwind CLI, then asserts that a set of load-bearing
  selectors (`.q-table`, `.hist-listen`, `.sim-panel`, `.tn-kpi-mini`, …) is
  present in the output — a build that silently drops a stylesheet fails.
* **Deterministic output.** Tailwind's automatic source detection was walking
  the compiled bundles, so class names from yesterday's `app.css` kept
  generating utilities and two consecutive builds of identical sources
  produced different CSS (verified: `.filter` and two theme variables appeared
  only on the first build). The entry now uses `source(none)` plus an explicit
  `@source` list, and `tests/run.mjs` rebuilds on every run — a rebuild that
  changes the committed bundle is a signal, not noise.
* The 15 631-character CSS block that `app.js` injected at run time (recording
  player styles, `rec-player-styles`) moved into `custom.css`; the injection
  code is gone.

## Bugs the new pipeline surfaced (fixed)

* `custom.css` carried a corrupted declaration (`lor: #94a3b8;` plus a stray
  brace) and a duplicated `.qs-table thead th` rule, both inherited from the
  committed `app.css` (line 3579). Tailwind v4 refuses to parse it
  (`CssSyntaxError: Missing opening {`); browsers had been dropping the rule
  silently. Both removed.
* Concrete missing-class fixes: `.sim-table-scroll` added, the inert
  `tn-table` class dropped. Coverage is now **0 missing utilities, 0 missing
  custom classes** (34 documented exceptions: FontAwesome names and inert
  selector hooks).

## The harness

* `tests/js/` boots the **built** bundle in jsdom with real React 18 and Chart
  stubs, then walks all six nav routes, the four Telephone Numbers tabs, the
  settings modal, an agent sub-tab and a dashboard-KPI → call-modal drill-down,
  failing on any unexpected runtime error.
* `tests/php/` runs every `api/*.php` under real PHP 8.4 (php-wasm) with a
  stubbed `PbxClient` that mirrors the real client's method signatures, and
  asserts **90** checks: no session → 401, wrong verb → 405, forbidden role →
  403, allowed role → 2xx, and no PHP fatal leaking into a response.
* `npm test` runs php lint → CSS coverage → build → JS smoke → API matrix in
  about four seconds. The API matrix is the contract the next refactors
  (security fixes, dead-code removal, file splits, SQLite cache) are checked
  against, so it is written as a table that is meant to be extended.

## Verification

* `npm test` → **ALL SUITES PASSED** (php lint on 34 files, 690 class tokens
  with 0 missing, build 443.7 kB JS / 134.4 kB CSS, JS smoke clean, API matrix
  90/90).
* Bundle behaviour is unchanged: the previous single-file `app.js` was moved
  to `assets/js/src/app.js` verbatim and rebuilt — the built JS is byte-identical
  to the pre-refactor bundle apart from the removed run-time CSS injection.
* No endpoint, no cache format, no config and no database change.

## Deploy checklist

1. Copy `assets/js/app.js`, `assets/css/app.css` (or leave the SFTP mirror to
   handle static files). Nothing else in this commit is deployed.
2. `tests/`, `tools/`, `package.json`, `README.md` are development-only and can
   be left out of the deploy set.

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
