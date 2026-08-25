# Profile Vault React — Project Status

**Status date:** 2026-08-25
**Version:** 3.10.0
**Build ID:** `2026-08-25-react-v3.10.0`

## Latest work — the refresh LinkedIn asked for, and messaging one applicant (3.10.0)

Two separate changes, and the second is what makes this a minor bump rather than a patch.

**The resume scan (TASK-0189).** *"Scanning resume for viruses. Please refresh the page now."* —
LinkedIn's own words, in the resume card, reported a second time and with the detail that settles
it: *"this is after many applicants profiles are saved"*. The reporter named the remedy themselves,
and the run now does what the notice asks — reloading at that applicant when waiting does not help,
and coming back for what it still owes. The budget that stops it looping rides on the auto-run lease
rather than in the run, because a reload destroys every counter in the document it bounds.

**Applicant messaging (TASK-0188, TASK-0190).** Message one applicant from a reusable template,
filled from that person's already-collected record. The panel's own **Message** control becomes the
**ninth click**, exempted from the denylist for that one purpose and no other.

**It inserts and stops.** LinkedIn's composer says *"Press Enter to Send"*, and the human presses it.
No Send control is resolved, found or pressed — `send` and `inmail` stay denylisted for *every*
purpose, so none could be classified clickable by any caller, and there is no `SEND` message type.
There is no bulk anything: one applicant, one composer, one insertion, driven by the user.

An unresolved template variable **blocks** the message rather than rendering nothing, because the
alternative is sending somebody `Hi ,` — rule 1, a wrong value is worse than a blank one. The
composer must also say who it is addressed to and agree, since the messaging overlay persists
between applicants and the *previous* conversation is routinely what is on screen.

**Rule 5 was amended in the same task**, as an amendment to that rule must be. A test — not
reading — caught the one real hole: `Message` with `aria-label: "Send message"` was allowed, because
the label check prefers visible text and the anchored allowlist never saw the verb. Closed the same
day, and recorded in [CHECKS.md](CHECKS.md).

**Still open:** none of the messaging path has run live, and it is the one feature here whose
mistakes reach a person rather than a spreadsheet cell. See
[applicant-messaging-guide.md](applicant-messaging-guide.md) for what to do the first time.

## Latest work — six releases on one pager control (3.9.4 – 3.9.8)

One defect, reported four times with the same screenshot — a `1` in a filled circle and a plain `2`
beside it — and it took six releases because each build fixed a different step of the same path.
**3.9.4 and 3.9.5 wrote no CHANGELOG entry of their own**; what they did is described inside the
3.9.6 and 3.9.7 entries, which is where to look for them.

- **3.9.3 – 3.9.5** each answered *which page is being shown* a different way: `aria-current` on the
  numbered control, then the two ancestors above it, then the walk's own history — standing on the
  one fact no layout can remove, that pressing the control labelled N leaves you on page N.
- **3.9.6 (TASK-0185)** — all three were downstream of a step nobody had looked at: **forming the
  group**. A number is trusted only inside a proven group of page numbers, and the group was never
  formed.
- **3.9.7 (TASK-0186)** — the readers *contradicted each other, so none of them ran*. Four builds had
  worked on controls that offered a page number in the first place, and that was the broken step.
- **3.9.8 (TASK-0187)** — **the run pressed the page it was already on, and had for five releases.**
  `APPLICANT_PAGINATION_PATTERN` carried `page \d+` on its **named** branch, which runs first and is
  handed no `currentPage`, so it could not tell the page being shown from the page after it. On a
  pager labelled `Page 1` / `Page 2`, the first control the classifier allowed was page one. Found by
  a parallel trace of the whole click path and confirmed by execution before a line was changed.

## Previously — the first live diagnostics report (3.9.3)

3.9.2 made the report retrievable. This is what the first one said, and **it contradicted the fix
that had just shipped**: `reason: "no-contact-menu"`, `menuClicked: false`, `menuLabel: ""`. Nothing
was ever pressed — the overflow menu was never found at all, because its accessible label carries a
screen-reader half (`More options More...`) and the pattern was anchored on the whole of it.

Two rounds of reasoning about markup produced a wrong diagnosis; one download settled it. That is
the single most useful thing to carry out of this release.

Also read straight out of the same report: `diagnostics.expansions` **absent**, so the section
expander had never run on a whole-job run — `education: 1` from a panel whose markup held two, the
second `visually-hidden` behind `Show 2 more educations`. And a resume that downloaded fine and
saved with **no extension**, because the content-type the server states was being fetched and
discarded.

**Open live questions** are in [CHECKS.md](CHECKS.md), and item 0 is now *does the report still
come back* — it is the instrument the other eight are answered with.

