# CHANGELOG.md

## 3.9.8 — the run pressed the page it was already on, for five releases

TASK-0187. Found by a parallel trace of the whole click path, and confirmed by
execution before a line was changed.

`APPLICANT_PAGINATION_PATTERN` carried `page \d+` as one of its alternatives:

```js
/^(?:next(?: page| \d+| \d+ applicants?)?|show more|load more|…|page \d+)$/i
```

That is the **named** branch. It runs first, it is handed **no `currentPage`**,
and it therefore cannot tell the page being shown from the page after it.
`findApplicantPaginationControl` enumerates `list.parentElement` in **document
order** and returns the first control the classifier allows — so on a pager whose
buttons carry `aria-label="Page 1"` and `aria-label="Page 2"`, the first allowed
control is **the page already being shown**.

```
classifyApplicantControl({ text: "1", ariaLabel: "Page 1", purpose: PAGINATION })
  -> { allowed: true, reason: "pagination", page: null }
```

So the run clicked `1` while sitting on page 1. Nothing happened, because nothing
was supposed to happen. The named branch reports `page: null`, so
`notePageReached` bailed on `!Number.isInteger(page)` and could not even score the
press; `fruitless` climbed on every attempt; three attempts retired the pager as
`pagination-retired`, which is CONCLUSIVE; the job was marked COMPLETED at the
bottom of page one and `claimAutoRun` refuses to re-arm it.

**The numbered path was never reached on that layout.** Every fix from 3.9.3 to
3.9.7 — `aria-current` on the control, then on its two ancestors, the accessible
name, the ordinal walk, the group-depth bound, the plain-text page markers, the
anchoring of `pageNumberFrom` — lives *beyond* a branch that had already returned
the wrong button. That is why five releases of correct work on the numbered
reader changed nothing the recruiter could see, and it is a lesson worth keeping:
**when a fix that is provably right changes nothing, the thing to check is
whether the code it fixed is reached at all.**

The fix is one alternative removed. A numbered page is exactly what the numbered
branch exists for, where the caller supplies `currentPage` and a number is
accepted only when it is exactly `current + 1`. Nothing is lost — `Page 2` is
still pressed from page one — but it now goes through the proof that keeps
`Page 1` from being pressed from page one, and `Page 25` from being pressed from
page one along with it.

Also fixed, from the same trace: **a next-page control that is momentarily
disabled no longer finishes the job.** LinkedIn disables its pager while a fetch
is in flight, and the search fires immediately after the list goes quiet; the
group was skipped with no note, which `pagerSearchReason` read as
`no-next-number` — CONCLUSIVE. It is now `next-page-not-pressable`, which leaves
the run restartable, because there *is* a next page and it simply could not be
pressed that instant.

No new click — still exactly eight. Two existing tests updated where they pinned
the defect: one listed `Page 2` among the named controls, and one asserted the
accessible name alone was permission to press. Both now assert the opposite, and
a new test names the failure.

**No live claim: rule 20 stands.** `npm run check` passed — 644 tests.

## 3.9.7 — the readers contradicted each other, so none of them ran

TASK-0186. **"It is still not working. I want the extension to click 2, 3, or the
next page number if Next is not available."** — reported against 3.9.6, which is
the build that was loaded.

Four builds had now worked on this control. 3.9.3, 3.9.4 and 3.9.5 each answered
*which page is being shown* a different way; 3.9.6 fixed how the members of a
pager are **grouped**. Every one of them operates on controls that offered a page
number in the first place, and that is the step that was broken:

```js
if (/^\d{1,4}$/.test(text)) return Number(text);
const named = /^page\s+(\d{1,4})(?:\s+of\s+\d{1,4})?$/.exec(text);
```

Both readings are anchored `^…$`, so a page was recognised **only in a label that
was `2` or `page 2` and nothing else**. Executed against the names a real pager
gives its controls:

```
"Page 1, current page"       -> null
"Go to page 2"               -> null
"Page 2, go to page 2"       -> null
"Page 3 of 27, go to page 3" -> null
```

A control offering no page number is not a member of the pager. On such a layout
the group has **zero** members, it is dropped for having fewer than two, and the
search reports `no-pager` — which is CONCLUSIVE. The job is marked COMPLETED at
the bottom of page one, and `claimAutoRun` refuses to re-arm a completed job.

**The sharpest evidence that this was the defect is inside 3.9.5 itself.** That
release added `saysCurrentPage` to recognise exactly `"Page 1, current page"` —
the very string `pageNumberFrom` rejected. The two readers contradicted each
other, and because the number is read *first* and gates membership, the newer one
could never run. A test now asserts the invariant permanently: anything
`saysCurrentPage` accepts must also yield that page's number.

The word `page` is still what licenses reading a number that is not the whole
label, and the refusal that matters is unchanged — `25 of 665` is the range the
list is showing, rendered right beside the pager, and reading it as page 25 would
jump the run past 24 pages of applicants. The **first** occurrence is taken, so
`page 2 of 27` is page two. A number a control merely leads with is read only
when what follows it says the control is the page being shown, which keeps
`3 results per page` — a real control that sits beside a real pager — from being
read as page three.

**The NAMED reader — the one that looks for "Next" before any number is
considered — had the identical defect**, and a parallel audit of every anchored
label rule in the codebase is what surfaced it. `APPLICANT_PAGINATION_PATTERN` is
also `^…$`, so `"Go to next page"`, `"Next page of applicants"` and
`"Next, page 2 of 27"` were all refused. With *both* readers blind, a page with a
perfectly ordinary Next button reports `no-pager` and completes the job. The fix
is a phrase reader added after the anchored one, and it is deliberately **not**
the obvious un-anchoring of `next`: every alternative in it requires the word
`page`, which is what keeps `"Next applicant"` and `"Go to next applicant"`
refused — those move the *panel*, not the list, so pressing one would read as a
working pager while collecting nobody new. `"Next: Message"` and `"Next steps"`
stay refused for the same reason, and the denylist still runs first.

`saysCurrentPage` had the same class of defect at the same boundary and is fixed
with it: `textContent` of `<button>1<span class="visually-hidden">Current
page</span></button>` is `1Current page`, and there is **no word boundary between
a digit and a letter**, so `\bcurrent` could not match the one shape a pager most
often renders.

**And a failed search now reports what it was looking at.** `no-pager` says
"nothing here offers a page"; it could not say that a control reading
`Go to page 2` was sitting right there and was declined for not being called `2`.
A capped, read-only sample of the nearby controls — tag, text, `aria-label`, the
page number each rule read from it, `aria-current`, disabled — is recorded on the
failing path only. That is one line of a console report instead of a fifth round
of reading source.

No new click — still exactly eight. No selector, schema, CSV column or permission
is touched. Two new tests, one of them a permanent invariant.

**No live claim: rule 20 stands.** `npm run check` passed; loading `dist/` in
Chrome is the user's step.

## 3.9.6 — the pager was never read, because the group was never formed

TASK-0185. **"There are 2 pages but it stops at the first"**, reported a third
time with the same screenshot: a `1` in a filled circle and a plain `2` beside
it.

3.9.3 read `aria-current` off the numbered control. 3.9.4 widened that to the two
ancestors above it. 3.9.5 added a third reader that needs no mark at all — the
walk's own history, standing on the one fact no layout can take away, that
pressing the control labelled N leaves you on page N. **All three answer the same
question, "which page is being shown", and all three are downstream of a step
nobody had looked at: forming the GROUP.** A pager is identified as a group of
page numbers, and only inside a proven group is a number trusted; if the group
does not form, none of the three readers is ever reached.

That step had two positional assumptions in it, and either one drops the pager
silently and completely:

* **The members had to share an ancestor at exactly two levels** —
  `element.parentElement.parentElement`, which is `button` → `li` → `ul` and
  nothing else. One extra wrapper `div` puts every number in a group of its own.
  That is a child-index assumption of exactly the kind **rule 7** forbids, and it
  is now a bound rather than a depth: a number is registered under every ancestor
  up to `PAGER_GROUP_LEVELS`, and the groups are tried deepest first so the
  tightest container holding the whole pager still wins.
* **Every member had to be a CONTROL.** A pager has no reason to make the page
  you are already on pressable — there is nowhere to go — and plenty of them
  paint it as plain text. On that layout the group is `[2]`: one member, dropped.
  `pageMarkersWithin` adds the pages a container renders that are not controls,
  scoped to a container that already holds a numbered control and that holds no
  applicant row and no panel, so nothing goes hunting for bare numbers across the
  page. **A marker may prove the shape and may carry the current-page mark; it
  may never be pressed** — `pressable` is checked before the click, and a next
  page that is only a marker is recorded as a reader failure.

Either way the group was dropped for having fewer than two members and the search
reported `no-pager` — which is CONCLUSIVE. The job was marked COMPLETED at the
bottom of page one, and `claimAutoRun` refuses to re-arm a completed job, so the
run could not even restart itself. **A reader failure that finishes a job is the
one failure this surface cannot recover from**, so `pagerSearchReason` is now a
pure rule with the mapping executed in a test rather than spelled out inline in a
DOM walk, and it asserts a pager's fingerprint at BOTH ends: a page one, and some
page after it, seen anywhere the search looked and whether or not the two could
be grouped. A `1` and a `2` outside every applicant row is a second page of
applicants however the markup defeated this reader — that is `unproven-pager`,
and the run stops restartable and names it. A stray number on its own is not
enough, which is what keeps a genuinely single-page job completing normally.

`PAGER_SCOPE_LEVELS` goes from four to six; the climb still stops at `main`, so
it now says "up to the page's own main content" rather than guessing at how many
wrappers sit between the row list and the pager below it. What makes a wider
scope safe is not the distance — it is the shape proof, the exclusion of anything
inside a row or inside the mounted panel, and the click policy's own refusal of
any number that is not exactly `current + 1`.

**And the build finally names itself.** `BUILD_ID` had read `v3.9.3` since 3.9.3,
so the code of 3.9.4 and 3.9.5 announced itself in the recruiter's console as
3.9.3 as well. Two of the three rounds spent on this pager could not distinguish
"the fix does not work" from "the fix is not loaded", which is most of why there
were three. Bumped in all six places the check asserts.

No new click — still exactly eight. No selector, schema, CSV column or permission
is touched. Three new tests; three existing assertions updated where they pinned
the old shapes.

**No live claim: rule 20 stands.** `npm run check` passed; loading `dist/` in
Chrome is the user's step.

## 3.9.3 — the first release driven by a live diagnostics report

TASK-0173 to TASK-0176. 3.9.2 made the diagnostics report retrievable. This is
what the first one said, and **it contradicted the fix that had just shipped**.

The 3.9.1 note guessed that the overflow menu was being opened and the wrong
element read back. The report says otherwise, and says it in three fields:

```
"contact": { "reason": "no-contact-menu", "menuClicked": false, "menuLabel": "" }
```

Nothing was ever pressed. `findControl(panel, CONTACT_MENU)` found no opener at
all, so every applicant on that layout saved an empty email and an empty mobile
while the code written to fix it never ran. **Worth stating plainly: two rounds
of reasoning about markup produced a wrong diagnosis, and one download of a
report settled it.**

### The label was the defect (TASK-0173)

The proof is in the same report, in the applicant's own Experience card:

```html
<span class="a11y-text">Years employed from 2025 to Present</span>
<span aria-hidden="true">2025 – Present</span>
```

Every LinkedIn control is built that way, so the accessible text of an overflow
menu reads `More options More...`, and `APPLICANT_MENU_OPENER_PATTERN` is
anchored on the **whole** label. It matched none of the shapes a real page ships.

`APPLICANT_MENU_OPENER_WITHIN_PATTERN` matches within the label instead, and
every alternative requires **either the ellipsis glyph or the words
actions/options/menu** — written that way so it cannot collide with a section
expander, which is the one control that must never be mistaken for a menu.
Verified by running the real classifier: seven menu shapes now return
`contact-menu`, and `Show 2 more educations`, `Show all 12 skills`, `See more`,
`Show more`, `Show 5 more experiences`, `Expand` and `View all details` all still
return `expand-section`. Both branches consult one function, so the menu route
and the expander refusal can never disagree about what a control is.

### Three defects were waiting behind it

Each could empty the columns on its own once the opener *is* found, so all three
are fixed in the same task.

**`EMAIL_PATTERN` is `/gi`, and `.test()` on a global regex advances
`lastIndex`.** Four identical calls answer `true, false, true, false` — executed,
not reasoned about, and asserted that way. Two contact readers asked it directly,
so a menu that printed an applicant's details was recognised for one applicant
and refused for the next, with nothing in the diagnostics to say why. Both now go
through one helper that builds a fresh non-global copy — the idiom the core's
capture path already uses, which is evidence the hazard was known in one place
and missed in these two.

**The opener could be returned as its own menu.** It carries `aria-expanded`,
flips it to `true` when pressed, so it matches `[aria-expanded='true']` in
`CONTACT_SURFACE_SELECTOR`; it was not expanded before the press, so it passes
the freshness test; and it precedes its own dropdown in document order. It and
its ancestors are refused outright now, the opener's own surroundings are
searched **first** with the page-wide sweep kept last so nothing that worked can
stop working, and a candidate must be *useful* rather than merely present.

**"It appeared when we pressed" meant newly created, not newly revealed.**
`contactSurfaceCandidates()` returns hidden elements too, so a dropdown LinkedIn
had already mounted and merely hidden was in the pre-click sample from the start
and refused forever by the binding meant to protect it. The sample is visible-only
now. The leak that binding exists to stop is the previous applicant's disclosure
still *on screen*, which is visible by definition and so is still caught.

And `probePanelContactControls` records every control on the panel with what the
classifier makes of it — `inContainer: false`, exactly as
`probePanelDownloadControls` uses it, so nothing it finds can ever be pressed. It
distinguishes *the label never matched* from *the label matched but the control
is outside the panel*, which is the one question the failing report could not
answer.

### The expander never ran on a whole-job run (TASK-0174)

The plainest reading in the report: `diagnostics.expansions` was **absent**. That
object is written on the first line of `expandCollapsedSections`, unconditionally,
so its absence proves the function was never called — and the cost is two fields
further down, `education: 1` from a panel whose own captured markup holds two
entries, the second `<li class="… visually-hidden">` behind `Show 2 more
educations`.

One frozen literal did it: a list run passed `expand: false`, and because that
flag reaches both expansion passes through one shared budget, it switched off the
whole thing. The reasoning was sound — up to eight clicks per applicant on a walk
that is already the slow part — and the price was simply never measured against
what it cost. Experience is the sole source of `current_role`, `current_company`
and `total_experience`, the three columns [CHECKS.md](CHECKS.md) records as empty
for four consecutive releases.

It is bounded now rather than refused: `LIST_RUN_EXPANSIONS` (4) for a whole-job
run against `MAX_EXPANSIONS` (8) for a single collection. A recruiter collecting
one applicant will wait for everything; a run walking six hundred rows pays it six
hundred times. Still one budget per applicant, shared by both passes.

Two silent failures in the same function went with it. An exhausted budget said
nothing, so a panel whose expanders were never *reached* looked exactly like a
panel that had none. And the refusal counter saw only `verdict.forbidden` and
re-counted the same controls on every pass, so `navigates-away` and
`overflow-menu-not-a-disclosure` — the two verdicts 3.9.1 added — never appeared
at all. Skills also joined Experience and Education in the resolved-but-empty
markup dump.

### The resume would not open (TASK-0175)

`savedAs: "…\profile-vault-resumes\RAHUL Mishra (1)"`, with the warning *"resume
file type unknown; saved without an extension"*, on a record whose resume
otherwise downloaded fine. **The download succeeded and the result was unusable.**

The type was never unknown. `resolveResumeDocumentUrl` fetches the content-type,
tests it for the single word `json`, and throws it away — while the three sources
that feed `fileType` all require a literal dot-extension in visible text or in the
URL path, which a LinkedIn media id never has. The report shows the address:
`linkedin.com/ambry/?x-li-ambry-ep=…`, no extension anywhere in it.

**The trap, and it is why this is more than plumbing.** Passing the raw header
into `resumeFileExtension` would have written *wrong* extensions to disk: it
string-sliced `^[a-z]+/` off the type, which is right for `application/pdf` by
luck and wrong for everything else — `application/msword` became `.msword`,
`text/plain` became `.plain`, the docx type and `application/pdf; charset=binary`
both yielded nothing. The single test that ever covered it used the one input
that happens to work. So it is a **closed table** now, and a type it does not know
returns nothing: rule 1 applied to a name written on the recruiter's disk, because
a `.pdf` that is really a `.docx` is worse than no suffix. `application/octet-stream`
and every `text/html` variant are deliberately absent.

The header speaks **last**, after all three observed sources, because a name the
page actually painted is stronger evidence than a header.

### What did not change

The click budget is still **eight**, `trusted: true` still at one site, seventeen
applicant fields, nine CSV columns byte for byte, six resume verdicts, and host
permissions. Nothing here reads anything new off the page.

**Rule 20 stands.** The build ID changed, so `dist/` must be reloaded and the
LinkedIn tab reloaded with it.


## 3.9.2 — "Nothing to report yet", after collecting a whole job

TASK-0172. Reported live, on an account that had just collected applicants
successfully: **Download Diagnostics answered "Nothing to report yet. Collect an
applicant first, then try again."**

This is a reporting bug, not an extraction bug — no applicant was ever collected
wrongly because of it. It matters more than its size because the diagnostics
report is the instrument every remaining live question is meant to be answered
with, and it has been unusable on the one workflow a recruiter actually uses:
collecting a whole job.

### Three nulls, each on its own sufficient

Closing any two of them still leaves a broken button, which is why all three are
in one task.

**1. The page threw its own copy away.** `onRouteChanged` set
`state.lastDiagnostics = null` on every address change. The intent was right and
is kept — the previous applicant's report must never be read as this one's — but
deleting it was the wrong way to honour that, because **on this surface the
address bar carries the applicationId and moves on every single applicant
switch**. That is not a new discovery; it is the note already in CLAUDE.md that
says LinkedIn routes ahead of the render. So a four-hundred-row run wiped the
report four hundred times, and the last one went too, on whatever re-render
followed. It is **stamped** now instead of deleted: `supersededAt` says the page
has moved on, and the report has always carried `selected.name` and the
applicationId in `context`, so it names its own applicant and cannot be mistaken
for the one now on screen.

**2. The worker was never told.** A whole-job run is *detached* — started with a
fire-and-forget message and silent until it finishes — so the worker's cached
copy was written by `COLLECT_CURRENT` alone, and a list run left it untouched.
The streamed per-applicant save carries the report now. That is the one message
a detached run does send per applicant, so this costs no extra round trip and no
new message type. The diagnostics are a **sibling of the record on the message,
never a field inside it**: an applicant has eighteen keys and a report is not one
of them.

**3. The worker itself does not last.** `applicantDiagnostics` is module state in
an MV3 service worker, which Chrome tears down after about thirty seconds idle.
Collecting happens in the LinkedIn tab; the report is downloaded from the
extension's own Applicants page. **The walk between those two is routinely longer
than the worker's life.** There is a copy in `chrome.storage.session` now —
`session` rather than `local` deliberately, because the report carries the
applicant's name, address and number in `selected`, and a debugging artefact has
no business outliving the browser session on disk. A Chrome without session
storage still gets the in-memory copy; this can only ever add.

### Why the existing test passed while the button did not work

Phase 8's test asserts that the worker asks the page for what it read last. The
worker did ask the page. **The page had nothing left to answer with** — and the
test could not see that, because it reads the worker's source and the defect was
four thousand lines away in the content script's route watcher. The 3.9.2 tests
assert the absence of `state.lastDiagnostics = null` in that watcher by name, so
this cannot come back quietly.

### What did not change

