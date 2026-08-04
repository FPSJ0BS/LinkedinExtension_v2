# TECH_STACK.md

| Technology | Version/target | Purpose |
|---|---:|---|
| React | 16.0.0, vendored locally | Popup, dashboard, import and applicants UI component architecture |
| React DOM | 16.0.1, vendored locally | Renders React components inside extension pages |
| TypeScript | 5.8.3 | Compiles `.tsx` entry points, the message contract, and the service worker |
| JavaScript | ES2020+ | Extraction core, connections core, queue core, content scripts, data and CSV modules |
| HTML/CSS | Browser native | React mount pages (`popup`, `dashboard`, `import`, `applicants`) and extension styling |
| Chrome Extension | Manifest V3 | Browser integration, permissions, popup, service worker, content scripts |
| IndexedDB | Browser native, DB version 5 | Persistent local profile storage plus the import queue, session, and discovery ledger (profile `schemaVersion` 5; v4 indexes `status` and `lastCollectedAt` and drops the `currentCompany`/`location` indexes; **v5 adds the `applicants` and `jobs` stores and deletes nothing**) |
| `chrome.storage.local` | Browser native | Build metadata and the remembered home window plus the two reusable collector tab ids |
| `chrome.scripting` | Manifest V3 | Bounded content-script injection and recovery |
| `chrome.tabs` | Manifest V3 (via host permissions) | The single reusable import tab and load-completion events |
| `chrome.downloads` | Manifest V3 | CSV, diagnostic and applicant-resume downloads |
| Node.js | v24.16.0 tested | Build scripts and automated tests |
| Node test runner | Built in | 373 unit, contract, and architecture tests |

## Build approach

A deterministic TypeScript-and-copy build script replaces any bundler or remote runtime dependency.
`npm run build` compiles to `.build/` and emits the loadable extension into `dist/`. React and React
DOM are packaged locally under `vendor/` so the extension satisfies Manifest V3 CSP.

The service worker is emitted at `dist/src/background.js` rather than the `dist/` root so its relative
ESM imports (`./messages.js`, `./import-queue-core.js`, `./queue-db.js`, `./db.js`,
`./profile-utils.js`) resolve at runtime.

## Permissions

### Currently declared

| Permission | Used for |
|---|---|
| `activeTab` | Popup acting on the tab the user is looking at |
| `scripting` | Bounded content-script injection and recovery |
| `storage` | Build metadata and the reusable import tab id |
| `downloads` | CSV and diagnostics export |
| `https://www.linkedin.com/*`, `https://linkedin.com/*` | The only hosts the extension may touch |

The connections importer added **no** new permission: tab creation, navigation, and load events rely
on the existing LinkedIn host permissions rather than the broad `tabs` permission.

### Added in 3.2.0

| Permission | Why | Status |
|---|---|---|
| `alarms` | The 1-minute heartbeat that resumes an interrupted run and starts the next batch after a cooldown (decision D2) | **Added.** A test asserts it is declared if and only if `chrome.alarms` is used. |

### Added in 3.3.0

**Nothing.** The permission list is unchanged: `activeTab`, `alarms`, `downloads`, `scripting`,
`storage`. The dedicated collector window uses `chrome.windows.create`, which requires no permission,
and reading the collector tab's URL is covered by the existing LinkedIn host permissions. `cookies`
was **not** added — login state is read from the rendered page, never from a cookie.

`unlimitedStorage` was **not** added: no storage-quota failure has been demonstrated. A test asserts
it stays absent. Re-evaluate only if a real quota error is observed with a multi-thousand queue.

No new host permission was needed. `tabs` remains unnecessary.

### Added in 3.7.0

**Nothing.** The recruiter applicant collector runs on `linkedin.com/hiring/*` and `/talent/*`, both
already inside the existing LinkedIn host permissions, and resume files are saved through the
`downloads` permission the CSV export already required. A test asserts the list is still exactly
`activeTab`, `alarms`, `downloads`, `scripting`, `storage`.

## Constraints

- Do not load React from a CDN in the extension.
- Do not use React hooks — the vendored React 16.0.0 predates them.
- Do not move LinkedIn DOM extraction or discovery into React components.
- Do not add ESM `import`/`export` to `src/extraction-core.js`, `src/connections-core.js` or
  `src/applicants-core.js`; they must stay classic-script-compatible IIFEs that publish onto
  `globalThis`.
- Do not change the IndexedDB database name.
- Do not add a backend, cloud database, analytics, scraping service, AI API, or paid service.
- Do not click any LinkedIn control that is not named in CLAUDE.md rule 9, per surface. The outreach
  denylist in `classifyControl()` and `classifyApplicantControl()` is **permanent** — Message,
  Connect, InMail, Send, Share, Shortlist, Move to, Reject, Interview, Rate and Add note act on
  somebody else's behalf, and no request loosens that.
- Do not widen `parseContactPanel({ trusted: true })` beyond a panel this extension opened itself on
  the person being collected. The rendered page keeps the 3.6.0 labelled-provenance rule.
- Do not take "the first line of a container" as anybody's name, and do not let a container holding
  the applicant list be treated as the detail panel. Both produced the 3.7.2 defect that saved every
  applicant as `Applicants`.
- Do not treat a `linkedin.com` page address as a downloadable document. The host is not the point —
  `isResumeDocumentUrl()` is, and `resume.url` and `resume.viewerUrl` stay separate fields.
- Do not accept a section root that carries only its own heading, and do not let a stored-but-useless
  section block a later pass. Both together are why `current_role`, `current_company` and `education`
  survived three releases of widening the section search.
