# CLAUDE.md — Profile Vault React

## ⚠ READ FIRST — the Project Time Machine is always on

**Every change to this project is a Time Machine task. There are no exceptions and
no "small enough" changes.** The full rules are in
[project-time-machine/docs/AGENTS.md](project-time-machine/docs/AGENTS.md); this is
the short version, and it is binding.

### 1. Start every session with both of these, before reading or touching anything

```bash
node project-time-machine/scripts/status.js
node project-time-machine/scripts/audit.js
```

Then act on what they say:

| They report | Do this before any other work |
|---|---|
| An active task | Finish it or abort it. **Never open a second task.** |
| A stale or malformed lock | `node project-time-machine/scripts/abort-task.js --execute` |
| Unlogged changes | Assign them to a task or discard them. **Never let the next task silently absorb them.** |
| Audit errors | Report them and fix only the metadata that is safe to fix. **Never fabricate a record, commit or tag to make the audit pass.** |

### 2. Wrap every change in a task — automatically, without being asked

```bash
node project-time-machine/scripts/start-task.js "Clear name based on the request"
# ... make only the changes that task needs ...
npm run check                     # or the subset that applies; see docs/checks.md
node project-time-machine/scripts/complete-task.js \
  --summary "What actually changed" --check "npm run check passed"
```

- **Open the task BEFORE the first edit.** `start-task.js` refuses to run once the
  tree is dirty, precisely so pre-existing work cannot be absorbed into it — so
  starting late means the work has to be parked (`git stash`) before a task can be
  opened at all.
- **Close it in the same turn.** Never leave a task open across turns.
- A one-word, one-colour, one-import, one-test, one-comment or docs-only change is
  still a task.
- `--check` may be passed once per check that was **actually run**. Never claim a
  check that did not run, and never claim a live-LinkedIn result (rule 17).
- Do not combine unrelated requests into one task; split independently reversible
  work into separate tasks.
- Report back only: task id, task name, files changed, checks run, Git reference.

### 3. Never run these — the Time Machine owns Git

`git commit`, `git add` + manual commit, `git reset --hard`, `git checkout -f`,
`git clean -fd`, `git stash drop`, `git rebase`, `git commit --amend`,
`git push --force`, `git tag -d/-f`, `git branch -D` on `tm-backup/*`, or any hand
edit to `project-time-machine/tasks/` or `project-time-machine/rollbacks/`.

Reading is always fine: `git status`, `git diff`, `git log`, `git show`.

Commits, tags and task records are created **only** by `complete-task.js`,
`rollback.js` and `recover.js`.

### 4. Plain-language rollback — just do it, do not make the user type commands

| The user says | Run |
|---|---|
| "undo the last task" | `rollback.js task last --execute` |
| "reverse the contact-info task" | `rollback.js task "contact info" --execute` |
| "go back to TASK-0004" | `rollback.js to TASK-0004 --execute` |
| "bring it all back" | `recover.js --execute` |
| "show me the saved tasks" | `list-tasks.js` |

Always preview first (omit `--execute`), show what will change, then apply.

### 5. If work was made outside a task

That is a rule violation — say so plainly rather than quietly folding it in. Then:
`watch.js checkpoint` to snapshot it, park it with `git stash push -u`, open a task
that names that work, restore it with `git stash pop`, run the checks, and complete
the task.

---

**Profile Vault React** v3.7.8 — a local-first Chrome **Manifest V3** extension that extracts *only
visibly rendered* LinkedIn profile data after a direct user action, reviews it in React, stores it in
IndexedDB, and exports formula-safe CSV. It also has a user-started **Connections importer** that
enumerates the account's connections across resumable passes and collects them one at a time, and,
since 3.7.0, a user-started **Applicant collector** for the recruiter's own hiring pages.

**The third surface, added in 3.7.0.** `linkedin.com/hiring/*` and `linkedin.com/talent/*` — the job
applicants the recruiter's own account already shows them. It is a **separate surface with a separate
record and a separate store**, and it shares nothing with the connections import but the cores. A
saved applicant is a person *on a job*: the same person applying to two jobs is two records, and
neither is a saved profile. See "The applicant record" and rule 9d below.

**What a record is, since 3.6.0.** The record is exactly what the table and the CSV show, in this
order: **name, email, mobile, CV, open-to-work details, education institutions, skills, profile URL,
status, last collected**, plus the user's own **notes** and **tags**. `experience`,
`yearsOfExperience`, `currentRole`, `currentCompany`, `currentEmploymentDates`, `totalExperience`,
`websites` and `profileImageUrl` were **removed** in 3.6.0, as `headline`, `location`, `about`,
`certifications` and `languages` were in 3.5.0 — none of them is extracted, stored, exported or
editable. A profile saved by an earlier version loses them the next time it is written, and a CSV
exported by 3.5.0 or earlier no longer round-trips them. Experience is still *read* during the scan,
because a late-hydrating Experience section is real page change the quiet count has to see; it is
simply never stored.

**Where a contact detail may come from, since 3.6.0 — amended in 3.7.1.** The rule is now about
*which element* the text came from, not only about labels:

- **Inside a panel this extension opened itself** on the person being collected — the `Contact info`
  overlay, or an applicant's own contact disclosure — **every address and every number it shows is
  taken**, labelled or not (`parseContactPanel({ trusted: true })`). Such a panel is that person's
  own contact card by construction: there is no Interests block inside it and no other member's card,
  which is the entire reason the labelled rule exists. Requiring a recognised heading in there meant a
  locale or markup revision `CONTACT_FIELD_LABELS` did not match silently lost the phone number that
  was plainly on screen next to the address. `extractPhones`' scrubbing and every rejection in
  `normalizePhone` still apply, so a URL, a member id, a date or a count inside that panel still
  yields nothing.
- **Everywhere else** — the rendered page, the sections, running text — the 3.6.0 rule is
  **unchanged**: a phone number only from a `tel:` link or a line under a labelled Phone/Mobile
  field, an address only from a `mailto:` link or a line under a labelled Email field. Nothing else
  counts: a URL, a member id, a date, a duration, a count, the Interests block, a recommendation or a
  post yields nothing. Two live defects came from breaking that —
  `linkedin.com/in/paarth-khandelwal-264954380` saved `264954380` as a mobile number, and the
  Interests block's Top Voices put a stranger's address and number on the record. **Do not relax this
  half**; the relaxation above is scoped to the one element the extension opened on purpose.

No backend, telemetry, AI API, or paid service. **This is not a git repository** — destructive
commands are unrecoverable.

## Non-negotiable rules

**Architecture**

1. Popup, dashboard, and import UI stay React components under [src/react/](src/react/). Never add
   root-level DOM-mutation UI scripts (`popup.js`, `dashboard.js`).
2. Content-script extraction stays framework-free. Never import React into [content.js](extension/content-scripts/content.js),
   [connections.js](extension/content-scripts/connections.js), or `src/*-core.js`.
3. React loads locally from [vendor/](extension/vendor/), never a CDN — MV3 CSP is `script-src 'self'`.
4. Chrome loads [dist/](dist/), never the repo root.
5. Host permissions stay LinkedIn-only; permissions stay minimal. **LinkedIn's own media CDN
   counts as LinkedIn** (amended in 3.7.9): `media.licdn.com` and `static.licdn.com` are listed
   alongside `linkedin.com`, and nothing else may be added without amending this rule again.
   They are there because the resume document is *served from* `licdn.com` while the page that
   renders it is on `linkedin.com` — a different origin — so `resolveResumeDocumentUrl()` and
   `fetchResumeBytes()` were refused before the request ever left the page, and the only trace was
   a `descriptor: "check-failed"` field nobody opens. A CDN LinkedIn serves the recruiter's own
   documents from is not a third party, and the access is **read-only fetches of a file that
   account already has**. The blocked case is now logged loudly as well, because "every applicant
   came back `check-failed`" is the one sentence that names this cause. `<all_urls>`, `tabs`,
   `webRequest`, `cookies` and the rest of the denied list are unchanged and still asserted.

**Extraction & import behavior**

6. Accuracy over polish. Missing values stay empty — **never invent data**.
7. A current role requires `Present`/`Current` in the visible date range.
8. Education stores **one entry per institution — the name only**, deduplicated case-insensitively,
   in the order the profile renders them. Experience is still grouped one company block per company
   with roles nested *while it is read*, because that grouping is what keeps the accumulator's
   entity identity stable across a virtualized scan; since 3.6.0 none of it is stored.
