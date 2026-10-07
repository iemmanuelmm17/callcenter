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