## Previously — the diagnostics report was unreachable (3.9.2)

Reported live: **Download Diagnostics answered "Nothing to report yet"** on an account that had
just collected a whole job. Three separate nulls, each on its own sufficient — the page deleted its
copy on every address change (and this surface changes address on every applicant), the worker was
never told because a whole-job run is detached, and the worker itself is torn down after thirty
seconds idle, which is less than the walk from the LinkedIn tab to the extension's own page.

No click, column, status or permission moved. The report is the instrument the remaining live
questions are meant to be answered with, which is why it was worth its own release.

**The open live question that matters most** is unchanged and is now reported as still failing:
contact details behind `More...` are not being saved. `diagnostics.contact` records where that path
stops, and until 3.9.2 that record could not be retrieved.

## Previously — the first live capture (3.9.1)

Screenshots of a real recruiter account arrived after 3.9.0 shipped and contradicted three
assumptions at once — all three in one screenshot, and none of them in a reader:

- **`Show 5 more experiences` was being refused.** The expander pattern required more/all/details/full
  to follow the verb immediately, so every counted expander LinkedIn renders was rejected. The
  Experience section is the sole source of `current_role`, `current_company` and `total_experience`,
  which have been empty for four consecutive releases. This is the fix most likely to show at once.
- **`See full profile` was being pressed**, which leaves the applicants page — and the panel, the
  resume card and the list pager only exist there.
- **`More...` was being pressed as a section expander**, opening the ATS action menu and leaving it
  open. That same menu is where the contact details live on this layout, so it is now opened
  deliberately and for that one purpose: the **eighth click**, with CLAUDE.md rule 5 amended in the
  same task.

Separately, LinkedIn's virus-scan state now has a name. It was being recorded as `UNAVAILABLE` — a
wrong value for somebody who does have a CV — and is now `NOT_ATTEMPTED` with a warning on the
record, which the merge preserves. And the descriptor check no longer downloads the whole document
to read its content-type.

**Open live questions** are in [CHECKS.md](CHECKS.md). The one to watch hardest: this is the first
release that opens an ATS menu, and nothing inside it may ever be activated.

## Previously — the same person, whichever way the page is drawn (3.9.0)

Twelve phases of [`multiple-linkedin-dom-ui-support-guide.md`](multiple-linkedin-dom-ui-support-guide.md),
TASK-0153 to TASK-0165, one Time Machine task each. Applicant collection now has a fallback layer
under every reader, a section table that can be unit-tested, layout detection that can only reorder
readers, a sanitized capture for a layout nobody has seen, and fixture regressions replayed through
the real parsers. **Nothing in the record, the CSV, the workflow or the click budget changed** —
seventeen applicant fields, nine CSV columns byte for byte, seven clicks, asserted at the end rather
than promised at the start. Suite 475 → 531.

The honest limits, stated in the release rather than buried: **no capture of a second LinkedIn
applicant layout exists**, so zero layout-specific selectors were added — Phase 5 shipped shape rules,
refusals and documented heading aliases instead, and Phase 9 built the capture that would make a real
second-UI reader possible. `linkedom` was declined for Phase 10 with reasons recorded in the fixture
suite's own header.

**Still open:** none of 3.9.0 has been run live. `docs/CHECKS.md` carries the seven-item live
checklist; the first item is that the *current* UI still works, and it is the one that matters most.

## Previously — the section that was never read, every page, and a resume that saves itself (3.7.8)

`npm run check` passes here: typecheck, build, **411 tests**, validate.

Eight things were asked for, in six separately reversible tasks (TASK-0044 … TASK-0049) plus
TASK-0050 for the version and the documents. Two were **re-reports**, and both were traced to a named
line before anything was edited.

1. **`current_role`, `current_company` and `education` empty — the fourth report.** The parser was
   never the bug. `sectionRootFor` could return a container holding only the heading, and
   `collectSections` then refused to let any later pass replace it — which is why three releases of
   widening the *search* changed nothing. Separately, the profile preview is a **nested scroller** that
   nothing ever scrolled, because the reveal pass uses `scrollIntoView` (ancestors only) and the
   scroll-target chooser refuses a descendant under 60 % text share. Both fixed; the section's real
   markup is now logged when it comes back empty.
2. **The resume opened a tab and the run died in it.** Nothing observed tab creation, so a
   `target="_blank"` control killed the run rather than pausing it. The whole open → save → close →
   return cycle is now the worker's, through the one tab controller, with the tab inactive throughout.
3. **Only the first page of applicants was collected.** Rule 9h adds the pager, with three bounds.
4. **Four columns removed**, with the field/column distinction 3.7.6 established.
5. **The popup's Job applicants section is always shown**, and
6. **the explanatory prose is gone** from all four surfaces.
7. **Row heights are stable** — fixed rows and a reserved status slot.

