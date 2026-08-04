# WORKFLOW.md — how work is done on this project

How every change to Profile Vault is investigated, made, checked and saved. The binding rules live in
[CLAUDE.md](CLAUDE.md) ("READ FIRST") and
[project-time-machine/docs/AGENTS.md](project-time-machine/docs/AGENTS.md); this file is the working
method those rules produce, written out so it can be followed or audited without reading either.

---

## 1. The one-line version

> Look first. Open a task. Change only what that task names. Run the checks. Close the task in the
> same turn. Never touch Git by hand.

---

## 2. Every change is a task — there is no "small enough"

A one-word fix, a single colour, one import, one comment, a docs-only edit: still a task. The
Project Time Machine is what makes any change individually reversible months later, and a change made
outside a task is a change that cannot be rolled back on its own.

**No file may be created, edited, renamed, moved or deleted outside an active task.** That includes
this file — it was written under `TASK-0051`.

### Task granularity

| Rule | Why |
|---|---|
| One request → one task | So "undo the pagination change" means something |
| Unrelated requests are **never** combined | Two fixes in one commit cannot be reversed separately |
| Independently reversible work is split | The unit of rollback is the unit of decision |
| A task is **closed in the same turn it is opened** | An open task blocks the next one, and a lock left overnight is a stale lock |

One request can legitimately become several tasks. When eight things were asked for in one message,
they became six tasks plus a release task — because "remove four columns" and "fix the resume tab"
should be reversible independently of each other.

---

## 3. The sequence, start to finish

### Step 0 — before reading or touching anything

```bash
node project-time-machine/scripts/status.js
node project-time-machine/scripts/audit.js
```

Then act on what they say, *before* any other work:

| They report | Action |
|---|---|
| An active task | Finish it or abort it. **Never open a second.** |
| A stale or malformed lock | `abort-task.js --execute` |
| Unlogged changes | Assign them to a task or discard them — never let the next task absorb them silently |
| Audit errors | Report them; fix only metadata that is safe to fix. **Never fabricate a record, commit or tag to make the audit pass.** |

### Step 1 — investigate before editing

This is not optional politeness; on this project it is the step that decides whether the fix works.

`current_role` was empty for **four consecutive releases** because each round patched the thing the
report pointed at — the parser — without first proving the parser was wrong. It was not. Round four
hand-traced the reported strings through the parser (they parsed correctly), noticed that *Education
failed too*, and from that concluded the fault had to be in a step above both. It was: a section root
that contained only its own heading.

So: read the actual code, quote the actual lines, and where a claim is load-bearing, try to **refute**
it before acting on it. A repeat report is evidence the previous diagnosis was wrong, not evidence the
previous fix was applied badly.

### Step 2 — open the task

```bash
node project-time-machine/scripts/start-task.js "Clear name based on the request"
```

`start-task.js` **refuses to run once the tree is dirty**. That is deliberate: it stops pre-existing
work being swallowed into a task that did not create it. Which means opening the task late is a
problem — see §6.

### Step 3 — make only the changes that task names

Nothing else. Adjacent cleanups that seem obvious belong to their own task.

### Step 4 — run the checks

```bash
npm run check
```

See §4 for what that runs and when a subset is acceptable.

### Step 5 — close the task, in the same turn

```bash
node project-time-machine/scripts/complete-task.js \
  --summary "What actually changed, and what was actually broken" \
  --check "npm run check passed (typecheck, build, 411 tests, validate)"
```

`--check` may be passed once per check **actually run**. Never claim a check that did not run, and
never claim a live-LinkedIn result (rule 17).

The summary says *what was broken*, not only *what changed*. A summary that reads "fixed the resume
download" is worthless six months later; one that names `closeOpenedOverlay` dispatching a synthetic
Escape and discarding its own return value is what makes the decision reviewable.

---

## 4. The checks — what runs, and when

`npm run check` is four commands in a fixed order:

```
typecheck  →  build  →  test  →  validate
    tsc       build.mjs   node    validate-build.mjs
  --noEmit               runner
```

| Command | What it proves |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — the TypeScript compiles |
| `npm run build` | ⚠️ **deletes `dist/` before running `tsc`** |
| `npm test` | Node's built-in runner, no dependencies |
| `npm run validate` | Read-only assertions about what landed in `dist/` |

**Typecheck first is not a style preference.** `build.mjs` removes `dist/` *before* compiling, and
there is no Git history for `dist/` to restore from — so a failed build leaves no extension at all.
Running `tsc --noEmit` first means the build only ever starts from a state known to compile.

### When they run

- **After every change**, before completing the task. Rule 18.
- **Between tasks in a chain** — each of the twelve tasks in this session ran the full check before it
  was closed, which is how a regression is attributed to the task that caused it rather than
  discovered five tasks later.
- **A baseline first**, when starting a batch of work, so "did I break this or was it already
  broken?" has an answer. This session started at **395 passing**.

### What the test count did, task by task

Real numbers from this session, each recorded in [CHECKS.md](CHECKS.md):

