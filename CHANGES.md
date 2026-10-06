# CHANGES — Sprint A, phase 2: one call, many legs (transfers, callbacks, repeats)

**What this phase is about.** A NetSapiens call is not a row: a transferred call
is two or three rows sharing `call-orig-call-id`/`call-parent-call-id`. Three
different copies of "which rows are the same conversation" had grown in the tree,
and none of them could answer the two questions a manager asks every morning —
*how often do we bounce a caller between two agents*, and *which missed calls did
we return*.

## New: `includes/reporting/links.php`

The one definition of call identity, and the three metrics that need it:

| function | what it answers |
| --- | --- |
| `cdrIdBag()` / `cdrLegIndex()` / `cdrRootKey()` / `cdrInteractionLegs()` | which rows are one conversation (union-find over every shared id, PBX leg order preserved, a stable fingerprint for rows with no ids at all) |
| `cdrOfferedInteractions()` | how many calls did we receive — one entry per conversation, not per leg. This is the denominator the app never had |
| `cdrTransferCount()` / `cdrTransferPairs()` | how many times a conversation was handed to a **different** agent, and the pairs |
| `cdrTransferSummary()` | hand-offs, transferred conversations, the pair lists, and the rate |
| `cdrCallbacks()` | which missed calls were returned, by whom, and how fast; plus the unreturned worklist |
| `cdrRepeatCallers()` | the same customer calling again, split 24 h / 72 h, with the honest FCR-proxy rate |
| `callLinkReport()` | everything above in one payload, so the dashboard, the queue screen and the printable pack cannot disagree |

`api/report.php` now ships that block as `links`.

## Fixed (found by the new suite, each one a wrong published number)

1. **The same call was one interaction on one screen and several on another.**
   `cdrIdBag` existed three times: `api/queue.php`, `api/cradle.php` and a
   six-field list inside `rows.php:findRelatedCdrs()` (it did not read `call-id`
   or `cdr-id`). All three now use the shared eight-field version. The cradle
   copy was also **missing** queue.php's numeric-call-id fix, so a purely numeric
   id (which PHP casts to an int array key) would fatal there and not on the
   queue screen; the shared version carries the fix and a test pins it.
2. **`+1 (845) 425-9810` did not match `8454259810`.** Comparing raw strings made
   every callback look unreturned — every single one, silently, which is the most
   dangerous direction this metric can fail in. `normalizeCallNumber()` now
   canonicalises NANP (`+1…` → 10 digits) and `00`-prefixed international
   numbers, and both the callback and repeat matchers use it.
3. **An outbound leg counted as a transfer hop.** `cdrIsAnsweredAgentLeg()`
   documented a direction check it did not make, so an answered outbound call
   inflated `handled` and depressed the transfer rate. Fixed.
4. **A transfer rate of 200 %.** The rate divided the *hand-off count* by handled
   calls, so a call bounced through three agents published "200 %" — the kind of
   figure that discredits the whole page. The rate is now transferred
   *conversations* / handled interactions (cannot exceed 100 %), with the
   hand-off count and `perTransferred` beside it. A test asserts ≤ 100 %.
5. **A queue pair that was not a queue transfer.** The first version recorded
   "previous agent → this queue"; the review asked for queue→queue, so it now
   records a genuine queue change inside one conversation.

## Deliberate rules, pinned by tests rather than left implicit

* A transfer needs a **person** to take the call: an unanswered leg offered to
  another agent is not a transfer (that would let an unanswered transfer inflate
  a coaching conversation), and a terminus that looks like an outside number is
  not an agent.
* The same agent answering twice on one interaction is the same person still on
  the call — not a transfer.
* A callback is looked for only in **outbound** legs. A customer calling back in
  is a repeat call; counting it as a callback would flatter every desk.
* An outbound leg's own from-number is ignored: it is usually the desk's caller
  ID, and matching it would "return" missed calls to the first number in the
  outbound caller-ID pool.
* The `call-back` CDR field is never consulted. It is always false in the data
  this app reads, so trusting it would report "nothing was ever returned".

## Evidence

`node tests/php/call-links.mjs` — 40 checks over hand-built leg trees, plus
`api/report.php` end-to-end. Registered in `tests/run.mjs` (`npm test` = 24
suites, all green).

---

# CHANGES — Sprint A, phase 1: opening hours, wait buckets, hold, service targets

**The task (2026-10-06):** implement the manager review (`REPORTING-REVIEW.md`)
in full — Sprints A, B and C — phase by phase, with every published number
recomputed and checked independently.

**Read this before you quote a number.** Three figures the app publishes have
changed, all three because they were wrong:

1. **p50 / p90 wait** (`support.php: percentileInt`). The percentile picked the
   element at `round(p/100 × (n−1))` and published it. For an even count that is
   not the median: over six rings of 10, 20, 45, 100, 125, 150 s it reported
   **100 s** where the median is **72.5 s** — a 38 % overstatement of the wait
   the desk made people endure, in the number the review says is quoted at the
   daily huddle. It now interpolates between the two nearest values, the same
   method as Excel/LibreOffice `PERCENTILE.INC` and R's type 7, so the exported
   CSV can be checked in a spreadsheet. Same fixture: p50 **73 s**, p90
   **138 s**. This affects the dashboard CSV's `p50_ring` / `p90_ring` columns
   and the new on-screen p50/p90; nothing else used the function.
2. **A call whose ringing and answer timestamps belong to different legs**
   (`support.php: ringSeconds`) used to publish **0 seconds**. A transfer or a
   re-queue can leave a row whose answer precedes this row's ringing, and the
   old code clamped the negative difference to zero: a real wait silently
   published as "answered instantly". It now measures this leg's own
   start→answer gap for that case (45 s in the test). Every single-leg value is
   byte-identical to before.
3. **An omitted field on the Settings screen wiped fields it did not mention.**
   `saveDomainSettings()` wrote the whole settings object, so a save that did
   not include the calendar wrote the *default* calendar over the stored one —
   the same class of bug the old `$pick` fix addressed for the scalar fields,
   and worse, because a partial save would silently switch opening hours off.
   The nested settings now start from what is stored. Test:
   `a save that omits the calendar keeps it`.

## What is new

| piece | where | note |
| --- | --- | --- |
| Opening-hours calendar (Mon–Fri 08:00–18:00 grid, per-day open/close, holiday list) | `includes/reporting/settings.php` | `businessHours.enabled` ships **false**: switching it on changes every headline number, so it is a manager decision, not a deploy |
| `hours=all\|business\|after` on every reporting endpoint | `includes/auth.php` (`authorizedFilters`), `includes/reporting/rows.php` (`scopedCdrs`) | the default is `business` **once a calendar is configured**, `all` while none is — an unconfigured install behaves exactly as before |
| Per-queue service targets (queue id → extension → name → domain default) | `settings.php: resolveQueueSlaSeconds`, `rows.php: summary()` | a period judged against several targets says so and carries the mean target applied, so the UI never labels it with one queue's number |
| Wait buckets for answered calls (≤30/≤60/≤120/>120 s) | `summary()` | one definition with the average beside it (`waitSeconds()` == `ringSeconds()`) |
| Abandon split by how long the caller waited (<5 s misdial / 5–30 s / >30 s staffing failure) | `summary()` | the review's F5, and the "abandoned wait" figure every nav now sees |
| Hold time (total, calls, average) | `summary()`, `support.php: holdSeconds` | the field was read inside `ringSeconds()` and thrown away |
| Roster rows (agent, weekday, shift, team, supervisor) stored and validated | `settings.php` | the editor UI lands with Sprint C; the storage and validation are here so no later phase can half-write it |

