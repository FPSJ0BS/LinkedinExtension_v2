'use strict';

/**
 * Reverse a task, or restore the whole project to a task's state.
 *
 *   rollback task TASK-XXXX   reverse ONLY that task, preserving later work
 *   rollback to   TASK-XXXX   restore the complete project to that task's state
 *
 * Both modes:
 *   - preview by default and require --execute to change anything
 *   - refuse to run with a dirty working tree or an active task
 *   - create and verify a backup branch before touching the repository
 *   - abort safely and keep the backup when Git reports a conflict
 *   - record the operation as a NEW globally unique task (record + commit + tag)
 *   - never modify the original completed task record
 *
 * Neither mode discards history. `to` is implemented as a forward "restore"
 * commit whose tree equals the target commit's tree, not as `reset --hard`, so
 * the commits being rolled back remain reachable and recoverable.
 *
 * The Time Machine's own tasks/ and rollbacks/ directories are always restored
 * to their pre-operation state afterwards: rolling the project back must never
 * rewind the machine's memory of what happened.
 */

const {
  requireRepo,
  requireNoActiveTask,
  requireCleanTree,
  findTask,
  resolveTaskCommit,
  head,
  hasCommits,
  createVerifiedBackup,
  restoreBookkeeping,
  nextTaskId,
  createTaskRecord,
  taskPath,
  writeJsonAtomic,
  rollbacksDir,
  path,
  setActive,
  statusEntries,
  describeEntries,
  isBookkeepingPath,
  mergeFileRecords,
  describeFileRecord,
  commitAndTagTask,
  currentBranch,
  git,
  gitTry,
  now,
  tmFolderName,
  parseArgs,
  fail,
  main
} = require('./common');

/**
 * Parse `--name-status -z` output. The record shape is
 *   <status> NUL <path> NUL                       for A/M/D/T
 *   <status> NUL <oldPath> NUL <newPath> NUL      for R<score>/C<score>
 * Reading the status token first and then consuming exactly the number of
 * paths it implies keeps this correct for paths containing spaces — or for a
 * file literally named "M".
 */
function summariseNameStatus(raw) {
  if (!raw) return [];
  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const lines = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++];
    const pathCount = /^[RC]/.test(code) ? 2 : 1;
    const paths = tokens.slice(i, i + pathCount);
    i += pathCount;
    lines.push(`${code.padEnd(5)} ${paths.join(' -> ')}`);
  }
  return lines;
}

