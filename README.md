# Profile Vault React

Profile Vault React is a local-first Chrome/Chromium Manifest V3 extension. Its popup, saved-profile
dashboard, connections-import dashboard and job-applicants page are built with React and TypeScript.
The content scripts stay framework-free because they run inside LinkedIn and handle only extraction,
discovery, and messaging.

## Included behavior

### Single profile

- User-initiated extraction from LinkedIn `/in/` pages
- Editable React review form before saving
- One entry per education institution — the institution name, deduplicated, in the order the profile
  shows them
- The member's own **Open to work** panel, when they are advertising one: job titles, locations,
  workplace types, employment types and availability
- Replacement save for an existing canonical LinkedIn profile URL
- Success message and cleared review form after saving
- IndexedDB persistence
- Local diagnostics export

### Connections import

- User-started, resumable multi-pass discovery of every connection the list will render
- Careful lazy scrolling that restores your scroll position, plus allowlisted "Load more" pagination
- Canonicalized, deduplicated, persistent IndexedDB queue
- Exactly one profile processed at a time in a single reusable tab — never a tab per profile
- **Start Full Collection** does the whole thing in one click: checks that you are signed in, opens
  your Connections page in this window, discovers every connection, then opens one profile collector
  tab and starts extracting by itself — the popup and import page can both be closed while it runs
- Collects exactly what the table shows: **name, email, mobile, CV/resume link, open-to-work details,
  education institutions, skills, profile URL, status and last collected**. An email or number
  LinkedIn keeps behind **Contact info** is fetched from there when the page did not already show
  one, and a number is only ever taken from a `tel:` link or a labelled Phone field — never from a
  profile URL, an id, a date, a count, or somebody else's card in the Interests block
- **Discover Connections Only** scans the whole list and saves it; **Start Profile Extraction** then
  collects it — two separate steps, so you can review what was found before anything is opened
- A count reconciliation that explains any difference between LinkedIn's advertised total and the
  profile URLs actually collected (restricted members, duplicate links, cards with no usable link)
- A paginated table of every connection (25 or 50 per page) with name, profile URL, status, last
  collected date and error, plus search and a status filter
- Extract all connections, just the ones you tick, the uncollected ones, the failed ones, or the ones
  not collected within your refresh window
- Progress bar; the live collection state, LinkedIn-reported total, discovered, missing/inaccessible,
  selected, pending, processing, completed, failed and skipped counts, the current profile, any
  unresolved count difference, and the final stop reason
- **Stop**, **Clear Queue**, **Saved Profiles**, **Download CSV**; **Retry Failed**,
  **Download Diagnostics** and **Recheck Login** live under **Advanced**
- Immediate pause on a CAPTCHA, login wall, checkpoint, unusual-activity warning, rate limit,
  restriction, unavailable profile, or repeated navigation failure
- Bounded retries with backoff, a batch cap, cooldowns, and automatic continuation between batches
- State survives popup closure, service-worker suspension, tab reload, and browser restart; an
  interrupted run continues by itself, while a challenge always waits for you
- Skips profiles collected recently, with a Force refresh override

### Job applicants (new in 3.7.0)

For a recruiter looking at the applicants on their **own** job posting
(`linkedin.com/hiring/…`). It reads only what that logged-in account already shows on screen. It opens
no tab, navigates nowhere, and never shortlists, moves, rejects, rates, messages or interviews anybody.

- **Collect This Applicant** reads the applicant currently open in your LinkedIn tab;
  **Collect Applicant List** works through the whole list, one at a time, and can be stopped at any
  point — each applicant is saved the moment it finishes. It opens each one, lets their panel load,
  scrolls it to the bottom, opens their contact details and saves their resume to disk under their
  own name
- **Collect Every Applicant was removed in 3.7.13.** It sent the same command and ran the same walk
  as Collect Applicant List, and once that walk began opening each applicant and saving their resume
  the two buttons did the same work under two names. Nothing else changed: one button, same run
- **A stopped run resumes.** Pressing Collect Applicant List again walks past everyone already saved
  for that job without reopening them, and picks up from the rest. Tick **Re-collect already saved**
  to go over the whole list again on purpose
- **Either button takes you to the page.** Your LinkedIn hiring tab is brought to the front — window
  and all — because Chrome stops rendering a background tab and a page that is not rendering cannot be
  read. If you have closed it, the last applicants page the extension actually worked on is reopened
  in the same window. It never guesses an address it has not been to, so the very first run still
  needs you to open the page once
