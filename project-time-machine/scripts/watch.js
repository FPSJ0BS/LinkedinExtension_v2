'use strict';

/**
 * Emergency checkpoints — a safety net, NOT a substitute for task tracking.
 *
 *   node <tm>/scripts/watch.js                 run the watcher daemon
 *   node <tm>/scripts/watch.js list            list stored checkpoints
 *   node <tm>/scripts/watch.js show <id>       show a checkpoint's file list
 *   node <tm>/scripts/watch.js restore <id>    preview restore (--execute to apply)
 *   node <tm>/scripts/watch.js prune --keep 20 delete old checkpoints (--execute)
 *
 * Checkpoints are written with plumbing (`add` into a throwaway index ->
 * `write-tree` -> `commit-tree` -> `update-ref`) into refs under
 * refs/tm-checkpoint/. That means a checkpoint NEVER:
 *   - commits to the current branch
 *   - moves HEAD
 *   - touches the real index or the working tree
 *   - creates a task, a task tag, or anything the audit trail would mistake
 *     for tracked work
 *
 * Restoring a checkpoint DOES go through task tracking: it takes a verified
 * safety backup and records itself as a normal task with a commit and an
 * annotated tag.
 */

const {
  path,
  root,
  runtimeDir,
  tm,
  tmFolderName,
  requireRepo,
  requireNoActiveTask,
  requireCleanTree,
  ensureDirs,
  ensureGit,
  repoTopLevel,
  listCheckpoints,
  CHECKPOINT_REF_PREFIX,
  head,
  hasCommits,
  createVerifiedBackup,
  restoreBookkeeping,
  nextTaskId,
  createTaskRecord,
  taskPath,
  writeJsonAtomic,
  rollbacksDir,
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
  safeStamp,
  removeFileIfPresent,
  parseArgs,
  fail,
  main
} = require('./common');

const DEFAULT_DEBOUNCE_MS = Number(process.env.TM_CHECKPOINT_DEBOUNCE_MS || 20000);
const tempIndex = path.join(runtimeDir, 'checkpoint-index');
const tempIndexPosix = tempIndex.split(path.sep).join('/');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache']);

// ---------------------------------------------------------------------------
// Checkpoint creation (plumbing only)
// ---------------------------------------------------------------------------

/** Build a tree object from the current working tree without touching the real index. */
function snapshotTree() {
  ensureDirs();
  removeFileIfPresent(tempIndex);
  const env = { GIT_INDEX_FILE: tempIndexPosix };
  try {
    git(['add', '-A', '--', '.'], { env, cwd: repoTopLevel() || root });
    return git(['write-tree'], { env, cwd: repoTopLevel() || root });
  } finally {
    removeFileIfPresent(tempIndex);
  }
}

function currentHeadTree() {
  return gitTry(['rev-parse', 'HEAD^{tree}']);
}

function latestCheckpointTree() {
  const [latest] = listCheckpoints();
  if (!latest) return null;
  return gitTry(['rev-parse', `${latest.commit}^{tree}`]);
}

/**
 * Create one checkpoint ref. Returns null when the tree is unchanged since both
 * HEAD and the previous checkpoint, so an idle project accumulates nothing.
 */
