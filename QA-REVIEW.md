# QA review — CallScope reporting

**Reviewed:** branch `arena/ecdba782-callcenter` @ `3b8b838` (P7), the same tree
that is merged into `main`.
**Method:** full read-through of `api/`, `includes/`, `assets/js/src/`, `tools/`
and `tests/`; targeted instrumentation of the real bundle in the jsdom harness;
two reproduction probes against a real PHP 8.4 interpreter; `npm test` (13
suites) on the reviewed tree.
**Stance:** adversarial — what breaks, what lies, what will bite the next
engineer. Everything below was looked for in the code, and the three headline
items were reproduced or traced to vendor source.

**Honesty note on evidence levels.** The XSS finding (QA-1) is proven at the
code-path level: the app's formatters return the payload verbatim (probe
output below) and Tabulator 6.3.1 assigns a string formatter result to
`element.innerHTML` (vendor source). It was **not** reproduced end-to-end in
this sandbox because Tabulator cannot lay out under jsdom (it throws in
`RowManager.resetScroll`), which is exactly why the JS suite stubs Tabulator.
Treat QA-1 as "verified by code path", not "seen in a browser".

## Verdict

The data layer is in good shape: one definition of missed/abandoned, server-side
scoping that the client cannot escape, a 31-day range clamp, no exception text in
responses, allowlisted outbound URLs, and 13 suites that actually assert the
numbers. The weak spots are at the edges: **one exploitable injection sink in the
drill-down table**, **runtime state (caller data + audit logs) still tracked in
git on this branch**, **third-party JS loaded from public CDNs at runtime**, and a
handful of small inconsistencies that will confuse whoever maintains it next.
None of them change a reported number; all of them are cheap to fix.

## Round 1 — what has been fixed since this review

All P0s and P2s are done; see `CHANGES.md` ("QA round 1") for the full record
and the test evidence. In short:

| finding | commit | what a reader should verify |
| --- | --- | --- |
| QA-1 XSS | `092bbc0` | `tests/js/smoke.mjs` mounts every text column the way Tabulator does; it fails against the pre-fix source |
| QA-2 tracked runtime state | `c92750d` | `git ls-files cache logs` is empty; the files are still on disk |
| QA-6 queue rows | `23d9c86` | queue recent rows now carry the CDR id, and Open sends it as `callId` |
| QA-7 dead `paused` | `67db536` | no `paused` in `queue.js`/`app-shell.js` |
| QA-8 metric vocabulary | `7b0ae4e` | `includes/reporting/metrics.php`; unknown metric → 422; `api/filters.php` serves labels |
| QA-9 error states | `67db536` | `ui.js::ErrorState`; the smoke suite forces a 502 and asserts Retry recovers |
| QA-10 playback audit | `23d9c86` | `logs/audit-*.jsonl` gets `"resource":"recording"` on both paths |
| QA-11 big modules | `750d4d7` | `call-modal-columns.js`, `lib/aa-call-fields.js`; the smoke suite pins the column set/order |

QA-3, QA-4 and QA-5 (all P1) are deliberately untouched and still need your
answers to Q1/Q3/Q4 below.

## Findings

