# MEMORY.md

## Durable project decisions

- The project is a Chrome/Chromium Manifest V3 extension named **Profile Vault React**.
- Highest-priority rules live in `CLAUDE.md`. `GEMINI.md` was removed in 3.1.0 and must not return.
- Extension version is `3.7.8`; the build ID is `2026-08-03-react-v3.7.8`.
- **A hidden collector tab is not a finished one.** Chrome throttles background tabs and LinkedIn does
  not render a hidden page, so "nothing changed" — the completion signal for both discovery and
  profile scans — becomes true for the wrong reason. Both content scripts gate on
  `document.visibilityState`; the worker pauses with `paused_visibility` and never saves partial data.
- **`COLLECTION_STATE` is the source of truth**, not booleans. `transitionCollection()` refuses repeat
  and illegal moves, which is what stops a worker wake-up from starting a second discovery.
- **Discovery termination needs all three bounds**: growth means new connections (never a pagination
  click), `MAX_FRUITLESS_PAGINATION`, and `MAX_FRUITLESS_DISCOVERY`. Removing any one brings the
  infinite run back.
- **Coverage settles on `unique URLs + cards with no usable URL`.** Requiring `discovered >= total`
  made 67-reported/66-usable hunt forever for a URL that cannot exist.
- **Never trust a LinkedIn entity's `innerText` for a single field.** It merges company, employment
  type and duration into one line. Sanitize in the core, and read skills from the card heading.
- **Two collector surfaces, both in the user's own window** (amended in 3.5.0).
  `src/collector-tabs-core.js` is the only place any tab is created, activated, or closed; it takes
  `chrome.tabs`/`chrome.windows`/`chrome.storage` by injection so the policy is testable without a
  browser. `chrome.tabs.create` and `chrome.windows.create` must never appear in the service worker.
  ONE Connections tab and ONE reusable profile collector tab serve the whole run - never a tab per
  profile, and no separate collector window any more. A tab the user has switched away from stops
  LinkedIn rendering lazy-loaded content, so the run pauses into `paused_hidden` and resumes when the
  tab is visible again. On completion `finishRun()` closes both collector tabs and opens the Saved
  Profiles table.
- **Every clickable control is named in CLAUDE.md rule 9, per surface** (amended in 3.7.0; through
  3.6.0 the rule read "exactly three, and no others may ever be added"). Profile pages still have
  exactly three: connections pagination, `Contact info` (gated by `classifyContactControl()`, once per
  profile and — since 3.7.1 — on **every** profile), and the Open to work card's own `Show details`
  (gated by `classifyOpenToWorkControl()`, proven inside that card). 3.7.0 added a **third surface**
  with four more, all gated by `classifyApplicantControl({ purpose, inContainer })`: the applicant's
  contact disclosure, their resume (opened every time since 3.7.1 — the href is usually a route and
  the file name lives only inside the viewer), a collapsed section's expander (capped at
  8), and a row of the applicant list. **The discipline was not loosened** — allowlist per purpose,
  denylist first, container proven. The hiring denylist adds Shortlist, Move to, Reject, Archive,
  Hire, Offer, Interview, Schedule, Rate, Good fit / Maybe / Not a fit and Add note. Tests assert the
  budget per file: `content.js` 3, `connections.js` 1, `applicants.js` 5.
- **The applicant record is not a profile** (added in 3.7.0). It lives in its own IndexedDB store, its
  `id` is `jobId|profileUrl|name|applicationId`, and **an applicant is a person ON A JOB** — the same
  person applying twice is two records. **An absent value is `null`**, never `""` and never a guess: a
  qualification LinkedIn "cannot provide or evaluate" is `unknown` and never a miss, a job description
  the view does not render is `null`, and a resume the account cannot see is `unavailable`.
  `currentRole`/`currentCompany` come from the experience card marked Present, **never the headline** —
  the reference screen's headline names no employer at all.