No click was added — still eight, `trusted: true` still at one site. No CSV
column, no table column, no resume status, no host permission; `storage` was
already held for the worker's own state, and session storage is the same
permission. Nothing about extraction moved: this release reads nothing new off
the page and presses nothing at all.

**Rule 20 stands.** The build ID changed, so `dist/` must be reloaded and the
LinkedIn tab reloaded with it.


## 3.9.1 — the first live capture, and the three things it contradicted

TASK-0168 to TASK-0171. **This is the first release driven by screenshots of a real recruiter
account rather than by reasoning about markup**, and it is worth saying plainly what that changed:
3.9.0 spent twelve phases making the applicant readers survive a layout nobody had seen. The layout
arrived, and what it broke was not a reader. It was the **click policy** — three controls the
classifier had an opinion about and got wrong, all three visible in a single screenshot.

### The expander was wrong about three controls at once (TASK-0168)

`DISCLOSURE_CONTROL_PATTERN` decides what `expandCollapsedSections` may press, and that function
walks **every** button and anchor in the applicant panel and presses whatever the classifier allows.

| Control in the capture | Old verdict | Why that was wrong |
|---|---|---|
| `Show 5 more experiences` | **refused** | The pattern required more/all/details/full to follow the verb *immediately*, so a count in between refused it. LinkedIn writes the count whenever it has one. |
| `See full profile` | **allowed** | It matched `see\s+full`. Pressing it **leaves the applicants page** — and the panel, the resume card and the list pager only exist there. |
| `More...` | **allowed** | It matched the bare `more` alternative, so the walk opened the **ATS action menu** — Reject, Move to, Archive, Rate — and left it open over the panel it was about to read. |

The first is not a cosmetic miss. `current_role`, `current_company` and `total_experience` are
derived from the Experience section and from nothing else, and [CHECKS.md](CHECKS.md) records all
three as empty for four consecutive releases. Every counted expander on the page was being refused.

An optional count is now allowed between the verb and the noun. Navigation is refused by
`APPLICANT_NAVIGATION_CONTROL_PATTERN` — as a *navigation* control, not a forbidden one, because it
sends nothing and changes nothing and calling it forbidden would be a false statement on the record.
Overflow menus are refused by `APPLICANT_MENU_OPENER_PATTERN`, anchored on the whole label. Both
refusals run **before** the allowlist so each reports its own reason into `diagnostics.expansions`
instead of falling through to a generic "not a disclosure".

### The contact details were behind that same menu (TASK-0169)

The captured panel offers **no Contact control at all**. Its buttons are `Rate as`, `Message` and
`More...`, and the address and the number are behind the last of them — so `findControl(panel,
CONTACT)` returned nothing and every applicant on that layout saved an empty email and an empty
mobile. Silently: `no-contact-control` is a diagnostics field, not a warning.

**This is the eighth click, and CLAUDE.md rule 5 was amended in the same task** — the order the rule
itself requires. The fallback is *ordered*, which is the same safety argument every phase of 3.9.0
rested on: the panel's own Contact control is still looked for first, and the menu is opened only
where that found nothing, so a layout that already works cannot change.

Why opening it is safe is a different question from why it is needed. Opening a menu renders controls
LinkedIn is already offering this recruiter: it sends nothing, changes nothing, and Escape undoes it.
**What makes it safe is what may be pressed next** — only an item this same classifier allows for
`CONTACT`, so the denylist still refuses every ATS action sitting in that menu. Two shapes are
handled and the first costs no further click: a menu that *prints* the details is read where it
stands. `carriesContactDetails` is deliberately stricter than `findContactDisclosure`'s own test,
which accepts the word "contact" appearing anywhere — every action menu contains that word. The menu
is closed on all five exits, including the success path, where the disclosure's own Escape does not
reliably take its parent with it. `trusted: true` is still at exactly one site (rule 2).

### "Scanning resume for viruses", and a document fetched four times (TASK-0170)

Reported live: the first two applicants of a run downloaded their resumes and every one after them
did not, with LinkedIn's own notice — *"Scanning resume for viruses. Please refresh the page now."* —
where the resume card had been. By hand on the same account, the file opened normally.

**Nothing here establishes the cause, and this entry does not claim to** (rule 20). Two things were
provably wrong regardless.

**The state had no name.** Nothing in the tree contained that string. Worse, LinkedIn takes the whole
resume card away while scanning, control included, so `collectResume` reached its
`no-resume-control` branch and wrote `UNAVAILABLE` — a *wrong* value for somebody who does have a CV,
and rule 1 says a blank beats a wrong one. It is now recognised, waited out once for a bounded five
seconds at two checkpoints, and if it has not cleared, recorded as `NOT_ATTEMPTED` with a warning on
the record. `NOT_ATTEMPTED` rather than a new status because `mergeApplicantRecord` already reads it
as "I did not look" and keeps what was stored — asserted end to end through the merge, so a re-run
that hits the scan cannot destroy a file an earlier run saved. The wait presses nothing and reloads
nothing: every way of hurrying the scan is either a forbidden control or a page reload that would
tear down the list, the pager and the panel the walk is standing on.

**The document was going down the wire four times per applicant.**
`resolveResumeDocumentUrl` needed only the content-type and was doing a full credentialed `GET` of
the CV to learn it — reading the body on one branch and discarding it on every other. That is once
there, again through `chrome.downloads`, on top of the viewer's own fetch and the copy its Download
control pulls. A recruiter doing this by hand transfers it once or twice. It is a `HEAD` now, with
the old `GET` kept as the fallback for a CDN that refuses `HEAD` or answers without a type, and the
descriptor branch going back for the bytes it genuinely needs. **Removing a redundant credentialed
GET of somebody's CV is worth doing whether or not it turns out to be the cause.**

### Found while working, and fixed rather than left

Normalising `applicants.js` to the repo's canonical LF exposed a test that had been passing
**vacuously on every CRLF checkout**: a source slice ended on a marker containing a bare `\n`, which
never matched, so `indexOf` returned `-1`, `slice(start, -1)` ran to the end of the file, and its
assertions were matching some other part of the source entirely. It had been hiding a constant
renamed in 3.9.0. The marker is now newline-agnostic and the slice asserts its own length.

Also restored `docs/SETUP.md`, deleted from the working tree between releases.

### What did not change

Seventeen applicant fields, nine CSV columns byte for byte, six resume verdicts, the three throwing
identity checks in `extractApplicant`, `trusted: true` at one site, and host permissions.
The click budget went **seven to eight**, deliberately and visibly: all sixteen budget assertions
were raised, and the Phase 1 ownership tripwire — which exists precisely to catch a click that moves
house — gained `openContactMenu` as a **named eighth owner** rather than absorbing it.

**Rule 20 stands.** None of this has been run against a live LinkedIn page from this side. The build
ID changed, so `dist/` must be reloaded and the LinkedIn tab reloaded with it.

## 3.9.0 — the same person, whichever way the page is drawn

Twelve phases of [`multiple-linkedin-dom-ui-support-guide.md`](multiple-linkedin-dom-ui-support-guide.md),
one Time Machine task each, TASK-0153 to TASK-0165. The brief was to survive *slightly different*
LinkedIn applicant layouts — the same data rendered somewhere else — by **adding fallback readers,
never by replacing the ones that work**. Nothing in the applicant record, the CSV, the workflow or
the click budget changed, and that is asserted at the end rather than promised at the start:
**seventeen applicant fields, nine CSV columns byte for byte, seven clicks.**

**The safety argument is structural, and it is the reason this was possible at all.** The
accumulator is fill-empty-only — `addHeader` is first-wins per field, `addKeyed` fills blanks, and
`addName` has its one documented exception. So a fallback that runs *after* the reader it backs up
and writes *only* through the accumulator is incapable of regressing the working layout whether or
not its selectors are right. Every phase was built to satisfy those two conditions, because it is
the only such argument provable in a repository with no DOM in its test runner.

**Two holes in that argument, closed first.** `setResume` was a spread — the only accumulator method
where the last writer won, blanks included — and `collectResume` writes twice by design, so a second
write missing `filename` erased the first one's and `resume_file` was empty for a file sitting on
disk. And `buildApplicantRecord` had no route at all for `currentRole`, `currentCompany` or
`totalExperience`: `normalizeApplicantRecord` has always read them as `orNull(explicit) || derived`,
so the slot for a page that states them outright existed from the start and had no producer.

**The single most consequential change is that the section table can now be tested.** It lived in
the DOM adapter, and a heading wording it does not recognise makes a whole section invisible — all
three of those columns are derived from Experience and from nothing else, which is why they came
back empty on four consecutive releases. It is now pure, in the core, unit-tested wording by
wording, and `diagnostics.sectionScan.headings[].key === ""` already names every wording that failed
on every live run: acting on such a report is now a three-line test instead of a live-only gamble.

**What the guide asked for that could not be honestly delivered, and why.** Phase 5 is "add support
for the second UI". There is no captured sample of a second LinkedIn applicant layout in this
repository and no saved diagnostics naming one, so **zero layout-specific selectors were added**.
What shipped instead is what evidence we hold: shape rules where there were positional guesses
(`looksLikeApplicantHeadline` retires the last `lines[1]` in the core, the same way
`looksLikeApplicantLocation` retired `lines[2]`), refusals the guide states in prose made executable
(`isEmployerCandidate`, `isCurrentRoleCandidate`), heading aliases for wordings LinkedIn is
documented to render, and a reader for the three columns that had none. Phase 9 builds the capture
that makes a real second-UI reader possible; Phase 10 is the format it lands in.

**`linkedom` was declined**, though Phase 10 permits it. It has no layout, so `innerText` collapses
to `textContent` and every parser here consumes `toLines(element.innerText)`; no layout means no
`isVisible`, which gates every heading, control, block and candidate panel, so it would have to be
stubbed — and then the program under test is not the program that ships. A fixture is instead the
capture's DOM-free projection, replayed through the real parsers with no dependencies at all.

Also here: layout detection whose only possible output is a permutation of a fixed reader list,
proved inert by running all 720 orders and comparing the records byte for byte; a scroll chooser that
refuses a container holding the recruiter's list, with the list's own movement now measured at
runtime and warned about; section boundaries for a top card, a contact block, application details and
additional information, recognised for element-level narrowing and for the report but deliberately
never for the line-level cut; a contact finder that gained four surfaces and got **stricter** while
doing it; a resume that cannot be written under an applicant the panel has stopped showing; and the
Applicants page finally sending `PV_APPLICANT_DIAGNOSTICS`, which the worker had answered since 3.6
and nothing had ever asked for.

## 3.8.0 — the block nobody told the map about, and the record that threw away what it had read

Two faults, one cause between them, and one deliberate change of scope.

**1. A followed company was saved as a connection's name.** The table showed a person called *Aakash
Educational Services Limited*, with an institution ("Kota Rtu") and a skill ("Quality Control") to
match. Nothing about those came off that member's own card. They came off the tiles inside
**Interests**, the block that renders other entities.

The name scorer had no shape test that could catch it: letters only, four words, no digits, near the
top of a card — the same answers a real name gives. So the fix is not another shape test. It is the
one identifier on the page that no re-render, no redesign and no neighbouring card can move: the
member's **own URL**. LinkedIn builds `/in/<slug>` out of the member's name and only appends digits
to make it unique, so the slug and the name agree by construction. `nameSlugAgreement` reports
`exact` / `partial` / `conflict` / `unknown`, `acceptNameCandidate` refuses an organization-shaped
value the URL does not confirm, and `slugNameBonus` scores every other candidate by it. A conflict is
penalized rather than refused — a member who changed their display name after the slug was minted
still has a real name on the page — and a name with no latin form is given **no opinion** rather than
a wrong one (rule 1). This is structure, not array position (rule 7), and it holds on every layout.

**2. And the cause underneath it: the section map had never heard of Interests.** `locateSectionRoot`
stops widening a section when the container it is about to take would swallow a **second anchor** — so
a heading the map does not know stops nothing, and the section above Interests kept widening straight
through it and took its tiles as its own entities. That is why a followed company could be an
institution, a skill and a name all at once.

**⚠ The rule this establishes: every heading LinkedIn renders below the collected sections is a
boundary, whether or not anything reads it.** `BOUNDARY_ALIASES` names Activity, Featured, Highlights,
Projects, Publications, Courses, Honors, Volunteering, Organizations, Recommendations, Test scores,
Causes, People also viewed, People you may know and the premium-profile strip. They are matched
exactly like a real section heading and then never extracted, so each costs one boundary and promises
nothing. Interests moved the other way — it is now a **collected** section, because the names on those
tiles are worth having and reading them is what proves the boundary works.

**3. What the scan reads is what the record keeps.** 3.6.0 cut the record back to contact
reachability, and that was half right and half wasteful: the scan was still walking Experience, About
and the top card on every pass and throwing the result away at the last step. Now kept —

| Field | What it holds |
|---|---|
| `experience` | one readable line per role, grouped by company so a promotion is two roles there |
| `educationDetails` | the whole of each card — degree, field, dates, details |
| `interests` | the companies, newsletters, schools and groups followed |
| `headline`, `location`, `about` | the member's own top card; `about` keeps its line breaks |

`education` still holds the bare institution names beside them, because that is what the table leads
its cell with and what a search hits. The **derived** fields stay retired — `totalExperience`,
`currentRole`, `currentCompany`, `yearsOfExperience`, `websites`, `profileImageUrl` — because a value
summed or picked out of a list, disagreeing with the roles printed beside it, is worse than no value.

`mergeProfiles` treats each new list as a whole-section replacement rather than a concatenation:
a scan's first pass always catches a section mid-hydration, and concatenating would keep both copies.

**4. The table was rebuilt around them, as asked.** Name · Email · Mobile · Location · Education ·
Skills · Experience · About · Interests · Open to Work · Status · Notes · Actions. **The name is the
link now**, so the separate Profile URL column went with it. CV, Last Collected and Tags left the
table — and none of them left the record: all three are in the details panel, the editor and the CSV,
because the table decides what is on screen and nothing else (rules 18 and 19). About is capped by
**word count**: ten words or fewer render inline, anything longer is hidden behind "See more", which
is the same affordance every other compact cell already used.

**The CSV appends and does not reorder** (rule 19). The first eighteen columns are exactly where
3.6.0 left them, so a file written by any release since then still opens against the same headers;
`location`, `headline`, `about`, `experience`, `education_details` and `interests` follow them.
`CSV_TABLE_COLUMNS` stopped meaning "the file's order" and now means "the table's columns", which is
the only way both rules can hold at once.

**Not fixed, and not fixable from here:** the Skills section renders two or three skills and hides
the rest behind *Show all N skills*. That control is not on rule 5's allowlist and was not added to
it, so what is collected is what the profile paints.

Build ID `2026-08-08-react-v3.8.0`, so an already-injected content script is refused and replaced
rather than quietly serving the old scorer.

## 3.7.24 — the guard that stopped the scroll, and the page that was walked from its middle

Two reports, one of them a regression 3.7.23 caused.

**1. "It stopped scrolling the profile" — caused by 3.7.23, fixed here.** The list guard added to
`nextRevealStep` last release refuses an anchor inside the applicant list. `applicantList()` is a
**resolver, not a fact**: it takes whichever container carries the most row links, and its candidate
list includes `main` and `[role='main']`. Let it answer with something that also holds the panel's
content and **every** candidate is refused — `nextRevealStep` returns `null`, `revealPanelContent`
breaks on its first pass with `nothing-to-reveal`, the profile column never moves at all, and
everything below its fold is never rendered and so never read. A refinement about *which* anchor to
prefer was able to cost the whole walk.

**⚠ The rule this establishes: the guard may refuse an anchor; it may never leave the walk without
one.** Two things now make that structural rather than lucky. A "list" that also contains the root is
this resolver reaching too wide rather than the other column, so it is disregarded outright
(`list.contains(root)`). And the candidate scan — lifted into `revealStepIn` — is **run again without
the guard** whenever the guarded pass found nothing. The worst the guard can now do is one extra walk
of the candidates, and the walk always has at least the anchors it had before the guard existed. The
benefit is unchanged in the normal case, where the list resolves to the narrow list wrapper.

**2. "It saves the list upside down — it collects the list top to down, the first name gets saved
first, so while saving data it starts from the bottom."** Exactly right, and long-standing rather than
new. The cause is a **seeding order**, not anything wrong in the roster's own merge.

`roster.add()` places an unknown window relative to the first row of it the roster already knows, and
with no known row it has genuinely nothing to anchor on, so it appends — *"this window is new
ground"*. That rule is sound while the page is walked **downward from the top**, which is exactly what
`sweepCurrentPage` does: every step overlaps the last, so every window anchors.

But the run's very first act is `unprocessedRows()`, and that feeds the roster too — **before** the
settle, with the list wherever LinkedIn left it, which is scrolled to the applicant whose panel is
open, i.e. the *middle*. Those middle rows therefore took roster positions 0..n. The settle then
scrolled to the top and added the first window, which shared no row with them, anchored on nothing,
and was appended **after** them. The page order became "the middle, then the top": `roster.next()`
handed back a row from the middle and the page's first name was reached last.

So a settle now **clears the roster before it walks**, because a settle *defines* the page's order and
may not inherit one guessed from an arbitrary scroll offset. It clears **order, never progress** — the
run's `processed` ledger is a separate object, so nothing already collected is collected twice — and
it is scoped to a settle: a sweep asked to find one owed row (`wanted`) keeps the membership it is
searching within. The pager path already reset, so it is unchanged.

Locked by *"a roster seeded before the page is settled walks it from the middle, not the top"*, which
**drives the pure roster** rather than asserting about source: it reproduces the reported ordering
from the two windows in the order the run produced them, then proves the cleared sweep yields
`1..9` and still walks past rows already finished with. Files:
`extension/content-scripts/applicants.js`, `tests/applicants-core.test.js`, `docs/CHANGELOG.md`.

## 3.7.23 — the reveal walk scrolls one column, and stops paying for the other

Three changes on the per-applicant reveal path, from
[`docs/applicant-collector-speed-guide.md`](applicant-collector-speed-guide.md). All three are
**cost, never verdict**: no floor, quiet rule, bottom test, budget, wait, click or read was changed,
and nothing was removed from what a walk collects.

**1. The left applicant list is no longer an anchor for the right panel** (`nextRevealStep`).
Reported as *"the left applicant list sometimes moves while the right profile is being read"*, and
asked for as *"do not scroll the left applicant list while extracting the right-side profile"*.
`scrollableRegions` has refused the list since it was written — walking it belongs to the list walk,
and dragging it here moves the row the run is standing on — and `nextRevealStep`, **the pass that
actually scrolls**, never did. That matters because its `root` is routinely *both columns*:
`applicantPanel()` resolves a strict panel only when one container carries `PANEL_MIN_SECTIONS`
**hydrated** section headings, which on this surface it routinely does not — that is the whole reason
`buildSectionMap` widens page-wide — and the fallback refuses a `main` holding more than one row link,
landing on `document.querySelector("main") || document.body`, which holds the list. From there the
last rendered element, which is the **tail** this walk aims at, is usually the last list row: so the
reveal spent its passes dragging the recruiter's list and confirming *its* bottom instead of the
applicant's. Refusing it gives up nothing readable — a list row is not the open applicant's content,
and every section collector already refuses a heading or a root inside the list — and it is the same
both-directions guard `scrollableRegions` makes, so a wrapper holding the list is refused while its
own children are still offered. The list is resolved **once per pass**, not per element.

