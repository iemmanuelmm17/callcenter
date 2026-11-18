# CallScope reporting

Call-centre reporting dashboard for the Birns PBX: PHP endpoints under `api/`,
a single-page React front end (deployed as `assets/js/app.<hash>.js` +
`assets/css/app.<hash>.css`, built from `assets/*/src`), and a cache of PBX CDRs
under `cache/`.

```
index.php            → redirects into the app shell (portal.php)
portal.php           → the HTML shell that boots assets/js/app.js
api/*.php            → one endpoint per view (session + role gated, JSON in/out)
includes/            → shared code: bootstrap, auth, security, export, PBX client, config
includes/reporting/  → the reporting layer as modules, loaded by includes/reporting.php
                       outcomes.php holds the one definition of missed / abandoned
assets/js/app.<hash>.js → DEPLOYED bundle (generated, minified, content-hashed)
assets/css/app.<hash>.css → DEPLOYED stylesheet (same)
assets/build-manifest.json → which hashed files to load + their sha384 (portal.php reads it)
assets/vendor/       → vendored third-party libraries + fonts (see "Third-party assets")
assets/js/src/       → bundle source (this is what you edit)
assets/css/src/      → stylesheet source (Tailwind entry + hand-written CSS)
assets/js/app.js, assets/css/app.css → dev build, unminified, NOT committed
cache/, logs/        → runtime state, never committed (includes cdrs.sqlite, the
                       CDR day cache; see "CDR cache" below)
tests/, tools/       → development harness (not deployed)
```

## Deploying

The deployed application is plain PHP + static files: copy `*.php`, `api/`,
`includes/` **including `includes/reporting/`**, `assets/`, and `CHANGES.md` to
the web root. There is no build step on the server and no database to migrate —
the front end is the committed prod bundle (`assets/js/app.<hash>.js`,
`assets/css/app.<hash>.css`, named by `assets/build-manifest.json`).

Cache the two hashed files hard (`Cache-Control: public, max-age=31536000,
immutable`): their names change whenever their bytes do, so a deploy cannot be
half-served. `npm run build:prod` before committing any source change — `npm
test` fails if the committed pair is stale.

**Upload in binary mode, and verify it.** Every vendored file and both build
artifacts are loaded with a Subresource Integrity hash, so the bytes that arrive
at the browser must be the bytes in `VENDOR.json` / `build-manifest.json`. An
ASCII-mode FTP transfer rewrites LF as CRLF, the browser then blocks the file
("failed to find a valid digest in the integrity attribute") and the dashboard
renders blank. Two things are here to make that visible rather than mysterious:

* the repository pins line endings in `.gitattributes` (`* text=auto eol=lf`,
  and `-text` for everything whose bytes are hashed), so a Windows checkout
  cannot rewrite them either;
* `node tools/deploy-check.mjs <base-url>` fetches what the server is actually
  serving and compares it byte for byte with this repository, naming any file
  that differs and saying whether the cause was a line-ending rewrite:

  ```
  node tools/deploy-check.mjs http://example.com/callscope/
  npm run deploy:check -- http://example.com/callscope/
  ```

  It also checks that the manifests on the server are this revision's, so a
  deploy of the wrong tree is reported as such. Exit code is 1 on any mismatch,
  so it can gate a deploy script.

If a mangled upload does get through, the page says so itself: portal.php stats
every file the manifests name and renders a `#deploy-warning` block listing the
files whose size does not match, above the (blocked) app.

## Third-party assets

The page loads React, ReactDOM, Chart.js, Font Awesome and IBM Plex Mono from
`assets/vendor/`, and Tabulator lazily from the same place. Nothing is fetched
from a CDN and every tag carries an SRI hash, so the app works on a network that
blocks the public internet — and a compromised CDN cannot run code in an
authenticated session.

```
npm run build:prod   # also regenerates nothing here; vendor files change only when a version does
node tools/vendor.mjs          # re-copy the vendored files from node_modules
node tools/vendor.mjs --check  # verify their hashes (part of npm test)
```

Versions are pinned in `package.json` (devDependencies only), the files come out
of those npm packages — never a CDN — and `assets/vendor/VENDOR.json` records
each file's sha256/sha384 plus the upstream licenses in
`assets/vendor/licenses/`. Bumping a version is: change the pin, `npm install`,
`node tools/vendor.mjs`, `npm run build:prod`, commit. `tools/no-cdn.mjs` (in
`npm test`) fails if a template or source starts referencing a CDN again.

