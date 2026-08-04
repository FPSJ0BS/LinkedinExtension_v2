'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, assertOk, assertFails, idFrom } = require('./helpers');

test('a completed task produces a record, a commit and an annotated tag', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const started = assertOk(host.tm('start-task.js', ['Add greeting']), 'start');
  const id = idFrom(started);
  host.write('src/greet.js', 'module.exports = () => "hi";\n');
  assertOk(host.tm('complete-task.js', ['--summary', 'Added greeting', '--check', 'tests passed']), 'complete');

  const record = host.task(id);
  assert.equal(record.status, 'completed');
  assert.equal(record.type, 'change');
  assert.equal(record.result, 'Added greeting');
  assert.deepEqual(record.checks, ['tests passed']);
  assert.ok(record.completedAt);
  assert.equal(record.gitRef, `task/${id}`);

  assert.ok(host.tags().includes(`task/${id}`), 'tag exists');
  assert.equal(host.gitOut(['cat-file', '-t', `refs/tags/task/${id}`]), 'tag', 'tag is annotated');
  assert.equal(
    host.gitOut(['rev-list', '-n', '1', `task/${id}`]),
    host.gitOut(['rev-parse', 'HEAD']),
    'tag points at the task commit'
  );
  assert.equal(host.porcelain(), '', 'working tree is clean');
});

test('the commit contains the task record, binding the three artifacts', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const id = host.doTask('Bind artifacts', (h) => h.write('a.txt', 'a\n'));
  const commit = host.gitOut(['rev-list', '-n', '1', `task/${id}`]);
  const inCommit = host.gitOut(['show', '--name-only', '--pretty=', commit]);
  assert.match(inCommit, new RegExp(`${host.folder}/tasks/${id}\\.json`));
});

test('a second task cannot start while one is active', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  assertOk(host.tm('start-task.js', ['First']), 'start first');
  const second = assertFails(host.tm('start-task.js', ['Second']), 'start second');
  assert.match(second.stderr, /while task TASK-0001 is active/);
});

test('a task cannot start with unlogged changes already present', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.write('stray.txt', 'made outside a task\n');
  const result = assertFails(host.tm('start-task.js', ['Should refuse']), 'start');
  assert.match(result.stderr, /Uncommitted changes exist before the task started/);
  assert.match(result.stderr, /stray\.txt/);
});

test('completing a task with no project change is refused, and allowed with --allow-empty', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  assertOk(host.tm('start-task.js', ['Nothing to do']), 'start');
  const refused = assertFails(host.tm('complete-task.js', ['--summary', 'nothing']), 'complete');
  assert.match(refused.stderr, /No project changes detected/);

  assertOk(host.tm('complete-task.js', ['--summary', 'deliberate no-op', '--allow-empty']), 'complete empty');
  assert.equal(host.task('TASK-0001').status, 'completed');
});

test('completed records are immutable — a second completion is refused', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('One', (h) => h.write('one.txt', '1\n'));
  const again = assertFails(host.tm('complete-task.js', ['--summary', 'again']), 'second complete');
  assert.match(again.stderr, /No active task/);
});

test('abort releases the lock, marks the record aborted, and keeps the files', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  assertOk(host.tm('start-task.js', ['Will be abandoned']), 'start');
  host.write('draft.txt', 'work in progress\n');

  const preview = assertOk(host.tm('abort-task.js'), 'abort preview');
  assert.match(preview.stdout, /Preview only/);
  assert.equal(host.task('TASK-0001').status, 'active', 'preview changed nothing');

  assertOk(host.tm('abort-task.js', ['--execute', '--reason', 'changed my mind']), 'abort');
  const record = host.task('TASK-0001');
  assert.equal(record.status, 'aborted');
  assert.equal(record.abortReason, 'changed my mind');
  assert.equal(host.read('draft.txt'), 'work in progress\n', 'files kept');
});

test('an aborted id is never reused', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  assertOk(host.tm('start-task.js', ['Abandoned']), 'start');
  assertOk(host.tm('abort-task.js', ['--execute']), 'abort');
  host.remove('draft.txt');

  const started = assertOk(host.tm('start-task.js', ['Next one']), 'start next');
  assert.equal(idFrom(started), 'TASK-0002');
});

test('task ids are not reused after a hard reset destroys the records', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('One', (h) => h.write('one.txt', '1\n'));
  host.doTask('Two', (h) => h.write('two.txt', '2\n'));
  host.doTask('Three', (h) => h.write('three.txt', '3\n'));

  const firstCommit = host.gitOut(['rev-list', '-n', '1', 'task/TASK-0001']);
  assertOk(host.git(['reset', '--hard', firstCommit]), 'destructive reset');

  assert.equal(host.exists(host.taskFile('TASK-0002')), false, 'records really are gone');
  assert.ok(host.tags().includes('task/TASK-0003'), 'tags survive a reset');

  const started = assertOk(host.tm('start-task.js', ['After the reset']), 'start');
  assert.equal(idFrom(started), 'TASK-0004', 'id continues past the destroyed records');
});