**2. No forced layout per candidate, per pass** (`nextRevealStep`). `isVisible` costs a
`getComputedStyle` and two rect reads, and `innerText` is *layout-aware*: it consults style and line
breaking across the element's whole subtree. Both were paid for **every** `div`, `section`, `li`, `p`
and heading under the panel — hundreds of them — on every one of up to `REVEAL_MAX_PASSES` (40)
passes, **twice** per applicant, on a run that walks a job one applicant at a time. `textContent`
answers the only question asked here — is there any text at all — without consulting style or
geometry, and `/\S/` stops at the first non-space character. This is the rule `sectionLabelsIn`
already follows (*"textContent measured before isVisible, so the common case costs no layout"*) and
the one `applicantRows()` was corrected to. It can only ever **widen** the candidate set, and then
only by a visible box whose text is all inside a hidden child — and a candidate is an **anchor**: it
decides where the walk scrolls, never what is read, so a wider set cannot cost a field.

**3. The region walk stops re-deriving the panel on every pass** (`revealRegion`). It read through
`livePanel(null)`, which resolves the panel **from scratch** every time: a document-wide
`querySelectorAll`, then per candidate an `isVisible`, a `rowLinksIn`, a `headingsIn` (its own heading
scan, with an `innerText` per heading) and `element.innerText.length` — the whole column's text, built
only to compare sizes. Paid up to `REGION_MAX_PASSES` (25) times per region, for every region, in
every one of `REGION_ROUNDS` (4) rounds, per applicant. Every other walk on this surface threads its
panel through instead — `scanApplicantPanel` and `revealPanelContent` both do `livePanel(live)` on
every step — because that is what the helper is *for*: the same node while it is connected, a fresh
resolve once it is **detached**, which is the case the null form was reaching for. So the re-mount is
still caught and the identical panel is still read. It cannot narrow what is collected: a connected
panel is the one every other pass of the extraction is already reading, and `buildSectionMap` still
widens page-wide for any section the panel does not hold. `revealNestedRegions` resolves it once per
round and hands it down.

**What was deliberately NOT done, and why.** The guide also asks for the resume to be handled *before*
the full profile scroll, and for the walk not to return to the top after reaching the bottom. Both
were left alone because both are load-bearing for data:

- **Resume ordering.** `collectResume` is passed `header.name` and that is the name the file is saved
  to disk under. The name is only settled *after* the scan — it is corroborated against the
  qualification explanation sentences, which is what stops the panel's first line being saved as
  somebody's name. Moving the resume ahead of the scan saves files under an empty or unarbitrated
  name, which is rule 1. The viewer is already only ever a *fallback*: the PERMANENT rule means
  nothing is opened at all when the document address is already on the page.
- **The final read from the top.** `scanApplicantPanel` ends with a scroll to the top, a wait and a
  `snapshotPanel`. That snapshot is a **read**, taken once everything below has hydrated, and the
  accumulator is merge-only — deleting it deletes a chance to capture a top-card value that arrived
  late. A scroll that ends in a read is not a wasted scroll.

Locked by *"the reveal walk scrolls the applicant's column and never the recruiter's list"* and
*"revealing costs no forced layout per candidate and no panel re-resolve per pass"*, the second of
which also re-asserts that `REVEAL_MIN_PASSES`, `REVEAL_QUIET_PASSES` and the region walk's shared
floor are untouched. Files: `extension/content-scripts/applicants.js`,
`tests/applicants-core.test.js`, `docs/CHANGELOG.md`.

## 3.7.22 — a section ends where the next one begins

Reported against one live applicant, with both halves of the record pasted: **Experience** held their
two jobs *and* their two degrees *and* the screening question; **Education** held the same four
entries, the jobs among them, plus a school called "Education verified". Requested outright: *"both
experience and education is getting saved in both education and experience — make extension
differentiate them and save them correctly, and the screening question should save separately, not
with the experience block."*

**Two causes, one on each side of the read.** Structurally, a resolved section root spanned more than
one section, so `blocksIn` handed both readers the same cards. And neither parser refused anything:
`parseExperienceBlock` and `parseEducationBlock` are **shape-only** — first line, then the line
carrying the dates — so two lines are two lines whatever they say. `parseExperienceBlock` turned
"CHANDIGARH UNIVERSITY / Bachelor of Laws - LLB · 2021-2024" into a job at a degree, and
`parseEducationBlock` turned "Legal Assistant / Bhatia and Khatri Law Office · 2024-Present" into a
school called Legal Assistant. Both were saved, on the same applicant, from one run.

**The structural half — one boundary set instead of five.** `sectionRootFor` and `siblingSectionFor`
are each bounded by the headings **their own pass was given**, which is not the same set as "the
section titles on this page". A label pass never sees the real headings and a heading pass never sees
the labels; worse, the label passes are asked only for the keys nothing else produced, so a pass
looking for one missing section is handed **one** candidate — `others` is empty, the upward walk never
breaks, and the root it returns is the whole detail column. `sectionBoundaries()` is the union, taken
once over the panel and the page, headings and labels alike, for **every** key; it is used only to
*bound* a root, never to collect one. `narrowSharedSections()` then runs at the end of
`buildSectionMap`, because only then is every boundary known — a section resolved by the panel pass
can only be checked against a title the page-label pass found afterwards. `ownSectionNodes()` is a
**descent**, not a sibling walk, because the two titles are routinely at different depths: at each
level, a child holding both titles is descended into, and otherwise the section is the run of children
from its own title up to the first one holding somebody else's. It may only ever take another
section's cards away and never this section's own — a root holding no foreign title is untouched, and
a narrowed range that carries nothing is discarded rather than kept. It reuses `__pvSectionNodes`, so
`blocksIn` and `carriesSectionContent` already understood it.

**And the text fallbacks, which have no structure to work on.** Every reader falls back to walking the
section's text **linearly** when the markup offered no blocks, and a flat string has none of the
structure the narrowing operates on. That is where "Screening question responses" became a job title
with the question beneath it as the employer. `ownSectionLines()` cuts at the first line naming a
**different** section — and at nothing else, deliberately: treating any noise line as a boundary would
end Experience at its first "Experience verified" card. All five readers use it.

**The parser half — a card that is unmistakably the other section's is refused, and the two refusals
are deliberately asymmetric.** `deriveCurrentPosition` and `totalExperienceFrom` read the experience
list and nothing else, so a job dropped there empties three exported columns — which makes a *lost*
job as wrong as an invented one (rule 6 cuts both ways). So the experience refusal takes either a
**spelled-out** qualification, which no employer is named, or an institution on the first line
*corroborated* by a qualification anywhere in the card: `Assistant Professor / Chandigarh University`
is still a job, and `Ground Engineer / BBA Aviation` still is too, because an abbreviation that is also
a company name may never refuse one on its own. The education refusal is looser — a card naming
neither a place of study nor a qualification is not one — because education is a list rather than the
source of a derived column. A screening question is refused by both: no role and no school is phrased
as a question.

**One list of section titles instead of two.** `EXPERIENCE_NOISE_PATTERN` carried the list;
`EDUCATION_NOISE_PATTERN` carried four entries. That is the whole of why the two readers behaved
differently on identical input, and why "Education verified" was stored as an institution while
"Experience verified" was correctly discarded. `SECTION_TITLE_NOISE_PATTERN` now names every section
on the surface — a root that spans one boundary routinely spans the next as well — and
`isSectionTitleLine()` applies the same count/middot/colon trimming `sectionKeyFor` applies on the page.

**One fix that was not asked for and is the same defect.** The degree and the years share **one** line
at least as often as they get two — `Bachelor of Laws - LLB • 2021-2024` is what the live card renders
— and there was no line left over for the degree, so it was stored as `null` and the whole line became
the `dateRange`. The same collapsed-metadata problem the experience card has, answered by the same
tested `splitCompanyAndDates`, and only when nothing else offered a degree, so a card that spells the
years out on their own line is untouched.

`diagnostics.sectionScan.resolved[].narrowedFrom` names the root a section was cut back from, which is
the one line that identifies this cause on a live page. Three new tests: *"an education card is never a
job, a job is never a school, and a question is neither"*, *"one list of section titles, so both
readers know where a section ends"* and *"no two sections are handed the same cards"*. No control, no
click, no permission and no message changed.

## 3.7.21 — a resume costs the applicant it belongs to, and nobody else

Requested outright: *"i want to make the extension faster where we can improve without compromising
the data"*, after *"it should work 15-20 second on every profile"*. So: four changes, every one of
them a change to what a wait **costs** and none of them a change to what a walk **concludes**. Not one
read, floor, budget or verdict moved. The suggestion that came with it — stop scrolling the applicant
list — was **not** taken, and the reason is measured rather than argued: `sweepCurrentPage` runs once
per *page* of 25 applicants, not once per applicant, so it is ~0.2 s each, and it is the only producer
of the rows above the current scroll position, the confirmed-bottom test, the page membership the
pager is gated on, and vanished-row retirement. Removing it re-introduces both defects 3.7.12 fixed —
the walk jumping backwards and forwards, and the pager pressed with part of the page never opened —
which loses applicants silently. Under 1% of the time for that trade is not a trade.

**The one that mattered: a repainting viewer was testifying about the page.** The tempo (3.7.14) asks
one question — "is this page keeping up" — and answers it from whether the document went quiet. That
inference holds only while the mutations being watched are the page's own hydration. LinkedIn's
document viewer renders and re-renders PDF pages for as long as it is open, so a wait held over one
**can never** observe a quiet window and always ends on `timeoutMs`, recording `"unsettled"`. And
`recordTempo` is asymmetric by design: **one** such sample pins the run to `SLOW`, where every
applicant afterwards pays a 1.25× quiet window and the 900–1300 ms pace band. So opening a single
resume made the whole rest of the job slower, on evidence about a PDF renderer. `waitForDomQuiet` now
takes `{ sample: false }`, and the viewer walk is the one caller that uses it — the wait is unchanged
in every other respect, same window, same ceiling, same resolving condition; only the verdict about
the page is withheld. Excluding it makes the measurement **more** accurate, not more optimistic: it
removes a reading taken with the thermometer against the radiator. Sampling is opt-**out**, so a new
wait testifies unless deliberately excused, and a test caps the excused waits at two.

**A fixed sleep in front of a poll can only make the answer arrive later.** `clickResumeDownload`
ended with `waitForDomQuiet(150, 900)` so "the request has been made when the entry log is read" — but
nothing in it reads the entry log. The **caller** does, by polling: `waitFor(… requests.url() …)` over
`RESUME_DOCUMENT_TIMEOUT_MS`, with `watchResumeRequests()`'s observer live since before the viewer
was opened. The poll already covers a slower network than the sleep ever did. Held over the viewer it
was also a guaranteed `"unsettled"` sample, so it cost the 900 ms twice over. The PERMANENT chain of
rule 9i is untouched — the control is still found by the tested policy, still pressed, still before
the document address is looked for, and the test still asserts all of it.

**The dismiss looked after it slept.** `closeOpenedOverlay` dispatched Escape then `await wait(250)`
before its first check, and again after clicking a close control — up to 500 ms per applicant to
confirm something that a modal honouring Escape does in a frame or two. It now polls the predicate it
already tested for, with the same 250 ms ceiling, so a genuinely slow modal is given exactly what it
had. Deliberately **not** through `waitFor`: that calls `assertRunnable()` on every poll, so a Stop or
a hidden page would throw straight out of a *dismiss* and leave the preview on screen — which is the
complaint the function exists to answer. Still exactly one `.click()`.

**And the worker's read-back is answered sooner without being given less time.** `downloadedFilePath`
polled `chrome.downloads.search` on a flat 120 ms, and the content script **awaits** it before it can
advance. It now starts at 25 ms and backs off ×1.7 to a 240 ms ceiling; the ten intervals sum to more
than the flat poll's 1200 ms, so a genuinely slow download gets at least the budget it had — a test
computes that sum rather than trusting the constants. An interrupted download is still reported as
interrupted, never as a saved file.

Two new tests: *"a repainting viewer cannot testify about the page, and one resume cannot slow the
rest of the run"* and *"reading back where Chrome put the file is answered sooner, never given less
time"*. Files: `applicants.js`, `src/background.ts`, `tests/applicants-core.test.js`, `CLAUDE.md`,
`CHANGELOG.md`.

⚠ **Not verified live** (rule 17). Local checks only: typecheck, build, 450 tests, validate.

## 3.7.20 — the walk starts at the first profile, and only scrolls for more when the queue runs dry

The clarification to 3.7.19, and it names the behaviour rather than the mechanism: *"instead of
collecting list only, the extension go to first profile then collect data then go to next profile
then collect then next and continues, and click load more when needed and redirect on pages if
needed."*

3.7.19 built the handover and it was real, but it did not produce that walk, for a reason that is one
line long: **`HANDOVER_PENDING_ROWS` is only ever tested BETWEEN passes, and a pass is
`DISCOVERY_STEPS_PER_PASS` (120) steps.** On the 19,000-connection account this was reported against,
the first pass scrolls 120 screens — many minutes, thousands of rows — before the check that hands
over is reached at all. So the run still looked exactly like "enumerate the list first", which is the
whole of what was being complained about.

`HANDOVER_PASS_STEPS` (12) is the other half. The two passes whose only job is to keep extraction fed
ask for a short one — `runDiscovery` in handover mode, and `discoverNextPage()`, the drain loop's
top-up, which is reached only when `autoDiscover` is on. `connections.js` already accepted and clamped
`options.maxSteps`, and `planDiscoveryStep` already had a `step-budget` verdict, so this is a budget
passed to machinery that was built for it rather than new machinery.

What the user sees is the walk they described: the first profile opens within seconds, each one is
collected and the next opened, and the list is scrolled — with lazy loading waited out and an
allowlisted `Load more` / `Next` used when it stalls — only when the queue runs dry. That last part is
`discoverNextPage()` and has been there since 3.3; it just never got a turn early enough to matter.

**`Discover Connections Only` passes no handover budget and keeps all 120 steps**, because enumerating
the whole list is the one thing that command is for, and a test asserts it never takes the shortcut.

**A short pass can never be mistaken for the end of the list, and that is structural rather than
careful:** `planDiscoveryStep` returns `DONE / "step-budget"` with `exhausted: false`, the content
script sets `atBottom = plan.exhausted`, and `applyDiscoveryPass` cannot settle without
`pass.atBottom`. A budget stop therefore says "I stopped early", never "there is no more".

**But the budget has to stay clear of `DISCOVERY_QUIET_SCANS` (5)**, the in-pass count of quiet bottom
reads needed before the list may be declared finished — and this is the one way shortening a pass
could have gone badly wrong. A budget below it could never reach a real verdict at the bottom, so
every pass would return `step-budget`, the drain loop would spend `MAX_FRUITLESS_DISCOVERY` on it and
then finish the run **anyway** with `discoveryExhausted: true`: a false completion on a list that is
not done. A bottom pass costs about seven steps at worst (two quiet reads, a pagination click that
resets the count, then five more), and the test asserts the *relationship*, not the number.

Nothing else moved. `HANDOVER_PENDING_ROWS` (25), the drain loop, its bounds, the state machine, the
two-tab rule and the pacing are all unchanged. Files: [src/background.ts](../src/background.ts),
[tests/collector-workflow.test.js](../tests/collector-workflow.test.js) (two new tests),
[CLAUDE.md](../CLAUDE.md).

## 3.7.19 — the list and the profiles are collected together, not one after the other

Requested outright against a **19,000-connection** account: *"instead of collecting the connection
list first, collect the list and collect them one by one at the same time."*

`Start Full Collection` ran `runDiscovery` to a settled bottom before reading a single profile. On
19,000 connections that is hours of scrolling with nothing collected — and an interruption anywhere
in that window leaves a long list and no profiles.

**Almost all of the machinery was already there.** `discoverNextPage()`, `autoDiscover: true`, the
legal move `moving_to_next_profile → discovering_connections`, and the drain loop's
`shouldContinueAutoDiscovery` / `registerDiscoveryGrowth` / `registerFruitlessDiscovery` bounds have
asked discovery for more whenever the queue empties since 3.3. The only thing missing was the
**first** handover, so the run now:

1. reads the list until `HANDOVER_PENDING_ROWS` (25) are queued — `stoppedBy: "handover"`,
2. hands over and starts extracting,
3. goes back for more of the list whenever the queue drains, for as long as the list keeps giving.

Three things about it are deliberate:

- **25 is a floor, never a cap.** A pass that mounts 400 rows queues all 400; the number only decides
  how little is enough to get started, and that pass was paid for either way. It is checked **after**
  the pass is persisted, so nothing handed over exists only in memory.
- **An early return is "enough to begin", never "that is the whole list".** It leaves
  `discoveryExhausted` alone, which is what keeps the top-up running. Getting that wrong would make a
  part-read account look finished and stop the run thousands of connections early.
- **`Discover Connections Only` is untouched** and still enumerates everything — that is its entire
  purpose — and a test asserts it never takes the shortcut.

`connections_complete` is now the hand-over rather than the end of the list, so both of its
user-facing strings were corrected; "Connections list complete" is untrue for most of a large run.

**⚠ They interleave; they do not run at the same time, and they cannot.** Rule 12a: LinkedIn does not
render a hidden tab, so its DOM freezes and every "has it finished?" signal reads as finished.
Discovery needs the Connections tab painting and extraction needs the profile collector tab painting,
and only one tab of a window is active at a time. Alternating is the whole of what "at the same time"
can mean here. Rule 12's two-tab limit is unchanged, and no new tab, click or control was added.

## 3.7.18 — a finished run no longer makes both connections buttons dead forever

Reported as *"nothing is happening"* — after 3.7.17 raised the Connections window and it still did
nothing. That is because 3.7.17 fixed a real gap that was **behind** this one: the reveal runs inside
the workflow, and the workflow was returning before it ever got there.

Both workflows opened on a bare guard:

```ts
if (!(await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_CONNECTIONS))) return;   // silent
```

and the transition table gives all four terminal states exactly one move:

```js
[STOPPED] [COMPLETED] [COMPLETED_WITH_GAP] [FAILED]  ->  [IDLE]
```

So from the moment a run first finished, was stopped, or failed, `OPENING_CONNECTIONS` was refused
and **both `Start Full Collection` and `Discover Connections Only` became permanent no-ops.** Nothing
said so: the command branch had already replied `started: true`, so the page reported *"Collecting.
Your connections are being discovered first, then extracted one at a time."* while the detached
workflow returned on its first line. The only escape was `Clear Queue` — which throws away the whole
discovered list to unstick a state machine.

It is long-standing rather than anything the applicants surface did; the same guard is in the
recorded baseline, and `connections.js` and `connections-core.js` have not been touched since.

`beginConnectionsRun()` is the fix, and it is scoped deliberately:

- **A button press is "explicitly starting over"** — which is what the transition table's own comment
  already says is the way out of a terminal state. So a terminal state is reset to `idle` first, then
  the move the guard wanted is taken.
- **Only terminal states.** By definition nothing is in flight in one. Every other state keeps
  refusing, which is the property that makes a service-worker wake-up idempotent instead of a second
  discovery. Both workflows are reached from their command branches and nowhere else — not the
  heartbeat, the alarm or the drain loop — so "a button press" is provable here.
- **It resets a state, not your data.** The queue, the discovered list and every saved profile are
  untouched; `Clear Queue` remains the separate, destructive action.
- **A refusal is never silent again.** `lastError` names the state that refused, because "the button
  did nothing" and "the collector is still finishing" look identical from outside and only one of
  them names a cause.

The evidence trail was already there and is worth knowing about: **Download Diagnostics** carries
`collectionState` and the last 40 state-machine moves as `transitions`, each with `changed` and a
`reason` — a refusal shows up verbatim as `refused:completed->opening_connections`.

## 3.7.17 — the connections buttons bring the Connections page to the front

Reported outright: *"I want these buttons to directly redirect on the connections page and start
collecting"* — about `Start Full Collection` and `Discover Connections Only`, which appeared to do
nothing at all when pressed.