- **Resumes are downloaded by the service worker, never the content script** (a content script has no
  `chrome.downloads`). Three refusals first: a non-LinkedIn host, a URL already reported as
  `downloaded` by any stored record, and a URL the page never rendered. `saveAs: false` plus
  `conflictAction: "uniquify"` into `profile-vault-resumes/`, because a 600-applicant run must not ask
  600 questions or overwrite 600 files.
- **The universal Stop is always available** (added in 3.7.0). `STOP_ALL` is matched before every other
  branch in the worker; it bumps the generation token, broadcasts to every LinkedIn tab, stops the
  session, clears the heartbeat and closes the collector tabs. All three content scripts check
  `state.aborted` **inside their walking loops, before each step**, and report a stop as an
  interruption (`stopped: true`, `atBottom: false`) — never a failed record, never a finished list.
  **Stop ends work; it never discards what that work produced.** The popup's button is unconditional:
  the old `{running || cooling || discovering ? …}` guard is the bug, and a test forbids its return.
- **The record IS the table** (amended in 3.6.0): name, `email`, `mobile`, `cvUrl`,
  `openToWorkDetails`, `education`, `skills`, `profileUrl`, `status`, `lastCollectedAt`, plus the
  user's `notes` and `tags`. `experience`, `yearsOfExperience`, `currentRole`, `currentCompany`,
  `currentEmploymentDates`, `totalExperience`, `websites` and `profileImageUrl` were removed in
  3.6.0, and `headline`, `location`, `about`, `certifications` and `languages` in 3.5.0 - do not
  reintroduce any of them.
- **A contact detail needs provenance — outside our own panel** (added in 3.6.0, scoped in 3.7.1). On
  the rendered page a phone number comes only from a `tel:` link or a labelled Phone/Mobile field, and
  an address only from a `mailto:` link or a labelled Email field. Two live defects came from ignoring
  that: a vanity URL's member id saved as a mobile (`.../paarth-khandelwal-264954380` -> `264954380`),
  and the Interests block's Top Voices putting a stranger's address and number on the record.
  `scanLabelledContacts()` replaced the whole-page sweep; `extractPhones()` deletes URLs, addresses
  and word-welded identifiers first; and `contactLinksIn()` rejects links in foreign sections or in a
  card linking to a different member. **Inside a panel the extension opened itself** — the
  `Contact info` overlay or an applicant's contact disclosure — `parseContactPanel({ trusted: true })`
  takes **every** address and number, labelled or not: that panel is the person's own contact card, so
  requiring a heading this build recognises only ever lost values. The scrubbing still runs in there,
  so the id, the count and the date range are still refused. **Do not widen `trusted` beyond a panel
  this extension opened on the person being collected.**
- **Activating a tab is not showing it to anyone** (added in 3.7.5). `Tabs.activate()` deliberately
  does not focus the window, which is right for the heartbeat-driven import run and wrong for a button
  press: the applicant commands are pressed on the extension's own page, often in another window, so
  the hiring tab became active somewhere the recruiter could not see and the button looked dead.
  `activate(id, { focusWindow: true })` is now used by exactly two things — the sign-in page and an
  applicant command. **A direct command may take focus; background work never may.** And when no
  hiring tab exists at all, the last address the extension was *actually on* is reopened
  (`rememberHiringUrl`) — never a path assembled from a job id, which would be the same class of
  mistake as guessing a resume link.
- **Identifying the scroller is a guess; `scrollIntoView` is not** (added in 3.7.4). 3.7.3 fixed the
  scroll *target* and the columns were still empty, because every position-based walk here depends on
  having named the one container that scrolls — and getting it wrong is **silent**: the walk runs, the
  position never moves, the first read is already the bottom. `revealPanelContent()` drags the bottom
  of the panel into view instead, and the browser scrolls every scrollable ancestor the element needs,
  so a column this build does not recognise still moves. **Keep a container-agnostic pass behind any
  position walk on a surface whose markup we do not control.**
