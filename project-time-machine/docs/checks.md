# Project Checks

Run only the checks that apply to this repository and this task. Record each one
you ran with `--check "..."` when completing the task. Record skipped checks with
a reason in the summary.

Never mark a check as passed unless it actually ran and passed.

## Always

- Confirm the task scope matches the request, and nothing more
- Inspect `git status` and `git diff`
- Verify no secrets, credentials, `.env` files or private keys are included
- Verify no unrelated files crept into the change
- Verify the Time Machine state is clean: `node <tm>/scripts/status.js`

## When available

- Build
- Lint
- Type-check
- Unit tests
- Integration tests
- End-to-end tests
- Dependency validation or audit

Prefer running only the subset that covers the change when the full suite is slow,
and say which subset you ran.

## UI changes

- Relevant routes open
- No console errors
- Responsive behaviour
- Keyboard access and visible focus
- Loading, empty, success and error states

## API and database changes

- Input validation
- Authorization checks
- Failure responses
- Migration and data-integrity checks
- Rollback path for the migration

## Before completing

- All changed files are recorded by `complete-task.js`
- The summary describes the result, not the intention
- Every `--check` you pass actually ran
