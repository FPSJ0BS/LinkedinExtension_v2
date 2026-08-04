'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, assertOk, assertFails } = require('./helpers');

/** Three independent tasks, each touching its own file. */
function threeTasks(host) {
  const one = host.doTask('Add alpha', (h) => h.write('alpha.txt', 'alpha v1\n'));
  const two = host.doTask('Add beta', (h) => h.write('beta.txt', 'beta v1\n'));
  const three = host.doTask('Add gamma', (h) => h.write('gamma.txt', 'gamma v1\n'));
  return { one, two, three };
}

test('rollback previews by default and changes nothing', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  const head = host.gitOut(['rev-parse', 'HEAD']);

  const preview = assertOk(host.tm('rollback.js', ['task', two]), 'preview');
  assert.match(preview.stdout, /Preview only/);
  assert.match(preview.stdout, /beta\.txt/);

  assert.equal(host.gitOut(['rev-parse', 'HEAD']), head, 'HEAD unchanged');
  assert.equal(host.exists('beta.txt'), true, 'file untouched');
  assert.equal(host.refs('refs/heads/tm-backup').length, 0, 'no backup created for a preview');
});

test('rollback task reverses only that task and preserves later work', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { one, two, three } = threeTasks(host);

  const result = assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  assert.match(result.stdout, /Backup branch created and verified/);

  assert.equal(host.exists('alpha.txt'), true, 'earlier task preserved');
  assert.equal(host.exists('beta.txt'), false, 'target task reversed');
  assert.equal(host.exists('gamma.txt'), true, 'later task preserved');
  assert.equal(host.read('gamma.txt'), 'gamma v1\n');

  // The original records are untouched.
  assert.equal(host.task(one).status, 'completed');
  assert.equal(host.task(two).status, 'completed');
  assert.equal(host.task(two).rollbackStatus, undefined, 'no rollback flag written into the original');
  assert.equal(host.task(three).status, 'completed');

  // The rollback is itself a task, with all three artifacts.
  const rollbackId = 'TASK-0004';
  const record = host.task(rollbackId);
  assert.equal(record.type, 'rollback');
  assert.equal(record.status, 'completed');
  assert.equal(record.target.taskId, two);
  assert.ok(record.backup.branch.startsWith('tm-backup/'));
  assert.ok(host.tags().includes(`task/${rollbackId}`));
  assert.equal(host.gitOut(['cat-file', '-t', `refs/tags/task/${rollbackId}`]), 'tag');

  assert.equal(host.porcelain(), '', 'clean tree afterwards');
  assertOk(host.tm('audit.js'), 'audit after rollback');
});

test('rollback derives the reverted state instead of mutating the original record', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  const before = host.read(host.taskFile(two));

  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  assert.equal(host.read(host.taskFile(two)), before, 'the original record file is byte-identical');

  const list = assertOk(host.tm('list-tasks.js'), 'list');
  assert.match(list.stdout, new RegExp(`${two}[^\\n]*reverted-by TASK-0004`));
});

test('rollback finds a task by name and refuses ambiguous names', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Add login animation', (h) => h.write('login.css', 'a\n'));
  host.doTask('Add signup animation', (h) => h.write('signup.css', 'b\n'));

  const byName = assertOk(host.tm('rollback.js', ['task', 'login animation']), 'by name');
  assert.match(byName.stdout, /TASK-0001/);

  const ambiguous = assertFails(host.tm('rollback.js', ['task', 'animation']), 'ambiguous');
  assert.match(ambiguous.stderr, /matches 2 tasks/);
});

test('rollback task last targets the most recent task', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', 'last', '--execute']), 'rollback last');
  assert.equal(host.exists('gamma.txt'), false);
  assert.equal(host.exists('beta.txt'), true);
});

test('rollback to restores the complete project state', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { one } = threeTasks(host);
  const result = assertOk(host.tm('rollback.js', ['to', one, '--execute']), 'rollback to');
  assert.match(result.stdout, /Backup branch created and verified/);

  assert.equal(host.exists('alpha.txt'), true, 'the target task state is kept');
  assert.equal(host.exists('beta.txt'), false, 'later work removed from the tree');
  assert.equal(host.exists('gamma.txt'), false, 'later work removed from the tree');

  // The machine's own memory is NOT rewound: every record survives.
  assert.equal(host.exists(host.taskFile('TASK-0002')), true);
  assert.equal(host.exists(host.taskFile('TASK-0003')), true);
  assert.equal(host.task('TASK-0004').type, 'restore');

  assert.equal(host.porcelain(), '', 'clean tree afterwards');
  assertOk(host.tm('audit.js'), 'audit after restore');
});

