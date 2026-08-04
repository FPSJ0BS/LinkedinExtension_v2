# COMPLETE_EXTRACTION_SPEC.md — collect the record the page holds, not only the part it painted

**Status: proposal. Not binding.** [CLAUDE.md](CLAUDE.md) is still the binding
rulebook, including the sentence that says this extension extracts *only visibly
rendered* data. Nothing in this document is in force until the rules it names in
"Rules that must be amended" are actually amended, each in its own task. This
file exists so the target can be argued with before any code moves.

**Written against:** 3.7.8, build `2026-08-03-react-v3.7.8`, 411 tests passing,
phase 30 (live verification) still open.

---

## 1. The one-line version

The extension currently reads **pixels**. We want it to read the **record**.

Everything LinkedIn has already delivered into the recruiter's own tab — the
hydration payload it parsed, the API response it fetched, the DOM node it built
and then collapsed, the list row it virtualized away — is data the account
already has. None of it should be lost merely because it was not painted at the
moment we happened to look.

The restriction being lifted is **on the source, not on the standard**. Accuracy
does not relax. See §6.

---

## 2. Why — the evidence, not the intuition

**`current_role`, `current_company` and `education` have been empty on every row
of a live run for four consecutive releases**, and the live screen at 3.7.8 still
shows `CURRENT ROLE`, `CURRENT COMPANY` and `RESUME FILE` empty with three
applicants saved.

Each release found a real, different cause, and every one of them was in the same
layer — how a *rendered* section is found and revealed:

| Release | Cause found | Layer |
|---|---|---|
| 3.7.3 | The scroll target was the page, not the column; the column never moved | reveal |
| 3.7.4 | `applicantPanel()` resolved to a sub-container; the section was outside it | find |
| 3.7.6 | `^experiences?$` did not match `Experience (5)`; a root bounded by the next heading only; blocks that parsed to nothing never reached the text fallback | find |
| 3.7.8 | `sectionRootFor` returned a root holding only the heading, and `collectSections` then refused to let a better pass replace it; the preview is a nested scroller nothing scrolled | find + reveal |

That is not four bad parsers. It is one architecture. Today a value must survive
**five** separate hazards before it is stored:

