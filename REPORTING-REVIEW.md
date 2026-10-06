# Reporting review from the manager's chair

**Who wrote this:** the person who runs the 9am huddle, the Monday ops review and
the month-end business review off this tool.
**Tree reviewed:** `09ee07d`, branch `arena/ecdba782-callcenter`.
**Method:** I went through what the app actually collects and computes —
`includes/reporting/{cdr_fields,support,rows,metrics,inventory}.php`,
`api/{report,calls,queue,cradle,telephone_numbers,filters}.php`, and every
screen — then wrote down what I could and could not do. **Every claim below is
tagged with the file/field it comes from, and the "already there" column was
verified in the source, not assumed.** Two of my first-draft findings turned out
to be wrong (period presets and the all-queues comparison already exist); they
are marked as corrections, because a review that flatters itself is useless.

---

## 1. What I can already do today (verified)

This is more than the last suite I used, and I would not change any of it:

| Capability | Where | Verified in |
| --- | --- | --- |
| Period presets: Today, Yesterday, This week, Last week, This month, Last month | filter bar | `filters.js:266–308` |
| Any date range up to 31 days, calendar + keyboard | date-range control | `date-range-picker.js`, `lib/date-range.js` |
| Department scoping (manager only), enforced on the server | filter bar | `filters.js`, `auth.php:47` `authorizedFilters()` |
| Call-type toggles (inbound/outbound/missed/on-net) | filter bar | `filters.js:12` |
| SLA target control, and thresholds shared by every role | Settings + dashboard payload | `api/settings.php`, `api/report.php` |
| All-queues comparison grid: calls, answered, abandon rate, SLA, avg ring, avg talk, agents by status | Queues → **Queue stats**, with search/site/active filters, weighted overall SLA, CSV export | `queue.js:528–576`, `:217` |
| Agent stats table: total/inbound/outbound/on-net/missed/missed-rate/abandoned/abandon-rate, AHT, inbound & outbound ASAs, longest talk, total talk time; sortable, column chooser, per-page site filter, CSV export | Agents | `agent-table.js:162–200`, `:300` |
| Dashboard KPI cards with drill-downs: total, inbound, outbound, on-net, missed, abandoned, answered, voicemail, service level | Dashboard | `overview.js` |
| Dashboard CSV: current vs previous for inbound/missed/answer-rate/outbound/total, **plus p50 and p90 ring and the missed breakdown**, plus the previous range's dates | Dashboard → Export CSV | `overview.js:149–150`, `:357` |
| 24-hour volume chart with the previous period overlaid | Dashboard | `overview.js` (dashed "Previous period" dataset) |
| Concurrency: peak, average, busiest day/hour, per-interval table, bucketed 15/30/60 min, CSV | Telephone Numbers → Simultaneous calls | `simultaneous.js` |
| Telephone numbers: per-DID calls/missed/talk, outcomes, hold/ring distributions per DID, **repeat callers** list, CSV | Telephone Numbers | `telephone-numbers.js:645–773` |
| Call history: search caller/dialed, type, derived outcome, agent/queue extension, time-of-day, paging, export of all filtered rows, recording playback and SIP flow per call | Call History | `call-history.js` |
| Drill-down from every number to the calls behind it, carrying the clicked filters | everywhere | `api/calls.php`, `call-modal.js` |
| Recording + SIP-flow columns in the call list, playback audited | drill-down | `call-modal-columns.js`, `api/recording.php` |
| Threshold alerts (users/queues/auto-attendants over limit for the range) | alerts bell | `api/alerts.php`, `filters.js` (alerts bell) |
| Live queue dignity: waiting now, agents available/on call/unavailable/offline, top waits | Queues → Overview | `api/cradle.php` (`waiting`, `agentStatus`, `waitSum`) |