They were not broken. Both already did every step the workflow claims: `rememberOrigin(sender)`,
then `resolveConnectionsTab()`, which opens or reuses the **one** Connections tab in that window,
navigates it to `linkedin.com/mynetwork/invite-connect/connections/`, waits for it, makes it the
**active** tab, and then walks the list. The one thing neither did was **raise the window**:

```js
ensureConnectionsTab(url)  ->  ensureTab(KEYS.CONNECTIONS_TAB, url, { activateTab: true })
ensureApplicantTab(url)    ->  ensureTab(KEYS.APPLICANT_TAB,   url, { activateTab: true, focusWindow: true })
```

The applicant surface fixed exactly this in 3.7.5 and rule 12c has named it since: *a tab activated
in a window the user is not looking at is, to them, a button that did nothing.* The older surface
was simply never brought along. It bites hardest where these buttons actually live — the popup has
no sender tab of its own, so `rememberOrigin` falls back to the last focused window, and the
importer page is routinely a window of its own — so the redirect kept landing off screen.

`revealConnectionsTab()` is its own step, mirroring `revealApplicantTab`, and three things about it
are deliberate:

- **It is not folded into `resolveConnectionsTab`.** `runDiscovery` calls that too, on the
  heartbeat's resume path, which must go on never stealing focus from whatever the user is typing
  into. `prepareCollectorStep` is what that path uses and it is untouched.
- **It runs before `checkLoginState()`, not after.** The session check costs a content-script
  injection and a round trip; a page that arrives seconds after the click reads as the same dead
  button. The check then reuses the very tab that was just revealed, and the signed-out path still
  navigates that same tab to LinkedIn's own sign-in page.
- **It adds no tab and no click.** Still one Connections tab, still one profile collector tab, still
  no control activated but allowlisted pagination.

Rule 12c is amended in the same task, from two focus points to three. Locked by *"a connections
command brings the Connections page to the front, before the slow part"*, which asserts the reveal,
its position ahead of the session check in **both** workflows, and that neither
`prepareCollectorStep` nor `runDiscovery` ever takes focus.

## 3.7.16 — "already open" is the panel's answer, never the address bar's

Reported in two halves that are one cause: *"after extracting one applicant the extension opens a
specific/previous profile again before moving to the next"*, and *"the first applicant on every page
is saved twice."*

`collectVisibleApplicant` decided whether a row's applicant was already on screen by comparing the
row's `applicationId` against `location.href` (`rowId !== openId`), and on a match it skipped the
click **and with it all three of `selectApplicantRow`'s waits** — teardown, arrival, settle-and-ask-
again. The address bar is the one source the rest of this surface already refuses for exactly this
question: `panelOwnApplicationId` will not fall back to it, and rule 9g decides arrival from
identifiers, both because LinkedIn **routes ahead of the render**. So the claim is true while the
detail column is still showing the *previous* applicant.

It is true at exactly two moments the run did not itself create: the recruiter's own open applicant
when a run starts, and **the pager press**, after which LinkedIn selects the new page's first
applicant and writes their id into the address before mounting them. Once per page — which is
precisely "the first applicant on every page".

Reading that stale panel failed two ways, and the quiet one is the worse:

- when the previous applicant's panel rendered its **own** application link, `assertExpectedApplicant`
  threw `wrongApplicant`, the row was retried, and the previous applicant was re-read in between —
  the visible "it goes back to a specific profile before moving on";
