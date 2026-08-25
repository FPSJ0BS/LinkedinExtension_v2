# CLAUDE.md — Profile Vault React

**Profile Vault React** — a local-first Chrome **Manifest V3** extension that extracts only visibly
rendered LinkedIn data after a direct user action, reviews it in React, stores it in IndexedDB, and
exports formula-safe CSV. No backend, telemetry, AI API, or paid service.

Three surfaces, sharing the cores and nothing else:

| Surface | Script | What it does |
|---|---|---|
| Profile pages | [content.js](extension/content-scripts/content.js) | Extracts one member's profile |
| Connections | [connections.js](extension/content-scripts/connections.js) | Enumerates the account's connections, then collects them one at a time |
| Hiring / applicants | [applicants.js](extension/content-scripts/applicants.js) | Collects applicants on the recruiter's own job posts |

---

## ⚠ Before touching applicant speed

**Before changing applicant collection speed, scrolling, repeated-profile behaviour, resume timing,
applicant switching, or delays, read:**

[`docs/applicant-collector-speed-guide.md`](docs/applicant-collector-speed-guide.md)

**Before changing an applicant DOM selector, a field location, section detection, a contact or resume
layout, a scroll container, or anything to do with supporting more than one LinkedIn layout, read:**

[`docs/multiple-linkedin-dom-ui-support-guide.md`](docs/multiple-linkedin-dom-ui-support-guide.md)

Its one rule, which every rule below already implies: **add a fallback reader after the working one; never
replace working extraction logic to support another UI.** All UIs write into the same applicant record.

**Before changing anything about messaging an applicant — the Message control, the composer, templates
or their variables — read:**

[`docs/applicant-messaging-guide.md`](docs/applicant-messaging-guide.md)

Its one rule: **the extension types the message and the human presses Enter.** Nothing here may resolve,
find or press a Send control, and nothing here may act on more than the one applicant the user picked.

**Keep all existing applicant data collection working. Make only the smallest safe changes and do not
modify the Project Time Machine logging system.**

---

## Project Time Machine

Start every session with:

```bash
node project-time-machine/scripts/status.js
node project-time-machine/scripts/audit.js
```

| They report | Do this first |
|---|---|
| An active task | Finish or abort it. Never open a second. |
| A stale lock | `abort-task.js --execute` |
| Unlogged changes | Assign them to a task or discard them — never let the next task absorb them |
| Audit errors | Fix only safe metadata. Never fabricate a record, commit or tag to make it pass. |

**Wrap each feature in a task** — not every one-line edit, but anything touching extraction, storage,
clicks, or timing:

```bash
node project-time-machine/scripts/start-task.js "Clear name"
# ... changes ...
npm run check
node project-time-machine/scripts/complete-task.js --summary "What changed" --check "npm run check passed"
```

`start-task.js` refuses on a dirty tree. If work began first: `watch.js checkpoint`,
`git stash push -u`, start the task, `git stash pop`, check, complete. Close a task in the same turn.
`--check` only for checks actually run — never a live-LinkedIn claim.

**Never run:** `git commit`, `git add` + commit, `git reset --hard`, `git checkout -f`,
`git clean -fd`, `git stash drop`, `git rebase`, `git commit --amend`, `git push --force`,
`git tag -d/-f`, `git branch -D tm-backup/*`, or hand-edit `tasks/` or `rollbacks/`.
Reading (`status`, `diff`, `log`, `show`) is always fine. Commits and tags come only from
`complete-task.js`, `rollback.js`, `recover.js`.

**Rollback in plain language** — just do it, preview first (omit `--execute`):

| User says | Run |
|---|---|
| undo the last task | `rollback.js task last --execute` |
| reverse the contact-info task | `rollback.js task "contact info" --execute` |
| go back to TASK-0004 | `rollback.js to TASK-0004 --execute` |
| bring it all back | `recover.js --execute` |
| show saved tasks | `list-tasks.js` |

---

## Non-negotiable rules

**Data honesty**