- **The applicant panel is scrolled to the bottom before anything is saved**, and the applicant list
  is scrolled to the bottom before a run starts. Both are their own scrolling column on this page, and
  the sections below the fold — Experience, Education, the rest of the qualifications — only exist
  once the column has been walked. The panel is then walked a second time by pulling its bottom into
  view directly, which works whatever turns out to scroll it, so a layout this build does not
  recognise is still read to the end
- Collects the **job** (title, company, description, applicant count, must-have and preferred
  requirements, screening questions and their ideal answers) and the **applicant** (name, profile URL,
  headline, location, current role and company, total experience, full employment history, education,
  skills, application status, applied and contacted dates)
- Opens the applicant's own **contact disclosure on every applicant** and takes **both** the email and
  the mobile number from it, plus any website. Everything inside that panel is taken — it is that
  person's own contact card, so a heading Profile Vault does not recognise no longer costs you the
  number sitting next to the address
- **Opens the resume** rather than only linking it: the viewer is scrolled so every page renders, and
  the file name, file type and page count are read from the viewer itself. The file is saved to
  `profile-vault-resumes/` when your account is allowed it. It never downloads the same resume twice,
  and it never guesses a link the page did not show
- **The resume is two columns**: **Resume Link**, which opens the CV — the document address when the
  page rendered one and the LinkedIn viewer page when that is all there is — and **Resume File**,
  which is the saved copy's path on your disk, or the file name LinkedIn showed when nothing was
  saved. The download status, the viewer address and the saved path are all still on the record and
  all still in the details drawer; they were three more columns to read across for one question
- **Reads the applicant's Experience wherever LinkedIn put it**, and says so when it cannot. A section
  titled `Experience (5)`, `Work experience` or `Experience:`, one outside the detail panel, or one
  LinkedIn did not mark up as a heading at all is still found — and every collection logs one line to
  the hiring page's console listing every heading it saw and the section each one matched, so a
  wording it does not know yet is visible instead of silent
- Records each **qualification** exactly as LinkedIn displayed it: the requirement, whether it is
  must-have or preferred, the verdict (matched / not matched / **unknown**), the platform's own
  explanation, and whether that came from the profile, the resume or a screening answer. A requirement
  LinkedIn says it cannot evaluate is recorded as *unknown*, never as a miss
- Scrolls the **whole applicant list** before a run over it starts, so a job advertising 665 applicants
  is not collected ten rows deep and reported complete
- A **Job Applicants** page with search, job/status/resume filters, 25/50 pagination, a details drawer
  holding the full verdicts, and a CSV export whose first twelve columns are the table:
  `applicant_name, email, mobile, resume_link, resume_file, current_role, current_company,
  total_experience, qualifications, education` — followed by the application status, the collected-at
  timestamp,
  `all_emails`, `all_phone_numbers` and the full qualifications, screening answers, experience,
  education and skills, one value per line
- **Collects every page of the applicants list**, not only the first — when a page settles it asks
  for the next one, and stops when there is no pager or the pager stops revealing anyone
- **Saves the resume by opening it, downloading it and closing it again**, entirely in the background:
  the tab it opens never comes to the front, never has to be closed by hand, and the run continues
  through it. Through 3.7.7 a resume that opened in a tab ended the run outright
- **Coming back to a job you have collected starts the run again — with no reload.** Once you have
  pressed *Collect Applicant List* on a job, returning to that job's Applicants page restarts the run
  from the first row with the options you chose — it walks past everyone already saved unless you
  ticked *Re-collect already saved*. It notices you arriving by LinkedIn's own in-app navigation, by
  the browser Back button, and by opening the job again from another page; through 3.7.6 only a manual
  refresh worked. Pressing **Stop** ends that standing instruction until you ask for it again
- **Saves the resume as a file, named after the applicant** — not a preview left on screen. The
  document's address is looked for on the page before anything is clicked; only if the page has not
  rendered it is the viewer opened, and then it is read, closed and checked that it closed. A download
  the browser could not complete is reported as **failed**, never as saved, and is retried once using
  the hiring tab's own session. One line per applicant in that tab's console says where the address
  came from, whether the file landed, and why not
- Anything the page did not show is stored as `null` — never invented

### Universal Stop (new in 3.7.0)