**Two drafts I had to strike out** (worth saying, because they are the sort of
thing a review gets wrong): there *are* period presets, and there *is* an
all-queues comparison view. Also, the weighted-average discipline I was going to
ask for is already followed where it matters — queue overall SLA is weighted by
its base (`queue.js:541`) and agent AHT is weighted by inbound volume
(`agent-table.js:172`). Keep doing that.

---

## 2. Verdict: what is missing is the *report layer*, plus five derivable metrics

I can answer "what happened, for one period, on six screens, one at a time". I
cannot produce a defensible **daily, weekly and monthly pack** from it, and five
numbers I am asked about every week are not computed anywhere although the data
is already on the wire.

### Foundation gaps (fix before adding another KPI)

| # | Gap | Why it costs me | Evidence / build |
| --- | --- | --- | --- |
| **F1** | **No opening-hours concept anywhere.** Every SLA, abandon and ASA figure includes the hours nobody is rostered. | A 02:00 abandon pollutes an 08:00–18:00 desk's SLA, and my monthly SLA is wrong by a couple of points every month. This is the number I get challenged on in the business review. | No `business-hours`/`operating-hours` token exists in the tree. Build: a per-domain weekday calendar (+ holidays) in Settings, and one toggle in `authorizedFilters()` so every screen honours it. Settings already carries domain thresholds — this belongs beside them |
| **F2** | **The 31-day wall.** A calendar month just fits; a quarter, YTD, a 90-day trend or year-on-year cannot even be asked for. | Monthly is fine, but "how does this month compare to the same month last year" — the first question the owner asks — is impossible. | `includes/auth.php:59` (`$maxSpanDays = 31`) and `lib/date-range.js` (`MAX_RANGE_DAYS = 31`). Build: raise the cap for managers and stitch the day cache (`cache/cdr-day-*.json`, already per-day) per month; add QTD/YTD/Last 90 days presets |
| **F3** | **One comparison mode: previous equal-length period.** | For a Wednesday huddle, yesterday is the wrong baseline; for a monthly review, last month is the wrong baseline (different business-day count). | `comparison.previous` in `api/report.php`. Build: a mode switch — previous period / same weekday last week / same period last month / same point last month for MTD / same month last year |
| **F4** | **`site` is supported end-to-end but has no control.** It is in the URL state, in every request and enforced server-side; the filter bar only offers Department. | Multi-site tenants (Branch/HQ in the fixtures) cannot scope the dashboard to a site without hand-editing the URL. | `app-shell.js:40` reads `?site=`, `auth.php` scopes it, `filters.js` renders only the department select. Build: add the select; it is a one-file change |
| **F5** | **The call list has no sort control** — it is newest-first only. | "Show me the 20 longest waits" and "the 10 longest calls" become an export-and-Excel job. Both are standing weekly questions. | `api/calls.php:633` sorts by start descending only. Build: `sort`/`dir` params on the endpoint + sortable headers in the modal |
| **F6** | **No saved views and no one-click period pack.** Exports are broad (dashboard, agents, queues, numbers, calls, intervals) but each is a separate screen and a separate CSV, re-filtered by hand. | My month-end pack is six screens of copy-paste. Weekly I re-pick the same filters five times a day. | Build: saved filter sets per user (small), then a "period pack" that emits every summary table for one range with the filters shown; a scheduled email of the same is infrastructure, and I would defer it |
| **F7** | **No data-quality line anywhere.** | Before I present a month I need to know whether it is trustworthy: missing answer times, answered calls with zero talk time, missing disconnect reasons, duplicate ids. | All derivable from fields already parsed (`call-answer-datetime`, durations, `call-id`). Build: a small appendix table on the monthly report |

---

## 3. The pack I actually send, line by line

**✅ already there · ⚠️ needs a metric built · ❌ needs data we do not have**

### Daily huddle (yesterday + today so far)

