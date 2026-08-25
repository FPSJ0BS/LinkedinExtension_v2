# PHASES.md

## Completed in 3.9.3 — the first live diagnostics report

The report 3.9.2 made retrievable, and it overturned the diagnosis 3.9.1 shipped on. Local checks
only (rule 20); [CHECKS.md](CHECKS.md) carries the nine-item live list.

| Task | Goal | Status |
|---|---|---|
| TASK-0173 | The overflow menu was never found: the label, and three defects behind it | Complete |
| TASK-0174 | The section expander never ran on a whole-job run | Complete |
| TASK-0175 | The resume saved with no extension though the server states its type | Complete |
| TASK-0176 | Release 3.9.3 | Complete |

## Completed in 3.9.2 — the diagnostics report was unreachable

A reporting bug, fixed on its own because the report is the instrument every remaining live
question is meant to be answered with. Local checks only (rule 20).

| Task | Goal | Status |
|---|---|---|
| TASK-0172 | Download Diagnostics returns a report after a whole-job run | Complete |

## Completed in 3.9.1 — the first live capture

Driven by screenshots of a real recruiter account rather than by reasoning about markup. What the
capture broke was not a reader but the **click policy**. Local checks only — the live half is a user
step (rule 20), and [CHECKS.md](CHECKS.md) carries the eight-item list.

| Task | Goal | Status |
|---|---|---|
| TASK-0168 | The expander: accept counted expanders, refuse navigation and overflow menus | Complete |
| TASK-0169 | Contact details from behind `More...`; the eighth click, with rule 5 amended | Complete |
| TASK-0170 | Name the virus-scan state; stop fetching each document four times | Complete |
| TASK-0171 | Release 3.9.1 | Complete |

## Completed in 3.9.0 — multiple LinkedIn applicant UI support

The twelve phases of [`multiple-linkedin-dom-ui-support-guide.md`](multiple-linkedin-dom-ui-support-guide.md),
one Project Time Machine task each. Local checks only — the live half is a user step (rule 20).

| Phase | Task | Goal | Status |
|---|---|---|---|
| — | TASK-0153 | Adopt the guide and name it in CLAUDE.md as a governing contract | Complete |
| 1 | TASK-0154 | Pin the working UI with eleven tripwires; **zero production lines changed** | Complete |
| 2 | TASK-0155 | One shared schema; close the `setResume` spread and give the three derived columns a route | Complete |
| 3 | TASK-0156 | The section table into the core, `resolveField`, and a reader for the labelled fields | Complete |
| 4 | TASK-0157 | Layout detection whose only output is a reader order, proved inert over 720 permutations | Complete |
| 5 | TASK-0158 | Shape rules and heading aliases from evidence held; **no invented layout** | Complete |
| 6 | TASK-0159 | Section boundaries, `cutToOwnSection` into the core, header window by document order | Complete |
| 7 | TASK-0160 | The scroll target is never the applicant list, and the list's movement is measured | Complete |
| 8 | TASK-0161 | Download Diagnostics on the Applicants page — closes a standing known issue | Complete |
| 9 | TASK-0162 | Capture Current Applicant UI: read-only, sanitized, zero clicks | Complete |
| 10 | TASK-0163 | Fixture regressions over capture projections; `linkedom` declined, with reasons | Complete |
| 11 | TASK-0164 | Contact and resume variants, still seven clicks, contact finder stricter | Complete |
| 12 | TASK-0165 | Release 3.9.0, and the build-ID consistency check that was always missing | Complete |

## Completed in 3.0.0

| Phase | Goal | Status |
|---|---|---|
| 1 | Preserve v2.5 extraction, storage, grouping, CSV, and replacement-save behavior | Complete |
| 2 | Replace popup DOM manipulation with React + TypeScript components | Complete |
| 3 | Replace dashboard DOM manipulation with React + TypeScript components | Complete |
| 4 | Add reusable experience-company and education-institution card components | Complete |
| 5 | Convert service worker to TypeScript and update build identity | Complete |
| 6 | Add deterministic production build and local React runtime | Complete |
| 7 | Add React architecture and build validation tests | Complete |
| 8 | Run complete automated verification | Complete |

## Completed in 3.1.0 — Connections importer