| # | Sev | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| QA-1 | **P0** | security | Caller-ID name (and 4 other text columns) rendered as HTML in the drill-down table → stored XSS | **Fixed** `092bbc0` — text formatters return Text nodes; regression test mounts them the Tabulator way |
| QA-2 | **P0** | hygiene / privacy | 93 runtime files under `cache/` + `logs/` are tracked in git on this branch (CDR payloads, audit trail); `origin/main` has them removed, so every merge re-adds them | **Fixed** `c92750d` — `git rm --cached`; history left alone by choice (no force-push), so old blobs remain |
| QA-3 | **P1** | supply chain | React/Chart.js loaded from public CDNs; Tabulator JS+CSS fetched from unpkg on first modal open; no SRI, no CSP | Open — P1, out of this round (needs the internal-only answer, Q3) |
| QA-4 | **P1** | ops | App assets are not minified (JS 444 kB, CSS 139 kB) and not cache-busted (`assets/js/app.js` with no `?v=`) | Open — P1, out of this round (needs the build/deploy decision, Q4) |
| QA-5 | **P1** | policy | Settings is shown to every role, readable by every role, and writable by supervisors — tenants-wide thresholds that colour every report | Open — P1, out of this round (needs the policy answer, Q1) |
| QA-6 | **P2** | consistency | "Recent calls" on the Queues screen carry no call id (`parentId` is an internal grouping key) → the one screen that cannot drill into a single call | **Fixed** `23d9c86` — recent rows carry the CDR id + an Open button; tested both sides |
| QA-7 | **P2** | dead code | `paused` prop on `QueueDashboard` is unreachable (`paused: false` hardcoded) and the live-ops screen never refreshes itself | **Fixed** `67db536` — prop removed; the live mode it implied is backlog F2 |
| QA-8 | **P2** | correctness | Metric names are an implicit contract; unknown metrics silently return "no calls" instead of an error, and `metricLabels` duplicates the vocabulary in the modal | **Fixed** `7b0ae4e` — `includes/reporting/metrics.php`, 422 on unknown, served via `api/filters.php` |
| QA-9 | **P2** | polish | Error copy is inconsistent ("Failed to load…" vs "Unable to load…", no Retry), and `formatPhoneNumber` is NANP-only + duplicated | **Fixed** `67db536` — one `ErrorState` with Retry in every panel; duplicate formatter merged; audio ids safe |
| QA-10 | **P2** | audit | Playing a recording is not audited (views and exports are) | **Fixed** `23d9c86` — playback audited (`stream:0` and `stream:1`) |
| QA-11 | **P2** | maintainability | `auto-attendant-report.js` is 1789 of the 2000-line module budget; `call-modal.js` 1469 | **Partly fixed** `750d4d7` — the two named files split (1,469→1,139 and 1,789→1,698); next: `agents.js` 1,100, `date-range-picker.js` 1,079 |

---

### QA-1 — Stored XSS in the drill-down call table (P0)

`assets/js/src/components/call-modal.js` defines five columns whose formatter
returns a **raw string** from the CDR:

* `From Name` (`call-modal.js:330`): `formatter: cell => cell.getValue() || ''`
* `From` / `Dialed` / `To` (`call-modal.js:351/373/395`): `formatter: cell => formatPhoneNumber(cell.getValue())`
* `Reason` (`call-modal.js:419`): `formatter: cell => cell.getValue() || ''`

Tabulator 6.3.1 applies a string formatter result with
`this.element.innerHTML = val` (`dist/js/tabulator.js`, `_generateContents()`);
its own `plaintext` formatter exists precisely to escape
(`return this.emptyToSpace(this.sanitizeHTML(cell.getValue()))`), and the app
uses custom formatters everywhere instead.

Probe (real bundle, hostile row, formatter invoked directly):

```
column under test: {"title":"From Name","field":"from","formatter":"(cell) => cell.getValue() || \"\""}
formatter output:   "<img src=x onerror=\"alert(1)\">"
escaped?            false
other string formatters: From / Dialed / To / Reason — all return the payload verbatim
```

`from` is `callFromName()` — i.e. the caller-ID name the PBX recorded. That
value is attacker-influenced (CNAM, or a SIP display name from anyone who can
reach the trunk). Rendering it as HTML in an authenticated session gives script
execution in a context that can read recordings, export every call the user may
see, and call every endpoint that session can reach.

The same fields are safe in Call history (React escapes string children), so
this is a modal-only hole — as is the new `Rec` / `SIP flow` code, which
returns DOM nodes.

**Fix:** `formatter: 'plaintext'` for the five text columns (or return a text
node). Add a regression assertion to `tests/js/smoke.mjs`: for every column
whose field is a free-text CDR string, the formatter's output must not contain
`<` … which today it does.