| Line on my slide | Source today | Status |
| --- | --- | --- |
| Volume: offered, answered, missed, abandoned | Dashboard KPIs + drill-downs | ✅ |
| Service level vs target, with the target shown | Dashboard, settings-thresholded | ✅ |
| Abandon rate, and the abandoned-call list to call back | Abandoned KPI → drill-down → CSV | ⚠️ works, but it is four clicks and Excel; want a **Callback worklist** panel (one button) |
| **Abandons split by how long the caller waited** (<5s, 5–30s, >30s) | — | ⚠️ same `abandoned` flag today; needs wait seconds from `ringSeconds()`. A 4-second abandon is usually a misdial, a 90-second one is a staffing failure — same number today |
| **Which missed calls were returned, and how fast** | — | ⚠️ nothing matches a missed inbound caller to a later outbound to the same number. `callFromNumber()` on both directions is enough to build it. This is the single most useful daily metric I do not have |
| ASA and **p90 wait**, per queue and per agent | p50/p90 are computed and in the dashboard CSV, but not on screen; queue/agent cards show averages | ⚠️ surface p50/p90; add ASA *by interval*, not just for the whole range (`rows.php:219–220` already computes them) |
| Longest waits / longest talks right now | Queue Overview live + `ibLtt` in the agent table | ⚠️ add a sortable "longest waits" list (needs F5) |
| Voicemail worklist (who left one, was it returned) | Voicemail is a metric and `missed_voicemail` a breakdown, so it is drillable and exportable | ⚠️ the "was it returned" half is the same matching problem as callbacks |
| Today vs same weekday last week, by hour | Dashboard compares to the previous period of equal length | ⚠️ needs F3 |
| Waiting now / agents available across **all** queues | Queues → Overview is per queue | ⚠️ an all-queues attention list ("waiting >60s anywhere") would save me tab-switching |

### Weekly ops review (Mon–Sun, per agent, per queue)

| Line on my slide | Source today | Status |
| --- | --- | --- |
| All-queues grid: calls/answered/abandon/SLA/ring/talk/agents | Queues → Queue stats | ✅ |
| Agent scorecard with calls, AHT, ASAs, missed, abandoned | Agents table (+ CSV) | ✅ |
| Ranked scorecard with a **totals row** for the visible columns, and a target column | Agent KPIs sit above the table; the table itself has no totals row and no target column | ⚠️ small change, big credibility win when I read a row out |
| Weekday × hour heatmap (volume, and abandon/SLA overlays) | Telephone Numbers has a heatmap; dashboard/queues do not | ⚠️ re-use the existing chart on Dashboard and per queue |
| **Transfer rate and the agent→agent / queue→queue pairs** | `call-through-user`/`-department`/`-site`, `call-parent-call-id`, `call-leg-ordinal-index` are collected and used only for attribution | ⚠️ derivable now; nobody computes a transfer count |
| **Hold time per agent and per queue** | `call-batch-on-hold-duration-seconds` is read inside `ringSeconds()` (`support.php:87`) and thrown away; no column, no CSV field | ⚠️ derivable now — this is nearly free and I ask for it weekly |
| **Repeat-call rate** (the honest FCR proxy) next to each agent, and tenant-wide | A repeat-caller *list* exists on the Telephone Numbers page only | ⚠️ move it to a rate column on Agents and the dashboard, with a 24h/72h split |
| Outbound contact rate (connects ÷ attempts) | Agents table has outbound calls and OUT ASAs; no rate | ⚠️ derivable from `call-answer-datetime` on outbound legs |
| What changed this week (outliers) | Dashboard trend arrows vs the previous period | ⚠️ an "outside ±2σ of the last 4 weeks" list by day/agent/hour |
| **Sentiment and topics for the period** | Collected as `call-intelligence-percent-*` / `topics-top`, rendered only live on Queues → Overview; not filterable, not in any report | ⚠️ the data is already there; expose it per period, and add a "negative only" filter |

### Monthly business review (calendar month, MoM + YoY)