**Still open:** phase 30. **None of 3.7.3–3.7.8 has been run live** — see CHECKS.md. The live questions
for 3.7.8, in order: does `logSectionScan` now show Experience and Education with blocks (and if not,
what does its `html` say); does `logListWalk` report more than one page; does the resume cycle happen
invisibly and leave no tab behind; and does the table still shift.

## Previous work — the resume that downloads, the return that needs no reload, one visual language (3.7.7)

`npm run check` passes here: typecheck, build, **405 tests**, validate.

Four things were asked for, and they are four separately reversible tasks: TASK-0039, TASK-0040,
TASK-0041, TASK-0042, plus TASK-0043 for the version and the documents. Two of the four were
**re-reports** — behaviour that had already been fixed once and was still wrong live — so both were
traced end to end and the cause confirmed in the source before anything was edited.

1. **Resumes opened a preview and saved no file.** Not because the download was never wired in: it was,
   and the applicant's name reached the filename intact. Four other things were wrong — a viewer that
   would not close and whose close result was discarded at every call site; a document address that
   cannot be found at all when the viewer paints to `<canvas>` or uses a `blob:` URL; a download Chrome
   interrupted being reported as `downloaded` with a path that is not on disk; and no second attempt
   when the first failed. All four fixed. The address is now also looked for in
   `performance.getEntriesByType("resource")` — bounded by a timestamp taken **before** the click,
   which is what stops one applicant's CV being saved under another's name.
2. **Returning to a job restarted the run only after a manual reload.** Two causes, both confirmed:
   the arrival was consumed before the async starter had succeeded, so a single lost race lost it
   permanently and only a fresh `state` recovered it; and the key was the job alone, so a job's own
   other views shared it and coming back from them was never an arrival. Plus a poller was the only
   watcher — `popstate`, `hashchange`, `pageshow`/`persisted` and a `MutationObserver` now sit
   alongside it.
3. **Collect Every Applicant closes the popup**, on the worker's `started: true` and never before.
4. **One visual language instead of four.** A shared `theme.css`, loaded first by all four pages, and
   a redesign built on it: warm neutral surfaces, graphite primary buttons with the accent spent only
   where it earns attention, depth from shadows rather than borders, and wide tables made navigable —
   sticky header, pinned name column, scroll shadows, and one card per row below 860px.

**Still open:** phase 30. **None of 3.7.3–3.7.7 has been run live** — see CHECKS.md. The live questions
for 3.7.7, in order: does the resume file now land on disk (the new `logResume()` console line answers
it directly, including where the address came from and why nothing landed); does the viewer close; does
returning to the job restart the run by each of the three routes separately — in-app navigation, the
Back button, and re-opening the job from another page; and does the redesign hold on a real screen,
since every visual assertion in the suite is a text assertion about a stylesheet.

## Previous work — the section that was there, two resume columns, and coming back (3.7.6)

`npm run check` passes here: typecheck, build, 390 tests, validate.

Three things were asked for, and they are three separate tasks: TASK-0033, TASK-0034, TASK-0035.

1. **Experience, current role and current company were empty on every row — again.** All three come
   from the Experience section and nothing else, so an empty column means no experience card was ever
   read. Four causes, all in how a section is *found*: `^experiences?$` matched the bare word only, so
   `Experience (5)` / `Work experience` / `Experience:` named no section; a section's root was bounded
   by the *next* heading only, so it could reach back over the section above it and the page-wide pass
   refuses exactly that; a section whose list items parsed to nothing never reached the text fallback;
   and a title LinkedIn did not mark up as a heading was invisible. All four are fixed, and the map is
   now built once per snapshot rather than seven times.
2. **And the search now reports itself.** This is the third release to fix a different cause and the
   columns kept coming back empty, so `diagnostics.sectionScan` records the selector targeted, every
   heading the panel and the page rendered with the key each resolved to, where each section was found
   and what nothing named — and `logSectionScan()` puts one line per applicant in the hiring page's
   console. A heading listed with an empty key is a wording to add. There is no jsdom here and the
   fixtures are not the live DOM, so this is the only thing that turns the next attempt into reading
   rather than guessing.
