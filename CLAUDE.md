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
2. Content-script extraction stays framework-free. Never import React into [content.js](content.js),
   [connections.js](connections.js), or `src/*-core.js`.
3. React loads locally from [vendor/](vendor/), never a CDN — MV3 CSP is `script-src 'self'`.
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
   **Hiring / applicants pages — exactly four, added in 3.7.0** ([applicants.js](applicants.js)),
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
      how "Collect Every Applicant" advances. It is a navigation click and nothing else. **Wait for
      `panelIdentity()` to change afterwards, never for the address bar** — LinkedIn routes without a
      navigation and the DOM is briefly quiet between tearing the old applicant down and mounting the
      new one, so both of those signals fire while the panel still shows the previous person. A row
      that never opens is **skipped**, not scanned; scanning anyway saved the previous applicant a
      second time under this row's identity. Since 3.7.3 a row whose applicant is **already saved for
      this job is walked past without being clicked at all** — see "Collecting every applicant" below.

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
12c. **Focus is taken in exactly two places, and both are a direct user command:** the sign-in page,
    and an applicant command's hiring tab (`activate(id, { focusWindow: true })`). Everything driven
    by the heartbeat activates the tab without focusing the window — stealing focus from whatever the
    user is typing into is worse than a background run taking longer. A button press is the opposite
    case: a tab activated in a window they are not looking at is a button that did nothing.
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

Fresh clone: `npm install && npm run check`, then load `dist/` at `chrome://extensions`
(Developer mode → Load unpacked).

After editing `src/**` or `content.js`/`connections.js`/`applicants.js`: `npm run build`, reload the
extension, and reload the LinkedIn tab.

## Layout

```
manifest.json   content.js (profile extraction)   connections.js (discovery)
                applicants.js (recruiter hiring pages)
popup.html  dashboard.html  import.html  applicants.html  + matching .css
theme.css       The shared visual layer — tokens, reset, type, buttons, fields,
                notices, pills, tables, drawer. Loaded FIRST by all four pages;
                each page's own .css holds only what is unique to it.
src/
  extraction-core.js    Pure profile parsing — NO DOM at load
  connections-core.js   Pure URLs, control policy, totals, challenges — NO DOM at load
  applicants-core.js    Pure applicant/job parsing + hiring click policy — NO DOM at load
  collector-tabs-core.js  Pure tab workflow over an INJECTED chrome API — NO DOM at load
  import-queue-core.js  Pure queue/session/discovery state machine
  queue-db.js  db.js  applicant-db.js  csv.js  profile-utils.js  messages.ts
  background.ts         Service worker — import orchestrator + applicant relay
  react/  popup.tsx  dashboard.tsx  import-dashboard.tsx  types.ts
scripts/  tests/ (*.test.js + fixtures/*.html, browser-only)
vendor/   React 16.0.0 + ReactDOM 16.0.1 — the actual runtime
dist/     Build output — the folder Chrome loads
```

## How the pieces connect

**React is a global, not an import.** Every `.tsx` does
`const React: any = (globalThis as any).React;`. HTML pages load `vendor/*.min.js` as classic scripts,
then the compiled entry as `type="module"`. **Never write `import React from "react"`** — there is no
bundler. The `react`/`react-dom` entries in [package.json](package.json) are *not* the runtime;
to change versions, replace the files in [vendor/](vendor/).

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