main(() => {
  requireRepo();

  const { flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ['reason'] });
  const mode = positionals.shift();
  if (!['task', 'to'].includes(mode)) {
    fail(
      'Rollback mode must be "task" or "to".\n' +
        `  node ${tmFolderName}/scripts/rollback.js task TASK-0002 --execute\n` +
        `  node ${tmFolderName}/scripts/rollback.js to   TASK-0002 --execute`
    );
  }

  const execute = Boolean(flags.execute);
  const query = positionals.join(' ').trim() || 'last';

  if (!hasCommits()) fail('The repository has no commits; there is nothing to roll back.');

  const target = findTask(query);
  const targetCommit = resolveTaskCommit(target.id);
  const preHead = head();

  console.log(`Mode:    rollback ${mode}`);
  console.log(`Target:  ${target.id} — ${target.name}`);
  console.log(`Commit:  ${targetCommit.slice(0, 10)}  (tag ${target.gitRef})`);
  console.log(`HEAD:    ${preHead.slice(0, 10)} on ${currentBranch() || '(detached)'}`);

  if (mode === 'task') {
    const affected = summariseNameStatus(
      gitTry(['diff-tree', '-r', '-M', '-C', '--name-status', '-z', '--no-commit-id', targetCommit]) || ''
    );
    console.log(`\nReversing ${target.id} will invert these ${affected.length} path(s):`);
    for (const line of affected) console.log(`  ${line}`);
    console.log('Later tasks are preserved.');
  } else {
    const affected = summariseNameStatus(
      gitTry(['diff', '--name-status', '-M', '-C', '-z', 'HEAD', targetCommit]) || ''
    );
    console.log(`\nRestoring the project to ${target.id} will change these ${affected.length} path(s):`);
    for (const line of affected) console.log(`  ${line}`);
    if (!affected.length) console.log('  (the project already matches that state)');
  }

  if (!execute) {
    console.log('\nPreview only. Nothing was changed. Re-run with --execute to apply.');
    return;
  }

  requireNoActiveTask('roll back');
  requireCleanTree('roll back');

  // ---- Backup first, verified, before touching anything -------------------
  const backup = createVerifiedBackup(preHead);
  console.log(`\nBackup branch created and verified: ${backup.branch} -> ${backup.commit.slice(0, 10)}`);

  const id = nextTaskId();
  const type = mode === 'task' ? 'rollback' : 'restore';
  const name =
    mode === 'task'
      ? `Rollback of ${target.id} (${target.name})`
      : `Restore project to ${target.id} (${target.name})`;

  const record = createTaskRecord({ id, name, type, startCommit: preHead });
  record.target = { taskId: target.id, taskName: target.name, commit: targetCommit };
  record.backup = { branch: backup.branch, commit: backup.commit };
  writeJsonAtomic(taskPath(id), record);
  setActive({ id, name, type, startedAt: record.startedAt, startCommit: preHead, pid: process.pid });

  const unwind = (message, extra) => {
    git(['revert', '--abort'], { allowFailure: true });
    git(['revert', '--quit'], { allowFailure: true });
    git(['reset', '--hard', preHead], { allowFailure: true });
    setActive(null);
    writeJsonAtomic(taskPath(id), { ...record, status: 'aborted', abortedAt: now(), abortReason: message });
    fail(
      `${message}\n${extra || ''}\n` +
        `The repository was returned to ${preHead.slice(0, 10)}.\n` +
        `The backup branch ${backup.branch} was kept and will not be deleted automatically.`
    );
  };

  // ---- Apply -------------------------------------------------------------
  if (mode === 'task') {
    const result = git(['revert', '--no-commit', '--no-edit', targetCommit], { allowFailure: true });
    if (!result.ok) {
      unwind(
        `Git could not reverse ${target.id} cleanly; the rollback was aborted.`,
        result.stderr || result.stdout
      );
    }
    // Single-commit revert leaves REVERT_HEAD/sequencer state behind; clear it
    // so the repository is not left mid-operation after we commit ourselves.
    git(['revert', '--quit'], { allowFailure: true });
  } else {
    const result = git(['read-tree', '-u', '--reset', targetCommit], { allowFailure: true });
    if (!result.ok) {
      unwind('Git could not restore the target tree; the rollback was aborted.', result.stderr || result.stdout);
    }
  }

  // The Time Machine's memory is never rewound.
  restoreBookkeeping(preHead);

  // ---- Record the operation as its own task ------------------------------
  writeJsonAtomic(
    path.join(rollbacksDir, `${id}.json`),
    {
      id,
      type,
      targetTaskId: target.id,
      targetCommit,
      backupBranch: backup.branch,
      backupCommit: backup.commit,
      fromCommit: preHead,
      performedAt: now()
    }
  );

  const before = statusEntries();
  git(['add', '-A']);
  const after = statusEntries();
  const files = mergeFileRecords(before, after).filter(
    (entry) => !isBookkeepingPath(entry.path) && !(entry.from && isBookkeepingPath(entry.from))
  );

  const summary =
    mode === 'task'
      ? `Reversed ${target.id} — ${target.name}`
      : `Restored project to the state after ${target.id} — ${target.name}`;

  const completed = {
    ...record,
    status: 'completed',
    completedAt: now(),
    files,
    checks: [`backup branch ${backup.branch} created and verified`],
    result: summary
  };
  writeJsonAtomic(taskPath(id), completed);

  const { commit, tagName } = commitAndTagTask(completed, `${id}: ${summary}`);
  setActive(null);

  console.log(`\n${id} — ${summary}`);
  console.log(`commit:  ${commit.slice(0, 10)}`);
  console.log(`tag:     ${tagName} (annotated, verified)`);
  console.log(`files:   ${files.length}`);
  for (const entry of files) console.log(`  ${describeFileRecord(entry)}`);
  console.log(`\nThe original record for ${target.id} was not modified.`);
  console.log(`Undo this with: node ${tmFolderName}/scripts/recover.js --execute`);

  const leftover = statusEntries();
  if (leftover.length) {
    console.log('\nWarning: working tree not clean after rollback:');
    console.log(describeEntries(leftover).join('\n'));
  }
});
