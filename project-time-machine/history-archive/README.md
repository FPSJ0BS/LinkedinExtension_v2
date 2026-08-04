# Archived task records (TASK-0001 – TASK-0065)

These 65 records document real work, but the Git history they point at **does not
exist in this repository**.

## Why they are here and not in `tasks/`

This project arrived as a delivered folder snapshot (`profile-vault-TASK-0064-fixed-fast-resume`)
with no `.git` directory. The task records survived because they are ordinary files
inside `project-time-machine/tasks/`; the commits and the annotated `task/TASK-*`
tags they refer to did not, and they cannot be reconstructed from anything on disk.

A Time Machine task is only complete when all three of its artifacts agree — the
record, the commit, and the annotated tag. For every record in this folder, two of
the three are gone. `audit.js` correctly reported each one as `missing-tag`.

Fabricating tags to silence that would be a lie about what is recoverable, and is
forbidden by the agent rules. Leaving them in `tasks/` meant `audit.js` reported
`FAILED` with 65 errors on every run, which would hide a real error the moment one
appeared.

So they were moved here, verbatim. **Nothing was deleted or edited.**

## What this means in practice

- These records are **readable history only**. Use them to see what was done and why.
- They are **not rollback targets**. `rollback.js` cannot reverse them — there is no
  commit to revert. Attempting it will fail.
- `list-tasks.js` no longer lists them. Read the JSON files here directly.
- Task ids are **not** reused: the id high-water mark in `runtime/` is at 66, and
  the first tracked task is `TASK-0066`.

## Where real history starts

`TASK-0066` recorded the delivered tree as the first tracked baseline. Every task
from `TASK-0066` onward has all three artifacts and is individually reversible.

Archived by `TASK-0067`.
