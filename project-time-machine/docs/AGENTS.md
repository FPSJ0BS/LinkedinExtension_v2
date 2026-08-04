# Project Time Machine — Agent Rules

`<tm>` is this folder's name. Never hardcode it; read it from the path you were
pointed at. All commands run from the project root.

## Purpose

Track every project-changing request as a separately recoverable task, including
minor edits. Preserve project history, validate work, and support
natural-language rollback and recovery.

## Session start — mandatory

Before reading or changing anything else, run both:

```bash
node <tm>/scripts/status.js
node <tm>/scripts/audit.js
```

Then act on what they report:

- **Active task exists** — finish it or abort it before starting new work. Never
  open a second task.
- **Stale or malformed lock** — a previous run was interrupted. Resolve it with
  `node <tm>/scripts/abort-task.js --execute` before doing anything else.
- **Unlogged changes** — files changed with no active task. Assign them to a task
  or discard them. Never absorb them silently into the next task.
- **Audit errors** — report them to the user and fix the metadata issues that are
  safe to fix. Never fabricate a record, commit or tag to make the audit pass.

## The mandatory rule

No project file may be added, edited, renamed, moved, deleted, generated,
formatted, or have its dependencies changed outside an active Time Machine task.

A minor change is still a task, including:

- One word, label, colour, spacing value, animation value, or CSS property
- One import, variable, field, route, validation rule, test, dependency, or
  configuration value
- Documentation, asset, schema, migration, environment-template and lockfile
  changes

Do not combine separate requests unless the user explicitly asks for one combined
task. When one request contains independently reversible changes, split them into
separate tasks.

## Every change

1. `node <tm>/scripts/start-task.js "Clear name based on the user's request"`
2. Make only the changes that task requires.
3. Run the applicable checks from `checks.md`.
4. `node <tm>/scripts/complete-task.js --summary "Result" --check "..."`
   — immediately, in the same turn. Never leave a task open across turns.
5. Report only: task id, task name, files changed, checks run, Git reference.

A task is not complete until its record, its Git commit and its annotated tag
all exist. `complete-task.js` verifies all three before releasing the lock; if it
fails partway the lock is deliberately kept so `status.js` can detect it.

During a task:

- Change only files the task requires.
- Do not include unrelated existing changes.
- Do not silently expand scope.
- Apply only the skills relevant to the task (`SKILLS.md`).

## Git discipline

Everything the Time Machine needs it does itself. You must never run:

- `git commit`, `git add` followed by a manual commit, or any commit outside
  `complete-task.js` / `rollback.js` / `recover.js`
- `git reset --hard`, `git checkout -f`, `git clean -fd`, `git stash drop`
- `git rebase`, `git commit --amend`, `git push --force`, `git filter-branch`
- `git tag -d`, `git tag -f`, or any edit to a `task/TASK-*` tag
- `git branch -D` on any `tm-backup/*` branch
- manual edits to files under `<tm>/tasks/` or `<tm>/rollbacks/`

Reading is always allowed and encouraged: `git status`, `git diff`, `git log`,
`git show`.

## Natural-language rollback

Interpret ordinary language without requiring the user to type commands:

| The user says | You run |
| --- | --- |
| "Undo the last task" | `rollback.js task last --execute` |
| "Reverse the login animation task" | `rollback.js task "login animation" --execute` |
| "Go back to TASK-0004" | `rollback.js to TASK-0004 --execute` |
| "Undo the rollback, bring everything back" | `recover.js --execute` |
| "Show all saved tasks" | `list-tasks.js` |

Always preview first (omit `--execute`), show the user what will change, then
apply. Identify the task from the records. Ask only when two tasks match equally
well and choosing wrong would be destructive.

## Rollback safety

- Every rollback and recovery creates and verifies a backup branch first.
- `rollback task` reverses only the selected task and preserves later work.
- `rollback to` restores the whole project to the selected task's state.
- Neither discards history: both are applied as forward commits, so anything
  rolled back stays reachable.
- Every rollback and recovery is itself recorded as a new task with its own
  record, commit and annotated tag.
- Original completed records are never modified. Rollback state is derived.
- On a Git conflict the operation aborts, restores the previous state, keeps the
  backup, and reports the conflict.
- Backup branches are never deleted automatically.

## Emergency checkpoints

The watcher (`watch.js`) stores snapshots in `refs/tm-checkpoint/*`. They never
commit to a branch, never move HEAD, and are never a substitute for a task. They
exist to rescue work that was made outside a task. Restoring one goes through
normal task tracking.

## Strict prohibitions

- Never skip a minor change; it is still a task.
- Never create a record, commit or tag that does not describe real work.
- Never report a check as passed unless it actually ran and passed.
- Never commit secrets, credentials, `.env` files, private keys or tokens.
- Never use a destructive Git command (see **Git discipline**).
- Never rewrite, delete or hand-edit a completed task record.
- Never reuse a task id.
- Never create a branch per task, or a session concept.
- Never require the user to type Git or Node commands you could run yourself.
- Never add project-specific requirements to this universal rule file.

## Low-interruption behaviour

Use repository context and safe assumptions. Ask the user only for missing
credentials, genuinely ambiguous destructive actions, or information that cannot
be inferred.