### QA-2 — Runtime state is committed (P0)

`.gitignore` says, in so many words, "never commit runtime state: these
directories hold caller records, tenant domains, PBX cache payloads and audit
trails". It lists `/cache/` and `/logs/`. The branch nevertheless tracks 93
files under those paths — inherited from the first commit — including
`cache/cdr-day-*.json`, `cache/aa/<tenant>.json`, `cache/callqueues-*.json`,
`logs/app-*.log`, `logs/audit-2026-09.jsonl` (772 lines) and
`logs/audit-2026-10.jsonl`: caller numbers, tenant names, and a per-user trail of
who viewed and exported what.

`origin/main` tracks none of them (verified: `git ls-tree origin/main | grep -c '^\(cache\|logs\)/'` → 0), so this branch and `main` disagree, and **every
merge from this branch re-adds them**.

**Fix:** `git rm -r --cached cache logs` + commit. **Caveat to handle first:**
that merge will delete those paths from a working tree that still has them, so
keep a copy of the audit trail (`robocopy logs logs_backup /E`) if it is
evidence you are required to retain — see open question Q2.

### QA-3 — Third-party JavaScript from public CDNs, at runtime (P1)

`portal.php` loads React 18 and Chart.js from `unpkg.com` / `cdn.jsdelivr.net`,
and `assets/js/src/lib/react.js` injects `tabulator-tables@6.3.1` (JS **and**
CSS) from unpkg the first time the drill-down modal opens. There is no SRI, no
CSP, and no pinning by hash. Consequences: a CDN compromise or takedown executes
arbitrary script inside an authenticated session (or breaks the modal with
"Unable to load the call table"), and the app cannot run on a network that does
not allow those hosts — unusual for a tool that otherwise talks to an internal
PBX.

**Fix:** vendor the three libraries into `assets/vendor/` and serve them
same-origin (Tabulator first — it is the one fetched at runtime); if a CDN must
stay, add `integrity` + `crossorigin` and a CSP that names the two hosts.

### QA-4 — Unminified, uncacheable assets (P1)

`tools/build.mjs` compiles JS with `--target=es2020` and no `minify`, and CSS
with `--minify=never`. The shipped bundle is 444 kB of JS and 139 kB of CSS for
what is a ~12k-line front end. `portal.php` links them at fixed paths with no
version query, so a deploy cannot be *proven* to reach every browser — the
classic "old JS against new API" skew.

**Fix:** `--minify` behind a `--prod` flag (keep the readable build for dev),
then content-hash the filenames or append `?v=<hash>`, and serve them with
`Cache-Control: public, max-age=31536000, immutable`.

### QA-5 — Settings is a policy hole with a UI inconsistency (P1)

* Every role gets the Settings button (`app-shell.js:761-776`, outside the `allowedRoutes` filter that hides the other items).
* `settings.js:15` allows saving only for `office_manager` / `supervisor`.
* `api/settings.php`: **GET has no role gate at all** (any authenticated user,
  including an agent, can read the thresholds); POST requires
  `office_manager` or `supervisor`.
* The values are tenant-wide: `slaSeconds`, `slaPct`, `missedPct`,
  `abandonPct`, `ahtMinutes`… They decide every red/green tone on the Dashboard,
  Agents, Queues and Alerts.

So an agent sees a panel they cannot use and can read the values behind the
colours; a supervisor can silently change what "missed" and "SLA" mean for the
whole tenant, including the office manager's screens. This is a product decision
(see Q1), but the *inconsistency* is not: the UI should render what the server
allows, and the GET should be gated like the POST.

### QA-6 — The one screen that cannot drill into a call (P2)

