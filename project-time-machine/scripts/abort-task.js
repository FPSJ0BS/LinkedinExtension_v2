'use strict';

/**
 * Release the active-task lock without producing a task.
 *
 * This is the recovery path for an interrupted `complete-task.js` run: the lock
 * is deliberately held across commit + tag creation, so a crash in between
 * leaves a lock that status/audit flag as stale. Aborting marks the (never
 * completed) record as "aborted" and clears the lock.
 *
 * Project files are never touched. The task id is never released, so it can
 * never be reused.
 *
 * Usage:
 *   node <tm>/scripts/abort-task.js [--execute] [--reason "..."]
 */

const {
  requireRepo,
  inspectActive,
  taskPath,
  readJsonSafe,
  writeJsonAtomic,
  setActive,
  statusEntries,
  describeEntries,
  git,
  hasCommits,
  now,
  parseArgs,
  fail,
  main
} = require('./common');

main(() => {
  requireRepo();

  const { flags } = parseArgs(process.argv.slice(2), { valueFlags: ['reason'] });
  const execute = Boolean(flags.execute);
  const reason = flags.reason ? flags.reason[flags.reason.length - 1] : 'Aborted by operator';

  const info = inspectActive();
  if (info.state === 'none') {
    console.log('No active task. Nothing to abort.');
    return;
  }

  console.log(`Lock state: ${info.state}`);
  if (info.reason) console.log(`Detail:     ${info.reason}`);
  if (info.active && info.active.id) {
    console.log(`Task:       ${info.active.id} — ${info.active.name || '(unnamed)'}`);
  }

  const dirty = statusEntries();
  if (dirty.length) {
    console.log('\nWorking tree changes (these are kept, not discarded):');
    console.log(describeEntries(dirty).join('\n'));
  }

  if (!execute) {
    console.log('\nPreview only. Re-run with --execute to release the lock.');
    return;
  }

  if (info.active && info.active.id) {
    const file = taskPath(info.active.id);
    const parsed = readJsonSafe(file);
    if (parsed.ok) {
      if (parsed.value.status === 'completed') {
        // The task finished but the lock outlived it — a run interrupted
        // between the commit and the tag. Release the lock and leave the
        // completed record untouched; it is immutable. audit.js will report
        // any missing tag separately.
        console.log(`\n${info.active.id} is already completed; its record is immutable and was left as-is.`);
        console.log('Run audit.js afterwards to confirm its commit and tag are intact.');
      } else {
        writeJsonAtomic(file, {
          ...parsed.value,
          status: 'aborted',
          abortedAt: now(),
          abortReason: reason
        });
        console.log(`\nMarked ${info.active.id} as aborted.`);
      }
    } else {
      console.log(`\nTask record for ${info.active.id} is missing or malformed; releasing the lock only.`);
    }
  }

  // Unstage anything a failed completion left in the index. Content is kept.
  if (hasCommits()) {
    const staged = git(['diff', '--cached', '--name-only'], { allowFailure: true });
    if (staged.ok && staged.stdout) {
      git(['reset', '--quiet']);
      console.log('Unstaged the index left behind by the interrupted run (files kept).');
    }
  }

  setActive(null);
  console.log('Active-task lock released.');
  console.log('The task id was not released and will never be reused.');
});
