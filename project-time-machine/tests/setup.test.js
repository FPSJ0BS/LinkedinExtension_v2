'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHost, assertOk, assertFails } = require('./helpers');

test('setup initialises Git in a directory that is not a repository', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assert.equal(host.git(['rev-parse', '--is-inside-work-tree']).status !== 0, true, 'precondition: not a repo');

  const result = assertOk(host.setup(), 'setup');
  assert.match(result.stdout, /initialised a new Git repository/);

  assert.equal(host.gitOut(['rev-parse', '--is-inside-work-tree']), 'true');
  assert.ok(host.gitOut(['rev-parse', 'HEAD']).length >= 7, 'a baseline commit exists');
  assert.match(host.gitOut(['log', '-1', '--pretty=%s']), /install project time machine/);
});

test('setup configures a Git identity only when one is missing', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assertOk(host.git(['init']), 'git init');
  assertOk(host.git(['config', 'user.name', 'Existing Person']), 'set name');
  assertOk(host.git(['config', 'user.email', 'existing@example.invalid']), 'set email');

  const result = assertOk(host.setup(), 'setup');
  assert.match(result.stdout, /user\.name = Existing Person/);
  assert.equal(host.gitOut(['config', 'user.name']), 'Existing Person');
  assert.equal(host.gitOut(['config', 'user.email']), 'existing@example.invalid');
});

test('setup preserves every existing package.json field, script and indentation', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  const original = {
    name: 'my-app',
    version: '3.1.4',
    description: 'do not lose me',
    scripts: { build: 'vite build', test: 'vitest' },
    dependencies: { react: '^18.0.0' },
    customTopLevelKey: { nested: ['a', 'b'] }
  };
  host.write('package.json', JSON.stringify(original, null, 4) + '\n');

  assertOk(host.setup(), 'setup');

  const pkg = host.readJson('package.json');
  assert.equal(pkg.name, 'my-app');
  assert.equal(pkg.version, '3.1.4');
  assert.equal(pkg.description, 'do not lose me');
  assert.deepEqual(pkg.customTopLevelKey, { nested: ['a', 'b'] });
  assert.deepEqual(pkg.dependencies, { react: '^18.0.0' });
  assert.equal(pkg.scripts.build, 'vite build', 'existing script untouched');
  assert.equal(pkg.scripts.test, 'vitest', 'existing script untouched');
  assert.equal(pkg.scripts['tm:status'], `node ${host.folder}/scripts/status.js`);
  assert.ok(pkg.devDependencies.chokidar, 'chokidar declared');

  const raw = host.read('package.json');
  assert.match(raw, /\n {4}"name"/, 'original 4-space indentation preserved');
  assert.ok(raw.endsWith('\n'), 'trailing newline preserved');
});

test('setup creates a package.json when the project has none', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assertOk(host.setup(), 'setup');
  const pkg = host.readJson('package.json');
  assert.equal(pkg.private, true);
  assert.ok(pkg.scripts['tm:audit']);
  assert.ok(pkg.devDependencies.chokidar);
});

test('setup stages only its own files and leaves unrelated changes unstaged', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assertOk(host.git(['init']), 'git init');
  host.write('existing.txt', 'committed\n');
  assertOk(host.git(['add', 'existing.txt']), 'add');
  assertOk(host.git(['commit', '-m', 'initial']), 'commit');

  host.write('existing.txt', 'locally modified, not mine to commit\n');
  host.write('unrelated-new.txt', 'also not mine\n');

  assertOk(host.setup(), 'setup');

  const committed = host.gitOut(['show', '--name-only', '--pretty=', 'HEAD']);
  assert.ok(!committed.includes('existing.txt'), 'unrelated modification not committed');
  assert.ok(!committed.includes('unrelated-new.txt'), 'unrelated new file not committed');
  assert.equal(host.read('existing.txt'), 'locally modified, not mine to commit\n');

  const status = host.porcelain();
  assert.match(status, /existing\.txt/, 'unrelated modification still pending');
  assert.match(status, /unrelated-new\.txt/, 'unrelated new file still untracked');
});

test('setup is idempotent — a second run creates no second commit', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assertOk(host.setup(), 'first setup');
  const first = host.gitOut(['rev-parse', 'HEAD']);

  const second = assertOk(host.setup(), 'second setup');
  assert.match(second.stdout, /nothing new to commit|already up to date/);
  assert.equal(host.gitOut(['rev-parse', 'HEAD']), first, 'HEAD unchanged');
});