- **A section outside the resolved panel is still the applicant's** (fixed in 3.7.4).
  `applicantPanel()` picks the smallest container carrying the most section headings, and a heading
  that has not hydrated does not count — so it can resolve to a *sub-container* of the real detail
  column, and Experience, Education and Skills were then invisible for the whole extraction. That is
  why `current_role` and `current_company` were empty on every row: `deriveCurrentPosition` already
  falls back to the first entry, so an empty column meant **no experience was read at all**.
  `buildSectionMap()` now falls back to a page-wide search, refusing anything inside the applicant list
  and any root that swallows a second section. **A container-scoped search is only as good as the
  container.**
- **A section is not found by its bare word** (fixed in 3.7.6, after 3.7.3 and 3.7.4 each fixed a
  different cause and the columns were *still* empty). `^experiences?$` matched `Experience` and
  nothing else, so `Experience (5)`, `Work experience` and `Experience:` named no section at all —
  and `current_role`, `current_company` and `total_experience` all come from that section and nothing
  else, so all three were empty with no warning anywhere. `sectionKeyFor()` strips an inline count and
  a trailing colon; the patterns carry the qualifiers; `sectionLabelsIn()` covers a title that is not
  a heading element. **A section that is not found produces no warning, only zeros.**
- **A section's root must be bounded by every other heading, not by the next one** (fixed in 3.7.6).
  Bounding on the next heading alone lets the ancestor reach back over the section *above* — which is
  exactly what the page-wide pass refuses (a root swallowing a second section), so the widened search
  returned nothing for the section most often outside the panel.
- **A failed parse is not a read** (fixed in 3.7.6). `if (added || blocks.length) return added` treated
  "the markup had list items" as "the section was read", so a section whose items were chrome silenced
  the text plainly on screen. Fall through on `added === 0`.
- **When a search can fail silently, make it report itself** (3.7.6). Three releases fixed three real
  causes of the same empty column and the column stayed empty, because nothing said what the search
  had actually seen. `diagnostics.sectionScan` records the selector targeted, every heading the panel
  and the page rendered **with the key each one resolved to**, where each section was found and what
  nothing named; `logSectionScan()` puts one line per applicant in the page's console. There is no
  jsdom in this repo and the fixtures are not the live DOM (rule 17), so a report is the only thing
  that turns the next attempt into reading rather than guessing.
- **Five columns to answer one question is a table nobody reads** (3.7.6). The applicant resume was
  `resume_file`, `resume_status`, `resume_link`, `resume_viewer`, `resume_saved_as`; it is now
  `resume_link` (where to click) and `resume_file` (which file we have). Consolidating *columns* is not
  dropping *fields* — `downloadStatus` is what stops a file being downloaded twice and
  `viewerUrl`/`localReference` are what the two columns are built from, so all of them stay on the
  record and in the details drawer.
- **A section root that holds only the heading is not a section** (fixed in 3.7.8, after 3.7.3, 3.7.4
  and 3.7.6 each widened the *search* and none of them helped). `sectionRootFor` seeded its answer
  with the heading's own parent and walked only upwards. LinkedIn renders an applicant's section title
  in its own header row — the word plus a collapse chevron — with the entries in a *sibling*
  container, so it returned a root whose whole text was "Experience". Require a candidate root to
  carry more than the heading, and when no ancestor qualifies take the heading's **following
  siblings** up to the next section.
- **Two fields failing together names the layer** (3.7.8). `current_role`, `current_company` AND
  `education` were all empty while Qualifications came through. One broken parser cannot do that; a
  shared step above all three can. Ask what the failures have in common before touching the thing the
  report points at.
- **A stored answer that is not useful must not block a better one** (3.7.8). `collectSections`
  refused to replace a key already in the map, so one degenerate root from the first pass permanently
  blocked every rescue pass added over three releases. Guard fill-in on **usefulness**, not presence —
  otherwise every later fix is dead code that still passes its tests.