Agents' recent-call rows now open exactly that call (`agents.js:1054` → the
`callId` filter added in P7). The Queues screen's "recent calls" rows
(`api/queue.php` ~558–572) emit `caller, agent, wait, talk, reason, startedAt,
parentId, path, hops` — and `parentId` is a union-find grouping key over call
ids, not a CDR id, so nothing in that row can be handed to `callId`.
Reproduced: the recent rows have no `id` field at all.

**Fix:** emit the CDR `id` (or `call-parent-cdr-id`) on those rows and make the
row click open the modal with `callId`, exactly like Agents.

### QA-7 — Dead `paused` prop, missing live mode (P2)

`app-shell.js:653` passes `paused: false` and nothing else ever sets it, so
`QueueDashboard`'s `paused` guard (`queue.js:15,39`) is unreachable. The Queues
nav is presented as live operations (KPIs, agent roster, recent calls) but only
refetches when a filter changes.

**Fix:** either delete the prop, or make it real — a "Live · Pause" toggle with a
30 s poll and an "updated at" stamp (F2 below).

### QA-8 — Metric vocabulary is an implicit contract (P2)

The UI sends `incoming`, `total`, `missed`, `answered`, `abandoned`,
`sla_missed`, `missed_abandon`; `api/calls.php` implements those plus
`inbound`, `offered`, `queue_abandoned`, `queue_offered`, `sla`,
`missed_noanswer`, `missed_voicemail`, `missed_no_abandon`, `handled`,
`voicemail` — and its final `return $type === $metric` turns any unknown value
into a plausible-looking empty list ("No calls found."). The display names live
in a second hand-maintained map (`metricLabels`, `call-modal.js`).

**Fix:** one canonical enum, validated (422 on unknown), exposed from one place
(e.g. `api/filters.php`) and used by both sides. That also makes the P7
queue-stage scoping explicit rather than a name match.

### QA-9 — Small consistency sweep (P2)

* Error copy: "Failed to load simultaneous calls / telephone numbers" vs "Unable
  to load …" everywhere else; no error state offers a Retry.
* `formatPhoneNumber` (`lib/format.js:54`) handles 10/11-digit NANP only —
  extensions (6080) and international numbers render raw. `telephone-numbers.js:545`
  re-implements the same idea (`formatTopNumber`) with 11-digit handling for
  `+1`; merge them.
* `.cdraudio` audio elements are appended to `document.body` with
  `id="audio-<callid>"`; ids derived from CDR values can contain characters that
  make the id invalid, and nothing ever removes old elements.

### QA-10 — Playback is not audited (P2)

`auditView()` records report views and every CSV export. Listening to a call
recording is a more sensitive act than viewing a list, and `api/recording.php`
only logs *refusals* (`appLog`). If the audit trail is there for compliance, it
has a hole (F8).

### QA-11 — Next split targets (P2)

`auto-attendant-report.js` is 1789 lines against the 2000-line budget enforced
by `tools/module-budget.mjs:21`; `call-modal.js` is 1469. Recommend splitting
both before adding features to them (the P4 split pattern and the module map in
CHANGES.md make this mechanical).

## Verified good (do not "fix" these)

* **Scope cannot be widened by the client.** `authorizedFilters()`
  (`includes/auth.php:46`) forces department/agents for supervisors and agents,
  validates the dates, and clamps the span to 31 days. Tested by the endpoint
  matrix.
* **No internals leak in errors.** Every endpoint logs `$e->getMessage()` via
  `appLog`/`appExceptionLog` and answers with a generic message + 502 (e.g.
  `api/agents.php:375-388`).
* **Outbound URLs are allowlisted.** Recording and call-flow refuse foreign
  hosts, non-PBX endpoints and CRLF injection (covered by `tests/php/endpoints.mjs`).
* **CSV exports** stream the whole filtered set, neutralise formula-like values,
  and carry the P7 columns; `CSV_EXPORT_MAX_ROWS` (200 000) is the only cap.
* **Deterministic front-end build** with an explicit Tailwind `@source` list, and
  four static gates (`css-coverage`, `ui-audit`, `module-budget`, `dead-code`) in
  `npm test`.
