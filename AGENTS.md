# AGENTS.md

Project rules live in `CLAUDE.md`. Read it before planning or editing code.

## The Project Time Machine is always on

Before anything else, every session: `npm run tm:status` then `npm run tm:audit`.
Every change — including a one-word or docs-only change — is opened with
`npm run tm:start -- "Name"` **before the first edit** and closed with
`npm run tm:complete -- --summary "..." --check "..."` in the same turn. Never run
`git commit` yourself; `complete-task.js` owns commits, tags and records. The
binding version of these rules is the **READ FIRST** section at the top of
[CLAUDE.md](CLAUDE.md).

**Amended in 3.5.0, 3.6.0 and 3.7.0, and easy to get wrong from memory:**

- There are **three surfaces**, not two: profile pages (`extension/content-scripts/content.js`), the
  connections list (`extension/content-scripts/connections.js`), and — since 3.7.0 — the recruiter
  hiring pages (`extension/content-scripts/applicants.js`, matching
  `linkedin.com/hiring/*` and `/talent/*`). The applicant record is a **separate record in a separate
  store** and is never a saved profile.
- The run uses **two reused tabs of the user's own window**, not a separate collector window. Every
  tab decision lives in `src/collector-tabs-core.js`; the service worker must never call
  `chrome.tabs.create` or `chrome.windows.create`. The applicant collector opens **no tab at all** —
  it works on the job and applicant the recruiter already has open.
- **Clickable controls are named per surface in CLAUDE.md rule 9** — three on profile pages
  (connections pagination, `Contact info`, the Open to work card's own `Show details`) and four on the
  hiring surface (contact disclosure, resume, section expander, applicant row), every one gated by a
  classifier and **proven inside the container it claims to belong to**. Everything else on the
  denylist stays permanently forbidden, the denylist beats every allowlist, and the hiring denylist
  additionally covers Shortlist, Move to, Reject, Interview, Rate and the other ATS actions.
- **The universal Stop always exists.** `STOP_ALL` is matched before every other worker branch, and
  every content script checks its abort flag inside its walking loop rather than between items. A stop
  is an interruption — never a failed record and never a finished list — and it discards nothing.
- **A contact detail needs provenance — outside our own panel.** On the rendered page a phone number
  comes only from a `tel:` link or a labelled Phone/Mobile field, and an address only from a `mailto:`
  link or a labelled Email field. Never reintroduce a whole-page sweep — that is what saved a vanity
  URL's member id as a mobile number and a Top Voice's address from the Interests block. **Inside a
  panel this extension opened itself** on the person being collected, `trusted: true` takes every
  address and number it shows (3.7.1); the scrubbing still runs there, and the flag must never be
  widened past that one element.
- The record is now exactly the table: name, email, mobile, CV, open-to-work, education institutions,
  skills, profile URL, status, last collected, notes, tags. `experience`, `yearsOfExperience`,
  `currentRole`, `currentCompany`, `currentEmploymentDates`, `totalExperience`, `websites` and
  `profileImageUrl` are **gone** (3.6.0), as are `headline`, `location`, `about`, `certifications`
  and `languages` (3.5.0). Do not reintroduce any of them.

## Main implementation agent
Owns the React/TypeScript architecture, integration, minimal permissions, documentation, build output,
and final verification. Integrates and verifies every other agent's work.

## React UI specialist
Maintains `src/react/`, reusable components, controlled forms, dashboard state, the connections import
dashboard, accessibility, and status messaging. Must not reintroduce root-level DOM-mutation UI
scripts, and must not use React hooks — the vendored runtime is React 16.0.0.

## DOM extraction specialist
Works only on evidence-backed LinkedIn extraction issues in `extension/content-scripts/content.js`
and `src/extraction-core.js`.
Creates a failing sanitized fixture before selector changes and prevents sidebar/accessibility
contamination. Does not place extraction logic inside React components.

## Connections import specialist
Owns `extension/content-scripts/connections.js`, `src/connections-core.js`,
`src/import-queue-core.js`, `src/queue-db.js`, and
the orchestration half of `src/background.ts`. Responsible for resumable multi-pass discovery, canonicalization
and deduplication, allowlisted pagination, one-at-a-time processing in a single reusable tab,
pause/resume/stop semantics, batch caps and cooldowns, bounded retries with backoff, and challenge
detection. Must never click a non-allowlisted control, run profiles in parallel, retry without bound,
or attempt to work around a challenge or restriction.

## Applicant collector specialist
Owns `extension/content-scripts/applicants.js`, `src/applicants-core.js`, `src/applicant-db.js`,
`src/applicant-csv.js`, the applicants page, and the applicant half of `src/background.ts`.
Responsible for the hiring URL
context, the four gated controls, the qualification and screening verdicts recorded exactly as the
platform displayed them, resume handling and its duplicate guard, and the merge-only accumulator.
Must never invent a value where the panel showed none, never click an ATS action (Shortlist, Move to,
Reject, Interview, Rate, Message), never open or navigate a tab, and never mix an applicant into the
saved-profile store.

## Data and CSV specialist
Maintains schema normalization, institution deduplication, contact provenance and the cleanup of
records collected by an older version, IndexedDB migrations, replacement behavior that preserves
`id`/`collectedAt`/`notes`/`tags`, CSV round trips, Unicode, mobile-as-text, partial and full
exports, and formula-injection protection. The CSV's first twelve columns must stay identical to the
Saved Profiles table, in the same order, and the applicant CSV's first thirteen identical to the
applicants table. Both exports share one implementation of the escaping, the BOM and the formula
guard, in `src/csv.js` — never a second copy.

## Build specialist
Maintains TypeScript compilation, local React runtime assets, `dist/`, Manifest V3 CSP compatibility,
service-worker module resolution under `dist/src/`, and generated-file validation.

## Testing and QA specialist
Runs all checks, verifies React entry points and manifest assets, records only results that were
actually observed, and keeps live-browser checks separate from fixture and unit checks.

## Security and safety reviewer
Reviews permissions, local-only storage, imported content handling, diagnostics privacy, local script
loading, pacing, and prohibited automated actions. Blocks anything that resembles bulk scraping,
challenge circumvention, unattended collection, telemetry, or an external service.

## Coverage agent

Owns phases 21-30: connection inventory, resumable multi-pass discovery, the coverage ledger,
long-run durability, batch cap and cooldown, refresh policy, scale hardening, and failure backoff.
Decisions D1, D2 and D3 are approved and implemented; the agent may not widen them. Specifically:
the pagination allowlist may not grow to include any action control, the outreach denylist is
permanent, and no pause other than an interruption or an elapsed cooldown may auto-resume.

Agents must not duplicate implementations or edit unrelated files.

# Project Time Machine

This project uses the Project Time Machine. Before changing ANY file, read and follow:

- `project-time-machine/docs/AGENTS.md` — mandatory workflow rules
- `project-time-machine/docs/checks.md` — checks to run before completing a task
- `project-time-machine/docs/COMMANDS.md` — the commands to use

Start every session with:

```bash
node project-time-machine/scripts/status.js
node project-time-machine/scripts/audit.js
```

No file may be created, edited, renamed, moved or deleted outside an active task.
