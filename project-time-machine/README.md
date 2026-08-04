# Project Time Machine

A Git-backed workflow that tracks every change an AI coding agent makes as a
separately reversible task, so a bad edit is one command away from being undone
without losing anything else.

## Quick start

Drop this folder into your project's root directory, then either:

1. **Ask your agent:** *"Please run the time machine setup script"*
2. **Or run it yourself,** from the project root:

   ```bash
   node project-time-machine/setup.js
   ```

The folder name is never hardcoded — rename it to anything you like and every
script, command and document keeps working. Throughout the docs it is written
as `<tm>`.

### What setup does

1. Initialises Git if needed, and configures an identity only when one is missing.
2. Creates `tasks/`, `rollbacks/` and `runtime/`.
3. Merges `tm:*` scripts into your `package.json`, preserving every existing
   field, script and the file's original indentation.
4. Installs `chokidar` (needed by the watcher). Skip with `--no-install`.
5. Writes agent pointer files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
   `.windsurfrules`).
6. Creates one baseline commit staging **only the files it touched** — unrelated
   work in your tree is left unstaged.

Every step reports success or failure explicitly; nothing is skipped silently.

## How it works

One task produces exactly three artifacts, and all three must agree:

| Artifact | Purpose |
| --- | --- |
| `tasks/TASK-XXXX.json` | immutable record of what changed and which checks ran |
| one Git commit | the actual change |
| annotated tag `task/TASK-XXXX` | the authoritative record-to-commit binding |

`audit.js` verifies the three against each other, and additionally checks for
duplicate ids, orphaned tags, interrupted tasks, malformed records, missing
backups, stale package scripts and inconsistent documentation.

## Everyday use

```bash
node <tm>/scripts/status.js                  # run at every session start
node <tm>/scripts/audit.js

node <tm>/scripts/start-task.js "Add CSV export"
# ... make the change ...
node <tm>/scripts/complete-task.js --summary "Added CSV export" --check "tests passed"

node <tm>/scripts/rollback.js task last      # preview
node <tm>/scripts/rollback.js task last --execute
node <tm>/scripts/recover.js --execute       # undo that rollback
```

Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Safety properties

- Rollback and recovery **preview by default** and need `--execute`.
- A backup branch is created **and verified** before anything is modified.
- Backup branches are **never deleted automatically**.
- Rollback is applied as a forward commit, so **nothing becomes unreachable** —
  there is no `reset --hard` anywhere in the rollback path.
- A conflict **aborts** the rollback, restores the previous state, and keeps the
  backup.
- Completed records are **immutable**; rollback state is derived from later
  records, never written back into the original.
- Task ids are **never reused**, even after a reset, a recovery or a branch change.
- The active-task lock is **held until the commit and tag are verified**, so an
  interrupted run is always detectable.

## Emergency checkpoints

`node <tm>/scripts/watch.js` snapshots the working tree into `refs/tm-checkpoint/*`
using Git plumbing and a throwaway index. Checkpoints never commit to a branch,
never move HEAD and never touch your index — they are a rescue net for work made
outside a task, not a replacement for tasks.

```bash
node <tm>/scripts/watch.js list
node <tm>/scripts/watch.js restore 1 --execute
```

## Tests

```bash
npm test
```

The suite drives the real scripts against real temporary Git repositories.

## For AI agents

Read [docs/AGENTS.md](docs/AGENTS.md). Setup also writes a pointer to it into
your project root so your agent finds it automatically.