test('setup refuses to run when the folder is gitignored', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  assertOk(host.git(['init']), 'git init');
  host.write('.gitignore', `${host.folder}/\n`);

  const result = assertFails(host.setup(), 'setup with ignored folder');
  assert.match(result.stderr, /excluded by a \.gitignore rule/);
});

test('setup refuses to run from outside the project root', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  const elsewhere = host.at('elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });

  const result = host.exec('node', [path.join('..', host.folder, 'setup.js'), '--no-install'], { cwd: elsewhere });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not inside the project root/);
});

test('setup never destroys a package.json it cannot parse', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  // Node itself refuses to launch any script whose nearest parent package.json
  // is unparseable or is not an object (ERR_INVALID_PACKAGE_CONFIG), so setup
  // is usually stopped before its own guard runs. The guaranteed property is
  // the one that matters: the run fails and the file is never rewritten.
  for (const broken of ['{ this is not json ', '["not", "an", "object"]']) {
    host.write('package.json', broken);
    assertFails(host.setup(), `setup with package.json = ${broken}`);
    assert.equal(host.read('package.json'), broken, 'file left byte-identical');
  }
});

test('setup writes agent pointer files that name the real folder', (t) => {
  const host = createHost({ folder: 'tools/history', setup: false });
  t.after(() => host.cleanup());

  assertOk(host.setup(), 'setup');

  for (const file of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.windsurfrules']) {
    assert.ok(host.exists(file), `${file} created`);
    assert.match(host.read(file), /tools\/history\/docs\/AGENTS\.md/);
  }
});

test('setup appends to an existing pointer file without clobbering it', (t) => {
  const host = createHost({ setup: false });
  t.after(() => host.cleanup());

  host.write('CLAUDE.md', '# My existing instructions\n\nKeep me.\n');
  assertOk(host.setup(), 'setup');

  const content = host.read('CLAUDE.md');
  assert.match(content, /My existing instructions/);
  assert.match(content, /Keep me\./);
  assert.match(content, new RegExp(`${host.folder}/docs/AGENTS\\.md`));
});

test('the whole workflow works from a renamed, nested folder', (t) => {
  const host = createHost({ folder: 'tools/deeply/nested-tm' });
  t.after(() => host.cleanup());

  assertOk(host.tm('status.js'), 'status');
  const id = host.doTask('Renamed folder task', (h) => h.write('src/app.js', 'console.log(1);\n'));
  assert.equal(id, 'TASK-0001');

  assert.ok(host.exists('tools/deeply/nested-tm/tasks/TASK-0001.json'));
  assert.ok(host.tags().includes('task/TASK-0001'));
  assertOk(host.tm('audit.js'), 'audit after task in nested folder');

  const pkg = host.readJson('package.json');
  assert.equal(pkg.scripts['tm:start'], 'node tools/deeply/nested-tm/scripts/start-task.js');
});

test('the whole workflow works from a folder whose name contains spaces', (t) => {
  const host = createHost({ folder: 'my time machine' });
  t.after(() => host.cleanup());

  const id = host.doTask('Task from a spaced folder', (h) => h.write('src/index.js', 'export default 1;\n'));
  assert.equal(id, 'TASK-0001');
  assert.ok(host.exists('my time machine/tasks/TASK-0001.json'));

  const pkg = host.readJson('package.json');
  assert.equal(pkg.scripts['tm:status'], 'node "my time machine/scripts/status.js"', 'path is quoted for npm');

  assertOk(host.tm('audit.js'), 'audit with a spaced folder name');
});

test('a dotted folder name is supported', (t) => {
  const host = createHost({ folder: '.time-machine' });
  t.after(() => host.cleanup());

  host.doTask('Dotted folder task', (h) => h.write('a.txt', 'a\n'));
  assert.ok(host.exists('.time-machine/tasks/TASK-0001.json'));
  assertOk(host.tm('audit.js'), 'audit');
});

test('no script or document hardcodes the old folder name or a missing installer', (t) => {
  const host = createHost();
  t.after(() => host.cleanup());

  const result = assertOk(host.tm('audit.js'), 'audit');
  assert.doesNotMatch(result.stdout, /doc-hardcoded-folder|script-hardcoded-folder|doc-bad-installer/);

  // Belt and braces: check the shipped files directly.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|md|txt|json)$/i.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('.project-time-machine')) offenders.push(`${full}: hardcoded folder`);
        if (/scripts\/install\.js/.test(content)) offenders.push(`${full}: references scripts/install.js`);
      }
    }
  };
  walk(host.tmDir);
  assert.deepEqual(offenders, []);
});
