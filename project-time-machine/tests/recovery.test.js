'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, assertOk, assertFails } = require('./helpers');

function threeTasks(host) {
  const one = host.doTask('Add alpha', (h) => h.write('alpha.txt', 'alpha v1\n'));
  const two = host.doTask('Add beta', (h) => h.write('beta.txt', 'beta v1\n'));
  const three = host.doTask('Add gamma', (h) => h.write('gamma.txt', 'gamma v1\n'));
  return { one, two, three };
}

test('recover previews by default and changes nothing', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  const head = host.gitOut(['rev-parse', 'HEAD']);

  const preview = assertOk(host.tm('recover.js'), 'preview');
  assert.match(preview.stdout, /Preview only/);
  assert.equal(host.gitOut(['rev-parse', 'HEAD']), head, 'HEAD unchanged');
  assert.equal(host.exists('beta.txt'), false, 'still rolled back');
});

test('recover undoes a rollback and brings the work back', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  assert.equal(host.exists('beta.txt'), false);

  const result = assertOk(host.tm('recover.js', ['--execute']), 'recover');
  assert.match(result.stdout, /Safety backup created and verified/);

  assert.equal(host.exists('alpha.txt'), true);
  assert.equal(host.exists('beta.txt'), true, 'the rolled-back work is back');
  assert.equal(host.read('beta.txt'), 'beta v1\n');
  assert.equal(host.exists('gamma.txt'), true);

  const record = host.task('TASK-0005');
  assert.equal(record.type, 'recovery');
  assert.equal(record.status, 'completed');
  assert.ok(host.tags().includes('task/TASK-0005'));
  assert.equal(host.gitOut(['cat-file', '-t', 'refs/tags/task/TASK-0005']), 'tag');

  assert.equal(host.porcelain(), '', 'clean tree');
  assertOk(host.tm('audit.js'), 'audit after recovery');
});

test('recovery keeps the audit trail of the rollback it undid', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  assertOk(host.tm('recover.js', ['--execute']), 'recover');

  assert.equal(host.exists(host.taskFile('TASK-0004')), true, 'the rollback record survives');
  assert.equal(host.task('TASK-0004').type, 'rollback');
  assert.equal(host.exists(host.taskFile('TASK-0005')), true, 'the recovery record exists');
});

test('recover --list shows backups and a specific one can be selected by index', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two, three } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', three, '--execute']), 'rollback gamma');
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback beta');

  const list = assertOk(host.tm('recover.js', ['--list']), 'list');
  assert.match(list.stdout, /2 backup\(s\)/);
  assert.match(list.stdout, /\[1\] tm-backup\//);
  assert.match(list.stdout, /\[2\] tm-backup\//);

  // Index 2 is the older backup: taken before gamma was rolled back.
  assertOk(host.tm('recover.js', ['2', '--execute']), 'recover from index 2');
  assert.equal(host.exists('gamma.txt'), true, 'gamma restored');
  assert.equal(host.exists('beta.txt'), true, 'beta restored');
});

test('a backup can be selected by branch name', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');

  const branch = host.refs('refs/heads/tm-backup')[0].replace('refs/heads/', '');
  assertOk(host.tm('recover.js', [branch, '--execute']), 'recover by name');
  assert.equal(host.exists('beta.txt'), true);
});

test('recovery is itself undoable via its own safety backup', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');
  assertOk(host.tm('recover.js', ['--execute']), 'recover');
  assert.equal(host.exists('beta.txt'), true);

  // The newest backup is the one recovery took before restoring.
  assertOk(host.tm('recover.js', ['1', '--execute']), 'undo the recovery');
  assert.equal(host.exists('beta.txt'), false, 'back to the rolled-back state');
  assertOk(host.tm('audit.js'), 'audit');
});

test('recover refuses a dirty tree, an active task and an unknown backup', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback');

  host.write('dirty.txt', 'x\n');
  assert.match(assertFails(host.tm('recover.js', ['--execute']), 'dirty').stderr, /uncommitted changes/);
  host.remove('dirty.txt');

  assertOk(host.tm('start-task.js', ['Busy']), 'start');
  assert.match(assertFails(host.tm('recover.js', ['--execute']), 'active').stderr, /is active/);
  assertOk(host.tm('abort-task.js', ['--execute']), 'abort');

  assert.match(assertFails(host.tm('recover.js', ['nope']), 'unknown').stderr, /No backup branch matches/);
});

test('recover reports clearly when there is nothing to recover from', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  threeTasks(host);
  const result = assertFails(host.tm('recover.js'), 'no backups');
  assert.match(result.stderr, /No Time Machine backup branch found/);
});

test('no backup branch is ever deleted automatically', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { two, three } = threeTasks(host);
  assertOk(host.tm('rollback.js', ['task', three, '--execute']), 'rollback 1');
  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'rollback 2');
  assertOk(host.tm('recover.js', ['--execute']), 'recover');

  assert.equal(host.refs('refs/heads/tm-backup').length, 3, 'two rollback backups plus one recovery safety backup');
});

test('a full three-task rollback and recovery cycle leaves a consistent audit', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const { one, two } = threeTasks(host);

  assertOk(host.tm('rollback.js', ['task', two, '--execute']), 'reverse beta');
  assertOk(host.tm('audit.js'), 'audit 1');

  assertOk(host.tm('recover.js', ['--execute']), 'recover beta');
  assertOk(host.tm('audit.js'), 'audit 2');

  assertOk(host.tm('rollback.js', ['to', one, '--execute']), 'restore to alpha');
  assertOk(host.tm('audit.js'), 'audit 3');

  assertOk(host.tm('recover.js', ['--execute']), 'recover from the restore');
  const audit = assertOk(host.tm('audit.js'), 'audit 4');
  assert.match(audit.stdout, /audit passed/);

  assert.equal(host.exists('alpha.txt'), true);
  assert.equal(host.exists('beta.txt'), true);
  assert.equal(host.exists('gamma.txt'), true);

  // Ids were never reused across all of that.
  const ids = host.tags().filter((tag) => tag.startsWith('task/'));
  assert.equal(new Set(ids).size, ids.length, 'every task tag is unique');
});