**Build ID `2026-08-03-react-v3.7.8` must match in 5 places:** [content.js](content.js),
[connections.js](connections.js), [background.ts](src/background.ts),
[popup.tsx](src/react/popup.tsx) (`EXPECTED_BUILD_ID`), and [build.mjs](scripts/build.mjs). The popup
and the service worker both refuse a content script whose `PV_PING` build ID differs, then re-inject.
[applicants.js](applicants.js) carries the same id and answers `PV_APPLICANT_PING`, so the two
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
[content.js](content.js)), never the container's `innerText` — that is what saved `Endorse` and
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
- **The table and the CSV were restructured in 3.7.1; the resume is two columns since 3.7.6.**
  `APPLICANT_TABLE_COLUMNS` is `applicant_name, email, mobile, resume_file, current_role,
  current_company, total_experience, education` — the person first, then both ways to reach them,
  then the resume in **one** column since 3.7.9: **which file we have**. `resume_link` was removed
  from the table on request ("we can skip the link and remove it from table too") and is
  **demoted into the detail columns, never dropped** — it is the only column carrying `url` /
  `viewerUrl`, so deleting it outright would take the document address out of the export
  altogether, and `resume.url` itself must stay on the record because `resumeAlreadyDownloaded()`
  is what stops every run re-downloading every file. The same treatment `qualifications` got, with
  the same two-part test: removed from the table, still asserted present in the export.
  `resume_link` is the document address when the page
  rendered one and the LinkedIn viewer page when that is all there is, because either way the cell
  means "open the CV"; `resume_file` is the saved copy's path under the downloads folder, falling back
  to the file name LinkedIn showed. Both are `resumeLink()` / `resumeFile()` in
  [applicant-csv.js](src/applicant-csv.js), so the table cell and the CSV cell are one rule, and
  neither invents anything. 3.7.4's `resume_status`, `resume_viewer` and `resume_saved_as` are
  **gone as columns** — a **deliberate removal**, five cells answering one question — while every
  record field is kept: `downloadStatus` is what stops a file being fetched twice and what the page's
  resume filter reads, `viewerUrl` and `localReference` are what the two columns are built out of, and
  the details drawer still shows all three. From here the usual rule resumes: **append columns; never
  reorder.** `job_title` and the applicant's `location` were **dropped** as columns in
  3.7.1: the job is a filter on the page and the location is detail, and both still live in the
  details drawer. `job_id` stays in the detail columns so the association is kept. `all_emails` and
  `all_phone_numbers` export every value, not only the primary two, with each number marked as text
  **per entry** — a cell-level marker would protect only the first and `04423456789` would lose its
  leading zero.
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

## The list pass — every applicant's name, across every page (3.7.10)

**Requested outright: "collect all applications across multiple pages in sequence, one at a time,
save the applicant's name, then the next one; page ends, then next page — like we did in
connections."** The connections surface has always had two separate commands for exactly this reason:
**Find All Connections** enumerates the list and saves rows without extracting anything, and **Start
Profile Extraction** reads what was found. *Who applied* and *what is on their profile* are different
questions, and the second costs hours where the first costs a walk down the list.

- **`options.listOnly` is a branch of the one walk**, not a second walk. Same row loop, same identity
  ledger, same `growApplicantList`, same pagination (rule 9h), same conclusive-stop rule, same
  resume-after-a-reload. The only difference is what happens to a row: `Applicants.buildApplicantListRecord()`
  is built from the row itself and streamed to the store with `PV_APPLICANT_SAVE`, one at a time as
  it is read, exactly as the full run streams a finished applicant.
