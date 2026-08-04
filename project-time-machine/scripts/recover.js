'use strict';

/**
 * Recover the project from a backup branch created by a previous rollback.
 *
 *   --list              show every available backup, newest first
 *   (no args)           preview recovery from the newest backup
 *   <branch|index>      select a specific backup (branch name or list index)
 *   --execute           actually perform the recovery
 *
 * Recovery:
 *   - refuses to run with a dirty working tree or an active task
 *   - creates and verifies its OWN safety backup first, so recovery is undoable
 *   - is recorded as a new globally unique task (record + commit + annotated tag)
 *   - never modifies any existing completed task record
 *   - never deletes a backup branch
 *
 * Like `rollback to`, this is applied as a forward restore commit rather than a
 * `reset --hard`, so nothing becomes unreachable.
 */

const {
  requireRepo,
  requireNoActiveTask,
  requireCleanTree,
  listBackupBranches,
  refExists,
  resolveCommit,
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

function resolveBackup(selector, backups) {
  if (!backups.length) {
    fail('No Time Machine backup branch found. There is nothing to recover from.');
  }
  if (!selector) return backups[0];

  if (/^\d+$/.test(selector)) {
    const index = Number(selector);
    if (index < 1 || index > backups.length) {
      fail(`Backup index ${index} is out of range (1..${backups.length}). Use --list to see them.`);
    }
    return backups[index - 1];
  }

  const normalised = selector.startsWith('tm-backup/') ? selector : `tm-backup/${selector}`;
  const exact = backups.find((backup) => backup.name === normalised || backup.name === selector);
  if (exact) return exact;

  if (refExists(`refs/heads/${selector}`)) {
    return { name: selector, commit: resolveCommit(`refs/heads/${selector}`), createdAt: null };
  }

  const partial = backups.filter((backup) => backup.name.includes(selector));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    fail(`"${selector}" matches ${partial.length} backups:\n` + partial.map((b) => `  ${b.name}`).join('\n'));
  }
  fail(`No backup branch matches: ${selector}`);
}

main(() => {
  requireRepo();

  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const backups = listBackupBranches();

  if (flags.list) {
    if (!backups.length) {
      console.log('No backup branches found.');
      return;
    }
    console.log(`${backups.length} backup(s), newest first:`);
    backups.forEach((backup, index) => {
      console.log(`  [${index + 1}] ${backup.name}  ${backup.commit.slice(0, 10)}  ${backup.createdAt}`);
    });
    console.log(`\nRecover with: node ${tmFolderName}/scripts/recover.js <index|branch> --execute`);
    return;
  }

  if (!hasCommits()) fail('The repository has no commits; there is nothing to recover.');

  const execute = Boolean(flags.execute);
  const backup = resolveBackup(positionals.join(' ').trim(), backups);
  const preHead = head();

  console.log(`Recover from: ${backup.name}`);
  console.log(`Backup commit: ${backup.commit.slice(0, 10)}${backup.createdAt ? `  (${backup.createdAt})` : ''}`);
  console.log(`Current HEAD:  ${preHead.slice(0, 10)} on ${currentBranch() || '(detached)'}`);

  const affected = (gitTry(['diff', '--name-status', '-M', '-C', '-z', 'HEAD', backup.commit]) || '')
    .split('\0')
    .filter(Boolean);
  const changeCount = affected.length ? Math.ceil(affected.length / 2) : 0;
  console.log(`\nRecovery will change approximately ${changeCount} path(s).`);
  if (!changeCount) console.log('  (the project already matches that backup)');

  if (!execute) {
    console.log('\nPreview only. Nothing was changed. Re-run with --execute to apply.');
    console.log(`List all backups with: node ${tmFolderName}/scripts/recover.js --list`);
    return;
  }

  requireNoActiveTask('recover');
  requireCleanTree('recover');

  // Recovery must itself be undoable.
  const safety = createVerifiedBackup(preHead);
  console.log(`\nSafety backup created and verified: ${safety.branch} -> ${safety.commit.slice(0, 10)}`);

  const id = nextTaskId();
  const name = `Recovery from ${backup.name}`;
  const record = createTaskRecord({ id, name, type: 'recovery', startCommit: preHead });
  record.target = { backupBranch: backup.name, commit: backup.commit };
  record.backup = { branch: safety.branch, commit: safety.commit };
  writeJsonAtomic(taskPath(id), record);
  setActive({ id, name, type: 'recovery', startedAt: record.startedAt, startCommit: preHead, pid: process.pid });

  const result = git(['read-tree', '-u', '--reset', backup.commit], { allowFailure: true });
  if (!result.ok) {
    git(['reset', '--hard', preHead], { allowFailure: true });
    setActive(null);
    writeJsonAtomic(taskPath(id), {
      ...record,
      status: 'aborted',
      abortedAt: now(),
      abortReason: 'Git could not restore the backup tree.'
    });
    fail(
      `Git could not restore ${backup.name}; recovery was aborted.\n${result.stderr || result.stdout}\n` +
        `The repository was returned to ${preHead.slice(0, 10)}.\n` +
        `Both ${backup.name} and ${safety.branch} were kept.`
    );
  }

  // Keep the full audit trail, including the rollback this recovery undoes.
  restoreBookkeeping(preHead);

  writeJsonAtomic(path.join(rollbacksDir, `${id}.json`), {
    id,
    type: 'recovery',
    source: backup.name,
    sourceCommit: backup.commit,
    safetyBackup: safety.branch,
    fromCommit: preHead,
    performedAt: now()
  });

  const before = statusEntries();
  git(['add', '-A']);
  const after = statusEntries();
  const files = mergeFileRecords(before, after).filter(
    (entry) => !isBookkeepingPath(entry.path) && !(entry.from && isBookkeepingPath(entry.from))
  );

  const summary = `Recovered the project from ${backup.name}`;
  const completed = {
    ...record,
    status: 'completed',
    completedAt: now(),
    files,
    checks: [`safety backup ${safety.branch} created and verified`],
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
  console.log(`\nPrevious state preserved at ${safety.branch}. No backup branch was deleted.`);

  const leftover = statusEntries();
  if (leftover.length) {
    console.log('\nWarning: working tree not clean after recovery:');
    console.log(describeEntries(leftover).join('\n'));
  }
});
