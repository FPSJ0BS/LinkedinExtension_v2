'use strict';

/**
 * Fast state snapshot. Run this at the start of every session, before touching
 * any file, to learn whether a task is already open and whether the working
 * tree carries unlogged changes.
 *
 * Usage:
 *   node <tm>/scripts/status.js [--json]
 */

const {
  insideRepo,
  root,
  tm,
  tmFolderName,
  tmRepoRelative,
  currentBranch,
  head,
  hasCommits,
  inspectActive,
  statusEntries,
  projectEntries,
  describeEntries,
  loadTaskRecords,
  listTaskTags,
  listBackupBranches,
  listCheckpoints,
  readHighWater,
  parseArgs,
  main
} = require('./common');

main(() => {
  const { flags } = parseArgs(process.argv.slice(2));

  if (!insideRepo()) {
    const payload = { repository: false, root, timeMachine: tm };
    if (flags.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Root:          ${root}`);
      console.log('Repository:    NOT a Git repository');
      console.log(`Next step:     node ${tmFolderName}/setup.js`);
    }
    process.exitCode = 1;
    return;
  }

  const info = inspectActive();
  const all = statusEntries();
  const project = projectEntries();
  const records = loadTaskRecords();
  const malformed = records.filter((task) => task.__malformed);
  const good = records.filter((task) => !task.__malformed);

  const byStatus = good.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  const byType = good.reduce((acc, task) => {
    const type = task.type || 'change';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const completed = good.filter((task) => task.status === 'completed');
  const last = completed[completed.length - 1] || null;
  const backups = listBackupBranches();
  const checkpoints = listCheckpoints();

  const payload = {
    repository: true,
    root,
    timeMachine: { path: tm, folder: tmFolderName, repoRelative: tmRepoRelative() || '(repository root)' },
    branch: currentBranch(),
    head: hasCommits() ? head() : null,
    active: { state: info.state, task: info.active || null, reason: info.reason || null },
    workingTree: {
      dirty: all.length > 0,
      totalChanges: all.length,
      projectChanges: project.length,
      entries: describeEntries(all)
    },
    tasks: {
      total: records.length,
      malformed: malformed.length,
      byStatus,
      byType,
      lastCompleted: last ? { id: last.id, name: last.name, completedAt: last.completedAt } : null,
      tags: listTaskTags().length,
      idHighWater: readHighWater()
    },
    backups: backups.length,
    checkpoints: checkpoints.length
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    if (info.state === 'stale' || info.state === 'malformed') process.exitCode = 1;
    return;
  }

  console.log(`Root:          ${root}`);
  console.log(`Time Machine:  ${tmFolderName}/  (${payload.timeMachine.repoRelative})`);
  console.log(`Branch:        ${payload.branch || '(detached HEAD)'}`);
  console.log(`HEAD:          ${payload.head ? payload.head.slice(0, 10) : '(no commits yet)'}`);
  console.log('');

  switch (info.state) {
    case 'none':
      console.log('Active task:   none');
      break;
    case 'healthy':
      console.log(`Active task:   ${info.active.id} — ${info.active.name}`);
      console.log(`               started ${info.active.startedAt}`);
      break;
    default:
      console.log(`Active task:   ${info.state.toUpperCase()}`);
      console.log(`               ${info.reason}`);
      console.log(`               Fix: node ${tmFolderName}/scripts/abort-task.js --execute`);
      process.exitCode = 1;
  }

  console.log('');
  console.log(`Working tree:  ${all.length ? `${all.length} change(s), ${project.length} outside Time Machine records` : 'clean'}`);
  for (const line of describeEntries(all).slice(0, 25)) console.log(`               ${line}`);
  if (all.length > 25) console.log(`               ... and ${all.length - 25} more`);

  console.log('');
  console.log(`Tasks:         ${records.length} record(s)${malformed.length ? `, ${malformed.length} MALFORMED` : ''}`);
  for (const [status, count] of Object.entries(byStatus)) console.log(`               ${status}: ${count}`);
  console.log(`Task tags:     ${payload.tasks.tags}`);
  console.log(`Id high-water: ${payload.tasks.idHighWater}`);
  if (last) console.log(`Last complete: ${last.id} — ${last.name}`);
  console.log(`Backups:       ${backups.length}${backups.length ? ` (newest ${backups[0].name})` : ''}`);
  console.log(`Checkpoints:   ${checkpoints.length}`);

  console.log('');
  if (info.state === 'healthy') {
    console.log(`Next step:     finish with complete-task.js, or abandon with abort-task.js`);
  } else if (info.state === 'none' && project.length) {
    console.log('Next step:     unlogged changes exist — assign them to a task or discard them');
    process.exitCode = 1;
  } else if (info.state === 'none') {
    console.log('Next step:     start-task.js before editing any file');
  }
});