- **It opens each applicant, lets the panel load and walks it to the bottom before moving on**
  (`revealApplicantProfile`, 3.7.10 — requested outright: *"slow down on every profile, let it load
  fully, scroll to its bottom, then move onto the next"*). It is the full run's **movement** without
  the full run's **reading**: the same single gated row click (rule 9g), the same wait for the panel
  to be showing that applicant, and the same `scanApplicantPanel` walk — so "loaded" and "scrolled to
  the bottom" mean here exactly what they mean there, rather than a second, thinner idea of both.
  **The saved name still comes from the list row, never from the opened panel**: opening is for
  loading, not for reading. The accumulator the walk fills is discarded, and that is not waste — the
  walk's stop rule *is* "the panel stopped producing new content", and only the accumulator's own
  signature can answer it.
- **It presses nothing extra.** `budget: null` is the flag `scanApplicantPanel` gates
  `expandCollapsedSections` on, so the eight expander clicks a full extraction may spend are never
  spent here: **one click per applicant** — the row itself — plus the pager. `extractApplicant` and
  everything it drives is untouched and is still the only path a full collection takes.
- **A profile that would not open never loses the person.** The name came from the row and is
  unaffected, so it is still saved and the failure is named in `lastError`. A hidden page is a pause
  with the same `MAX_HIDDEN_RETRIES` bound the full run applies, or a panel that reliably hides the
  tab would re-run one applicant for as long as the tab is left alone.
- **It paces itself** (`LIST_PROFILE_PACE_MS`), because a run walks hundreds of panels back to back
  on the recruiter's own session and the connections importer has paced between profiles since 3.3.
  ⚠ This makes a pass cost **tens of seconds per applicant** rather than a millisecond — a
  665-applicant job is hours, not minutes. That is what makes the listed-index skip below load-bearing
  rather than an optimisation.
- **The name and the two ids, and deliberately nothing else.** The row also renders a headline and a
  location; taking them would mean deciding that line two is the headline and line three is the
  location — positional guessing on generated markup, which rule 11 refuses and rule 6 makes worse
  than an empty field. `cleanApplicantName` still strips the `· 2nd` degree badge.
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
- **The job header is read once per run**, not per row: it sits above both columns and does not
  change as the list is walked, so reading it per row would be hundreds of forced layouts for one
  unchanging answer — the same reason `applicantRows()` made its name a lazy getter.
- **A listed applicant is not a collected one.** `isCollectedApplicant` needs one substantive field,
  so a later full run still opens these people rather than walking past them forever.
- **Which "already have them" question is asked depends on the pass** (3.7.10). A full run asks
  `createCollectedIndex` — "is this person **collected**" — because a record with nothing substantive
  on it is a run that *failed* on them and must be tried again. A list pass asks
  `createListedIndex` — "do I already **have** them" — because every record it writes is name-only,
  so the collected test always answers no and a resumed pass would walk the whole job again. That
  matters most once the pass opens each applicant: a row then costs tens of seconds, and since an
  interrupted run continues itself, a pass that keeps being interrupted would walk the first page
  over and over — the re-saves reading as progress, which is exactly what clears the
  fruitless-return budget that would otherwise stop it. `PV_APPLICANT_COLLECTED` therefore sends
  **every** stored entry with the verdict beside it rather than filtering on the verdict, because a
  page filtering on `collected` can never tell "already listed" from "never seen".
  `options.recollect` asks for the whole list again either way.
- **Two earlier changes are what make running it first safe**, and neither is incidental:
  `saveApplicant` reconciles on `job.id + applicationId` (rule 14, v6) so the later full pass enriches
  *this* record instead of creating a second one under a different hash, and `mergeApplicantRecord`
  protects every scalar field by field (3.7.10) so a blank never erases a stored value.
- **The profile extraction is stopped, never removed.** `extractApplicant` and everything it drives
  is untouched and is still the only path a full run takes; the list pass simply does not call it. A
  test asserts both halves.
- Its own button, **Collect Applicant List**, beside Collect Every Applicant **on the Applicants page
  and in the popup**. It rides `PV_APPLICANT_COLLECT_ALL`, so `listOnly` travels with the armed
  options and returning to the tab resumes a list pass *as a list pass* rather than starting to open
  people. Both whole-job commands in the popup share one handler (`runApplicantJob`), so the
  close-only-on-`{ok, started}` discipline is one rule rather than two copies that can drift.

## Collecting every applicant (3.7.3, amended in 3.7.4 and 3.7.6)

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
**`revealPanelContent()`** ([applicants.js](applicants.js)) does not need to know: it drags the bottom
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
- **Then it waits for the right panel**, on `panelIdentity()` changing rather than on the address bar,
  and then for the DOM to go quiet so the shell has finished mounting. **Nothing may click again
  while a profile is still loading**: the caller advances only on the resolved value, an applicant
  already shown is not re-clicked (`rowId !== openId`), and a row that never opened is *skipped*
  rather than scanned as somebody else.
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
- **A scan may never scroll the applicant list** (3.7.10, `choosePanelScrollTarget()`). "Carries the
  content being read" is true of a wrapper around **both** columns, and `scrollCandidates()` offers
  every ancestor of the panel — so the scan could resolve its target to a container that scrolls the
  list, and then drove it: `scanApplicantPanel` opens with `scrollPanelTo(0, target)` and restores in
  its `finally`, which on that target reads as *drag the list to the top, walk it to the bottom, snap
  it back*, once per applicant. That was the reported behaviour. `scrollCandidates(root,
  { excludeList: true })` refuses any candidate holding **two or more** row links — one is fine, the
  panel legitimately links to the applicant it shows, and it is the same `rowLinksIn` test
  `applicantPanel()` applies. A **page-level** fallback is refused for the same reason. It is a
  parameter and not a blanket rule, because the list's own scroller is a legitimate target for the
  list's own callers. **A null target then means "do not guess", never "drive the page"**: every
  `scrollPanelTo` in the scan is guarded and the position walk is skipped outright, because
  `scrollPanelTo(top, null)` falls back to `window.scrollTo` — which would have brought the very
  behaviour back in through the fallback. `revealPanelContent` needs no target at all, so nothing is
  lost.
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

**Pressing Collect Every Applicant in the popup closes the popup** (3.7.7). The run happens on the
hiring tab, which the worker has just activated and focused, so a popup hanging over it covers the one
thing the button was pressed to watch. It closes **only on `{ ok: true, started: true }`** — the
worker's own proof that it resolved the tab, revealed it, got a matching-build `PV_APPLICANT_PING`,
armed the auto-run and dispatched `PV_APPLICANT_EXTRACT_ALL`. Anything less keeps the window open and
shows the error, because a window that vanishes on failure is a button that silently did nothing. It
does **not** use `runImport`, which is shared with Start Collecting and Collect This Applicant;
`closePopup()` clears the poller first and latches `closing`, which every state write checks, because
`window.close()` does not tear the document down synchronously.

**Contact details are accumulated, not read once.** `collectRenderedContacts()` and
`collectFeaturedDocuments()` ([content.js](content.js)) run on **every** snapshot of the scan and feed
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
2. Check the LinkedIn session; open LinkedIn's own sign-in page and pause if signed out.
3. `resolveConnectionsTab()` opens or reuses **one** Connections tab **in that same window** and
   makes it the active tab. A tab already on the page is re-activated, never reloaded.
4. Enumerate the whole list, persisting every pass.
5. Stop on stable bottom + reconciliation → `connections_complete`.
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
there rather than in [connections.js](connections.js) or [content.js](content.js) — there is no jsdom
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
| Pagination labels and the connections-total selector are **assumptions** until checked live | [connections.js](connections.js) |

**Live-layout limitation:** LinkedIn changes its DOM per account. Passing fixtures and unit tests does
**not** prove live correctness — loading `dist/` in Chrome is a user-browser step (phase 30). Never
claim live success without it.

## Companion docs

Keep in sync: [WORKFLOW.md](WORKFLOW.md) (how a change is investigated, made, checked and saved —
the working method these rules produce), [AGENTS.md](AGENTS.md), [TECH_STACK.md](TECH_STACK.md) (with
[package.json](package.json)), [MEMORY.md](MEMORY.md), [CHECKS.md](CHECKS.md) (**real results only**),
[PHASES.md](PHASES.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), [CHANGELOG.md](CHANGELOG.md),
[SKILLS.md](SKILLS.md), [README.md](README.md).

**Not binding, and deliberately outside that list:**
[COMPLETE_EXTRACTION_SPEC.md](COMPLETE_EXTRACTION_SPEC.md) — the proposed target state, in which a
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