| Line on my slide | Source today | Status |
| --- | --- | --- |
| This month vs last month | Two manual runs, stitched | ⚠️ needs F2/F3 for one screen, one export |
| This month vs **same month last year** | — | ❌ blocked by F2 (needs a 1-year lookback) |
| Daily volume profile vs a baseline (each day vs the same weekday in the prior 4 weeks) | — | ⚠️ derivable; label it a baseline, not a forecast |
| Staffing estimate per interval (Erlang-flavoured) | — | ⚠️ volume × AHT ÷ interval ÷ target occupancy, with the occupancy assumption printed on the page |
| Agent monthly trend (per week within the month) | Manual per week | ⚠️ multi-period query |
| Number/DID portfolio roll-up, with zero-traffic and high-abandon flags | Telephone Numbers has the per-DID numbers | ⚠️ add the monthly roll-up and the flags |
| Compliance/audit pack (all summary tables, one period, one file) | Exports are per screen; the export itself is audited | ⚠️ F6 |
| Data-quality appendix ("trust this month") | — | ⚠️ F7 |
| **Occupancy** (talk time ÷ logged-in time), adherence, calls-per-hour | — | ❌ **we do not have roster or scheduled-hours data.** The app knows extensions and names from the PBX directory and nothing else. Without a roster I will keep reporting talk-time share, clearly labelled, and not call it occupancy |

---

## 4. Filters I would add, in priority order

| # | Filter | Backing data | Notes |
| --- | --- | --- | --- |
| 1 | **After-hours / opening-hours toggle** | new domain calendar (F1) | Changes every SLA number we publish; do this one first |
| 2 | **Period presets beyond a month**: Last 90 days, QTD, YTD, and a comparison-mode switch | F2/F3 | Removes the calendar from the workflow |
| 3 | **Site** | already supported end-to-end (F4) | One select; the plumbing is done |
| 4 | **Outcome multi-select** (answered / missed / abandoned / voicemail / no-answer) | `outcome`, `cdrLooksLikeVoicemail()` | Call History can already do this; nothing else can |
| 5 | **Wait-time bucket** (`waited > 30s / 60s / 120s`) | `ringSeconds()` | Produces the coaching list, not just a count |
| 6 | **Queue multi-select** | `cdrQueueMatch()` | Queue Stats compares all queues, but I cannot restrict the dashboard to my three |
| 7 | **Agent multi-select** on the dashboard | `callAgent()` | Exists on Agents only |
| 8 | **Sentiment: negative only** | `call-intelligence-percent-negative` | Turns the live donut into a worklist |
| 9 | Sort control on every call list (longest wait, longest talk, newest) | F5 | Not a filter, but the same class of gap |
| 10 | Has recording / has SIP flow | `call-recording-status`, `callHasFlowHint()` | Compliance spot-checks |

---

## 5. Totals and summary presentation

Small, and they are about trust rather than features:

1. **A totals row** on the agent, queue-stats and DID grids, computed from the
   rows on screen for the current filters — sums for counts and durations,
   recomputed weighted rates (never a mean of percentages).
2. **Denominators on cards**: `Abandon 12% (34 of 280 offered)`, not `12%`. A
   rate without its base is how last month's "best agent" turned out to be
   someone with nine calls.
3. **Comparison labels that state the baseline and the period length**: "vs
   previous 7 days", "vs same weekday last week", with business days shown on
   monthly views.
4. **Timezone and range printed on every export** (the dashboard export already
   includes the previous range — extend that to every CSV).
5. **Definition footnotes on the report**: which metric ids count as offered,
   what "answered" excludes, when the data was fetched. One line each, driven by
   the metric catalog so it cannot drift.

---

## 6. Data we would need to bring in (with what it unlocks)

Nothing below is derivable from the CDR; each line says what to buy, from where,
and what it unlocks — so the cost is visible against the benefit.

