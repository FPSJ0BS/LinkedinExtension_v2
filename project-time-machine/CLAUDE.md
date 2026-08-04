# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This repo **is** the Project Time Machine tool — not a project that uses it. It is a drop-in folder copied into a *host* project's root, where it wraps every agent edit in a Git-backed, individually reversible "task".

Keep the two perspectives separate:

- **Developing the tool** (what you are doing here): edit [scripts/](scripts/), [setup.js](setup.js), [docs/](docs/), [tests/](tests/).
- **Using the tool** (what happens in a host project): the agent runs the `tm:*` scripts, governed by [docs/AGENTS.md](docs/AGENTS.md).

`setup.js` writes agent pointer files into the **host project's root** (`process.cwd()`). Those are different files from this one. Setup deliberately skips `CLAUDE.md` when it detects a self-hosted install (`root === tm`).

## Commands

No build, lint, or typecheck step — plain CommonJS Node scripts, run directly.

```bash
npm test                                   # bare `node --test` — discovers tests/*.test.js
node --test tests/rollback.test.js         # one file
node --test --test-name-pattern="rename"   # one test
# A bare directory argument (`node --test tests`) does NOT work on Node 22+:
# positional args are treated as globs, so a plain dir resolves to a module path.

node setup.js --no-install            # installer (--no-install skips npm)
node scripts/status.js                # session-start state snapshot
node scripts/audit.js [--strict]      # full consistency audit
node scripts/start-task.js "Name"
node scripts/complete-task.js --summary "Result" --check "tests passed"
node scripts/abort-task.js --execute  # release a stale lock
node scripts/rollback.js task TASK-0002 --execute
node scripts/rollback.js to   TASK-0002 --execute
node scripts/recover.js --list | --execute
node scripts/watch.js [checkpoint|list|show|restore|prune]
```

Because this repo is self-hosted, its own `tm:*` scripts point at `node scripts/…` rather than `node <folder>/scripts/…`. `audit.js` knows the difference and checks the right prefix.

Everything destructive **previews by default** and requires `--execute`.

## Architecture

**Git is the source of truth; JSON records are an index over it.** One task produces exactly three artifacts that must agree: `tasks/TASK-XXXX.json`, one commit, and an annotated tag `task/TASK-XXXX`.

The commit hash is deliberately **not** stored in the record — the record is part of the commit it would describe, so any embedded hash would be self-referential. The annotated tag is the authoritative binding, and `audit.js` proves it by checking `git cat-file -e <tagCommit>:<tm>/tasks/<id>.json`.

**All shared logic lives in [scripts/common.js](scripts/common.js).** Every other script is a thin argv shell over it. The invariants worth knowing before editing anything:

- **Nothing hardcodes the folder name.** Paths derive from `__dirname`; `tmChildPath()` handles the self-hosted case where the repo-relative path is the empty string. `audit.js` fails if a script or doc reintroduces the legacy dot-prefixed folder literal (see `LEGACY_FOLDER` in [scripts/audit.js](scripts/audit.js)).
- **`run()` never swallows a failure.** Non-zero exit throws with stderr attached. Callers that genuinely tolerate failure opt in with `{allowFailure: true}` and must check `.ok`.
- **`writeJsonAtomic()`** writes to a temp file in the same directory, fsyncs, then renames. Records are never partially written.
- **`statusEntries()` parses `--porcelain=v2 -z`**, not v1. v2 has a documented field layout, never quotes paths under `-z`, and carries rename/copy origins as their own NUL-terminated field — which is what makes paths with spaces parse correctly. Field counts are fixed per record type, so `parts.slice(8).join(' ')` recovers a path containing spaces.
- **`usedTaskNumbers()`** unions record filenames, ids inside records, rollback-log ids, `task/TASK-*` tags, and a gitignored high-water mark in `runtime/`. Tags survive `reset --hard`; the high-water mark survives records being reverted away. Together they make id reuse impossible.
- **Completed records are immutable.** Rollback state is computed by `derivedRollbackState()` from later rollback/recovery records. Never write `rolledBack` back into an original.

**Lock lifecycle.** `runtime/active-task.json` is a single-slot lock. `complete-task.js` holds it across commit *and* tag creation *and* verification, releasing only after all three succeed — so an interrupted run leaves a detectable stale lock rather than a silently lost task. `inspectActive()` classifies it as `none | healthy | stale | malformed`; `abort-task.js` is the recovery path.

**Rollback never destroys history.** There is no `reset --hard` in the rollback path.

| Mode | Mechanism | Effect |
| --- | --- | --- |
| `rollback task` | `git revert --no-commit` | reverses only that task, preserves later work |
| `rollback to` | `git read-tree -u --reset` + forward commit | restores the whole project tree, keeps all commits reachable |
| `recover.js` | `git read-tree -u --reset` + forward commit | restores from a `tm-backup/*` branch |

All three create and *verify* a backup branch first, refuse to run dirty or with an active task, and record themselves as a **new** task with its own id, commit and tag.

**`restoreBookkeeping()` is the subtle one.** After any rollback or recovery, `tasks/` and `rollbacks/` are restored from the pre-operation HEAD. Rolling the project back must never rewind the machine's memory — otherwise reverting TASK-0003 would delete `tasks/TASK-0003.json` (it was added in that commit), breaking both immutability and id allocation.

**Checkpoints are not tasks.** [scripts/watch.js](scripts/watch.js) snapshots via plumbing — `git add` into a throwaway index at `runtime/checkpoint-index`, then `write-tree`, `commit-tree`, `update-ref` into `refs/tm-checkpoint/*`. It never commits to a branch, moves HEAD, or touches the real index. Restoring a checkpoint *does* go through normal task tracking. Checkpoints are skipped when the tree matches HEAD or the previous checkpoint, so an idle project accumulates nothing.

## Conventions

- CommonJS, `'use strict'`, Node built-ins only. `chokidar` is the single runtime dependency and only `watch.js` needs it — it is `require`d lazily so every other command works without it.
- Scripts wrap their body in `main()` from `common.js`, which turns `TimeMachineError` into a clean one-line message plus exit code 1. Set `TM_DEBUG=1` for stack traces.
- `parseArgs()` handles `--flag`, `--flag value` and `--flag=value`; declare value-taking flags in `valueFlags`.
- Failures use `fail(message)` and should tell the user the exact command that fixes the problem.
- `TM_ROOT` overrides the project root; tests rely on it.
- Tests use `node:test` against real temporary Git repositories — no mocking of Git. Add new cases to [tests/](tests/) rather than asserting on internals.

## Guardrails encoded in audit.js

`audit.js` is partly a self-test of this repository, so a change that breaks these fails the audit rather than shipping quietly:

- no doc or script may reference a separate installer under `scripts/` — the installer is `setup.js` at the folder root
- no doc or script may hardcode the legacy dot-prefixed folder name
- every script in `REQUIRED_SCRIPTS` must exist
- `tm:*` entries in `package.json` must match the current folder name

Both forbidden literals are assembled at runtime in `audit.js` (`LEGACY_FOLDER`, `LEGACY_INSTALLER`) precisely so the checker does not flag its own source. Keep them that way, and keep them out of every `.md` file in this folder — the doc scan reads `CLAUDE.md` too.