- when it rendered **none**, `describePanelArrival` can only answer `arrived` ("mounted, and no id
  was rendered to check it against"), because there is no id to contradict the one asked for. So the
  **previous** applicant was scrolled again, their contact disclosure opened again and their resume
  downloaded again — and that read was filed under *this* row's application id. One person written
  twice, per page, with no error anywhere.

**Deduplication could not have fixed this**, which is why none was added: the record is keyed to the
application that was *asked for*, so a scan that read the wrong panel writes the wrong person under
the right key. That is not a duplicate key, and no store-side reconciliation can see it. The fix has
to be that the wrong panel is never read.

`panelAlreadyShowing()` ([applicants.js](../extension/content-scripts/applicants.js)) makes the address bar a **hint** — a row it
does not even claim is certainly not open, so the question is worth asking at all — and the panel the
**answer**. The claim is accepted only once `describeApplicantArrival` says the panel itself is
showing this applicant, through the same verdict the click path waits on. A panel positively showing
somebody else ends the wait immediately and the row is **clicked**: `OTHER` for a third party, and
`PREVIOUS` against the new `state.lastPanelIdentity` — the identity recorded when the run finished
the last applicant, which is the only thing that can identify a stale panel carrying no application
link of its own. `torn-down` and `mounting` still mean only "I could not tell" (3.7.11) and are still
waited out; only a *positive* arrival may skip the click, and everything else opens the row, which is
where the walk was going anyway.

It presses nothing and adds no control — a confirmed panel is one click saved, exactly as before —
so the seven-click budget, rule 9's list of controls, the PERMANENT resume chain, the contact
disclosure, the roster and page boundary (3.7.12), the pager (rule 9h), Start/Stop, the auto-run and
every extracted field are untouched. `roster.reset()` on a pager press still resets the *page's*
membership while `processed` — the run's ledger of finished rows — deliberately survives it, which is
what makes the first applicant of page two a new person rather than a repeat.

Locked by *"an applicant is opened, read and saved exactly once, and 'already open' is the panel's
answer"*, which asserts the three arrival verdicts that made the defect silent, the hint-then-confirm
shape, one read and one row click per applicant, and the unchanged click budget. Three existing
assertions that pinned the old `rowId !== openId` line were repointed at the new decision rather than
deleted, and one now fails if the address bar is ever allowed to decide on its own again.

## 3.7.15 — the applicant export is the applicants table, and nothing else

Requested outright, against a screenshot of the rendered table: *"update only the download/export
function so the downloaded CSV or Excel file contains **only** these columns in this exact order —
#, Applicant Name, Email, Mobile, Resume File, Current Role, Current Company, Total Experience,
Education. Do not download any extra fields such as qualifications, status, additional emails or
numbers, profile URL, headline, dates, screening responses, full experience history, skills, resume
metadata, job details, warnings, timestamps, applicant ID, or internal data. Keep all extra data
stored internally and do not change any other extension feature or behaviour."*

`APPLICANT_CSV_COLUMNS` is now exactly `["#", ...APPLICANT_TABLE_COLUMNS]`. Twenty-three detail
columns are gone from the file: `qualifications`, `must_have_qualifications`,
`preferred_qualifications`, `screening_responses`, `experience`, `skills`, `application_status`,
`collected_at`, `last_updated`, `all_emails`, `all_phone_numbers`, `website`, `profile_url`,
`headline`, `applied`, `contacted`, `resume_link`, `resume_file_type`, `resume_pages`, `job_id`,
`job_url`, `warnings`, `source_url` and `applicant_id`.

**Not one field left the record.** Every value above is still extracted, still merged into the
stored record, still in IndexedDB and still rendered in the details drawer. That is not a nicety:
`resume.url`, `viewerUrl` and `downloadStatus` are what `resumeAlreadyDownloaded()` reads, and
without them every run would re-download every file. The formatters those columns were built on —
`resumeLink()`, `qualificationRows()`, `formatQualifications()`, `allOf()`, `formatScreening()`,
`formatExperience()` — are all kept, all exported and all still tested, because the drawer renders
through them and a column is a *view*. There is no applicant CSV import, so a narrower file cannot
break a round trip.

**`#` is the row's position in the file being written**, 1..N over the rows exported, which is what
the table's own `#` means for the view it paints. It is derived from where the row lands rather than
read off the record, and it is deliberately not `applicant_id`: two exports of different filters
number the same person differently, which is correct for a serial number and would be a defect for a
key. `applicantsToCsv` passes the index to every column reader; only `#` looks at it.

**This removes columns, which the export's own "append columns; never reorder" rule forbids, so
CLAUDE.md was amended in the same task and says so.** Two of the removals — `resume_link` and
`qualifications` — were 3.7.9 demotions that carried a two-part test asserting each was *still in
the export*; the second half of both is now the opposite assertion. Stated rather than quietly
reversed.

Nothing outside the export changed: the table paints the same nine columns it did before, the
details drawer shows everything it did before, and the collection, resume download, storage and
navigation paths are untouched. Two stale comments in `applicants-dashboard.tsx` that described the
CSV's detail block were corrected; no markup moved.

## 3.7.14 — the applicant walk paces itself to the page instead of to fixed delays

Requested outright: *"optimize applicant processing speed without changing any existing feature,
logic, data, or UI behavior ... slightly faster + fully safe + no missed data ... accuracy > speed
always."*

**Nothing about what is read, clicked, stored or shown changed.** The diff removes ten lines, and
every one of them is inside `waitFor`, inside `waitForDomQuiet`, or is one of the three
`wait(LIST_PROFILE_PACE_MS)` call sites. No extraction rule, no click, no record field, no message,
no control.

**The waste it removes.** Every quiet window in [applicants.js](../extension/content-scripts/applicants.js) is a guess about a
page nobody measured, and it has to be a pessimistic one, because it is chosen once — in the source —
for a panel that might be halfway through hydrating. So a recruiter whose machine and connection
render an applicant instantly pays the struggling machine's 320 ms on every pass, of every walk, of
every applicant, and a 665-applicant job is where that lands.

The page can be asked instead. `waitForDomQuiet` already runs a `MutationObserver` over the whole
document, so it knows for nothing whether anything actually changed while it waited. Three samples of
that decide one of three tempos, and the window is scaled to it.

**The asymmetry is the safety.** One wait that hits its timeout drops the page to `slow` at once and
buys it a window *longer* than the fixed value ever gave; reaching `fast` needs every recent wait to
have observed **nothing at all**. `timeoutMs` is never scaled — the caller's ceiling is what stops an
unsettled page holding one applicant, and a tempo that could stretch it would turn a slow page into a
stuck run. `MIN_QUIET_MS` floors the other end, and the floor can never *raise* a window a caller
deliberately made short.

**What it may and may not do.** A shorter window can only take a read a moment early, and an early
read costs nothing here by construction: `snapshotPanel` is merge-only, every walk re-reads on every
pass, and each quiet counter resets the instant anything grows. What it must never do is *end* a
walk — that would lose sections — so `REVEAL_MIN_PASSES` (4), `REVEAL_QUIET_PASSES` (3) and the
reached-the-bottom test are untouched and the tempo has no say in any of them. The worst case is one
extra pass.

`waitFor`'s poll interval now starts at `FAST_POLL_MS` (50 ms) and backs off to the caller's own
value. A poll interval is not a wait for anything — it is how *late* a condition already true is
noticed — so this can only see an arrival sooner, never accept one it would otherwise have refused.
Polling the panel's arrival every 200 ms meant the average applicant sat on an already-mounted panel
before the run looked, once per applicant, all job long.

The breath between applicants (`PACE_BOUNDS`) follows the same tempo and is randomised within its
band. The medium band still averages `LIST_PROFILE_PACE_MS`, so a normally-loading page paces exactly
as it did; the slow band is *longer* than the fixed value, because that is a page under strain.

`beginRun()` resets the tempo — a page-condition verdict is never carried across runs, the same rule
`wentHidden` is re-derived under. The walk reports the tempo it was held at on `listScroll.tempo`,
because "the run was slow" and "the page never settled" are the same sentence from two ends and only
one of them names a cause.

Two tests lock the bounds at both ends, the unscaled ceiling, the reset, the single pacing helper,
and — the point of the whole change — that the rules deciding when a walk has finished reading an
applicant are exactly the ones that were there before.

## 3.7.14 — an installer, so the extension can be put on another device

Requested outright: *"create an installer through which I can install it in any other device and use
it on them ... it should not affect the current working of the extension or any other features."*

**Nothing about the extension changed, and nothing could have.** `npm run package` reads `dist/` —
the folder Chrome already loads (rule 4) — and writes it into an archive. It adds no source file, no
manifest key and no permission, and it cannot ship anything outside `dist/`, because it never reads
anywhere else. A packaged copy is byte-for-byte the build a developer loads unpacked, and that is
asserted from the archive's own bytes rather than assumed.

**Why a `.zip` and not a `setup.exe` or a `.crx`.** Chrome will not install an extension from a
file: dragging a `.crx` in has been blocked outside the Web Store since Chrome 33, and a desktop
installer cannot get round that, because it is the browser that declines rather than the operating
system. The one supported route for an extension distributed outside the store is **Load unpacked**,
which takes a folder. So the installer is that folder, packed for transport, with the instructions
inside it. Shipping a `.crx` would have looked more like an installer and installed nothing.

```
releases/profile-vault-react-<version>.zip
  profile-vault-react-<version>/
    INSTALL.md      the instructions, beside the thing they describe
    extension/      a byte-for-byte copy of dist/ — the folder to select
releases/profile-vault-react-<version>.zip.sha256
```

The extension is nested under `extension/` rather than being the top-level folder so the instruction
can name it: a recipient who selects the folder above gets *"Manifest file is missing or
unreadable"*, which reads like a broken download rather than a wrong click.

- **`npm run package` is `npm run check` first.** An archive can only be cut from a tree that
  typechecks, builds, passes its tests and validates, so a broken build cannot become an installer.
- **It verifies what it wrote.** The archive is read back through its own central directory, every
  CRC is checked, every entry is inflated and compared against `dist/`, and the packaged manifest is
  re-parsed to confirm its version. An archive nobody can open is invisible until it reaches the
  device it was made for.
- **No new dependency.** Node has no archiver and this project has no build dependencies —
  `npm test` runs on the built-in runner so a fresh clone needs nothing but Node. `scripts/zip.mjs`
  writes the format by hand rather than making the installer the first exception to that.
- **The refusals are named.** A missing `dist/`, a `dist/` not produced by `npm run build`, a
  manifest and build stamp that disagree, or a file the manifest promises that is not in the folder
  all stop the package and say which command fixes it.
- `releases/` is gitignored: derived output, rebuildable from tracked sources, never committed.

[INSTALL.md](INSTALL.md) is written for whoever receives the file rather than for a developer, and
two of its warnings are load-bearing rather than politeness — both are asserted by a test. Chrome
loads an unpacked extension from its folder at **every** startup, so deleting or moving that folder
later uninstalls it; and Chrome derives the extension's identity from that folder's path, and its
storage from that identity, so a folder that moves comes back as a different extension with an empty
vault. The guide also states plainly that saved data does **not** travel with the installer, and
points at **Export all CSV** / **Import CSV** for profiles — while saying that applicants export but
have no import, so they stay on the device that collected them.

Five tests in `tests/packaging.test.js`: the archive round-trips through an independent read, a
damaged archive is refused rather than half-read, the packager reads `dist/` and could not read the
repository, `npm run package` cannot skip its checks, and the install guide keeps the instructions
and accounts for every host permission the manifest asks for. TASK-0124; `npm run package` passed
end to end — 437 tests, then a 338 KB archive of 38 files that Windows' own extractor unpacks to
files identical to `dist/`. Rule 17 still applies: that is the archive verified, not a live install.

## 3.7.13 — Collect Every Applicant removed

Requested outright: *"remove Collect Every Applicant, its code and function and feature ... that will
not affect any other button or any other feature."*

**It was never a second walk.** `options.listOnly` chose between two **per-row bodies** inside one
loop, and everything that makes a run a run was already shared between them: the row loop, the
identity ledger, the page roster and page boundary, `growApplicantList`, the pagination (rule 9h),
the conclusive-stop rule, the collected index, the panel-arrival guard, the auto-run and the
reload-resume. By 3.7.11 the two bodies had converged as well — Collect Applicant List opens each
applicant, walks their panel to the bottom, opens their contact disclosure and saves their resume —
leaving `expand: false` and the row-name floor as the only differences between them. So what went is
**one branch and one button**, not a capability.

Removed: the button and `collectEveryApplicant` in the popup, the button and `collectAll` on the
Applicants page, and the per-row branch that called `extractApplicant({ ...options })` directly
along with the already-collected check it duplicated (the bulk retirement above it always did that
work for both paths, which is why deleting it changes no behaviour). `options.listOnly` is still
accepted and simply no longer read, so a run armed by the previous build resumes rather than falling
into a branch that is gone.

Kept, and asserted: Collect This Applicant and `PV_APPLICANT_EXTRACT`; Collect Applicant List and
`PV_APPLICANT_COLLECT_ALL`; `extractApplicant` — now the surface's one per-row path, called both by
the walk and for a single applicant; `sweepCurrentPage` and the roster; `clickApplicantPager` and
`isConclusiveListStop`; `selectApplicantRow`; the PERMANENT resume chain and the contact disclosure;
`continueInterruptedRun` and `pumpAutoRun`; and the seven-click budget, which counts **controls** —
no control was removed here, only a caller.

`recollect` moved rather than being deleted. It is a property of a *run* — "walk past the people
already saved, or open them again" — and never belonged to one button, so **Re-collect already
saved** now travels with Collect Applicant List. Unchecked it sends `false`, which is the walk's own
default, so that button's behaviour is unchanged unless the box is ticked.

TASK-0123. `npm run check` passes (432 tests). Rule 17: this is unit tests and fixtures, not a live
LinkedIn result.

## 3.7.8 — The section that was never read, every page of the list, and a resume that saves itself

`npm run check` passes here (411 tests: typecheck, build, test, validate).

Eight requests, six separately reversible tasks: TASK-0044 (sections), TASK-0045 (resume tab),
TASK-0046 (pagination), TASK-0047 (columns), TASK-0048 (popup and prose), TASK-0049 (row heights).
Two of the eight were re-reports, so both were traced to a named line before anything was edited.

### `current_role`, `current_company` and `education` were empty — the fourth report

**The parser was never the bug.** Every entry in the supplied screenshot —
`Specialist, Talent Solution Delivery` / `Randstad · 2026-Present` / `Experience verified` — parses
correctly, character for character, through `parseExperienceBlock`, `splitCompanyAndDates` and
`normalizeDateRange`. The section *root* was the bug, and there were two halves to it.

**`sectionRootFor` could return a container holding only the heading.** It seeded `best` with
`heading.element.parentElement` and walked only upwards, breaking at the first ancestor that held
another heading. LinkedIn renders the applicant's section title in its own header row — the word plus
a collapse chevron — with the entries in a *sibling* container, so on that markup it returned the
header row: a root whose entire text is "Experience". `blocksIn` found nothing, the text fallback
parsed the single word, `EXPERIENCE_NOISE_PATTERN` correctly discarded it, and the applicant was
saved with no experience at all. Education failed identically, which is what made the shape obvious —
one broken parser would not have taken both. `carriesSectionContent()` now decides, and when no
ancestor qualifies `siblingSectionFor()` takes the heading's following siblings up to the next keyed
heading, returning a **detached wrapper referencing the live nodes** — never appending them, which
would move them out of the page.

**And a useless root permanently blocked every rescue.** `collectSections` refused to replace a key
already in the map, so one degenerate panel root blocked the page-wide pass added in 3.7.4, the label
pass added in 3.7.6, and everything else. That is why three releases of widening the search changed
nothing. `sectionIsUseful()` now decides whether a stored section counts as an answer.

**The other half was the scroll, and the report's own hypothesis was right.** The applicant's profile
preview is its own **nested scroller** inside the panel, and `scrollCandidates` refuses any descendant
carrying less than `COLUMN_TEXT_SHARE` (60 %) of the panel's text — correct for choosing the one
column the position walk drives, wrong for revealing. `revealPanelContent` only calls `scrollIntoView`
on the panel's last element, which moves that element's **ancestors**. So nothing ever scrolled that
region: only its first screenful rendered, Experience and Education sat below its fold, and
Qualifications — outside it — came through fine. `scrollableRegions()` and `revealNestedRegions()` now
drive every scrollable region innermost-first to its bottom, bounded, restoring every position.

**And the requested logging.** `sectionMarkup()` captures each resolved section's real `outerHTML`
(bounded to 1500 characters) onto the diagnostics, and `logSectionScan` prints it whenever experience
or education produced no entries — distinguishing "no section resolved, here are the headings seen"
from "resolved but empty, here is the markup it was read from".

### The resume opened a tab and the run died in it

`collectResume` pressed the control with a bare click and **nothing anywhere handled the tab it might
open** — no `chrome.tabs.onCreated`, no `openerTabId`, no `window.open` shim, repo-wide. So when the
control was an `<a target="_blank">`, LinkedIn opened a real foreground tab, the applicants tab went
hidden, every `waitFor` poll called `assertRunnable()` which threw `hiddenPageError`, and
`extractAllApplicants` **broke out of its row loop**. The run was not stuck; it was dead, and closing
the tab by hand did not bring it back because nothing restarts a run mid-list.

The cycle now happens in the worker, which is the only place that knows the id of the tab it created:
`PV_APPLICANT_OPEN_AND_SAVE_RESUME` opens the document through `Tabs.openDocumentTab()` — added to
`collector-tabs-core.js`, because rule 12 says that file is the only place a tab may be created, and
the first attempt put `chrome.tabs.create` in the worker and three tests correctly refused it — opened
**inactive**, waited to completion because the load is what makes the session and referrer right for a
signed media address, saved under the applicant's own name, with an in-tab credentialed read as the
fallback. The tab is closed and the hiring tab re-activated in a `finally`, so every failure path
cleans up too. `state.resumeCycle` suspends only the visibility guard for those seconds, and a hidden
page is now a **pause** rather than the end of the list: `waitForVisibleAgain()` holds, a Stop ends it
at once, and the run re-reads the applicant it was on.

### Only the first page of applicants was collected

`loadEveryApplicantRow` had exactly one action — scroll — and treated "the scroll container reached
its bottom and stopped growing" as "the list has ended", so the end of page one was indistinguishable
from the end of the list. `CONTROL_PURPOSE` gains `PAGINATION` and **rule 9 gains 9h**, which is the
only way a control may be added to this surface. Same shape as every other purpose: an allowlist by
name, the denylist consulted first, `inContainer` mandatory, and a disabled pager never offered —
on the last page LinkedIn renders it and disables it. Three bounds keep it terminating: growth counts
new rows and never a click, a pager revealing nothing three times is retired, and the pass budget caps
the walk. `logListWalk()` now says rows, pages and why it stopped, because those diagnostics were
being written and thrown away.

### Four columns removed, one distinction kept

`must_have_met` and `preferred_met` are gone outright — they were computed from `qualifications`,
which is itself a column, so each summarised the cell beside it. `application_status` and
`collected_at` leave the **table** and move to the CSV's detail block rather than being deleted from
the record: `applicant.applicationStatus` is an **IndexedDB index** (rule 14) and backs the page's own
status filter, and `collectedAt` is preserved across merges. That is the distinction 3.7.6 made when
it cut five resume columns to two — consolidating columns is not dropping fields.

### The popup, the prose, and the shifting rows

The popup's **Job applicants** section is always shown; gating it on the active tab meant the section
the recruiter opened the popup for was absent most of the time, and the gate bought nothing because
the worker resolves a hiring tab in any window and re-opens the last one it was on.

Explanatory prose is gone from all four surfaces. What stays is everything that reports **live state**
— pause reasons, auth messages, the current profile, stop reasons, counts, the reconciliation panel.
Six tests asserted the presence of sentences; each now asserts the behaviour where it is actually
enforced, which is a stronger claim than the sentence was.

The table stopped shifting. Rows are a fixed 72px above the card breakpoint, so a cell going from an
em dash to a value no longer shoves every row below it down on the three-second poll; and the status
banner, which was rendered conditionally and moved the whole table each time it appeared or cleared,
now sits in a reserved `.pv-slot`. A new test forbids any stylesheet animating a layout property.

### Not verified here

Nothing in this release has been run against live LinkedIn (rule 17). The console now answers the two
questions that matter on the next run: `logSectionScan` prints the markup behind an empty Experience
or Education, and `logListWalk` prints how many pages the list walk actually covered.

## 3.7.7 — Downloading the resume, coming back without a reload, and one visual language

`npm run check` passes here (405 tests: typecheck, build, test, validate).

Four requests, four separately reversible tasks: TASK-0039 (popup close), TASK-0040 (auto-restart),
TASK-0041 (resume), TASK-0042 (redesign). Two of them were re-reports of fixes that had already been
attempted, so both were traced end to end before anything was changed, and what follows says what was
actually broken rather than only what changed.

### Resumes opened a preview and saved no file

The download was wired in all along — `collectResume` sends `PV_APPLICANT_DOWNLOAD_RESUME`, the
worker calls `chrome.downloads.download`, and the applicant's sanitized name reaches the filename
without being dropped on any hop. Four other things were wrong.

**The viewer was opened and then silently left on screen.** `closeOpenedOverlay` dispatched a
synthetic `keydown` — `isTrusted: false`, which plenty of overlays ignore — and if that failed it
looked only for a `<button>` **inside** the element `findResumeViewer()` had matched. LinkedIn's
document viewer routinely renders its close control as an `<a>` or a `[role="button"]`, and often in
the modal *chrome* rather than inside the content, so there was nothing to find. Worse, the boolean it
returned was discarded at all three call sites, so a viewer that ignored both was left up without the
extension ever mentioning it. That is the reported symptom exactly. It now retries three times,
dispatches to the overlay as well as the document, searches the overlay **and** its modal wrapper
across `button,a,[role='button'],[aria-label]`, and `dismissResumeViewer()` records the result and
puts a warning on the record when it would not close. Still exactly one click: the budget is unchanged
at five.

**The file was never found for a viewer that does not write its address down.** The attribute sweep
cannot see a viewer that fetches the bytes in JavaScript and paints them into a `<canvas>`, or hands
them to a plugin as a `blob:` URL — which `resumeUrlFrom` refuses, correctly, because it is not an
address the worker could ever fetch. So the sweep found nothing, the applicant came back `link_only`,
and the preview was all there was. `fetchedResumeDocumentUrl()` reads
`performance.getEntriesByType("resource")` — the browser's own record of what the page **actually
requested**, an observation rather than a guess — filtered through the same tested
`Applicants.isResumeDocumentUrl()`, so it can no more return a route than the attribute sweep can.

**Its `since` floor is not optional and is the whole safety of it.** The entry buffer belongs to the
*document*, and a run walks hundreds of applicants through one without ever navigating. Consulted
unbounded it would hand applicant two applicant one's CV — saved under the wrong person's name, which
is worse than no file at all (rule 6). The floor is stamped with `performance.now()` **before** the
click, and the function refuses to answer without one.

**A download Chrome interrupted was reported as saved.** `downloadedFilePath` returned the *requested*
path on `state === "interrupted"` and `downloadResume` still answered `status: "downloaded"` — so an
expired signed media address, a 403, or an HTML error body became a `resume_file` naming a path that
is not on disk. `mergeApplicantRecord`'s `keepDownload` then protected that wrong answer from ever
being corrected by a later collection. It now returns `{ interrupted, reason }`, the caller answers
`failed`, warns on the record, and sets `retryFromPage`.

**And the second attempt, which is what the request asked be checked.** `chrome.downloads` fetches
with the browser's own cookie jar, so the direct download is still tried first every time and costs no
memory. When it comes back interrupted the content script fetches the same address with
`credentials: "include"` from the tab that rendered it — refusing an HTML answer outright and anything
over 25 MB — and hands the bytes to the worker as a `data:` URL. The worker still owns
`chrome.downloads`, and the *address* is still what every refusal is applied to; the bytes are only
what was found at it.

Also: `state.downloadedResumes` became a `Map`, so `already_saved` names the file it landed as instead
of leaving `resume_file` empty; and `logResume()` puts one line per applicant in the hiring page's
console saying where the address came from, whether the viewer closed, whether the file landed, and
why not.

### Coming back to a job restarted the run only after a manual reload

Two causes, both confirmed in the source first.

**The arrival was consumed before it was acted on.** `checkAutoRunArrival()` wrote
`state.autoRun.lastKey = key` and *then* called `startAutoRun(key)`, which is async, fire-and-forget,
and has several silent bails — a list that has not mounted yet after an in-app route, a worker that
was asleep, `busy`, a run in flight. The poller only ever acts on a *change*, so one lost race lost the
restart permanently. A reload rebuilds `state` with `lastKey: ""` and gets a clean attempt, which is
exactly why F5 worked and nothing else did. An arrival is now **recorded** as `pendingKey` and
fulfilled by a separate, repeatable `pumpAutoRun()`: transient bails keep it pending and it is retried
on every watcher tick, bounded by `AUTO_RUN_MAX_ATTEMPTS` (8), while a Stop, a run already in flight,
an unarmed job or a page that moved on call `abandonAutoRun(reason)` and say so in the console.

**The key was the job alone.** `/hiring/jobs/<id>/manage`, `/hiring/jobs/<id>/applicants` and
`/hiring/applicants/?jobId=<id>` were all `job:<id>`, so moving between a job's own views in
LinkedIn's app and landing back on its Applicants list was never an arrival at all.
`Applicants.applicantsViewKey()` is new, pure and tested: the job id plus the pathname with its ids
stripped. It is identical when a row is opened — the one thing that must not count, whether the
application's id lands in the query or in the path — and differs for a different view of the same job.

**A poller only samples.** Three watchers now sit alongside it, none needing a permission or a click:
`popstate` and `hashchange` for back and forward; a debounced `MutationObserver` for `pushState`,
because a content script's isolated world has its own `history` object and patching `pushState` there
would never see LinkedIn's own call to it — the re-render that follows is what is observable; and
`pageshow` with `event.persisted` for a back/forward-cache restore, which is the reported back-button
case. That one is the case a poller can never see: the *same* document comes back still holding the
key it was frozen on, so the return read as "we are already here" — and freezing had latched
`state.wentHidden`, so `assertRunnable()` would have thrown "the page is hidden" before a row was
read. Both are re-derived on restore. A re-injection now disconnects the observer and removes all
three listeners.

### Collect Every Applicant closes the popup

The run happens on the hiring tab, which the worker has just activated and focused, so a popup left
hanging over it covers the one thing the button was pressed to watch. It closes **only once the run
has actually started** — `{ ok: true, started: true }`, which the worker returns after it has resolved
the hiring tab, revealed it, confirmed a matching-build content script answered `PV_APPLICANT_PING`,
armed the standing auto-run instruction and dispatched `PV_APPLICANT_EXTRACT_ALL`. Anything short of
that keeps the popup open and shows the error, because a window that vanishes on failure is a button
that silently did nothing. It no longer shares `runImport` with Start Collecting and Collect This
Applicant — neither of those may take the window away — and `closePopup()` clears the 2 s poller before
`window.close()` and latches a `closing` flag every state write checks, because `window.close()` does
not tear the document down synchronously.

### One visual language instead of four

The four stylesheets each carried their own copy of the same primitives and disagreed about all of
them: four page backgrounds, three inks, two font stacks, and two files defining the **same** custom
property names with different values (`--muted` was `#5b6472` in one and `#687386` in the other,
`--good` `#0a7d4a` vs `#17633a`). `.danger` was a solid fill on three surfaces and a white outline
button on the fourth. Only one file gave buttons a hover; only one declared `color-scheme`. Four
screens of one product cannot be redesigned as one thing while that is true, so **theme.css** now
holds the tokens, the reset, the type scale and every shared primitive, is loaded **first** by all four
pages, and each page file holds only what is genuinely its own.

The look: warm off-white surfaces rather than the cold blue-grey that reads as a template; depth from
low-alpha shadows and 8–14 % ink hairlines rather than 1px mid-grey borders; a **graphite** primary
button, so the single indigo accent is spent on focus, links, progress and the current page instead of
on every control; small tracked-out uppercase labels against normally-set data with tabular figures;
130–240 ms transitions behind a `prefers-reduced-motion` guard. No external resource of any kind — the
CSP is `script-src 'self'`, and the old files named `Inter` first while shipping no Inter, so it
resolved by luck and four pages could render in different faces on one machine.

**Tables, which was the specific complaint.** The header sticks; the checkbox and the person **pin to
the left**, so scrolling right never leaves a screen of anonymous cells; the wrapper carries scroll
shadows painted `background-attachment: local`, so they appear only on the side still hiding content
and vanish at the end; and below 860px the table becomes **one card per row**, each cell naming itself
from a `data-label` written from the same words as its own header, so a renamed column cannot leave a
stale label behind.

Two latent bugs fell out of the rewrite. `import.css` had carried a literal `</content>` tag, which CSS
error recovery swallows together with the rule that follows it — `.notice.info` had been dead, and the
informational notice on the importer had been rendering unstyled. And ~120 lines of experience and
education card CSS sat in two slightly different copies in `popup.css` and `dashboard.css`, styling
class names no React file has emitted since 3.6.0 removed those fields from the record.

The new CSS was then reviewed against the real JSX from three angles, and nine confirmed collisions
were fixed: the shared `.status` notice primitive painting every Status *cell* in the connections table
as a grey ringed box; `.empty` losing `text-align` and `padding` to `.table-wrap td` on specificity;
the name column's `<th>` missing the class that pins it, so its header scrolled off the column it
names; three specificity inversions where the 860px card-mode resets lost to the pinning rules; the
page files' unguarded `max-height` beating theme's `max-height: none` in card mode; `--pv-ink-3` at
`#78747f` clearing 4.5:1 on pure white by 0.06 and then failing on both `--pv-bg` and the table-header
fill, which is where most of it sits (now `#6e6a77`, which clears it on all three); input rings at
1.3:1 against their own fill, so an empty field was effectively invisible until focused (now a real
`--pv-field-line` at 3.3:1); and a focus ring that changed every control's corner radius on focus.
`.actions-cell` no longer sets `display: flex` on a `<td>`.

`tests/visual-layer.test.js` is new and holds five guards: every class the UI emits has a rule on the
page that loads it, all four pages load one shared layer first, no stylesheet reaches for a remote
resource, no stylesheet contains a stray tag, and a wide table stays navigable.

### Not verified here

Nothing in this release has been run against live LinkedIn (rule 17). In particular, whether the
recruiter's document viewer exposes the file's address in an attribute, in a request the resource
timeline records, or in neither, is a live-DOM question — which is what `logResume()` exists to answer
from the console on the next run.

## 3.7.6 — The section that was there, two resume columns, and coming back to a job

`npm run check` passes here (390 tests: typecheck, build, test, validate).

### Experience, current role and current company were empty on every row

All three are derived from the Experience section and from nothing else — `deriveCurrentPosition`
takes the card marked `Present` and falls back to the first card, and it is never allowed to read the
headline (rule 7). So an empty column does not mean "the applicant has no job": it means **no
experience card was ever read**. Four causes, all of them in how a section is *found*, and each one
silent — a section that is not found produces no warning, only zeros.

- **`^experiences?$` matched the word and nothing else.** `Experience (5)`, `Work experience` and
  `Experience:` all named no section at all. `sectionKeyFor()` now strips an inline count with or
  without brackets and a trailing colon, and `SECTION_PATTERNS` accepts `work`/`professional`/
  `employment`/`career` before Experience, `Educational background`, and `Top skills`.
- **A section's root was bounded by the *next* heading only.** So the ancestor chosen for a heading
  could reach back over the section *above* it — and the page-wide pass refuses exactly that (a root
  swallowing a second section), so the widened search returned nothing for the one section most often
  outside the resolved panel. `sectionRootFor()` is now bounded by **every** other heading, which
  also means the blocks read out of a root can only be that section's.
- **A section whose list items parsed to nothing never reached the text fallback.**
  `if (added || blocks.length) return added` treated "the markup had `li` elements" as "the section
  was read". `readExperience` and `readEducation` now fall through on `added === 0`; the accumulator
  is keyed, so a card reached both ways is stored once.
- **A section title that is not a heading element was invisible.** `sectionLabelsIn()` is the last
  resort: a short leaf whose own text *is* the section name, matched on rendered text and never on a
  class name (rule 11), asked only for the keys nothing else produced, with `textContent` measured
  before layout so the common case costs nothing.

The section map is now built **once per snapshot** and handed to all seven readers, instead of each
one rebuilding it — seven page-wide heading scans per read, dozens of reads per applicant, and seven
chances for two readers to disagree about where a section was.

**And an empty column is now explicable from the page it was read on.** Every extraction records
`diagnostics.sectionScan`: the selector that was targeted, the patterns it was matched against, every
visible heading in the panel *and* on the page with the key each one resolved to (a heading listed
with an empty key is a wording `SECTION_PATTERNS` does not know yet — the whole failure mode in one
line), where each section was found (`panel` / `page` / `panel-label` / `page-label`), its root, its
block count and a text sample, and the sections nothing named. It is logged as one grouped line per
applicant in the hiring page's own console, as a warning when experience is empty or a section is
missing. Built once, after the walk, because it reads `innerText` page-wide.

### The resume is two columns, not five

`resume_file`, `resume_status`, `resume_link`, `resume_viewer`, `resume_saved_as` — five cells
answering one question, and a table nobody can read across. **This is a deliberate removal**, stated
in [applicant-csv.js](../src/applicant-csv.js)'s header, and from here the usual rule resumes: append
columns, never reorder.

- **`resume_link` is where to click.** The document address when the page rendered one, the LinkedIn
  viewer page when that is all there is — because either way the cell means "open the CV".
- **`resume_file` is which file we have.** The saved copy's path under the downloads folder when the
  worker fetched one, falling back to the file name LinkedIn showed.
- Both are exported as `resumeLink()` / `resumeFile()`, so the table cell and the CSV cell are the
  same rule. Neither invents anything: an applicant with no resume exports two empty cells.
- **Every record field is kept.** `downloadStatus` is what stops the same file being downloaded twice
  and is what the page's resume filter reads; `viewerUrl` and `localReference` are what the two
  columns are built out of; and `url` is still only ever a document (`isResumeDocumentUrl` refuses a
  linkedin.com address first, and the worker refuses to fetch one). The details drawer shows all
  three, and gained the saved path it never showed.

### Coming back to a job starts its run again

A navigation destroys the content script and with it the run, the state, and everything it had been
asked to do — so returning to a job's Applicants page left the surface idle until the recruiter went
and pressed the button again. The **worker** is the only thing that outlives a navigation, so it now
holds the standing instruction (`PV_APPLICANT_AUTO_RUN`).

- **Only a job the recruiter started a run on**, with the options they started it with, so
  `Re-collect already saved` is honoured on the restart too. Collecting a *single* applicant arms
  nothing. An entry expires after twelve hours, so a job collected last week does not restart itself
  because the page was opened.
- **A Stop a navigation could undo is not a Stop** (rule 13a). Both Stops — the universal one and the
  page's own — call `disarmAutoRuns()` before anything else that can fail, and the content script
  latches `autoRun.disabled` so an arrival already in flight cannot start after one. `Clear
  Applicants` disarms as well, because there is then nothing to come back to.
- **An arrival is a change of *job*, never of URL.** Opening a row is how a run advances and every one
  of those changes the address bar, so keying on the URL would restart the run on every row it
  opened. Both routes are watched: the 800 ms poller for the SPA, and one check at injection, because
  a full page load leaves no history to compare against.
- It waits for the list to actually have rows, refuses to start on a hidden tab and defers to
  `visibilitychange` instead (rule 12a), never starts on top of a run in flight, and **adds no
  click** — it replays `extractAllApplicants`, which builds a fresh run state and walks from the first
  row rather than picking up a stale index. The applicants page states the behaviour above the
  toolbar, because it is the one thing that happens without a button being pressed.

Version and build id `2026-08-02-react-v3.7.6` in all five places plus the manifest and
[package.json](../package.json).

## 3.7.5 — An applicant command takes you to the page

`npm run check` passes here (387 tests: typecheck, build, test, validate).

**Activating a tab is not showing it to anyone.** Both applicant commands are pressed from the
extension's own Applicants page — a different tab, usually in a different window. `Tabs.activate()`
deliberately does not focus the window, which is correct for the heartbeat-driven import run and wrong
here: the hiring tab became active somewhere the recruiter could not see, so from their side the
button did nothing and they still had to go and find the page by hand.

- `activate(tabId, { focusWindow })` is new, and defaults to the old behaviour. `revealApplicantTab()`
  passes `true`. That makes exactly **two** places allowed to take focus, both of them a direct user
  command: the sign-in page, and an applicant command's hiring tab. Everything driven by the heartbeat
  still activates without focusing — stealing focus from whatever the user is typing into is worse
  than a background run taking longer. Rule 12c names this.
- **With no hiring tab open at all, one is opened** at the last hiring page the extension was actually
  on, in the window the command came from — `rememberOrigin(sender)` runs first, exactly as the import
  workflow's step 1 does. Through 3.7.4 this raised "Open your job's Applicants page, then try again"
  and left the recruiter to set it up themselves.
- **Only a remembered address is ever used.** `rememberHiringUrl()` accepts a resolved hiring tab's URL
  or a collected record's `extraction.sourceUrl`, and nothing else. Welding a job id into a guessed
  path would be the same class of mistake as guessing a resume link, so with nothing remembered it
  still says so — and says that the next press will work.
- `KEYS.APPLICANT_TAB` tracks the tab so a second command **reuses** it rather than opening another,
  and a tab already on the applicants page is never navigated (that would throw away the list LinkedIn
  has rendered, exactly as for Connections). It is deliberately **not** a collector tab:
  `closeCollectorTabs()` never touches it, because it is the recruiter's own working page.

## 3.7.4 — Read the whole panel however it scrolls, and carry the resume in full

Reported straight after 3.7.3: current role, current company and the resume file were still empty on
every row. 3.7.3 fixed the scroll *target*; this fixes the two things that were wrong underneath it,
and stops depending on getting the target right at all. `npm run check` passes here (383 tests:
typecheck, build, test, validate).

### The bottom of the panel is now reached without knowing which container scrolls

Every position-based walk in this codebase depends on having correctly identified the one container
that scrolls, and getting it wrong is **silent**: the walk runs, the position never moves, the first
read is already "the bottom", and one screenful is saved as the whole applicant. On the hiring surface
that container is a column whose markup differs per account, so the identification is a guess.

**`revealPanelContent()`** does not need to guess. It drags the bottom of the panel into view with
`scrollIntoView`, which scrolls **every** scrollable ancestor the element needs — so a column this
code failed to recognise still moves, and so does a nested one. It repeats until the panel stops
growing, bounded by `REVEAL_MAX_PASSES` and by the same "growth means new content, never a scroll that
happened" rule discovery uses, and it is stoppable at every pass. The page's own scroll position is
now remembered and restored alongside the column's, because `scrollIntoView` can move it too.

### A section outside the resolved panel is still the open applicant's

`applicantPanel()` picks the *smallest* container carrying the most section headings — and a heading
that has not hydrated yet does not count. So a panel resolved early can be a **sub-container of the
real detail column**, and Experience, Education and Skills were then invisible for the whole
extraction. That is precisely why `current_role` and `current_company` were empty on every row:
`deriveCurrentPosition` already falls back to the first entry, so an empty column meant no experience
had been read at all.

`buildSectionMap()` now falls back to a page-wide search for any section the panel did not hold.
Nothing else on a hiring page renders an Experience or Education heading, so this cannot pick up
another member's card — and the widening still refuses any heading or root inside the applicant list,
and any root that swallows a second section, because a wrong entry is worse than an empty one
(rule 6).

### The resume document is found wherever the viewer rendered it

`findResumeDocumentUrl()` looked at four tag shapes and decided with a **local** extension regex, so a
viewer handing its document to a plugin through `data-source-url`, or a media host with no extension
in the path, produced nothing — every applicant came back `link_only` with no file and no link.

It now searches `DOCUMENT_URL_ATTRIBUTES` across the viewer, the panel and the page in that order, and
decides with **`Applicants.isResumeDocumentUrl()`** — the same tested rule the record uses, which
refuses a `linkedin.com` page address *first*. So the wider search still cannot return a route, which
was the 3.7.1 defect. The document URL is now **waited for** over the full overlay timeout rather than
sampled for three seconds on the frame the viewer appeared; the viewer mounts its shell before it
fetches the file.

`localReference` is now the file's actual path under the downloads folder rather than Chrome's
download id, which told the recruiter nothing about which file on disk is whose.

### The resume is five columns, in the table and the CSV

`resume_file`, `resume_status`, `resume_link` (the document), `resume_viewer` (the LinkedIn page that
displays it) and `resume_saved_as` (the copy on disk). The table's single resume-link cell used to
show whichever of the two links existed, so the viewer link disappeared the moment a file was found
and the file link was never visible next to it.

`resume_viewer` and `resume_saved_as` were moved **up** from the detail block into
`APPLICANT_TABLE_COLUMNS`. That is a **deliberate reorder** of the applicant export, stated as one in
[applicant-csv.js](../src/applicant-csv.js), and the only one planned: "did we get the CV" and "where do
I click to read it" are different questions, and the answer to the second exists on almost every
applicant even when the first is empty. From here the usual rule applies again — append columns, never
reorder.

## 3.7.3 — The applicant collector read one screenful, could not be restarted, and always began again

`npm run check` passes here (380 tests: typecheck, build, test, validate). All three of these were
reported from a live recruiter account running 3.7.2, and all three are the standing phase-30 warning
doing its job: 3.7.2's 364-test suite passed while every one of them was happening.

### It only collected what was already on screen

The applicant detail panel and the applicant list are each an **independently scrolling column** on
the hiring surface, inside a page that scrolls almost nothing — the global nav and the job header.
`Connections.chooseScrollTarget()` is tuned for the opposite arrangement: on the connections list the
document *is* the scroller and the tallest inner container is a filter panel, so it scores
`isScrollingElement` at **+60** and *penalises* depth.

So the moment the hiring page had any range at all, the page won. The run scrolled the page, the
column never moved, `maxPosition` was reached on the first read, and the scan settled having seen one
screenful. That is both symptoms at once: an applicant saved with no Experience section because it
sits below the fold, and a run over a 665-applicant list that produced a handful of rows.

- **`Applicants.chooseColumnScrollTarget()`** is the mirror image and is consulted first. It refuses
  the page outright, requires real range and an overflow that actually scrolls, requires the candidate
  to carry the content being read, and prefers the **innermost** such container — because an outer
  qualifying container here is the page shell. When no column qualifies it returns `null` and the
  adapter falls back to the tested general chooser, which is what handles a layout where the page
  really is the scroller.
- **`scrollCandidates()` now offers descendants too.** Which side of the scroller `applicantPanel()`
  lands on is markup's choice: resolve to a content wrapper and the scroller is an ancestor, resolve
  to the column shell and it is a descendant. Only a descendant carrying at least 60 % of the panel's
  text qualifies, so a filter or a menu that scrolls a fraction of it is refused — the same rule the
  connections chooser applies when it demands the container hold the list.
- **`maxScrollPosition()` reads `clientHeight` live.** `scrollHeight` always was; mixing it against a
  height remembered from before the column had mounted produced a bottom that arrived early.
- **The panel is re-resolved on every step** (`livePanel()`). The hiring surface re-mounts the detail
  column as sections hydrate, and a detached node keeps answering `innerText` with what it held when
  it was unmounted — so a scan holding one reference re-read its first screenful and settled on it.
  The scroll target is re-chosen after the first paint for the same reason.
- **The expander runs again at the bottom.** A section below the fold does not exist during the first
  pass, so a control collapsing it could never be found. Both passes share one
  `createExpansionBudget()`, so it is still eight clicks in total and the click budget is unchanged.

### Pressing Collect Every Applicant again did nothing until the page was reloaded

`state.wentHidden` is latched by the `visibilitychange` listener the instant the recruiter switches
tab — which is exactly how they reach the extension's own Applicants page — and it was only ever
cleared several steps inside `extractApplicant`. `extractAllApplicants` reset the stop flag and
nothing else, went straight into `loadEveryApplicantRow`, hit `assertRunnable()` and threw "the
applicants page is hidden" before reading a single row. Every later press did the same. The only
thing that cleared the latch was reloading the page, because that re-injects the content script with
a fresh `state` — which is precisely the workaround that was being used.

- **`beginRun()`** clears the stop flag *and* re-derives the hidden flag from what the page actually
  is right now. Both the single-applicant and whole-list entry points call it.
- **The hiring tab is activated before either command** (`revealApplicantTab()` → `Tabs.activate`).
  The button is pressed on a *different tab*, so the hiring tab is hidden the moment it is clicked
  and LinkedIn stops rendering it — rule 12a, and rule 12 keeps the tab decision in the controller
  rather than in the worker.
- A second press while a run is genuinely in flight is answered at once with `alreadyRunning` rather
  than left hanging on the first run's promise for up to an hour.

### A restarted run began again at the first applicant

The loop walked the rows from index 0 and asked nothing about what was already saved, so a run
stopped half way collected everybody a second time.

- **`Applicants.isCollectedApplicant()`** — one substantive field (a way to reach them, a verdict, a
  history, or a resume). Deliberately not "a record exists": a row saved with nothing but a name is a
  run that *failed* on that applicant, and skipping it would make the failure permanent.
- **`Applicants.createCollectedIndex()`** is keyed on the `applicationId` in the row's own href,
  because that is the only identifier a row carries **before** it is opened — the record's own id
  needs the profile URL, which only the panel shows, so keying on it would mean opening every
  applicant to discover it could be skipped. The name is a stand-in only for a row carrying no id.
  Scoped to the job, because an applicant is a person *on a job*.
- **`PV_APPLICANT_COLLECTED`** returns one lean entry per stored applicant with the verdict already
  made by the core, rather than a whole job's records over the message channel.
- The run walks past those rows **without opening them**, and adds each one it collects to the index
  so a virtualized list rendering the same row twice is not collected twice. A worker that cannot
  answer skips **nobody**, never everybody.
- The Applicants page gained a **Re-collect already saved** checkbox, which passes `recollect: true`
  and asks for the whole list again on purpose.

### What did not change

The click budget: `applicants.js` still contains exactly five `.click()` calls — four gated opens and
one shared dismiss — and the second expander pass shares the same eight-click budget as the first.
No new permission, no new host, no new control on the denylist's side of the line.

## 3.7.2 — Three defects found in a live run

`npm run check` passes here (373 tests: typecheck, build, test, validate). All three of these were
found by running 3.7.1 against a real recruiter account — which is exactly what the standing
"phase 30 is still open" warning says fixtures cannot do.

### Every applicant was saved with the name "Applicants"

Three separate causes, all fixed.

`applicantPanel()` scores containers by how many applicant sections they hold, and a wrapper around
**both** columns satisfies that — so it won, and it contained the applicant list. `readApplicantHeader`
then took the first line of that container's text as the name. The first line of a container holding
the list is the list's own heading. Every record came back named `Applicants`, or blank.

- The panel now **refuses any candidate holding more than one applicant-row link**. One is fine — the
  panel legitimately links to the application it is showing; two or more is a list. Its fallback is
  the widest non-list `main`, not `document.body`, which always contains the list.
- **The name is now chosen by policy.** `findApplicantName()` offers the selected list row (matched on
  the `applicationId` in the address bar), the profile link, the portrait alt, non-section headings,
  and the panel's first line *last of all*. `isApplicantNameCandidate()` refuses page chrome,
  addresses, counts and sentences outright.
- **The platform arbitrates.** LinkedIn writes every verdict as a sentence about the applicant —
  "Mahak Ayani answered 'Yes' …", "Mahak Ayani has 3 years …" — so the words those sentences share at
  the front are the name, stated in prose where no markup change can move it.
  `nameFromExplanations()` extracts it and `chooseApplicantName()` lets it win.
- `addName` is now the one header field a later, **corroborated** read may replace, and `snapshotPanel`
  reads qualifications before the header so the arbiter exists on the very first snapshot.

### Every applicant after the first was collected from the wrong panel

`selectApplicantRow()` clicked the next row, waited for `location.href` to change, then waited for the
DOM to go quiet. Neither means the panel has re-rendered: LinkedIn routes without a navigation, and
the DOM is briefly quiet *between* tearing the old applicant down and mounting the new one. So the
scan ran against the previous applicant's panel or an empty one — which is why every row after the
first had no role and no company.

It now waits on a `panelIdentity()` fingerprint change, and **a row that never opens is skipped rather
than scanned** — scanning anyway saved the previous applicant a second time under this row's identity.

### The resume link opened the applicants page, and the worker saved that page as a CV

The resume control's `href` on this surface is a route — `linkedin.com/hiring/applicants/…` — not the
document. It was stored as `resume.url`, so "Open resume" reopened the applicants page. Worse, the
worker's host check passed it, because the host genuinely *is* LinkedIn: `chrome.downloads` fetched
the HTML page, saved it under a `.pdf`-shaped name, and the record reported `downloaded`.

- `isResumeDocumentUrl()` now decides what a file is: a document extension, a `licdn.com` address, or
  a `/dms/`-style storage path — and a `linkedin.com/hiring|talent|in|jobs|…` address is refused
  **first**, exactly as `looksLikeCvLink` refuses a linkedin.com address before considering anything
  else.
- The record splits them: **`resume.url` is the document, `resume.viewerUrl` is the page that displays
  it**, and `normalizeApplicantRecord` moves a page arriving on `url` across to `viewerUrl` — defence
  in depth for records already stored with the wrong one.
- The worker refuses a page route with `refused-page-not-a-document`, before anything is fetched.
- The table's link now reads **Open file** or **View on LinkedIn** depending on which it has, and the
  CSV gained a `resume_viewer` column so the two can never be conflated again.

## 3.7.1 — Both contact details, the resume actually opened, and an export built around the applicant

`npm run check` passes here (364 tests: typecheck, build, test, validate).
**Phase 30 (live browser verification) is still open** — see [CHECKS.md](CHECKS.md).

### Contact info is opened every time, and everything in it is taken

Two rules were in the way of collecting the phone number that is plainly on screen next to the
address, and both are gone.

**The overlay was skipped whenever the page had already shown something.** `Contact info` was clicked
only when the rendered page "did not already yield both an email and a phone number", so a profile
whose About showed an address never had its overlay opened — and the number sitting in that overlay
was never collected. The same `already-visible` skip was on the applicant disclosure. Both are
removed: the overlay is opened once per profile and once per applicant, **always**. The accumulator is
merge-only, so opening it when something was already found can only ever add.

**A recognised heading was required inside the panel.** `parseContactPanel` gained `trusted`: a panel
**this extension opened itself**, on the person being collected, yields **every** address and number
it shows, labelled or not. Such a panel is that person's own contact card by construction — there is
no Interests block inside it and no other member's card, which is the entire reason the labelled rule
exists. Requiring a heading `CONTACT_FIELD_LABELS` recognised meant any locale or markup revision
silently lost the number.

**The relaxation is scoped to that one element.** The rendered page still needs a `tel:` link or a
labelled field; `extractPhones`' scrubbing and every `normalizePhone` rejection still apply inside a
trusted panel. A test proves the vanity-URL member id, a follower count and a date range are still
refused in there, so neither 3.6.0 defect can come back through this door.

### The resume is opened, scrolled and read — not just linked

`collectResume` clicked the control only when it carried no `href`. On this surface the `href` is
usually a route rather than the document, and the applicant's real file name exists **only** inside
the viewer — LinkedIn's document URLs are opaque media ids with no name in them. So the viewer is now
opened every time, `scrollResumeViewer` walks it to the bottom because a PDF viewer renders its pages
as lazily as a profile does, and `readResumeViewerDetails` reads the file name, the file type and the
page count from the viewer's own chrome. The viewer's name beats one derived from the URL; neither is
guessed, and a viewer that opens but never exposes a document URL now records the name it *did* show
as `link_only` rather than losing it. `resume.pages` joined the record, `null` when the viewer said
nothing.

### The applicant list is loaded before a run over it starts

`Collect Every Applicant` read the list once. The list is virtualized, so that gave a screenful —
about ten rows of a job advertising 665 — and the run would have collected ten people and reported
itself complete. `loadEveryApplicantRow()` now scrolls it to the bottom first, using discovery's own
stop rule: growth means **new rows** and never a scroll that happened, three quiet passes, a 200-pass
ceiling, a DOM-quiet wait for the network slice, Stop honoured, and the scroll position restored.

### The export is built around the applicant

`APPLICANT_TABLE_COLUMNS` is now, in order:

```
applicant_name, email, mobile, resume_file, resume_status, resume_link,
current_role, current_company, total_experience,
must_have_met, preferred_met, application_status, collected_at
```

The person first, then both ways to reach them, then the resume in three columns of its own — the
file, where it came from, and whether it was saved. **`job_title` and the applicant's `location` were
dropped as columns**: the job is a filter on the page rather than a column on every row, and the
location is detail. Both still appear in the details drawer, and `job_id` stays in the detail columns
so the association is kept.

`all_emails` and `all_phone_numbers` were added, exporting **every** value rather than only the
primary two, with each number marked as text **per entry** — a cell-level marker protects only the
first line, and the second number would lose its leading zero.

### Fixed: total experience was always empty

`totalExperienceFrom` handed `calculateTotalExperience` a `{ dates }` object. That function reads
`dateRange` and `title`, so every range was skipped and the column was blank on every record. It now
passes the right shape — and `normalizeDateRange()` restores the separator in the applicant card's
spaceless `2026-Present`, which `parseDateRange` deliberately refuses to split (that guard is what
stops `3-5 years` being read as a range). The stored `dateRange` keeps LinkedIn's own wording; only
the lookup is normalized, and only a hyphen following a four-digit year is touched.

### Not removed, and why

Three restrictions stay, because they are not preferences:

- **No credential handling.** `Sign in to LinkedIn` still only navigates to LinkedIn's own sign-in
  page; nothing reads a password, a cookie, or `document.cookie`.
- **Pause on a challenge.** A CAPTCHA, checkpoint or restriction still stops the run for a human.
- **The outreach denylist.** Message, Connect, InMail, Send, Share, Shortlist, Move to, Reject,
  Interview, Rate and Add note stay permanently unclickable. Every control the extension *does* click
  reveals something already addressed to this user; those would act on somebody else's behalf.

## 3.7.0 — The recruiter applicant collector, its CSV, and a Stop that always works

`npm run check` passes here (357 tests: typecheck, build, test, validate).
**Phase 30 (live browser verification) is still open** — nothing below has been run against live
LinkedIn from here. Passing fixtures and unit tests do not prove live correctness, and the hiring
surface has never been seen by this code outside the two screenshots it was written against.

### A third surface

`linkedin.com/hiring/*` and `/talent/*` — the applicants on a recruiter's own job. It is a **separate
surface with a separate record and a separate store**, and it shares nothing with the connections
import except the cores. It opens no tab and navigates nowhere: it reads the job and applicant the
recruiter already has open, in the tab they already have open.

**What a record holds.** The job (title, id, company, location, description, applicant count, plus its
must-have and preferred requirements and its screening questions with their ideal answers), the
applicant (name, profile URL, headline, location, current role and company, total experience, applied
and contacted dates, application status), their contact details, their resume, their full employment
history and education, their skills, their screening answers, and the platform's own qualification
verdicts. `extraction.rawData` keeps the verbatim text each section was parsed from, so a LinkedIn
layout change is diagnosable from the exported record rather than only from a live page.

**An absent value is `null`.** Not `""`, and never a guess. A qualification LinkedIn says it "cannot
provide or evaluate" is recorded `unknown` and never as a miss. A job description the applicants view
does not render is `null` and is never assembled out of the applicant panel. A resume the account
cannot see is `available: false, downloadStatus: "unavailable"` and is never a guessed link.
`currentRole` and `currentCompany` come from the experience card marked `Present`, **never from the
headline** — the reference profile's headline reads "HR Head | Talent Acquisition | Employer Branding
| …" and names no employer at all.

**Four new gated controls, and the discipline was not loosened.** Rule 9 read "exactly three
clickable controls exist, and no others may ever be added" through 3.6.0. It now names the controls
**per surface**, and every one of the four new ones goes through
`classifyApplicantControl({ purpose, inContainer })`: an allowlist per purpose, a denylist consulted
first, and the caller having to *prove* the element was enumerated from inside the container it claims
to belong to. The four are the applicant's contact disclosure, their resume (only when it carries no
href to read directly), a collapsed section's own expander (capped at 8, and one that reveals nothing
is retired), and a row of the applicant list. The hiring denylist adds **Shortlist, Move to, Reject,
Archive, Hire, Offer, Interview, Schedule, Rate, Good fit / Maybe / Not a fit and Add note** — those
change the recruiter's own ATS — on top of the permanent one. "Message · Contact info" is refused,
including when only the `aria-label` says it. Tests assert the click budget per file: `content.js` 3,
`connections.js` 1, `applicants.js` 5.