* **Drill-down parity on Queues was checked and cleared.** I built the ambiguous
  fixture (a CDR whose `call-through-user` is queue 701 while its DID maps to
  700): `queue.php` reports 1 call for each queue and
  `calls.php?queue=700|701&metric=total` returns exactly those same rows, so the
  `call-through-user`-first precedence keeps the two screens in step. No ticket.
* Housekeeping is clean: no `TODO`/`FIXME`, no `console.*` left in the sources,
  no dead endpoints (the P1/P2 passes removed them).

## Feature backlog (worth building, ranked by value ÷ effort)

| # | Feature | Why / what exists already |
| --- | --- | --- |
| F1 | **Shareable view state in the URL + "Copy link"** | The app already writes `?start&end&department&site` (`app-shell.js` ~423) but not route/tab/selection/modal filters. Deep links ("Queues → 700", "Agents → Overview → 6080") are the single biggest usability win for a reporting tool. |
| F2 | **Live queues** (30 s poll, Pause, "updated 12:03:44") | Turns QA-7 into a feature; the `paused` prop is already there waiting. |
| F3 | **Scheduled digest e-mails / report packs** (daily missed + SLA CSV to a list) | All the computation exists; needs a small outbox table + cron + a settings field. |
| F4 | **Row detail everywhere**: click a call row → cradle-to-grave + recording | The dialog and player were extracted into components in P7; only the wiring is missing (and the row ids from QA-6). |
| F5 | **Baseline-aware alerts + per-queue SLA targets** | Alerts are fixed thresholds today; the 4-week cache is already on disk, and one tenant-wide SLA is a blunt instrument for queues with different service promises. |
| F6 | **Search inside the drill-down modal** | Call history has free-text search; the modal that opens from every other screen does not. |
| F7 | **Agent scorecard export** for 1:1s (period compare + recent calls) | Composition of existing payloads; high perceived value for supervisors. |
| F8 | **Retention + playback audit** (old-recording report, who-listened log) | Closes QA-10 and answers the first question any owner asks about recordings. |
| F9 | **Retry affordances on error states** | Every failure today prints a sentence and requires a full page reload. |

## Open questions for the product owner

1. **Should a supervisor change tenant-wide thresholds?** (QA-5) If yes, keep
   the server gate and relabel the modal "Domain defaults"; if no, restrict POST
   to `office_manager`.
2. **Is `logs/audit-*.jsonl` compliance evidence?** (QA-2) It decides how the
   untracking is done and whether playback audit (QA-10) is mandatory.
3. **Is the deployment internal-only?** (QA-3) It decides how urgent vendoring
   the CDN libraries is — and whether browsers hitting the PBX directly for audio
   (the first `<source>` in `recordingSources()`) is acceptable at all.
4. **Roughly how many concurrent users and what typical range?** (QA-4) It
   decides whether minification/caching is a "nice" or the top item.

## Appendix — reproduce

```cmd
node tests/run.mjs                  :: 13 suites, the reviewed tree is green
node tools/module-budget.mjs        :: line-budget report (QA-11)
```

```js
// QA-1 probe (formatter output for a hostile caller name), from the repo root:
//  - mount the bundle in tests/js/harness.mjs, open the dashboard KPI modal,
//    read the built columns from the harness' `tables` registry, and call
//    fromCol.formatter({ getValue: () => '<img src=x onerror=alert(1)>' })
//  - it returns the payload unescaped; Tabulator 6.3.1 then assigns it to
//    element.innerHTML (dist/js/tabulator.js, _generateContents)
```

```js
// Queue drill parity probe (cleared): fixture = one CDR through queue 701 whose
// DID maps to queue 700 + one abandon in 700. queue.php: 700.totalCalls = 1,
// 701.totalCalls = 1; calls.php?queue=700 → ['q2'], queue=701 → ['q1'].
```