| Input | Unlocks | Likely source |
| --- | --- | --- |
| **Roster: team, supervisor, scheduled shifts** | Occupancy, adherence, calls-per-hour, team rollups, a supervisor view | WFM/HR export, or a small table maintained in Settings |
| **Wrap-up / disposition codes** | True FCR, call-reason mix, quality sampling, "why did they call" | ACD disposition capture, or a two-click disposition on the call modal (needs an agent-workflow decision, and it changes agent behaviour) |
| **Forecast** | Forecast-vs-actual, forecast accuracy; replaces the baseline in §3 | WFM export |
| **QA scores** | A quality column beside speed, so nobody optimises AHT | The existing QA process, imported monthly |
| **Cost / tariff per trunk and DID** | Cost per call and per minute, cost of abandons, outbound campaign ROI | Rate card |
| **Holiday calendar** | F1 is only as good as its exceptions | Settings (same screen as opening hours) |
| **Per-queue SLA targets** | Sales and support have different promises; one global target forces me to pick a number that is wrong for both | Settings (extends the existing thresholds) |

---

## 7. Build order I would fund

**Sprint A — make the daily numbers defensible.** F1 opening hours, F4 site
control, F5 sort, abandon-split by wait, p50/p90 on screen, ASA by interval,
longest-wait list, callback matching (the returned-call metric), denominators and
the totals row. After this, the 9am huddle stands up to a challenge and I can
justify the staffing roster.

**Sprint B — the weekly review.** F2/F3 (longer windows, comparison modes),
heatmap on the dashboard and per queue, the ranked agent scorecard with
targets, transfers, hold time, repeat-call rate, outbound contact rate, outlier
list, negative-sentiment filter, queue/agent multi-select.

**Sprint C — the month-end pack.** F6 period pack and saved views, F7
data-quality appendix, MoM/YoY, baseline and staffing estimate, sentiment
report, DID roll-up with flags, per-queue SLA targets, holiday calendar.

**Deliberately not proposed:** per-call points on charts (standing rule); any
occupancy or adherence figure before there is a roster (it would be talk-time
share wearing a false label); CSAT/NPS (no such data); anything that needs
dispositions before there is a capture workflow.

---

## 8. Decisions I need before Sprint A

1. **Are we 24/7 or an opening-hours desk — and in which timezone?** If the desk
   follows Philippine hours for a US-time business, F1 must be a per-domain
   calendar, not a hard-coded 08:00–18:00.
2. **Is there a roster or schedule I can have access to?** Without it, the
   scorecard ships without occupancy and says so.
3. **One SLA target or per queue?** Cheap now, painful later.
4. **Month-end format: CSVs, or a single printable report (HTML → print to PDF)
   the owner can read without Excel?**

---

## Appendix — where each claim was checked

* Presets and filters: `filters.js:12`, `:138`, `:266–336`.
* Site in URL/requests/server, no control: `app-shell.js:40`, `:458`;
  `includes/auth.php:66–69`; `filters.js` (department select only).
* 31-day cap: `includes/auth.php:59`; `lib/date-range.js` (`MAX_RANGE_DAYS`).
* Only one comparison mode: `api/report.php` (`comparison.previous`), dashboard
  overlay in `overview.js`.
* Queue stats grid, weighted SLA, CSV: `queue.js:198–217`, `:528–576`.
* Agent table, weighted AHT, KPI totals, CSV: `agent-table.js:162–200`, `:224`,
  `:300`.
* p50/p90 ring computed and exported, not displayed: `rows.php:219–220`,
  `overview.js:149–150`.
* Newest-first only: `api/calls.php:633`.
* Hold seconds read and discarded: `includes/reporting/support.php:87`.
* Transfer fields used for attribution only: `rows.php:91`,
  `cdr_fields.php:298–315`.
* Sentiment/topics collected, live-only: `call-intelligence-*` fields,
  `queue.js` (sentiment donut), not in any report payload.
* Repeat callers: `api/telephone_numbers.php:321`, `telephone-numbers.js:645–773`.
* No opening-hours, roster, forecast, disposition, QA-score or cost concept in
  the tree (searched `includes/`, `api/`, `assets/js/src/`).