function createCheckpoint(changedFiles) {
  const tree = snapshotTree();
  if (tree === currentHeadTree()) return null;
  if (tree === latestCheckpointTree()) return null;

  const id = safeStamp();
  const message =
    `tm-checkpoint ${id}\n\n` +
    'Emergency working-tree snapshot created by the Time Machine watcher.\n' +
    'This is NOT a task. It is not on any branch and does not move HEAD.\n' +
    (changedFiles && changedFiles.length
      ? `\nPaths that triggered it:\n${changedFiles.slice(0, 50).map((file) => `  ${file}`).join('\n')}\n`
      : '');

  const parent = head();
  const args = ['commit-tree', tree];
  if (parent) args.push('-p', parent);
  args.push('-m', message);
  const commit = git(args);

  const ref = `${CHECKPOINT_REF_PREFIX}/${id}`;
  git(['update-ref', ref, commit]);

  const verified = gitTry(['rev-parse', '--verify', '--quiet', ref]);
  if (verified !== commit) fail(`Checkpoint ref ${ref} was not written correctly.`);

  return { id, ref, commit, tree };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

function runDaemon(flags) {
  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch (error) {
    fail(
      'The watcher needs the "chokidar" package.\n' +
        `Install it with:  npm install --save-dev chokidar\n` +
        `(or run: node ${tmFolderName}/setup.js, which installs it for you)`
    );
  }

  ensureDirs();
  ensureGit();
  requireRepo();

  const debounceMs = flags.interval ? Number(flags.interval[flags.interval.length - 1]) * 1000 : DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 1000) fail('--interval must be at least 1 second.');

  const watchRoot = repoTopLevel() || root;
  const changed = new Set();
  let timer = null;

  const isIgnored = (target) => {
    const relative = path.relative(watchRoot, target);
    if (!relative || relative.startsWith('..')) return false;
    const segments = relative.split(path.sep);
    if (segments.some((segment) => IGNORED_DIRS.has(segment))) return true;
    // The Time Machine's own folder is never checkpointed.
    return path.resolve(target) === tm || path.resolve(target).startsWith(tm + path.sep);
  };

  const flush = () => {
    const files = [...changed];
    changed.clear();
    try {
      const checkpoint = createCheckpoint(files);
      if (checkpoint) {
        console.log(`checkpoint ${checkpoint.id}  ${checkpoint.commit.slice(0, 10)}  (${files.length} path(s))`);
      }
    } catch (error) {
      console.error(`Checkpoint failed: ${error.message}`);
    }
  };

  const schedule = (filePath) => {
    changed.add(path.relative(watchRoot, filePath));
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const watcher = chokidar.watch(watchRoot, {
    ignored: isIgnored,
    ignoreInitial: true,
    persistent: true
  });

  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  watcher.on('error', (error) => console.error(`Watcher error: ${error.message}`));

  const shutdown = () => {
    clearTimeout(timer);
    watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Project Time Machine watcher active.');
  console.log(`Root:       ${watchRoot}`);
  console.log(`Debounce:   ${debounceMs / 1000}s`);
  console.log(`Ref prefix: ${CHECKPOINT_REF_PREFIX}/`);
  console.log('Checkpoints never touch HEAD, the index, or any branch.');
  console.log('They are a safety net only — real changes still need a task.');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function resolveCheckpoint(selector) {
  const checkpoints = listCheckpoints();
  if (!checkpoints.length) fail('No checkpoints found.');
  if (!selector || selector === 'last' || selector === 'latest') return checkpoints[0];

  if (/^\d+$/.test(selector)) {
    const index = Number(selector);
    if (index < 1 || index > checkpoints.length) {
      fail(`Checkpoint index ${index} is out of range (1..${checkpoints.length}).`);
    }
    return checkpoints[index - 1];
  }

  const exact = checkpoints.find((c) => c.id === selector || c.ref === selector || c.short === selector);
  if (exact) return exact;

  const partial = checkpoints.filter((c) => c.id.includes(selector));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    fail(`"${selector}" matches ${partial.length} checkpoints:\n` + partial.map((c) => `  ${c.id}`).join('\n'));
  }
  fail(`No checkpoint matches: ${selector}`);
}

function commandList() {
  const checkpoints = listCheckpoints();
  if (!checkpoints.length) {
    console.log('No checkpoints stored.');
    console.log(`Start the watcher with: node ${tmFolderName}/scripts/watch.js`);
    return;
  }
  console.log(`${checkpoints.length} checkpoint(s), newest first:`);
  checkpoints.forEach((checkpoint, index) => {
    console.log(`  [${index + 1}] ${checkpoint.id}  ${checkpoint.commit.slice(0, 10)}  ${checkpoint.createdAt}`);
  });
  console.log(`\nRestore with: node ${tmFolderName}/scripts/watch.js restore <index|id> --execute`);
}

function commandShow(selector) {
  const checkpoint = resolveCheckpoint(selector);
  console.log(`Checkpoint: ${checkpoint.id}`);
  console.log(`Ref:        ${checkpoint.ref}`);
  console.log(`Commit:     ${checkpoint.commit}`);
  console.log(`Created:    ${checkpoint.createdAt}`);
  const diff = gitTry(['diff', '--name-status', '-M', '-C', 'HEAD', checkpoint.commit]);
  console.log('\nDifference from HEAD:');
  console.log(diff ? diff : '  (identical to HEAD)');
}

function commandRestore(selector, flags) {
  requireRepo();
  if (!hasCommits()) fail('The repository has no commits; there is nothing to restore onto.');

  const checkpoint = resolveCheckpoint(selector);
  const preHead = head();

  console.log(`Restore checkpoint: ${checkpoint.id}`);
  console.log(`Checkpoint commit:  ${checkpoint.commit.slice(0, 10)}  (${checkpoint.createdAt})`);
  console.log(`Current HEAD:       ${preHead.slice(0, 10)} on ${currentBranch() || '(detached)'}`);

  const diff = gitTry(['diff', '--name-status', '-M', '-C', 'HEAD', checkpoint.commit]);
  console.log('\nPaths that will change:');
  console.log(diff ? diff : '  (none — already identical to HEAD)');

  if (!flags.execute) {
    console.log('\nPreview only. Nothing was changed. Re-run with --execute to apply.');
    return;
  }

  requireNoActiveTask('restore a checkpoint');
  requireCleanTree('restore a checkpoint');

  const safety = createVerifiedBackup(preHead);
  console.log(`\nSafety backup created and verified: ${safety.branch} -> ${safety.commit.slice(0, 10)}`);

  const id = nextTaskId();
  const name = `Restore emergency checkpoint ${checkpoint.id}`;
  const record = createTaskRecord({ id, name, type: 'checkpoint-restore', startCommit: preHead });
  record.target = { checkpoint: checkpoint.id, ref: checkpoint.ref, commit: checkpoint.commit };
  record.backup = { branch: safety.branch, commit: safety.commit };
  writeJsonAtomic(taskPath(id), record);
  setActive({ id, name, type: 'checkpoint-restore', startedAt: record.startedAt, startCommit: preHead, pid: process.pid });

  const result = git(['read-tree', '-u', '--reset', checkpoint.commit], { allowFailure: true });
  if (!result.ok) {
    git(['reset', '--hard', preHead], { allowFailure: true });
    setActive(null);
    writeJsonAtomic(taskPath(id), {
      ...record,
      status: 'aborted',
      abortedAt: now(),
      abortReason: 'Git could not restore the checkpoint tree.'
    });
    fail(
      `Git could not restore checkpoint ${checkpoint.id}.\n${result.stderr || result.stdout}\n` +
        `The repository was returned to ${preHead.slice(0, 10)}. ${safety.branch} was kept.`
    );
  }

  restoreBookkeeping(preHead);

  writeJsonAtomic(path.join(rollbacksDir, `${id}.json`), {
    id,
    type: 'checkpoint-restore',
    source: checkpoint.ref,
    sourceCommit: checkpoint.commit,
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

  const summary = `Restored emergency checkpoint ${checkpoint.id}`;
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
  console.log(`commit: ${commit.slice(0, 10)}`);
  console.log(`tag:    ${tagName} (annotated, verified)`);
  console.log(`files:  ${files.length}`);
  for (const entry of files) console.log(`  ${describeFileRecord(entry)}`);

  const leftover = statusEntries();
  if (leftover.length) {
    console.log('\nWarning: working tree not clean after restore:');
    console.log(describeEntries(leftover).join('\n'));
  }
}

function commandPrune(flags) {
  requireRepo();
  const keep = flags.keep ? Number(flags.keep[flags.keep.length - 1]) : 20;
  if (!Number.isInteger(keep) || keep < 0) fail('--keep must be a non-negative integer.');

  const checkpoints = listCheckpoints();
  const doomed = checkpoints.slice(keep);
  if (!doomed.length) {
    console.log(`${checkpoints.length} checkpoint(s) stored; nothing to prune with --keep ${keep}.`);
    return;
  }

  console.log(`Keeping the newest ${keep}, deleting ${doomed.length}:`);
  for (const checkpoint of doomed) console.log(`  ${checkpoint.id}  ${checkpoint.commit.slice(0, 10)}`);

  if (!flags.execute) {
    console.log('\nPreview only. Re-run with --execute to delete these checkpoint refs.');
    return;
  }
  for (const checkpoint of doomed) git(['update-ref', '-d', checkpoint.ref]);
  console.log(`\nDeleted ${doomed.length} checkpoint ref(s). Backup branches were not touched.`);
}

// ---------------------------------------------------------------------------

main(() => {
  const { flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ['keep', 'interval'] });
  const command = positionals.shift() || 'watch';
  const selector = positionals.join(' ').trim();

  switch (command) {
    case 'watch':
      runDaemon(flags);
      break;
    case 'list':
      requireRepo();
      commandList();
      break;
    case 'show':
      requireRepo();
      commandShow(selector);
      break;
    case 'restore':
      commandRestore(selector, flags);
      break;
    case 'prune':
      commandPrune(flags);
      break;
    case 'checkpoint': {
      // Create one checkpoint immediately; used by tests and by agents that
      // want a snapshot before a risky operation.
      requireRepo();
      ensureGit();
      const checkpoint = createCheckpoint([]);
      if (!checkpoint) {
        console.log('No checkpoint created: the working tree matches HEAD or the latest checkpoint.');
        return;
      }
      console.log(`checkpoint ${checkpoint.id}  ${checkpoint.commit.slice(0, 10)}`);
      console.log(`ref: ${checkpoint.ref}`);
      break;
    }
    default:
      fail(
        `Unknown watcher command: ${command}\n` +
          'Expected one of: watch, checkpoint, list, show, restore, prune'
      );
  }
});