- **The rule that picks the ONE scroll target is the wrong rule for revealing** (3.7.8, and the
  reporter's own hypothesis). `scrollCandidates` refuses a descendant carrying under 60 % of the
  panel's text, which is right for "which container should the position walk drive" and wrong for
  "what should be scrolled so it renders". A nested profile-preview box was refused by that gate and
  never scrolled by `scrollIntoView` either — that only moves an element's **ancestors** — so
  everything below its fold was never read. Reveal every scrollable region; choose only one to walk.
- **`scrollIntoView` scrolls ancestors, never descendants** (3.7.8). Worth stating on its own: it is
  the reason a "scroll whatever it takes" backstop can still miss a nested scroller entirely.
- **A tab you did not open is a tab you cannot close** (3.7.8). A bare click on a resume control that
  turned out to be `<a target="_blank">` opened a foreground tab nothing observed, the page went
  hidden, `assertRunnable()` threw and the row loop **broke** — so the run was dead, not stuck, and
  closing the tab by hand did not restart it. Open it yourself, in the worker, inactive, and close it
  in a `finally`.
- **A hidden page is a reason to WAIT, not a reason to discard the list** (3.7.8). Rule 12a says never
  read a hidden page; it does not say abandon the run. Those are different decisions and conflating
  them turned every momentary tab switch into a lost run.
- **"The container stopped growing" is not "the list has ended" on a paginated list** (3.7.8). The end
  of page one looks exactly like the end of everything unless something looks for the pager. The
  connections list had already solved this; the hiring list had not.
- **A summary of the column beside it is not a column** (3.7.8). `must_have_met` was `0 of 10`
  computed from `qualifications`, which was itself a column two cells to the left.
- **Removing a field is not the same as removing a column** (3.7.8, restating 3.7.6). `applicationStatus`
  is an IndexedDB **index** and backs a filter; `collectedAt` is preserved across merges. Both left
  the table; neither left the record.
- **Conditional banners move everything below them** (3.7.8). `{message ? <div/> : null}` on a page
  that polls every three seconds is a layout shift on a timer — which is what "the rows keep shifting"
  turned out to be, together with rows whose height followed their content while that content filled
  in mid-run. Reserve the slot; fix the row height.
- **A sampling watcher misses the transition it is watching for** (3.7.7). The restart-on-return
  worked after F5 and never otherwise, and an 800 ms poller was half the reason: it observes *states*,
  so a round trip completed between two ticks is invisible, and a back/forward-cache restore is
  invisible to it in principle because the same document comes back holding the state it was frozen
  in. Watch *events* — `popstate`, `hashchange`, `pageshow` with `event.persisted` — and keep the
  poller as a backstop. Note that **`history.pushState` cannot be hooked from a content script**: the
  isolated world has its own `history` object, so a patch there never sees the page's own call. What
  *is* observable is the re-render that follows, which is what the `MutationObserver` is for.
- **Do not consume a trigger before the work it triggers has succeeded** (3.7.7). `checkAutoRunArrival`
  wrote `lastKey` and then called an async, fire-and-forget starter with several silent bails, so one
  lost race — a list not yet mounted after an SPA route, a sleeping worker — lost the restart
  permanently, and only a reload (fresh state) recovered it. Record the trigger, fulfil it in a
  separate repeatable step, and split the bails into **transient** (retry, bounded) and **terminal**
  (clear, and say why). A silent bail that also discards its own retry is unfixable from a bug report.
- **A key that is too coarse fails in the direction nobody tests** (3.7.7). Keying the arrival on the
  job alone correctly stopped a row-open from restarting the run — and also made returning to the
  Applicants list from the job's own other views a no-op, because they share the job id. The key is now
  the job plus the pathname with its ids stripped: stable across the thing that must not count, and
  different across the thing that must.
- **A close that is not verified is a close that did not happen** (3.7.7). `closeOpenedOverlay`
  dispatched a synthetic Escape (`isTrusted: false`), fell back to a `<button>` **inside** the matched
  element only, and had its boolean result discarded at every call site — so "the resume preview is
  still on screen" was a state the extension could be in without ever saying so. Search the modal
  wrapper as well as the content, accept `a`/`[role=button]`, retry, and **put the failure on the
  record**.
- **When the page will not write an address down, read what it fetched** (3.7.7). A document viewer
  that paints to `<canvas>` or hands over a `blob:` URL renders no attribute an extension can read,
  so attribute scanning found nothing and every applicant came back `link_only`.
  `performance.getEntriesByType("resource")` is the browser's record of what the page **actually
  requested** — an observation, not a guess, so it stays inside rule 6. **It must be bounded by a
  timestamp taken before the action**: the buffer belongs to the document, and a run walks hundreds of
  applicants through one without navigating, so an unbounded read saves one person's CV under
  another's name.
- **Never report a failed write as a successful one** (3.7.7). `chrome.downloads.download()` resolves
  with an id, not an outcome; the download can still be interrupted afterwards. Returning the
  *requested* path on `state === "interrupted"` while answering `downloaded` put a path that is not on
  disk onto the record — and the merge rule that protects a downloaded resume then made it permanent.
  Read the outcome back, and let a failure be a failure.
- **Four stylesheets are four palettes** (3.7.7). Each of the four surfaces carried its own copy of the
  same primitives and disagreed about every one: four page backgrounds, three inks, two font stacks,
  and two files defining the **same** custom property names with different values. `.danger` was a
  solid fill on three screens and an outline button on the fourth. One shared `theme.css`, loaded
  first, with the page files holding only what is genuinely theirs.
- **A global rule on a bare element selector reaches things you did not picture** (3.7.7). Styling
  `label` as the small, tracked-out, stacked field-name voice broke every label that is a *sentence
  with a control in the middle of it*. Same class of error: `.status` as a shared notice primitive also
  matched a table cell called `status`. Cross-check every class the UI emits against what the
  stylesheet defines — `tests/visual-layer.test.js` does exactly that now.
- **Tune a muted colour against the darkest surface it lands on, not against white** (3.7.7).
  `#78747f` cleared 4.5:1 on pure white by 0.06 and then failed on the page background and the
  table-header fill, which is where most of it actually sits.
- **Only the worker outlives a navigation** (3.7.6, hardened after the jump-back recording). A
  content script is destroyed by it, so the worker holds the standing instruction plus its run id,
  newest attempt and `running | interrupted | completed` lifecycle. Only an unfinished run may be
  reclaimed, only by its owning tab while it is running, and stale reports from a replaced closure
  are ignored. A completed run stays completed across reloads and returns. Both Stops still disarm
  it — a Stop a navigation could undo is not a Stop. The arrival is keyed on the job plus applicants
  view, never the applicant URL: opening a row changes the address bar and is how a run advances.
- **One rule decides what a resume file is** (fixed in 3.7.4). `findResumeDocumentUrl()` had its own
  local extension regex over four tag shapes, so a viewer using `data-source-url`, or a media host with
  no extension in the path, produced nothing — every applicant came back `link_only` with no file and
  no link. It now searches a list of attributes across viewer → panel → page and decides with
  `Applicants.isResumeDocumentUrl()`, which refuses a `linkedin.com` page address first, so the wider
  search still cannot return a route. **Widen the search, never the rule.** And wait for the document:
  the viewer mounts its shell before it fetches the file.
- **The hiring surface scrolls a column, not the page** (fixed in 3.7.3). The applicant panel and the
  applicant list each own a scroller; the page moves only its own nav and header.
  `Connections.chooseScrollTarget()` is tuned for the opposite arrangement — it scores
  `isScrollingElement` at **+60** and *penalises* depth — so the page won the moment it had any range,
  the column never moved, the first read was already the bottom, and the scan settled on one
  screenful: no Experience section, and a 665-applicant list that yielded a handful of rows.
  `Applicants.chooseColumnScrollTarget()` is the mirror image and is consulted first; the general
  chooser is only the fallback. **Never assume one scroll policy fits two surfaces.**
- **A held DOM reference is not the live panel** (fixed in 3.7.3). The hiring surface re-mounts the
  detail column as sections hydrate, and a detached node keeps answering `innerText` with what it held
  when it was unmounted — so a scan holding one reference re-read its first screenful forever and
  settled on it, which looks exactly like "it did not scroll". Re-resolve with `livePanel()` on every
  read. For the same reason, `clientHeight` must be read live wherever `scrollHeight` is.
- **A latched flag is not a state** (fixed in 3.7.3). `state.wentHidden` is set by `visibilitychange`
  the instant the recruiter switches tab — which is how they reach the extension's own pages — and was
  only cleared deep inside `extractApplicant`. So every later press of Collect Every Applicant threw
  "the page is hidden" before reading a row, and only reloading the page (a fresh content script, a
  fresh `state`) cleared it. **Re-derive a page-condition flag when work begins; never carry one
  across runs.** And a command aimed at another tab must activate that tab first — rule 12a is not
  only about the profile collector.
- **A run must know what it already has** (fixed in 3.7.3). The applicant loop walked from index 0 and
  asked nothing about the store, so a run stopped half way collected everybody again.
  `createCollectedIndex()` keys on the `applicationId` in the row's own href, because that is the only
  identifier a row carries **before** it is opened. `isCollectedApplicant()` deliberately requires one
  substantive field: a record with nothing but a name is a *failed* pass, and skipping it would make
  the failure permanent.
- **The applicant's name is chosen by policy, and page chrome is not a name** (fixed in 3.7.2). Live,
  every record came back named `Applicants`: the panel resolved to a container that also held the
  applicant list, and the first line of its text was taken as the name. `applicantPanel()` now refuses
  a candidate holding more than one applicant-row link; `findApplicantName()` ranks the list row, the
  profile link, the portrait alt, non-section headings and the first line *last*; and
  `nameFromExplanations()` arbitrates using the words LinkedIn's own verdict sentences share at the
  front. **Never take "the first line" as a name again.**
- **A row click is not a rendered panel** (fixed in 3.7.2). Waiting for `location.href` to change and
  the DOM to go quiet meant every applicant after the first was scanned on the previous one's panel —
  LinkedIn routes without navigating, and the DOM is quiet *between* unmount and mount. Wait on a
  `panelIdentity()` fingerprint change, and **skip** a row that never opened rather than scanning it.
- **A LinkedIn page is not a resume file** (fixed in 3.7.2). The resume control's href is a route, and
  the worker's host allowlist passed it because the host really is LinkedIn — so `chrome.downloads`
  saved the applicants HTML page as somebody's CV and the record said `downloaded`.
  `isResumeDocumentUrl()` refuses a `linkedin.com/hiring|talent|in|jobs|…` address **first**;
  `resume.url` is the document and `resume.viewerUrl` is the page, and they are never the same field.
- **`totalExperience` needs the right shape and the right separator** (fixed in 3.7.1).
  `calculateTotalExperience` reads `dateRange` and `title`, not `dates` — passing the wrong key made
  the column blank on every applicant. And `parseDateRange` refuses a hyphen glued between digits, so
  the applicant card's `2026-Present` needs `normalizeDateRange()` before the lookup. The stored value
  keeps LinkedIn's own wording.
- **No credential handling, ever.** `Sign in to LinkedIn` only navigates to
  `https://www.linkedin.com/login`. Login state is inferred by `classifyAuthState()` from URL, page
  text, and member-navigation markers; "unknown" is never upgraded to "signed in". No password input,
  `document.cookie` read, or `chrome.cookies` call may exist anywhere.
- `PV_IMPORT_START_COLLECTING` and `PV_IMPORT_DISCOVER_ALL` reply `{ started: true }` immediately and
  run detached, because the popup and importer page are allowed to close mid-run.
- Every rendered connection card is tallied, not just the ones that produced a URL: that is what
  explains "LinkedIn reports 67 but 66 profile URLs exist" (the 67th is a restricted or deleted
  member with no profile link).
- The build ID is duplicated in `content.js`, `connections.js`, `src/background.ts`,
  `src/react/popup.tsx`, and `scripts/build.mjs`. All five must change together.
- Popup, dashboard, and connections-import UI are React class-component applications written in
  TypeScript under `src/react/`.
- React and React DOM are vendored locally (16.0.0 / 16.0.1) because Manifest V3 extension pages
  cannot load remote scripts. **React 16.0.0 has no hooks** — class components only.
- `.tsx` files read `globalThis.React`; they never import `react` as a bare specifier.
- LinkedIn DOM work stays in the framework-free content scripts and `*-core.js` IIFEs.
  `src/extraction-core.js` and `src/connections-core.js` must remain export-free and must not touch
  the DOM at load, because Node tests import them directly.
- Profile records continue using IndexedDB database `profile-table-collector`. Schema is **v4**: v3
  added the `importQueue` and `importSession` stores, and v4 indexes `status` and `lastCollectedAt`
  and deletes the `currentCompany` and `location` indexes. Rows migrate lazily through
  `normalizeProfile`, and `repairStoredProfiles()` writes back the ones that changed.
- The service worker is `dist/src/background.js`, not `dist/background.js`, so its relative ESM
  imports resolve.
- Education stores one entry per institution, the name only, deduplicated, in visible order.
  Experience is still grouped one company block per company while it is read, because that keeps the
  accumulator's entity identity stable across a virtualized scan; since 3.6.0 it is not stored.
- Saving the same canonical LinkedIn URL replaces previously extracted fields while preserving `id`,
  `collectedAt`, `notes`, and `tags`.
- A successful popup save clears the review form and displays a success message.
- Missing fields remain empty and are never guessed. Current employment requires `Present`/`Current`.
- CSV remains UTF-8 and formula-safe. The column set was REPLACED again in 3.6.0: its first twelve
  columns are the Saved Profiles table, column for column
  (`name,email,mobile,cv_url,open_to_work,education,skills,profile_url,status,last_collected,notes,tags`),
  and `CSV_TABLE_COLUMNS` is exported so a test holds the two in step. `mobile` exports as text so a
  spreadsheet keeps a leading zero. An object never reaches a cell. `full_name`, `all_emails` and
  `all_phone_numbers` import as aliases. From 3.6.0 columns may be appended, never reordered.

## Connections import decisions

- Import is always user-started. Discovery reads only `/in/` links that are already rendered, then
  scrolls or pages to render more.
- Each discovery pass is bounded (25 scroll steps) but **resumable**, so the worker runs many passes
  instead of one long scan. The original scroll position is always restored, including on error.
- The queue is processed strictly one profile at a time in a single reusable tab.
- `src/import-queue-core.js` holds the pure state machine so queue, discovery, cooldown, and recovery
  behavior are testable without IndexedDB; `src/queue-db.js` is only persistence.
- Retries are bounded at 3 attempts per profile; exhausted items wait for an explicit Retry Failed.
- CAPTCHA, login, checkpoint, unusual activity, rate limit, restriction, unavailable profile, and 3
  consecutive navigation failures all pause the session immediately.
- Permissions are `activeTab, scripting, storage, downloads, alarms`. Only `alarms` was added, and
  only for the D2 heartbeat.

## Full connection coverage (3.2.0, implemented)

- Decisions D1, D2, D3 were approved on 2026-08-02 and implemented exactly as scoped.
- **D1** - the only clickable control is connections-list pagination, gated by `classifyControl()`.
  A forbidden label (Connect, Follow, Message, InMail, Contact info, Endorse, Remove connection,
  Withdraw, Invite, Report, Block, Send, Share, Accept, Ignore, Save) always beats the allowlist, and
  a control must be proven inside the list. `connections.js` has exactly one `.click()` site.
- **D2** - a `chrome.alarms` heartbeat (1 min) resumes interrupted runs and elapsed cooldowns only.
  A session paused by a challenge, the user, a navigation trip, or an error never auto-resumes.
  `alarms` was added for this and nothing else.
- **D3** - no unbounded mode. A user-set batch cap pauses into a cooldown that resumes automatically;
  pacing between profiles is randomized 4-9 s.
- Discovery is multi-pass and resumable from a persisted `cursorY`. Coverage is `confirmed` only when
  a *reliable* advertised total is reached; a rounded `500+` total can never confirm it. Otherwise a
  settled list (bottom reached, no pagination control, no new URLs for 2 passes) reports `estimated`.
- Failures are classified: permanent (unavailable/404/out of network) fails at once; transient backs
  off 15 s x 2^n up to 3 attempts.
- Profiles collected within `refreshMaxAgeDays` (default 30) are skipped without navigating unless
  Force refresh is set.
- Queue rows are written individually via `putItem()`; the whole queue is never rewritten per profile.
- **Lazy-load timing is the critical variable.** LinkedIn fetches the next slice of the connections
  list, and profile sections, over the network in 2-4 s. Short DOM-quiet waits made discovery treat a
  10-row page as the whole list and made profiles come back partial. Discovery now waits for real
  growth (profile-link count and document height), nudges the scroll sentinel, retries the bottom
  before concluding, and drives an inner scroller when the layout uses one. Never lower these waits.
- **Superseded:** the import page was once reduced to a single button, with a test capping it at
  three. That was reverted on user instruction — see the two entries below.
- **The connections page has two explicit steps.** `Find All Connections`
  (`PV_IMPORT_DISCOVER_ALL`) enumerates and saves the whole list and never extracts; `Start
  Extraction` (`PV_IMPORT_START`) runs over what was saved. They must stay separate buttons and
  separate commands — a test asserts the discover branch never calls `Queue.startSession`.
- The connections page must keep: those two buttons plus Stop, Retry Failed, View Saved Profiles
  Table, Download CSV, search, a status filter, an editable skip-if-collected-within-days setting,
  the discovered/selected/pending/processing/completed/failed counts, a progress bar, and a paginated
  table (25 or 50 rows; Previous/Next/page numbers; name, URL, status, last collected date, error per
  row). Tests enforce every one of these.
- `Start Collecting` (`PV_IMPORT_START_COLLECTING`) survives as the popup's one-click path and still
  auto-discovers as the queue drains. `Start Extraction` sets `autoDiscover: false`.
- **What actually caused "only 10 connections discovered":** `discoveryPass()` advanced from
  `window.scrollY`, which stays 0 on layouts where LinkedIn scrolls an inner container, so every step
  requested the same position. Secondary causes: the list root was assumed to be `<main>`, the strict
  visibility test could reject every card, and `runDiscovery()` enqueued `result.urls` instead of
  `result.entries` so names were lost. All four are fixed and covered.
- **What actually caused missing profile fields:** name, headline, and location were read from the top
  card *before* the lazy-scroll pass, while LinkedIn was still hydrating. The page is now walked in
  full first and the top card is re-read on every snapshot, keeping the best-scored value.
- **Discovery and scan policy must stay in the pure cores.** There is no jsdom in this repo, so
  anything that touches the DOM cannot be tested. `planDiscoveryStep()` and `nextScanStep()` are
  DOM-free and tested against simulated pages; the content scripts are thin adapters over them.
- Queue items now carry `name` so the list is human-readable.
- The popup carries the primary controls: `Start full extraction` (PV_IMPORT_RUN_ALL = discovery then
  processing) and `Continue extraction` (PV_IMPORT_RESUME). The separate Import page remains the
  detailed view. Users look in the popup first, so the main actions must live there.
- `unlimitedStorage` was deliberately NOT added - no quota problem has been demonstrated, and a test
  enforces that.
- Live DOM assumptions remain unverified: the exact-total selector, the pagination labels, and list
  containment. Only a signed-in browser run can confirm them.

## Verification status

- Baseline before the 3.2.0 changes: 67 tests passing.
- After the changes: type check, 103 tests, production build, and build validation all pass.
- `dist/` was inspected: 31 files, manifest byte-identical, worker imports resolve, classic content
  scripts contain no ESM statements, exactly one guarded click site, build ID consistent.
- The built extension has **not** been loaded in Chrome from this environment, and no live LinkedIn
  behavior has been observed or claimed.