| Phase | Goal | Status |
|---|---|---|
| 9 | Remove `GEMINI.md` and consolidate project rules into `CLAUDE.md` under 200 lines | Complete |
| 10 | Add `src/connections-core.js`: canonicalization, deduplication, challenge detection | Complete |
| 11 | Add `connections.js`: careful lazy-scroll discovery of visible `/in/` links | Complete |
| 12 | Add IndexedDB schema v3 (`importQueue`, `importSession`) with the database name unchanged | Complete |
| 13 | Add `src/import-queue-core.js` pure state machine and `src/queue-db.js` persistence | Complete |
| 14 | Rewrite the service worker as a one-at-a-time, single-tab import orchestrator | Complete |
| 15 | Add the React import dashboard with all nine controls and full status reporting | Complete |
| 16 | Preserve `id`, `collectedAt`, `notes`, and `tags` on duplicate replacement | Complete |
| 17 | Add partial (imported-only) and full CSV export | Complete |
| 18 | Add 42 new automated tests and two sanitized manual fixtures | Complete |
| 19 | Run typecheck, tests, build, validation, and `dist` inspection | Complete |
| 20 | Load `dist` in the user's Chrome and verify against a live LinkedIn account | **Pending — user browser** |

---

# 3.2.0 — Full connection coverage (planned)

## Target requirements

| # | Requirement | State after 3.2.0 |
|---|---|---|
| R1 | Explore **all** connections of the logged-in account | **Implemented** — resumable multi-pass discovery with allowlisted pagination, dedup across passes and restarts, and coverage reported as confirmed or estimated. Live DOM behavior unverified (phase 30). |
| R2 | Automatically open a connection's profile and collect data | **Implemented** in 3.1.0 |
| R3 | Automatically save, leave the profile, and move to the next | **Implemented** in 3.1.0 — the reusable tab navigates straight to the next URL rather than using browser Back: same effect, one less page load |
| R4 | Repeat until every connection is explored and all data collected | **Implemented** — batches run to the cap, cool down, and continue automatically; suspension auto-resumes; challenges still stop for a human |

## Decisions — all approved 2026-08-02 and implemented

| ID | Decision | As implemented |
|---|---|---|
| **D1** | Click pagination-only controls | `classifyControl()` in `src/connections-core.js` gates every click. A control must (a) carry an allowlisted label, (b) be proven inside the connections list, and (c) not match the forbidden-action pattern, which always wins. `connections.js` contains exactly one `.click()` call, behind that verdict. Connect, Follow, Message, InMail, Contact info, Endorse, Remove connection, Withdraw, Invite, Report, Block, Send, Share, Accept, Ignore, Save remain permanently prohibited. |
| **D2** | Auto-continue after worker suspension | `chrome.alarms` heartbeat (1 min) plus `recoverAfterInterruption()`. A `running` session resumes by itself; `pausedBy` of `challenge`, `user`, `navigation`, or `error` never does. `alarms` was added to the manifest for this and nothing else. |
| **D3** | Cap plus cooldown instead of unbounded | User-set batch cap and cooldown. Reaching the cap pauses with `pausedBy: "cooldown"` and a deadline; the heartbeat starts the next batch automatically unless the user stopped the run or a challenge was detected. The dashboard shows cap, cooldown countdown, batch number, and overall progress. |

## Phases

