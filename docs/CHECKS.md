# CHECKS.md

## Automated verification - 3.9.0 multiple LinkedIn applicant UI support

Executed in this environment on 2026-08-08. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

The twelve phases of [`multiple-linkedin-dom-ui-support-guide.md`](multiple-linkedin-dom-ui-support-guide.md),
each one its own Time Machine task with its own `npm run check`. The baseline before the series was
**475 passed / 0 failed**.

| Command | Result |
|---|---|
| `node project-time-machine/scripts/status.js` / `audit.js` | one unlogged change (the guide's own 546-line append); assigned to TASK-0153 rather than absorbed |
| `npm run check` after TASK-0153 (adopt the guide) | typecheck, build, **475 passed / 0 failed**, docs:check (17 files), validate (31 build files) |
| `npm run check` after TASK-0154 (Phase 1, tripwires) | typecheck, build, **486 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0155 (Phase 2, the two merge holes) | typecheck, build, **490 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0156 (Phase 3, the seams) | typecheck, build, **496 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0157 (Phase 4, layout detection) | typecheck, build, **500 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0158 (Phase 5, evidence-driven fallbacks) | typecheck, build, **505 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0159 (Phase 6, section boundaries) | typecheck, build, **509 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0160 (Phase 7, scroll containers) | typecheck, build, **513 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0161 (Phase 8, diagnostics UI) | typecheck, build, **516 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0162 (Phase 9, sanitized capture) | typecheck, build, **520 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0163 (Phase 10, fixture regressions) | typecheck, build, **525 passed / 0 failed**, docs:check, validate |
| `npm run check` after TASK-0164 (Phase 11, contact and resume variants) | typecheck, build, **529 passed / 0 failed**, docs:check, validate |

## Automated verification - 3.7.8 the section that was never read, every page, and a resume that saves itself

Executed in this environment on 2026-08-03. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Command | Result |
|---|---|
| `node project-time-machine/scripts/status.js` / `audit.js` | clean tree, no active task, audit passed |
| `npm run check` after TASK-0044 (sections) | typecheck, build, **408 passed / 0 failed**, validate |
| `npm run check` after TASK-0045 (resume tab) | typecheck, build, **409 passed / 0 failed**, validate |
| `npm run check` after TASK-0046 (pagination) | typecheck, build, **410 passed / 0 failed**, validate |
| `npm run check` after TASK-0047 (columns) | typecheck, build, **410 passed / 0 failed**, validate |
| `npm run check` after TASK-0048 (popup, prose) | typecheck, build, **410 passed / 0 failed**, validate |
| `npm run check` after TASK-0049 (row heights) | typecheck, build, **411 passed / 0 failed**, validate |
| `npm run check` after TASK-0050 (release) | typecheck, build, **411 passed / 0 failed**, validate |

Three intermediate failures are worth recording, because each caught a real mistake rather than a
stale assertion:

- **`chrome.tabs.create` in the worker.** The first version of the resume cycle created the tab in
  `background.ts`. Three tests refused it — rule 12 says `collector-tabs-core.js` is the only place a
  tab may be created. The tab work moved into the controller as `openDocumentTab`/`closeDocumentTab`.
- **`.click()` inside a comment.** `tests/import-integration.test.js` asserts the worker never clicks
  a page control, by searching the source for `.click()`. A comment of mine describing the old
  behaviour contained the literal string. Reworded.
- **A ternary left with no else branch.** Removing the "nothing queued yet" paragraph from the popup
  left `) : (` followed by `)}`, which `tsc` caught as `TS1109: Expression expected`.

### New tests, and what each asserts

**`tests/applicants-core.test.js`**

- *a section root has to carry the section, and a useless one never blocks a better one* — asserts
  `carriesSectionContent` gates the ancestor walk, that the heading's own parent is no longer accepted
  sight unseen, that `siblingSectionFor` is the fallback, that the sibling range references the live
  nodes and never appends them, and — the amplifier — that only a *useful* stored section blocks a
  later pass.
- *every nested scroller is revealed, not only the one the walk chose* — asserts the reveal pass does
  **not** inherit `COLUMN_TEXT_SHARE`, that it still requires real range and a scrolling overflow,
  that it excludes the applicant list, that it goes innermost-first, that every region's position is
  restored in a `finally`, and that it runs *after* `revealPanelContent`.
- *a section that produced nothing prints the markup it was read from* — asserts `sectionMarkup`
  exists, is bounded, reaches the diagnostics, and that the log distinguishes not-found from
  found-but-empty.
- *the run collects every page of the applicant list* — asserts the pager is looked for when a page
  settles, the three termination bounds, that the control is classified with `inContainer` proven, that
  a disabled pager is refused, and that the denylist is consulted *before* the pagination branch.
- *the resume is opened, saved and closed without the recruiter touching a tab* — asserts the tab is
  opened through the controller, waited for, closed in a `finally` on every path, focus handed back,
  the host refusal still applied, the in-tab read used only as a fallback, that the page suspends the
  visibility rule only for the cycle and clears it in a `finally`, and that a hidden page no longer
  ends the run.

**`tests/visual-layer.test.js`**

- *a row keeps the height it was rendered at* — asserts the fixed 72px row above the card breakpoint,
  cell clipping, the line clamp, the reserved `.pv-slot` on both table pages, and that **no stylesheet
  animates a layout property** (`width` excluded: the two progress bars animate their fill, which is
  the one place a growing box is the point).

### Changed tests, and why each had to change

- The click budget for `applicants.js` moves **5 → 6** with rule 9h.
- `only ensureTab and openSavedProfilesTab may create a tab` becomes **three**, and additionally
  asserts the resume tab is inactive and untracked.
- `readExperience`/`readEducation` are now gated on whether a record **parsed**, not on how many were
  newly added, so the two tests pinning `if (added) return added;` assert `if (parsed)` instead.
- The applicant table's column order and `data-label` assertions follow the four removed columns.
- Six tests asserted the presence of explanatory prose. Each now asserts the behaviour where it is
  actually enforced — the completion policy against the tab controller, "Stop discards nothing"
  against the worker, "it never shortlists or messages" against
  `FORBIDDEN_APPLICANT_CONTROL_PATTERN` — which is a stronger claim than the sentence was.

### What only a live run can confirm (rule 17)

Local checks passed while `current_role` was empty for **four** consecutive releases, so this section
is the important one.

1. **Whether Experience and Education are now read.** `logSectionScan` answers it directly: a warning
   line naming `experience` or `education` now carries `foundIn`, `root`, `blocks`, a text sample and
   the section's real `html`. If it is still empty, that markup is the answer rather than another round
   of guessing.
2. **Whether the nested-region reveal is what was missing.** `diagnostics.regions` reports how many
   scrollable regions were found and walked, and how much they added.
3. **Whether the resume now lands and the run continues.** The cycle should be invisible: no tab
   appears in the foreground, no tab is left behind, and `logResume` reports `downloaded` with a path.
4. **Whether the list now covers every page.** `logListWalk` states rows, pages and `stoppedBy` —
   `settled` means it found no pager, `pagination-retired` means it found one that stopped helping.
5. **Whether the popup's applicant commands work from a non-hiring tab**, which is the case the
   always-visible panel newly exposes.
6. **Whether the table still shifts.** Every assertion above is a text assertion about a stylesheet;
   nothing here has been rendered in a browser.

## Automated verification - 3.7.7 the resume that downloads, the return that needs no reload, one visual language

Executed in this environment on 2026-08-03. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Command | Result |
|---|---|
| `npm test` (baseline, before any change) | 395 passed, 0 failed |
| `npm run typecheck` | clean, after each of the four tasks |
| `npm run check` after TASK-0039 | typecheck, build, **396 passed / 0 failed**, `Validated 30 build files` |
| `npm run check` after TASK-0040 | typecheck, build, **398 passed / 0 failed**, `Validated 30 build files` |
| `npm run check` after TASK-0041 | typecheck, build, **400 passed / 0 failed**, `Validated 30 build files` |
| `npm run check` after TASK-0042 | typecheck, build, **405 passed / 0 failed**, `Validated 31 build files` |
| `npm run check` after TASK-0043 (version bump) | typecheck, build, **405 passed / 0 failed**, `Validated 31 build files` |
| `node project-time-machine/scripts/status.js` | clean tree, no active task, 38 records at start |
| `node project-time-machine/scripts/audit.js` | `Time Machine audit passed. No issues found.` |

The build-file count went 30 → 31 with `theme.css`.

### New tests, and what each one actually asserts

**`tests/applicants-core.test.js`**

- *returning to a job's applicant list is an arrival; opening a row is not* — drives
  `Applicants.applicantsViewKey()` over real addresses: the live reference URL with and without an
  `applicationId` must key **identically** (opening a row is how a run advances), the same job with the
  application id in the *path* likewise, `/hiring/jobs/<id>/manage` must key **differently** from
  `/hiring/jobs/<id>/applicants`, a different job differently again, and five non-applicant addresses
  — including `/feed/`, `/my-items/posted-jobs/` and a malformed string — must key `""`, so *leaving*
  the surface is always observable.
- *an arrival survives a lost race, a back button and a bfcache restore* — asserts the arrival is
  recorded rather than consumed, that `pumpAutoRun` is a separate repeatable step with a bounded
  attempt count, that the two bails which actually happen live (list not mounted, worker asleep) do
  **not** abandon while a Stop does, that all four watchers are installed, that the `pageshow` handler
  fires only on `event.persisted` and re-derives **both** `lastKey` and `wentHidden`, that a
  re-injection removes every listener, and that the click budget is still exactly 5.
- *a viewer that never writes the address down is still read, from what it fetched* — asserts the
  resource-timing source exists, that it still decides with `Applicants.isResumeDocumentUrl`, and
  — the load-bearing one — that it **refuses to answer without a `since` floor**, that the floor is
  stamped before the click, and that it is never called without one.
- *a resume that did not land is never recorded as saved* — asserts `downloadedFilePath` reports an
  interrupted download as interrupted, that `downloadResume` answers `failed` rather than `downloaded`,
  that the page is asked for bytes exactly once (`retryFromPage: !dataUrl`), that the direct download
  is still tried first, that only `data:` bytes are accepted, that the *address* is still what the host
  and page refusals are applied to, that the content-script fetch uses `credentials: "include"` and
  refuses an HTML answer, and that `applicants.js` still contains no `chrome.downloads` outside a
  comment.
- *the popup closes itself once Collect Every Applicant has actually started* — asserts the reply is
  awaited **before** anything closes, that it closes on `started: true`, that an error keeps the window
  open and shows it, that the shared `runImport` helper never closes, and that the full-page Job
  Applicants dashboard contains no `window.close()`.

**`tests/visual-layer.test.js`** (new file, 5 tests)

- every class the four React files emit — static and the enumerated template-literal values — has a
  rule in the stylesheets that page actually loads;
- all four pages load `theme.css` and load it **before** their own sheet, no page file opens a second
  `:root` token block, and no page file names a second font stack;
- no stylesheet has `@import`, a remote `url()` or an `@font-face` (MV3 CSP), and the one `data:` URI
  is the select chevron;
- no stylesheet contains an HTML tag (comments stripped first) — the check the `</content>` bug earns;
- the wide table keeps its sticky header, its pinned name column and its `local`-attached scroll
  shadows, the card view hides the header and labels each cell from `data-label`, and those labels are
  present in both tables' markup.

### Changed tests, and why each one had to change

- *the applicants adapter clicks only its four gated controls* — the dismiss is now
  `element.click()` inside `closeOpenedOverlay` rather than `dismiss.click()`. The test additionally
  asserts that block contains **exactly one** `.click()`, so hardening the dismiss cannot quietly turn
  into clicking several controls. Total budget unchanged at 5.
- *the resume is downloaded, not previewed, whenever the page already has the address* — now asserts
  the close result is **not** discarded: the old `if (overlay) await closeOpenedOverlay(overlay)` must
  be gone and all three exits must go through `dismissResumeViewer`.
- *the resume viewer is opened, scrolled and read rather than only linked* — dropped an assertion whose
  stated intent ("opening must not be conditional on the href being missing") directly contradicted the
  3.7.7 behaviour its sibling test asserts, and which had been vacuous since two comment lines broke
  its negative regex.
- *the resume document is found wherever the viewer rendered it* — the wait now has two sources, and
  `localReference` is `actual.path`.
- *coming back to a job the recruiter collected starts that run again* — the key rule moved into the
  core and the bails now name themselves.
- *the Stop button is styled to be found* — the red is now `var(--pv-bad-lit)`/`var(--pv-bad-fill)`
  rather than a hardcoded `#b42318`, and the test asserts `.danger` is built from the **same two
  tokens**, which is a stronger claim than the hex was.
- `tests/applicant-csv.test.js` and `tests/react-architecture.test.js` — the `<th>` header parsers were
  `/<th>([^<]+)<\/th>/g` and now accept an attribute, because the name column's header carries the
  class that pins it.

### What only a live run can confirm (rule 17)

Local checks passed while the reported behaviour was broken in three consecutive releases, so this
section is not a formality.

1. **Whether the resume file now lands on disk.** The console line `[Profile Vault …] resume — <name>:
   <status>` answers it directly: `addressFrom` says `page` / `viewer-markup` / `viewer-request`,
   `refetchedFromPage` says whether the credentialed second attempt was needed, `savedAs` is the path
   Chrome actually wrote, and `reason` is why not. A warning rather than an info line means a control
   was found and no file landed.
2. **Whether the viewer now closes.** `viewerClosed: false` on that same line, plus a warning on the
   record, is what "the preview is still on screen" looks like from the outside now.
3. **Whether the resource timeline actually carries the document URL** on this account's viewer. If it
   does not, `addressFrom` will read `viewer-markup` with no URL and the status will be `link_only` —
   which is the answer, not another guess.
4. **Whether returning to the job now restarts the run without a reload**, by each of the three routes
   separately: LinkedIn's own in-app navigation, the browser Back button (the bfcache case), and
   opening the job again from another page. A refusal now says why in the console
   (`auto-restart not started: …`) instead of doing nothing.
5. **Whether the popup closes** on Collect Every Applicant, and — the case worth checking — whether it
   stays open and shows the error when no hiring tab can be resolved.
6. **Whether the redesign holds on a real screen.** Nothing here has been rendered in a browser; every
   visual assertion above is a text assertion about a stylesheet.

## Automated verification - 3.7.6 the section that was there, two resume columns, and coming back

Executed in this environment on 2026-08-03. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.6 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 390 tests, 390 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 387 tests. TASK-0033 added 2 and changed 2; TASK-0034 changed 1;
TASK-0035 added 1.

**The 3.7.5 suite passed 387 tests while `current_role`, `current_company` and `total_experience`
were empty on every row of the live run.** That is the third release in a row where it has done so,
and it is the reason 3.7.6's answer is not another selector guess but a *report*: there is no jsdom
in this repo, the fixtures are not the live DOM (rule 17), and the only place the answer exists is
the page itself. `diagnostics.sectionScan` and its console line are what make the next attempt one
reading rather than another guess.

### What the new and changed tests actually assert

| Area | Test |
|---|---|
| A title is still a title with a count after it | `a section title is still a section title with a count, a qualifier or a colon after it` — the widened `SECTION_PATTERNS`, `sectionKeyFor` stripping `(5)` / ` 5` / a trailing colon, `sectionLabelsIn` asked only for missing keys and never matching a class name, `textContent` measured before layout, and the Experience text fallback running on `added === 0` rather than only when the markup had no list items |
| An empty column must be explicable | `an empty column is explicable from the page it was read on` — `recordSectionScan` recording the selector targeted, the patterns matched against, every heading with the key it resolved to, where each section was found, its block count and the sections nothing named; recorded once after the walk, not per snapshot; logged to the page console; and one section map per snapshot shared by every reader |
| The root a heading owns | `a section outside the resolved panel is still the open applicant's` (changed) — now bounded by **every** other heading, with `DOCUMENT_POSITION_FOLLOWING` gone, because an ancestor reaching back over the section above is exactly what the widened pass refuses |
| Two resume columns | `the export leads with the applicant, and the resume is exactly two columns` (changed) — the five reduced to `resume_link` + `resume_file`, the three removed names absent, the document winning the link cell and the saved path winning the file cell, the viewer standing in when there is no document, empty staying empty, and the record still keeping all three fields apart |
| Coming back to a job | `coming back to a job the recruiter collected starts that run again` — only `COLLECT_ALL` arming and `COLLECT_CURRENT` never, both Stops disarming, the TTL, the arrival keyed on the job rather than the URL, both the poller and the injection check, the hidden-tab deferral, the options replayed, and the click budget still exactly five |

### Not run here

Everything in the 3.7.5 and earlier lists below still applies. Specifically unconfirmed for 3.7.6,
and every one of these needs a live hiring page (rule 17):

- **whether the Experience section is on that page at all.** The section search now covers a count, a
  qualifier, a colon and a non-heading title, but if the recruiter's account renders the applicant's
  history behind a tab, or does not render it on the applicants view at all, no search finds it — and
  no control on this surface may be clicked to reveal it without amending rule 9. `sectionScan.headings`
  is what answers this: a heading listed with an empty `key` is a wording to add; no Experience-like
  heading listed at all means the section is not rendered;
- whether `sectionRootFor`'s tighter bound picks the container that actually holds the cards, rather
  than one element too deep — the tests prove the rule, not the markup;
- whether `resume_link` falling back to the viewer page is what the recruiter wants in that cell, or
  whether an empty cell would say more than a link that opens the applicants page again;
- whether returning to a job restarts the run in practice — the LinkedIn SPA may reuse the content
  script or re-inject it, and only one of those paths can be exercised here;
- whether a restart that skips everyone already collected reads as "it did nothing" — with
  `Re-collect already saved` unticked and a job already fully collected, the restart is correct and
  invisible;
- whether twelve hours is the right life for an armed job.

## Automated verification - 3.7.5 an applicant command takes you to the page

Executed in this environment on 2026-08-02. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.5 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 387 tests, 387 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 383 tests. TASK-0032 added 4 and changed 1.

### What the new tests actually assert

| Area | Test |
|---|---|
| Focus is for commands only | `a direct command focuses the window; the background run still never does` — the default unchanged, `focusWindow: true` raising the window, and a minimized window restored on the way |
| One hiring tab, in the right window | `the hiring tab is opened once, in the origin window, and reused after that` — created in the home window and painted, reused on the second command with no second tab, never navigated when already on the page, and **not** closed by `closeCollectorTabs()` |
| A tab the user opened is adopted | `a hiring tab the user opened themselves is adopted rather than duplicated` — and a missing id remembers nothing |
| The worker takes them there | `the applicant commands take the recruiter to the page instead of refusing` — the remembered URL reopened through the controller and waited for, the honest error when nothing is remembered, only a real hiring address remembered, `rememberOrigin` before any tab is opened on both commands, and the sender reaching the handler |

### Not run here

Everything in the 3.7.4 and earlier lists below still applies. Specifically unconfirmed for 3.7.5:

- that Chrome actually raises and focuses the window from a service worker in this situation — a
  `windows.update({ focused: true })` from a background context is honoured in normal use but is not
  something the fake window in the tests can prove;
- that the recruiter *wants* the window raised rather than finding it intrusive;
- that the remembered applicants URL still resolves to the same job later — LinkedIn's
  `applicationId` in that address points at one application, so a reopened tab may land on a different
  applicant of the same job than the one that was last open. The run reads the list, not that
  applicant, so this should not matter, and it is listed here because it has not been seen live.

## Automated verification - 3.7.4 the whole panel however it scrolls, and the resume in full

Executed in this environment on 2026-08-02. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.4 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 383 tests, 383 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 380 tests. TASK-0029 added 3; TASK-0030 changed two existing CSV tests
rather than adding any.

**Reported live, immediately after 3.7.3.** 3.7.3 fixed the scroll *target* and the run's ability to
restart and resume; `current_role`, `current_company` and the resume file were still empty on every
row afterwards. So the target was not the only cause, and 3.7.4 stops depending on identifying it.

### What the new tests actually assert

| Area | Test |
|---|---|
| The bottom is reached regardless | `the bottom of the panel is reached without knowing which container scrolls` — `scrollIntoView` rather than a position, growth meaning new content, both bounds, `assertRunnable`, running before the second expander pass, and the page's own scroll position restored |
| A missing section is still found | `a section outside the resolved panel is still the open applicant's` — the page-wide fallback, only when a section is actually missing, never a heading or root inside the applicant list, and a root swallowing a second section refused |
| The document is found and waited for | `the resume document is found wherever the viewer rendered it` — the attribute list, viewer → panel → page ordering, the tested `isResumeDocumentUrl` as the only decider with no second local copy, the full-timeout wait, and `localReference` being the path rather than the download id |
| The resume is five columns | `the export leads with the applicant, and the resume is a column of the table` — the eight leading columns, each of the three resume links reading its own field, and a viewer-only record still exporting the link it has |

### Not run here

Everything in the 3.7.3, 3.7.2, 3.7.1 and 3.7.0 lists below still applies. 3.7.4 has **not** itself
been run live. Specifically unconfirmed:

- that `scrollIntoView` on the panel's last rendered element actually causes LinkedIn to mount the
  sections below the fold, rather than the surface using a virtualizer that needs a scroll *event*;
- that the page-wide section fallback finds Experience and Education on this account's layout, and
  that neither is inside a container that also holds another section (in which case it is correctly
  refused and the columns stay empty);
- that the resume viewer exposes a `licdn.com` / `/dms/` document address in **any** of the searched
  attributes — if it renders the file into a `canvas` with no URL anywhere, `link_only` remains the
  honest answer and `resume_link` stays empty while `resume_viewer` fills in;
- that a downloaded file lands where `localReference` now says it does;
- that the per-applicant time is still acceptable: the reveal pass adds up to 40 further DOM-quiet
  waits per applicant, on top of the position walk.

## Automated verification - 3.7.3 the applicant collector reads the whole column and resumes

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.3 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 380 tests, 380 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 373 tests. TASK-0026 added 3, TASK-0027 added 4.

**All three defects were reported live, not found here.** The 3.7.2 suite passed 373 tests while the
collector was reading one screenful of every applicant, refusing to start again after a stop until
the page was reloaded, and re-collecting the whole list from the first row. That is the standing
phase-30 warning doing exactly what it is for.

### What the new tests actually assert

| Area | Test |
|---|---|
| The column, not the page | `the column that scrolls is the panel's own, never the page around it` — the page refused however much range it has, an element that cannot move refused, a scroll box carrying a filter refused, innermost wins, and a `containsList`-only descriptor still works |
| The panel is never stale | `the panel is re-resolved and the whole column is walked, not one screenful` — `livePanel()` on every read, the target re-chosen after the first paint, the viewport read live, the second expander pass, and the shared eight-click budget |
| Both sides of the scroller | `a scroll box inside the panel is offered as well as every ancestor` — descendants offered, the 60 % text share required, and `carriesContent` saying what `containsList` cannot |
| A run can be restarted | `a stopped run can be started again without reloading the page` — `beginRun()` re-deriving the hidden flag, the old `state.aborted = false` alone being gone, the hiring tab revealed before either command and through the controller, and `alreadyRunning` for a second press |
| A run resumes | `a run resumes over the applicants it has not collected yet` — the collected index asked of the worker, `recollect` forcing a full pass, the decision made from the row's href before anything is opened, one collected in this run added to the index, an unreachable worker skipping nobody, and a lean reply |
| What counts as collected | `only a record carrying something counts as collected` — every substantive field, and a name-only record explicitly **not** collected |
| Skipping is scoped | `a run knows who is already saved and walks past them` — the id winning over the name, another job's record not skipping this job's row, the name standing in only for a row with no id, and the lean worker entry |

### Not run here

Everything in the 3.7.2, 3.7.1 and 3.7.0 lists below still applies. 3.7.3 fixes what one live run
exposed; it has **not** itself been run live. Specifically unconfirmed:

- that the applicant panel's real scroller is an ancestor-or-self of, or a ≥60 %-text descendant of,
  whatever `applicantPanel()` resolves to on this account's layout — if it is neither, the fallback
  still hands back the page and the walk is no better than 3.7.2's;
- that the detail column's `overflow-y` is a computed `auto`/`scroll`/`overlay` rather than a
  transform- or `position`-driven scroll that reports `visible`;
- that scrolling the column actually mounts the Experience and Education sections, rather than them
  being absent for this account for a different reason;
- that the applicant list keeps loading past ~17 rows toward the advertised 665 once the column
  itself is the thing being scrolled;
- that `Tabs.activate` on the hiring tab is enough to make LinkedIn render it again promptly, and
  that activating it is acceptable behaviour to the user rather than an unwanted tab switch;
- that the `applicationId` in a list row's href is the same id the stored record carries, on this
  account's URL scheme — if it is not, the resume check silently skips nobody and the run repeats
  itself exactly as before.

## Automated verification - 3.7.2 three defects found in a live run

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.2 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 373 tests, 373 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 364 tests. TASK-0023 added 7, TASK-0024 added 2.

**These three defects were found live, not here.** That is the point of the standing phase-30 warning:
the 3.7.1 suite passed 364 tests while every applicant was being saved with the name "Applicants",
every applicant after the first was read from the previous one's panel, and the service worker was
downloading an HTML page and recording it as somebody's CV. The tests below are the ones that would
have caught them.

### What the new tests actually assert

| Area | Test |
|---|---|
| Chrome is not a name | `page chrome is never saved as somebody's name` — the 20 labels on this screen, including `Applicants` itself, plus real names, addresses, counts and sentences |
| The platform names the applicant | `the platform's own explanation sentences say who the applicant is` — the shared leading words, a shared verb excluded, one sentence proving nothing, disagreeing sentences, and shared chrome refused |
| Corroboration wins | `the name the explanations agree with wins over the name the markup offered` — including a name the markup never offered, and an empty result rather than a guess |
| The name may be upgraded once | `a corroborated name replaces a guessed one, and nothing replaces a corroborated one` — and every other header field stays first-wins |
| The panel excludes the list | `the detail panel can never be a container that holds the applicant list` — the row-link refusal and the non-`document.body` fallback |
| The name is policy-driven | `the applicant's name is chosen by policy, corroborated by the platform's own prose` — every candidate source, the `applicationId` row match, and qualifications read before the header |
| The panel must have changed | `the next applicant is only scanned once the panel is showing them` — the fingerprint wait, the forbidden `location.href` wait, and a row that never opened being skipped |
| A page is not a file | `a LinkedIn page is never stored or downloaded as a resume` — four routes refused, four documents accepted, and a page arriving on `url` moved to `viewerUrl` |
| Both layers refuse it | `the adapter and the worker both refuse a page route as a resume` — and the page check runs before anything is fetched |

### Not run here

Everything in the 3.7.1 and 3.7.0 lists below still applies. 3.7.2 fixed what one live run exposed; it
has **not** itself been run live. Specifically unconfirmed:

- that `applicantPanel()` now resolves to the detail column on this account's layout, rather than to
  some other non-list container;
- that the list row for the current `applicationId` is findable, and that its first line is the name;
- that `panelIdentity()` actually changes when LinkedIn swaps applicants, and within 12 seconds;
- that a live resume viewer exposes a `licdn.com`/`/dms/` document URL at all — if it does not, every
  resume will now correctly report `link_only` rather than incorrectly report `downloaded`.

## Automated verification - 3.7.1 both contact details, the resume viewer, the applicant-first export

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.1 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 364 tests, 364 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 357 tests. TASK-0019 added 2, TASK-0020 added 2, TASK-0021 added 3.

### What the new tests actually assert

| Area | Test |
|---|---|
| A panel we opened yields everything in it | `a panel the extension opened itself yields every address and number in it` — an unlabelled number is taken inside it, the rendered page is unchanged outside it, and the vanity-URL id, a follower count and a date range are **still refused** inside it |
| Both scripts mark their own panel | `both content scripts mark their own opened panel as trusted` — and no `already-visible` skip survives |
| The overlay is never skipped | `the contact overlay is opened after the page has settled, on every profile` — the old `counts.emails > 0 && counts.phones > 0` guard is forbidden from returning |
| The resume viewer is really opened | `the resume viewer is opened, scrolled and read rather than only linked` — clicked unconditionally, scrolled with the position restored in a `finally`, details read from the viewer, viewer name beats the URL, closed again, and `pages` null when the viewer said nothing |
| The list is loaded first | `the applicant list is scrolled to the bottom before a run over it starts` — growth means new rows, quiet-pass and max-pass bounds, DOM-quiet wait, Stop honoured, scroll restored |
| The export leads with the applicant | `the export leads with the applicant, and the resume is a column of the table` — first six columns fixed, `job_title`/`location` absent, `job_id` retained |
| Every value is exported | `every address and every number reaches the file, not only the primary two` — per-entry text marking, and a duplicate primary/extra is not exported twice |
| Total experience computes | `total experience is computed, including from the applicant card's spaceless range` — the `{ dates }` defect, the spaceless `2026-Present` form, the untouched spaced form, `3-5 years` still not a range, internships excluded |

### Not run here

Everything in the 3.7.0 "Not run here" list below still applies unchanged — the hiring surface has
still never been run against a live recruiter account from this environment. 3.7.1 adds two more that
only a real browser can settle:

- whether a live `Contact info` overlay and a live applicant contact disclosure actually contain both
  the address and the number as plain text, and therefore whether the `trusted` read collects them;
- whether the live resume viewer exposes a file name and a page count in its own chrome at all, and
  whether it is the element `chooseScrollTarget` picks.

## Automated verification - 3.7.0 applicant collector, applicant CSV and universal Stop

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — no errors |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.7.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 357 tests, 357 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 30 build files, 4 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 313 tests. TASK-0015 added 24 (23 new plus one v5 migration test),
TASK-0016 added 11, TASK-0017 added 9.

### What the new tests actually assert

| Area | Test |
|---|---|
| The core stays pure | `the applicants core stays an export-free, DOM-free, framework-free IIFE` — no `document`/`window` anywhere in the file, comments excluded |
| The job and applicant are read, not guessed | `the job and the applicant are read out of the address bar, never guessed` — the screenshot's own URL, the path form, and a bare `/hiring/` yielding `null` |
| ATS actions are refused first | `every control that acts on the applicant is refused before any allowlist` — 14 labels × every purpose, plus `Message · Contact info` and an `aria-label` that says it when the text does not |
| A control must be proven inside its container | `a disclosure control is only allowed when it is proven inside its container` |
| Verdicts are stored as displayed | `a qualification is stored exactly as the platform displayed it` — matched / unknown / not-matched, the source note, the icon beating the wording, and a blank never reading as a pass |
| Screening answers stay separate | `a screening response keeps the question, the ideal answer and the answer apart` — `met` is `null` when the platform did not say |
| Collapsed metadata still splits | `an experience card splits into role, employer and dates even with no separator` |
| Education keeps the degree | `education keeps the degree, which the connections record deliberately drops` |
| Job and applicant headers | `the job header reads the title and the applicant count off the screen`, `the applicant header strips the badges and never reads the timeline as a status` |
| Absent means null | `an absent value is null, never an empty string and never a guess` — plus the specified schema key for key, and idempotence |
| Record identity | `the same applicant on two different jobs is two different records` |
| Merge is enrichment | `re-collecting an applicant enriches the record and never re-downloads the resume` |
| The accumulator is merge-only | `the accumulator is merge-only, so a section scrolled past is not lost` |
| The job carries its own requirements | `the finished record carries the job's requirements as well as the verdicts` |
| Stop is checked per item | `Stop takes effect before the next applicant, not at the end of the list` |
| The adapter's click budget | `the applicants adapter clicks only its four gated controls` (exactly five `.click()` sites, four gated) |
| The adapter's scan discipline | `the applicants adapter stays framework-free and restores the scroll position`, `the panel is walked to the bottom before any overlay is opened` |
| Failure isolation | `the panel is walked to the bottom before any overlay is opened` also asserts `attempt(` and `addWarning(` exist — a failing section is a warning, not the end of the run |
| Streaming saves | `each finished applicant is persisted immediately, not at the end of the run` |
| Resume safety | `the resume is fetched by the worker, only from LinkedIn, and only once` — non-LinkedIn host refused, already-downloaded skipped, `saveAs: false`, `conflictAction: "uniquify"`, and no `chrome.downloads` in the content script |
| Manifest scope | `the hiring surface is a content script entry scoped to LinkedIn hiring pages` — and no new permission |
| Migration | `the v5 upgrade adds the applicant stores without disturbing the existing ones` — no `deleteObjectStore` |
| CSV safety | `the applicant CSV is UTF-8, quoted, CRLF and formula-safe`, `a phone number survives a spreadsheet round trip` |
| Table and CSV agree | `the CSV columns start with the applicants table, column for column` |
| One implementation of the escaping | `the applicant export shares the connections export's safety rules rather than copying them` |
| Cell formatting | `a qualification cell says the verdict, the requirement, the reason and the source`, `screening, experience, education and resume cells read as sentences` |
| Sparse and empty exports | `an applicant with nothing but a name still exports a full, empty row`, `an empty export is refused rather than producing a header-only file` |
| The page | `the applicants page is a React TypeScript entry point with no hooks`, `the applicants page offers every control the surface needs`, `the applicants page is reachable and loads React locally` |
| Stop is unconditional | `the popup's Stop is always rendered and never behind a state check` — and the old `{running \|\| cooling \|\| discovering ? …}` guard is forbidden from returning |
| Stop is universal | `the popup's Stop sends the universal message, not the import one`, `the worker's Stop ends work in flight, in every tab, and discards nothing`, `the broadcast reaches every LinkedIn tab and survives a tab with no listener` |
| Stop is per step | `all three content scripts stop at their next step, not at their next item` |
| Stop is not a failure | `a stop is reported as an interruption, never as a failed record` |

### Not run here

**Phase 30 — live browser verification is still open, and it matters more than usual for 3.7.0.**
Nothing below has been run against a live recruiter account from this environment. The hiring adapter
was written against two screenshots of one account's applicants view; fixtures and unit tests do not
prove live correctness (rule 17). Specifically unconfirmed:

- that `applicantPanel()` and `applicantList()` pick the right two columns on a live hiring page, and
  that the detail panel — not the document — is the element that actually scrolls;
- that the qualification and screening blocks resolve to `<li>` elements rather than falling through
  to the text fallback, and that the verdict icon exposes an accessible name at all;
- that the applicant's contact control is a disclosure and not a send action on this account's
  LinkedIn — the denylist refuses anything that says message, send or InMail, so the failure mode is
  "no contact details collected", but that has not been observed live;
- that a live resume URL is reachable by `chrome.downloads` with the recruiter's session, and what
  `downloadStatus` a real attempt produces;
- that "Collect Every Applicant" advances correctly through a virtualized list of hundreds;
- that schema v5 upgrades a real pre-3.7.0 IndexedDB store without disturbing saved profiles.

## Automated verification - 3.6.0 contact provenance and the reduced record

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — `TypeScript: No errors found` |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.6.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Tests | `npm test` | **Pass** — 313 tests, 313 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 23 build files, 3 React entry points, and service-worker imports.` |
| Whole gate | `npm run check` | **Pass** — all four of the above, in order |

Baseline before this work: 283 tests. TASK-0013 added 12, TASK-0014 added 18.

### What the new tests actually assert

| Area | Test |
|---|---|
| A vanity URL's member id is not a phone number | `digits taken from a LinkedIn URL are never a phone number` — covers the four reported live slugs, plus `normalizePhone` on a bare slug and on a path |
| Identifiers are not phone numbers | `an identifier welded to a word is not a phone number` |
| Real numbers still survive the scrubbing | `a real number still survives everything the scrubbing removes` |
| The Interests block contributes nothing | `an address or number in running text is not a contact detail` — built from the reported Top Voices card |
| A value needs a label | `a value is taken only from the field that says what it is`, `a label carrying its value on the same line is read too` |
| The page may give an address, never a number | `the rendered page may contribute an address but never a number` |
| `tel:`/`mailto:` carry their own provenance | `a tel: or mailto: link always carries its own provenance` |
| content.js routes through the policy | `the rendered page is never swept for phone numbers, and never for other people` |
| Records already saved are cleaned | `a number that is really the profile's own URL is dropped from records already saved`, `one stranger's details spread across many profiles can be found and removed`, `the saved-profiles page repairs stored records and offers the shared-value cleanup` |
| Open-to-work parsing | `the open-to-work panel is read field by field`, `the panel becomes one labelled line per field that carried a value`, `an unrecognised heading closes the field rather than swallowing the next block` |
| Only that card's Show details may be clicked | `only the Open to work card's own Show details may be clicked`, `the open-to-work step is gated, waited for, and closed again` |
| Still nothing else is clicked | `profile extraction still clicks nothing else at all` (exactly three `.click()` sites), `the profile script clicks only its two gated controls and rejects non-profile context` |
| Education deduplication | `education keeps unique institution names in the order the page rendered them`, `roles at one company group into a single card and education groups per institution` |
| Skill-noise filtering | `skill noise is refused and real skills are kept`, `accessibility text duplicated by LinkedIn collapses to one skill`, `skills accumulate across the whole scroll rather than being replaced` |
| Full-page incremental extraction | `nothing is built until the page has been walked to the bottom and settled` |
| The reduced record | `the stored record is the name, the ways to reach the person, and what they can do`, `a profile that rendered none of the priority fields is partial, not failed`, `a CV that is a hosted page has no file name, and the record says so`, `the fields 3.6.0 retired are gone from the record` |
| Table and CSV agree | `the saved-profiles table shows the specified columns in the specified order`, `the CSV columns are the table columns`, `the CSV is the table, column for column` |
| CSV behaviour | `a profile survives a CSV round trip with every stored field intact`, `a mobile number is exported as text and never as a number`, `an empty value stays empty and Unicode survives the round trip`, `no cell can ever read [object Object]`, `a CSV written by 3.5.0 still imports`, `CSV round trip preserves every institution and every skill` |
| Migration | `the import queue uses the existing database under a new schema version` (v4), `the v4 upgrade indexes what the record now has and retires what it does not` |

### Not run here

**Phase 30 — live browser verification is still open.** Nothing in 3.6.0 has been run against live
LinkedIn from this environment. Fixtures and unit tests do not prove live correctness (rule 17), and
the following can only be confirmed in a real browser:

- that the Open to work card and its own `Show details` are found on a live profile, and that no
  other `Show details` is ever the one clicked;
- that a live Contact info overlay's `Phone` heading matches `CONTACT_FIELD_LABELS` for this account's
  LinkedIn locale — if it does not, the number is left empty rather than guessed;
- that the reduced record and the new table render correctly against real data;
- that `repairStoredProfiles()` migrates a real pre-3.6.0 IndexedDB store.

## Automated verification - 3.5.0 two-tab collector workflow

Executed in this environment on 2026-08-01. Every row below is a command that was actually run here
and the output it actually produced. Nothing in this section was inferred.

| Check | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | **Pass** — `TypeScript: No errors found` |
| Build | `npm run build` | **Pass** — `Built Profile Vault React 3.5.0 into dist` |
| Full test suite | `npm test` | **Pass** — 269 tests, 269 pass, 0 fail |
| Build validation | `npm run validate` | **Pass** — `Validated 23 build files, 3 React entry points, and service-worker imports.` |
| Whole pipeline | `npm run check` | **Pass** — typecheck -> build -> test -> validate, all green |
| New tab-workflow suite | `node --test tests/collector-tabs.test.js` | **Pass** — 20 tests, 0 fail |
| New contact/CV suite | `node --test tests/contact-extraction.test.js` | **Pass** — 28 tests, 0 fail |

### The eight required tab behaviours, and the test that proves each

All in `tests/collector-tabs.test.js`, driven against a fake Chrome (`fakeChrome()`) that records
every `tabs.create` / `tabs.update` / `tabs.remove` / `windows.update` call.

| Required behaviour | Test | Result |
|---|---|---|
| Start Full Collection activates the Connections tab | "Start Full Collection opens the Connections tab in the same window and activates it" | **Pass** |
| Discovery completion opens and activates the profile collector tab | "discovery completing opens and activates a separate profile collector tab" | **Pass** |
| Only one profile collector tab exists | "only one profile collector tab is ever created, however many times it is ensured" | **Pass** |
| The same tab is reused for every profile | "every profile in the queue is loaded into the same reusable tab" | **Pass** |
| Hidden collector tabs pause without saving partial data | "a hidden collector pauses the run and writes no profile" + "the worker refuses to save a profile read from a tab that went hidden" | **Pass** |
| Returning to the collector tab resumes extraction | "a hidden pause resumes automatically, and into the half of the run it left" + "returning to the collector tab makes it renderable again and resume is driven by tab events" | **Pass** |
| Queue completion activates the Saved Profiles table | "queue completion closes both collector tabs and activates the Saved Profiles table" | **Pass** |
| No processing continues after completion | "no work continues once the run reaches a terminal state" + "the worker stops its alarms and its loop when the queue finishes" | **Pass** |

Additional guards verified in the same run:

- "the automatic workflow performs the steps in the order the design requires" — asserts the literal
  order of `opening_connections` -> login check -> Connections tab -> `discovering_connections` ->
  `runDiscovery` -> `connections_complete` -> `opening_profile_collector` -> `ensureProfileTab` ->
  `startSession` -> `extracting_profile` -> `kickLoop` inside `startCollectingWorkflow`. **Pass**
- "connection discovery hands over to profile extraction automatically" — asserts the hand-over is a
  legal transition and that `stopped -> extracting_profile` is not. **Pass**
- "the service worker creates collector tabs only through the tested controller" — asserts
  `chrome.tabs.create` and `chrome.windows.create` appear nowhere in `src/background.ts` outside the
  injected dependency object. **Pass**

### Contact details, CV, and the amended control policy

| Claim | Test | Result |
|---|---|---|
| A date range is never saved as a mobile number | "a date range, a count, and a placeholder are never saved as a mobile number" | **Pass** |
| Two renderings of one number merge, keeping the fuller form | "two renderings of one number are stored once, keeping the fuller form" | **Pass** |
| A CV is recognised by label, URL, file type, or host | "a link is a CV when its label, its URL, its file type, or its host says so" | **Pass** |
| `Contact info` is clickable; everything else on the denylist is not | "Contact info is now clickable, and nothing else on the denylist is" | **Pass** |
| The denylist still beats the contact allowlist | same test — "Message · Contact info" is refused | **Pass** |
| Profile extraction clicks exactly twice (open + dismiss) | "profile extraction still clicks nothing else at all" | **Pass** |
| Contact details survive a section unmounting mid-scan | "contact details survive a section being unmounted mid-scan" | **Pass** |
| A late contact detail restarts the quiet count | "a contact detail arriving late stops the scan settling too early" | **Pass** |
| The removed fields are gone from the record | "headline, location, about, certifications and languages are no longer stored" | **Pass** |
| The CSV leads with the CV and drops the removed columns | "the CSV leads with the CV and no longer carries the removed columns" | **Pass** |
| A profile survives a CSV round trip | "a profile survives a CSV round trip with its contact details intact" | **Pass** |
| No credential is ever touched | "the extension still never touches a credential" | **Pass** |

### Not verified here

**Phase 30 (live browser verification) remains open.** Nothing in 3.5.0 has been run against live
LinkedIn from this environment. In particular these are *unverified assumptions* until someone loads
`dist/` in Chrome and watches a real run:

- that LinkedIn's `Contact info` control matches `CONTACT_CONTROL_PATTERN` on the account in question;
- that the opened overlay matches `findContactDialog()`'s selectors;
- that Escape dismisses that overlay;
- that a Featured-section document is reachable as an ordinary `<a href>`;
- that the two collector tabs behave as expected under Chrome's real background-tab throttling.

Fixtures are not the live DOM. Do not record a live result in this file that was not observed live.

## Automated verification - 3.4.0 live-defect fixes (restored under Project Time Machine)

Executed in this environment on 2026-08-01. Each row is a command that was run and the output it
produced. This release was re-applied task-by-task after an external revert removed most of the
3.4.0 source; every step below is now a Time Machine task with its own commit and annotated tag.

| Check | Command | Result |
|---|---|---|
| State after the revert | `npm test` | 196 tests, 0 failures - the 3.3.0 suite; `tests/live-regressions.test.js` was gone |
| TypeScript strict type check | `npm run typecheck` | PASS - no output |
| Production build | `npm run build` | PASS - `Built Profile Vault React 3.4.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Full suite after the restore | `npm test` | PASS - **219 tests, 0 failures** |
| Build validation | `npm run validate` | PASS - 22 build files, 3 React entry points, worker imports |
| Whole workflow | `npm run check` | PASS - exit 0 |
| Time Machine audit | `node project-time-machine/scripts/audit.js` | PASS - no issues |

### The restore, task by task

| Task | What it restored | Suite after |
|---|---|---|
| TASK-0001 | Parser field boundaries: `stripEntityMeta`, `sanitizeCompanyName`, `sanitizeRoleTitle`, `isSkillValue`; skills read from the card heading | 196 |
| TASK-0002 | Untracked `dist/` and `.build/` (derived output) | 196 |
| TASK-0003 | `COLLECTION_STATE`, bounded discovery, `accountedFor`/`gap`, visibility pause, matching types | 197 |
| TASK-0004 | Visibility gating in both content scripts | 197 |
| TASK-0005 | `prepareCollectorStep`, hidden-page pause and resume, bounded drain, terminal state, collector diagnostics | 197 |
| TASK-0006 | Importer toolbar + Advanced area, one session component, state and gap pills, navigation labels | 196 |
| TASK-0007 | `tests/live-regressions.test.js` - 23 tests | 219 |
| TASK-0008 | Build id 3.4.0 in all five places, CLAUDE.md and this file | 219 |

Three previously passing tests encoded behaviour that *caused* the live bugs and were rewritten to
the corrected contract, with the reason recorded in each test:

| Test | Why it changed |
|---|---|
| `growth or a pagination click resets the quiet counter` | Counting a click as growth is defect 3. It now asserts a click that reveals nothing is **not** progress, and a sibling test asserts a dead control stops keeping discovery alive. |
| `the loop reveals more connections when the queue drains` | Now asserts the drain loop is bounded and lands in a terminal state. |
| `the connections page exposes every required control` | The button set and the single session component are new requirements. |

### Behavioural spot-checks run directly against the cores

| Assertion | Result |
|---|---|
| `TechMatrix Consulting 9 mos` -> company `TechMatrix Consulting`, title unaffected | PASS |
| `Full-time`, `9 mos`, `Remote`, date ranges rejected as companies | PASS |
| `Endorse` and `Associate Software Engineer at TechMatrix Consulting Endorse` rejected as skills | PASS |
| 67 reported / 66 usable / 1 unusable -> `accountedFor` 67, `coverageConfirmed` true, `exhausted` true, `gap` 1 | PASS |
| `terminalStateFor` -> `completed_with_gap` with a gap, `completed` without | PASS |
| A dead pagination control exhausts discovery | PASS |
| The drain loop gives up after 3 fruitless attempts | PASS |
| Repeat and skip-ahead transitions refused; `ready_to_extract -> extracting` allowed | PASS |
| A visibility pause claims no work and can resume itself; a challenge pause cannot | PASS |

### Built `dist/` inspected directly

| Assertion | Observed |
|---|---|
| `dist/build-meta.json` | `{ "version": "3.4.0", "buildId": "2026-08-02-react-v3.4.0" }` |
| `chrome.windows.create` / `chrome.tabs.create` in the worker | **1** / **0** |
| Worker foreground + state machine | `prepareCollectorStep`, `pauseForHiddenCollector`, `collectorIsRenderable`, `moveCollectionTo`, `shouldContinueAutoDiscovery`, `terminalStateFor`, `collectorDiagnostics` all present |
| Both content scripts gate on visibility | `document.visibilityState === "visible"` present in `dist/connections.js` and `dist/content.js` |
| Saved-profiles `<tbody>` | uses `summarizeExperience` / `summarizeEducation`; contains **no** `ExperienceCards` or `EducationCards` |

### What these results do NOT prove

No test here touches live LinkedIn, and the visibility behaviour in particular is asserted at the
source and state-machine level - Node cannot produce a real hidden tab. **Phase 30 remains open.**

---

## Automated verification — 3.3.0 automatic collector workflow

Executed in this environment on 2026-07-31. Nothing below is inferred; each row is a command that was
run and the output it produced.

| Check | Command | Result |
|---|---|---|
| Baseline before this work | `npm test` | PASS — 167 tests, 0 failures |
| After the contract change, before the tests were updated | `npm test` | **FAIL — 3 of 167**, exactly the three tests whose contract this release changes (`Start Extraction` renamed, popup one-click semantics, connections-page control list) |
| TypeScript strict type check | `npm run typecheck` | PASS — no output |
| Production build | `npm run build` | PASS — `Built Profile Vault React 3.3.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Full suite after the change | `npm test` | PASS — **196 tests, 0 failures** |
| Build validation | `npm run validate` | PASS — 22 build files, 3 React entry points, service-worker imports |
| Whole workflow | `npm run check` | PASS — exit 0 |

### Built `dist/` inspected directly (not via the validator)

| Assertion | Observed |
|---|---|
| `dist/build-meta.json` | `{ "version": "3.3.0", "buildId": "2026-08-02-react-v3.3.0" }` |
| Build ID occurrences in `dist/` | 5, all `2026-08-02-react-v3.3.0` (content.js, connections.js, background.js, popup.js, build-meta.json) |
| `chrome.windows.create` in `dist/src/background.js` | **1** — the only place a collector surface is ever created |
| `chrome.tabs.create` in `dist/src/background.js` | **0** — no second processing tab can be opened |
| `dist/src/connections-core.js` emitted and reachable by the worker | present, 28.6 KB, exports `classifyAuthState`, `createCardLedger`, `reconcileDiscovery` |
| Worker ESM imports resolve from `dist/src/` | `./messages.js`, `./import-queue-core.js`, `./queue-db.js`, `./db.js`, `./profile-utils.js`, `./connections-core.js` all present |

### What the 23 new tests in `tests/collector-workflow.test.js` cover

| Requirement | Test |
|---|---|
| A 67-card fixture reconciles all 67 | `a 67-card list reconciles as 66 usable, 1 without a URL, and 3 duplicate links` — 66 unique URLs + 1 restricted card = 67 accounted for, `unexplained === 0` |
| Virtualized re-renders never inflate counts | `re-reading the same virtualized cards does not inflate any count` — five scans over the same window keep `cardsSeen === 67` |
| An early stop is never mistaken for success | `an unaccounted-for remainder is called out instead of looking like success` |
| Discovery stops automatically | `discovery over a list that never grows stops on its own in a bounded number of steps` |
| No infinite loops | `a pass can never run past its step budget`, `the worker bounds its own discovery passes and honours an abort` |
| Start Collecting → login → Connections → discover → extract | `Start Collecting checks the session, redirects to Connections, discovers, then automatically starts extraction` (asserts the *order* of the three steps in the workflow function) |
| No multiple collector tabs | `the collector tab is redirected to the Connections page rather than a second tab being opened` — exactly one `chrome.windows.create`, zero `chrome.tabs.create` |
| Queue continues after the popup closes | `the queue keeps running after the popup and importer page are closed` + the detached-reply assertion |
| Clear Queue keeps saved profiles | `Clear Queue empties the queue and its counters without touching saved profiles`, `a cleared queue cannot claim the work it used to hold` |
| Manual discovery and manual extraction still work separately | `manual discovery saves the list without starting any extraction`, `manual extraction runs over the saved queue without re-enumerating the list` |
| Login states | four auth tests: signed in, login wall (URL and text), checkpoint/CAPTCHA, and "unknown" never upgraded to signed in |
| No credential handling | `Sign in only ever opens LinkedIn'''s own page and no credential is handled` — greps every UI and content file for password inputs, `document.cookie`, and `chrome.cookies` |
| The previous page'''s load is not mistaken for the new one | `navigation waits for the new page, not the previous page'''s completed status` |

Pre-existing coverage that still passes unchanged: 10 initial connections expanding to the full list,
35-card virtualized accumulation, Load more / Next pagination, profile top/middle/bottom sections
surviving to the saved record, and single-profile extraction.

### What these results do NOT prove

No test here touches live LinkedIn. Fixtures are not the live DOM, and 196 passing tests say nothing
about whether the live account'''s Connections page yields its whole list. **Phase 30 remains open and
can only be closed by loading `dist/` in Chrome against a signed-in account.**

---

## Automated verification — scroll-container detection (second live report)

Executed in this environment. Nothing below is inferred.

| Check | Command | Result |
|---|---|---|
| Baseline before this work | `npm test` | PASS — 132 tests, 0 failures |
| New regression suite, before the fix | `node --test tests/lazy-dom-regression.test.js` | **FAIL — 26 of 32 failing**, as intended |
| TypeScript strict type check | `npm run typecheck` | PASS — no output |
| Production build | `npm run build` | PASS — `Built Profile Vault React 3.2.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Full suite after the fix | `npm test` | PASS — **167 tests, 0 failures** |
| Build validation | `npm run validate` | PASS — 22 build files, 3 React entry points, worker imports |
| Whole workflow | `npm run check` | PASS — exit 0 |

### What the 35 new tests in `tests/lazy-dom-regression.test.js` cover

They drive the real policy functions over a simulated LinkedIn page that models the live failure:
`<html>`/`<body>` pinned with `overflow: hidden`, an ancestor wrapper that scrolls, a decoy scrollable
filter panel inside the list, virtualized rows, and lazy chunks.

| Requirement | Test |
|---|---|
| Scroll container above the list | "the scroll container is found when LinkedIn scrolls a wrapper above the list" |
| Decoy panel rejected | "a tall scrollable panel that does not contain the list is never used as the scroller" |
| Reproduces the live bug | "the old descendant-only scroll heuristic is what limited discovery to the first slice" |
| 10 visible + 25 while scrolling | "10 initially visible connections plus 25 loaded while scrolling are all discovered" |
| 35 virtualized, old cards removed | "a 35-connection virtualized list keeps the cards LinkedIn removed from the DOM" |
| Load more control | "a Load more control is used to reach every page of a paginated list" — 137 at 50/page |
| Next-page control | "a Next-page control is followed across several Connections pages" — 120 at 40/page |
| Forbidden controls | "only allowlisted Load more / Next controls may ever be clicked" — 16 denylisted labels |
| Five quiet scans | "discovery finishes only after five consecutive scans find nothing new" |
| Duplicate + non-profile links | "duplicate profile URLs and non-profile links never enter the discovered list" |
| Persistent accumulation | "the accumulator is never replaced by the currently rendered batch" |
| Resume after interruption | "discovery resumes from its persisted cursor after an interruption" |
| Save during discovery | "new connections are persisted as they are found, not only at the end" |
| Extension-side pagination | "the React list pages through every discovered connection regardless of LinkedIn's page size" |
| Sections only after scrolling | "profile sections that render only after scrolling are all captured" |
| Sections removed later | "profile sections unmounted by later scrolling stay in the saved record" |
| Grouped company / institutions | "roles at one company group into a single card and education groups per institution" |
| Dedup keys | "entity dedup keys are exactly the ones the requirement specifies" |
| Late hydration | "a later, fuller read of the same entity enriches it instead of being discarded" |
| Never guess | "a missing value stays empty and is never guessed" |
| Save only after full scroll | "the profile is only complete after the bottom stops producing new entities for five scans" |
| Scroll restoration on failure | "the scroll position is restored even when extraction throws" |
| Diagnostics | "discovery diagnostics can distinguish every candidate failure mode"; "the content scripts expose the diagnostics the requirement lists" |

### Not verified here

- **Live LinkedIn.** No sign-in, no browser, no network access to LinkedIn from this environment. The
  Connections page and live profiles are a user-browser step (phase 30) and remain unverified.
- **The two new HTML fixtures.** `tests/fixtures/*.html` are manual browser pages and are not run by
  `npm test`. They have not been opened in a browser from here.

## Automated verification — connections importer rebuild

Executed in this environment on Node v24.16.0. Nothing below is inferred.

| Check | Command | Result |
|---|---|---|
| Baseline before this work | `npm test` | PASS — 103 tests |
| TypeScript strict type check | `npm run typecheck` | PASS — no output |
| Production build | `npm run build` | PASS — `Built Profile Vault React 3.2.0 into D:\nihal\profile-vault-react-v3.0.0\dist` |
| Full suite after changes | `npm test` | PASS — **132 tests, 0 failures** |
| Build validation | `npm run validate` | PASS — 22 build files, 3 React entry points, worker imports |
| Whole workflow | `npm run check` | PASS — exit 0 |

### What the 29 new tests cover

All live in `tests/connections-discovery.test.js` and run the real policy functions against
simulated LinkedIn lists and profile pages.

| Requirement | Test |
|---|---|
| Multiple cards on one page | "every card rendered on a page is read, not just the first" — 10 anchors → 10 entries |
| Lazy-loaded connection cards | "lazy-loaded connection cards are all discovered" — 137 revealed 10 at a time |
| Multiple connection pages | "a paginated connections list is followed across every page" — 137 at 50/page, 2 clicks |
| Duplicate URLs | "duplicate links for the same person collapse into one connection"; "…only queued once" |
| Complete pagination discovery | "complete pagination discovery ends only when no control and no growth remain" |
| Persisted full lists | "the full discovered list is persisted across passes before extraction" — 137 rows, no duplicates |
| Full-page profile scrolling | "the profile scan walks the whole page from the top to the bottom" |
| Virtualized profile sections | "virtualized profile sections are not lost: the scan waits for them to settle" |
| Extraction only after scrolling | "extraction only completes after the scan reaches the bottom and stops changing" |
| Selection scopes | "a selection scope narrows extraction without discarding the discovered list"; "a scoped run only ever claims connections inside its scope" |
| List pagination / search / filter | "the connections list paginates at 25 or 50 rows…"; "…can be searched and filtered by status" |

Source-level assertions in `tests/import-integration.test.js` and `tests/react-architecture.test.js`
prove the content scripts and the React page actually route through those functions, that discovery
and extraction are separate commands, and that the required controls exist.

### Not verified

The extension was **not** loaded into Chrome and no live LinkedIn session was exercised from this
environment. Passing tests do not prove live correctness — see the standing limitation below.

## Automated verification — 2026-08-02 (Profile Vault React 3.2.0)

Every row was executed in this environment on Node v24.16.0. Nothing is inferred.

| Check | Command | Result |
|---|---|---|
| Baseline before 3.2.0 work | `npm test` | PASS — 67 tests |
| TypeScript strict type check | `npm run typecheck` | PASS — no output |
| Production build | `npm run build` | PASS — `Built Profile Vault React 3.2.0 into dist` |
| Full suite after changes | `npm test` | PASS — **103 tests, 0 failures** |
| Build/manifest validation | `npm run validate` | PASS — `Validated 22 build files, 3 React entry points, and service-worker imports` |
| Combined chain | `npm run check` | PASS — exit 0 |

### Suite composition (103 tests)

| File | Tests | Area |
|---|---:|---|
| `tests/import-queue-core.test.js` | 31 | Queue state machine, cap/cooldown, backoff, coverage ledger, D2 recovery |
| `tests/connections-core.test.js` | 18 | Canonicalization, dedup, challenge detection, **D1 control policy**, total parsing |
| `tests/import-integration.test.js` | 18 | Replacement, notes/tags, card shape, exports, source invariants, permissions, **lazy-load timing floors** |
| `tests/extraction-core.test.js` | 11 | Present/Current, overlap math, noise, company grouping, logo round trip |
| `tests/profile-utils.test.js` | 7 | URL canonicalization, arrays, merge, replace-preserves-identity |
| `tests/manifest.test.js` | 6 | MV3, LinkedIn-only hosts, minimal permissions, script scoping, worker path |
| `tests/react-architecture.test.js` | 9 | Three React entry points, **single-button import UI**, interleaved collect loop, local runtime, no hooks, framework-free cores |
| `tests/csv.test.js` | 3 | Unicode/multiline round trip, formula neutralization, grouped experience |

### Phase 21–29 behavior covered by tests

| Phase | Requirement | Test |
|---|---|---|
| 21 | Reads the advertised total | `reads the advertised connection total` |
| 21 | A rounded `500+` total never confirms coverage | `a rounded total is captured but marked unreliable`, `a rounded total such as 500+ never confirms coverage` |
| 22 | Passes resume from a persisted cursor | `the discovery pass is resumable from a persisted cursor` |
| 22 | Quiet-pass convergence | `a discovery pass that finds nothing increments the quiet counter`, `the list is only exhausted at the bottom, with no pagination, after quiet passes` |
| 22 | Dedup across passes and restarts | `deduplication holds across passes and restarts, ignoring case` |
| 23 | Allowlisted pagination is clickable | `allowlisted pagination controls inside the connections list may be clicked` |
| 23 | Outreach controls permanently forbidden | `outreach and relationship controls are permanently forbidden` |
| 23 | A forbidden label beats a pagination aria-label | `a forbidden action wins even when disguised with a pagination aria-label` |
| 23 | Controls outside the list are refused | `pagination outside the connections list is refused` |
| 23 | Exactly one click site in the source | `the connections content script clicks only classifier-approved pagination` |
| 24 | Coverage reporting | `coverageReport describes discovered, processed, remaining, failed and confidence`, `coverage is reported as estimated when the total is unusable` |
| 25 | Heartbeat resumes only normal processing | `the heartbeat only ever resumes normal processing` |
| 25 | `alarms` declared iff used | `the alarms permission is declared because the heartbeat needs it` |
| 26 (D3) | Cap pauses into a cooldown | `reaching the batch cap pauses into a cooldown, not a stop` |
| 26 (D3) | Cooldown auto-resumes the next batch | `a cooldown elapses on its own and the next batch starts` |
| 27 | Fresh profiles skipped, force overrides | `a recently collected profile is skipped as fresh unless forced` |
| 28 | Single-row queue writes | `the queue is written one row at a time so large queues stay cheap` |
| 28 | `unlimitedStorage` not requested | `unlimitedStorage is not requested without a demonstrated quota problem` |
| 29 | Permanent failures never retry | `a permanent failure never retries` |
| 29 | Transient failures back off then give up | `a transient failure retries with exponential backoff, then gives up`, `an item inside its backoff window is not claimed yet` |
| D2 | Suspension auto-resumes | `an interrupted run resumes automatically after service-worker suspension` |
| D2 | Challenge/user/navigation never auto-resume | `recovery never resumes a user pause, a challenge, or a navigation trip`, `a challenge pause never auto-resumes even if a cooldown deadline exists` |

Preserved behavior still covered: one-at-a-time claiming, bounded retries, pause/resume/stop/skip,
duplicate replacement keeping `id`/`collectedAt`/`notes`/`tags`, one card per company with nested
roles, one card per institution, partial and full CSV export, database name unchanged.

### `dist` inspection performed

- 31 files emitted; `dist/manifest.json` is byte-identical to the root manifest.
- Service worker is `dist/src/background.js`; all five relative imports resolve inside `dist/src/`.
- `dist/src/extraction-core.js`, `dist/src/connections-core.js`, `dist/content.js`, and
  `dist/connections.js` contain **zero** `import`/`export` statements.
- `dist/connections.js` contains **exactly one** `.click()` call, at `control.element.click()` inside
  the classifier-guarded pagination branch. `dist/src/background.js` contains none.
- `chrome.alarms` appears 4 times in the compiled worker; `alarms` is declared in the manifest.
- Build ID `2026-08-02-react-v3.2.0` is consistent across `build-meta.json`, `connections.js`,
  `content.js`, `src/background.js`, and `src/react/popup.js`. No `v3.1.0`/`v3.0.0` id remains.
- Permissions: `activeTab, scripting, storage, downloads, alarms`. Hosts LinkedIn-only.
  `unlimitedStorage` is **not** requested — no quota problem has been demonstrated.

## Not performed — requires the user's browser

No claim is made about any of the following:

- Loading `dist/` as an unpacked extension in Chrome.
- Any interaction with a live, signed-in LinkedIn account.
- Live connections enumeration, live pagination clicking, live queue processing, live challenge
  handling, live service-worker suspension and auto-resume, or live cooldown behavior.
- Whether LinkedIn's current Connections DOM exposes an exact total, and whether the pagination
  labels in the allowlist match the live markup. **These are DOM assumptions that only live
  evidence can confirm or refute.**
- The four manual fixtures in `tests/fixtures/` are browser-only pages; they are **not** executed by
  `npm test` and were not opened in a browser here.

## Manual verification still required (phase 30)

1. Load `dist/` at `chrome://extensions` (Developer mode → Load unpacked).
2. Confirm the popup shows build ID `2026-08-02-react-v3.2.0`.
3. Extract one profile manually — single-profile behavior must be unchanged.
4. Open your Connections page, open **Import**, press **Discover**. Confirm the reported total,
   the pass count, and that repeated passes converge.
5. Confirm a "Load more" style control is clicked and that Connect/Message are never activated.
6. Press **Start**. Confirm one tab is reused and one profile is processed at a time.
7. Let a batch cap be reached; confirm the cooldown countdown appears and the next batch starts by itself.
8. Force a service-worker suspension mid-run; confirm the run continues without you.
9. Trigger a challenge; confirm the run stops and does **not** auto-resume.
10. Confirm a re-imported profile keeps its notes and tags.
11. Open the three fixtures in `tests/fixtures/` and check `document.body.dataset.result`.
12. Inspect the popup, content-script, and service-worker consoles for unexplained errors.