**Resumes are fetched by the service worker**, because a content script has no `chrome.downloads`.
Three refusals before anything is fetched: a host that is not `linkedin.com`/`licdn.com`, a URL any
stored record already reports as `downloaded`, and a URL the page never rendered. Files land in
`profile-vault-resumes/` with `saveAs: false` and `conflictAction: "uniquify"` — a 600-applicant run
must not ask 600 questions or overwrite 600 files.

**Each applicant is saved as it finishes**, streamed to the worker with `PV_APPLICANT_SAVE`, so a run
the recruiter walks away from or stops keeps everything already collected. The save is a merge, so a
second visit enriches the record rather than replacing it, and a resume already downloaded keeps its
filename and its status.

### The applicant CSV

A new column set, and one shared implementation of everything that makes a CSV open correctly.
`csv.js` now exports `neutralizeFormula`, `serializeValue`, `escapeCell`, `buildCsvFile` and
`downloadCsvText`; `applicant-csv.js` imports them rather than copying them, so the UTF-8 BOM, CRLF
endings, quoted cells, formula neutralization and the leading-apostrophe text guard on mobile are
identical across both exports and a fix to one fixes both.

`APPLICANT_CSV_COLUMNS` leads with `APPLICANT_TABLE_COLUMNS` — the applicants table, column for column
— and a test holds the exported list and the rendered `<thead>` in step:
`job_title, applicant_name, email, mobile, location, current_role, current_company, total_experience,
must_have_met, preferred_met, resume, application_status, collected_at`. The structured detail
follows, one value per line inside its cell: qualifications print as
`matched · <requirement> — <explanation> [screening_response]`, screening answers as
`<question> · ideal: Yes · answered: Yes · met`, experience as
`HR Manager — Naad Wellness (2026-Present) [verified]`. A sparse record still exports a full row, and
nothing ever leaks `null`, `undefined` or `[object Object]` into a cell. From here the usual rule
applies: **append columns, never reorder them.**