3. **The resume is two columns, not five.** `resume_link` (where to click — the document, or the
   viewer page when that is all there is) and `resume_file` (the saved copy's path, or the file name).
   Every record field is kept: `downloadStatus` is what stops a file being fetched twice, and the
   details drawer shows all three.
4. **Coming back to a job starts its run again.** The worker holds the instruction, because the
   navigation destroys the content script. Only a job `Collect Every Applicant` was pressed on, with
   the options it was pressed with, expiring after twelve hours; both Stops disarm it, because a Stop
   a navigation could undo is not a Stop; and the arrival is keyed on the job, never the URL, because
   opening a row is how a run advances.

**Still open:** phase 30. None of 3.7.3–3.7.6 has been run live — see CHECKS.md. For 3.7.6 the live
question is a specific one: whether the hiring page renders an Experience heading at all, which
`sectionScan.headings` now answers directly.

## Previous work — an applicant command takes you to the page (3.7.5)

`npm run check` passes here: typecheck, build, 387 tests, validate.

Activating a tab is not showing it to anyone. Both applicant commands are pressed from the extension's
own Applicants page — a different tab, usually a different window — and `Tabs.activate()` deliberately
does not focus the window. So the hiring tab became active somewhere the recruiter could not see, and
the button looked dead.

- `activate(tabId, { focusWindow })` defaults to the old behaviour; `revealApplicantTab()` passes
  `true`. Exactly **two** places may take focus, both a direct user command: the sign-in page and an
  applicant command. Heartbeat-driven work still never does (rule 12c).
- With no hiring tab open, one is opened at the last hiring page the extension was **actually on**, in
  the window the command came from. Only a remembered address is used — never one assembled from a job
  id — so the first run still needs the page opened once, and it says so.
- `KEYS.APPLICANT_TAB` makes a second command reuse the tab, and `closeCollectorTabs()` never touches
  it: it is the recruiter's own page, not a collector this extension owns.

## Previous work — the whole panel however it scrolls, and the resume in full (3.7.4)

`npm run check` passes here: typecheck, build, 383 tests, validate. Reported straight after 3.7.3:
`current_role`, `current_company` and the resume file were **still** empty on every row. So the scroll
target was not the only cause.

1. **The bottom is now reached without knowing which container scrolls.** Every position-based walk
   depends on having named the one scrolling container, and getting it wrong is silent.
   `revealPanelContent()` drags the panel's bottom into view with `scrollIntoView`, which scrolls every
   scrollable ancestor the element needs — bounded, stoppable, and it restores the page's own scroll
   position as well as the column's.
2. **A section outside the resolved panel is still the applicant's.** `applicantPanel()` picks the
   smallest container carrying the most section headings, and an unhydrated heading does not count, so
   it can resolve to a sub-container of the real detail column. `buildSectionMap()` now falls back to a
   page-wide search, refusing anything inside the applicant list and any root that swallows a second
   section. This is the direct cause of the empty role/company columns —
   `deriveCurrentPosition` already falls back to the first entry, so empty meant nothing was read.
3. **The resume document is found wherever the viewer rendered it.** The search was four tag shapes
   and a local extension regex; it is now a list of attributes across viewer → panel → page, decided by
   the tested `isResumeDocumentUrl()` so it still cannot return a page route. The URL is waited for over
   the full overlay timeout, and `localReference` is now the file's path rather than a download id.
4. **The resume is five columns**, in the table and the CSV: file, status, document link, viewer link,
   saved-as. A deliberate reorder of the applicant export, and the only one planned.

**Still open:** phase 30. None of this has been run live — see CHECKS.md for the specific things only
a real recruiter account can confirm.

## Previous work — the applicant collector reads the whole column and resumes (3.7.3)

`npm run check` passes here: typecheck, build, 380 tests, validate. All three of these were reported
from a live recruiter account running 3.7.2 — the suite passed 373 tests while every one of them was
happening.

1. **It only collected what was already on screen.** The applicant panel and the applicant list are
   each an independently scrolling column inside a page that scrolls almost nothing, and
   `Connections.chooseScrollTarget()` scores the page at **+60** and penalises depth — so the page won,
   the column never moved, and the first read was already "the bottom".
   `Applicants.chooseColumnScrollTarget()` is the mirror image: it refuses the page, requires the
   candidate to carry the content being read, and takes the **innermost** such container.
   `scrollCandidates()` now offers scroll boxes inside the panel as well as every ancestor,
   `maxScrollPosition()` reads `clientHeight` live, the panel is re-resolved on every step
   (`livePanel()`), and the expander runs again at the bottom where late-mounted sections finally
   exist — inside the same eight-click budget.
2. **Pressing Collect Every Applicant again did nothing until a reload.** `state.wentHidden` is
   latched the instant the recruiter switches tab and was only cleared deep inside `extractApplicant`,
   so the next run threw "the page is hidden" before reading a row and only re-injecting the content
   script cleared it. `beginRun()` now re-derives the flag from the live page, and
   `revealApplicantTab()` activates the hiring tab through `Tabs.activate` before either command,
   because the button is pressed on a different tab.
3. **A restarted run began again at the first applicant.** `createCollectedIndex()`, keyed on the
   `applicationId` in the row's own href — the only identifier a row carries before it is opened — now
   tells the run who to walk past, and `isCollectedApplicant()` keeps a name-only record (a failed
   pass) in the queue rather than skipping it forever. The Applicants page gained a **Re-collect
   already saved** checkbox for a deliberate full pass.

## Previous work — three defects found in a live run (3.7.2)

`npm run check` passes here: typecheck, build, 373 tests, validate. All three of these came from
running 3.7.1 against a real recruiter account, which is what the standing phase-30 warning exists
for: the suite passed 364 tests while all three were happening.

1. **Every applicant was saved as "Applicants".** `applicantPanel()` could resolve to a wrapper around
   both columns — it satisfies "two sections" — and the first line of that container's text is the
   list's own heading. The panel now refuses any candidate holding more than one applicant-row link,
   and the name is chosen by policy (`findApplicantName` → `chooseApplicantName`) with LinkedIn's own
   verdict sentences as the arbiter (`nameFromExplanations`).
2. **Every applicant after the first was read from the wrong panel.** Waiting for the address to
   change and the DOM to go quiet does not mean the panel re-rendered. It now waits on a
   `panelIdentity()` change, and a row that never opens is skipped rather than scanned.
3. **The resume link opened the applicants page, and the worker saved that page as a CV.** The
   control's href is a route; the host check passed it because the host is LinkedIn.
   `isResumeDocumentUrl()` refuses a page address first, `resume.url` and `resume.viewerUrl` are now
   separate fields, and the worker refuses `refused-page-not-a-document`.

## Previous work — both contact details, the resume opened, and an applicant-first export (3.7.1)

`npm run check` passes here: typecheck, build, 364 tests, validate. Phase 30 (live browser
verification) is **still open**.

**Contact info is opened every time.** The "only when the page did not already show both" condition
is gone from the profile overlay and the applicant disclosure alike — a profile whose About showed an
address never had its overlay opened, so the number in that overlay was never collected. And inside a
panel the extension opened itself, **every** address and number is taken, labelled or not
(`parseContactPanel({ trusted: true })`): such a panel is that person's own contact card, so requiring
a heading this build recognises only ever lost values. The rendered page is unchanged, and the
scrubbing that stops a vanity-URL id, a count or a date range being read as a number still applies
inside the trusted panel.

**The resume viewer is opened, scrolled and read**, not merely linked. The control's `href` is usually
a route; the real file name, type and page count exist only inside the viewer, and a PDF viewer
renders its pages as lazily as a profile does.

**The applicant list is scrolled to the bottom before a run**, using discovery's own stop rule.
Reading a virtualized list once gave a screenful, and a run over a 665-applicant job would have
collected ten people and called itself complete.

**The export leads with the applicant**: name, email, mobile, then the resume in three columns.
`job_title` and `location` were dropped as columns; `all_emails` and `all_phone_numbers` were added.

**Fixed:** `total_experience` was blank on every record — `totalExperienceFrom` passed a `{ dates }`
object to a function that reads `dateRange` and `title`.

## Previous work — the recruiter applicant collector, its CSV, and a Stop that always works (3.7.0)

`npm run check` passes here: typecheck, build, 357 tests, validate. Phase 30 (live browser
verification) is **still open**, and it matters more than usual for this release: the hiring surface
was written against two screenshots and has never been run against a live recruiter account from
here. See [CHECKS.md](CHECKS.md) for exactly what was and was not run.

**A third surface.** `linkedin.com/hiring/*` and `/talent/*`. [applicants.js](../extension/content-scripts/applicants.js) is the
framework-free adapter and [src/applicants-core.js](../src/applicants-core.js) is the pure half; the
record lives in its own IndexedDB store (schema v5) and is never a saved profile. An applicant is a
person **on a job** — the same person applying to two jobs is two records. It opens no tab and
navigates nowhere: it reads what the recruiter already has open.

**The workflow, in order.** Detect the job and applicant from the address bar → expand what the panel
has collapsed → walk the panel to the bottom with the same scroll chooser and settle policy the
profile scan uses → open the contact disclosure → find and save the resume → build the record → stream
it to the worker. The order is asserted by a test: an overlay opened mid-scan would stop the lazy walk
dead.

**An absent value is `null`.** A qualification LinkedIn "cannot provide or evaluate" is `unknown`, not
a miss. A job description the applicants view does not render is `null`, not assembled out of the
panel. A resume the account cannot see is `unavailable`, not a guessed link. `currentRole` and
`currentCompany` come from the experience card marked `Present`, never the headline.

**Four new gated controls.** Rule 9 changed from "exactly three, and no others may ever be added" to a
named list **per surface**, with the same discipline: allowlist per purpose, denylist first, container
proven. The hiring denylist adds Shortlist, Move to, Reject, Interview, Rate and the other ATS
actions. Click budgets are asserted per file: `content.js` 3, `connections.js` 1, `applicants.js` 5.

**A Stop that always works.** `Stop Everything` is rendered unconditionally in the popup; `STOP_ALL` is
matched before every other worker branch, and all three content scripts honour it inside their walking
loops, before each step. A stop is an interruption, never a failed record, and it discards nothing.

## Previous work — contact provenance, open-to-work, and a record cut down to the table (3.6.0)

`npm run check` passes here: typecheck, build, 313 tests, validate. Phase 30 (live browser
verification) is **still open** — see [CHECKS.md](CHECKS.md) for exactly what was and was not run.

**Two live defects, one root cause.** A value was being accepted because it *looked* like a contact
detail, with no check on where it came from. Every LinkedIn vanity URL ends in the member's numeric
id, which lands inside the 7–15 digit window a phone number occupies, so
`linkedin.com/in/paarth-khandelwal-264954380` was saved as the mobile number `264954380`; and the
whole-page text sweep read the **Interests** block — which renders *other* members with their own
addresses and numbers — onto the profile being collected.

**The fix is provenance, not a better pattern.** A phone number now comes only from a `tel:` link or
a line under a labelled Phone/Mobile field; an address only from a `mailto:` link or a labelled Email
field. `scanLabelledContacts()` replaced the sweep and keeps exactly one field open at a time — any
other contact label closes it. `extractPhones()` deletes addresses, URLs and word-welded identifiers
before `PHONE_PATTERN` runs, and `contactLinksIn()` rejects any link inside a foreign section or a
card that links to a different member.

**Records already saved are cleaned.** `normalizeProfile` drops a phone contained in the record's own
profile URL, `repairStoredProfiles()` persists that on load, and **Clean shared contacts** removes any
value found on three or more different people.

**The record is now exactly the table**: name, email, mobile, CV, open-to-work, education
institutions, skills, profile URL, status, last collected, notes, tags. `experience`,
`yearsOfExperience`, `currentRole`, `currentCompany`, `currentEmploymentDates`, `totalExperience`,
`websites` and `profileImageUrl` were removed. `openToWorkDetails`, `cvFileName`, `cvAvailable`,
`status` and `lastCollectedAt` were added, education is now institution names only, and the CSV's
first twelve columns are the table column for column. IndexedDB moved to v4.

**A third clickable control**: the Open to work card's own `Show details`, gated by
`classifyOpenToWorkControl()` and only when proven to be inside that card.

## Previous work — two-tab collector workflow and CV/contact-led records (3.5.0)

`npm run check` passed there: typecheck, build, 269 tests, validate.

**The workflow.** One click now: remember the window → open and activate **one** Connections tab in
it → enumerate the list → **automatically** open and activate **one** profile collector tab → drive
that same tab through every queued profile → pause whenever it stops being visible, resume when it
returns → on completion close both collector tabs and open the Saved Profiles table. Never a tab per
profile; no separate collector window. All of it is in the new pure `src/collector-tabs-core.js`,
tested against a fake Chrome.

**The state machine** was rewritten to the specified states and the discovery→extraction hand-over is
automatic — Stop followed by Start Extraction is no longer required.

**The record** was led by CV, name, email, mobile, skills, education, and years of experience — since
3.6.0 it is the list above instead. `headline`, `location`, `about`, `certifications` and `languages`
were removed from the schema, CSV, and UI here.

**`Contact info` became clickable** — on profile pages, at most once per profile, and only when the
rendered page gave up neither an email nor a phone number. Every outreach control stays permanently
forbidden.

## Previous work — live-defect fixes (3.4.0)

Ten problems were observed live on 3.3.0. Root cause and fix for each:

| Reported | Root cause | Fix |
|---|---|---|
| 1. Only worked while the collector tab was visible | Nothing read `document.visibilityState`. A hidden tab is throttled and unrendered, so the DOM froze — and every completion signal is "the page stopped changing". Hidden read as **finished**. | Both content scripts gate on visibility, listen for `visibilitychange`, and return `hidden: true` / `atBottom: false`. Worker pauses `paused_visibility`, saves nothing, resumes on the heartbeat. `prepareCollectorStep()` activates the tab and un-minimizes the window per step. |
| 2. 67 reported, 66 saved | Coverage confirmed on `discovered >= totalCount`, counting only URLs that parsed. The 67th is a restricted member with no profile link, so 67 was unreachable. | Coverage settles on `unique URLs + cards with no usable URL`. `gap` records the difference; `terminalStateFor()` returns `completed_with_gap`. |
| 3. Discovery ran forever | Two unbounded loops: `grew` counted a pagination **click** as growth, so a dead control reset the quiet counter every pass; and the drain loop did `await delay(2000); continue;` with no counter or budget. | Growth means new connections only; `MAX_FRUITLESS_PAGINATION` (3) retires a dead control; `MAX_FRUITLESS_DISCOVERY` (3) bounds the drain loop. |
| 4. No automatic hand-off to extraction | `startCollectingWorkflow()` awaited `runDiscovery()`, which never returned (cause 3). | Fixed by (3), plus an explicit `ready_to_extract → extracting` transition. |
| 5. Only worked after Stop then Start | Stop aborted the stuck discovery; the queue was already populated. | Same as (4). |
| 6. Profiles saved before lazy sections loaded | Same as (1). | Scan aborts with `hiddenPageError()` before the profile is assembled. |
| 7, 8. Role/company/skill contamination | Entity `innerText` merges metadata spans (`"TechMatrix Consulting 9 mos"`); `"Full-time"` was a legal company; skills were read from each card's whole container text, which includes the `Endorse` button and the role sentence. | `stripEntityMeta()`, `sanitizeCompanyName()`, `sanitizeRoleTitle()`, `isSkillValue()` applied at parse, grouping **and** accumulator level; skills read from `entityHeadingText()`. |
| 9. Redundant/unclear buttons | — | Primary/Advanced split, one compact session component, `Import`→**Connections Collector**, `Table`→**Saved Profiles**. |
| 10. Unreadable saved-profiles table | Full `ExperienceCards`/`EducationCards` rendered inside `<td>`. | Compact summaries (`N companies · M roles`, 3 skills + `+N more`, 2-line headline) with a **View details** side panel holding the full cards. |

Also added: the deterministic `COLLECTION_STATE` machine with idempotent transitions, so a
service-worker wake-up cannot start a second discovery or a second extractor.

Verification: `npm run check` exit 0 — typecheck clean, build clean, **222 tests passing**, validate
clean. The new `tests/live-regressions.test.js` failed 21/23 before the fixes and passes 23/23 after.
`dist/` inspected directly. Phase 30 (live browser) remains open.

## Previous work — automatic collector workflow (3.3.0)

Reported requirement, and what was done about each:

| Requirement | Fix |
|---|---|
| One click must check login, redirect to Connections, discover everything, then extract | `startCollectingWorkflow()` in [background.ts](../src/background.ts) does exactly that, in that order, detached from the message that started it so the popup and import page can close. A test asserts the ordering. |
| Never open multiple processing tabs | **Root cause:** `resolveConnectionsTab()` called `chrome.tabs.create()` for a connections tab unrelated to the stored import tab, so a run used two tabs. Now `ensureCollectorTab()` is the single creation site (one `chrome.windows.create`), and `chrome.tabs.create` no longer appears in the worker at all. |
| Detect login; open LinkedIn's login page; never store credentials | `classifyAuthState()` (pure) reports Signed in / Login required / Checkpoint detected / Unknown; `Sign in to LinkedIn` only navigates to `https://www.linkedin.com/login`. A test greps every UI and content file for password inputs, `document.cookie`, and `chrome.cookies`. |
| Explain 67 reported vs 66 collected | `createCardLedger()` + `reconcileDiscovery()` account for every rendered card as usable, duplicate link, or no-usable-link (restricted/deleted). Shown on the importer page; an unexplained remainder is stated explicitly. |
| Clear Queue must stop the process without deleting saved profiles | `abortRunningWork()` generation token ends in-flight discovery and extraction; `Queue.clearQueue()` wipes queue rows, counters and session progress and cannot reach the profile store. |
| Show LinkedIn total, missing/inaccessible, skipped, current profile, final stop reason | New tiles plus `STOP_REASON` / `stopReasonText()` and the reconciliation panel. |
| Wait for the profile to load | Fixed a latent race: `waitForTabComplete()` resolved on the *previous* page's `complete` status, because `chrome.tabs.update()` leaves `tab.url` stale until the navigation commits. |

Verification: `npm run check` exit 0 — typecheck clean, build clean, **196 tests passing**, validate
clean; `dist/` inspected directly (1 `chrome.windows.create`, 0 `chrome.tabs.create`, build ID
consistent in 5 files). Phase 30 (live browser) remains open.

## Previous work — connections importer rebuild

Reported problems, and what was done about each:

| Report | Fix |
|---|---|
| Only ~10 connections discovered | `discoveryPass()` stepped from `window.scrollY`, which never moves when LinkedIn scrolls an inner container. Position now spans both scrollers. Also: `listRoot()` no longer assumes `<main>`, card reading falls back to a relaxed visibility test, and `runDiscovery()` enqueues `entries` (with names) instead of `urls`. |
| Full list not available | **Find All Connections** (`PV_IMPORT_DISCOVER_ALL`) enumerates the whole list across resumable passes and writes it to IndexedDB after every pass. |
| No pagination in the UI | The connections page is a paginated table: 25 or 50 rows, Previous/Next/page numbers, search, status filter, total count. |
| Profiles read before lazy loading finished | Name/headline/location were extracted *before* the scroll pass. The page is now walked in full first, and the top card is re-read on every snapshot. |
| Important profile information missing | The scan now ends only at the bottom with three consecutive unchanged reads, so virtualized sections are not lost; skills/certifications/languages caps raised. |
| Interface simplified too much | Find All Connections, Start Profile Extraction, Stop, Retry Failed, View Saved Profiles Table, Download CSV, search, status filter, editable refresh window, the counts, progress bar, and the paginated list — all test-enforced. The three-button cap is gone. |

Preserved and still test-enforced: challenge detection, the pagination allowlist / outreach denylist,
bounded retries, one profile at a time in one reusable tab, local-only storage, LinkedIn-only host
permissions, CSV safety, and the React 16 class-component architecture.

Verification: `npm run check` exit 0 — typecheck clean, build clean, **132 tests passing**, validate
clean. Phase 30 (live browser) remains open; see the honest limitation at the bottom of this file.

## Current status

Phases 21–29 are implemented. The connections importer now enumerates the account's connections
across resumable multi-pass discovery, pages the list with allowlisted controls, and runs batches that
cool down and continue on their own. All prior behavior was preserved and its tests still pass.

Decisions D1, D2, and D3 were approved on 2026-08-02 and are implemented exactly as scoped.

## Requirement status

| Requirement | State |
|---|---|
| Explore all connections of the signed-in account | **Implemented** — multi-pass, resumable, deduplicated, with confirmed/estimated coverage |
| Open a connection's profile automatically and collect data | **Implemented** |
| Save automatically, leave, and continue to the next | **Implemented** |
| Repeat until everything is collected | **Implemented** — batch cap → cooldown → automatic next batch |

## Added in 3.2.0

- `parseConnectionCount()` / `readConnectionTotal()` — advertised total, with rounded `500+` values
  flagged unreliable
- `classifyControl()` — pagination allowlist plus a permanent outreach denylist (D1)
- Resumable `discoveryPass()` driven from a persisted `cursorY`, with a worker-side pass loop
- `applyDiscoveryPass()` / `coverageReport()` — the coverage ledger
- `chrome.alarms` heartbeat and split recovery semantics (D2)
- Batch cap, cooldown, automatic next batch, randomized 4–9 s pacing (D3)
- `shouldSkipAsFresh()` refresh policy with a Force refresh override
- `classifyFailure()` / `backoffDelayMs()` — permanent vs transient failures with exponential backoff
- `putItem()` single-row queue writes and a paged queue table
- **Popup controls**: `Start full extraction` (discover + collect everything) and `Continue extraction`
  (resume from where it stopped), with live progress, backed by a new `PV_IMPORT_RUN_ALL` command

## Verification actually performed

| Check | Result |
|---|---|
| Baseline `npm test` before 3.2.0 | 67 passing |
| `npm run typecheck` | pass |
| `npm run build` | pass — `dist` 31 files |
| `npm test` after | **103 passing, 0 failing** |
| `npm run validate` | pass — 22 build files, 3 React entry points, worker imports |
| `npm run check` | exit 0 |
| `dist` inspection | manifest byte-identical; classic scripts ESM-free; exactly one `.click()` in `dist/connections.js`, guarded by the classifier; `chrome.alarms` present; build ID consistent in 5 files |

Full detail, including the phase-to-test map, is in `CHECKS.md`.

## Permissions

`activeTab`, `scripting`, `storage`, `downloads`, `alarms`, and LinkedIn-only host permissions.
`alarms` was added solely for the D2 heartbeat. `unlimitedStorage` was **not** added — no storage
quota problem has been demonstrated, and a test enforces that.

## Honest limitation

The build has **not** been loaded into Chrome from this environment and no live LinkedIn session was
exercised. In particular these are **assumptions that only live evidence can confirm**:

- that LinkedIn's Connections page exposes an exact, parseable total;
- that the pagination labels in the allowlist match the live markup;
- that the list container and control containment checks hold against the real DOM.

If the live DOM differs, discovery will under-report coverage or find no pagination control — it will
not misbehave, but it will not reach full coverage either. Phase 30 in `PHASES.md` tracks this and is
still open. No claim of live completion is made.