## Evidence

`node tests/php/report-metrics.mjs` — 77 checks, all hand-computed in the file:
the calendar's boundaries (open inclusive / close exclusive), a cross-midnight
shift, holidays and closed weekdays; the ring fix; `summary()`'s buckets, hold
and per-queue SLA arithmetic written out line by line; the Save guards; and
`api/report.php` over a four-call day where `business + after` must equal `all`
exactly and the drill-down must agree with the summary it was opened from.
Registered in `tests/run.mjs`, so `npm test` (23 suites) already runs it.

Two behavioural rules are **pinned, not changed**: a call with no usable
timestamp is never hidden by the hours filter, and an unanswered call that
reached a queue counts as an **abandon even when it ended in a mailbox** (the
mailbox is the queue's overflow; counting it as handled voicemail would hide the
failure). Both now have a test that says so.

---

# CHANGES — QA round 2: the remaining P1s, the history purge, the large modules

**Scope:** the three P1 findings round 1 left for a decision (QA-3, QA-4,
QA-5), the QA-2 history purge, and the module-size work QA-11 pointed at —
including the two files it named as "next" (`agents.js`, `date-range-picker.js`)
and `call-modal.js` after the round-1 split left it at 1,139 lines.

**The four decisions this round was waiting on** (answered 2026-10-06):

1. **QA-5** — supervisors may *read* the thresholds, only an office manager may
   change them; the GET is role-gated *and* the thresholds ship inside the
   dashboard payload, so no role can colour a report differently from the server.
2. **QA-3** — vendor React, ReactDOM, Chart.js, Tabulator, Font Awesome and IBM
   Plex Mono into `assets/vendor`; nothing is fetched from a CDN at runtime.
3. **QA-4** — commit the *minified, content-hashed* production build only; the
   unminified dev build stays local (git-ignored) for the jsdom harness.
4. **QA-2** — purge `cache/` + `logs/` from history, force-push both refs, and
   make the repository private.

**Read this before you pull.** The QA-2 purge rewrote every commit in this
repository, so every SHA changed and a normal `git pull` will not fast-forward.
The working trees are unchanged: the branch tip tree is byte-identical
(`38790995…`) and `main`'s tree is byte-identical (`241a9e84…`) to what they were
before the rewrite. See "History rewrite" below for the fetch/reset commands.

## Commits (post-rewrite)

| commit | what |
| --- | --- |
| `53928ab` | QA-5 — settings read/write split, thresholds in the dashboard payload |
| `dbd9f7a` | QA-3 — vendored third-party assets, SRI, `tools/no-cdn.mjs`, portal suite |
| `966ca19` | QA-4 — minified content-hashed prod build + `tools/prod-build.mjs` |
| `dd27ab5` | AA report — derived numbers moved to `lib/aa-report-model.js` |
| `0a37a41` | date-range picker — calendar arithmetic moved to `lib/date-range.js` |
| `3ddb9c4` | agents — one file split into four views |
| `5d7e728` | call modal — pagination arithmetic moved to `lib/pagination.js` |
| *(rewrite)* | QA-2 — `cache/` + `logs/` dropped from all history, both refs force-pushed |

## History rewrite (QA-2)

**What was in there.** 93 files — `cache/cdr-day-*.json`,
`cache/aa/<tenant>.json`, `cache/callqueues-*.json`, `logs/app-*.log`,
`logs/audit-2026-09.jsonl`, `logs/audit-2026-10.jsonl`: caller numbers, tenant
domains, PBX payloads and a per-user record of who viewed and exported what.
They entered at `bfbc3f5` ("First commit"), were deleted from the tracking in
round 1 (`c92750d`), and stayed reachable in history — including through the
two "Delete cache/logs directory" commits on `main`.

**What was done** (all local, before any push):

```
git filter-branch --force --prune-empty \
  --index-filter 'git rm -r --cached --ignore-unmatch cache logs' \
  --msg-filter '…' -- --all
git update-ref -d refs/original/…   # then reflog expire --expire=now --all && git gc --prune=now
```

