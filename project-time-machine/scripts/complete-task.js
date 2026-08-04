'use strict';

/**
 * Close the active task, producing exactly three artifacts:
 *   1. an immutable tasks/TASK-XXXX.json record
 *   2. one Git commit
 *   3. one annotated tag task/TASK-XXXX
 *
 * The active-task lock is released only after the commit and the annotated tag
 * have been created AND verified. If anything fails in between, the lock is
 * kept so the interrupted task is detectable by status/audit.
 *
 * The commit hash is intentionally not stored inside the record: the record is
 * part of the commit it would describe, so any embedded hash would be
 * self-referential. The annotated tag is the authoritative record-to-commit
 * binding, and audit.js verifies the record is present in the tagged commit.
 *
 * Usage:
 *   node <tm>/scripts/complete-task.js [TASK-XXXX] --summary "Result" --check "build passed"
 */

const {
  requireRepo,
  requireActiveTask,
  statusEntries,
  projectEntries,
  describeEntries,
  isBookkeepingPath,
  mergeFileRecords,
  describeFileRecord,
  getTask,
  taskPath,
  writeJsonAtomic,
  setActive,
  git,
  now,
  commitAndTagTask,
  tmFolderName,
  TASK_ID_PATTERN,
  parseArgs,
  fail,
  main
} = require('./common');

main(() => {
  requireRepo();

  const { flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ['summary', 'check'] });
  const info = requireActiveTask();
  const active = info.active;

  const rest = [...positionals];
  if (rest.length && TASK_ID_PATTERN.test(rest[0].toUpperCase())) {
    const requested = rest.shift().toUpperCase();
    if (requested !== active.id) {
      fail(`Active task is ${active.id}, not ${requested}.`);
    }
  }

  const summary = (flags.summary ? flags.summary[flags.summary.length - 1] : rest.join(' ')).trim() ||
    `Completed ${active.id}`;
  const checks = (flags.check || []).map((value) => value.trim()).filter(Boolean);

  // Refuse to record an empty task: a task with no project change is a
  // bookkeeping artifact, not a recoverable unit of work.
  const before = statusEntries();
  const projectBefore = projectEntries();
  if (!projectBefore.length && !flags['allow-empty']) {
    fail(
      `No project changes detected for ${active.id}.\n` +
        'Make the change first, or abandon the task with:\n' +
        `  node ${tmFolderName}/scripts/abort-task.js --execute\n` +
        'Use --allow-empty only to deliberately record a no-op task.'
    );
  }

  // Stage first so Git performs rename/copy detection, then read status again.
  // `before` still knows which paths were untracked; the two are merged.
  git(['add', '-A']);
  const after = statusEntries();
  const files = mergeFileRecords(before, after).filter(
    (record) => !isBookkeepingPath(record.path) && !(record.from && isBookkeepingPath(record.from))
  );

  const task = getTask(active.id);
  if (task.status !== 'active') {
    fail(`Task ${active.id} is already ${task.status}; completed records are immutable.`);
  }

  const completed = {
    ...task,
    status: 'completed',
    completedAt: now(),
    files,
    checks,
    result: summary
  };
  delete completed.commit; // resolved from the annotated tag, never stored
  writeJsonAtomic(taskPath(active.id), completed);

  // Commit + annotated tag + verification. The lock is still held here.
  const { commit, tagName } = commitAndTagTask(completed, `${completed.id}: ${summary}`);

  // Only now is the task genuinely complete.
  setActive(null);

  console.log(`${completed.id} — ${completed.name}`);
  console.log(`status:  completed`);
  console.log(`commit:  ${commit.slice(0, 10)}`);
  console.log(`tag:     ${tagName} (annotated, verified)`);
  console.log(`summary: ${summary}`);
  console.log(`files:   ${files.length}`);
  for (const record of files) console.log(`  ${describeFileRecord(record)}`);
  console.log(`checks:  ${checks.length ? '' : '(none recorded)'}`);
  for (const check of checks) console.log(`  ${check}`);

  const leftover = statusEntries();
  if (leftover.length) {
    console.log('\nWarning: the working tree is not clean after committing:');
    console.log(describeEntries(leftover).join('\n'));
  }
});