| Task | Change | Tests |
|---|---|---|
| — | baseline | 395 |
| TASK-0039 | popup closes on Collect Every Applicant | 396 |
| TASK-0040 | auto-restart without a reload | 398 |
| TASK-0041 | resume download, honest status | 400 |
| TASK-0042 | visual redesign | 405 |
| TASK-0043 | release 3.7.7 | 405 |
| TASK-0044 | section roots, nested scrollers, DOM logging | 408 |
| TASK-0045 | resume open→save→close cycle | 409 |
| TASK-0046 | pagination | 410 |
| TASK-0047 | four columns removed | 410 |
| TASK-0048 | popup panel, prose removed | 410 |
| TASK-0049 | stable row heights | 411 |
| TASK-0050 | release 3.7.8 | 411 |

### A failing check is information, not an obstacle

Three failures in this session each caught a real mistake rather than a stale assertion, and all three
are recorded in CHECKS.md:

- `chrome.tabs.create` added to the service worker — **three tests refused it**, correctly: rule 12
  says `collector-tabs-core.js` is the only place a tab may be created. The tab work moved there.
- A **comment** containing the literal string `.click()` tripped the assertion that the worker never
  clicks a page control. Reworded.
- Removing a paragraph left a ternary with no else branch — `tsc` caught it as `TS1109`.

When a test pins behaviour that is deliberately changing, the test is updated **and the reason
recorded**. When a test fails because the change is wrong, the change is fixed. Telling those two
apart is the judgement the step exists for.

---

## 5. How work is saved — the Time Machine owns Git

**Commits, tags and task records are created only by `complete-task.js`, `rollback.js` and
`recover.js`.**

`complete-task.js` performs, atomically:

1. stages the changed files,
2. writes the commit,
3. writes an **annotated, verified tag** `task/TASK-00NN`,
4. writes the task record under `project-time-machine/tasks/`,
5. prints back: task id, name, files changed, checks run, and the Git reference.

### Never run these

```
git commit          git add + manual commit     git reset --hard
git checkout -f     git clean -fd               git stash drop
git rebase          git commit --amend          git push --force
git tag -d / -f     git branch -D tm-backup/*
```

…and never hand-edit `project-time-machine/tasks/` or `project-time-machine/rollbacks/`.

Reading is always fine: `git status`, `git diff`, `git log`, `git show`.

### Rolling back — plain language, no commands for the user to type

| The user says | What runs |
|---|---|
| "undo the last task" | `rollback.js task last --execute` |
| "reverse the contact-info task" | `rollback.js task "contact info" --execute` |
| "go back to TASK-0004" | `rollback.js to TASK-0004 --execute` |
| "bring it all back" | `recover.js --execute` |
| "show me the saved tasks" | `list-tasks.js` |

Always previewed first (omit `--execute`), the effect shown, then applied.

---

## 6. When it goes wrong

**Work made outside a task** is a rule violation, and it is said plainly rather than quietly folded
in. The recovery is:

```bash
node project-time-machine/scripts/watch.js checkpoint   # snapshot it
git stash push -u                                       # park it
node project-time-machine/scripts/start-task.js "…"     # now the tree is clean
git stash pop                                           # restore it
npm run check
node project-time-machine/scripts/complete-task.js --summary "…" --check "…"
```

**An audit error is never fixed by inventing a record.** Only metadata that is safe to correct is
corrected; anything else is reported as-is.

---

## 7. What is never claimed

- **A check that did not run.** `--check` is a record, not a hope.
- **A live-LinkedIn result** (rule 17). Fixtures are not the live DOM, and this project has the scar
  tissue to prove it: the suite passed **387 tests while three columns were empty on every row, for
  three releases running**. Local green means the code compiles and the contracts hold. It does not
  mean the extension works.
- **That something is done when part of it is blocked.** The blocked part is named, with the reason.

Every release therefore ends with an explicit *"what only a live run can confirm"* section in
[CHECKS.md](CHECKS.md) — and where a live answer is needed, the code is changed to *report* it. That
is why `logSectionScan()` now prints the real markup behind an empty Experience section, and why
`logListWalk()` prints how many pages the list walk actually covered: the next report should not need
another round of guessing.

---

## 8. Reporting back

After a task, only: **task id, task name, files changed, checks run, Git reference.**

The long-form reasoning belongs in the task summary and in [CHANGELOG.md](CHANGELOG.md), where it is
attached to the change forever rather than scrolling away in a conversation.

---

## Companion docs

[CLAUDE.md](CLAUDE.md) · [AGENTS.md](AGENTS.md) · [CHECKS.md](CHECKS.md) ·
[CHANGELOG.md](CHANGELOG.md) · [MEMORY.md](MEMORY.md) · [TECH_STACK.md](TECH_STACK.md) ·
[PROJECT_STATUS.md](PROJECT_STATUS.md) · [PHASES.md](PHASES.md) · [SKILLS.md](SKILLS.md) ·
[README.md](README.md)