### A Stop that always works

`Stop Everything` is rendered in the popup **unconditionally** — full width, above every panel,
disabled only while a stop is itself in flight. The previous Stop appeared only when the extension had
already noticed it was busy (`{running || cooling || discovering ? … }`), which is exactly the Stop a
user cannot find when they need it; a test now forbids that guard returning.

`STOP_ALL` is matched **before every other branch** in the service worker, so it is never queued
behind the work it is trying to end. It bumps the generation token (ending a pass already running, not
merely its next iteration), broadcasts `PV_STOP_ALL` to every LinkedIn tab, stops the queue session,
clears the heartbeat and closes the collector tabs. All three content scripts now check their abort
flag **inside their walking loops, before each step** rather than between items, and each reports a
stop as an *interruption*: `stopped: true` with `atBottom: false`, never a failed record and never a
finished list. **Stop ends work; it never discards what that work produced** — a test asserts it calls
no `clearProfiles`, `clearApplicants`, `clearQueue` or `deleteProfile`.

### Storage

IndexedDB goes to **v5**, adding `applicants` (keyPath `id`, indexed by `job.id`, `updatedAt` and
`applicant.applicationStatus`) and `jobs` (keyPath `id`). The database name is unchanged and **v5
deletes nothing** — a test asserts it calls no `deleteObjectStore` — so rolling 3.7.0 back costs
applicants and not one saved profile or queue row.

### Also

New page `applicants.html` + `applicants.css` + `src/react/applicants-dashboard.tsx`: search,
job/status/resume filters, 25/50 pagination, per-row selection, Download CSV and Download Selected,
and a details drawer holding the full verdicts, the screening answers and the extraction warnings.
Reachable from the popup ("Job Applicants") and from the Saved Profiles page ("Open Job Applicants").
Version and build id `2026-08-02-react-v3.7.0` in all five places plus the manifest and
`package.json`. No new permission was requested: the surface is covered by the existing LinkedIn host
permissions and the existing `downloads` permission.

## 3.6.0 — Contact provenance, open-to-work, and a record cut down to the table

`npm run check` passes here (313 tests: typecheck, build, test, validate).
**Phase 30 (live browser verification) is still open** — nothing below has been run against live
LinkedIn from here. Passing fixtures and unit tests do not prove live correctness.

### Two live defects, both from taking a value without asking where it came from

**A vanity URL's member id was being saved as a mobile number.** Every LinkedIn profile address ends
in the member's numeric id, and that id sits squarely inside the 7–15 digit window a phone number
occupies, so `linkedin.com/in/paarth-khandelwal-264954380` handed `264954380` straight to
`PHONE_PATTERN`. `extractPhones()` now deletes addresses, URLs and word-welded identifiers from the
text *before* any number is looked for, and `normalizePhone()` refuses anything containing a path, an
`@`, a host, or digits welded to a word.

**The Interests block put a stranger on the record.** "Interests" renders Top Voices — other members,
with their own addresses and phone numbers in plain text — and the whole-page sweep collected them.
There is no whole-page sweep any more.

### Provenance is now required

- `scanLabelledContacts()` walks the text keeping one open field. An Email or Phone label opens it;
  **any other** contact label (`Your Profile`, `Website`, `Address`, `Birthday`, …) closes it. Only
  lines under an open field are parsed, and unlabelled running text yields nothing.
- The rendered page is scanned with `allow: ["email"]`. A phone number now comes only from a `tel:`
  link or the Contact info overlay.
- `contactLinksIn()` rejects any link inside a foreign section (Interests, Top Voices, People also
  viewed, Recommendations, …) **or** inside a card that links to a different member — a structural
  test, so it holds in any language.

### Cleaning what was already saved

- `normalizeProfile` drops a stored phone whose digits appear inside the record's own profile URL, so
  the corrected value shows the moment the table is opened. `repairStoredProfiles()` persists it.
- **Clean shared contacts** (Saved Profiles toolbar) finds every address or number that appears on
  three or more different people — contamination from a block that renders other members — shows
  them, and removes them on confirmation.

### The record is now exactly the table

`name, email, mobile, cv, open to work, education, skills, profile url, status, last collected,
notes, tags`. **Removed:** `experience`, `yearsOfExperience`, `currentRole`, `currentCompany`,
`currentEmploymentDates`, `totalExperience`, `websites`, `profileImageUrl`. They are no longer
extracted, stored, exported or editable, and they are **not recoverable** — export before upgrading.
Experience is still read during the scan, because a late Experience section is real page change the
quiet count must see; it is simply not stored.

**Added:** `openToWorkDetails`, `cvFileName`, `cvAvailable`, `status`, `lastCollectedAt`.

- **Open to work** — a third and last gated control. `findOpenToWorkCard()` finds the card, and its
  own `Show details` has to be proven inside it before `classifyOpenToWorkControl()` will allow the
  click. The panel is polled until it settles, then read into `Job titles`, `Locations`,
  `Workplace types`, `Employment types` and `Availability`, and dismissed.
- **Education** is now institution names only, deduplicated, in visible order.
- **Skills** additionally reject a bare count, a section heading, and the accessibility duplicate
  LinkedIn welds together (`DockerDocker` → `Docker`).
- **CV** stores the derived file name and availability. A hosted CV page has no file name and one is
  never guessed.

### CSV

Replaced again, and now the table column for column:
`name,email,mobile,cv_url,open_to_work,education,skills,profile_url,status,last_collected,notes,tags`,
followed by `all_emails`, `all_phone_numbers`, `cv_file_name`, `cv_links`, `source`, `collected_at`.
`mobile` and `all_phone_numbers` export as text so a spreadsheet keeps a leading zero. Formula
neutralization now also covers a leading TAB and CR. An object can never reach a cell — no
`[object Object]`. `full_name`, `all_emails` and `all_phone_numbers` are accepted as aliases on
import, so a 3.5.0 export still imports.

### Storage

IndexedDB moves to **v4**: `status` and `lastCollectedAt` are indexed, and the `currentCompany` and
`location` indexes are deleted. Rows migrate lazily through `normalizeProfile` and are written back
by `repairStoredProfiles()` when the Saved Profiles page mounts.

### Removed

`src/react/components/ExperienceCards.tsx` and `EducationCards.tsx`, and the `groupExperienceEntries`
/ `parseExperienceCompanyBlock` helpers in `profile-utils.js` — nothing renders or stores what they
formatted.

## 3.5.0 — Two-tab collector workflow, CV/contact-led records

`npm run check` passes here (269 tests: typecheck, build, test, validate).
**Phase 30 (live browser verification) is still open** — nothing below has been run against live
LinkedIn from here. Passing fixtures and unit tests do not prove live correctness.

### The tab workflow (replaces the dedicated collector window)

The run now uses **two reused tabs of the user's own window** instead of one tab in a separate
window. `Start Full Collection`:

1. remembers the window and extension tab it was clicked from;
2. opens or reuses **one** LinkedIn Connections tab in that same window and **activates** it;
3. scrolls and collects the whole connection list incrementally;
4. stops on stable bottom + reconciliation;
5. **automatically** opens or reuses **one** profile collector tab in the same window and activates it;
6. navigates **that same tab** to each queued profile, one at a time;
7. keeps it open and active until the queue finishes;
8. pauses instead of saving whenever that tab stops being visible, and resumes when it comes back;
9. on completion closes both collector tabs and opens/activates the Saved Profiles table.

**Never a tab per profile.** All tab handling moved into the new pure
`src/collector-tabs-core.js`, which takes `chrome.tabs`/`chrome.windows`/`chrome.storage` by
injection so the whole policy is tested against a fake Chrome in `tests/collector-tabs.test.js`.
`chrome.tabs.create` and `chrome.windows.create` no longer appear in the service worker at all.

### State machine

`COLLECTION_STATE` was rewritten to the specified states: `opening_connections`,
`discovering_connections`, `connections_complete`, `opening_profile_collector`, `extracting_profile`,
`saving_profile`, `moving_to_next_profile`, `paused_hidden`, `paused_challenge`, `completed`,
`completed_with_gap`, `failed` (plus `idle` and `stopped`). The discovery→extraction hand-over is
automatic: **no Stop followed by Start Extraction**. `resumeCollectionState` records which half of the
run a hidden pause interrupted, so it resumes into the right one.

### What a record now holds

Led by reachability: **CV, name, email, mobile, skills, education, years of experience.**

- New: `cvUrl`/`cvLinks`, `email`/`emails`, `mobile`/`phones`, `yearsOfExperience`, `websites`.
- **Removed: `headline`, `location`, `about`, `certifications`, `languages`, `contactInfo`** — from
  the schema, the CSV, and the UI. ⚠️ A profile saved by an earlier version **loses those values**
  the next time it is written, and a CSV exported by 3.4.0 or earlier no longer round-trips them.
- CSV columns were **replaced**, not appended: 24 columns led by `cv_url`. `full_name`,
  `profile_url`, `source` and `collected_at` keep their labels, so the import guard still works.
- `schemaVersion` is now `4`. The IndexedDB name is unchanged.

### `Contact info` is now clickable — a deliberate amendment to rule 9

Contact details are read for free from whatever LinkedIn already renders. **Only when the page
yielded neither an email nor a phone number** does extraction open the member's own `Contact info`
overlay, read it, and dismiss it with Escape. It is clicked at most once per profile, after the lazy
scan has settled, so it can never disturb the scroll walk. Everything else — Connect, Follow,
Message, InMail, Endorse, Remove connection, Withdraw, Invite, Report, Block, Send, Share, Accept,
Ignore, Save — stays permanently forbidden, and the denylist still beats both allowlists. A test
asserts `content.js` contains exactly two `.click()` calls.

The extension still never handles a credential: no `document.cookie`, no `chrome.cookies`, no
password field, asserted across all four scripts.

### Parsing guards worth naming

- `normalizePhone()` refuses date ranges (`2019 - 2023`), repeated-digit placeholders, and anything
  outside 7–15 digits, so a duration can never be saved as somebody's mobile number.
- Two renderings of one number (`9876543210` and `+91 98765 43210`) merge, keeping the fuller form.
- `looksLikeCvLink()` accepts a CV by label, URL, file type, or document host, and rejects ordinary
  websites and LinkedIn URLs.
- `calculateExperienceYears()` returns `""` rather than `0` when no role carried a parseable range.

### Tests

- New `tests/collector-tabs.test.js` (20 tests) covers all eight required tab behaviours.
- New `tests/contact-extraction.test.js` (28 tests) covers contact/CV policy and the new schema.
- Existing suites updated for the renamed states, the amended control policy, and the new fields.

## 3.4.0 — Foreground collector, deterministic state machine, parser field boundaries

Fixes the ten problems observed live in 3.3.0. `npm run check` passes here (222 tests).
**Phase 30 (live browser verification) is still open** — nothing below has been run against live
LinkedIn from here.

### Root causes

1. **Collection only worked while the collector tab was visible.** Nothing in the codebase ever read
   `document.visibilityState`. Chrome throttles a background tab and LinkedIn does not render a
   hidden page at all, so the DOM froze — and *every* completion signal is "the page stopped
   changing". A hidden page therefore read as *finished*, both for discovery and for a profile scan.
2. **67 reported, 66 saved, and the run never ended.** `applyDiscoveryPass()` confirmed coverage with
   `discovered >= totalCount`, counting only URLs that parsed. The 67th connection is a restricted
   member whose card renders with no profile link, so 67 was unreachable and discovery kept hunting.
3. **Discovery ran forever.** Two independent unbounded loops: `grew` counted a *pagination click* as
   growth, so an allowlisted control that revealed nothing reset the quiet counter on every pass; and
   the drain loop in `runLoop()` did `await delay(2000); continue;` whenever a pass reported neither
   growth nor exhaustion — with no counter, no budget, and no exit.
4. **No automatic hand-off to extraction, 5. only worked after Stop then Start.** Both were
   consequences of (3): `startCollectingWorkflow()` awaited `runDiscovery()`, which never returned.
   Stop aborted it, and the queue was then already populated, so a manual start worked.
6. **Profiles saved before their lazy sections loaded.** Same root cause as (1).
7. **and 8. Role, company, duration, employment type and skills were mixed together.** LinkedIn's
   entity `innerText` collapses sibling metadata spans into one line when the separator span does not
   render, producing `"TechMatrix Consulting 9 mos"`. Nothing stripped that, `"Full-time"` was a legal
   company name, and skills were read from each card's whole container text — which includes the
   `Endorse` button and the role the skill was used in.

### Added

- **Foreground collector.** `prepareCollectorStep()` makes the collector tab active and un-minimizes
  its window before every discovery pass and every profile. Both content scripts now check
  `document.visibilityState`, listen for `visibilitychange`, and abort with `hidden: true` (and
  `atBottom: false`) instead of concluding anything. The worker pauses with `paused_visibility`,
  saves nothing partial, and resumes by itself on the next heartbeat once the page is renderable.
- **Deterministic state machine** (`COLLECTION_STATE` in [import-queue-core.js](../src/import-queue-core.js)):
  idle → navigating_to_connections → discovering → reconciling → ready_to_extract → extracting →
  completed / completed_with_gap, plus paused_visibility, paused_challenge, stopped and failed.
  `transitionCollection()` refuses illegal and repeat moves, so a service-worker wake-up cannot start
  a second discovery or a second extractor. The worker only acts when it wins the transition.
- **Terminal `completed_with_gap`.** Coverage now settles against `unique URLs + cards with no usable
  URL`, so 66 + 1 accounts for all 67 and discovery stops. `gap` records the exact unresolved
  difference and the importer page shows it.
- **Bounded discovery.** `MAX_FRUITLESS_PAGINATION` (3) retires a control that keeps revealing
  nothing; `MAX_FRUITLESS_DISCOVERY` (3) bounds the drain loop; a pagination click is no longer
  counted as growth.
- **Parser field boundaries** in [extraction-core.js](../src/extraction-core.js): `stripEntityMeta()`,
  `sanitizeCompanyName()`, `sanitizeRoleTitle()`, `isEmploymentMeta()`, `isSkillValue()`. Applied at
  parse time, at grouping time, and again inside the accumulator, so employment metadata cannot
  become a company or a role title by any path. Skills are read from the card's heading
  (`entityHeadingText()`), and the section-wide sweep is now a fallback rather than an unconditional
  addition.
- **Diagnostics**: collector window id, tab id, tab active state, window state, renderability, the
  current collection state, and the automatic transition log.
- `tests/live-regressions.test.js` (23 tests) — every one of them failed before this change.

### Changed

- Importer page: **Start Full Collection**, **Discover Connections Only**, **Start Profile
  Extraction**, **Stop**, **Clear Queue**, **Saved Profiles**, **Download CSV** are primary; Retry
  Failed, Download Diagnostics and Recheck Login moved into **Advanced**. The three competing session
  controls collapsed into one compact component (`LinkedIn connected` / `Login required` /
  `LinkedIn verification required` with a small `Recheck`). The live collection state and any
  unresolved gap are shown.
- Navigation: `Import` → **Connections Collector**, `Table` → **Saved Profiles**, and
  `Connections import` → **Open Connections Collector**.
- Saved-profiles table: no longer renders full company and education cards inside cells. Columns are
  Name, Location, Current role, Current company, Headline (2 lines), Skills (3 + `+N more`),
  Experience (`N companies · M roles`), Education (`N institutions`), Updated, Actions — with a
  **View details** side panel holding the full cards, about text, certifications and languages.

## 3.3.0 — Automatic collector workflow, one collector tab, login gate, count reconciliation

Build ID `2026-08-02-react-v3.3.0`. `npm run check` passes here (196 tests). **Phase 30 (live
browser verification) is still open** — nothing below has been run against live LinkedIn from here.

### Root cause fixed in this release

**Discovery and extraction were running in two different tabs.** `resolveConnectionsTab()` searched
for *any* open connections tab and, failing that, called `chrome.tabs.create()` — a tab that had no
relationship to the reusable import tab stored under `profileVaultImportTabId`. A single run
therefore opened a connections tab *and* a profile tab, which violated the one-reusable-tab rule, and
Start Collecting could not work at all unless the user had already opened the Connections page
themselves. There was no login check anywhere, so a signed-out browser produced a discovery pass over
LinkedIn's sign-in wall instead of a clear "sign in first".

