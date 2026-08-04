'use strict';

/**
 * List every task record with its derived rollback state.
 *
 * Rollback state is derived from later rollback/recovery task records, never
 * read from the original record — completed records are immutable.
 *
 * Usage:
 *   node <tm>/scripts/list-tasks.js [--json] [--all]
 */

const {
  loadTaskRecords,
  inspectActive,
  derivedRollbackState,
  tagExists,
  insideRepo,
  parseArgs,
  main
} = require('./common');

main(() => {
  const { flags } = parseArgs(process.argv.slice(2));
  const records = loadTaskRecords().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const info = inspectActive();
  const repo = insideRepo();

  const rows = records.map((task) => {
    if (task.__malformed) {
      return { id: task.id, status: 'malformed', type: '-', name: task.__error, ref: '-', rollback: '-' };
    }
    const state = task.status === 'completed' ? derivedRollbackState(task.id) : { reverted: false };
    return {
      id: task.id,
      status: task.status,
      type: task.type || 'change',
      name: task.name,
      ref: task.gitRef || '-',
      tag: repo && task.gitRef ? tagExists(task.gitRef) : null,
      rollback: state.reverted ? `reverted-by ${state.by}` : 'active-in-history',
      files: Array.isArray(task.files) ? task.files.length : 0
    };
  });

  if (flags.json) {
    console.log(JSON.stringify({ active: info.state === 'none' ? null : info.active, activeState: info.state, tasks: rows }, null, 2));
    return;
  }

  if (info.state !== 'none') {
    const id = info.active && info.active.id ? info.active.id : '(unknown)';
    const name = info.active && info.active.name ? info.active.name : '';
    console.log(`ACTIVE (${info.state}) | ${id} | ${name}`);
    if (info.reason) console.log(`  ${info.reason}`);
  }

  if (!rows.length) {
    console.log('No tasks recorded yet.');
    return;
  }

  for (const row of rows) {
    const tagMark = row.tag === null ? '' : row.tag ? '' : ' [TAG MISSING]';
    console.log(
      `${row.id} | ${String(row.status).padEnd(9)} | ${String(row.type).padEnd(18)} | ` +
        `${row.ref.padEnd(16)} | ${String(row.files).padStart(3)} files | ${row.rollback}${tagMark}`
    );
    console.log(`         ${row.name}`);
  }
});
