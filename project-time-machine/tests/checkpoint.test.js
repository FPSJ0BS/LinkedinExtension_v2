'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, assertOk, assertFails } = require('./helpers');

test('a checkpoint stores a ref without touching HEAD, the branch or the index', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));

  const headBefore = host.gitOut(['rev-parse', 'HEAD']);
  const branchBefore = host.gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);

  host.write('app.js', 'v2 made outside a task\n');
  host.write('scratch.txt', 'untracked scratch\n');
  const statusBefore = host.porcelain();

  const result = assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');
  assert.match(result.stdout, /checkpoint /);

  assert.equal(host.gitOut(['rev-parse', 'HEAD']), headBefore, 'HEAD did not move');
  assert.equal(host.gitOut(['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore, 'branch unchanged');
  assert.equal(host.porcelain(), statusBefore, 'the index and working tree are untouched');

  const refs = host.refs('refs/tm-checkpoint');
  assert.equal(refs.length, 1, 'exactly one checkpoint ref');
  assert.match(refs[0], /^refs\/tm-checkpoint\//);
});

test('a checkpoint is not a task and does not appear in the task records', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));
  host.write('app.js', 'v2\n');
  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');

  const list = assertOk(host.tm('list-tasks.js'), 'list');
  assert.doesNotMatch(list.stdout, /AUTO-/);
  assert.equal(host.tags().filter((tag) => tag.startsWith('task/')).length, 1, 'no task tag was created');

  const taskFiles = host.gitOut(['ls-files', `${host.folder}/tasks`]);
  assert.doesNotMatch(taskFiles, /AUTO/);
});

test('a checkpoint captures untracked files', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('kept.txt', 'kept\n'));
  host.write('brand new.txt', 'never tracked\n');

  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');
  const ref = host.refs('refs/tm-checkpoint')[0];
  const listed = host.gitOut(['ls-tree', '-r', '--name-only', ref]);
  assert.match(listed, /brand new\.txt/, 'the untracked file with a space is in the snapshot');
});

test('a checkpoint is skipped when the tree matches HEAD', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));
  const result = assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');
  assert.match(result.stdout, /No checkpoint created/);
  assert.equal(host.refs('refs/tm-checkpoint').length, 0);
});

test('an unchanged tree does not accumulate duplicate checkpoints', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));
  host.write('app.js', 'v2\n');

  assertOk(host.tm('watch.js', ['checkpoint']), 'first');
  const second = assertOk(host.tm('watch.js', ['checkpoint']), 'second');
  assert.match(second.stdout, /No checkpoint created/);
  assert.equal(host.refs('refs/tm-checkpoint').length, 1);
});

test('checkpoints can be listed and inspected', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));

  const empty = assertOk(host.tm('watch.js', ['list']), 'list empty');
  assert.match(empty.stdout, /No checkpoints stored/);

  host.write('app.js', 'v2\n');
  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');

  const list = assertOk(host.tm('watch.js', ['list']), 'list');
  assert.match(list.stdout, /1 checkpoint\(s\)/);
  assert.match(list.stdout, /\[1\]/);

  const show = assertOk(host.tm('watch.js', ['show', '1']), 'show');
  assert.match(show.stdout, /app\.js/);
});

test('restoring a checkpoint previews first, then recovers lost work as a task', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));

  // Work done outside a task, then lost.
  host.write('app.js', 'v2 important work\n');
  host.write('extra.txt', 'also important\n');
  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');

  assertOk(host.git(['checkout', '--', 'app.js']), 'discard');
  host.remove('extra.txt');
  assert.equal(host.read('app.js'), 'v1\n');
  assert.equal(host.porcelain(), '', 'tree is clean again');

  const preview = assertOk(host.tm('watch.js', ['restore', '1']), 'preview');
  assert.match(preview.stdout, /Preview only/);
  assert.equal(host.read('app.js'), 'v1\n', 'preview changed nothing');

  const result = assertOk(host.tm('watch.js', ['restore', '1', '--execute']), 'restore');
  assert.match(result.stdout, /Safety backup created and verified/);

  assert.equal(host.read('app.js'), 'v2 important work\n', 'lost work recovered');
  assert.equal(host.exists('extra.txt'), true);

  const record = host.task('TASK-0002');
  assert.equal(record.type, 'checkpoint-restore');
  assert.equal(record.status, 'completed');
  assert.ok(host.tags().includes('task/TASK-0002'), 'the restore is a tracked task');
  assertOk(host.tm('audit.js'), 'audit after restore');
});

test('restoring a checkpoint refuses a dirty tree or an active task', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v1\n'));
  host.write('app.js', 'v2\n');
  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');

  const dirty = assertFails(host.tm('watch.js', ['restore', '1', '--execute']), 'dirty');
  assert.match(dirty.stderr, /uncommitted changes/);

  assertOk(host.git(['checkout', '--', 'app.js']), 'clean up');
  assertOk(host.tm('start-task.js', ['Busy']), 'start');
  const active = assertFails(host.tm('watch.js', ['restore', '1', '--execute']), 'active');
  assert.match(active.stderr, /is active/);
});

test('prune previews, then deletes only the checkpoints beyond --keep', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Baseline', (h) => h.write('app.js', 'v0\n'));
  for (let i = 1; i <= 3; i++) {
    host.write('app.js', `v${i}\n`);
    assertOk(host.tm('watch.js', ['checkpoint']), `checkpoint ${i}`);
  }
  assert.equal(host.refs('refs/tm-checkpoint').length, 3);

  const preview = assertOk(host.tm('watch.js', ['prune', '--keep', '1']), 'prune preview');
  assert.match(preview.stdout, /Preview only/);
  assert.equal(host.refs('refs/tm-checkpoint').length, 3, 'preview deleted nothing');

  assertOk(host.tm('watch.js', ['prune', '--keep', '1', '--execute']), 'prune');
  assert.equal(host.refs('refs/tm-checkpoint').length, 1);
});

test('prune never touches backup branches', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const one = host.doTask('One', (h) => h.write('one.txt', '1\n'));
  host.doTask('Two', (h) => h.write('two.txt', '2\n'));
  assertOk(host.tm('rollback.js', ['task', one, '--execute']), 'rollback');

  host.write('scratch.txt', 'x\n');
  assertOk(host.tm('watch.js', ['checkpoint']), 'checkpoint');

  assertOk(host.tm('watch.js', ['prune', '--keep', '0', '--execute']), 'prune all');
  assert.equal(host.refs('refs/tm-checkpoint').length, 0);
  assert.equal(host.refs('refs/heads/tm-backup').length, 1, 'the backup branch survived');
});

test('the watcher rejects an unknown subcommand', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const result = assertFails(host.tm('watch.js', ['nonsense']), 'unknown command');
  assert.match(result.stderr, /Unknown watcher command/);
});