9. **Every clickable control is named here, and one may only be added by amending this rule.**
   Through 3.6.0 this rule read "exactly three, and no others may ever be added". 3.7.0 added a
   third *surface*, which needs its own controls, so the rule is now: a control exists only if it is
   listed below, it opens or reveals something LinkedIn is already showing this user, and it is
   **gated by a classifier and proven to be inside the container it claims to belong to**. The
   discipline is unchanged and was deliberately not loosened — what changed is that the list is per
   surface, and each surface's click budget is asserted by its own test.

   **Profile pages — exactly three, unchanged:**
   a. Allowlisted connections-list pagination (decision D1), gated by `classifyControl()` and proven
      to be inside the list.
   b. **`Contact info` on a profile page** (amended in 3.5.0 and again in 3.7.1), gated by
      `classifyContactControl()`. It opens the member's own overlay, reads it, and dismisses it with
      Escape. It is clicked **at most once per profile** and **on every profile** — the old
      "only when the rendered page did not already yield both an email and a phone number" condition
      is **gone**, because a profile whose About showed an address never had its overlay opened and so
      never gave up the number sitting in it. It sends nothing, contacts nobody, and changes no state
      on LinkedIn.
   c. **`Show details` inside the Open to work card** (added in 3.6.0), gated by
      `classifyOpenToWorkControl()`. "Show details" labels several unrelated controls on a profile,
      so the label alone is never enough: `findOpenToWorkCard()` locates the card first and the
      control has to be **proven to be inside it** (`inOpenToWorkCard: card.contains(element)`),
      exactly as pagination has to be proven inside the connections list. It opens the member's own
      job-preferences panel, reads it, and dismisses it. At most once per profile.
   **Hiring / applicants pages — exactly four, added in 3.7.0** ([applicants.js](extension/content-scripts/applicants.js)),
   every one of them gated by `classifyApplicantControl({ purpose, inContainer })`
   ([applicants-core.js](src/applicants-core.js)):
   d. The applicant's **contact disclosure** (`purpose: "contact"`), proven inside the applicant
      panel, opened **once per applicant, always**. The recruiter screen keeps the email and the
      phone number together behind this one control, so skipping it because the panel already showed
      an address is exactly how the number goes missing.
   e. Their **resume** (`purpose: "resume"`) — and only when the control carries no `href` to read
      directly, because a link needs no click at all.
   f. A collapsed section's own **expander** (`purpose: "disclosure"`), proven inside the panel and
      capped at `MAX_EXPANSIONS` (8); one that keeps revealing nothing is retired, exactly as a
      fruitless pagination control is.
   h. The applicant list's own **next-page control** (`purpose: "pagination"`, added in 3.7.8),
      matched by `APPLICANT_PAGINATION_PATTERN` and **proven inside the list**. The list is
      paginated and the run only ever saw the first page: scrolling to the bottom of page one is
      indistinguishable from the end of the list unless something looks for the pager, so a job with
      more applicants than fit on a page was collected one page deep and reported complete. It
      reveals more of the same list the recruiter is already looking at and changes nothing on
      LinkedIn. Three bounds keep it terminating — growth counts **new rows** and never a click, a
      pager that reveals nothing `MAX_FRUITLESS_PAGINATION` (3) times is retired, and a disabled
      control is never offered, because on the last page LinkedIn renders the pager and disables it.
      The connections list's allowlist is deliberately **not** reused: its patterns are anchored on
      whole text labels, and a hiring pager is often an icon whose only name is an `aria-label`.
      **The list is re-resolved before every pass and never fallen back to** (3.7.10). Pressing the
      pager re-mounts the whole hiring view, so for those milliseconds `applicantList()` answers
      null — and `applicantList() || list` fell back to the container the walk was holding, which by
      then is **detached**. A detached node reports no scroll range, so every pass reads as "already
      at the bottom"; `findApplicantPaginationControl` then searches that dead subtree and finds the
      *previous* page's pager, which does nothing when clicked. Three presses later the walk concludes
      `pagination-retired`, or finds no control and concludes `settled` — and **both are conclusive**,
      so the run reported COMPLETED at the end of page one and `claimAutoRun` would never re-arm it.
      That is the whole of "it stops after going to the next page". `waitForApplicantList()` waits the
      re-mount out (`LIST_REMOUNT_TIMEOUT_MS`, 8 s) and there is now **no fallback at all**: either a
      live list, or `no-list`, which is *inconclusive* and retried. The page itself is waited for by
      its **rows** (`waitFor(() => wanted())`, `PAGE_ARRIVAL_TIMEOUT_MS` 15 s) rather than by the DOM
      falling quiet, because quiet was wrong in both directions — the DOM is quiet while the next
      page is still in flight, and a re-mount never falls quiet inside a timeout at all — and the
      "start the new page at its top" scroll addresses the **new** container, since the old one went
      with the old page.
      **A chevron is stripped before the label is matched** (3.7.9, `paginationLabel()`): the live
      pager on a 665-applicant job renders `Next ›` and `textContent` includes the glyph, so the
      whole-label anchor refused it and the run never left page one — and because no pager was found
      the walk reported `settled`, a *conclusive* stop, so the job was marked `COMPLETED` at 25 of
      665 and could not restart. Stripping rather than widening the pattern keeps the anchor's
      meaning: removing a glyph from `Next: Message` leaves `next: message`, which still fails, and
      the denylist is consulted before any of it. A control whose **whole** name is the glyph is
      accepted only because `inContainer` is checked immediately after — a bare `›` elsewhere on a
      hiring page is refused. **Numbered page buttons stay refused**: a bare `2` would make any
      numeric control in the list a pager.
      **It may only be pressed once the current page's roster is finished** (3.7.12) — see "The walk
      is the page's own order" below. What gated it before was "no unprocessed row is *mounted*",
      and on a virtualized list that is not "no unprocessed row is *left*": the pager was pressed
      over applicants the run had never opened, and nothing anywhere noticed.
   i. The opened viewer's own **Download** control (`purpose: "resume-download"`, added in 3.7.9),
      matched by `RESUME_DOWNLOAD_CONTROL_PATTERN` on the **whole** label and **proven inside the
      viewer this extension opened itself**. It exists because the address a viewer fetches is not
      always the document: on a recruiter account it is a **descriptor** that answers with JSON
      naming the asset, a `transcribedDocumentUrl` and a set of image manifests — and that JSON was
      being written to disk under the applicant's name and reported as `downloaded`. A `/dms/` path
      on a `linkedin.com` host passes every address-shaped refusal there is, including
      `isResumeDocumentUrl`, so nothing about the *address* can catch it. Pressing the control
      LinkedIn provides makes the page resolve its own descriptor with its own session and request
      the real file. It reveals a file the recruiter's account already has and changes nothing on
      LinkedIn. `Save` remains forbidden — the denylist is consulted first, so a control whose label
      pairs a download with an action on the applicant is still refused.

      **⚠ PERMANENT — this chain may never be removed.** Requested outright by the user and binding
      from 3.7.9 on: *when the extension opens a resume it presses Download, saves the file to disk,
      and keeps that link as the resume link.* All five steps are load-bearing and none may be
      dropped, shortened or made conditional:
      **(1)** open the viewer → **(2)** press the viewer's own Download control
      (`clickResumeDownload`, gated by `classifyApplicantControl`) → **(3)** take the address that
      produced and prove it is a document, resolving a descriptor to the file it names
      (`resolveResumeDocumentUrl`) → **(4)** record that address as the resume link **before** the
      download is attempted (`linkSavedBeforeDownload`), so a refused or timed-out download still
      leaves a usable link → **(5)** save the file through the worker
      (`PV_APPLICANT_DOWNLOAD_RESUME`; a content script has no `chrome.downloads`) and put
      `localReference` and `downloadStatus` on the record beside the link.
      Step 2 must stay **before** step 3: pressing Download is what makes the page request the real
      file, which is what puts its address in the entry log at all — reordering them silently returns
      the surface to saving a descriptor, or nothing. The test
      `PERMANENT: the opened resume is downloaded by pressing Download, and its link is kept`
      ([tests/applicants-core.test.js](tests/applicants-core.test.js)) asserts every step and is
      itself not to be deleted or weakened. If this behaviour ever genuinely has to change, **this
      rule changes first, in its own task**, and the test changes with it — never the other way
      round.

      **⚠ PERMANENT — the viewer is a fallback, never the first move.** Also requested outright:
      *download the resume without opening it — both the link and the file on disk.* So before
      anything is clicked, the document's address is looked for on the resume control's own `href`
      (only when `isResumeDocumentUrl` says it is a document — a `/hiring/…` route never counts) and
      then across the whole page (`findResumeDocumentUrl(null)`, seven attributes over nine element
      shapes). **If that finds an address, nothing is opened and nothing is clicked**: the descriptor
      resolve, the link and the worker download all live *after* the guarded block, so not opening
      never means not saving. The open-and-press-Download chain above runs **only** inside
      `if (!url)`, and that guard is the feature — a click that escapes it silently reverts this.
      Opening remains necessary in exactly one case, and it is LinkedIn's doing rather than a choice:
      when the control carries only a route, the file's address does not exist anywhere on the page
      until LinkedIn's own viewer resolves it. `diagnostics.resume.foundWithoutOpening` records which
      of the two paths each applicant took. Locked by
      `PERMANENT: the resume is downloaded without opening it whenever the address is already known`.
   g. A **row of the applicant list** (`purpose: "applicant-row"`), proven inside the list, which is
      how the whole-job walk advances. It is a navigation click and nothing else. **Wait for
      the applicant that row leads to to be *mounted*, never for the address bar and never for the
      panel's text to differ** (amended in 3.7.10) — LinkedIn routes without a navigation and the DOM
      is briefly quiet between tearing the old applicant down and mounting the new one, so both of
      those signals fire while the panel still shows the previous person. **A text fingerprint is no
      better, and it cost every applicant their name.** The teardown alone satisfies it, so the scan
      read the stale panel; `chooseApplicantName` then arbitrated with LinkedIn's own qualification
      prose, which on that panel names the *previous* person over and over — so the wrong name won as
      the **corroborated** one, and `addName` latches a corroborated name against every later read.
      Three different applicants were stored as "Komal Sharma", the one open when the run started.
      `selectApplicantRow` now waits in three steps — **teardown** (best-effort and short, so arrival
      cannot be satisfied by the panel already on screen), **arrival**, then **settle and confirm
      again** — and arrival is decided by `Applicants.describePanelArrival()` from **identifiers
      only**: the application id on the panel's own link and the member's `/in/` slug, plus at least
      `PANEL_MIN_SECTIONS` (2) hydrated sections. **And waiting is not trusted on its own** (rule 6):
      `extractApplicant` takes `expectApplicationId`, `assertExpectedApplicant()` re-checks it before
      the scan, after it and immediately before the record is built, and a panel showing somebody else
      throws rather than saving — bounded by `MAX_WRONG_APPLICANT_RETRIES` so one unresolvable row
      cannot hold the job. Since 3.7.3 a row whose applicant is **already saved for this job is walked
      past without being clicked at all** — see "Collecting every applicant" below.

      **⚠ The wait is time given to the panel, never a verdict on the applicant** (amended in 3.7.11,
      and this half of the rule was written by breaking it). Two things made the arrival question
      unanswerable on the live markup, and together they stopped the run reading anybody: the panel's
      own id **fell back to the address bar**, which routes ahead of the render and therefore answers
      "yes, this is the applicant you asked for" before the panel has changed at all — leaving the
      section count as the only real test — and that count was taken from `mountedApplicantPanel()`,
      the strict resolver, which needs one container holding two *hydrated* section headings and on
      this surface **routinely holds none**. That is not a suspicion: it is exactly why
      `buildSectionMap()` widens page-wide, and why `current_role` was empty before it did. The strict
      resolver then answers `null`, every poll reads `torn-down`, arrival never happens — and the
      caller's `Boolean(arrival) && settled.arrived` **skipped the applicant**. The reported symptom
      was precise: *"it scrolls one profile, then stops at the second and does not even scroll it"* —
      one profile, because the first applicant is already on screen and so is never clicked. Every
      other row was walked past unopened, unscrolled, saved as a bare name.
      So: `panelOwnApplicationId()` reads the panel's **own** markup and answers `""` rather than the
      address bar; `arrivalPanel()` takes the strict panel when there is one and the loose panel when
      it carries an identifier of its own (an application link or the member's `/in/` link), still
      refusing anything holding more than one row link so "the list is on screen" cannot look like an
      arrival; and **only `OTHER` or `PREVIOUS` — a panel positively showing somebody else — refuses
      the row.** `torn-down` and `mounting` mean *"I could not tell"*, and the answer to that is to
      read the panel and let `assertExpectedApplicant` refuse the **record**, which is the guard that
      was already there and already checks three times. A row that comes up as somebody else is still
      **skipped**, not scanned; scanning anyway saved the previous applicant a second time under this
      row's identity. `PANEL_ARRIVAL_TIMEOUT_MS` is 10 s and the teardown 1.5 s, because a job is
      walked one applicant at a time and every second spent waiting for an answer that will not come
      is spent once per applicant.

   Connect, Follow, Message, InMail, Endorse, Remove connection, Withdraw, Invite, Report, Block,
   Send, Share, Accept, Ignore, and Save are permanently forbidden on every surface, and the hiring
   surface adds **Shortlist, Move to, Reject, Archive, Hire, Offer, Interview, Schedule, Rate, Good
   fit / Maybe / Not a fit, and Add note** — those change the recruiter's own ATS. **The denylist
   always beats every allowlist**, so "Message · Contact info", "Message · Show details" and
   "Message · Contact" are all refused, including when only the `aria-label` says it. Tests assert
   the budget per file: `content.js` exactly **three** `.click()` calls (two gated opens plus one
   shared dismiss), `connections.js` exactly **one**, and `applicants.js` exactly **seven** (six
   gated opens plus one shared dismiss). The pager has two callers since 3.7.9 — the full walk and
   the on-demand growth — and deliberately **one call site** (`clickApplicantPager`), because a
   second site for a control this rule already names would raise that count without adding a
   control, and the count is only worth asserting while it counts controls. Lazy scrolling must
   always restore the scroll position, on every surface and on the failure path.
10. Scope to the main profile context. Reject `aside`, `footer`, `nav`, `[role='complementary']`,
    messaging overlays, and modals. **The one exception is the contact overlay this extension opened
    itself** — `contactLinksIn(dialog, { allowModal: true })` lifts the modal rule for that single
    element and nothing else. Document-wide guessing is never the primary method.
11. Do not depend on generated class names, child indexes, or exact array positions. Class names may
    only add *scoring bonuses*, never hard matches.
12. **Import runs one profile at a time in exactly TWO reused tabs of the user's own window**
    (amended in 3.5.0): one Connections tab and one profile collector tab.
    [collector-tabs-core.js](src/collector-tabs-core.js) is the **only** place any tab is created,
    activated, or closed; the service worker injects `chrome.tabs`/`chrome.windows`/`chrome.storage`
    into it and must never call `chrome.tabs.create` or `chrome.windows.create` itself. A test
    asserts that, and drives a whole queue through the controller asserting **exactly one** profile
    collector tab is created. **Never a tab per profile.** No separate collector window any more —
    the run lives in the window Start Full Collection was clicked in. No parallel extraction, no
    infinite retries, no bypassing restrictions or challenges. The hiring surface adds a **third**
    tracked tab in 3.7.5 (`KEYS.APPLICANT_TAB`), reused not duplicated and opened only at an address
    the extension has actually been on — but it is **not a collector tab**: `closeCollectorTabs()`
    never touches it, because it is the recruiter's own working page.
12c. **Focus is taken in exactly three places, and all three are a direct user command:** the
    sign-in page, an applicant command's hiring tab, and — added in 3.7.17 — a **connections
    command's Connections tab** (`activate(id, { focusWindow: true })`). Everything driven
    by the heartbeat activates the tab without focusing the window — stealing focus from whatever the
    user is typing into is worse than a background run taking longer. A button press is the opposite
    case: a tab activated in a window they are not looking at is a button that did nothing.
    **The third was the same defect as the second, left unfixed on the older surface.** Reported
    outright: *"I want these buttons to directly redirect on the connections page and start
    collecting"*, about `Start Full Collection` and `Discover Connections Only`, which appeared to do
    nothing at all. Both already did everything else right — `rememberOrigin`, then
    `resolveConnectionsTab()` opening or reusing the **one** Connections tab in that window and making
    it the **active** tab — but `ensureConnectionsTab` passed only `{ activateTab: true }` where
    `ensureApplicantTab` had passed `{ activateTab: true, focusWindow: true }` since 3.7.5. The popup
    has no sender tab of its own, so `rememberOrigin` falls back to the last focused window, and the
    importer page is routinely a window of its own — so the redirect kept landing off screen.
    `revealConnectionsTab()` is its own step, exactly as `revealApplicantTab` is, and deliberately
    **not** folded into `resolveConnectionsTab`, which `runDiscovery` also reaches on the heartbeat's
    resume path; `prepareCollectorStep` is what that path uses and it still never focuses. It is
    called **before** `checkLoginState()`, because that check costs a content-script injection and a
    round trip and a page that arrives seconds later reads as the same dead button — the check then
    reuses the tab it just revealed. Locked by *"a connections command brings the Connections page to
    the front, before the slow part"*, which asserts both halves.
12a. **A hidden collector page is never a finished one.** Chrome throttles background tabs and
    LinkedIn does not render a hidden page, so the DOM freezes — and every completion signal in this
    codebase is "the page stopped changing". Both content scripts gate on
    `document.visibilityState === "visible"`, listen for `visibilitychange`, and return
    `hidden: true` with `atBottom: false` instead of concluding anything. The worker pauses with
    `paused_visibility`, saves nothing partial, and resumes on the heartbeat once the page is
    renderable again. `prepareCollectorStep()` makes the tab active and un-minimizes its window
    before every discovery pass and every profile.
12b. **The extension never handles a credential.** `Sign in to LinkedIn` only navigates the collector
    tab to `https://www.linkedin.com/login`. No password input, `document.cookie` read, or
    `chrome.cookies` call may exist anywhere; login state is inferred by `classifyAuthState()` from
    the page's URL, text, and member-navigation markers, and "unknown" is never upgraded to
    "signed in".
13. On CAPTCHA, login, checkpoint, unusual-activity, rate-limit, restriction, unavailable profile, or
    repeated navigation failure — **pause immediately** and require manual Resume. Only worker
    interruption and an elapsed cooldown may ever resume automatically.
13a. **The universal Stop (`STOP_ALL` / `PV_STOP_ALL`, added in 3.7.0) is always available and always
    ends everything.** The popup renders `Stop Everything` unconditionally — full width, above every
    panel, disabled only while a stop is itself in flight. A Stop that only appears once the
    extension has noticed it is busy is the Stop a user cannot find when they need it, and a test
    asserts the old `{running || cooling || discovering ? …}` guard never comes back.
    `stopEverything()` in [background.ts](src/background.ts) is matched **before every other message
    branch**, and it bumps the generation token (ending work already in flight, not merely the next
    iteration), broadcasts `PV_STOP_ALL` to every LinkedIn tab, stops the session, clears the
    heartbeat and closes the collector tabs. **All three content scripts honour it inside their
    walking loops, before each step** — not between items — and each reports a stop as an
    *interruption*: `stopped: true` with `atBottom: false`, never a failed record and never a
    finished list. **Stop ends work; it never discards what that work produced** — a test asserts it
    calls no `clearProfiles`, `clearApplicants`, `clearQueue` or `deleteProfile`.

**Data**

14. The IndexedDB name `profile-table-collector` must never change ([db.js](src/db.js)) — it
    preserves pre-3.0 data. Schema is now **v6**, which adds **one index and nothing else**:
    `applicants.applicationId`. `applicantId` hashes `jobId|profileUrl|name|applicationId`, so *how
    much of a person was known when they were written* decides their key — a pass that reads only the
    list row knows no profile URL, a pass that opens the panel does — and the same application
    therefore hashed two ways and was stored twice, silently. The application id is what identifies
    "this person on this job", so `saveApplicant` consults it (`findStoredApplication`, scoped to the
    job) **before** a second record can be created, and `mergeApplicantRecord` keeps `id: before.id`
    so nothing is re-keyed. The index is added to the store **as it already exists** — every user who
    has collected an applicant is on v5 with the store already created, so adding it inside the
    "create the store" branch would never reach them — and a pre-v6 database answers "nothing stored"
    rather than throwing on every save. Rolling back to v5 costs this lookup and not one record.
    Previously: v3 added `importQueue` and `importSession`; v4
    indexes `status` and `lastCollectedAt` and **deletes** the `currentCompany` and `location`
    indexes, which pointed at fields the record no longer has; **v5 adds `applicants` (keyPath `id`,
    indexed by `job.id`, `updatedAt` and `applicant.applicationStatus`) and `jobs` (keyPath `id`)**
    and touches nothing else — a test asserts v5 calls no `deleteObjectStore`, so rolling 3.7.0 back
    costs applicants and not one saved profile or queue row. Rows migrate lazily —
    `normalizeProfile` drops the retired fields and fills in the new ones on every read, and
    `repairStoredProfiles()` (run once when the Saved Profiles page mounts) writes back only the
    rows that actually changed. Retired values are **not recoverable** afterwards, so export first.
15. Saving an existing canonical URL **replaces** extracted details while preserving `id`,
    `collectedAt`, `notes`, and `tags` ([replaceProfile](src/profile-utils.js)).
16. CSV keeps its UTF-8 BOM, quoted cells, and formula neutralization (now including a leading TAB
    or CR). The column set was **replaced again** in 3.6.0: its first twelve columns are the Saved
    Profiles table, column for column and in the same order —
    `name,email,mobile,cv_url,open_to_work,education,skills,profile_url,status,last_collected,notes,tags`
    — and `CSV_TABLE_COLUMNS` is exported so a test holds the two in step. `all_emails`,
    `all_phone_numbers`, `cv_file_name`, `cv_links`, `source` and `collected_at` follow as extra
    detail. `mobile` and `all_phone_numbers` are written with a leading apostrophe so a spreadsheet
    keeps them as text (`04423456789` keeps its leading zero) and `csvToProfiles` strips it again.
    An object can never reach a cell — `serializeValue` returns "" for one rather than printing
    `[object Object]`. `full_name`, `all_emails` and `all_phone_numbers` are accepted as **aliases**
    on import, so a 3.5.0 export still imports. From 3.6.0 onward the old rule resumes: **append
    columns; never reorder.**

**Verification**

17. Never mark a live LinkedIn issue fixed because local checks pass. Fixtures ≠ live DOM.
18. Run `npm test` after every change. Add a sanitized failing fixture *before* selector changes.
19. Document only checks you actually ran.

## Commands

| Command | Notes |
|---|---|
| `npm test` | Node built-in runner, no deps needed |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | ⚠️ **deletes `dist/` before running `tsc`** — a failed build leaves no extension, and there is no git to restore from. Typecheck first. |
| `npm run validate` | Read-only `dist/` assertions |
| `npm run clean` | Deletes `dist/` + `.build/`. Unrecoverable. |
| `npm run check` | typecheck → build → test → validate |
| `npm run package` | `check` → a versioned installer in `releases/`. Packages `dist/` and **nothing else** — it never reads anywhere else — then reads its own archive back and compares every entry against `dist/` before writing it. |

Fresh clone: `npm install && npm run check`, then load `dist/` at `chrome://extensions`
(Developer mode → Load unpacked).

Another device: `npm run package`, then send `releases/profile-vault-react-<version>.zip`. It carries
[INSTALL.md](docs/INSTALL.md) and unzips to an `extension/` folder to Load unpacked. Chrome refuses to
install an extension from a file — a `.crx` has been blocked outside the Web Store since Chrome 33 —
so unpacked is the only route, and **nothing about the extension differs in a packaged copy**: no
added file, no manifest key, no permission. `scripts/zip.mjs` writes the archive format by hand
because this project has no build dependencies and shipping a zip is not a reason to acquire one.

After editing `src/**` or `extension/content-scripts/**`: `npm run build`, reload the extension, and
reload the LinkedIn tab.

## Layout

```
extension/
  manifest.json
  content-scripts/  content.js (profile extraction), connections.js (discovery),
                    applicants.js (recruiter hiring pages)
  pages/            popup.html, dashboard.html, import.html, applicants.html
  styles/           theme.css (shared visual layer) + one stylesheet per page
  icons/  vendor/   Extension icons and the local React runtime
src/
  extraction-core.js    Pure profile parsing — NO DOM at load
  connections-core.js   Pure URLs, control policy, totals, challenges — NO DOM at load
  applicants-core.js    Pure applicant/job parsing + hiring click policy — NO DOM at load
  collector-tabs-core.js  Pure tab workflow over an INJECTED chrome API — NO DOM at load
  import-queue-core.js  Pure queue/session/discovery state machine
  queue-db.js  db.js  applicant-db.js  csv.js  profile-utils.js  messages.ts
  background.ts         Service worker — import orchestrator + applicant relay
  react/  popup.tsx  dashboard.tsx  import-dashboard.tsx  types.ts
docs/     Supporting project guides, history, status and verification records
scripts/  tests/ (*.test.js + fixtures/*.html, browser-only)
dist/     Build output — the folder Chrome loads
```

## How the pieces connect

**React is a global, not an import.** Every `.tsx` does
`const React: any = (globalThis as any).React;`. HTML pages load `vendor/*.min.js` as classic scripts,
then the compiled entry as `type="module"`. **Never write `import React from "react"`** — there is no
bundler. The `react`/`react-dom` entries in [package.json](package.json) are *not* the runtime;
to change versions, replace the files in [extension/vendor/](extension/vendor/).

**React 16.0.0 is old.** No hooks (16.8), no `createContext`/`forwardRef` (16.3), no
`memo`/`lazy`/`Suspense` (16.6), no Fragments or `<>` (16.2), no `createRoot` (18). Use class
components and hook-free function components. TypeScript will *not* catch a hook — `React` is `any`.

**`*-core.js` files are export-free IIFEs** assigning `globalThis.ProfileVaultCore` /
`globalThis.ProfileVaultConnections` / `globalThis.ProfileVaultApplicants`. They must work three
ways: classic content script, ESM side-effect import, and Node `await import()` in tests. **Never add
`export` to them, and never touch `document`/`window` at their top level.**
`applicants-core.js` additionally reads `globalThis.ProfileVaultCore` **lazily, inside functions** and
always guarded, so it reuses the profile core's text cleaning, contact provenance and settle policy
rather than growing a second copy — and still loads when that core is absent.

**Service worker lives at `dist/src/background.js`** (not the dist root) so its relative ESM imports
of `./queue-db.js`, `./db.js` and `./applicant-db.js` resolve.

**Build ID `2026-08-03-react-v3.7.8` must match in 5 places:** [content.js](extension/content-scripts/content.js),
[connections.js](extension/content-scripts/connections.js), [background.ts](src/background.ts),
[popup.tsx](src/react/popup.tsx) (`EXPECTED_BUILD_ID`), and [build.mjs](scripts/build.mjs). The popup
and the service worker both refuse a content script whose `PV_PING` build ID differs, then re-inject.
[applicants.js](extension/content-scripts/applicants.js) carries the same id and answers `PV_APPLICANT_PING`, so the two
surfaces are never mistaken for one another and re-injected on top of a live run.

**Messages** are declared in [src/messages.ts](src/messages.ts). Profile page: `PV_PING`,
`PV_CHECK_PAGE`, `PV_CHECK_LOGIN`, `PV_EXTRACT`, `PV_GET_DIAGNOSTICS`. Connections page:
`PV_DISCOVER_CONNECTIONS`, `PV_CONNECTION_TOTAL`, `PV_CHECK_LOGIN`, `PV_GET_DIAGNOSTICS`. Service
worker: `PV_GET_BUILD_INFO`, `PV_IMPORT_*`
(status/discover/start/pause/resume/stop/skip/retry/clear/check-login/open-login, plus
`PV_IMPORT_DISCOVERY_PROGRESS` — fire-and-forget streamed rows from the connections page — and
`PV_IMPORT_DIAGNOSTICS`, which backs the **Download Diagnostics** button). Hiring pages (3.7.0):
`PV_APPLICANT_PING`, `PV_APPLICANT_CHECK_PAGE`, `PV_APPLICANT_EXTRACT`, `PV_APPLICANT_EXTRACT_ALL`,
`PV_APPLICANT_STATUS`, `PV_APPLICANT_STOP`. Service worker: `PV_APPLICANT_COLLECT_CURRENT`,
`PV_APPLICANT_COLLECT_ALL`, `PV_APPLICANT_AUTO_RUN` (3.7.6 — "was this job collected on purpose, and
with what options", which is what makes returning to it restart the run rather than sit idle),
`PV_APPLICANT_LIST`, `PV_APPLICANT_COLLECTED` (3.7.3 — one lean entry per
stored applicant, which is what lets a run resume rather than start over), `PV_APPLICANT_CLEAR`,
`PV_APPLICANT_DIAGNOSTICS`, plus two that travel the other way — `PV_APPLICANT_SAVE` (streamed per
finished applicant, so a run the user walks away from keeps everything already collected) and
`PV_APPLICANT_DOWNLOAD_RESUME`.
`PV_STOP_ALL` is handled **before every other branch** in the worker and by every content script.
Async handlers **must `return true`**.

`PV_IMPORT_START_COLLECTING` and `PV_IMPORT_DISCOVER_ALL` **reply `{ started: true }` immediately**
and run detached, because the popup and the importer page are both allowed to close mid-run. Never
make them `await` the whole workflow.

## Data model

`normalizeProfile` ([profile-utils.js](src/profile-utils.js)) is the canonical shape. `id` is a
deterministic FNV-1a hash of `canonicalUrl|name|suffix`. `updatedAt` is always restamped;
`collectedAt` is preserved. Array fields dedupe case-insensitively.

**`canonicalizeProfileUrl` truncates a LinkedIn member URL to `/in/<slug>`.** LinkedIn routes its
sub-views into the address bar, so opening Contact info moves the page to
`/in/<slug>/overlay/contact-info/`. The profile URL is now captured in `extractProfile` *before* the
overlay is opened as well, because a record whose `profileUrl` is the overlay hashes to a different
`id` and matches no queue row. Both copies of the function — [extraction-core.js](src/extraction-core.js)
and [profile-utils.js](src/profile-utils.js) — must stay identical.

**Field boundaries are enforced in the core, not hoped for.** LinkedIn's entity `innerText` collapses
sibling metadata spans into one line when the separator span does not render, producing values like
`"TechMatrix Consulting 9 mos"`. `stripEntityMeta()`, `sanitizeCompanyName()`, `sanitizeRoleTitle()`
and `isSkillValue()` ([extraction-core.js](src/extraction-core.js)) are applied at parse time, at
grouping time, **and** inside `createProfileAccumulator()`, so no path can store an employment type or
a duration as a company or a role title. Skills come from the card's heading (`entityHeadingText()` in
[content.js](extension/content-scripts/content.js)), never the container's `innerText` — that is what saved `Endorse` and
`Associate Software Engineer at TechMatrix Consulting Endorse` as skills.

**The record, in table order** (`PROFILE_FIELDS` in [profile-utils.js](src/profile-utils.js)):

| Field | Notes |
|---|---|
| `fullName`, `firstName`, `lastName` | |
| `email` / `emails` | `email` is the primary; `emails` holds every address found. **A `mailto:` link or a labelled Email field only.** |
| `mobile` / `phones` | Same shape. **A `tel:` link or a labelled Phone/Mobile field only.** `normalizePhone()` rejects date ranges, counts, placeholders, anything containing a path, an `@` or a host, and anything with digits welded to a word — 7–15 digits only. |
| `cvUrl` / `cvFileName` / `cvAvailable` / `cvLinks` | **CVs only.** A link qualifies when its own label or URL says cv/resume/curriculum vitae, when it is a PDF/DOC/ODT/RTF file, or when it is on a host that exists to publish a CV (`read.cv`, `resume.io`, …). A general document host (Drive, Dropbox, OneDrive, Box, Notion) needs the word as corroboration; surrounding section text alone never promotes a link, "portfolio" is a **website**, and a linkedin.com address is **never** a CV — that is `profileUrl`. LinkedIn's `redir/redirect` wrapper is unwrapped first, so the stored link is the document. `cvFileName` is **derived** from the URL and is empty when the CV is a hosted page rather than a file — never guessed. `cvAvailable` is simply `Boolean(cvUrl)`. Empty when the profile has none — **never invented**. |
| `openToWorkDetails` | One labelled line per field of the member's own Open to work panel, led by `Open to work: Yes`: `Job titles`, `Locations`, `Workplace types`, `Employment types`, `Availability`. Empty for a member who is not advertising. |
| `education` | **Institution names only**, deduplicated case-insensitively, in the order the profile renders them. Degree, field, dates and details are still parsed — they are what tells two cards for the same school apart while the page hydrates — but they are not stored. |
| `skills` | Every rendered skill name, from the card's heading. |
| `profileUrl` | Captured before any overlay is opened. |
| `status` | `collected` when the record carries at least one of email / mobile / CV / skills / education / open-to-work; `partial` when it carries none; `failed` when the importer states it. A status supplied outright is never overwritten. |
| `lastCollectedAt` | When a **collection** last wrote this record. A hand edit restamps `updatedAt` and leaves this alone, which is what makes the importer's `stale` scope mean "not collected recently". |
| `notes`, `tags` | The user's own, and never touched by an extraction. |

⚠️ `ARRAY_FIELDS` is defined twice — [profile-utils.js](src/profile-utils.js) (9, for validation) vs
[types.ts](src/react/types.ts) (7, for form editing). Update both.

## The applicant record (3.7.0)

A **different record in a different store**, and deliberately not a profile. `normalizeApplicantRecord`
([applicants-core.js](src/applicants-core.js)) is the canonical shape; `ApplicantRecord` in
[messages.ts](src/messages.ts) is the same shape in TypeScript, and the two must stay in step.

**An absent value is `null`, never `""` and never a guess.** That is the whole difference in tone from
the profile record, and it is what the recruiter surface needs: a qualification LinkedIn says it
"cannot provide or evaluate" is `unknown`, never a miss; a job description not rendered on the
applicants view is `null`, never assembled out of the panel; a resume the account cannot see is
`available: false` with `downloadStatus: "unavailable"`, never a guessed link.

- `id` is FNV-1a over `jobId|canonicalProfileUrl|name|applicationId`. **An applicant is a person *on a
  job*** — the same person applying twice is two records.
- **The name is chosen by policy, never taken from wherever it happened to be** (3.7.1).
  `findApplicantName()` offers the selected list row (matched on the `applicationId` in the address
  bar), the profile link, the portrait alt, non-section headings, and the panel's first line *last*;
  `chooseApplicantName()` arbitrates with `nameFromExplanations()` — the words LinkedIn's own verdict
  sentences share at the front, which is the name stated in prose where no markup change can move it.
  `isApplicantNameCandidate()` refuses page chrome, addresses, counts and sentences outright. The live
  defect: the panel resolved to a container that also held the applicant list, and the first line of
  its text was taken as the name, so **every record was saved as "Applicants"**. `applicantPanel()`
  now refuses any candidate holding more than one applicant-row link, and `addName` is the one header
  field a later, corroborated read may replace — because the explanations only exist once the
  qualifications have been read.
  **`cleanApplicantName` strips what a portrait welds to the END of a name** (3.7.10,
  `NAME_IMAGE_ARTIFACT_PATTERN`): LinkedIn's applicant photo carries its accessible name as
  `alt="<name> graphic"`, so records were saved as **"Komal Sharma graphic"**. Only a *leading*
  "photo of" was ever removed. It is fixed in `cleanApplicantName` rather than at the portrait
  because the same artifact reaches the name through the profile link's `aria-label` too, and
  stripping it at one source would leave the other producing a second spelling of one person —
  **which is not cosmetic**: `applicantId` hashes the name, so the two spellings are two records, and
  that is the duplicate rows reported alongside it. The degree badge and the artifact are stripped in
  either order and repeatedly, bounded rather than `while`; a value that is *nothing but* the
  artifact collapses to `""` and `isApplicantNameCandidate` then refuses it.
- `job` — `id`, `title`, `company`, `location`, `description`, `applicantCount`, `url`, plus
  `mustHaveQualifications`, `preferredQualifications` and `screeningQuestions` (question and ideal
  answer only; the *answer* belongs to the person, not the posting).
- `applicant.currentRole` / `currentCompany` come from the experience card marked `Present`, **never
  from the headline** — the live headline in the reference screen reads
  "HR Head | Talent Acquisition | Employer Branding | …" and names no employer at all.
- `applicant.totalExperience` is `calculateTotalExperience` over the entries, which merges overlapping
  ranges and excludes internships. The card renders `2026-Present` with **no spaces** and
  `parseDateRange` deliberately refuses a hyphen glued between digits, so `normalizeDateRange()`
  restores the separator for the lookup **only** — the stored `dateRange` keeps LinkedIn's own
  wording. Only a hyphen following a four-digit year is touched, so `3-5 years` is still not a range.
- `applicant.qualifications[]` — `requirement`, `category` (`must_have` | `preferred`), `result`
  (`matched` | `not_matched` | `unknown`), `explanation`, `source` (`applicant_profile` | `resume` |
  `screening_response` | `""`), `sourceNote`, `raw`. The **verdict icon's accessible name wins over
  the wording**; the wording is a conservative fallback where only an explicit negative is a miss.
- `applicant.screeningResponses[]` — `question`, `idealAnswer`, `answer`, `met`. `met` is only ever a
  real comparison: absent either half it is `null`, because the platform did not say.
- `applicant.resume` — `available`, `filename`, `fileType`, `pages`, `url`, `viewerUrl`,
  `localReference`, `downloadStatus` (`not_attempted` | `downloaded` | `already_saved` | `link_only` |
  `unavailable` | `failed`). Since 3.7.1 the viewer is **opened** rather than merely linked: the
  control's `href` is usually a route, not the document, and the file name, type and page count exist
  only inside the viewer. It is scrolled to the bottom first, because a PDF viewer renders its pages
  as lazily as a profile does. The viewer's own file name beats one derived from the URL; neither is
  guessed.
- **`url` is the document and `viewerUrl` is the page that displays it, and they are never the same
  field.** `isResumeDocumentUrl()` decides: a document extension, a `licdn.com` address, or a
  `/dms/`-style storage path — and a `linkedin.com/hiring|talent|in|jobs|…` address is refused
  **first**, exactly as `looksLikeCvLink` refuses a linkedin.com address before considering anything
  else. `normalizeApplicantRecord` moves a page arriving on `url` to `viewerUrl` as defence in depth,
  and the worker refuses to fetch one (`refused-page-not-a-document`). The live defect: the control's
  route was stored as the file, so "Open resume" reopened the applicants page — and the worker
  downloaded that HTML page as somebody's CV and reported `downloaded`. A LinkedIn host is not a file.
- **The downloaded file IS the table, and since 3.7.15 it is nothing else.** Requested outright,
  against a screenshot of the rendered table: *"the downloaded CSV or Excel file contains **only**
  these columns in this exact order — #, Applicant Name, Email, Mobile, Resume File, Current Role,
  Current Company, Total Experience, Education. Do not download any extra fields ... Keep all extra
  data stored internally."* So `APPLICANT_CSV_COLUMNS` is exactly `["#", ...APPLICANT_TABLE_COLUMNS]`
  — `APPLICANT_TABLE_COLUMNS` is `applicant_name, email, mobile, resume_file, current_role,
  current_company, total_experience, education`, and one assertion holds the file, that list and the
  page's rendered `<th>` labels together, so a column added to any one of them without the others
  fails. **`#` is a position in the file being written**, 1..N over the rows exported, exactly as the
  table's own `#` is a position in the view it paints; it is derived from where the row lands, never
  read off the record, and it is deliberately not `applicant_id` — two exports of different filters
  number the same person differently, which is right for a serial number and would be a defect for a
  key.
  **This removed columns, which the appending rule forbids, so the rule is amended here first.**
  Twenty-three detail columns are gone from the file: `qualifications`,
  `must_have_qualifications`, `preferred_qualifications`, `screening_responses`, `experience`,
  `skills`, `application_status`, `collected_at`, `last_updated`, `all_emails`, `all_phone_numbers`,
  `website`, `profile_url`, `headline`, `applied`, `contacted`, `resume_link`, `resume_file_type`,
  `resume_pages`, `job_id`, `job_url`, `warnings`, `source_url` and `applicant_id`. That includes
  `resume_link` and `qualifications`, which 3.7.9 had **demoted rather than dropped** with a
  two-part test asserting each was still in the export — the second half of both tests is now the
  opposite assertion, and the change is stated rather than quietly made.
  **Not one field left the RECORD, and that distinction is the whole change.** Everything above is
  still extracted, still merged, still stored and still rendered in the details drawer;
  `resume.url`, `viewerUrl` and `downloadStatus` in particular are load-bearing, because
  `resumeAlreadyDownloaded()` is what stops every run re-downloading every file. The formatters
  those columns were built on — `resumeLink()`, `qualificationRows()`, `formatQualifications()`,
  `allOf()`, `formatScreening()`, `formatExperience()` — are **all kept, all exported and all still
  tested**, because the drawer renders through them and because a column is a *view*. There is no
  applicant CSV import, so shrinking the file cannot break a round trip. Two tests assert both
  halves: every named column is absent from the file, and every value is still on the record.
  `resume_file` is the saved copy's path under the downloads folder, falling back to the file name
  LinkedIn showed; `resumeLink()` is still the document address when the page rendered one and the
  LinkedIn viewer page when that is all there is. Both live in
  [applicant-csv.js](src/applicant-csv.js), so the table cell and the drawer are one rule, and
  neither invents anything. `mobile` is still written with a leading apostrophe so a spreadsheet
  keeps it as text. From here the usual rule resumes — **append columns; never reorder** — and
  appending one now means appending it to the table as well.
- `extraction.rawData` keeps the verbatim text every section was parsed from, so a LinkedIn layout
  change is diagnosable from the exported record rather than only from a live page.

**Merging is enrichment, exactly like the profile accumulator.** `mergeApplicantRecord` concatenates
the lists and never overwrites a filled field with a blank, and **a resume already `downloaded` keeps
its filename and its status** — that is what stops the second visit fetching the same file again.
**Through 3.7.10 that first clause was only true of the lists, `contact` and `job`** — each merged
field by field — and **not** of the applicant's own scalars, which arrived by `...after.applicant`,
so `currentRole`, `currentCompany`, `headline`, `location`, `totalExperience`, `appliedAt`,
`contactedAt`, `applicationStatus` and even `name` were replaced by whatever the newer read had,
including `null`. Every re-collection already had this: rule 12a pauses a scan the moment the tab is
hidden, `revealPanelContent` gives up on a column it cannot move, and a re-mount can leave a section
unread — so a second visit that saw less than the first **deleted the difference**, silently, and the
record then looked exactly like an applicant who has no current role. `APPLICANT_SCALAR_FIELDS` names
the fields a merge protects one by one (kept in step with `normalizeApplicantRecord` by hand, so a
future field is a deliberate addition rather than a silent inclusion), and `resume` gets the same
per-field treatment: `available` is OR-ed because a resume seen once exists, and a `not_attempted`
status keeps the stored verdict, because **"I did not look" is never "there is nothing"** — which
generalises `keepDownload` rather than replacing it. It stays *prefer-filled*, not prefer-stored: a
newer value that exists still wins, or a corrected name could never land.
`saveApplicant` ([applicant-db.js](src/applicant-db.js)) always merges, so the streamed mid-run save
is idempotent.

**Resumes are downloaded by the service worker, never by the content script** — a content script has
no `chrome.downloads`. Three refusals before any fetch: a host that is not `linkedin.com`/`licdn.com`,
a URL any stored record already reports as `downloaded`, and a URL the page never rendered. Files land
in `profile-vault-resumes/` with `saveAs: false` and `conflictAction: "uniquify"`, because a
600-applicant run must not ask 600 questions or overwrite 600 files.

**Getting the file rather than a preview** (3.7.7). The download was wired in from 3.7.1 and the
applicant's name reached the filename intact; four other things kept a preview on screen and no file
on disk.

- **A viewer that would not close was left open, silently.** `closeOpenedOverlay` dispatched a
  synthetic Escape (`isTrusted: false`, which many overlays ignore) and then looked only for a
  `<button>` **inside** the matched element — LinkedIn renders that control as an `<a>` or a
  `[role="button"]`, often in the modal wrapper rather than the content. And the boolean it returned
  was discarded at every call site. It now retries, searches the wrapper too, and
  `dismissResumeViewer()` **records the result and warns on the record**. Still one click; the budget
  is still five.
- **A viewer that never writes the address down is read from what it *fetched*.**
  `fetchedResumeDocumentUrl()` reads `performance.getEntriesByType("resource")` — an observation of
  what the page requested, not a guess — through the same `isResumeDocumentUrl()`, so it can no more
  return a route than the attribute sweep can. **Its `since` floor is mandatory and is the whole
  safety of it:** the entry buffer belongs to the *document* and a run walks hundreds of applicants
  through one without navigating, so unbounded it would save applicant one's CV under applicant two's
  name — worse than no file at all (rule 6). The floor is `performance.now()` stamped **before** the
  click, and the function refuses to answer without one.
- **But that buffer stops recording, so the requests are OBSERVED rather than read back** (3.7.12).
  Reported as *"it saved the resume for seven profiles but not after that"* — and there is no budget,
  cap or retirement anywhere on the resume path that stops at seven, because the limit is the
  browser's. The resource timing buffer holds **250 entries** and **silently** stops recording when
  it is full: no error, no exception, no change in what the call returns. A run walks hundreds of
  applicants through **one document** without ever navigating — that is the whole of the permanent
  flow — and an applicant costs a few dozen requests, so the buffer fills around the seventh and
  `fetchedResumeDocumentUrl` can never see a document request again. Every applicant after that is
  `no-document-url` → `link_only`: a link, a file name, and no file, silently, because `link_only`
  is a legitimate outcome for an applicant whose resume genuinely has no address.
  `watchResumeRequests()` ([applicants.js](extension/content-scripts/applicants.js)) is a `PerformanceObserver`, which is not
  subject to that buffer at all — entries are delivered as they are created — so it cannot stop
  working however long the run goes on. It is still an *observation of what the page did*, and
  `isResumeDocumentUrl()` still decides, so it can no more return a route than the sweep can.
  **`buffered: false` is its whole safety and is not optional:** a buffered observer replays what is
  already in the timeline, which is the *previous* applicant's document. Unbuffered it can only ever
  see requests made after it was created, immediately before this applicant's viewer is opened —
  structurally stronger than the `since` floor rather than a relaxation of it. It starts before the
  click and is disconnected in a `finally`, because a run walks hundreds of applicants through one
  document and a leaked observer per applicant grows with the job. `fetchedResumeDocumentUrl` stays
  as the fallback for a browser where no observer can be constructed, floor and all.
- **A download Chrome interrupted is never reported as saved.** `downloadedFilePath` returned the
  requested path on `state === "interrupted"` and the caller still answered `downloaded`, so a
  `resume_file` named a path that is not on disk — and `mergeApplicantRecord`'s `keepDownload` then
  protected that wrong answer forever.
- **The second attempt is made from the page.** `chrome.downloads` uses the browser's cookie jar, so
  the direct download is tried first every time; when it comes back interrupted the content script
  fetches the same address with `credentials: "include"` from the tab that rendered it, refuses an
  HTML answer and anything over 25 MB, and hands the bytes to the worker as a `data:` URL. The worker
  still owns `chrome.downloads`, and the **address** is still what every refusal is applied to.
- `state.downloadedResumes` is a `Map`, so `already_saved` names the file it landed as. `logResume()`
  puts one line per applicant in the console: where the address came from, whether the viewer closed,
  whether the file landed, and why not — the same discipline `logSectionScan` was written under.

## The whole-job walk — every applicant, across every page (3.7.10, amended in 3.7.13)

**Requested outright: "collect all applications across multiple pages in sequence, one at a time,
save the applicant's name, then the next one; page ends, then next page — like we did in
connections."** The connections surface has always had two separate commands for exactly this reason:
**Find All Connections** enumerates the list and saves rows without extracting anything, and **Start
Profile Extraction** reads what was found. *Who applied* and *what is on their profile* are different
questions, and the second costs hours where the first costs a walk down the list.

**⚠ Collect Every Applicant was REMOVED in 3.7.13, and this is what remains.** Requested outright:
*"remove Collect Every Applicant, its code and function and feature ... that will not affect any
other button or any other feature."* It was never a second walk — `options.listOnly` chose between
two **per-row bodies** inside one loop, and everything that makes a run a run was already shared:
the row loop, the identity ledger, the roster and page boundary, `growApplicantList`, the pagination
(rule 9h), the conclusive-stop rule, the collected index, the arrival guard, the auto-run and the
reload-resume. By 3.7.11 the two bodies had converged as well — this one opens each applicant,
discloses their contacts and saves their resume — leaving `expand: false` and the floor name as the
only differences. So removing it removed **one branch and one button**, not a capability. The flag
is still accepted and simply no longer read, so a run armed by the previous build resumes rather
than falling into a branch that is gone. Locked by *"Collect Every Applicant is gone, and it took
nothing else with it"*, which asserts both halves — the button and the branch are absent, and
Collect This Applicant, Collect Applicant List, `extractApplicant`, the roster, the pager, the
resume chain, the contact disclosure, the auto-run and the seven-click budget all still stand.

- **There is one per-row path, and it is `extractApplicant`** — the same one `PV_APPLICANT_EXTRACT`
  calls for a single applicant, so this surface has one reading rule and one click budget rather
  than two that can drift. `Applicants.buildApplicantListRecord()` is built from the row itself and
  streamed to the store with `PV_APPLICANT_SAVE` as the **floor** (see below).
- **It opens each applicant, lets the panel load, walks it to the bottom and takes what the panel
  rendered** (`collectVisibleApplicant`, 3.7.10 — requested outright: *"slow down on every profile,
  let it load fully, scroll to its bottom, then move onto the next"*, then *"capture name, current
  role, current company, total experience and education — what is normally visible on the profile
  page, not hidden behind any button"*).
- **And since 3.7.11 it discloses the contact details and saves the resume**, requested outright:
  *"I want the extension to be able to get contact info from the contact info button given in the
  profile AND I WANT THE RESUME TO BE DOWNLOADED IN THE DISK WITH THE NAME OF THE PROFILE OWNER."*
  Both were already built and both were switched **off** for this pass, which is the whole of why
  neither happened. `contact` gates `openContactAndCollect`, the control rule 9d already names and
  already opens once per applicant; `resume` gates `collectResume`, which is the entire PERMANENT
  resume chain — the address is looked for without opening anything, the viewer and its own Download
  control are the fallback, the link is recorded *before* the download is attempted, and the worker
  saves the file. **The name it is saved under was always the applicant's**
  (`Applicants.resumeFileName` over `header.name`, sanitized, de-duplicated with ` (2)`); nothing on
  this surface ever asked for the file.
- **It is `extractApplicant` with one flag off, not a second reading rule.**
  `VISIBLE_ONLY_OPTIONS` is `{ expand: false }`: `expand` is `expandCollapsedSections`, and it also
  becomes the scan's expansion budget so the second expander pass at the bottom of the walk is
  skipped too. It stays off because it opens *collapsed sections* rather than revealing a field this
  pass exists for, and it is worth up to `MAX_EXPANSIONS` (8) clicks per applicant on a walk that is
  already the slow part. Every control that is now pressed is one rule 9 names and gates
  individually, so the per-file click budget is untouched. `current_role`, `current_company` and
  `total_experience` are still `deriveCurrentPosition` and `totalExperienceFrom` over the Experience
  cards the panel rendered, exactly as when a single applicant is collected: **one** definition of
  "current role" on this surface rather than a second that can drift from it.
- **The row's own name is the FLOOR, and only when it is needed.** `extractApplicant` saves whatever
  the panel gave it; a row that never opened, or a panel that resolved no name, would otherwise
  leave the column the whole export is read by empty while the row plainly rendered it. Safe because
  both halves of the store are merge-only — `saveApplicant` reconciles on job + applicationId so the
  floor lands *on* the record just written rather than beside it, and `mergeApplicantRecord` never
  overwrites a filled field with a blank, so it can only fill the gap and never flatten the details.
- **A profile that would not open never loses the person**, and the failure is named in `lastError`.
  A hidden page is a pause with the same `MAX_HIDDEN_RETRIES` bound the full run applies, or a panel
  that reliably hides the tab would re-run one applicant for as long as the tab is left alone.
- **It paces itself** (`LIST_PROFILE_PACE_MS`), because a run walks hundreds of panels back to back
  on the recruiter's own session and the connections importer has paced between profiles since 3.3.
  ⚠ This makes a pass cost **tens of seconds per applicant** rather than a millisecond — a
  665-applicant job is hours, not minutes. That is what makes the listed-index skip below load-bearing
  rather than an optimisation.
- **And it paces itself to the page, not to a number chosen in the source** (3.7.14). Every quiet
  window here is a guess about a page nobody measured, and it has to be a pessimistic one — so a
  machine that renders an applicant instantly pays a struggling machine's budget on every pass, of
  every walk, of every applicant. The page can be asked instead: `waitForDomQuiet` already runs a
  `MutationObserver` over the document, so it knows for free whether anything changed while it
  waited. Three samples of that pick one of three tempos, and the window is scaled to it
  (`TEMPO_SCALE`, `quietWindow()`), as is the breath between applicants (`PACE_BOUNDS`, randomised
  within its band because a run that pauses for exactly 900 ms hundreds of times is the one shape a
  human session never has). **The asymmetry is the safety**: one wait that hits its timeout drops the
  page to `slow` immediately and buys it a window *longer* than the source ever asked for, while
  reaching `fast` needs every recent wait to have observed **nothing at all**. `timeoutMs` is never
  scaled — the caller's ceiling is what stops an unsettled page holding one applicant, and a tempo
  that could stretch it would turn a slow page into a stuck run.
  **What this may and may not do**: a shorter window can only take a read a moment early, and an
  early read costs nothing on this surface by construction — `snapshotPanel` is merge-only, every
  walk re-reads on every pass, and each quiet counter resets the instant anything grows. What it must
  never do is *end* a walk, so `REVEAL_MIN_PASSES` (4), `REVEAL_QUIET_PASSES` (3) and the
  reached-the-bottom test are untouched and the tempo has no say in any of them. Worst case is one
  extra pass. `waitFor`'s poll interval starts at `FAST_POLL_MS` and backs off to the caller's own,
  which changes only how *late* an already-true condition is noticed — same predicate, same timeout,
  same verdict. `beginRun()` resets the tempo, because a page-condition verdict is never carried
  across runs (the rule `wentHidden` is re-derived under). The run reports the tempo it was held at
  on `listScroll.tempo`, because "the run was slow" and "the page never settled" are the same
  sentence from two ends and only one of them names a cause. Locked by *"the quiet window follows the
  page, within bounds it can never leave"* and *"adapting the pace changes what a wait costs, never
  what a walk concludes"*.
  **⚠ A wait held over something designed to repaint may not testify** (3.7.21,
  `waitForDomQuiet(…, { sample: false })`). The whole inference above holds only while the mutations
  being watched are *the page's own hydration*. LinkedIn's document viewer renders and re-renders PDF
  pages for as long as it is open, so a wait held over one **can never** observe a quiet window and
  always ends on `timeoutMs` — recording `"unsettled"`. Combined with the asymmetry that is the
  safety everywhere else, **one** such sample pinned the run to `slow`, so opening a single resume
  made every applicant after it pay a 1.25× window and the 900–1300 ms band, on evidence about a PDF
  renderer rather than about the page. Excluding those waits makes the measurement *more* accurate,
  not more optimistic — it removes a reading taken with the thermometer held against the radiator.
  The wait is unchanged in every other respect: same window, same ceiling, same resolving condition;
  only the verdict is withheld. **Sampling is opt-out**, so a wait added later testifies unless it is
  deliberately excused, and the excused ones are capped at two by test — the tempo is only worth
  having while almost every wait feeds it, and this must never become the way to make a run faster.
  `scrollResumeViewer` is the one caller. Locked by *"a repainting viewer cannot testify about the
  page, and one resume cannot slow the rest of the run"*.
- **The resume step pays for itself and not for the applicants after it** (3.7.21). Three fixed
  sleeps on that path were costs without a corresponding benefit, and none of them decided anything.
  `clickResumeDownload` ended with `waitForDomQuiet(150, 900)` so the request would have been made
  "when the entry log is read" — but it does not read the entry log; the **caller** does, by polling
  `waitFor(… requests.url() …)` over `RESUME_DOCUMENT_TIMEOUT_MS` with `watchResumeRequests()`'s
  observer live since before the viewer opened. A fixed sleep in front of a poll can only make the
  answer arrive *later* than the poll would have noticed it, and the poll already covers a slower
  network than the sleep ever did. `closeOpenedOverlay` slept 250 ms **before** its first check and
  again after clicking a close control; it now polls the same predicate to the same 250 ms ceiling,
  and deliberately **not** through `waitFor` — that calls `assertRunnable()` on every poll, so a Stop
  or a hidden page would throw straight out of a *dismiss* and leave the preview on screen, which is
  the complaint that function exists to answer. Still exactly one `.click()`. And the worker's
  `downloadedFilePath`, which the content script **awaits** before advancing, backs off from 25 ms to
  a 240 ms ceiling instead of polling flat at 120 ms — its ten intervals sum to *more* than the flat
  poll's, so a genuinely slow download gets at least the budget it had, and a test computes that sum
  rather than trusting the constants. The PERMANENT chain of rule 9i is untouched throughout.
  **What was NOT done, and why**: the request that prompted this also proposed skipping the applicant
  list scroll. `sweepCurrentPage` runs once per *page* of 25, not once per applicant — ~0.2 s each,
  under 1% — and it is the sole producer of the rows above the current scroll position, the
  confirmed-bottom test, the page membership the pager is gated on, and vanished-row retirement.
  Removing it re-introduces both defects 3.7.12 fixed and loses applicants silently.
- **From the row itself: the name and the two ids, and deliberately nothing else.** The row also
  renders a headline and a location; taking them would mean deciding that line two is the headline
  and line three is the location — positional guessing on generated markup, which rule 11 refuses and
  rule 6 makes worse than an empty field. Everything beyond the name comes from the **panel**, which
  labels its own sections. `cleanApplicantName` still strips the `· 2nd` degree badge, and
  `extraction.rawData.list_row` records the provenance, because a name-only record and a full
  extraction that found nothing call for opposite responses.
- **A row that is not a person is no record at all.** `buildApplicantListRecord()` returns `null`
  unless `isApplicantNameCandidate()` accepts the name, and the walk skips that row. The live defect:
  an applicant saved as **"Edit qualifications"** — the list renders that link in its own header
  ("Here are all applicants to your job. Edit qualifications") and its `href` carries the same
  `applicationId` the page is on, so **nothing about the link tells it apart from the open
  applicant's row**. The text does, and that policy already existed and already knew this exact
  phrase: `NAME_CONTROL_PHRASE_PATTERN` was added when the *panel* path saved people under the same
  label. The list pass simply never asked; it asks now, and asks the **one** policy rather than
  growing a second list of its own.
- **And it is refused before it is ever a row at all** (3.7.11), because rejecting it late was still
  losing the applicant it collides with. `applicantRowKey` keys a row on the `applicationId` in its
  own href — the only identifier a row carries before it is opened — and that header control's href
  carries **the id the page is currently on**, so the control and the **open applicant's own row**
  hash to one key. The control renders above the rows, so the walk reached it first, retired the key
  on its terminal outcome, and `unprocessedApplicantRows` then filtered the real row out as already
  finished with. The applicant whose panel was open when the run started was never opened, and since
  a pager click leaves LinkedIn showing the new page's first applicant it was **one lost person per
  page, silently, with no error anywhere** — exactly the reported "in every page's list the first
  name is skipped". `Applicants.isApplicantRowLabel()` refuses a link whose own label is a control
  phrase or page chrome, and `isApplicantRowLink()` consults it, so such a link never becomes a row
  and can never claim a key. Judged on the **label**, never the href, because the two addresses are
  genuinely identical. Judged on `textContent` rather than `innerText`, because this runs for every
  anchor of every list scan and a layout flush per row is the exact cost the row's lazy name getter
  exists to avoid. And **never on the `aria-label`**: "View Komal Sharma's application" is an
  entirely plausible accessible name for a row and it leads with a verb, so judging it would refuse
  every row on the page rather than one control. An **unlabelled** link is accepted and judged by its
  href exactly as before — losing a real applicant is the failure being fixed, so a link this cannot
  read is never one it refuses. **"Does this address name an application" is a separate question and
  stays separate** (`hasApplicationHref`): the panel's own application link is what
  `panelApplicationId` reads the arrival verdict from, and it is labelled whatever LinkedIn labels it
  — `View full profile`, `Resume`, an icon with no text — so judging *it* as a row would refuse it and
  drop that answer back to the address bar, which is the one source the arrival test exists not to
  trust.
- **The job header is read once per run**, not per row: it sits above both columns and does not
  change as the list is walked, so reading it per row would be hundreds of forced layouts for one
  unchanging answer — the same reason `applicantRows()` made its name a lazy getter.
- **A record with nothing on it is not a collected one.** `isCollectedApplicant` needs one
  substantive field, so a later run still opens the people a broken one left thin rather than
  walking past them forever.
- **One "already have them" question, asked the same way by both commands** (3.7.11). Both ask
  `createCollectedIndex` — "is this person **collected**", meaning the record carries at least one
  substantive field — and `createListedIndex`, the "do I already **have** them" variant the list pass
  used to ask, is **gone**. It existed for exactly one reason: that pass wrote name-only records,
  which `isCollectedApplicant` correctly refuses to call collected, so a resumed pass would have
  re-walked the whole job. The moment it started opening each applicant and writing a full record the
  reason evaporated, and what was left was actively harmful. **The defect it caused, reported
  directly: *"even if I click the extension to start again it does not scroll the profile."*** Every
  path that leaves a thin record behind — a panel that would not open, a scan the tab going to the
  background interrupted, a run that could not confirm who it was looking at — writes the row's own
  name as a floor, deliberately, so nobody is lost. A have-them index counts every one of those as
  done, so the applicants a broken run **failed** on became precisely the ones the next run walked
  straight past, and no number of button presses could reach them again. One substantive field is the
  test that tells a complete read from a failed one. `PV_APPLICANT_COLLECTED` still sends **every**
  stored entry with the verdict beside it rather than filtering on it — the index applies the verdict,
  the worker only reports — so nothing about the payload changed. `options.recollect` asks for the
  whole list again regardless.
- **Two earlier changes are what make a re-run safe**, and neither is incidental: `saveApplicant`
  reconciles on `job.id + applicationId` (rule 14, v6) so a second pass enriches *this* record
  instead of creating a second one under a different hash, and `mergeApplicantRecord` protects every
  scalar field by field (3.7.10) so a blank never erases a stored value.
- **The profile extraction was never the thing removed.** `extractApplicant` and everything it
  drives is untouched, and since 3.7.13 it is what this walk calls for every applicant as well as
  what `PV_APPLICANT_EXTRACT` calls for one. A test asserts there is exactly one of it.
- Its own button, **Collect Applicant List**, on the Applicants page and in the popup — the only
  whole-job command since 3.7.13. It rides `PV_APPLICANT_COLLECT_ALL`, so the armed options travel
  with it and returning to the tab resumes the run. **`recollect` travels with it too**: it is a
  property of a *run* — "walk past the people already saved, or open them again" — and never
  belonged to one button, so when the button it was first added beside went, it moved rather than
  being deleted. Unchecked it sends `false`, which is the walk's own default, so the surviving
  button's behaviour is unchanged by default. The popup's `runApplicantJob` keeps the
  close-only-on-`{ok, started}` discipline (see below), and deliberately stays separate from
  `runImport`, which Collect This Applicant shares and which must never close the window.

## Collecting every applicant (3.7.3, amended in 3.7.4, 3.7.6 and 3.7.12)

**The walk is the page's own order, and a page is finished before the pager is pressed** (3.7.12).
Requested outright, and reported in two halves that turned out to be one cause: *"it is saving a
profile, going to a specific profile, then to the next, saving, then back to that specific profile,
then next"* — and *"it did not even collect all the applicants in one page ... make sure it is
working in a sequence, collecting all applicants before moving to next page."*

The walk's whole notion of the list was `applicantRows()`: whatever the DOM has mounted at the
instant it is asked. That answers neither question it was being used for.

- **It cannot say what order the page is in.** LinkedIn re-centres the virtualized window on the
  applicant whose panel it has just opened, so rows *above* the one just collected keep re-mounting.
  They are unprocessed and they render first, so "the first rendered row I have not finished with"
  walked backwards, then forwards, then backwards again — the reported back-and-forth, exactly.
- **It cannot say who is on the page.** A run that arrives with the list scrolled anywhere but the
  top — which is where LinkedIn leaves it, on the applicant it had open — never mounts the rows above
  that point, because `growApplicantList` only ever scrolls **down**. The pager was then pressed with
  part of the page never opened, and nothing anywhere noticed.

So the page is settled before anybody on it is opened. `sweepCurrentPage()` ([applicants.js](extension/content-scripts/applicants.js))
scrolls the page from the **top** to a confirmed bottom, feeding `Applicants.createApplicantRoster()`
([applicants-core.js](src/applicants-core.js)) on every pass, and hands the list back at its top so
the page starts at its first row. After it, the roster **is** the page: `roster.next(processed)` is
the next row in the page's own order whether or not it is mounted, and `roster.remaining(processed)`
is what the pager press is gated on. Four properties are load-bearing:

- **The next row is waited for, never substituted.** `roster.sort()` puts a mounted window back into
  page order, so when the owed row is mounted it is `pending[0]` and the common case costs one string
  comparison. When it is **not** mounted the run sweeps for *that row* and opens nobody else in the
  meantime. Only a row that survives a confirmed walk of the whole page is retired — one at a time,
  and said out loud — because by then it is not on the page any more.
- **Merge-insert, never append.** A window is a *slice*: a row seen for the first time belongs
  between the rows it rendered between, not after everything already known. Appending would place a
  late-mounting row after rows that come after it, which is the ordering defect in a different
  costume.
- **A row of unknown position sorts last.** Guessing it belongs at the front is how the walk jumped
  backwards to begin with.
- **A pager press is a new page**: the roster is reset and the new page is settled in its turn,
  before its first applicant is opened. `pageSettled` is what carries that across turns.

It costs one walk of ~25 rows per page and it is **not** the up-front walk 3.7.8 removed — that one
walked the whole list, every page of a 665-applicant job, before a single person was opened. This
walks the page the run has just arrived at, and only that page. `sweepCurrentPage` presses nothing
and never so much as looks for the pager (a test asserts both), so paging forward stays the caller's
decision, made only once the roster it settled has been finished with. Every list scan the run
already makes feeds the roster (`unprocessedRows()`), so a row LinkedIn mounts late is merged into
its own place at no extra cost. Locked by *"the walk follows the page's own order, and a page is
finished before the pager is pressed"* and *"the page is settled before anybody on it is opened, and
the pager waits for it"*.

**A section that is not found produces no warning, only zeros — so the search has to report itself.**
`current_role`, `current_company` and `total_experience` all derive from the Experience section and
from nothing else (rule 7, `deriveCurrentPosition`), so an empty column never means "no job": it means
**no experience card was ever read**. Three releases fixed a different cause each and the columns were
still empty, so 3.7.6 stops guessing and records what the search saw. Every extraction builds
`diagnostics.sectionScan` — the selector targeted (`HEADING_SELECTOR`), the patterns matched against,
**every visible heading in the panel and on the page with the key each one resolved to**, where each
section was found (`panel` / `page` / `panel-label` / `page-label`), its root, its block count and a
text sample, and the sections nothing named — and `logSectionScan()` puts one grouped line per
applicant in the hiring page's own console, a warning when experience is empty. **A heading listed
with an empty `key` is a wording `SECTION_PATTERNS` does not know yet**, which is the whole failure
mode in one line. It is built once, after the walk, because it reads `innerText` page-wide.

**A section title is still a section title with a count, a qualifier or a colon after it** (3.7.6).
`^experiences?$` matched the bare word only, so `Experience (5)`, `Work experience` and `Experience:`
named no section at all. `sectionKeyFor()` strips an inline count with or without brackets and a
trailing colon; the patterns accept `work`/`professional`/`employment`/`career`, `Educational
background` and `Top skills`. `sectionLabelsIn()` is the last resort for a title LinkedIn did not mark
up as a heading — a short leaf whose own text *is* the section name, matched on rendered text and
never on a class name (rule 11), asked only for the keys nothing else produced, with `textContent`
measured before `isVisible` so the common case costs no layout.

**A section's root is bounded by every other heading, not by the next one** (3.7.6). Bounding on the
next heading alone let the chosen ancestor reach back over the section *above* it — and the page-wide
pass refuses exactly that (a root swallowing a second section), so the widened search returned nothing
for the one section most often outside the panel. A tighter root is also more honest: the blocks read
out of it can only be that section's.

**A section whose blocks parsed to nothing must still be read.** `readExperience` and `readEducation`
returned 0 whenever the markup offered list items that yielded no record, never reaching the text
fallback; they now fall through on `added === 0`. The accumulator is keyed, so a card reached both
ways is stored once.

**The section map is built once per snapshot** and handed to all seven readers. Each one used to
rebuild it — seven page-wide heading scans per read, dozens of reads per applicant, and seven chances
for two readers to disagree about where a section was.

**Identifying the scroller is a guess; do not build only on it.** 3.7.3 fixed the scroll *target* and
`current_role`, `current_company` and the resume were still empty on every row. Every position-based
walk in this codebase depends on having named the one container that scrolls, and getting it wrong is
**silent** — the walk runs, the position never moves, the first read is already the bottom.
**`revealPanelContent()`** ([applicants.js](extension/content-scripts/applicants.js)) does not need to know: it drags the bottom
of the panel into view with `scrollIntoView`, and the browser scrolls every scrollable ancestor the
element needs. Bounded by `REVEAL_MAX_PASSES` (40) and `REVEAL_QUIET_PASSES` (3) on the same
"growth means new content, never a scroll that happened" rule discovery uses, stoppable at every pass,
and it runs **before** the second expander pass because what it reveals may itself be collapsed. It
can move the document, so `scanApplicantPanel` remembers `window.scrollY` too and restores both.

**A container-scoped search is only as good as the container.** `applicantPanel()` picks the
*smallest* container carrying the most section headings — and a heading that has not hydrated does not
count — so it can resolve to a **sub-container of the real detail column**, leaving Experience,
Education and Skills invisible for the whole extraction. That is exactly why `current_role` and
`current_company` were empty on every row: `deriveCurrentPosition` already falls back to the first
entry, so an empty column meant no experience had been read at all. `buildSectionMap()` therefore
falls back to a **page-wide** search for any section the panel did not hold. Nothing else on a hiring
page renders an Experience or Education heading, so it cannot pick up another member's card — and the
widening refuses any heading or root inside the applicant list, and **any root that swallows a second
section**, because a wrong entry is worse than an empty one (rule 6).

**Widen the search, never the rule.** `findResumeDocumentUrl()` used to look at four tag shapes and
decide with a *local* extension regex, so a viewer handing its document to a plugin through
`data-source-url` — or a media host with no extension in the path — produced nothing, and every
applicant came back `link_only` with no file and no link. It now reads `DOCUMENT_URL_ATTRIBUTES`
across the **viewer, then the panel, then the page**, and the decision is
`Applicants.isResumeDocumentUrl()` — the same tested rule the record uses, which refuses a
`linkedin.com` page address *first*. So the wider search still cannot return a route. The document URL
is **waited for** over `OVERLAY.OPEN_TIMEOUT_MS`, not sampled on the frame the viewer appeared: the
viewer mounts its shell before it fetches the file.



**⚠ PERMANENT — a started run keeps going, including across a reload.** Requested outright: *keep
going once I start, as long as I am on that tab, even if the page reloads.* The worker holds the
standing instruction and `claimAutoRun()` refuses to re-arm a job whose execution reported
`COMPLETED` — deliberately, so a finished job is not walked forever. **That makes a false completion
far worse than a stop: it permanently disables the reload-resume.** So only a walk that actually
reached the end of the list may complete a run. `Applicants.isConclusiveListStop()` names the two
verdicts that qualify — `settled` and `pagination-retired` — and everything else
(`grow-budget`, `no-list`, `pagination-refused`, `list-exhausted`) is an excuse meaning "I could not
tell yet", retried up to `MAX_INCONCLUSIVE_GROWTHS` (3) and reset by any growth that produces a row.
Exhausting the retries is `RUN_STATE.STOPPED`, never `COMPLETED`, which reaches the worker as
`AUTO_RUN_STATE.INTERRUPTED` and leaves the job restartable. `walk.stoppedBy` is reset to `running`
at the **start of every growth call**, because the ledger is shared across calls so `fruitless` can
retire a pager over a whole run, and a verdict read more than once must describe the call that just
ran. `LIST_GROW_PASSES` (16) covers roughly 8000px of scrolling, so treating budget exhaustion as
the end of the list finished long jobs in the middle *and* stopped them ever resuming. Locked by
`PERMANENT: only a walk that reached the list end may complete a run`.

**⚠ PERMANENT — the required flow, and the page never moves.** Stated by the user and binding:
`click applicant in left list → wait for right panel → scroll right panel completely → extract →
save → click next applicant`. Every clause of it is load-bearing.

- **The page and the left list stay mounted.** A run changes applicants by *clicking*, never by
  navigating: there is no `location.reload/assign/replace` and no `location.href =` on this surface,
  and LinkedIn swaps only the right panel underneath.
- **One click per applicant, and only a row of the left list** — `selectApplicantRow`, gated by
  `classifyApplicantControl` and proven inside the list (rule 9g), with exactly one `.click()`.
- **Then it waits for the right panel** — for *that applicant* to be **mounted**, decided by
  `Applicants.describePanelArrival()` from identifiers rather than from the address bar or the
  panel's text (rule 9g, amended in 3.7.10), then for the DOM to go quiet, then it **asks again**.
  And the record is refused outright if the panel is showing anybody else
  (`assertExpectedApplicant`), because a wait is a race that can be lost and losing it saved three
  applicants under one name. **Nothing may click again
  while a profile is still loading**: the caller advances only on the resolved value, an applicant
  already shown is not re-clicked (`panelAlreadyShowing`), and a row that came up as **somebody else**
  is *skipped* rather than scanned as them — with the arrival verdict's own reason on
  `state.lastArrival`.

  **⚠ "Already open" is the PANEL's answer, never the address bar's** (amended in 3.7.16, and this
  clause was written by breaking it). That test was `rowId !== openId` — a comparison against
  `location.href` — and on a true answer it skipped the click **and with it all three waits above**.
  The address bar is the one source this rule already refuses everywhere else, because LinkedIn
  **routes ahead of the render**: the claim is true while the column is still showing the *previous*
  person. It is true at exactly two moments the run did not itself create — the recruiter's own open
  applicant when a run starts, and **the pager press**, after which LinkedIn selects the new page's
  first applicant and writes their id into the address before mounting them. Once per page, which is
  the whole of the reported *"the first applicant on every page is saved twice"*. Reading the stale
  panel then failed two ways: when it rendered its own application link `assertExpectedApplicant`
  threw and the row was opened again with the previous applicant re-read in between — the visible
  *"it goes back to a specific/previous profile before moving on"* — and when it rendered none,
  `describePanelArrival` can only answer `arrived` ("mounted, and no id was rendered to check it
  against"), so the **previous** applicant was scrolled again, their contact disclosure opened again
  and their resume downloaded again, and that read was filed under *this* row's application id. One
  person written twice, silently, with no error anywhere. **No store-side deduplication can catch
  that** — it is the wrong person under the right key, not a duplicate key. So the address bar is a
  *hint* that makes the question worth asking, and `panelAlreadyShowing()` only accepts it once
  `describeApplicantArrival` says the panel itself is showing this applicant. A panel positively
  showing somebody else — `OTHER`, or `PREVIOUS` against `state.lastPanelIdentity`, the identity the
  run recorded when it finished the last applicant — ends the wait at once and the row is **clicked**,
  because clicking the row the walk is owed is the whole of moving forward. `torn-down` and `mounting`
  still mean only "I could not tell" and are still waited out. It presses nothing and adds no control:
  a confirmed panel is one click saved, exactly as before, and the seven-click budget is unchanged.
  **The wait is time given to the panel, not a verdict on the applicant** (3.7.11): a wait that
  cannot be answered — `torn-down` from a panel this markup will not let it resolve, `mounting` from
  one whose headings it cannot see — used to skip the person, and that stopped the run reading anybody
  after the first. It reads them, and `assertExpectedApplicant` refuses the record if the panel turns
  out to be somebody else. **Waiting for the right panel is permanent; skipping on an unanswerable
  wait never was.** See rule 9g for the whole chain.
- **Only a column scrolls, never the recruiter's page.** `anchorPage()` wraps **every**
  `scrollIntoView` on this surface — the detail-panel reveal and the list nudge — snapshotting the
  document position and putting it back on the same frame. `scrollIntoView` stays the mechanism
  because it needs no guess about which container scrolls (see below); anchoring keeps its one cost,
  "every scrollable ancestor" including the document, off the page. A `scrollIntoView` that escapes
  `anchorPage` drags the whole page around for the length of a run, and a test asserts there are
  exactly two and both are anchored.
- **Movement is measured relative to the panel** (`offsetInPanel`), not in viewport coordinates.
  Holding the page still would otherwise read as a column that refused to scroll, retire the anchor,
  and end the reveal early — the 3.7.6 failure by another route.

Locked by `PERMANENT: one click per applicant, wait for the right panel, scroll only that column`.

**The hiring surface scrolls a *column*, not the page, and one policy does not fit both surfaces.**
The applicant detail panel and the applicant list each own an independently scrolling container,
inside a page that moves only its own nav and job header. `Connections.chooseScrollTarget()` is tuned
for the opposite arrangement — on the connections list the document *is* the scroller and the tallest
inner container is a filter panel — so it scores `isScrollingElement` at **+60** and *penalises*
depth. The moment the hiring page had any range at all it won, the column never moved, `maxPosition`
was satisfied on the first read and the scan settled having seen one screenful.

- **`Applicants.chooseColumnScrollTarget()`** ([applicants-core.js](src/applicants-core.js)) is the
  mirror image and is consulted **first**: it refuses the page outright, requires real range, a
  scrolling `overflow-y` and a candidate that carries the content being read, and prefers the
  **innermost** such container. It returns `null` when no column qualifies, and only then does
  `chooseScrollTarget()` fall back to the tested general chooser.
- **`scrollCandidates()` offers descendants as well as every ancestor.** Which side of the scroller
  `applicantPanel()` lands on is markup's choice. A descendant qualifies only if it carries
  ≥ `COLUMN_TEXT_SHARE` (60 %) of the panel's text, so a filter or a menu is refused — the same rule
  the connections chooser applies when it demands the container hold the list.
- **`maxScrollPosition()` reads `clientHeight` live** (`viewportOf()`), because `scrollHeight` always
  did and mixing the two ends the walk early.
- **`livePanel()` re-resolves the panel on every step.** The surface re-mounts the detail column as
  sections hydrate, and a detached node keeps answering `innerText` with what it held when it was
  unmounted. The scroll target is re-chosen after the first paint for the same reason.
- **The expander runs twice** — before the walk and again at the bottom, where late-mounted sections
  finally exist — sharing one `createExpansionBudget()`, so `MAX_EXPANSIONS` is still eight in total.

**A run resumes; it never starts over.** `Applicants.createCollectedIndex()` is keyed on the
`applicationId` in each row's own href, because that is the only identifier a row carries **before**
it is opened — the record's `id` needs the profile URL, which only the panel shows. The name stands in
only for a row with no id, and the index is scoped to the job, because an applicant is a person *on a
job*. `Applicants.isCollectedApplicant()` requires **one substantive field**, deliberately not "a
record exists": a row saved with nothing but a name is a run that *failed* on that applicant, and
skipping it would make the failure permanent. The worker answers `PV_APPLICANT_COLLECTED` with one
lean entry per stored applicant and the verdict already made by the core. A worker that cannot answer
skips **nobody**, never everybody. `options.recollect` asks for the whole list again on purpose, and
the Applicants page exposes it as **Re-collect already saved**.

**Pressing an applicant button takes the recruiter to the page** (3.7.5). Both commands are pressed
from the extension's own Applicants page — a different tab, often in a different window — so
`revealApplicantTab()` activates the hiring tab **and focuses its window** (`Tabs.activate(id,
{ focusWindow: true })`). A tab activated in a window the user is not looking at is, to them, a button
that did nothing. This is the second of exactly two places allowed to take focus; the other is the
sign-in page, and the heartbeat-driven import run still never does.

When **no** hiring tab exists, `resolveApplicantTab()` re-opens the last hiring page the extension was
actually on, via `Tabs.ensureApplicantTab()` in the window the command came from (`rememberOrigin`
runs first, exactly as workflow step 1). Through 3.7.4 it raised an error instead. **Only a remembered
address is ever used** — `rememberHiringUrl()` accepts a resolved tab's URL or a collected record's
`extraction.sourceUrl` and nothing else, because welding a job id into a guessed path is the same
class of mistake as guessing a resume link. With nothing remembered it still says so. `APPLICANT_TAB`
is tracked so a second command reuses the tab rather than opening another, and it is deliberately
**not** closed by `closeCollectorTabs()` — it is the recruiter's own working page.

**A run must be startable again without a page reload.** `beginRun()` clears the stop flag *and*
re-derives `state.wentHidden` from what the page is right now. The old code cleared only `aborted`,
and `wentHidden` — latched by `visibilitychange` the instant the recruiter switches to the extension's
own Applicants page — threw "the page is hidden" out of `loadEveryApplicantRow` before a single row
was read. Only re-injecting the content script cleared it. **Never carry a page-condition flag across
runs.** The other half is rule 12a on this surface: `revealApplicantTab()` activates the hiring tab
through `Tabs.activate` before either applicant command, because the button is pressed on a different
tab and Chrome stops rendering the one that matters. A second press while a run is genuinely in flight
replies `alreadyRunning` at once rather than hanging on the first run's promise.

**Coming back to a job starts its run again, and the worker is what remembers** (3.7.6, and it took
until 3.7.7 to work without a reload). A navigation
destroys the content script and with it the run, the state and everything it had been asked to do, so
returning to a job's Applicants page left the surface idle until the button was pressed again. The
worker holds the standing instruction (`PV_APPLICANT_AUTO_RUN`), and the discipline around it is the
point:

- **Only a job the recruiter started a run on**, with the options they started it with, so
  `Re-collect already saved` is replayed too. `COLLECT_ALL` arms; `COLLECT_CURRENT` never does. The
  worker persists a run id, an attempt number and `running | interrupted | completed`; only an
  unfinished execution is restartable, and an armed instruction expires after twelve hours. A
  completed run stays completed across a reload, a route change and a content-script reinjection.
  This is a *replay of their own unfinished instruction*, which is what keeps it inside "after a
  direct user action" — the extension never decides on its own to read a page.
- **A Stop a navigation could undo is not a Stop** (rule 13a). `stopEverything()` and the page's own
  Stop both call `disarmAutoRuns()` **before anything else that can fail**, and the content script
  latches `autoRun.disabled` so an arrival already in flight cannot start after one. `Clear
  Applicants` disarms as well.
- **An arrival is a change of *view*, never of URL** (3.7.7; it was a change of *job* in 3.7.6).
  Opening a row is how a run advances and each one changes the address bar, so keying on the URL would
  restart the run on every row it opened. But the job alone is too coarse in the other direction:
  `/hiring/jobs/<id>/manage`, `/hiring/jobs/<id>/applicants` and `/hiring/applicants/?jobId=<id>` are
  all `job:<id>`, so moving between a job's own views in LinkedIn's app and landing back on its
  Applicants list was never an arrival at all. `Applicants.applicantsViewKey()` is the job id plus the
  pathname **with its ids stripped** — identical when a row is opened, whether the application's id
  lands in the query or in the path, and different for a different view of the same job.
- **An arrival is recorded, then retried — never consumed** (3.7.7). `checkAutoRunArrival()` used to
  write `lastKey` and *then* call the async, fire-and-forget `startAutoRun()`, which has several silent
  bails; the poller only acts on a *change*, so one lost race lost the restart for good, and only a
  reload — a fresh `state` with `lastKey: ""` — got it back. That is the whole reason F5 worked and
  nothing else did. The arrival is now `pendingKey`, fulfilled by a separate `pumpAutoRun()`.
  **Transient bails keep it pending** (the list has not mounted after an in-app route; the worker was
  asleep; `busy`) and are retried, bounded by `AUTO_RUN_MAX_ATTEMPTS` (8). **Terminal ones call
  `abandonAutoRun(reason)`** and say so in the console: a Stop, a run already in flight, an unarmed
  job, an address with no job id, a page that moved on.
- **One persisted lifecycle, one newest execution.** `runEveryApplicant()` reports `completed` or
  `interrupted` through `PV_APPLICANT_RUN_LIFECYCLE`; the worker applies it only when both the run id
  and attempt number match. Re-injection may hand the same job to a replacement document in the same
  tab, but a second tab is refused while the owner is running, and the old closure's late report is
  stale by construction. Applicant row navigation never touches this lifecycle.
- **A poller only samples, so it is not the only watcher** (3.7.7). `popstate` and `hashchange` catch
  back and forward. A debounced `MutationObserver` catches `pushState`, because a content script's
  isolated world has **its own `history` object** — patching `pushState` there would never see
  LinkedIn's own call to it, and the re-render that follows is what is actually observable. `pageshow`
  with `event.persisted` catches a back/forward-cache restore, which is the case a poller can never
  see: the *same* document returns still holding the key it was frozen on, so the return reads as "we
  are already here" — and freezing latched `state.wentHidden`, so `assertRunnable()` would throw "the
  page is hidden" before a row was read. Both are re-derived on restore. The 800 ms poller stays as the
  backstop and as the thing that retries. A re-injection removes all three listeners and disconnects
  the observer, so two watchers never run over one page.
- It waits for the list to have rows, refuses to start on a hidden tab and defers to
  `visibilitychange` (rule 12a), never starts on top of a run in flight, and **adds no click** — it
  replays `extractAllApplicants`, which builds a fresh run state and walks from the first row.
- **A run that stops short while nobody navigates anywhere continues itself** (3.7.10,
  `continueInterruptedRun`). Every restart path above answers "did we *arrive* somewhere" — a route
  change, a tab return, a reload — and **none of them fires when a run simply ends early while the
  recruiter is sitting on the page watching it**, which is exactly what an inconclusive stop is:
  `MAX_INCONCLUSIVE_GROWTHS` spent on a list that was being re-mounted leaves `RUN_STATE.STOPPED`,
  the worker is correctly told `INTERRUPTED` so the job stays restartable, and then nothing restarts
  it. So the run asks for itself back — a continuation of the recruiter's own unfinished instruction,
  on the job they started it on, which is the same standing the reload-resume has. It routes through
  `pumpAutoRun`, so every guard on that path applies unchanged. Four bounds, and this is the one
  place on the surface where a missing bound walks a recruiter's job forever: a **COMPLETED** run is
  never continued (the end of the list ends it), `autoRun.disabled` is checked first (rule 13a),
  leaving the surface blanks the key, and the same `MAX_FRUITLESS_RETURNS` budget a tab return spends
  applies — an attempt that collected nobody new does not earn another, while one that collected
  somebody resets it, which is why walking page after page is unbounded in *pages* and still bounded
  in *failures*. It is deliberately **not** applied on the throw path: a throw out of the walk is a
  challenge, a checkpoint or a page that stayed hidden past the wait, and rule 13 says those pause
  for a person.

**Pressing the whole-job command in the popup closes the popup** (3.7.7; it was Collect Every
Applicant until 3.7.13 and is Collect Applicant List now). The run happens on the
hiring tab, which the worker has just activated and focused, so a popup hanging over it covers the one
thing the button was pressed to watch. It closes **only on `{ ok: true, started: true }`** — the
worker's own proof that it resolved the tab, revealed it, got a matching-build `PV_APPLICANT_PING`,
armed the auto-run and dispatched `PV_APPLICANT_EXTRACT_ALL`. Anything less keeps the window open and
shows the error, because a window that vanishes on failure is a button that silently did nothing. It
does **not** use `runImport`, which is shared with Start Collecting and Collect This Applicant;
`closePopup()` clears the poller first and latches `closing`, which every state write checks, because
`window.close()` does not tear the document down synchronously.

**Contact details are accumulated, not read once.** `collectRenderedContacts()` and
`collectFeaturedDocuments()` ([content.js](extension/content-scripts/content.js)) run on **every** snapshot of the scan and feed
`addContactPanel()` on the merge-only accumulator, so an address that hydrates late — or a top card
that is recycled out of the DOM as the scan passes it — is still captured. `emails`/`phones`/`cvLinks`
counts are part of `signature()`, so a contact detail arriving late **restarts** the quiet count
rather than letting the scan settle early.

**Provenance, not pattern matching** ([extraction-core.js](src/extraction-core.js)):
`scanLabelledContacts()` walks the text line by line keeping one *open field*. A line matching an
Email or Phone label opens that field; a line matching **any other** contact label (`Your Profile`,
`Website`, `Address`, `Birthday`, `Interests`, …) closes it. Only lines under an open field are
parsed, and unlabelled running text yields nothing at all. `extractPhones()` then deletes addresses,
URLs and word-welded identifiers from the text *before* `PHONE_PATTERN` runs. The rendered page is
scanned with `allow: ["email"]`; a phone number is only ever taken from a `tel:` link or the contact
overlay. `contactLinksIn()` additionally drops any link inside a foreign section
(`FOREIGN_SECTION_PATTERN`: Interests, Top Voices, People also viewed, Recommendations, …) or inside
a card that links to a **different** member — a structural test, so it holds in any language.

**Cleaning what is already stored.** `normalizeProfile` drops a phone whose digits appear inside the
record's own `profileUrl` digits (exactly the `264954380` defect), so the corrected value shows the
moment the table is opened; `repairStoredProfiles()` persists it. A value that turns up on **three or
more different people** is contamination from a block that renders other members —
`findSharedContactValues()` reports those and `stripSharedContactValues()` removes them, behind the
Saved Profiles page's **Clean shared contacts** button, because removing somebody's real details
would be worse than leaving a wrong one.

**Merge vs replace:** [`replaceProfile`](src/profile-utils.js) (popup + importer) — incoming wins,
keeps `id`, `collectedAt`, and existing `notes`/`tags` when incoming are empty.
[`mergeProfiles`](src/profile-utils.js) (CSV import) — scalars overwrite, arrays concatenate except
`education`/`openToWorkDetails`/`partialSections`/`missingFields`, which are replaced.

## The collection state machine

`COLLECTION_STATE` ([import-queue-core.js](src/import-queue-core.js)) is the single source of truth
for what the collector is doing:

```
idle → navigating_to_connections → discovering → reconciling → ready_to_extract → extracting
     → completed | completed_with_gap
```
plus `paused_visibility`, `paused_challenge`, `stopped`, `failed`. `transitionCollection()` refuses
illegal moves **and repeats of the current state**, returning `{ changed }`. The worker only ever
starts work when it *won* the transition — that is what makes a service-worker wake-up idempotent
instead of a second discovery or a second extractor. `ready_to_extract → extracting` is a legal move,
so the automatic workflow never needs a Stop/Start detour. A terminal state is left only via `idle`.

**And a direct command is what takes that move, since 3.7.18 — `beginConnectionsRun()`.** Both
connections workflows used to open on a bare
`if (!(await moveCollectionTo(OPENING_CONNECTIONS))) return;`, which is a **silent** return, so from
the first time a run reached `completed`, `completed_with_gap`, `stopped` or `failed`, **both
`Start Full Collection` and `Discover Connections Only` were permanent no-ops** — while the command
branch had already replied `started: true` and the page said "Collecting…". Reported as *"nothing is
happening"*, and the only escape was `Clear Queue`, which discards the discovered list to unstick a
state machine. Pressing one of those buttons **is** the "explicitly starting over" this rule names,
so a terminal state is reset to `idle` first and then the wanted transition is taken. Scoped to
terminal states on purpose: nothing is in flight in one, every other state keeps refusing, and that
refusal is exactly what keeps a wake-up idempotent. Provable here because both workflows are reached
from their command branches and nowhere else — never the heartbeat, the alarm or the drain loop. It
resets a *state*, never data: the queue, the discovered list and the saved profiles are untouched.
**A refusal is never silent again** — `lastError` names the state that refused. Locked by *"a
finished, stopped or failed run can be started again without clearing the queue"* and *"a connections
command resets a terminal run and never refuses in silence"*.

**Where to look when a connections command appears to do nothing:** **Download Diagnostics** carries
`collectionState` and the last 40 state-machine moves as `transitions`, each with `changed` and a
`reason` — a refused start reads verbatim as `refused:completed->opening_connections`. That log is
in-memory, so it is empty after the service worker sleeps; `collectionState` is persisted and is the
durable half.

**Discovery must terminate.** Three separate bounds, all of which were missing and each of which
alone produced an infinite run:
- `grew` counts *new connections only* — never a pagination click.
- `MAX_FRUITLESS_PAGINATION` (3) retires an allowlisted control that keeps revealing nothing.
- `MAX_FRUITLESS_DISCOVERY` (3) bounds how often the drain loop may ask for more.

**Coverage settles against `unique URLs + cards with no usable URL`**, not against unique URLs alone.
LinkedIn advertising 67 while one member is restricted means 66 IS the whole list; the old rule made
discovery hunt forever for a 67th URL that cannot exist. `discovery.gap` records the exact difference
and `terminalStateFor()` returns `completed_with_gap` when it is non-zero.

## Import queue

State lives in IndexedDB stores `importQueue` (keyPath `url`) and `importSession`.
[import-queue-core.js](src/import-queue-core.js) holds the **pure** state machine (enqueue, claimNext,
markCompleted/Failed/Skipped, retryFailed, pause/resume/stop, recoverAfterInterruption, stats) so it
is fully testable without IndexedDB; [queue-db.js](src/queue-db.js) is the thin persistence adapter.

Every row also carries `lastCollectedAt` — set on completion, and preserved from the existing record
when a completion was a skip-as-fresh. It drives both the "last collected" column and the `stale`
selection scope. [queue-db.js](src/queue-db.js) fills newer fields in on load, so rows written by an
older release stay usable.

Item statuses: `pending → processing → completed | failed | skipped`. Permanent failures (unavailable,
404, out of network) fail at once; transient ones back off 15 s × 2ⁿ up to `MAX_ATTEMPTS` (3), then
wait for **Retry Failed**. Queue rows are written one at a time (`putItem`), never by rewriting the
whole queue.

**Recovery (D2):** on service-worker start any `processing` item returns to `pending`. A `running`
session **auto-continues**; a session whose `pausedBy` is `challenge`, `user`, `navigation`, or
`error` never does. A `chrome.alarms` heartbeat (1 min) drives this and also starts the next batch
once a cooldown deadline passes. `alarms` exists for that and nothing else.

**Batches (D3):** a run processes up to the user's cap, then pauses with `pausedBy: "cooldown"` and
resumes automatically. Pacing between profiles is randomized 4–9 s. There is no unbounded mode.

**The collection state machine** (`COLLECTION_STATE` in
[import-queue-core.js](src/import-queue-core.js)) is the single source of truth for what the run is
doing. A full run takes exactly this path, with **no manual step anywhere in it**:

```
idle -> opening_connections -> discovering_connections -> connections_complete
     -> opening_profile_collector -> extracting_profile -> saving_profile
     -> moving_to_next_profile -> extracting_profile -> ... -> completed
```

plus `paused_hidden`, `paused_challenge`, `stopped`, `completed_with_gap`, and `failed`.
`connections_complete -> opening_profile_collector` is the hand-over that **used to require a manual
Stop followed by Start Extraction**; the worker now takes it itself, and a test asserts there is no
path from discovery to extraction through `stopped` or `idle`. `transitionCollection()` refuses every
illegal move, which is what makes a service-worker wake-up idempotent instead of a second run.

**The tab workflow (requirements 1–13).** `Start Full Collection`
(`PV_IMPORT_START_COLLECTING`, also reachable from the popup) runs `startCollectingWorkflow()`:

1. `rememberOrigin(sender)` records the window and extension tab it was clicked from.
2. `revealConnectionsTab()` opens or reuses **one** Connections tab **in that same window**, makes it
   the active tab and **raises its window** (rule 12c). A tab already on the page is re-activated,
   never reloaded. This happens *before* step 3, so the redirect is what the user sees.
3. Check the LinkedIn session; open LinkedIn's own sign-in page and pause if signed out.
4. Read the list, persisting every pass.
5. Stop as soon as `HANDOVER_PENDING_ROWS` (25) are queued → `connections_complete`. The pass itself
   is shortened to `HANDOVER_PASS_STEPS` (12), because that budget is only tested between passes.
6. `Tabs.ensureProfileTab()` opens or reuses **one** profile collector tab in the same window.
7. It is activated.
8. `Tabs.navigateProfileTab()` sends **that same tab** to each queued profile in turn.
9. Each profile: wait for the tab to be active and visible → read from the top → scroll gradually →
   wait for mutation quiet after every step → merge into the accumulators → open Contact info if
   needed → save only after a stable bottom with five unchanged scans.
10. The collector tab stays open and active until the queue finishes.
11. If the user switches away, `onSurfaceChanged()` pauses into `paused_hidden` — **nothing partial
    is ever saved**. `processItem()` checks visibility before reading *and* again before writing.
12. `resumeFromHidden()` continues as soon as the tab is visible again, driven by
    `chrome.tabs.onActivated` / `chrome.windows.onFocusChanged` rather than waiting for the alarm.
    `resumeCollectionState` decides which half of the run it returns to.
13. When every row is completed, failed, or skipped, `finishRun()` applies **one** policy
    (`COMPLETION_POLICY = "close-collectors-open-saved-profiles"`): abort in-flight work, clear the
    heartbeat, close both collector tabs, open or activate the Saved Profiles table, and move to a
    terminal state. `onHeartbeat()` refuses to restart a terminal run.

The order of those steps is asserted by a test. It sets `autoDiscover: true`, so a queue that drains
before the list settled keeps paging forward.

**Discovery and extraction INTERLEAVE, and step 5 is where that starts (3.7.19).** Requested outright
against a **19,000-connection** account: *"instead of collecting the connection list first, collect
the list and collect them one by one at the same time."* Enumerating 19,000 rows before reading a
single profile is hours of scrolling with nothing collected — and an interruption anywhere in that
window leaves a long list and no profiles.

- **The mechanism already existed; only the first handover was missing.** `discoverNextPage()`, the
  drain loop's `shouldContinueAutoDiscovery` / `registerDiscoveryGrowth` /
  `registerFruitlessDiscovery` bounds, `autoDiscover: true` and the legal move
  `moving_to_next_profile → discovering_connections` have asked discovery for more whenever the queue
  empties since 3.3. What `startCollectingWorkflow` did was run `runDiscovery` to a settled bottom
  first. It now passes `handoverAtPending: HANDOVER_PENDING_ROWS` and returns `stoppedBy: "handover"`
  the moment that many rows are queued.
- **`HANDOVER_PENDING_ROWS` (25) is a floor, never a cap.** A pass that mounts 400 rows queues all
  400; the number only decides how little is enough to get started, and the pass that satisfies it was
  paid for either way. It is checked **after** the pass is persisted, so nothing handed over exists
  only in memory.
- **A pass that exists to FEED extraction is short, and that is the other half of the interleave**
  (3.7.20, `HANDOVER_PASS_STEPS` = 12). The row budget above is only ever tested *between* passes, and
  a pass is `DISCOVERY_STEPS_PER_PASS` (120) steps — so on the 19,000-connection account this was
  reported against, the first profile was still 120 screens of scrolling away and the run still looked
  exactly like "enumerate the list first". Both passes whose only job is to keep the queue fed ask for
  a short one: `runDiscovery` in handover mode, and `discoverNextPage()`, the drain loop's top-up,
  which is reached only when `autoDiscover` is on. What the user sees is the walk they asked for —
  open a profile, collect it, next, and scroll for more of the list only when the queue runs dry.
  **`Discover Connections Only` passes no handover budget and keeps all 120**, because enumerating the
  whole list is the one thing that command is for.
  **A short pass can never be mistaken for the end of the list, structurally rather than carefully:**
  `planDiscoveryStep` returns `DONE / "step-budget"` with `exhausted: false`, the content script sets
  `atBottom = plan.exhausted`, and `applyDiscoveryPass` cannot settle without `pass.atBottom`. **But
  it must stay clear of `DISCOVERY_QUIET_SCANS` (5)** — the in-pass quiet-bottom-read count needed
  before the list may be declared finished. A budget below it could never reach a real verdict at the
  bottom, so every pass would return `step-budget`, the drain loop would spend
  `MAX_FRUITLESS_DISCOVERY` on it and then finish the run anyway with `discoveryExhausted: true` — a
  false completion on a list that is not done. A bottom pass costs about seven steps at worst (two
  quiet reads, a pagination click that resets the count, then five more), and a test asserts the
  relationship rather than the number.
- **An early return is "enough to begin", never "that is the whole list".** It does not touch
  `discoveryExhausted`, which is exactly what keeps the drain loop topping the queue up. Getting that
  wrong would make a part-read account look finished and stop the run thousands of connections early.
- **`Discover Connections Only` passes no handover budget** and still enumerates the whole list — it
  is the command whose entire purpose is that — and a test asserts it never takes the shortcut.
- **`connections_complete` is now the HAND-OVER, not the end of the list**, so both of its user-facing
  strings were corrected: saying "complete" there is untrue for most of a large account's run.
- **⚠ They interleave; they do not run at the same time, and they cannot.** Rule 12a: LinkedIn does
  not render a hidden tab, so its DOM freezes and every "has it finished?" signal reads as finished.
  Discovery needs the Connections tab painting and extraction needs the profile collector tab
  painting, and only one tab of a window is active at a time. Alternating is the whole of what "at the
  same time" can mean here, and rule 12's two-tab limit is unchanged.

Locked by *"Start Full Collection hands over to extraction as soon as there is a batch, and keeps
discovering"*, *"an early handover is 'enough to begin', never 'that is the whole list'"*, *"a pass
that exists to feed extraction scrolls a short way and hands back"* and *"a short pass says 'I stopped
early', never 'there is no more'"*.

`Find All Connections` (`PV_IMPORT_DISCOVER_ALL`) enumerates the whole list and saves it; it never
extracts. `Start Profile Extraction` (`PV_IMPORT_START`) runs over what is already saved and sets
`autoDiscover: false`. **They must stay separate commands and separate buttons** — a test asserts the
discover branch never calls `Queue.startSession`.

`Clear Queue` (`PV_IMPORT_CLEAR`) must **stop work already in flight** (via `abortRunningWork()`'s
generation token, not just by flipping the session status) and wipe the discovered list, queue rows,
counters, and session progress. It must never touch the saved-profile store.

The page must keep: Start Collecting, Find All Connections, Start Profile Extraction, Stop, Retry
Failed, Clear Queue, View Saved Profiles Table, Download CSV, Download Diagnostics, Sign in to
LinkedIn, Check Login, search, status filter, the editable skip-if-collected-within-days setting, the
LinkedIn-reported total, discovered / missing-inaccessible / selected / pending / processing /
completed / failed / skipped counts, the current profile, a progress bar, the **final stop reason**,
the count-reconciliation panel, the hidden-collector-tab warning, and the paginated connection list (25 or
50 rows, Previous/Next/page numbers, total count; each row shows name, profile URL, status, last
collected date, and error). Tests enforce all of it.

**Selection scopes** (`SELECTION_SCOPE` in [import-queue-core.js](src/import-queue-core.js)): all,
selected, uncollected, failed, or stale (not collected within the configured days). `selectItemUrls()`
resolves the scope, `prepareRun()` requeues only those rows **without touching the rest of the
discovered list**, and `claimNext()` refuses to claim anything outside `session.scopeUrls`.

**Count reconciliation.** Discovery tallies every rendered card, not only the ones that yielded a URL.
`Core.createCardLedger()` ([connections-core.js](src/connections-core.js)) keys usable cards by
canonical URL and cards with no usable link by their visible text, so a virtualized re-render cannot
inflate either count; `Core.reconcileDiscovery()` turns those numbers into the explanation the
importer page shows. This is what accounts for "LinkedIn reports 67 but 66 profile URLs exist" — the
67th is a restricted or deleted member whose card renders without a profile link. **An unexplained
remainder must always be stated**, because it is indistinguishable from discovery having stopped
early.

**Coverage (phases 21–24):** discovery is multi-pass and resumable from a persisted `cursorY`. It
stops when a *reliable* advertised total is reached (`coverage: "confirmed"`) or when the list is at
the bottom with no allowlisted pagination control and no new URLs for `DISCOVERY_QUIET_PASSES`
consecutive passes (`coverage: "estimated"`). A rounded total such as `500+` is stored but can never
confirm coverage.

**Discovery and scan policy is pure and tested; the content scripts are adapters.**
`Core.planDiscoveryStep()` ([connections-core.js](src/connections-core.js)) decides scroll / wait for
growth / paginate / done, and `Core.nextScanStep()` ([extraction-core.js](src/extraction-core.js))
walks a profile page. Neither touches the DOM, so both are tested against simulated pages in
[tests/connections-discovery.test.js](tests/connections-discovery.test.js). Keep new discovery logic
there rather than in [connections.js](extension/content-scripts/connections.js) or [content.js](extension/content-scripts/content.js) — there is no jsdom
in this repo, so DOM-resident logic cannot be tested at all.

Three traps that caused the "only 10 connections" bug and must not come back:

1. **Never assume the document scrolls.** LinkedIn's scaffold layout pins `<html>`/`<body>` at
   `height: 100vh; overflow: hidden` and scrolls a wrapper that is an **ancestor** of the list, so
   `document.scrollingElement.scrollHeight - innerHeight` is `0` and the first read looks like the
   bottom. `Core.chooseScrollTarget()` ([connections-core.js](src/connections-core.js)) picks the real
   one from candidate descriptors; `scrollCandidates()` in both content scripts must keep offering the
   document, **every ancestor** of the root, and the root. It rejects any container that does not
   contain the content being read — on the connections page the tallest scrollable *descendant* is a
   filter panel that scrolls nothing. Position, bottom, and stepping must all read that one element:
   never `Math.max` across two scrollers.
2. **Never assume the list lives in `<main>`.** `listRoot()` picks whichever candidate carries the
   most `/in/` links (via `querySelectorAll`, never a single `querySelector`), and card reading falls
   back to a relaxed visibility test.
3. **Never let a scan replace the accumulator.** Cards and sections are recycled out of the DOM as the
   page scrolls; the cumulative collector is merge-only. Discovery streams new rows to the worker with
   `PV_IMPORT_DISCOVERY_PROGRESS` so an interrupted pass keeps what it found.

**Profile extraction reads the whole page before it builds anything.**
`performLazyScrollAndCollect()` drives the container returned by `chooseScrollTarget()` (same rule as
discovery — trap 1 above applies here too), starts at the top, steps down gradually, collects on every
step, and finishes only when it is at the bottom *and* `PROFILE_SCAN.QUIET_PASSES` (5) consecutive
reads produce an unchanged signature. The scroll position is restored in a `finally`, on the failure
path as well. The top card is re-read on every snapshot via `collectIdentity()` and the best-scored
name/headline/location wins — **never extract the top card before the scan**, it hydrates late.

**Everything read goes into `Core.createProfileAccumulator()`** ([extraction-core.js](src/extraction-core.js)),
which is pure and merge-only, so a section LinkedIn unmounts as the scan passes it stays in the record.
Entity identity is fixed: experience = canonical company URL + normalized title + visible date range;
education = institution + degree + dates (grouped into **one entry per institution**, of which only
the **name** is stored); skills = lowercase name, after `collapseRepeatedText()` folds the
accessibility duplicate LinkedIn welds on (`DockerDocker` → `Docker`); certifications = name +
issuer + issue date. A later, more hydrated read of the same entity **enriches** it — a value that is
already there is never overwritten, and a missing value stays empty. `extractEducation` therefore
returns **records, not formatted strings**.

**After the walk, and only then, two overlays.** The Contact info overlay first (rule 9b), then the
Open to work panel (rule 9c). Both open, are polled with the same `nextContactOverlayStep()` settle
policy until what they show stops changing, are merged into the accumulator, and are dismissed. A
modal opened mid-scan would stop the lazy walk dead, so a test asserts the ordering.

## Known issues

| Issue | Where |
|---|---|
| `npm run build` deletes `dist/` before compiling; a failed `tsc` leaves no extension | [build.mjs](scripts/build.mjs) |
| Manually added dashboard profiles collide on one ID (`createProfileId("","")` is constant) | [dashboard.tsx](src/react/dashboard.tsx) |
| CSV import merges against a pre-loop snapshot; duplicate URLs in one file lose data | [dashboard.tsx](src/react/dashboard.tsx) |
| `findByProfileUrl` scans all records despite a `profileUrl` index | [db.js](src/db.js) |
| Object URLs revoked on a fixed 15 s timer; slow save dialogs can fail | [csv.js](src/csv.js) |
| `chrome.storage.local` build keys are written but never read | [background.ts](src/background.ts) |
| `tests/fixtures/*.html` are **not** run by `npm test` — manual browser pages only | [tests/fixtures/](tests/fixtures/) |
| Pagination labels and the connections-total selector are **assumptions** until checked live | [connections.js](extension/content-scripts/connections.js) |

**Live-layout limitation:** LinkedIn changes its DOM per account. Passing fixtures and unit tests does
**not** prove live correctness — loading `dist/` in Chrome is a user-browser step (phase 30). Never
claim live success without it.

## Companion docs

Keep in sync: [WORKFLOW.md](docs/WORKFLOW.md) (how a change is investigated, made, checked and saved —
the working method these rules produce), [AGENTS.md](AGENTS.md), [TECH_STACK.md](docs/TECH_STACK.md) (with
[package.json](package.json)), [MEMORY.md](docs/MEMORY.md), [CHECKS.md](docs/CHECKS.md) (**real results only**),
[PHASES.md](docs/PHASES.md), [PROJECT_STATUS.md](docs/PROJECT_STATUS.md), [CHANGELOG.md](docs/CHANGELOG.md),
[SKILLS.md](docs/SKILLS.md), [README.md](README.md), [INSTALL.md](docs/INSTALL.md) (what ships inside the
installer — it must account for every host permission the manifest asks for, and a test in
[tests/packaging.test.js](tests/packaging.test.js) fails when a new one is added without explaining
it there).

**Not binding, and deliberately outside that list:**
[COMPLETE_EXTRACTION_SPEC.md](docs/COMPLETE_EXTRACTION_SPEC.md) — the proposed target state, in which a
value is read from the record the page already holds rather than only from what it painted. It
proposes amending the "only visibly rendered" preamble and rules 6, 9, 10, 11 and 12a. **Every rule
above stays in force exactly as written until such an amendment lands in its own task**; the spec
describes what we want to build, not what is true.

# Project Time Machine

See **READ FIRST** at the top of this file — it is the binding version of these
rules. Reference docs:
[AGENTS.md](project-time-machine/docs/AGENTS.md) (workflow),
[checks.md](project-time-machine/docs/checks.md) (what to run before completing),
[COMMANDS.md](project-time-machine/docs/COMMANDS.md) (every command).

No file may be created, edited, renamed, moved or deleted outside an active task.