The popup's **Stop Everything** button is always there, whatever the extension is doing. One press
ends the connections discovery, the profile queue and any applicant run, in every LinkedIn tab, within
one step. Nothing already collected is lost.

### Dashboard

- Search, filtering, sorting, pagination, manual editing, deletion, selection
- CSV import, full CSV export, and an imported-only partial CSV export

## Install

### On another device — the installer

`npm run package` writes `releases/profile-vault-react-<version>.zip`: the whole extension, with its
instructions beside it. Copy it across, unzip it, and follow the `INSTALL.md` inside —
`chrome://extensions` → **Developer mode** → **Load unpacked** → select the `extension` folder.

It is a `.zip` rather than a `setup.exe` because Chrome will not install an extension from a file;
dragging a `.crx` in has been blocked outside the Web Store for years, and it is the browser that
declines, not Windows. **Load unpacked** is the supported route, so the installer is the folder it
needs, packed for transport. The archive ships a `.sha256` beside it, and the packager reads its own
output back and compares it against `dist/` before writing it.

⚠ Keep the unzipped folder where you put it. Chrome loads the extension from that folder every time
it starts, and ties the saved data to that folder's path — so moving or deleting it later loses the
extension, or the vault. [INSTALL.md](docs/INSTALL.md) covers updating in place, moving your saved
profiles across, and what each thing that can go wrong means.

### From a clone

1. `npm install && npm run check`
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Remove or disable any older Profile Vault extension.
5. Click **Load unpacked**.
6. Select the project's `dist` folder.
7. Reload any LinkedIn tab that was already open.
8. Open the extension and confirm the build ID contains `react-v3.7.8`.

## Use

### One profile

1. Open a LinkedIn profile URL containing `/in/`.
2. Click **Extract Profile**.
3. Review the fields and company/institution cards.
4. Click **Save Profile**. An existing record for the same URL is replaced; your notes and tags are kept.

### All your connections

#### The one-click way

1. Open the extension and press **Start Full Collection** (in the popup, or on the Connections
   Collector page).
2. Profile Vault checks whether this browser is signed in to LinkedIn. If it is not, it opens
   LinkedIn's own sign-in page and stops — it never asks you for a password.
3. It opens (or reuses) **one Connections tab in this same window**, brings it to the front, scrolls
   the whole list, and saves every connection it finds.
4. When discovery finishes it opens **one profile collector tab**, also in this window, and starts
   extracting on its own — navigating that same single tab from profile to profile and scrolling each
   one to the bottom before saving it. It never opens a tab per profile.
5. You can close the popup and the Import page. **Leave the collector tab in front while it works** —
   Chrome does not render a tab you have switched away from, so collecting cannot continue there.
6. When every connection is done, both collector tabs close and the **Saved Profiles** table opens.
7. Press **Download CSV** when you are done.

**Collection pauses rather than guessing.** The moment you switch away from the collector tab (or
minimize the window), LinkedIn stops rendering the page — Profile Vault notices, pauses, keeps
everything already collected, and continues by itself as soon as you switch back. It never saves a
half-read profile and never reports a half-read list as complete.

**What is collected.** The name, every email address and phone number the profile genuinely publishes,
the CV/resume link if there is one, what the person says they are open to work for, the institutions
they studied at, and their skills.

If the profile page shows neither an email nor a number, Profile Vault opens that person's own
**Contact info** panel once, reads it, and closes it again. If they are advertising **Open to work**,
it opens that card's own **Show details**, reads the panel, and closes it. It clicks nothing else —
never Connect, Message, Follow, Endorse, or anything that would contact somebody.

**A contact detail has to say what it is.** A phone number is only taken from a `tel:` link or a
field labelled Phone or Mobile; an address only from a `mailto:` link or a field labelled Email.
A profile URL's trailing digits, a member id, a date, a duration, a follower count, and anything in
the **Interests** block — which shows *other* people, with their own addresses and numbers — are
never read as this person's contact details. Missing values stay empty; nothing is guessed or
invented.

**Cleaning up records collected by an older version.** Opening **Saved Profiles** migrates every
stored row to the current format and removes any mobile number that was really the digits at the end
of that profile's own URL. **Clean shared contacts** in the toolbar finds any address or number that
appears on three or more different people — which means it came from a block showing somebody else —
shows you the list, and removes them once you confirm.

#### The manual way

1. The session badge shows **LinkedIn connected**, **Login required**, or **LinkedIn verification
   required**. Press **Sign in to LinkedIn** if you need to, or **Recheck** to re-test.