Configuration comes from the environment (`PBX_SERVERS`, `PBX_CLIENT_ID`,
`PBX_CLIENT_SECRET`, `PBX_SIP_TOKEN`, …) or from `includes/config.local.php`,
which stays on the server (it is git-ignored).

## Missed and abandoned

Every report derives missed and abandoned calls from
`includes/reporting/outcomes.php` — one place, so the same call cannot be
abandoned on one screen and missed on another:

| outcome | rule |
| --- | --- |
| `answered` | answer timestamp on either leg (`call-answer-datetime` **or** `call-batch-answer-datetime`) or any talking seconds |
| `abandoned` | not answered, and the call reached a queue or auto attendant (queue / AA / IVR signals in the CDR, or a queue batch leg) |
| `voicemail` | not answered, and it ended in a mailbox (voicemail fields, or `call-direction` 2) |
| `noanswer` | not answered, and it never reached a queue, an IVR or a mailbox |

`missed` in the reports means "not answered" (all four except `answered`), and
`abandoned` is a subset of it. The Dashboard's offered volume is
`inbound + missed`; the Queues screen's offered is `answered + abandoned` for
the queued calls only, which is a scope difference and is stated in its column
tooltips. `tests/php/outcomes.mjs` asserts that all seven report navs agree on
these numbers for the same CDRs.

## Drill-downs

Every figure that opens a call list sends the filters that figure was computed
with, so the list adds up to the number that was clicked: the agent (or the whole
table), the queue scope, the date range of the screen the number came from, the
part of an hour a Simultaneous interval covers (`timeFrom`/`timeTo`), and — for a
row that *is* one call — its `callId`. The same filters drive the CSV export.

What the global bar holds comes along too — outcome, sentiment, wait, callback
state — because the list behind a card is that card's population, not the whole
day. A filter the bar owns and no card names is therefore shown in the modal as
a chip (`Outcome`, `Sentiment`, …), so the rows can be read against the scope
that produced them; an unknown filter value is no filter on either endpoint
rather than a silent empty list. Two figures deliberately do **not** narrow with
the bar: the missed-returned / missed-not-returned worklist and the Transfer
reasons pairs. They classify interactions over the scoped period — a miss stays
returned even when the outbound leg is outside the subset you happen to be
viewing — and the chip above them names the subset the rows are drawn from.

The call-details modal also carries a **Rec** column (plays the recording in a
tray under the table; resolved on click, never cached in the row) and a **SIP
flow** column (the cradle-to-grave dialog, shared with Call history). Both are
booleans on the row — `hasRecordingHint` / `hasFlowHint` — because resolving
either one is a PBX walk.

## Dates, days and the time zone

A report day is a wall-clock fact, so it belongs to the desk, not to the server
it happens to run on. **Settings → Service desk → Timezone** stores `timezone`
per domain, in the same file as the SLA targets and the opening-hours calendar
(`cache/settings-<sha256>.json`), defaulting to `DEFAULT_TIMEZONE`
(`includes/config.php`, `US/Eastern`) for a tenant that has never chosen one.

That one value decides:

* which date a call belongs to — `callLocalDate()` and therefore every
  `filterCallsByLocalDate()`, card and chart;