* `--prune-empty` also dropped the three commits whose *only* change was those
  paths (`c92750d` "stop tracking runtime state", `2f2c8f7` "Delete logs
  directory", `3149a5c` "Delete cache directory"): keeping a no-op commit with
  that message would be misleading.
* The `--msg-filter` fixed four round-2 commit messages whose suite count was
  off by one (`npm test: 20/20` → `19/19`, etc.). The counts per phase are 17
  (QA-3), 18 (QA-4), 19 (AA split), 20 (date range), 20 (agents), 21
  (pagination).
* **Before:** branch 28 commits, `main` 29. **After:** branch 28, `main` 26
  (28 − the three no-op commits; `main` also lost its own two "Delete …"
  commits).
* **Verified:** `git log --all --name-only -- cache logs` is empty;
  `git rev-list --objects --all | grep -c " cache/\| logs/"` is 0; the old tip
  objects no longer resolve (`git cat-file -t 7e3449e` → fatal); `.git` shrank
  from ~10 MB to 2.0 MB.
* **Pushed with leases** so a concurrent push would have aborted:
  `--force-with-lease=refs/heads/arena/ecdba782-callcenter:<old>` and
  `--force-with-lease=refs/heads/main:<old>`. `main` is force-pushed here and
  only here — the purge does not change a single byte of its tree.
* **Still public.** The sandbox's GitHub token can push but has no
  administration scope, so `gh api -X PATCH … -f private=true` returned
  `403 Resource not accessible by integration`. The repository must be flipped
  to private by hand: **Settings → General → Danger zone → Change visibility**.
* **What GitHub may still hold.** Unreachable commits can remain addressable by
  SHA on GitHub until its own housekeeping runs; nobody can reach them from a
  normal clone. The repository was public with **0 forks**, which bounds the
  exposure.
* **Any existing clone must be re-pointed:**

  ```
  git fetch --force origin
  git checkout main
  git reset --hard origin/main
  git remote set-head origin -a
  ```

## Deploy hotfix — the integrity hashes vs a CRLF upload

**Reported from the deployed server:** the browser refused
`assets/vendor/chart.js/chart.umd.js` with

```
Failed to find a valid digest in the 'integrity' attribute … with computed
SHA-384 integrity 'cxXbu9HOn/Jw1+RQ88i8dDge6E6nLsrhWlv5BEuiMd1ZCuLQui8frGqdvY8L9wcL'.
The resource has been blocked.
```

**Diagnosis.** The hash the browser computed for the file it received is not the
hash we shipped, and it is not a version problem: it is exactly the sha384 of
our file with LF rewritten as CRLF.

```
as committed (LF)   sha384-zYPBGXwO4633CABX/5Spf6emCKUJCfoOkhOMYyxMsatqQZPnDblmmOewfjsIVWCM  205,615 bytes
LF -> CRLF          sha384-cxXbu9HOn/Jw1+RQ88i8dDge6E6nLsrhWlv5BEuiMd1ZCuLQui8frGqdvY8L9wcL  205,629 bytes  ← what the browser got
```

14 line feeds became 14 CRLF pairs. The vendored Chart.js is protected by the
integrity attribute we added in QA-3, so the browser did the right thing and
blocked it — the deploy transferred text as text. The same thing would hit
`assets/js/app.<hash>.js` (230 kB, ~28 line endings), i.e. the whole app.

**Why it could happen at all.** Two doors were open: an FTP/SFTP transfer in
ASCII mode rewrites line endings on the way up, and a Windows checkout of a
repository with no `.gitattributes` hands you CRLF files in the working tree to
upload in the first place. The code in the repository was correct; the bytes
that reached the server were not.

**Fixes, in order of importance:**

1. **`.gitattributes` (new).** `* text=auto eol=lf`, and `-text` for every path
   whose bytes are hashed (`assets/vendor/**`, `assets/js/app*.js`,
   `assets/css/app*.css`, `assets/build-manifest.json`). LF in the repository
   and LF in the working tree, on every platform, whatever `core.autocrlf` says.
2. **`tools/deploy-check.mjs` (new).** `node tools/deploy-check.mjs <base-url>`
   fetches what the server serves and compares every manifest-listed file with
   this repository: status, byte count, sha384 — and it distinguishes "the same
   text with CRLF" from "a different file". It also compares the server's own
   `VENDOR.json` / `build-manifest.json` with ours, so deploying the wrong
   revision is reported as such. Exit code 1 on any mismatch, so a deploy script
   can gate on it. `tests/js/deploy-check.mjs` (new suite) proves the diagnosis
   against three staged trees: identical, CRLF-converted, one byte flipped.
3. **`portal.php` says it in the page.** It now stats every file the manifests
   name and, when a size does not match, renders a `#deploy-warning` block
   naming the files and both sizes above `<div id="root">`, with the binary-mode
   instruction. `stat()` is metadata, so this costs nothing per render; the
   integrity attributes still fail closed and are still the actual protection.
   `tests/php/portal.mjs` covers it (a correctly-sized tree renders no warning;
   a CRLF-sized file is named with both numbers).

**For the operator:** re-upload `assets/` in **binary mode** (FTP clients have a
transfer-type setting; `scp`, `rsync`, `zip` and `robocopy` never rewrite line
endings), then run `node tools/deploy-check.mjs <base-url>` and confirm it says
`DEPLOY OK`. On a Windows machine, refresh the working tree first so it really
is the repository's bytes: `git rm -r --cached . && git reset --hard HEAD`.

## QA-5 — Settings: supervisors read, managers write

`api/settings.php` had one `GET`/`POST` for everyone: the panel was in every
role's nav, the endpoint answered any signed-in user, and a supervisor could
rewrite the tenant thresholds that colour every report.

* `requirePageRoles` now sits above both method branches: `GET` is
  `['office_manager','supervisor']`, `POST` is `['office_manager']`. An `agent`
  or `basic_user` gets 403 on both; a supervisor gets 200 on `GET` with
  `canEdit: false` and 403 on `POST`.
* The GET response carries `canEdit`, and `assets/js/src/lib/roles.js` (new)
  mirrors the policy for the UI: `CAN_READ_SETTINGS`, `CAN_WRITE_SETTINGS`,
  `ROLES_READING_SETTINGS`.
* `app-shell.js` only fetches settings (and only renders the nav button) when
  the role may read them; the panel opens read-only for supervisors — no Save,
  no Reset, and the copy says so ("View only. Only an office manager can change
  the domain thresholds.").
* **The colours agree for every role:** `api/report.php` now includes
  `settings` in the dashboard payload, and `app-shell.js` applies it, so a
  supervisor who cannot call `settings.php` still sees the same SLA/missed/
  abandoned thresholds as the manager in the next seat.
* Evidence: `tests/php/endpoints.mjs` grew a six-check QA-5 block plus four
  matrix rows (101/101 checks), and `tests/js/smoke.mjs` renders the panel for
  agent / basic_user / supervisor / office_manager and asserts that a
  supervisor's DOM contains no `.set-save` and no `.set-reset` at all.

## QA-3 — the front end has no third-party runtime dependency

React, ReactDOM and Chart.js came from unpkg/jsdelivr at parse time, Tabulator
(JS + 29 kB CSS) from unpkg the first time a drill-down opened, the icon font
from cdnjs and IBM Plex Mono from Google Fonts — none of it with an integrity
hash, inside an authenticated session, on networks that often cannot reach any
of them.

* `tools/vendor.mjs` copies the 13 needed files out of the *pinned npm
  packages* (devDependencies), writes each file's sha256 + sha384 into
  `assets/vendor/VENDOR.json`, and copies the six upstream licenses into
  `assets/vendor/licenses/`. `--check` re-verifies every hash (part of
  `npm test`).
* `portal.php` reads that manifest and emits the tags with `integrity`
  attributes; a missing vendor tree degrades with a visible message instead of
  a blank page.
* `lib/react.js` loads Tabulator lazily from `assets/vendor/tabulator/`, with
  the integrity hash taken from the `#vendor-manifest` JSON the shell renders —
  the lazy path gets SRI too. `lib/theme.js` lost its two runtime CDN `<link>`
  injections.
* `tools/no-cdn.mjs` (new, in the suite) fails if a template or source starts
  referencing one of the CDN hosts again.
* 13 files, 1.3 MB of assets (Tabulator 432 kB, Font Awesome webfonts 293 kB,
  Chart.js 201 kB, ReactDOM 129 kB of that).

## QA-4 — the deployed bundle is minified, hashed and checkable

The front end shipped as a fixed-name, unminified `assets/js/app.js` (444 kB),
so a deploy could not be proven to have reached a browser.

* `npm run build` → dev: `assets/js/app.js` + `assets/css/app.css`,
  unminified, git-ignored (this is what the jsdom harness mounts).
* `npm run build:prod` → deploy: `assets/js/app.<sha256[:10]>.js` +
  `assets/css/app.<hash>.css`, minified, plus `assets/build-manifest.json` with
  both names and their sha384. **JS 444 kB → 225 kB, CSS 136 kB → 111 kB.**
* `portal.php` reads the manifest and emits the hashed pair with integrity
  hashes; without a manifest (a dev checkout) it falls back to the unversioned
  files, and a malformed manifest falls back instead of breaking the page.
* `tools/build.mjs --prod --check` fails when the committed artifacts are stale
  — the exact failure a fixed filename used to hide — and
  `tools/prod-build.mjs` (new suite) asserts the filename carries the file's own
  hash, the manifest integrity matches the bytes, the minified pair is
  materially smaller, exactly one hashed pair is committed, and a second run is
  byte-identical.
* `tests/run.mjs` builds first, because `css coverage`, `ui-audit` and the smoke
  suite read build output a fresh clone does not have.
* README: the deploy section says cache the hashed pair immutably; a new
  "Third-party assets" section documents the vendor workflow.

## Module splits

| module | before | after | what moved |
| --- | --- | --- | --- |
| `components/auto-attendant-report.js` | 1,698 | 1,459 | `lib/aa-report-model.js` (303) — totals, abandonment, outcome buckets, digits, destinations, hourly peak |
| `components/call-modal.js` | 1,140 | 973 | `lib/pagination.js` (155) — page windowing, clamp, range wording, page sizes |
| `components/agents.js` | 1,100 | 131 | `agent-table.js` (399), `agent-compare.js` (277), `agent-overview.js` (340) |
| `components/date-range-picker.js` | 1,079 | 943 | `lib/date-range.js` (150) — calendar/date arithmetic |

Every move was done by cutting whole declarations and re-parsing both sides to
compare the source text byte-for-byte (`units verified byte-identical: N`), the
same technique the P4b entry file split used. Nothing is over 1,459 lines now;
`app-shell.js` (937), `telephone-numbers.js` (813), `queue.js` (791) and
`overview.js` (655) were checked for seams and left alone — they are under half
the 2,000-line budget and their parts share state.

## Tests added this round

| suite | what it pins |
| --- | --- |
| `tests/js/aa-model.mjs` | the AA report's arithmetic on a five-call fixture: totals, unique callers, mean duration, the abandoned flag beating the reason text, outcome buckets summing to the call count, digit ordering, local-hour buckets, peak ranking, `formatHourLabel` |
| `tests/js/date-range.mjs` | inclusive day spans, month/year boundaries in `addDays`, leap Februaries, the 31-day cap (at the cap, one over, today wins), the month grid's leading blanks |
| `tests/js/pagination.mjs` | the three page-window shapes, first/last/current page always present, ascending numbers, `clampPage` at both ends, the range wording |
| `tests/php/portal.mjs` | the real `portal.php` renders only local, existing, hash-carrying tags; the prod manifest is honoured; a malformed manifest falls back |
| `tools/prod-build.mjs` | the committed prod build matches the sources, the name carries the content hash, the integrity matches, one pair only, reproducible |
| `tools/no-cdn.mjs` | no CDN host in templates or sources |
| `tools/vendor.mjs --check` | the vendored bytes still match `VENDOR.json` |
| `tests/js/smoke.mjs` (+38 checks) | the settings-panel role matrix; the date-range popup driven for real (open, page back, pick two days, apply); the call modal footer (range line, four page sizes, one button per page, next → page 2, size 100 → page 1) |

Two real bugs fell out of writing those tests: the harness handed the app
`react-dom/client`, which has no `createPortal`, so *every* portalled dialog
threw the moment a test opened one (and React's error text was being ignored as
a console.error); and the calendar extraction left the picker without its
`maxDate` binding, which only showed up once the popup was opened.

## Evidence

* `npm test` — **21/21 suites**, `ALL SUITES PASSED`
  (build, prod build, php lint, css coverage, ui audit, module budget, dead
  code, no cdn, vendor check, js smoke, aa fields, aa model, date range,
  pagination, api matrix, url policy, csv exports, cdr store, cdr cache,
  outcome parity, portal).
* `tests/php/endpoints.mjs` — 101/101 checks (QA-5 matrix + behaviour).
* `node tools/module-budget.mjs` — 37 modules, 13,310 lines, largest 1,459.
* `node tools/prod-build.mjs` — `PROD BUILD OK — hashed, minified,
  integrity-checked, in sync with the sources`.
* `node tests/js/deploy-check.mjs` — `DEPLOY CHECK OK — the tool catches the
  incident it was written for`; `node tools/deploy-check.mjs .` against this
  working tree — `DEPLOY OK — all 15 files match this repository byte for byte`.
* History purge — see the verification list above (all four checks pass, both
  remote refs confirmed).

## Still open

* **Repository visibility** — flip to private (token has no admin scope).
* **`main` is a merge away from this branch**: all round-2 work lives on
  `arena/ecdba782-callcenter` (`5d7e728`); `main` (`8567672`) still carries the
  round-1 tree it was merged from.

# CHANGES — QA round 1: the P0s and P2s from QA-REVIEW.md

**Scope:** everything `QA-REVIEW.md` rated **P0** or **P2**. The P1s (CDN
vendoring, asset minification + cache-busting, the Settings role policy) are
untouched on purpose — see "Still open" at the bottom.

**Commits:** `092bbc0` escape the drill-down table, `c92750d` untrack runtime
state, `7b0ae4e` one metric vocabulary, `67db536` error/retry + phone formatter
+ audio ids, `23d9c86` queue rows open their call + playback audit, `750d4d7`
split the two largest components.

**Files:** `assets/js/src/components/call-modal.js`,
`components/call-modal-columns.js` (new), `components/ui.js`,
`components/{queue,simultaneous,telephone-numbers,call-history,app-shell}.js`,
`components/auto-attendant-report.js`, `lib/aa-call-fields.js` (new),
`lib/metrics.js` (new), `lib/format.js`, `lib/recording.js`,
`api/{calls,filters,queue,recording}.php`, `includes/reporting/metrics.php`
(new), `includes/reporting.php`, `tests/js/{smoke,harness,aa-fields}.mjs`,
`tests/php/{outcomes,endpoints}.mjs`, `tests/run.mjs`, rebuilt
`assets/js/app.js` + `assets/css/app.css`.

## Fixed

* **QA-1 (P0) — caller text was rendered as HTML.** Tabulator applies a string
  formatter result with `element.innerHTML = val`; the five columns that echoed
  CDR text (From Name, From, Dialed, To, Reason) returned raw strings, so a
  hostile caller-ID name was executable markup in an authenticated session. All
  five now return a Text node (`asText()` — a Node is appended, never parsed),
  and the call-type icon is built with `createElementNS`/`setAttribute` instead
  of an `innerHTML` string.
* **QA-2 (P0) — caller data and the audit trail were committed.** 93 files under
  `cache/` (CDR day caches, tenant caches) and `logs/` (audit jsonl, app logs)
  were tracked; `origin/main` tracked none of them, so every merge re-added
  caller records. `git rm -r --cached cache logs`: git stops tracking them, the
  files stay on disk, and history is deliberately **not** rewritten (no
  force-push to `main`). Anyone who deployed this app on the branch gets the
  operational note in the commit message; see QA-REVIEW.md Q2 for the retention
  question behind it.
* **QA-6 (P2) — the one list that could not open its call.** `api/queue.php`
  recent rows now carry the CDR `id` (resolved by `callCallIds()`), and each row
  has an **Open** button (the row itself still expands the cradle path) that
  opens exactly that call, with its recording and SIP-flow columns.
* **QA-7 (P2) — dead `paused` prop.** Removed from `QueueDashboard`; a live
  refresh mode is a feature (QA-REVIEW F2), not a defect.
* **QA-8 (P2) — one metric vocabulary.** `includes/reporting/metrics.php` is now
  the single list (id → label/title). `api/calls.php` validates it and answers
  **422** for an unknown metric instead of a plausible empty list; the dead names
  `handled`/`voicemail` (no call type can equal them) are gone; `api/filters.php`
  serves the catalog and the modal's titles/chips come from it — the second copy
  in `call-modal.js` is deleted.
* **QA-9 (P2) — error states.** `ui.js::ErrorState` replaces five inline copies
  of the same block (two of which said "Failed to load…"), and every panel that
  fetches its own data now offers **Retry** — Queues, Simultaneous, Telephone
  Numbers, Call history, Agents compare and the Auto-Attendant panels.
  `telephone-numbers.js` drops its byte-identical private phone formatter, and
  the `<audio>` ids are per-instance counters instead of CDR strings (two
  players for one call used to collide).
* **QA-10 (P2) — playback is audited.** `api/recording.php` writes an
  `auditView(..., 'recording')` entry for both the URL resolution and the
  streamed bytes.
* **QA-11 (P2, partial) — the two named files are split.**
  `call-modal.js` 1,469 → 1,139 lines (`components/call-modal-columns.js`, built
  by `buildCallColumns({slaSeconds, playingRef, onPlay, onFlow})`) and
  `auto-attendant-report.js` 1,789 → 1,698 (`lib/aa-call-fields.js`, pure CDR
  readers). The next two over 1,000 lines are `agents.js` (1,100) and
  `date-range-picker.js` (1,079).

## Evidence

* New JS suite `tests/js/aa-fields.mjs` (14 suites total) pins the extracted
  readers: fallback order (normalised name first, raw PBX field last, blanks
  never shadow), trimming, coercion.
* `tests/js/smoke.mjs`: every CDR text column is mounted **the way Tabulator
  mounts it** (string → `innerHTML`, Node → `appendChild`) against
  `<img src=x onerror=…>` and must not create an element — verified to fail
  against the pre-fix source and pass after; the dialog title must show the
  server-served metric wording (the fixture's sentinel), which fails when the
  fixture stops serving `metrics`; a failed panel must show the shared error
  block whose Retry re-requests and recovers (the harness can now force a
  `{__status: 502}` response); a queue recent row's Open button must send its
  `callId`; the drill-down table's full column set and order is pinned, so a
  move can no longer silently drop a column.
* `tests/php/outcomes.mjs`: the catalog is served, **every** catalog id is
  accepted by `calls.php` (so no dead ids), unknown/removed names are 422, and
  omitting the metric still means every call; every queue recent row's id opens
  exactly that call.
* `tests/php/endpoints.mjs`: both playback audit lines (`stream:1`, `stream:0`).
* The split found its own bug: `formatPhoneNumber` is still used by the modal's
  filter chips, and the smoke suite failed loudly on the missing import.

## Still open (P1 — not in this round)

| finding | why it is still open |
| --- | --- |
| QA-3 CDN-only front end | vendoring Tabulator/React/Chart.js + SRI + CSP changes how the app is deployed; needs the "is this internal-only?" answer (QA-REVIEW Q3) |
| QA-4 unminified, uncacheable assets | `--minify` + content hashing changes the deploy step; needs a decision on the build flags (Q4) |
| QA-5 Settings policy | needs the product answer on whether supervisors may change tenant-wide thresholds (Q1) |

# CHANGES — drill-down filters that match the clicked item, plus recording and SIP-flow columns (P7)

**Scope:** the call-details modal. Two problems, both about trust in a number:

1. **A drill-down did not always open the calls behind the figure that was
   clicked.** Rows that stand for one call opened *every* call of their type;
   the Agents KPI cards inherited whatever agent the sidebar was showing; a
   queue-scoped metric also counted abandons that never reached a queue; and a
   15-minute Simultaneous interval opened the whole hour.
2. **The modal could not tell you that a call has a recording or a trace**, so
   finding either meant leaving for Call history.

**Files:** `api/calls.php`, `api/call_history.php`,
`includes/reporting/cdr_fields.php`, `includes/reporting/support.php`,
`assets/js/src/components/call-modal.js`,
`assets/js/src/components/call-flow-dialog.js` (new, extracted),
`assets/js/src/components/recording-player.js` (new, extracted),
`assets/js/src/components/{call-history,app-shell,agents,queue,simultaneous,telephone-numbers}.js`,
`assets/js/src/lib/react.js`, `assets/css/src/custom.css`,
`tests/php/{outcomes,export,endpoints}.mjs`, `tests/js/{harness,smoke}.mjs`,
`tools/ui-audit.mjs`, rebuilt `assets/js/app.js` + `assets/css/app.css`.

## The filters a drill-down must carry

| clicked item | before | now |
| --- | --- | --- |
| Agents table cell (Missed, Abandoned, …) | metric + that agent, whole page range | unchanged (already correct) |
| Agents **KPI card** (Total calls / Missed calls) | inherited the Overview agent selection, so the list disagreed with the card | `agents: []` — the card totals the table the user is looking at, and department / site / range still apply |
| Agents **Overview → recent calls** row | `metric: 'total'` + agent — "every call of that type for this agent" | `callId` of the row, so the list is that call |
| **Agent compare** "· calls" links | page date range | the compare screen's own range + metric |
| **Queues** hour bar | hour, queue scope, page range | unchanged, and now also carries the `slaSeconds` the chart was drawn with |
| **Queues** KPI / row | metric + queue | unchanged; a queue metric is now also scoped to queue calls server-side (below) |
| **Telephone Numbers** KPI (Total / Missed calls) | `incoming` / `missed` | unchanged |
| **Telephone Numbers** DID row & graphs bar | `inbound` (answered inbound only) | `incoming` — the figure is inbound + missed |
| **Telephone Numbers → Top numbers** bars | the panel was an empty canvas; nothing was clickable | real bars, each opening that DID's calls |
| **Telephone Numbers → Simultaneous** interval row / volume chart / Peak KPI | that day + hour | that day + hour + the exact `timeFrom`–`timeTo` window of the interval |
| **Dashboard** KPI card / mix row / rate row / hour / day | metric, hour or day + page filters | unchanged (the hour and day charts count every call, matching `metric: total`) |

Two API additions make those filters real:

* **`callId`** — exact call lookup. Matches any id the CDR carries for the call
  (`id`, `call-id`, `call-parent-cdr-id`, `call-orig-call-id`,
  `call-term-call-id`), so a row picked from one screen resolves on another.
* **`timeFrom` / `timeTo`** — a half-open Eastern wall-clock window
  (`'10:15'`–`'10:30'`), wrapping past midnight. Both ends must parse; a
  malformed or zero-length window is ignored rather than emptying the list, so a
  half-typed filter can never show "no calls".

Queue metrics are now **queue-stage scoped**: `queue_abandoned` / `queue_offered`
count only calls that reached a queue (`cdrQueueMatch($call, $queueIdsAll)`),
which is the population `api/queue.php` counts. Previously, asking for
`queue_abandoned` *without* a queue id fell back to the dashboard rule and
included auto-attendant abandons that the Queues screen never counts.

## Recording and SIP flow, in the modal

* **Rec column** — `hasRecordingHint`, decided server-side by
  `callHasRecordingHint()` (a leg id on the right side + a user to file it
  under). `▶` opens the recording in a tray under the table; `—` is a disabled
  button. Nothing is resolved until the button is clicked: resolving costs a PBX
  walk, and the table only needs the boolean.
* **SIP flow column** — `hasFlowHint` (`callRecordingCallId() !== '' ||
  callTraceApi() !== ''`). `Flow` opens the same cradle-to-grave dialog Call
  history uses, now shared as `components/call-flow-dialog.js`.
* **Recording player** — moved out of `call-history.js` verbatim into
  `components/recording-player.js` (246 lines) and reused by the modal; the
  modal passes no pre-resolved URL, so the player resolves its own.
* **Escape unwinds layers from the inside out** — flow dialog, then the
  recording tray, then the modal. `useEscape` now also honours
  `event.defaultPrevented`, because `stopPropagation()` does not stop a sibling
  listener on `document`: two layers can be open at once and one Escape used to
  close both.
* **CSV** — the export streams the same rows and gained `recording` and
  `sip_flow` (`yes` / `no`) columns; it also respects `callId` and the window,
  which is asserted in `tests/php/export.mjs`.

New row fields from `callsRow()`: `id`, `disconnectedAt`, `origCallId`,
`termCallId`, `origUser`, `termUser`, `recordingCallId`, `recordingUser`,
`servers`, `traceApi`, `hasRecordingHint`, `hasFlowHint`.

## Two bugs found on the way

1. **`tools/ui-audit.mjs` scanned comments as code.** Its balanced-paren walk was
   quote-aware but not comment-aware, so an apostrophe inside a comment ("the
   table's rows") opened a string that never closed and the audit reported
   findings against whatever element it landed on next. Comments are now blanked
   (indices preserved) before scanning, which cleared two phantom findings that
   had been mis-attributed to `AgentPerformanceTable` / `AgentCompare`.
2. **`tests/php/endpoints.mjs` seeded the PBX stub with the wrong case**
   (`phoneNumbers` vs the `phonenumbers` the stub reads), so the DID endpoint
   was silently exercised against an empty inventory.

## Verification

`npm test` — 13 suites, all green:

```
php lint · css coverage · ui audit · module budget · dead code · build · js smoke
api matrix (86/86) · url policy · csv exports (16) · cdr store · cdr cache · outcome parity
```

* `tests/php/outcomes.mjs` — **160 checks** (was 137). New: the `callId` filter
  returns exactly one call and matches leg ids (term *and* orig); the window is a
  strict subset of its hour and ignores malformed/zero-length values; queue-stage
  scoping does not absorb the auto-attendant abandon; the Simultaneous tab's
  busiest interval drill opens exactly `started` calls; a DID drill opens exactly
  the number card's total.
* `tests/js/smoke.mjs` — the modal is opened from the dashboard and the Rec /
  SIP-flow **formatters are run** over a fixture row with attachments and one
  without (`▶`/`Flow` enabled vs `—` disabled); the tray opens and asks only for
  the clicked recording; the flow dialog opens and calls `call_flow`; Escape
  closes flow → tray → modal, one layer at a time. Five drill-down paths are
  driven through the real UI (queue hour chart, interval row, DID bar,
  recent-call row, compare link) and their request bodies are asserted.
* `tests/js/harness.mjs` — the calls fixture now carries the full row shape, the
  Tabulator stub records the options it was built with, and the Chart stub keeps
  its instances so click handlers can be invoked.

**Known gap, stated plainly:** this sandbox has no `pdo_sqlite`, so the SQLite
CDR cache path is still verified by the store/cache suites only (as in P5); no
part of P7 touches that path.

# CHANGES — one definition of missed and abandoned, shared by every report nav (P6)

**Scope:** how the reports decide that a call was missed or abandoned. Each nav
page used to answer that question its own way, so the same call could be
abandoned on the Dashboard and missed on the Queues screen, the Auto Attendant
abandonment rate ignored most real abandons, and the Agents table's Abandoned
column was never filled in at all (the counter existed and was never
incremented). There is now one module that defines the outcome and every
endpoint derives from it, with a parity suite that asserts the seven nav pages
reconcile with each other.

**Files:** `includes/reporting/outcomes.php` (new — the definition),
`includes/reporting.php` (facade loads it), `includes/reporting/cdr_fields.php`,
`includes/reporting/rows.php`, `api/aa.php`, `api/agents.php`, `api/alerts.php`,
`api/call_history.php`, `api/calls.php`, `api/cradle.php`, `api/queue.php`,
`api/report.php`, `api/telephone_numbers.php`,
`assets/js/src/components/agents.js`, `auto-attendant-report.js`,
`call-modal.js`, `overview.js`, `queue.js`, `tests/php/outcomes.mjs` (new, 137
checks), `tests/run.mjs`, `tests/js/harness.mjs`, `tests/js/smoke.mjs`.

## The rules, in one place

`includes/reporting/outcomes.php` is now the only place where "answered",
"abandoned", "voicemail" and "no answer" are decided.

| outcome | rule |
| --- | --- |
| `answered` | an answer timestamp on either leg (`call-answer-datetime` **or** `call-batch-answer-datetime`) **or** any talking seconds. A mailbox call with talking seconds is not answered — that is the caller recording a message. |
| `abandoned` | not answered, and the call reached a queue or the auto attendant: the CDR went through a queue / service user / IVR application (`call-through-user` in the queue list, a directory `system-queue` / `system-aa` service code, `callqueue` / `to-callqueue` / `auto-attend` / `ivr` application strings), **or** it carries a queue batch leg (`call-batch-start-datetime`). |
| `voicemail` | not answered and the call ended in a mailbox: the voicemail-ish CDR fields (vmbox / voicemail URIs, term user, disconnect text) or `call-direction` 2. |
| `noanswer` | not answered, and it never reached a queue, an IVR or a mailbox — it rang a phone and stopped. |

`type` (what kind of traffic: `inbound` / `outbound` / `onnet` / `missed` /
`other`) stays where it was, in `classifyCdrType()`, but its "unanswered" test
now comes from the same module (`callUnansweredForType()`), so `type =
'missed'` and `outcome ∈ {abandoned, voicemail, noanswer}` describe the same
calls.

## What each nav page shows now

| nav page | missed | abandoned |
| --- | --- | --- |
| Dashboard | `counts.missed` = every missed call of any kind; breakdown by outcome | `summary.missedBreakdown.abandon` |
| Agents (table) | `mc` = missed **and not** abandoned (`Missed Calls` opens exactly that list) | `ab` = abandoned, new `Abandoned Calls` column, same drill-down |
| Agents (overview) | `agent.mc + agent.ab` for the open agent, else the dashboard summary | `agent.ab` (was the dashboard's company-wide count) |
| Queues | call reached the queue extension but never joined the queue | reached the queue, never answered |
| Telephone Numbers | every missed call on the number | not broken out separately (as before) |
| Auto Attendants | not a column | `api/aa.php`'s `abandoned` per call, read verbatim |
| Call history | `histDisplayOutcome()` → `missed` | `histDisplayOutcome()` → `abandoned` |
| Alerts | per entity, every missed call | the subset that was abandoned |

Everywhere, `abandoned ⊆ missed` and a call lands in exactly one bucket. The
queues screen's *offered* is still `answered + abandoned` (the queued calls
only) while every other screen's offered is `inbound + missed`; that difference
is scope, not definition, and it is stated in the column tooltips.

## What was wrong, and what changed

| # | where | before | now |
| --- | --- | --- | --- |
| 1 | `rows.php agentPerformance()` | `ab` declared, never incremented; abandoned calls were dropped from **both** columns | `ab` counted, `mc + ab` = every missed call handed to the agent |
| 2 | `api/agents.php` | `mc` = all `missed`, no kind split, so queue abandons showed as missed on the Agents screen | same `mc` / `ab` split as the Dashboard, with the directory and queue list passed in |
| 3 | `missedKind()` vs the queue loops | three copies of the abandoned rule (`queue.php`, `cradle.php`, `calls.php`) using the batch leg only | one `callIsAbandoned()`; the queue views now count a call that reached the queue without a batch leg as abandoned, like the Dashboard always did |
| 4 | `classifyCdrType()` | "answered" meant `call-answer-datetime` only — an answered queue call with just the batch timestamp or talk seconds was classified **missed** | the classifier asks `outcomes.php` |
| 5 | `api/aa.php` + the AA screen | backend flag `throughUser === destination`, and the screen demanded *also* a caller-hangup disconnect reason + zero talk | the backend sends the canonical verdict, the screen reads it; the disconnect reason is still shown per call |
| 6 | `api/alerts.php` | missed was `talk <= 0` (an answered call with zero talk counted as missed) and the AA abandon path passed no directory | canonical outcome per call; the limits now mean what the screens mean |
| 7 | `api/telephone_numbers.php` | a private `inferCallType()` duplicate of the classifier | deleted; `callType()` everywhere |
| 8 | `includes/reporting/rows.php` | `mcRate` = `mc ÷ offered` (a no-answer rate wearing the Dashboard's label) | `mcRate` = `(mc + ab) ÷ offered`, the Dashboard's missed rate |
| 9 | `api/cradle.php` | per-queue `abandonRate` = `abandoned ÷ totalCalls`, disagreeing with the Queues screen for the same queue | `abandoned ÷ offered`, same as `api/queue.php` |
| 10 | `api/calls.php` | no metric for the Agents `Missed Calls` cell, so it would have opened a list that also contained the abandons | new `missed_no_abandon` metric used by that cell |
| 11 | call modal | `missed_noanswer` / `missed_voicemail` / `queue_*` metrics rendered their raw id in the title and View chip | labelled |

## Numbers that move (and why that is the point)

These are real reporting changes, not refactors:

* **Answered queue calls** whose only answered signal is the batch timestamp or
  talking seconds move from *missed* to *inbound* on the Dashboard, Agents,
  Telephone Numbers and Call history. They were already answered on the Queues
  screen — that disagreement is what this phase fixes.
* **Queue calls with no batch leg** (aggregate-only CDRs) move from *missed* to
  *abandoned* on the Queues screen, matching the Dashboard/Agents/Call history
  verdict for the same call.
* **Abandoned calls** are now counted in the Agents table's Abandoned column
  (previously always 0) and in that table's Missed-rate denominator.
* **Auto Attendant abandonment** rises on that screen: calls the PBX released
  with a reason string the old `/orig: bye|hang up/` test did not match, or that
  never produced one, are counted now — they were always abandoned on the
  Dashboard.
* **Alerts** stop counting an answered call with zero talking seconds as missed.
* **Voicemail calls with talking seconds** (the caller recording a message) stay
  in the missed family as `voicemail`; only a mailbox call that also carries an
  answer timestamp is treated as answered inbound.

## Verification

* `tests/php/outcomes.mjs` (new, 137 checks, wired into `npm test`) has two
  halves. First a truth table over `includes/reporting/outcomes.php` — one case
  per rule — run as real PHP. Then one synthetic day of 11 CDRs whose buckets
  are known by hand (4 inbound answered, 3 abandoned, 2 voicemail, 1 no answer,
  1 outbound; offered 10) pushed through `report.php`, `agents.php`, `calls.php`,
  `queue.php`, `aa.php`, `call_history.php`, `alerts.php` and
  `telephone_numbers.php`, asserting that:
  * the dashboard breakdown sums to `counts.missed` and `inbound + missed` is
    the offered volume;
  * `Σ(mc + ab)` over agent rows equals `counts.missed` and `Σ(ab)` equals
    `missedBreakdown.abandon` — the Agents table and the Dashboard cannot drift;
  * `agents.php` rows equal `report.php` rows field for field, and each cell
    opens exactly as many calls as it shows (`missed_no_abandon`, `missed_abandon`);
  * the queue outcomes sum to the queue's calls, the queue abandon count equals
    the queue-scoped `calls.php abandoned` metric, and the rate is
    `abandoned ÷ offered`;
  * the AA report marks the answered AA call answered and the abandoned one
    abandoned;
  * call history's abandoned + missed rows equal `counts.missed`;
  * Alerts percentages equal the queue and agent tables they are derived from;
  * the Telephone Numbers summary and its number card equal the Dashboard's
    inbound and missed;
  * no file re-derives the rule: no `missedKind(`, no
    `!$answered && $batchStart !== ''`, no `inferCallType()`.
* `tests/js/smoke.mjs` (built bundle in jsdom) asserts the Dashboard's abandon
  row is the summary breakdown over offered inbound, that the Agents table
  renders the payload's Abandoned column and missed rate verbatim, and that the
  Missed cell drills into `missed_no_abandon`.
* Full suite: `npm test` — all 13 suites green (php lint, css coverage, ui
  audit, module budget, dead code, build, js smoke, api matrix, url policy, csv
  exports, cdr store, cdr cache, outcome parity).

# CHANGES — SQLite CDR store behind a config switch (P5)

**Scope:** the CDR day cache now has two backends behind one interface. The
JSON day files are still there and still the default when the runtime has no
SQLite. No endpoint contract changed (one additive field, see below); the
reporting layer, the exports and the front end are untouched.

**Files:** `includes/reporting/cdr_store.php` (new, ~560 lines),
`includes/reporting/cache.php` (rewritten as a two-backend day cache),
`includes/config.php` + `includes/config.local.example.php` (the switch),
`api/cache_job.php` (reports the backend), `tools/cdr-cache.php` (new CLI),
`tests/php/cdr-store.mjs` + `tests/php/cdr-cache.mjs` (new suites),
`tests/php/fixtures/cdr-store-double.php` (new), `tests/php/php.mjs`
(multi-page PBX stub), `tools/php-lint.mjs` (fixed false positive + self-test),
`tools/reporting-modules.json` (historian's note).

## Why SQLite, and what the day cache looked like

The cache was one JSON file per day (`cache/cdr-day-<sha256>.json`, 2–4 MB,
62 files / 169 MB on the current deployment). Every fetch page rewrote the whole
file, "is this day complete?" could only be answered by reading the entire day,
and nothing could be queried. The store keeps the same contract in a database:

| | json (before) | sqlite (now) |
| --- | --- | --- |
| write per fetch page | whole day, 2× per page (callback + return) | one insert per new record |
| resume of a partial day | rewrite the day | append from `next_offset` |
| completeness | parse the file | one row in `cdr_days` |
| queries | none | indexed `start_ts`, `kind`, `agent` |
| atomicity | last writer wins | per-page transaction, WAL |

## Schema

```
cdr_days    (domain, tz, day) → complete, next_offset, record_count, fetched_at
cdr_records (domain, tz, day, cdr_key) → seq, start_ts, kind, agent, department, site, raw
```

* `raw` is the complete CDR as the PBX returned it — the source of truth. The
  derived columns are a snapshot computed **without** the PBX user directory,
  so they are used for indexing, statistics and the CLI only; the reporting
  layer still classifies every row with the live directory, because `_type`,
  `_agent`, `_department` and `_site` depend on it.
* The timezone is part of the primary key, exactly like the JSON filenames hash
  it in: changing `DEFAULT_TIMEZONE` invalidates the cache instead of silently
  mixing two definitions of "a day".
* Indexes: `(day, seq)` for the range read, `(kind, start_ts)`, `(agent,
  start_ts)`, `(start_ts)`. `department`/`site` are deliberately unindexed (low
  cardinality, one day is scanned anyway, every index costs write time).
* `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `auto_vacuum=INCREMENTAL`; a non-WAL filesystem is logged, not fatal.
* `user_version` carries the schema version; a file from a newer build is
  refused with a log line instead of being written to.

## The switch

```php
define('CDR_CACHE_DRIVER', 'auto');   // default: sqlite when pdo_sqlite exists, else json
// 'sqlite' or 'json' to force one
define('CDR_STORE_FILE', '');         // default CACHE_DIR/cdrs.sqlite
```
Also settable by environment variable. Reading an existing JSON day file keeps
working while the store is selected (so flipping the switch does not cold-start
the cache); writing goes to the selected backend only, which is the point.

## Migrating a live deployment

```
php tools/cdr-cache.php status                      # driver, size, days, records
php tools/cdr-cache.php import <domain> --delete-json
php tools/cdr-cache.php verify <domain>             # json vs store, record by record
php tools/cdr-cache.php days <domain>               # what is stored
php tools/cdr-cache.php prune <domain> <before-day> --vacuum
```
`import` reads each day file, splits it by the local date of its records, writes
each day through the same code the web app uses, and reports per day;
`--delete-json` removes a file only after its records are stored, and `verify`
compares keys and completeness before you delete anything.

## What else changed

* **Two full writes per fetch page are gone.** `PbxClient::fetchCdrs()` hands
  the accumulated list to the callback *and* returns it, and the old code stored
  both — a whole-day JSON rewrite twice per page, and now a whole-day
  delete + re-insert twice per page. The cache writes the page once; the return
  value only refreshes completeness/offset. On a fresh fetch the day is replaced
  by the **first** page and every later page appends, so a 100k-record day costs
  400 small transactions instead of 400 delete-and-reinsert cycles.
* `api/cache_job.php` reports `driver` (additive; the UI ignores it).
* `tools/php-lint.mjs` banned `$pdo->exec(...)` and `function exec(...)` as
  "shell execution" — a real false positive on the new code. The rule now has a
  lookbehind for `->`/`::`/`function `, and the lint **self-tests every rule in
  both directions** at startup so an edit that neuters a security rule fails
  loudly instead of quietly.

## Verification

`npm test`: 12 suites, all green — php lint, css coverage, ui audit --strict,
module budget, dead code --strict, build, js smoke, api matrix 86 checks, url
policy 62, csv exports 17, **cdr store 34 checks**, **cdr cache 41 checks**.

* `tests/php/cdr-store.mjs` executes the store's own SQL against real SQLite
  (`node:sqlite`): schema applies, the upsert is idempotent, `record_count`
  tracks records, a resumed fetch appends only new rows, a replace drops the old
  day, days are keyed per domain and per timezone.
* `tests/php/cdr-cache.mjs` runs the real PHP cache against both backends and
  asserts the behaviour that matters: first request fetches and stores, second
  request answers **without touching the PBX**, a partial day resumes from its
  `next_offset`, a multi-page fetch inserts each record exactly once and deletes
  the day once, an expired day is refetched and replaced without duplicating
  rows, and the endpoints (report.php, cache_job.php) answer unchanged with the
  store selected. The operator CLI is covered too (status, usage, the refusal to
  import without `--force` on the json driver, import, verify, prune, vacuum).
* **Honest limitation:** the PHP runtime in this container (php-wasm) has no
  `pdo_sqlite`, so the PHP-side suite drives the store through a recording
  connection double (`tests/php/fixtures/cdr-store-double.php`), and the real
  SQLite run happens in Node. That is why `CDR_CACHE_DRIVER` defaults to `auto`:
  on a host without the extension nothing changes at all. The first thing to run
  on the real server is `php tools/cdr-cache.php status`, which prints whether
  pdo_sqlite is there and what the store would contain.

---

# CHANGES — assets/js/src/app.js (12,292 lines) split into 25 ES modules (P4b)

**Scope:** structure only. Every declaration keeps its exact source text; the
only edits are the `import`/`export` lines, one setter (see below) and the
deletion of one dead helper. No component, endpoint, style or response changed.

**Files:** `assets/js/src/app.js` (12,292 → 36 lines, now the entry),
`assets/js/src/lib/*.js` (7 new), `assets/js/src/components/*.js` (17 new),
`tools/split-js-file.mjs` + `tools/app-modules.json` (new),
`tools/module-budget.mjs` (new), `tools/ui-audit.mjs`, `tests/run.mjs`,
`assets/js/app.js` (rebuilt), `package.json` (+ `acorn`).

## Layout

| module | lines | contents |
| --- | --- | --- |
| `app.js` (entry) | 36 | React root, `App`, the auth-expiry wiring |
| `lib/react.js` | 65 | hook shortcuts, `h`, `keyActivate`, `useEscape`, lazy Tabulator loader |
| `lib/theme.js` | 42 | stored theme + the stylesheet injection that runs first |
| `lib/api.js` | 140 | `api`/`apiDownload`, auth expiry, role → route policy |
| `lib/time.js` | 200 | time zone, timestamps, day/date labels |
| `lib/format.js` | 61 | numbers, percentages, phone numbers, history labels |
| `lib/sla.js` | 38 | SLA storage + ring helpers |
| `lib/recording.js` | 84 | recording URLs and audio element |
| `components/ui.js` | 364 | icons, skeletons, tooltips, toasts, tabs, theme toggle |
| `components/charts.js` | 168 | gradients, sparklines, KPI cards, donut |
| `components/date-range-picker.js` | 1,079 | the range control |
| `components/filters.js` | 357 | filter bar + call-type toggles |
| `components/call-history.js` | 740 | history table, cradle dialog, recording player |
| `components/call-modal.js` | 1,252 | drill-down calls dialog |
| `components/agents.js` | 1,073 | agent table, sidebar, compare, overview |
| `components/overview.js` | 655 | operations dashboard |
| `components/queue.js` | 775 | queue dashboard |
| `components/telephone-numbers.js` | 796 | inventory + graphs |
| `components/simultaneous.js` | 604 | simultaneous-call counting |
| `components/auto-attendants.js` | 515 | list + calls sheet |
| `components/auto-attendant-structure.js` | 439 | option tree |
| `components/auto-attendant-report.js` | 1,812 | performance report |
| `components/settings.js` | 276 | domain settings dialog |
| `components/login.js` | 76 | login + alerts bell |
| `components/app-shell.js` | 850 | nav, routing, global filters, modals |

## How the split was done, and why that is safe

`tools/split-js-file.mjs` parses the committed single-file version
(`--from HEAD`, i.e. the pre-split commit) with acorn, treats every top-level
statement as a unit, and moves whole statements — **byte-identical, original
indentation included** — into the files named by `tools/app-modules.json`.
`import`/`export` lines are derived from the real usage graph: an identifier
used inside a unit whose declaration lives in another module becomes an import
from that module. The tool refuses to run if a unit is unassigned, claimed
twice, needs something that stays in the entry, or if the module graph has a
cycle.

Verification, all reproducible:

* `node tools/split-js-file.mjs --verify` — hashes every declaration's source
  text before and after: **115 declarations before, 115 after, 0 missing,
  0 added, 0 changed bytes**. One declaration (`inSelectedRange`) was dead code
  and is recorded as dropped; one (`setAuthExpiredHandler`) was added by hand.
* **A/B render check:** the pre-split bundle and the post-split bundle were
  mounted in the jsdom harness and the rendered HTML was dumped after visiting
  all six routes plus every Telephone Numbers tab and the modals: **12/12
  snapshots byte-identical**, no console errors.
* `npm test` — all 10 suites pass (php lint, css coverage, ui audit --strict,
  module budget, dead code --strict, build, js smoke, api matrix 86 checks,
  url policy 62, csv exports 17).
* The rebuild is deterministic (two consecutive builds are byte-identical) and
  the bundle got 21 kB smaller (453,575 → 432,664 bytes) because esbuild now
  sees real module boundaries instead of one 12k-line IIFE.

## The one manual edit

An ES module cannot assign to an imported binding, and `App` replaced the
auth-expiry callback on mount/unmount. That single cross-module write is routed
through `setAuthExpiredHandler()` next to the variable in `lib/api.js`; the map
records it under `manual`, so `--verify` reports "edited by hand: App" instead
of hiding it. The tool detects this class of error for any other declaration
(the split cannot even be generated when a cross-module write exists).

## Guards added

* `tools/module-budget.mjs` (in `npm test`): fails if any module grows past
  2,000 lines, if an import points at a file that does not exist, or if a
  module is imported by nobody.
* `tools/ui-audit.mjs` now audits all 25 modules instead of the single file and
  names `file:line` for every finding; its component-boundary detection uses
  the parser instead of indentation (the modules keep the original mixed
  indentation, which a regex could not handle).

## Known remaining large components (next candidates)

`AutoAttendantReport` (1,812 lines), `CallModal` (1,252), `DateRangePicker`
(1,079), `AgentPerformanceTable` (378) and `QueueDashboard` (759) are single
functions; splitting them is functional decomposition, not a file move, so it
was deliberately left out of a change whose guarantee is "moved, not edited".

---

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