test('task ids are not reused after both the records and the runtime state are lost', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('One', (h) => h.write('one.txt', '1\n'));
  host.doTask('Two', (h) => h.write('two.txt', '2\n'));

  const firstCommit = host.gitOut(['rev-list', '-n', '1', 'task/TASK-0001']);
  assertOk(host.git(['reset', '--hard', firstCommit]), 'reset');
  // Simulate a fresh clone: runtime/ is gitignored so it would not be present.
  host.remove(`${host.folder}/runtime`);

  const started = assertOk(host.tm('start-task.js', ['After losing runtime']), 'start');
  assert.equal(idFrom(started), 'TASK-0003', 'tags alone are enough to avoid reuse');
});

test('status and audit detect an interrupted task whose record stayed active', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Real work', (h) => h.write('real.txt', 'x\n'));

  // Simulate a crash between writing the record and writing the lock.
  const orphan = { ...host.task('TASK-0001'), id: 'TASK-0002', status: 'active', completedAt: null };
  host.write(host.taskFile('TASK-0002'), JSON.stringify(orphan, null, 2));

  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /interrupted-task/);
  assert.match(audit.stdout, /TASK-0002/);
});

test('a stale lock pointing at a missing record is detected and repairable', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.write(`${host.folder}/runtime/active-task.json`, JSON.stringify({ id: 'TASK-0009', name: 'ghost' }, null, 2));

  const status = assertFails(host.tm('status.js'), 'status');
  assert.match(status.stdout, /STALE/);

  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /active-lock/);

  const blocked = assertFails(host.tm('start-task.js', ['Blocked']), 'start');
  assert.match(blocked.stderr, /abort-task\.js/);

  assertOk(host.tm('abort-task.js', ['--execute']), 'abort');
  assertOk(host.tm('status.js'), 'status after repair');
  assertOk(host.tm('start-task.js', ['Now allowed']), 'start after repair');
});

test('a malformed lock file is detected and repairable', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.write(`${host.folder}/runtime/active-task.json`, '{ not json');

  const status = assertFails(host.tm('status.js'), 'status');
  assert.match(status.stdout, /MALFORMED/);

  assertOk(host.tm('abort-task.js', ['--execute']), 'abort');
  assertOk(host.tm('status.js'), 'status after repair');
});

test('a malformed task record is reported, not crashed on', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Good', (h) => h.write('good.txt', 'g\n'));
  host.write(host.taskFile('TASK-0002'), '{ "id": "TASK-0002", broken');

  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /malformed-record/);
  assert.match(audit.stdout, /TASK-0002\.json/);

  const list = assertOk(host.tm('list-tasks.js'), 'list');
  assert.match(list.stdout, /malformed/);

  // The malformed id is still treated as used.
  host.remove(host.taskFile('TASK-0002'));
  host.write(host.taskFile('TASK-0002'), '{ "id": "TASK-0002", broken');
  const started = assertOk(host.tm('start-task.js', ['Next']), 'start');
  assert.equal(idFrom(started), 'TASK-0003');
});

test('audit detects a missing tag and an orphaned tag', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Tagged', (h) => h.write('t.txt', 't\n'));
  assertOk(host.git(['tag', '-d', 'task/TASK-0001']), 'delete tag');

  let audit = assertFails(host.tm('audit.js'), 'audit missing tag');
  assert.match(audit.stdout, /missing-tag/);

  assertOk(host.git(['tag', '-a', 'task/TASK-0001', '-m', 'restored']), 'recreate tag');
  assertOk(host.tm('audit.js'), 'audit clean again');

  assertOk(host.git(['tag', '-a', 'task/TASK-0077', '-m', 'orphan']), 'orphan tag');
  audit = assertFails(host.tm('audit.js'), 'audit orphan tag');
  assert.match(audit.stdout, /orphaned-tag/);
});

test('audit rejects a lightweight task tag', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Tagged', (h) => h.write('t.txt', 't\n'));
  assertOk(host.git(['tag', '-d', 'task/TASK-0001']), 'delete');
  assertOk(host.git(['tag', 'task/TASK-0001']), 'lightweight tag');

  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /lightweight-tag/);
});

test('audit detects unlogged changes made outside a task', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.write('rogue.txt', 'edited with no task\n');
  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /unlogged-changes/);
  assert.match(audit.stdout, /rogue\.txt/);
});

test('audit detects package scripts left pointing at the old folder name', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const pkg = host.readJson('package.json');
  pkg.scripts['tm:status'] = 'node some-old-name/scripts/status.js';
  host.write('package.json', JSON.stringify(pkg, null, 2) + '\n');

  const audit = assertFails(host.tm('audit.js'), 'audit');
  assert.match(audit.stdout, /stale-tm-script/);
});

test('status reports a clean installation and exits zero', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const result = assertOk(host.tm('status.js'), 'status');
  assert.match(result.stdout, /Active task:\s+none/);
  assert.match(result.stdout, /Working tree:\s+clean/);
  assert.match(result.stdout, /Next step:\s+start-task\.js/);

  const json = JSON.parse(assertOk(host.tm('status.js', ['--json']), 'status json').stdout);
  assert.equal(json.repository, true);
  assert.equal(json.active.state, 'none');
  assert.equal(json.workingTree.dirty, false);
});

test('audit --json reports machine-readable results', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Something', (h) => h.write('s.txt', 's\n'));
  const result = assertOk(host.tm('audit.js', ['--json']), 'audit json');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.errors, []);
});