| Phase | Goal | Status |
|---|---|---|
| 21 | **Connection inventory.** `parseConnectionCount()` reads the advertised total; `readConnectionTotal()` scans the list header. A `500+` style total is stored but flagged unreliable and can never confirm coverage. | Complete |
| 22 | **Resumable multi-pass discovery.** Each `PV_DISCOVER_CONNECTIONS` call runs one pass from a persisted `cursorY` and returns the new cursor. The worker repeats passes (budget 400) until the reliable total is reached or the list is provably settled. Dedup spans every pass and browser restart. | Complete |
| 23 | **Pagination handling.** Allowlist + permanent denylist in `classifyControl()`; one guarded click site in `connections.js`. | Complete |
| 24 | **Coverage ledger.** `applyDiscoveryPass()` and `coverageReport()` track passes, quiet passes, pagination clicks, discovered/processed/remaining/failed, and report coverage as `confirmed`, `estimated`, `in-progress`, or `unknown`. | Complete |
| 25 | **Long-run durability.** `chrome.alarms` heartbeat resumes interrupted runs and elapsed cooldowns only. | Complete |
| 26 | **Batch mode with cap and cooldown.** User-set cap and cooldown, randomized 4–9 s inter-profile pacing, automatic next batch. | Complete |
| 27 | **Refresh policy.** `shouldSkipAsFresh()` skips profiles collected within N days (default 30) without navigating; a Force refresh checkbox overrides it. | Complete |
| 28 | **Scale hardening.** `putItem()` writes one queue row per state change instead of rewriting the queue; the dashboard pages the queue 50 rows at a time. | Complete |
| 29 | **Failure taxonomy and backoff.** `classifyFailure()` separates permanent (unavailable, 404, out of network) from transient; permanent fails immediately, transient backs off 15 s × 2^n up to `MAX_ATTEMPTS`. | Complete |
| 31 | **One collector surface.** `ensureCollectorTab()` is the only creation site (one `chrome.windows.create`, zero `chrome.tabs.create`); discovery and every profile share that tab. | Complete |
| 32 | **Login gate.** `classifyAuthState()` reports Signed in / Login required / Checkpoint detected / Unknown; `Sign in to LinkedIn` opens only LinkedIn's own page; no credential is ever handled. | Complete |
| 33 | **Automatic workflow.** `startCollectingWorkflow()` chains login check → Connections redirect → full discovery → automatic extraction, detached so the UI may close. | Complete |
| 34 | **Count reconciliation.** `createCardLedger()` + `reconcileDiscovery()` account for every rendered card and state any unexplained remainder. | Complete |
| 35 | **Clear Queue and stop reasons.** An abort generation ends in-flight work; `STOP_REASON` distinguishes every way a run can end. | Complete |
| 36 | **Foreground collector.** Visibility gating in both content scripts; `prepareCollectorStep()` activates the tab and un-minimizes the window; a hidden page pauses and never completes. | Complete |
| 37 | **Deterministic state machine.** `COLLECTION_STATE` with idempotent, guarded transitions; automatic discovery → extraction with no Stop/Start. | Complete |
| 38 | **Bounded discovery.** Growth excludes pagination clicks; dead controls and fruitless drain attempts are capped; `completed_with_gap` is a real terminal state. | Complete |
| 39 | **Parser field boundaries.** Employment metadata can never become a company or a role title; skills come from the card heading. | Complete |
| 40 | **UI legibility.** Primary/Advanced split, one session component, compact saved-profiles table with a details panel. | Complete |
| 30 | **Live verification at scale.** Load `dist` in Chrome and run a full collection against a real signed-in account. | **Pending — user browser** |

## Acceptance criteria for 3.4.0

- The import dashboard reports the account's total connection count and how many have been explored.
- Repeated Discover passes converge: each pass either adds new URLs or reports that the list is exhausted.
- A single user action can run until every discovered connection has been collected, subject to the
  user's cap and cool-downs.
- A service-worker suspension mid-run resumes without the user, while a CAPTCHA, checkpoint,
  restriction, or unusual-activity warning still stops the run for a human.
- Re-running after completion collects only what is new or stale, not everything again.
- Start Collecting needs no open LinkedIn tab and no open extension page: it opens the collector
  window itself, and the run survives the popup and importer page being closed.
- A signed-out browser produces "Login required" and LinkedIn's own sign-in page, never a discovery
  pass over the sign-in wall.
- Any difference between LinkedIn's advertised total and the collected URLs is explained, and an
  unexplained remainder is reported rather than hidden.
- Clear Queue stops the run and empties the queue while every saved profile survives.
- Collection never concludes anything from a hidden page: it pauses, keeps what it had, and resumes.
- Discovery always reaches a terminal state, and any unresolved difference is stated as a number.
- Discovery hands over to extraction with no user action in between.
- No saved profile contains an employment type or a duration as a company or a role, and no
  endorsement control is ever stored as a skill.
- A queue of several thousand entries does not degrade the dashboard or exhaust storage.
- `npm run check` passes, and phase 30 is closed by observed browser results, not by test output.

## What automated results can never prove

Phases 20 and 30 require a human with a signed-in LinkedIn account. No test in this repository can
close them. Until they are done, no claim may be made that full connection collection works live.