A second, narrower defect was fixed in the same path: `waitForTabComplete()` resolved on the
*previous* page'''s `status === "complete"`, because `chrome.tabs.update()` leaves `tab.url`
pointing at the old page until the navigation commits. The next profile could be read before it
existed.

### Added

- **Automatic Start Collecting workflow** (`startCollectingWorkflow` in `src/background.ts`):
  check the LinkedIn session → open LinkedIn'''s own sign-in page and pause if signed out → redirect
  the collector tab to the Connections page → enumerate the entire list → start extraction by itself.
  It runs **detached** from the message that requested it, so the popup and the importer page may
  both be closed while it works.
- **One dedicated collector window with one reusable tab.** `ensureCollectorTab()` creates a single
  unfocused normal window on first use and reuses that tab for discovery and for every profile.
  `chrome.tabs.create` no longer appears anywhere in the worker. The importer page warns that
  minimizing or closing that window stops LinkedIn rendering lazy-loaded content.
- **Authentication, without credentials.** `classifyAuthState()` (pure, in
  `src/connections-core.js`) reports Signed in / Login required / Checkpoint detected / Unknown from
  the page'''s own URL, text, and member-navigation markers. `Sign in to LinkedIn` only ever opens
  `https://www.linkedin.com/login`. No password field, cookie read, or credential storage exists in
  the codebase, and a test asserts that.
- **Count reconciliation.** `createCardLedger()` and `reconcileDiscovery()` account for every
  rendered card as a unique usable profile URL, a duplicate link to somebody already found, or a card
  with no usable link at all (restricted, out of network, deleted). This is what explains "LinkedIn
  reports 67, 66 profile URLs exist". An unexplained remainder is stated explicitly, because that is
  the one case that means discovery stopped early.
- **Clear Queue** on the importer page. It aborts work already in flight (via a generation token),
  stops the session, and wipes the discovered list, queue rows, counters, and session progress.
  Saved profiles live in a different store and are never touched.
- **Final stop reason.** `STOP_REASON` / `stopReasonText()` distinguish queue-complete,
  discovery-complete, user-stopped, queue-cleared, challenge, login-required, navigation-failures,
  error, and batch-cooldown, and the importer page shows it verbatim.
- **Importer page:** Start Collecting, Start Profile Extraction (renamed from Start Extraction),
  Clear Queue, Sign in to LinkedIn, Check Login, a live auth pill, and tiles for LinkedIn'''s reported
  total, missing/inaccessible cards, and skipped.
- **Diagnostics** now carry `cardsSeen`, `cardsWithoutUrl`, `restrictedCards`, `duplicateLinks`,
  `unusableSamples`, and the full reconciliation report.
- `tests/collector-workflow.test.js` (22 tests) and `tests/fixtures/linkedin-connections-67.html`.

### Changed

- `PV_IMPORT_DISCOVER_ALL` and `PV_IMPORT_START_COLLECTING` now return `{ started: true }`
  immediately instead of holding the message channel open for the whole run.
- `PV_IMPORT_RUN_ALL` is an alias of `PV_IMPORT_START_COLLECTING`.
- Stop and Pause abort in-flight discovery instead of only preventing the next pass.
- Removed `discoverCurrentPage()`: Start Collecting now enumerates the whole list before extracting
  rather than seeding from the visible page.

## Unreleased — Scroll-container detection (second live report)

The previous rebuild (below) did not fix the live symptoms: discovery still returned ~10 connections
and profiles still came back incomplete. Build ID and version are unchanged. Phase 30 (live browser
verification) is still open — none of this has been run against live LinkedIn from here.

### Root cause

Both failures were the same defect, in two places: **the code never found the element that actually
scrolls.**

LinkedIn's scaffold layout can pin `<html>`/`<body>` at `height: 100vh; overflow: hidden` and scroll a
wrapper that is an **ancestor** of the content. On that layout:

- `document.scrollingElement.scrollHeight - window.innerHeight` is `0`, so `maxScrollTop()` was `0`;
- `connections.js` searched only for a scrollable **descendant** of the list root (`innerScroller()`),
  where the tallest match is a filter panel that scrolls nothing;
- `content.js` drove `window.scrollTo` / `window.scrollY` outright.

So `atDocumentBottom()` was true on the very first read. Discovery went straight to its idle-at-bottom
path, found no growth (nothing had scrolled), and after `IDLE_BOTTOM_LIMIT` reads declared a
ten-row page to be the whole list. The profile scan settled after `QUIET_PASSES` reads of the top card
and saved a profile that had never been scrolled through. Everything downstream — accumulators,
planners, pagination policy — was already correct and never got the chance to run.

### Fixed

- **Scroll-container detection is now a pure, tested function.** `Core.chooseScrollTarget()`
  ([connections-core.js](../src/connections-core.js)) scores candidate descriptors and requires a real
  scroll range, a scrolling overflow, and that the container *actually holds the content being read* —
  which disqualifies the filter-panel decoy outright. `document.scrollingElement` wins ties; the
  outermost qualifying container beats an inner one.
- **Both content scripts feed it ancestors.** `scrollCandidates()` in [connections.js](../extension/content-scripts/connections.js)
  and [content.js](../extension/content-scripts/content.js) offers the document, every ancestor of the list/profile root, and the
  root itself. Scrollable descendants are a last resort, only when nothing above qualifies.
- **Position, bottom, and stepping all read the same element.** `currentScrollTop()` /`maxScrollTop()`
  no longer take `Math.max` across two different scrollers, which produced a cursor belonging to
  neither.
- **Discovery finishes only after five quiet scans.** `DISCOVERY_QUIET_SCANS = 5`; an available
  allowlisted control still always wins over finishing (`IDLE_BOTTOM_LIMIT = 2` for paging).
- **The profile scan needs five quiet passes** (`PROFILE_SCAN.QUIET_PASSES` 3 → 5).
- **Late-hydrating entities enrich instead of duplicating.** The old `addUniqueMap` was insert-only, so
  a role captured before its company link hydrated locked in an empty `companyUrl`.

### Added

- **`Core.createProfileAccumulator()`** in [extraction-core.js](../src/extraction-core.js): the pure,
  merge-only profile accumulator, keyed exactly as required — experience by canonical company URL +
  normalized title + date range, education by institution + degree + dates, skills by lowercase name,
  certifications by name + issuer + issue date. One education card per institution
  (`groupEducationByInstitution`).
- **Streamed persistence during discovery.** The connections page posts `PV_IMPORT_DISCOVERY_PROGRESS`
  as it finds rows; the worker writes them one at a time with `putItem`. An interrupted pass no longer
  loses everything it found.
- **Live diagnostics.** Both content scripts build a diagnostics report (detected containers, scroll
  metrics, per-scan card/link/new-URL counts, mutations, quiet scans, pagination control, advertised
  total, stop reason; plus section headings and per-entity deltas on the profile side). **Download
  Diagnostics** on [import.html](../extension/pages/import.html) saves it as JSON via `PV_IMPORT_DIAGNOSTICS`.
- `tests/lazy-dom-regression.test.js` (35 tests) and two sanitized fixtures reproducing the live
  scaffold layout: `linkedin-connections-virtualized-35.html`, `linkedin-profile-scaffold-scroll.html`.

## Unreleased — Connections importer rebuild

Discovery, the connections page, and profile extraction were reworked after a report that only ~10
connections were ever discovered and that profiles came back incomplete. Build ID and version are
unchanged. Phase 30 (live browser verification) is still open — none of this has been run against
live LinkedIn from here.

### Fixed

- **Discovery stopped at the first screenful.** `discoveryPass()` stepped from `window.scrollY`, which
  never moves on layouts where LinkedIn scrolls an inner container — so every step asked for the same
  position. Position is now read and advanced through `currentScrollTop()`/`maxScrollTop()`, which
  span both scrollers.
- **The list container was assumed to be `<main>`.** `listRoot()` now picks whichever of `main`,
  `[role='main']`, or `body` actually carries the most profile links.
- **Cards were dropped by the visibility test.** Card reading falls back to a relaxed pass when the
  strict `getComputedStyle` test rejects everything while profile links clearly exist.
- **Discovery lost names.** `runDiscovery()` enqueued `result.urls` instead of `result.entries`, so
  every connection found by a full scan was queued without its name.
- **Profiles were read before the page finished loading.** Name, headline, and location were extracted
  from the top card *before* the lazy-scroll pass ran. The whole page is now walked first and the top
  card is re-read on every snapshot, keeping the best-scored value.
- **The profile scan stopped too early.** It ended after two reads at a stable scroll position. It now
  ends only when the page is at the bottom *and* three consecutive reads reveal no new content, so a
  virtualized section that is still producing records keeps the scan alive.

### Added

- **Find All Connections** (`PV_IMPORT_DISCOVER_ALL`) — enumerates the whole list and saves it to
  IndexedDB. It never starts extraction.
- **Start Extraction** (`PV_IMPORT_START`, extended) — runs over what was already discovered and saved.
  Discovery and extraction are now separate buttons and separate commands.
- **Selection scopes** — all, selected, uncollected, failed, or not collected within the configured
  number of days (`selectItemUrls()`, `prepareRun()`, scope-aware `claimNext()`).
- **A paginated connections table** — 25 or 50 rows per page, Previous/Next/page numbers, search,
  status filter, total count, and per-row name, profile URL, status, last collected date, and error.
- **Editable refresh window** — the skip-if-collected-within rule kept, with the number of days
  editable in the page.
- **View Saved Profiles Table** and **Retry Failed** buttons on the connections page.
- `lastCollectedAt` on every queue row, preserved when a completion re-used an existing record.
- Pure, testable cores for the parts that used to be buried in the content scripts:
  `createEntryCollector()`, `collectEntriesFromLinks()`, `planDiscoveryStep()` in
  `connections-core.js`; `createScanState()`, `nextScanStep()` in `extraction-core.js`;
  `filterItems()`, `paginate()`, `pageNumbers()` in `import-queue-core.js`.
- `tests/connections-discovery.test.js` — 29 tests over simulated lists and profile pages covering
  multiple cards per page, lazy-loaded cards, multiple pages, duplicate URLs, complete pagination
  discovery, persisted full lists, full-page profile scrolling, virtualized sections, and extraction
  only after the scan completes.

### Changed

- The import page's three-button cap was removed; the test that enforced it is replaced by tests for
  the controls now required.
- Skills cap 50 → 100, certifications 30 → 60, languages 30 → 40.
- `PROFILE_SETTLE_MS` 2000 → 2500.

Unchanged and still enforced by tests: challenge detection, the pagination allowlist / outreach
denylist, bounded retries, one profile at a time in one reusable tab, local-only storage,
LinkedIn-only host permissions, CSV column order and formula neutralization, and the React 16
class-component architecture.

## 3.2.0 — 2026-08-02 — Full connection coverage

Decisions D1, D2, and D3 were approved and phases 21–29 implemented. Phase 30 (live browser
verification) remains open.

### Added

- **Connection inventory (21).** `parseConnectionCount()` reads the advertised total from the
  Connections header. A rounded value such as `500+` is stored but flagged unreliable and can never
  confirm coverage.
- **Resumable multi-pass discovery (22).** Each `PV_DISCOVER_CONNECTIONS` call runs one pass from a
  persisted `cursorY` and returns the new cursor. The worker repeats passes (budget 400) until a
  reliable total is reached or the list is provably settled. Deduplication spans every pass and
  survives browser restarts.
- **Allowlisted pagination (23, decision D1).** `classifyControl()` permits only connections-list
  pagination labels, requires the control to be proven inside the list, and permanently forbids
  Connect, Follow, Message, InMail, Contact info, Endorse, Remove connection, Withdraw, Invite,
  Report, Block, Send, Share, Accept, Ignore, and Save. The denylist always beats the allowlist.
  `connections.js` contains exactly one `.click()` site, behind that verdict.
- **Coverage ledger (24).** `applyDiscoveryPass()` and `coverageReport()` track passes, quiet passes,
  pagination clicks, and discovered/processed/remaining/failed, reporting coverage as `confirmed`,
  `estimated`, `in-progress`, or `unknown`.
- **Long-run durability (25, decision D2).** A `chrome.alarms` heartbeat resumes an interrupted run
  and starts the next batch after a cooldown. It never clears a pause caused by a challenge, the
  user, a navigation trip, or an error.
- **Batch cap and cooldown (26, decision D3).** A user-set cap pauses into a cooldown that resumes
  automatically. Pacing between profiles is randomized 4–9 s. There is no unbounded mode.
- **Refresh policy (27).** Profiles collected within `refreshMaxAgeDays` (default 30) are skipped
  without navigating; a Force refresh checkbox overrides it.
- **Scale hardening (28).** `putItem()` writes one queue row per state change instead of rewriting
  the queue; the dashboard pages the queue 50 rows at a time.
- **Failure taxonomy and backoff (29).** `classifyFailure()` separates permanent failures
  (unavailable, 404, out of network), which fail immediately, from transient ones, which back off
  15 s × 2ⁿ up to 3 attempts.
- Dashboard now shows coverage state, advertised total, discovery passes, pagination clicks, batch
  number, batch cap, cooldown countdown, collected total, and per-item failure kind.
- New sanitized fixture `linkedin-connections-pagination.html` proving "Load more" is clicked while
  adjacent Connect/Message buttons and a decoy with a pagination `aria-label` are not.
- **Popup run controls.** `Start full extraction` enumerates every connection and then collects them
  all; `Continue extraction` resumes from the profile it stopped at. The popup shows live progress,
  the current URL, cooldown countdown, and challenge reason, and keeps running after it is closed.
  Backed by a new `PV_IMPORT_RUN_ALL` command that discovers first and refuses to start into a
  challenge.
- 36 new tests (67 → **103**).

### Changed — importer reduced to one button

- **`Start Collecting` is now the only action.** It reads the connections already rendered on the
  Connections page, lists them with name, URL and status, and begins collecting immediately. When the
  queue drains, the loop itself reveals the next connections via scrolling and allowlisted pagination
  and keeps going until the list is exhausted. Discovery is no longer a separate user step.
- The import page now shows only: one primary button, one progress bar, the current profile name,
  `completed / total`, a failed count, `Stop`, and a final `Download CSV`, plus the connection list.
- Removed from the UI: Find Connections, Collect All, Pause, Resume, Skip, Retry Failed, Clear Queue,
  batch size, cooldown, refresh-days and recollect-everything. These remain as internal safety limits
  with sensible defaults (100 per batch, 90 s rest, 30-day refresh window).
- Queue items carry a `name`, captured during discovery, so the list is readable.
- The popup mirrors the same single `Start Collecting` / `Stop` model.
- Tests cap the import page at three buttons and forbid inputs, selects, and disclosure panels.

### Fixed — reported from a live run

- **Only ~10 connections were discovered.** Discovery waited at most 1.4 s after each scroll, so it
  read a partially loaded list, hit the bottom of a short page and declared the list exhausted.
  It now waits for *actual growth* (profile-link count and document height) for up to 8 s, nudges the
  scroll sentinel so intersection-observer loaders re-fire, retries the bottom before concluding,
  drives an inner scroll container when the layout uses one, and requires 3 quiet passes instead of 2.
- **Profiles came back with missing data.** The lazy-scroll pass waited 800 ms per step, so sections
  below the fold were read before they rendered. Steps now wait up to 2.4 s, the pass runs up to 30
  steps, and the importer lets a profile settle 2 s after `tab.status === "complete"` before reading.
- Extraction and discovery timeouts raised to 150 s / 240 s to match the longer waits.
- Import page rewritten for clarity: a numbered "How this works" panel, two obvious primary buttons
  (`1 · Find connections`, `2 · Collect all`), plain-language coverage ("Found everyone" / "Probably
  found everyone"), an explicit warning when fewer than 25 connections are found, and everything else
  moved behind a "More options" disclosure.

### Changed

- `alarms` permission added — solely for the D2 heartbeat. A test asserts it is declared if and only
  if `chrome.alarms` is used.
- `recoverAfterInterruption()` now auto-continues a `running` session instead of forcing a manual
  Resume. Challenge, user, navigation, and error pauses still require a human.
- The connections fixture now exercises two resumable passes rather than one scan.

### Deliberately not done

- `unlimitedStorage` was **not** requested: no storage-quota failure has been demonstrated. A test
  keeps it out.

## 3.1.0 — 2026-08-01

### Added — user-started LinkedIn Connections importer

- Discovery of already-visible `/in/` profile links on the Connections page, with bounded, careful
  lazy scrolling that restores the original scroll position and never clicks a LinkedIn control.
- Canonicalization to `https://www.linkedin.com/in/<slug>` and deduplication of discovered URLs.
- A persistent IndexedDB queue (`importQueue`) and session record (`importSession`) under schema v3.
  The database name `profile-table-collector` is unchanged, so existing saved profiles remain.
- Strictly one-at-a-time processing in a single reusable tab: navigate, wait for the page and the
  content script, run the existing extractor, save, then continue.
- React import dashboard (`import.html`) with Discover, Start, Pause, Resume, Stop, Skip,
  Retry Failed, Clear Queue, and partial/full Export CSV.
- Status reporting for total, pending, processing, completed, failed, skipped, current URL,
  progress, session limit, pause reason, and last error.
- Immediate pause on CAPTCHA, login wall, checkpoint, unusual-activity warning, account restriction,
  unavailable profile, or three consecutive navigation failures.
- Bounded retries (3 attempts per profile) and a session limit (default 50).
- Recovery after popup closure, service-worker suspension, tab reload, or browser restart: an
  interrupted session is restored as paused and requires a manual Resume.
- `src/messages.ts` typed message contract shared by the React UI and the service worker.
- Two sanitized manual browser fixtures: `linkedin-connections-list.html` (virtualized rows,
  duplicate links, company/school links, sidebar contamination) and `linkedin-challenge-captcha.html`.
- 42 new automated tests covering discovery, deduplication, queue persistence surface,
  one-at-a-time processing, pause/resume/stop/skip, bounded retries, challenge detection, restart
  recovery, duplicate replacement, notes/tags preservation, and partial/full CSV export.

### Changed

- `replaceProfile` now preserves user-authored `notes` and `tags` in addition to `id` and
  `collectedAt`, so re-importing a profile no longer discards them.
- The service worker moved from `dist/background.js` to `dist/src/background.js` so its relative ESM
  imports resolve; `manifest.json` and the build script were updated to match.
- The profile content script now also loads `src/connections-core.js` so it can detect challenges.
- `downloadCsv` accepts a filename prefix, enabling a separate imported-only export.
- `validate-build.mjs` additionally checks the import page, the third React entry point,
  service-worker import resolution, and that no extension page loads a remote script.
- Fixed: the profile lazy-scroll pass now restores the user's scroll position via `try/finally`,
  so a mid-extraction error no longer strands the page.

### Removed

- `GEMINI.md`. Project rules are consolidated into `CLAUDE.md` (183 lines). No file references it.

### Unchanged

- Single-profile extraction, review, and save behavior.
- One company card per company with nested roles; one education card per institution.
- The 22-column CSV schema, UTF-8 BOM, quoting, and formula neutralization.
- Permissions: `activeTab`, `scripting`, `storage`, `downloads`, LinkedIn-only hosts.
  The importer added none.

## 3.0.0 — 2026-07-31

- Migrated popup UI to React + TypeScript.
- Migrated saved-profile dashboard to React + TypeScript.
- Added reusable company/role and institution card components.
- Preserved one-company-per-block experience normalization.
- Preserved replacement-save behavior and success messaging.
- Converted service worker to TypeScript.
- Added local vendored React/ReactDOM runtime for Manifest V3 CSP compliance.
- Added deterministic `dist` build pipeline.
- Added React architecture and generated-build validation tests.
- Preserved IndexedDB database name so existing saved profiles remain available.

## 2.5.0 — retained behavior

- Separate company cards for distinct employers.
- Nested roles for repeated employment at one company.
- Company logo capture when visibly rendered.
- Automatic replacement of previous extracted details on Save Profile.