1. its section must be *found* (heading wording, root bounding, panel resolution),
2. it must be *revealed* (the right scroller, enough passes, the right ancestor),
3. it must be *expanded* (an expander found, allowed, clicked, within budget),
4. it must be *visible* (`isVisible`, [applicants.js:220](applicants.js#L220) — 25 read sites gate on it),
5. it must be read as `innerText`, which returns nothing for a `display:none` subtree.

Five chances to lose a value the page already had in hand. The parser is the one
part that was never wrong.

### What the visibility fight costs today

Machinery that exists **solely** to make something visible enough to read —
none of it is parsing:

- `isVisible()` and `isExcludedContext()`; 25 gated read sites in
  [applicants.js](applicants.js) alone.
- `revealPanelContent()` with `REVEAL_MAX_PASSES` (40) and `REVEAL_QUIET_PASSES` (3).
- `chooseColumnScrollTarget()`, `chooseScrollTarget()`, `scrollCandidates()`,
  `maxScrollPosition()`, `viewportOf()`, `livePanel()`, plus the scroll-position
  restore on every path including failure.
- The expander pass, run **twice** inside one `MAX_EXPANSIONS` (8) budget.
- The settle policy: `signature()`, quiet counts, `PROFILE_SCAN.QUIET_PASSES` (5).
- Rule 12a in full — `document.visibilityState` gating, `visibilitychange`,
  `paused_visibility`, `wentHidden`, `prepareCollectorStep()`, and the auto-run
  restart machinery that exists because a navigation destroys all of it.
- Five of the six clicks in rule 9d–9h exist to make something visible.

Every one of those is a correct fix for a real defect. The point is that they are
all answers to the same question — *how do we get LinkedIn to paint this?* — and
that question is optional.

---

## 3. What we want to build

### 3.1 A source hierarchy, most authoritative first

A field is filled from the highest-ranked source that yields a value with
acceptable provenance. Lower sources still run, and **corroborate** rather than
overwrite (the accumulator is merge-only, unchanged).

| Rank | Source | Layout-dependent? | Needs scroll? | Needs a click? |
|---|---|---|---|---|
| 1 | **Structured payload** the page already holds (embedded hydration JSON, `application/ld+json`, `<code>` payload blocks) | no | no | no |
| 2 | **Responses the page itself fetched**, observed in-tab | no | no | no |
| 3 | **Full DOM text** — `textContent` of the section root regardless of `display`, `opacity`, `aria-hidden`, offscreen position or zero size | partly | no | no |
| 4 | **Rendered text** — today's `innerText` + `isVisible` path | yes | yes | yes |

Today we have only rank 4, plus one narrow use of rank 2
(`fetchedResumeDocumentUrl()` reading `performance.getEntriesByType("resource")`,
which observes *that* a request happened, never its body).

**Nothing in the codebase parses an embedded payload today.** A grep for
`application/ld+json`, `JSON.parse` of a page node, or a hydration global across
[content.js](content.js), [connections.js](connections.js),
[applicants.js](applicants.js) and [src/](src/) returns nothing in the extraction
path. Rank 1 is not a refinement of what exists; it does not exist.

### 3.2 The layers, in the order they should ship

Each is independently useful, independently reversible, and independently a
task.

**L0 — lift the visibility gate on *reading*, keep it on *clicking*.**
`isVisible()` splits into two predicates: `isReadable()` (the node exists in this
applicant's subtree and carries text) and `isClickable()` (unchanged — a control
we are about to press must genuinely be on screen, or the click is a lie).
Cheapest change, and it alone recovers a section that is present but scrolled out
or `opacity:0` mid-transition.

**L1 — read the collapsed DOM.**
Section roots are read with `textContent` and structural walking rather than
`innerText`. A collapsed accordion, a `hidden` panel, a `display:none` tab body
and an off-screen virtualized card all become readable **without a click and
without a scroll**. Directly retires the need for the expander pass and shrinks
the reveal walk to a corroboration pass.

**L2 — read the page's own structured payload.**
The applicant, the job, the qualifications, the screening responses and the
resume descriptor as LinkedIn's own data, keyed by its own entity ids. This is
the layer that makes `current_role` a lookup instead of an archaeology dig, and
it is immune to every heading-wording and root-bounding defect in the table in
§2 — those failure modes stop existing rather than getting one more fix.

**L3 — read the responses the page fetched.**
The list, the pages of the list, and per-applicant detail as the tab received
them. Bounded exactly as `fetchedResumeDocumentUrl()` is bounded (see §7).

**L4 — stop walking the list.**
With L2/L3, list completeness comes from the payload's own total and cursor
rather than from scroll growth plus a pager. Rule 9h's pagination click, the
three fruitless-pagination bounds and "the bottom of page one looks like the end
of the list" all become moot.

### 3.3 What this buys, concretely

- The ten columns in `APPLICANT_TABLE_COLUMNS` — `applicant_name, email, mobile,
  resume_link, resume_file, current_role, current_company, total_experience,
  qualifications, education` — fill from a source that cannot be empty because
  something did not scroll.
- A run stops being a physical process. No 40-pass reveal, no 8-click expansion
  budget, no settle wait per applicant. A 600-applicant job stops taking as long
  as 600 page renders.
- **Rule 12a's premise weakens**: a hidden tab still cannot be *walked*, but a
  payload read does not care whether Chrome is painting. That removes the single
  most fragile part of the run — the pause/resume/auto-run/re-arm machinery that
  3.7.3, 3.7.6 and 3.7.7 all had to fix.
- The click budget **shrinks**. If L2 lands, 9e (resume), 9f (disclosure) and 9h
  (pagination) become fallbacks rather than the primary path.
- Diagnosis changes character. A failure becomes "the payload shape changed
  here", which is one line in a log, instead of "no experience card was ever
  read", which took four releases to attribute.

---

## 4. What this does **not** change — the safety floor

None of the following is on the table, and this document is not a lever for
reopening any of them:

- **Rule 6 — accuracy over polish, never invent data.** Strengthened, not
  relaxed. See §6.
- **Contact provenance** (a phone only from `tel:`, a labelled field, or a panel
  the extension opened itself; an address only from `mailto:` or a labelled Email
  field). Every new source in §3.1 needs its **own** provenance verdict before a
  value is accepted from it. A payload field named `phoneNumber` on the applicant
  entity is provenance; a digit string found anywhere in a payload blob is not.
- **The outreach denylist, permanently.** Connect, Follow, Message, InMail,
  Endorse, Invite, Report, Block, Send, Share, Accept, Ignore, Save — and on the
  hiring surface Shortlist, Move to, Reject, Archive, Hire, Offer, Interview,
  Schedule, Rate, Good fit / Maybe / Not a fit, Add note. The denylist beats every
  allowlist. **No new source may be used to *write* anything anywhere.**
- **Only the account's own data.** The recruiter's own hiring pages, the
  account's own connections, the profile the user opened. Reading a payload must
  not become a way to reach a member the account's own screen would not show.
  This is the line, and §7 is about defending it.
- **LinkedIn-only host permissions**, minimal permissions, no `unlimitedStorage`.
- **No backend, no telemetry, no AI API, no paid service.** Local-first,
  IndexedDB `profile-table-collector`, unchanged.
- **No credential handling** (rule 12b). No password input, no `document.cookie`,
  no `chrome.cookies`. Login state stays inferred by `classifyAuthState()`.
- **The universal Stop** (rule 13a) — always available, ends everything in
  flight, discards nothing already collected.
- **Every run still starts from a direct user action**, including the 3.7.6
  auto-run, which is a *replay of the recruiter's own instruction* and expires.
- **Rule 17** — local checks never prove live correctness. More important here,
  not less: fixtures cannot contain a real payload.

---

## 5. Rules that must be amended, by name

Each is its own task. None is assumed by this document.

| Rule | Change |
|---|---|
| Preamble, "extracts *only visibly rendered* LinkedIn profile data after a direct user action" | Becomes "extracts the data the recruiter's own account has already delivered to the page, after a direct user action". The **direct user action** half does not move. |
| **6** (never invent) | Unchanged in intent; add the clarifying sentence in §6 so "hidden" is not confused with "invented". |
| **9** (every clickable control is named here) | The list **shrinks**. 9e, 9f and 9h become fallback paths, used only when the higher-ranked source yielded nothing. The per-file click-budget tests get lower numbers, not higher. Nothing is added. |
| **10** (scope to the main profile context; reject `aside`/`nav`/modal) | A payload has no `aside`. Scoping changes from *container containment* to **entity identity** — a value is this applicant's because it hangs off this applicant's id, which is a stronger test than "it was inside the box we picked". The DOM half of the rule stays exactly as written for the DOM path. |
| **11** (no generated class names / child indexes) | Extend to payload shape: a payload key is a **named field**, never a positional index into an array whose order is LinkedIn's business. |
| **12a** (a hidden collector page is never a finished one) | Narrows to: *a hidden page may not be **walked**, and a walk's completion signal is never valid while hidden.* A payload read is exempt, because it has no completion-by-quiescence semantics. The pause/resume machinery stays for the DOM path. |
| **16 / applicant CSV** | Only if §8's open decision 1 is answered "add fields". Otherwise untouched — **append columns; never reorder** still holds. |
| **17, 18, 19** (verification) | Unchanged. |
| [manifest.json](manifest.json) description, [README.md](README.md) | Reworded to match the amended preamble, in the same task as the preamble. |

---

## 6. "No restriction" means the source, not the standard

This is the part most likely to be misread later, so it is stated flatly:

- **A hidden node's text is not invented data.** Rule 6 forbids *manufacturing* a
  value. Reading a value the page built and chose not to paint is the opposite of
  manufacturing one. A collapsed Experience card is not a guess; it is the answer,
  behind a chevron.
- **Provenance gets stricter, not looser.** Every source in §3.1 arrives with its
  own verdict function, in the same shape as `isResumeDocumentUrl()` and
  `parseContactPanel({ trusted })`. A value with no verdict is not stored.
- **An absent value is still `null`** on the applicant record, never `""`, never a
  guess. `unknown` still means LinkedIn said it could not evaluate.
- **Every stored field records which rank it came from.** `extraction.rawData`
  already keeps the verbatim text each section was parsed from; it gains a
  per-field `source` (`payload` | `network` | `dom-hidden` | `dom-rendered`). A
  disagreement between two ranks is recorded, not silently resolved — that is how
  the next live defect gets attributed in one read instead of four releases.

---

## 7. The risks, and what each one is mitigated by

The four failure modes below are the reason this is a spec and not a patch.

**1. A payload fails silently and totally.** A DOM scrape degrades — it loses one
section. A payload whose shape changed loses *everything*, and looks like a
person with no data rather than an error. **Mitigation:** rank 1 is never the
only path. The DOM path stays, runs, and corroborates; a rank-1 read that yields
zero fields where the DOM yields some is a **logged warning**, on the same
principle as `logSectionScan()`'s empty-experience warning.

**2. Reading hidden DOM can pick up what the renderer would never show.** This is
the exact defect class that produced the two worst live bugs in this project's
history: the Interests block putting a stranger's address and phone number on a
record, and the panel resolving wide enough to hold the applicant list so every
record was saved as "Applicants". A hidden subtree can be a **template**, a
**placeholder**, a **prefetched other member**, or last applicant's card not yet
torn down. **Mitigation:** entity-scoped reads (rule 10 as amended), plus the
existing structural refusals — `FOREIGN_SECTION_PATTERN`, the refusal of a
container holding more than one applicant-row link, and the refusal of a root
that swallows a second section. None of those are relaxed. A hidden node that
cannot be tied to *this* entity id is not read.

**3. Network observation can straddle two people.** The entry buffer belongs to
the *document*, and a run walks hundreds of applicants through one document
without navigating. Unbounded, it saves applicant one's data under applicant
two's name — worse than no data at all (rule 6). **Mitigation:** the discipline
already written for `fetchedResumeDocumentUrl()` — a mandatory `since` floor
stamped **before** the step, and a function that **refuses to answer without
one** — becomes the general rule for rank 2, plus an entity-id match.

**4. Scope.** This stays inside "what the account already has, in the account's
own browser, with no credential and no backend". It must not drift into reading
members the account's own screens do not show, and no new host permission is
requested for any of it. If a layer cannot be built without leaving LinkedIn-only
host permissions or without a credential, **that layer is not built.**

---

## 8. Open decisions — these need an answer before L1

1. **Does "no restriction" mean the ten columns get filled, or that removed
   fields come back?** 3.5.0, 3.6.0, 3.7.1 and 3.7.7 each *deliberately* cut
   fields and columns (`headline`, `about`, `certifications`, `languages`,
   `experience`, `yearsOfExperience`, `websites`, `profileImageUrl`,
   `must_have_met`, `preferred_met`, …). This document assumes **fill the columns
   we have** and adds nothing. Widening the record is a separate decision and a
   separate task.
2. **Is rank 2 (reading fetched responses) in scope, or DOM + embedded payload
   only?** L2 alone may be enough. L3 is more powerful and has the tightest
   correctness constraint (§7.3).
3. **Should a hidden tab be allowed to collect** once payload reads exist, or does
   rule 12a stay whole for simplicity?
4. **Once L2 works, do the clicks get removed or kept as fallback?** Keeping them
   costs a maintained path; removing them costs the fallback that §7.1 depends on.
   Recommendation: **kept, demoted, and logged when used.**

---

## 9. How we would know it worked

Local checks cannot answer this — there is no jsdom in the repo and
`tests/fixtures/*.html` are not run by `npm test`. What is testable locally:

- The pure verdict functions per source, in `*-core.js`, against fixtures — same
  as `isResumeDocumentUrl()` and `classifyApplicantControl()` are today.
- The rank ordering and merge behaviour, against synthetic multi-source input.
- The click budget going **down**, asserted per file exactly as it is now.
- A test that a payload read cannot return a value for an entity id other than
  the one asked for.

What only a live recruiter account can answer, in order:

1. Does the page carry a structured payload for the applicant at all, and does
   `sectionScan` (extended with `source`) say so on a real job?
2. Do `current_role`, `current_company` and `education` fill on the row where four
   releases of DOM work left them empty?
3. Does `resume_file` become a file on disk rather than a preview?
4. Does the list report its own total, and does it match what the pager walk
   found?
5. Does anything come back attributed to the **wrong** applicant — the one failure
   that is worse than an empty column?

Question 5 is the acceptance gate. **No layer ships live-verified until it is
answered.** Rule 17 stands: passing checks here prove nothing about LinkedIn.

---

## 10. Sequencing

One task per layer, each independently reversible, in this order:

| Task | Scope | Ships when |
|---|---|---|
| Amend the preamble, rule 6's clarifying sentence, manifest and README | docs + manifest text only | first, so the code that follows is not in violation of its own rulebook |
| **L0** — split `isVisible()` into `isReadable()` / `isClickable()` | [applicants.js](applicants.js), then [content.js](content.js) | after the amendment |
| **L1** — `textContent`-based section reads; demote the expander pass | [applicants.js](applicants.js), `buildSectionMap()` | after L0 |
| **L2** — payload source + per-source provenance verdicts + `source` on every stored field | [src/applicants-core.js](src/applicants-core.js) (pure), adapter in [applicants.js](applicants.js) | after L1, and after open decision 1 |
| **L3** — fetched-response source, with the mandatory `since` floor and entity match | as L2 | only if open decision 2 says yes |
| **L4** — list completeness from the payload; retire the pager walk | [applicants.js](applicants.js), rule 9h | last, and only after L2/L3 are live-verified |

Each task runs `npm run check` and records the real result in
[CHECKS.md](CHECKS.md). No live claim without a live run (rule 17).

---

## 11. Companion documents

This is a target-state proposal. The binding documents remain
[CLAUDE.md](CLAUDE.md) (rules), [WORKFLOW.md](WORKFLOW.md) (method),
[CHECKS.md](CHECKS.md) (real results only), [PHASES.md](PHASES.md),
[PROJECT_STATUS.md](PROJECT_STATUS.md) and [CHANGELOG.md](CHANGELOG.md). When a
layer here is accepted, the amendment lands in CLAUDE.md **in its own task** and
this file records that it did.
