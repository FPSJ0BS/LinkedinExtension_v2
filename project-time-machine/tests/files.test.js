'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHost, assertOk, idFrom } = require('./helpers');

const find = (record, filePath) => record.files.find((entry) => entry.path === filePath);

test('added, modified and deleted files are recorded with the right change type', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  host.doTask('Create files', (h) => {
    h.write('keep.txt', 'keep\n');
    h.write('remove.txt', 'remove\n');
  });

  const id = host.doTask('Change files', (h) => {
    h.write('keep.txt', 'keep, modified\n');
    h.remove('remove.txt');
    h.write('added.txt', 'new\n');
  });

  const record = host.task(id);
  assert.equal(find(record, 'keep.txt').change, 'modified');
  assert.equal(find(record, 'remove.txt').change, 'deleted');
  assert.equal(find(record, 'added.txt').change, 'added');
  assert.equal(find(record, 'added.txt').wasUntracked, true, 'new files are flagged as previously untracked');
});

test('renames are recorded as renames with the original path', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  host.doTask('Create original', (h) => h.write('src/original.js', body));

  const id = host.doTask('Rename it', (h) => {
    fs.renameSync(h.at('src/original.js'), h.at('src/renamed.js'));
  });

  const record = host.task(id);
  const entry = find(record, 'src/renamed.js');
  assert.ok(entry, 'the new path is recorded');
  assert.equal(entry.change, 'renamed');
  assert.equal(entry.from, 'src/original.js');
});

test('copies are recorded when Git detects them', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const body = Array.from({ length: 60 }, (_, i) => `distinctive content line ${i}`).join('\n') + '\n';
  host.doTask('Create source', (h) => h.write('src/source.js', body));

  const id = host.doTask('Duplicate it', (h) => h.write('src/duplicate.js', body));
  const record = host.task(id);
  const entry = find(record, 'src/duplicate.js');
  assert.ok(entry, 'the copy is recorded');
  // Git reports this as either a copy or a plain addition depending on
  // detection settings; both are correct, an omission would not be.
  assert.ok(['copied', 'added'].includes(entry.change), `unexpected change type: ${entry.change}`);
});

test('paths containing spaces round-trip through record, commit and rollback', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const spaced = 'my source/deep folder/my component.tsx';
  const id = host.doTask('Add a spaced path', (h) => h.write(spaced, 'export const A = 1;\n'));

  const record = host.task(id);
  const entry = find(record, spaced);
  assert.ok(entry, `record should contain "${spaced}", got ${JSON.stringify(record.files)}`);
  assert.equal(entry.change, 'added');

  const inCommit = host.gitOut(['show', '--name-only', '--pretty=', `task/${id}`]);
  assert.ok(inCommit.includes(spaced), 'the commit contains the spaced path');

  assertOk(host.tm('rollback.js', ['task', id, '--execute']), 'rollback');
  assert.equal(host.exists(spaced), false, 'the spaced path was removed by the rollback');
});

test('renaming a file to a path with spaces is recorded correctly', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const body = Array.from({ length: 40 }, (_, i) => `content ${i}`).join('\n') + '\n';
  host.doTask('Create it', (h) => h.write('plain.txt', body));

  const id = host.doTask('Rename with spaces', (h) => {
    fs.mkdirSync(h.at('a folder'), { recursive: true });
    fs.renameSync(h.at('plain.txt'), h.at('a folder/a renamed file.txt'));
  });

  const entry = find(host.task(id), 'a folder/a renamed file.txt');
  assert.ok(entry, 'the spaced destination is recorded');
  assert.equal(entry.change, 'renamed');
  assert.equal(entry.from, 'plain.txt');
});

test('quotes and non-ASCII characters in paths are recorded verbatim', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const tricky = "src/café menü/résumé (final).md";
  const id = host.doTask('Unicode paths', (h) => h.write(tricky, '# hi\n'));

  const entry = find(host.task(id), tricky);
  assert.ok(entry, `record should contain "${tricky}", got ${JSON.stringify(host.task(id).files)}`);
  assert.equal(entry.change, 'added');
});

test('the Time Machine record files are excluded from the recorded file list', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const id = host.doTask('One real file', (h) => h.write('only.txt', 'x\n'));
  const record = host.task(id);
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].path, 'only.txt');
});

test('many files in one task are all recorded', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const id = host.doTask('Bulk add', (h) => {
    for (let i = 0; i < 25; i++) h.write(`bulk/file-${i}.txt`, `content ${i}\n`);
  });

  const record = host.task(id);
  assert.equal(record.files.length, 25);
  assert.ok(record.files.every((entry) => entry.change === 'added'));
});

test('a subdirectory of untracked files becomes individual recorded entries', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const id = host.doTask('Untracked tree', (h) => {
    h.write('newdir/a.txt', 'a\n');
    h.write('newdir/nested/b.txt', 'b\n');
  });

  const paths = host.task(id).files.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ['newdir/a.txt', 'newdir/nested/b.txt']);
});