- Do not reveal content with the rule that CHOOSES the scroll target. `scrollCandidates` refuses a
  descendant under `COLUMN_TEXT_SHARE`, which is right for picking one column to walk and wrong for
  deciding what to scroll; and `scrollIntoView` moves an element's ancestors, never a nested scroller
  it does not sit inside. Reveal every scrollable region; walk only one.
- Do not click a control that may open a tab. Open it yourself, through
  `collector-tabs-core.js` (rule 12), inactive, and close it in a `finally` — a tab the extension did
  not open is one it cannot close, and the run dies inside it.
- Do not treat a hidden page as the end of a run. Rule 12a says never READ a hidden page; waiting and
  abandoning are different decisions.
- Do not treat "the scroll container stopped growing" as "the list has ended" on a paginated list.
- Do not detect a single-page-app arrival by polling alone. A poller samples *states*, so a round trip
  between two ticks is invisible and a back/forward-cache restore is invisible in principle. Watch
  `popstate`, `hashchange` and `pageshow`/`persisted`, and use a `MutationObserver` for `pushState` —
  a content script's isolated world has its own `history`, so patching `pushState` there never sees
  the page's own call. This is what made the 3.7.6 restart work only after a manual reload.
- Do not consume a trigger before the work it triggers has succeeded. Record it, fulfil it in a
  separate repeatable step, and split the failures into transient (retry, bounded) and terminal
  (clear, and state the reason).
- Do not read `performance.getEntriesByType("resource")` without a timestamp floor taken before the
  action. The buffer belongs to the document and a run walks hundreds of applicants through one, so an
  unbounded read returns the previous applicant's file.
- Do not answer `downloaded` on a `chrome.downloads` id alone. The id means accepted, not written; read
  the outcome back, because `mergeApplicantRecord` protects a resume already marked downloaded and a
  wrong answer becomes permanent.
- Do not put page-specific styling in `theme.css`, and do not redefine its tokens in a page
  stylesheet. `theme.css` is the one visual layer, loaded first by all four pages; four private
  palettes is the state 3.7.7 replaced. `tests/visual-layer.test.js` holds both halves.
- Do not use one scroll policy for two surfaces. `Connections.chooseScrollTarget()` prefers the page
  and penalises depth because that is right for the connections list; the hiring surface is the
  opposite and uses `Applicants.chooseColumnScrollTarget()`, which refuses the page and takes the
  innermost container carrying the content. That mismatch produced the 3.7.3 defect where every
  applicant was read from one screenful.
- Do not hold a DOM reference across a scan on a surface that re-mounts, and do not read `scrollHeight`
  live against a remembered `clientHeight`. Both make a walk settle before it has moved.
- Do not carry a page-condition flag across runs. `state.wentHidden` latched by `visibilitychange` and
  cleared only mid-extraction is what made a stopped applicant run unstartable without a reload.
- Do not rely on a position-based walk alone on a surface whose markup we do not control. Naming the
  scrolling container is a guess and failing it is silent, so `revealPanelContent()`'s
  `scrollIntoView` pass stays behind it. Removing it brings back "it only saved what was on screen".
- Do not scope a section search to `applicantPanel()` alone. It can resolve to a sub-container of the
  detail column, which is what emptied `current_role` and `current_company` on every row. The
  page-wide fallback stays — and so do its two refusals: never the applicant list, never a root that
  swallows a second section.
- Do not give `findResumeDocumentUrl()` its own idea of what a file is. `isResumeDocumentUrl()` is the
  one rule, and it refuses a `linkedin.com` page address first. Widen the search, never the rule.
- Do not match a section title on the bare word. `Experience (5)`, `Work experience` and `Experience:`
  are all the Experience section, and missing it empties `current_role`, `current_company` and
  `total_experience` on every row without a single warning — those three come from that section and
  nothing else. `sectionKeyFor()` strips the count and the colon; `SECTION_PATTERNS` carries the
  qualifiers.
- Do not bound a section's root by the *next* heading alone. The ancestor then reaches back over the
  section above it, which is precisely what the page-wide pass refuses, so the widened search finds
  nothing. Bound it by every other heading.
- Do not let a failed parse pass for a read. `if (added || blocks.length) return added` treated "the
  markup had list items" as "the section was read", so a section of chrome silenced the text on
  screen. Fall through on `added === 0`.
- Do not let a section search fail silently. `diagnostics.sectionScan` and `logSectionScan()` are the
  only reason an empty column is answerable without a live debugging session, and rule 17 says the
  fixtures cannot answer it. Removing them puts the next empty column back to guessing.
- Do not let the applicants table carry more than the two resume columns. `resume_link` is where to
  click and `resume_file` is which file we have; the status, the viewer address and the saved path
  stay on the **record** and in the details drawer, because `downloadStatus` is what stops a file
  being downloaded twice.
- Do not restart an applicant run on a job the recruiter did not ask for, and never key the restart on
  the URL. Only `COLLECT_ALL` arms a job, an armed job expires, both Stops disarm — a Stop a
  navigation could undo is not a Stop — and the arrival is keyed on the **job**, because opening a row
  changes the address bar and is how a run advances.
- Do not take window focus from background work. Exactly two things may pass `focusWindow: true` to
  `Tabs.activate()`: the sign-in page and an applicant command, both of which are a button the user
  just pressed. Everything driven by the heartbeat activates the tab and leaves the window alone.
- Do not construct a LinkedIn address to navigate to. `rememberHiringUrl()` stores only a page the
  extension has genuinely been on; a hiring path assembled from a job id is the same class of guess as
  a guessed resume link, and is refused for the same reason.
- Do not auto-resume a session paused by a challenge, restriction, navigation trip, or the user.
- Any dependency or version change must update this file and `package.json` together.
