# CallScope reporting

Call-centre reporting dashboard for the Birns PBX: PHP endpoints under `api/`,
a single-page React front end (`assets/js/app.js` + `assets/css/app.css`), and a
JSON cache of PBX CDRs under `cache/`.

```
index.php            → redirects into the app shell (portal.php)
portal.php           → the HTML shell that boots assets/js/app.js
api/*.php            → one endpoint per view (session + role gated, JSON in/out)
includes/            → shared code: bootstrap, auth, security, export, PBX client, config
includes/reporting/  → the reporting layer as modules, loaded by includes/reporting.php
                       outcomes.php holds the one definition of missed / abandoned
assets/js/app.js     → BUILT bundle (generated — never edit by hand)
assets/js/src/       → bundle source (this is what you edit)
assets/css/app.css   → BUILT stylesheet (generated — never edit by hand)
assets/css/src/      → stylesheet source (Tailwind entry + hand-written CSS)
cache/, logs/        → runtime state, never committed (includes cdrs.sqlite, the
                       CDR day cache; see "CDR cache" below)
tests/, tools/       → development harness (not deployed)
```

## Deploying

The deployed application is plain PHP + static files: copy `*.php`, `api/`,
`includes/` **including `includes/reporting/`**, `assets/`, and `CHANGES.md` to
the web root. There is no build step
on the server and no database to migrate — the front end is the committed bundle.

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

The call-details modal also carries a **Rec** column (plays the recording in a
tray under the table; resolved on click, never cached in the row) and a **SIP
flow** column (the cradle-to-grave dialog, shared with Call history). Both are
booleans on the row — `hasRecordingHint` / `hasFlowHint` — because resolving
either one is a PBX walk.

## CDR cache

The raw PBX CDRs are cached per day (domain + timezone + date) so a report does
not refetch history. Two backends, chosen by `CDR_CACHE_DRIVER`:

| value | storage | when |
| --- | --- | --- |
| `auto` (default) | SQLite when `pdo_sqlite` is available, else JSON | start here |
| `sqlite` | `cache/cdrs.sqlite` (`cdr_days` + `cdr_records`) | after checking `status` |
| `json` | `cache/cdr-day-<sha256>.json`, one file per day | previous behaviour |

Move an existing deployment over with `php tools/cdr-cache.php` (status, import,
verify, days, prune) — see `CHANGES.md` for what each command guarantees. Until a
day has been imported, the JSON file for it is still read, so the switch can be
flipped without a cold cache.

## Development

`package.json` exists **only** for the development toolchain; it is not needed in
production.

```
npm install          # esbuild, Tailwind CLI, jsdom, acorn, php-parser, php-wasm
npm test             # everything: lint, coverage, audits, build, js smoke, api matrix, cdr cache
npm run build        # regenerate assets/js/app.js and assets/css/app.css from src/
npm run build:js     # JS only
npm run build:css    # CSS only
npm run lint:php     # syntax + banned-construct scan over every .php file
```

* **Edit the sources under `assets/js/src/` and `assets/css/src/`, never the
  built files.** `npm run build` rewrites both bundles; the build is
  deterministic (identical sources → byte-identical output), so a rebuild that
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