test('rollback to does not discard history — the rolled-back commits stay reachable', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { one, three } = threeTasks(host);
  const gammaCommit = host.gitOut(['rev-list', '-n', '1', `task/${three}`]);

  assertOk(host.tm('rollback.js', ['to', one, '--execute']), 'rollback to');

  const reachable = host.gitOut(['rev-list', 'HEAD']);
  assert.ok(reachable.includes(gammaCommit), 'the rolled-back commit is still an ancestor of HEAD');
});

test('task ids continue past a restore that removed later records from the tree', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { one } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['to', one, '--execute']), 'rollback to');

  const started = assertOk(host.tm('start-task.js', ['After restore']), 'start');
  assert.match(started.stdout, /TASK-0005/);
});

test('rollback refuses to run with a dirty tree or an active task', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);

  host.write('dirty.txt', 'unlogged\n');
  const dirty = assertFails(host.tm('rollback.js', ['task', two, '--execute']), 'dirty');
  assert.match(dirty.stderr, /uncommitted changes/);
  host.remove('dirty.txt');

  assertOk(host.tm('start-task.js', ['In progress']), 'start');
  const active = assertFails(host.tm('rollback.js', ['task', two, '--execute']), 'active');
  assert.match(active.stderr, /while task TASK-0004 is active/);
});

test('a conflicting rollback aborts safely, restores the previous state and keeps the backup', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Create the file', (h) => h.write('shared.txt', 'line one\nline two\nline three\n'));
  const second = host.doTask('Change the middle line', (h) =>
    h.write('shared.txt', 'line one\nSECOND EDIT\nline three\n')
  );
  host.doTask('Change the middle line again', (h) =>
    h.write('shared.txt', 'line one\nTHIRD EDIT\nline three\n')
  );

  const headBefore = host.gitOut(['rev-parse', 'HEAD']);
  const contentBefore = host.read('shared.txt');

  const result = assertFails(host.tm('rollback.js', ['task', second, '--execute']), 'conflicting rollback');
  assert.match(result.stderr, /could not reverse .* cleanly/);
  assert.match(result.stderr, /backup branch tm-backup\/.* was kept/);

  assert.equal(host.gitOut(['rev-parse', 'HEAD']), headBefore, 'HEAD restored');
  assert.equal(host.read('shared.txt'), contentBefore, 'content restored');
  assert.doesNotMatch(host.read('shared.txt'), /<<<<<<<|>>>>>>>/, 'no conflict markers left in the file');

  // The only thing left uncommitted is the aborted rollback's own record,
  // which documents the failed attempt and reserves its id.
  const leftover = host.porcelain().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(leftover, [`?? ${host.folder}/tasks/TASK-0004.json`], 'no project files left dirty');
  assert.equal(host.refs('refs/heads/tm-backup').length, 1, 'the backup was kept');

  // The failed attempt left an aborted record, not a completed one.
  assert.equal(host.task('TASK-0004').status, 'aborted');

  // And the repository is still fully usable.
  assertOk(host.tm('start-task.js', ['Still works']), 'start after conflict');
});

test('two rollbacks in quick succession get distinct backup branches', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two, three } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', three, '--execute']), 'first');
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'second');

  const backups = host.refs('refs/heads/tm-backup');
  assert.equal(backups.length, 2);
  assert.equal(new Set(backups).size, 2, 'branch names are unique');
});

test('rollback refuses an unknown task id', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  threeTasks(host);
  const result = assertFails(host.tm('rollback.js', ['task', 'TASK-0099']), 'unknown id');
  assert.match(result.stderr, /No completed task found with id TASK-0099/);
});

test('rollback requires a valid mode', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const result = assertFails(host.tm('rollback.js', ['sideways', 'TASK-0001']), 'bad mode');
  assert.match(result.stderr, /must be "task" or "to"/);
});
