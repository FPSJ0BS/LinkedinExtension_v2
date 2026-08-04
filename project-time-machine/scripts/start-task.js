'use strict';

/**
 * Open exactly one task. Refuses to start when another task is active or when
 * the working tree already carries unlogged changes — those changes must be
 * assigned to a task (or discarded) first, otherwise they would be silently
 * absorbed into the next task's commit.
 *
 * Usage:
 *   node <tm>/scripts/start-task.js "Task name" [--type change]
 */

const {
  ensureDirs,
  ensureGit,
  requireRepo,
  requireNoActiveTask,
  projectEntries,
  describeEntries,
  nextTaskId,
  createTaskRecord,
  taskPath,
  writeJsonAtomic,
  setActive,
  head,
  currentBranch,
  tmFolderName,
  TASK_TYPES,
  parseArgs,
  fail,
  main
} = require('./common');

main(() => {
  ensureDirs();
  ensureGit();
  requireRepo();

  const { flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ['type', 'name'] });

  const name = (flags.name ? flags.name[flags.name.length - 1] : positionals.join(' ')).trim();
  if (!name) {
    fail(`Task name is required.\nUsage: node ${tmFolderName}/scripts/start-task.js "Describe the change"`);
  }

  const type = flags.type ? flags.type[flags.type.length - 1] : 'change';
  if (!TASK_TYPES.includes(type)) {
    fail(`Unknown task type "${type}". Expected one of: ${TASK_TYPES.join(', ')}`);
  }

  requireNoActiveTask('start a task');

  // Only real project work blocks a new task. Uncommitted Time Machine records
  // (e.g. left by an aborted task) ride along into this task's commit so the
  // audit trail survives.
  const dirty = projectEntries();
  if (dirty.length) {
    fail(
      'Uncommitted changes exist before the task started.\n' +
        describeEntries(dirty).join('\n') +
        '\n\nAssign them to a task, commit them, or discard them before starting another task.'
    );
  }

  const id = nextTaskId();
  const task = createTaskRecord({ id, name, type, startCommit: head() });
  writeJsonAtomic(taskPath(id), task);

  setActive({
    id,
    name,
    type,
    startedAt: task.startedAt,
    startCommit: task.startCommit,
    branch: currentBranch(),
    pid: process.pid
  });

  console.log(`${id} — ${name}`);
  console.log(`type: ${type}`);
  console.log(`base: ${task.startCommit ? task.startCommit.slice(0, 10) : '(no commits yet)'}`);
});
