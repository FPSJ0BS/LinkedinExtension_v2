# Commands

`<tm>` below is the Time Machine folder's name. It is never hardcoded anywhere —
rename the folder and every command keeps working. If `setup.js` has been run,
the `npm run tm:*` shortcuts are equivalent and shorter.

All commands are run from the **project root**.

## Session start (always)

| Purpose | Command | Shortcut |
| --- | --- | --- |
| State snapshot | `node <tm>/scripts/status.js` | `npm run tm:status` |
| Full consistency audit | `node <tm>/scripts/audit.js` | `npm run tm:audit` |

`status.js` exits non-zero when a lock is stale or unlogged changes exist.
`audit.js` exits non-zero on any error; add `--strict` to fail on warnings too.
Both accept `--json`.

## Every change

| Purpose | Command | Shortcut |
| --- | --- | --- |
| Open a task | `node <tm>/scripts/start-task.js "Task name"` | `npm run tm:start -- "Task name"` |
| Close a task | `node <tm>/scripts/complete-task.js --summary "Result" --check "build passed"` | `npm run tm:complete -- --summary "Result"` |
| Abandon a task | `node <tm>/scripts/abort-task.js --execute` | `npm run tm:abort -- --execute` |
| List tasks | `node <tm>/scripts/list-tasks.js` | `npm run tm:list` |

`--check` may be repeated once per check actually run.
`complete-task.js` refuses a task with no project changes unless `--allow-empty`
is given.

## Rollback and recovery

Every one of these previews by default and changes nothing without `--execute`.

| Purpose | Command |
| --- | --- |
| Preview reversing one task | `node <tm>/scripts/rollback.js task TASK-0002` |
| Reverse one task | `node <tm>/scripts/rollback.js task TASK-0002 --execute` |
| Reverse the most recent task | `node <tm>/scripts/rollback.js task last --execute` |
| Preview restoring the project | `node <tm>/scripts/rollback.js to TASK-0002` |
| Restore the whole project | `node <tm>/scripts/rollback.js to TASK-0002 --execute` |
| List backups | `node <tm>/scripts/recover.js --list` |
| Preview recovery | `node <tm>/scripts/recover.js` |
| Recover from newest backup | `node <tm>/scripts/recover.js --execute` |
| Recover from a chosen backup | `node <tm>/scripts/recover.js 2 --execute` |

A task can also be named instead of an id: `rollback task "login animation"`.
An ambiguous name is a hard error, never a guess.

## Emergency checkpoints

Checkpoints are a safety net for work that is not yet in a task. They live in
`refs/tm-checkpoint/*`, never touch HEAD, the index or any branch, and are not
tasks.

| Purpose | Command |
| --- | --- |
| Run the watcher | `node <tm>/scripts/watch.js` |
| Take one checkpoint now | `node <tm>/scripts/watch.js checkpoint` |
| List checkpoints | `node <tm>/scripts/watch.js list` |
| Inspect one | `node <tm>/scripts/watch.js show 1` |
| Preview a restore | `node <tm>/scripts/watch.js restore 1` |
| Restore one | `node <tm>/scripts/watch.js restore 1 --execute` |
| Delete old checkpoints | `node <tm>/scripts/watch.js prune --keep 20 --execute` |

## Install

| Purpose | Command |
| --- | --- |
| Install into a project | `node <tm>/setup.js` |
| Install without npm | `node <tm>/setup.js --no-install` |

The installer is `setup.js` at the folder root. There is no separate installer
inside `scripts/`.