* the hour-of-day buckets the hour chart and the drill-down's `hour` filter use;
* the `[00:00, 23:59:59]` window a day is fetched from the PBX with
  (`easternDayWindow()` — the name is historical, the window is the desk's);
* whether a call was inside the opening hours, and so what `hours=business`
  counts;
* the day-cache key. `cdrDayCacheFile()` hashes the zone into the filename and
  the SQLite store keys days on `(domain, tz, day)`, on purpose: **changing the
  timezone re-fetches the days in the requested range** rather than serving a
  day cut by the old boundaries. That is the cost, and it is the whole point.

The plumbing is one rule: *whoever resolves a date resolves the zone first.*
`includes/timezone.php` holds the resolver (`reportingTimezoneName()`,
`reportingTimezone()`, `setReportingTimezone()`, `normalizeTimezoneName()`);
`authorizedFilters()` applies the signed-in user's domain setting at the top of
every reporting endpoint, so no aggregation helper may read `DEFAULT_TIMEZONE`
directly. `portal.php` writes the same value into a `#app-clock` JSON island
before the bundle runs and `lib/api.js` re-applies the `timezone` field every
payload carries, so the browser's "Today", the range the date picker opens with
and the `datetimeStart`/`datetimeEnd` window sent to the PBX are the desk's — a
tenant in Manila no longer opens on yesterday. `api/session.php` and
`api/login.php` answer the zone too, because neither runs through
`authorizedFilters()`.

Two deliberate edges. A bare UTC offset (`+08:00`) is **refused**: it has no DST
rules, so a desk stored that way drifts by an hour twice a year — which is the
bug this setting exists to fix. And `US/Eastern` is kept as the stored default
rather than renamed to `America/New_York`: the two are the same zone but
different cache keys, so a rename would have invalidated every day cache on
every box for a spelling.

## CDR cache

The raw PBX CDRs are cached per day (domain + timezone + date — the timezone is
the tenant's own setting, see *Dates, days and the time zone* above) so a report
does not refetch history. Two backends, chosen by `CDR_CACHE_DRIVER`:

| value | storage | when |
| --- | --- | --- |
| `auto` (default) | SQLite when `pdo_sqlite` is available, else JSON | start here |
| `sqlite` | `cache/cdrs.sqlite` (`cdr_days` + `cdr_records`) | after checking `status` |
| `json` | `cache/cdr-day-<sha256>.json`, one file per day | previous behaviour |

Move an existing deployment over with `php tools/cdr-cache.php` (status, import,
verify, days, prune) — see `CHANGES.md` for what each command guarantees. Until a
day has been imported, the JSON file for it is still read, so the switch can be
flipped without a cold cache.

A node client's `cdr-out/cdr-<date>.jsonl` files are imported into the day cache
the first time a day is read and served from the cache after that, so a
deployment with those files does not re-parse them on every request.

### When a range is slow

Two read-only meters, run from the command line on the server:

```
php tools/cdr-timing.php <domain> [start] [end] [--runs=2]   # where the time goes
php tools/pbx-bench.php <domain> [server] --token=<bearer>   # what the PBX allows
```

`cdr-timing` times the whole report path stage by stage (twice, so the cold and
warm requests are side by side) and prints peak memory; it refuses a range that
is not fully cached and names the days to warm. `pbx-bench` proves whether the
PBX honours a page larger than 250 and how many requests per second it sustains,
then prints the `CDR_PAGE_SIZE` / `PBX_REQUESTS_PER_SECOND` lines for
`includes/config.local.php`.

## Development

`package.json` exists **only** for the development toolchain; it is not needed in
production.

```
npm install          # esbuild, Tailwind CLI, jsdom, acorn, php-parser, php-wasm
npm test             # everything: lint, coverage, audits, build, js smoke, api matrix, cdr cache
npm run build        # dev build: assets/js/app.js + assets/css/app.css (git-ignored)
npm run build:prod   # deploy build: minified, content-hashed, writes assets/build-manifest.json
npm run build:js     # JS only
npm run build:css    # CSS only
npm run lint:php     # syntax + banned-construct scan over every .php file
```

* **Edit the sources under `assets/js/src/` and `assets/css/src/`, never the
  built files.** `npm run build` rewrites the dev bundles; `npm run build:prod`
  rewrites the deployed pair and the manifest, and `npm test` fails if the
  committed pair is stale (`tools/prod-build.mjs` rebuilds and compares). The
  build is deterministic (identical sources → byte-identical output), so a rebuild that
  produces no diff means the committed bundle really does match the source.
  `assets/js/src/app.js` is the entry point (React root + `App`); everything
  else lives in `lib/` (api, time, format, sla, recording, react helpers,
  theme) and `components/` (one file per screen or dialog). The table of
  contents is `tools/app-modules.json` and `tools/module-budget.mjs` fails the
  build if a module grows past 2,000 lines or is imported by nobody.
* `tools/css-coverage.mjs` fails the build if any Tailwind utility or custom
  class used in the sources is missing from the built stylesheet — the check
  that keeps a Tailwind class from silently disappearing.
* `tools/ui-audit.mjs` (`npm test` runs it with `--strict`) checks the UI
  consistency rules that a compiler cannot: every clickable element must say
  how it behaves (`cursor-pointer` / `cursor-default`), keyboard-reachable,
  and explained by a `title`; colours in JS must use the theme tokens; loading
  states must render the shared `skel()` placeholder; heavy third-party code
  must be loaded on demand. Run it on its own for the full report.
* `tests/js/` runs the real bundle in jsdom with React and Chart stubs;
  `tests/php/` executes every `api/*.php` under real PHP 8.4 (php-wasm) and
  asserts the session/method/role gates and the response contract. The CDR
  store's SQL is executed against real SQLite through `node:sqlite` (the PHP
  runtime here has no `pdo_sqlite`), and the PHP cache is exercised against both
  backends with a recording connection double. `tests/php/outcomes.mjs` pushes
  one synthetic day of CDRs through every report endpoint and asserts that the
  missed and abandoned totals reconcile across the Dashboard, Agents, Queues,
  Telephone Numbers, Auto Attendants, Call history and Alerts.

## Topics, summaries and keyword watch

Office managers can open **Topics & summaries**, review topic counts and call
summaries, manage domain-wide watched phrases, and manually email selected tagged
calls. `api/intelligence.php` enforces the manager role on every operation.
The report defaults to the current desk-calendar month through today and has its
own month selector for past months. Department, site, agent and hours scopes
still apply; hours default to all on this report. The call table shows only
calls with topics, offers 30/50/100 rows per page and highlights keyword matches
red. The topic browser shows the ten most common topics by default; search all
topics or expand the list and sort by call count or name. CDR topics are used
while lookups are pending or unavailable, with those rows marked incomplete.
Separate watched phrases with commas or line breaks. To retain a comma within
one phrase, enclose it in double quotes; double a quote within a quoted phrase.
Existing comma-containing phrases are quoted automatically in the editor.
Phrase matching is case-insensitive substring matching across topics, summaries
and transcript segments. Tags are recalculated against the current watch list;
removing a phrase removes its tag on the next scan. Topic counts include CDR topics and retrieved jobs; they are provisional
while loading and may be incomplete (partial jobs are flagged). Filter calls by
match status and optionally a saved keyword. A known match on a partially checked
call can appear in both Matched and Incomplete; No match includes only fully
checked calls. The scrollable table retains pagination and a sticky header.
Export filtered calls to Excel creates an XLSX in the browser containing all
filtered pages, summaries and matching excerpts, plus report scope and coverage
metadata. Exports are available during checking when filtered rows are available;
the file name and report information identify partial results. Unavailable checks
and incomplete cache coverage are also flagged. Treat
these files as sensitive. Optional scheduled keyword email alerts are described below.

The report retrieves one transcription per job using the authenticated PBX
session. It takes the call ID and month from a valid CDR
`prefilled-transcription-api` when present (including its `orig_callid`,
`term_callid` and `by_callid` when supplied; the URL's host is never fetched),
or uses `call-id` and the configured `INTELLIGENCE_MONTH_TIMEZONE`. A different
CDR call-ID field can be selected using `INTELLIGENCE_CALL_ID_FIELD`. For CDRs
without a recorded PBX source, `INTELLIGENCE_PBX_SERVER` can explicitly select
a key from `PBX_SERVERS`. A manual
YYYYMM override takes precedence. The PBX's exact month basis has not been
confirmed: verify it against real records before configuring the timezone.
Offset-less CDR timestamps are interpreted in the desk timezone before conversion.
Missing IDs, lookup errors, unfinished jobs and incomplete intelligence responses
are identified rather than counted as successful searches.

Set the `INTELLIGENCE_SMTP_*` constants in `includes/config.local.php` as shown
in `includes/config.local.example.php` to enable authenticated STARTTLS mail.
Certificate verification is mandatory. The manager enters recipients and selects calls, including unmatched and
incomplete calls. Select/unselect filtered calls applies across all currently
loaded filtered pages; selections outside the filter remain selected until
cleared. The application sends batches of up to ten calls per email, re-fetching
available transcription jobs and labeling incomplete or unavailable ones. CDR-only
calls include their available signed CDR topics, without a transcription summary;
the server rechecks matches against the current watch list. Successful batches are
removed from the selection; on failure the rest remain selected. Verify the failed
batch before retrying because its delivery may be uncertain. An accepted email means the SMTP server accepted it, not that it
was delivered. Excerpts may contain sensitive data: verify recipients and use a
mail server appropriate for that data. The application stores domain watch lists
and a server-only call-reference signing key under `CACHE_DIR` (not transcript
text); keep this directory persistent and shared between application workers, and
configure the web server to deny HTTP
access to cache and logs, or place them outside the web root.

### Scheduled keyword alerts (Windows)

Optional automatic alerts poll the PBX directly; there is no webhook subscription.
Configure `INTELLIGENCE_SMTP_*`, `INTELLIGENCE_MONITOR_API_KEY`, and the global
`INTELLIGENCE_ALERT_RECIPIENTS` array (1–10 addresses) in the server-only `includes/config.local.php`
(see `includes/config.local.example.php`). Use a dedicated PBX API key with
permission to read CDRs and transcriptions for each enabled domain. Every
configured PBX server used by the worker must use HTTPS so the long-lived API
key is not transmitted in plaintext. SMTP uses
authenticated STARTTLS and verifies certificates. **Every address in the global
list receives matching call details from every enabled domain**; restrict access
to recipients and to the server configuration. Do not put keys or passwords in Git.

An office manager saves watched phrases, then enables **Automatic keyword email
alerts** in the report's Keyword Watch drawer for each domain. Enabling starts
with calls completed after that point, not historical calls. Report checks made
after enabling are recorded separately: a completed report check suppresses the
automatic email for that call even if no email was sent. Earlier report checks
were not stored and cannot be used to suppress alerts. Already checked calls
are not automatically rechecked when watched phrases change. Re-enabling starts
a new cutoff. The scheduler checks all calls in the domain, not the report's site or
department filters. Disabling stops further work, although a message already in
flight may still be delivered. Checks search the same current watched phrases in summary,
topics and transcript segments; an automatic message contains the summary,
topics and matching excerpts. Calls without finished intelligence and topics
are revisited for up to 24 hours after completion, then flagged for review.
If the scheduled task is stopped for more than 24 hours, affected calls are
flagged instead of automatically emailed when the worker returns.

Create a Windows Task Scheduler task with a repeating trigger at your preferred
interval, **Run whether user is logged on or not**, and **Do not start a new
instance**. Set the action to the full path of the same PHP CLI installation
used by the application and pass the full path to `tools/intelligence-monitor.php`
as its argument. For example (adjust both paths to your server):

```text
Program/script: C:\php\php.exe
Add arguments:  C:\inetpub\wwwroot\callscope\tools\intelligence-monitor.php
Start in:       C:\inetpub\wwwroot\callscope
```

Install the PHP cURL extension and give the task account read access to the app
and server configuration, and read/write access to the **same persistent**
`CACHE_DIR` and `LOG_DIR` as the web server. Deny HTTP access to those directories
and `includes`, or place them outside the web root. Configure the task's own
execution time limit to allow the scans to finish; a file lock prevents overlapping
instances. The task maintains its checkpoint and re-reads recent CDRs directly,
including two earlier start-date days for delayed CDRs. Very long calls starting
more than two days before completion may not be discovered; failed or incomplete
PBX page fetches do not advance the checkpoint. PBX limits, retries, API key
permissions, the PBX's actual CDR/lookup fields and PHP capacity still affect
coverage. The PBX lookup month must be resolvable via its prefilled link or
`INTELLIGENCE_MONTH_TIMEZONE`; the browser-only month override is not used.

The drawer shows the last scan and calls needing review. SMTP errors or a process
crash during sending may be ambiguous; the worker does **not** resend those
messages automatically. Verify delivery before marking a review handled. Missing
lookup references and unfinished intelligence after 24 hours also require review.
CDRs with no usable completion time cannot be confidently classified as new; the
last scan reports their count, and those that started after enablement are flagged
for review after 24 hours.
Inspect the application logs for scan failures, and monitor the Windows task's
last run/result: enabling the switch does not install or start the task. Mail
acceptance by SMTP does not guarantee delivery. Monitor state and call-reference
identifiers are retained under `CACHE_DIR/intelligence-monitor`; this grows with
the number of checked calls. Monitor available disk space, and protect and back
up this directory with the same care as other sensitive call metadata. Deleting
it loses the checkpoint and deduplication history and can cause missed or
repeated alerts. Live PBX, scheduler and SMTP behavior must be verified on the
actual deployment.

CDR caches created before this version may not contain the job ID or the
prefilled transcription URL, because older versions trimmed these fields. They
can therefore appear as missing even if the PBX has intelligence data. Refresh
or expire those CDR cache days (and any imported node JSONL source) before relying
on historical coverage; the default closed-day cache lifetime is one year. The
report also flags an incomplete date cache. A large range may require many PBX
requests. The selected month is warmed in batches and lookups use the domain's **Settings → Topics & summaries → Transcription lookup
workers** value (1–32 simultaneous requests per browser; default 8). Only office
managers can change it. Save, then reload the report to start a new check with
the updated value (the report reload button is enabled after checking finishes);
other open browsers also need to reload. The number is per
browser, not a domain-wide total, so multiple users can multiply the server load.
The shared per-PBX-server rate limit and retry rules still apply to all PBX
traffic: it defaults to five requests per second and is configured by the server
administrator with `PBX_REQUESTS_PER_SECOND` in `includes/config.local.php`
(see the PBX benchmark above). Raising either setting can overload the server or
trigger throttling; throughput also depends on latency and PHP worker capacity. Progress and
partial results are displayed; counts
and pages may change until checking finishes.