1. **Never invent data.** A missing value stays empty. A wrong value is worse than a blank one.
2. **A phone number only from a `tel:` link or a labelled Phone/Mobile field; an address only from
   `mailto:` or a labelled Email field.** Not from running text, member ids, dates, counts, the
   Interests block, recommendations or posts. Two live defects came from relaxing this — a member id
   saved as a mobile, and a stranger's details from a Top Voices block.
   **The one exception:** inside a panel this extension opened itself (Contact info, or an
   applicant's contact disclosure), every address and number shown is taken — that element is that
   person's own card by construction.
3. A current role requires `Present`/`Current` in the visible date range.
4. **Never let a scan replace the accumulator.** Cards and sections are recycled out of the DOM as
   the page scrolls; every collector is merge-only, and a later read enriches rather than overwrites.

**Clicking**

5. **A control may be clicked only if it is on the allowlist below, opens something LinkedIn is
   already showing this user, and is proven inside the container it claims to belong to.**

   *Profile pages:* connections-list pagination · `Contact info` · `Show details` in the Open to work
   card · a section's own **`Show all N …`** expander — Skills, Experience, Education — proven inside
   that section, because it opens the same member's own full list, sends nothing and changes nothing.
   That control **navigates** (`/in/<slug>/details/<section>/`), so whatever uses it must capture the
   profile URL first, treat the details view as that member's page, and return to the profile
   afterwards; a details view that never loads leaves the section as the profile painted it, never
   half of one member's list under another's name.
   *Hiring pages:* contact disclosure · resume · a collapsed section's expander · the list's next-page
   control · a row of the applicant list · the resume viewer's own Download · **the applicant panel's
   overflow menu, opened only to reach the contact disclosure inside it.**

   That last one is the eighth click and the newest (3.9.1). On the captured layout the panel offers
   no Contact control at all — the address and the number are behind `More…` — so every applicant was
   saved with an empty email and an empty mobile. Opening a menu renders controls LinkedIn is already
   offering this recruiter: it sends nothing, changes nothing, and Escape undoes it. What makes it
   safe is not the opening but **what may be pressed next** — only an item the same classifier allows
   for the contact disclosure, so every ATS action sitting in that menu stays refused by the denylist.
   The menu is closed on every path out, including the failure paths, because a menu left open over
   the panel is the next applicant's problem.

   **On hiring pages a control that navigates is refused, even when its label reads like an
   expander.** "See full profile" sits inside the applicant panel and matched the expander rule until
   3.9.1; pressing it leaves the applicants page, and the panel, the resume card and the list pager
   only exist there. The profile-page exception above does not transfer — it works only because that
   flow captures the profile URL first and comes back, and this surface has no such return path.

   **Permanently forbidden everywhere:** Connect, Follow, Message, InMail, Endorse, Remove
   connection, Withdraw, Invite, Report, Block, Send, Share, Accept, Ignore, Save — and on hiring
   pages also **Shortlist, Move to, Reject, Archive, Hire, Offer, Interview, Schedule, Rate,
   Good fit / Maybe / Not a fit, Add note**, because those change the recruiter's own ATS.
   **The denylist always beats the allowlist**, including when only the `aria-label` matches.

6. Scope to the main content. Reject `aside`, `footer`, `nav`, `[role='complementary']`, messaging
   overlays and modals — except an overlay this extension opened itself. Lazy scrolling always
   restores the scroll position, on the failure path too.

**Resilience**

7. **Never depend on generated class names, child indexes, or array positions.** Class names may add
   scoring bonuses, never hard matches. Resolve by visible text and structure — that is what survives
   a LinkedIn redesign.
8. **Never assume the document scrolls.** LinkedIn pins `html`/`body` and scrolls a wrapper, so
   `scrollingElement` reads as already-at-the-bottom. Use the tested chooser, and read position,
   bottom and stepping from that one element.
9. **A hidden tab is never a finished one.** Chrome throttles background tabs and LinkedIn does not
   render them, so the DOM freezes and every "it stopped changing" signal reads as complete. Gate on
   `visibilityState`, report `hidden: true` with `atBottom: false`, and save nothing partial.
10. **Pause on** CAPTCHA, login, checkpoint, unusual activity, rate limit, restriction, unavailable
    profile, or repeated navigation failure — and require a manual Resume. Only worker interruption
    and an elapsed cooldown may resume automatically.

**Safety**

11. **The extension never handles a credential.** No password input, no `document.cookie`, no
    `chrome.cookies`. Sign-in only navigates to LinkedIn's own login page. Login state is inferred
    from the page, and "unknown" is never upgraded to "signed in".
12. **Stop is always available and always ends everything.** Rendered unconditionally, matched before
    every other message branch, honoured by all three content scripts inside their loops.
    **Stop ends work; it never discards what that work produced.**
13. **Two reused tabs, never one per profile.** [collector-tabs-core.js](src/collector-tabs-core.js)
    is the only place a tab is created, activated or closed. The hiring tab is a third tracked tab
    but is the recruiter's own page and is never closed by the collectors.
14. Host permissions stay LinkedIn-only: `linkedin.com`, `media.licdn.com`, `static.licdn.com` —
    LinkedIn's own CDN serves the recruiter's own resumes. Nothing else without amending this rule.
15. **Focus is taken only on a direct user command** — the sign-in page, an applicant command's tab,
    a connections command's tab. Heartbeat-driven work activates a tab but never steals focus.

**Storage**

16. The IndexedDB name `profile-table-collector` must never change — it preserves pre-3.0 data.
    Stores: `profiles`, `importQueue`, `importSession`, `applicants` (indexed by `job.id`), `jobs`.
17. **An applicant is a person *on a job*.** The same person applying twice is two records, and
    neither is a saved profile. Saves reconcile on job + applicationId, and merging never overwrites
    a filled field with a blank.
18. Saving an existing profile URL replaces extracted details but preserves `id`, `collectedAt`,
    `notes` and `tags`. Notes and tags are the user's and are never touched by an extraction.
19. CSV keeps its UTF-8 BOM, quoted cells and formula neutralization. Phone columns carry a leading
    apostrophe so a spreadsheet keeps them as text. **Append columns; never reorder.**

**Verification**

20. **Never mark a live LinkedIn issue fixed because local checks pass.** Fixtures ≠ live DOM.
    Loading `dist/` in Chrome is a user step, always.
21. Run `npm test` after every change. Add a failing fixture *before* changing selectors.
22. Document only checks you actually ran.

---

## Commands

| Command | Notes |
|---|---|
| `npm test` | Node built-in runner, no deps |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | ⚠ **deletes `dist/` first** — a failed build leaves no extension. Typecheck first. |
| `npm run validate` | Read-only `dist/` assertions |
| `npm run check` | typecheck → build → test → validate |
| `npm run package` | `check` → versioned installer in `releases/` |

Fresh clone: `npm install && npm run check`, then load `dist/` at `chrome://extensions`
(Developer mode → Load unpacked). After editing `src/**` or a content script: `npm run build`, reload
the extension, reload the LinkedIn tab.

---

## Layout

```
manifest.json   content.js   connections.js   applicants.js
popup.html  dashboard.html  import.html  applicants.html  + .css   theme.css (shared, loaded first)
src/
  extraction-core.js      Pure profile parsing — no DOM at load
  connections-core.js     Pure URLs, control policy, totals, challenges
  applicants-core.js      Pure applicant/job parsing + hiring click policy
  collector-tabs-core.js  Pure tab workflow over an injected chrome API
  import-queue-core.js    Pure queue/session/discovery state machine
  db.js  queue-db.js  applicant-db.js  csv.js  applicant-csv.js  profile-utils.js  messages.ts
  background.ts           Service worker — import orchestrator + applicant relay
  react/  popup.tsx  dashboard.tsx  import-dashboard.tsx  applicants-dashboard.tsx  types.ts
docs/     applicant-collector-speed-guide.md
tests/    *.test.js + fixtures/*.html (fixtures are browser-only, not run by npm test)
vendor/   React 16.0.0 + ReactDOM 16.0.1 — the actual runtime
dist/     Build output — the folder Chrome loads
```

---

## Things that will bite you

- **React is a global, not an import.** Every `.tsx` does `const React: any = (globalThis as any).React;`
  There is no bundler. Never write `import React from "react"`. To change versions, replace the files
  in [vendor/](extension/vendor/).
- **React 16.0.0 is old.** No hooks, no `createContext`/`forwardRef`, no `memo`/`lazy`/`Suspense`, no
  Fragments or `<>`, no `createRoot`. Use class components. TypeScript will *not* catch a hook —
  `React` is `any`.
- **`*-core.js` files are export-free IIFEs** assigning to `globalThis`. They must work as a classic
  content script, an ESM side-effect import, and a Node `await import()` in tests. **Never add
  `export`, and never touch `document`/`window` at their top level.**
- **The service worker lives at `dist/src/background.js`**, not the dist root, so its relative imports
  resolve.
- **The build ID must match in 5 places:** the three content scripts, [background.ts](src/background.ts),
  [popup.tsx](src/react/popup.tsx), and [build.mjs](scripts/build.mjs). A mismatched content script is
  refused and re-injected.
- **Async message handlers must `return true`.** Commands that start long work reply
  `{ started: true }` immediately and run detached — the popup is allowed to close mid-run.
- **`canonicalizeProfileUrl` truncates to `/in/<slug>`.** LinkedIn routes overlays into the address
  bar, so the profile URL is captured *before* any overlay is opened. Both copies of the function must
  stay identical.
- **The address bar is not identity.** LinkedIn routes *ahead of the render*, so it names the next
  applicant while the panel still shows the previous one. Decide arrival from the panel's own
  identifiers, and refuse the record outright if the panel is showing somebody else.
- **A section that is not found produces zeros, not warnings.** An empty `current_role` means no
  Experience card was ever read — not that the person has no job. Check `diagnostics.sectionScan`,
  which lists every heading seen and the key it resolved to. A heading with an empty key is a wording
  the patterns don't know yet.
- **There is no jsdom**, so DOM-resident logic cannot be unit-tested. Keep new policy in the pure
  cores, where it can be.

---

## Known issues

| Issue | Where |
|---|---|
| `npm run build` deletes `dist/` before compiling | [build.mjs](scripts/build.mjs) |
| Manually added dashboard profiles collide on one ID | [dashboard.tsx](src/react/dashboard.tsx) |
| CSV import merges against a pre-loop snapshot; duplicate URLs in one file lose data | [dashboard.tsx](src/react/dashboard.tsx) |
| `findByProfileUrl` scans all records despite an index | [db.js](src/db.js) |
| Object URLs revoked on a fixed 15 s timer | [csv.js](src/csv.js) |
| Pagination labels and the connections-total selector are assumptions until checked live | [connections.js](extension/content-scripts/connections.js) |

---

## Where the detail went

This file is the working brief. The reasoning behind each rule — which live defect caused it, what was
tried first, why a given approach was rejected — is in [CHANGELOG.md](docs/CHANGELOG.md), one entry per
release, and it is unusually complete. **Read the relevant entry before changing behaviour a rule
names.** Tests carry the same reasoning in their names and comments; a failing test usually explains
itself.

Companion docs: [WORKFLOW.md](docs/WORKFLOW.md) · [AGENTS.md](AGENTS.md) · [TECH_STACK.md](docs/TECH_STACK.md) ·
[CHECKS.md](docs/CHECKS.md) (real results only) · [PHASES.md](docs/PHASES.md) ·
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md) · [SETUP.md](docs/SETUP.md) (from a clone) ·
[INSTALL.md](docs/INSTALL.md) (from the installer) · [MEMORY.md](docs/MEMORY.md) ·
[SKILLS.md](docs/SKILLS.md) · [applicant-messaging-guide.md](docs/applicant-messaging-guide.md) ·
[README.md](README.md).

[COMPLETE_EXTRACTION_SPEC.md](docs/COMPLETE_EXTRACTION_SPEC.md) is a **proposal**, not current behaviour —
it describes reading from the data the page already holds rather than only what it painted. Every rule
above stays in force until such an amendment lands in its own task.
