# Project Time Machine

Universal task tracking, rollback and recovery for AI coding tools.

`<tm>` below is this folder's name. It is never hardcoded — rename the folder and
everything keeps working.

## Install

1. Copy this folder into the project root.
2. From the project root, run:

   ```bash
   node <tm>/setup.js
   ```

3. Give your coding agent the text in `docs/START_PROMPT.txt`.

The installer initialises Git when needed, configures an identity only if one is
missing, merges `tm:*` scripts into `package.json` without disturbing anything
already there, installs `chokidar`, writes agent pointer files, and creates one
baseline commit that stages **only the files it touched** — unrelated changes in
your working tree are left alone.

Use `--no-install` to skip the npm step on an offline machine.

## Design

- One task = one JSON record + one Git commit + one annotated `task/TASK-XXXX` tag
- Task ids are allocated from records, tags and a gitignored high-water mark, so
  an id is never reused after a reset, a recovery or a branch change
- Completed records are immutable; rollback state is derived, never written back
- Every rollback and recovery is itself a task
- A verified backup branch is created before any rollback or recovery
- No sessions, no branch per task, no duplicate Markdown task log
- Rollback never discards history — it is applied as a forward commit

## Natural language

You can say:

- Undo the last task.
- Reverse the CSV column task.
- Restore the project to TASK-0003.
- Undo the rollback and bring back all my tasks.
- Show all saved tasks.

The agent runs the scripts for you. Everything previews first.

## Files

| Path | Purpose |
| --- | --- |
| `setup.js` | the installer — there is no separate installer inside `scripts/` |
| `scripts/` | the commands — see `COMMANDS.md` |
| `tasks/` | one immutable JSON record per task |
| `rollbacks/` | append-only log of rollback and recovery operations |
| `runtime/` | active-task lock and id high-water mark (gitignored) |
| `docs/AGENTS.md` | the rules an agent must follow |
| `docs/checks.md` | checks to run before completing a task |
| `docs/SKILLS.md` | capabilities to apply per task type |
| `tests/` | integration tests against real temporary Git repositories |

## Tests

```bash
npm test
```