2. Press **Discover Connections Only**. It scrolls the whole list, waits for LinkedIn to load more, uses
   only "Load more"-style controls, and saves everything it finds. Nothing is extracted at this stage.
3. Review the list. Search it, filter it by status, page through it, and tick any rows you want. Read
   the reconciliation panel if LinkedIn's total and the discovered count differ.
4. Choose what to extract — all connections, your ticked selection, the ones never collected, the
   failed ones, or the ones not collected within your refresh window — and set **Skip if collected
   within … days**.
5. Press **Start Profile Extraction**.
6. Watch the progress bar, counts and current profile. Press **Stop** whenever you like, **Retry
   Failed** to requeue errors, **Clear Queue** to stop and start over (your saved profiles are kept),
   and **View Saved Profiles Table** to see what has been stored.
7. If LinkedIn shows a check, it stops and says so. Solve it yourself in the collector tab, then
   start again. Profile Vault never bypasses a challenge.

Everything continues after you close the popup or the import tab — the work runs in the extension's
background service worker over state persisted in IndexedDB.

## Development

```bash
npm install
npm run check
```

`npm run check` runs typecheck, build, tests, and build validation. The build command creates `dist/`:

```bash
npm run build
```

Chrome must load `dist/`, not the repository root. Note that `npm run build` deletes `dist/` before
compiling, so run `npm run typecheck` first.

Project rules for contributors and coding agents are in [CLAUDE.md](CLAUDE.md).

## Structure

- `src/react/popup.tsx` — React popup application
- `src/react/dashboard.tsx` — React saved-profiles dashboard
- `src/react/import-dashboard.tsx` — React connections-import dashboard
- `src/react/applicants-dashboard.tsx` — React job-applicants table and details drawer
- `src/react/components/` — company/role and institution cards
- `src/background.ts` — TypeScript service worker, import orchestrator and applicant relay
- `src/extraction-core.js` + `extension/content-scripts/content.js` — profile extraction and content-script lifecycle
- `src/connections-core.js` + `extension/content-scripts/connections.js` — discovery, pagination policy, challenge detection
- `src/applicants-core.js` + `extension/content-scripts/applicants.js` — recruiter hiring pages: job, applicant, qualifications,
  screening answers, contact disclosure and resume
- `src/import-queue-core.js` + `src/queue-db.js` — import queue state machine and persistence
- `src/applicant-db.js` + `src/applicant-csv.js` — applicant storage and export
- `extension/pages/`, `extension/styles/`, `extension/icons/`, `extension/vendor/` — extension pages and static assets
- `docs/` — installation, workflow, status, verification and project-history documents

## Coverage and limits

Discovery runs **many resumable passes**, not one scan. Each pass resumes where the last stopped,
scrolls, and — when it reaches the bottom — clicks an allowlisted pagination control such as
"Load more" if one is present. It stops when LinkedIn's advertised total is reached, or when the list
is at the bottom with no pagination control and no new profiles across repeated passes.

The dashboard reports coverage as:

- **Confirmed** — LinkedIn showed an exact total and that many profiles were found.
- **Estimated** — the list settled, but LinkedIn gave no reliable total (for example "500+"), so full
  coverage cannot be proven.
- **In progress / unknown** — discovery has not finished or has not run.

Runs are deliberately paced: profiles are collected one at a time with a randomized 4–9 second gap, a
batch cap you set, and a cooldown between batches. If Chrome suspends the extension mid-run, it picks
up by itself; a CAPTCHA or restriction always stops and waits for you.

## Privacy and limits

The extension extracts only information visible in the current document after a direct user action.
The only control it ever clicks is connections-list pagination such as "Load more". Connect, Follow,
Message, InMail, Contact info, Endorse, and every other action control are permanently prohibited. It has no backend,
tracking, telemetry, AI API, or paid service, and it never sends your data anywhere. Everything is
stored locally in your browser.

The importer is deliberately slow and sequential. It is not a bulk scraper: it processes one profile
at a time with randomized pacing, respects a batch cap and cooldowns you configure, stops on any
LinkedIn challenge or restriction, and never tries to work around one.

## Live-layout limitation

LinkedIn changes its DOM and serves account-specific layouts. Automated tests and fixtures passing
does **not** prove live correctness. Verify on the affected LinkedIn account, and use **Diagnostics**
when a field is wrong.
