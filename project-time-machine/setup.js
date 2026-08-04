'use strict';

/**
 * Project Time Machine installer.
 *
 * Run from the host project root:
 *   node <time-machine-folder>/setup.js [--no-install] [--quiet]
 *
 * What it does, in order, failing loudly at every step:
 *   1. verifies the folder sits inside the project and is not gitignored
 *   2. initialises Git when needed and configures an identity when missing
 *   3. creates the Time Machine's own directories
 *   4. merges tm:* scripts into package.json, preserving every existing key,
 *      the original indentation and any existing scripts
 *   5. installs the chokidar dependency needed by the watcher
 *   6. writes agent pointer files (CLAUDE.md, AGENTS.md, .cursorrules, ...)
 *   7. stages ONLY the files it touched and creates one baseline commit
 *
 * Nothing here swallows a failure: every Git and npm invocation either
 * succeeds, or is reported with its stderr and reflected in the exit code.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/** Canonicalise so Windows 8.3 short names and drive-letter case cannot make
 *  the same directory compare as two different paths. */
function canonical(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    return resolved;
  }
}

const tm = canonical(__dirname);
const tmFolderName = path.basename(tm);
const root = canonical(process.env.TM_ROOT || process.cwd());
const selfHosted = tm === root;
const tmRelative = selfHosted ? '' : path.relative(root, tm).split(path.sep).join('/');
const tmPrefix = tmRelative ? `${tmRelative}/` : '';

const args = process.argv.slice(2);
const skipInstall = args.includes('--no-install');
const quiet = args.includes('--quiet');

const problems = [];
const touched = new Set();

function log(...parts) {
  if (!quiet) console.log(...parts);
}
function step(message) {
  log(`\n== ${message}`);
}
function ok(message) {
  log(`   ok      ${message}`);
}
function info(message) {
  log(`   ..      ${message}`);
}
function problem(message) {
  problems.push(message);
  console.error(`   FAILED  ${message}`);
}

function die(message) {
  console.error(`\nSetup aborted: ${message}`);
  process.exit(1);
}

/** Run a command. Throws with captured stderr; never returns on failure. */
function exec(program, argv, options = {}) {
  // Windows batch wrappers (npm.cmd) cannot be spawned without a shell since
  // Node's CVE-2024-27980 fix. Shell mode is only ever used for constant
  // argument lists. Arguments are collapsed into a single quoted command
  // string: passing an args array alongside shell:true is deprecated
  // (DEP0190), and quoting stops cmd.exe from eating the "^" in a semver
  // range like chokidar@^4.0.3.
  const useShell = Boolean(options.shell);
  const command = useShell ? [program, ...argv.map((arg) => `"${arg}"`)].join(' ') : program;
  const commandArgs = useShell ? [] : argv;

  const result = cp.spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    shell: useShell,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe'
  });
  if (result.error) {
    const error = new Error(`${program} could not be started: ${result.error.message}`);
    error.cause = result.error;
    throw error;
  }
  const stdout = (result.stdout || '').toString().trim();
  const stderr = (result.stderr || '').toString().trim();
  if (result.status !== 0) {
    const error = new Error(`${program} ${argv.join(' ')} exited with code ${result.status}${stderr ? `:\n${stderr}` : ''}`);
    error.status = result.status;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return stdout;
}

/** Run a command, returning {ok, stdout, stderr} instead of throwing. */
function tryExec(program, argv, options = {}) {
  try {
    return { ok: true, stdout: exec(program, argv, options), stderr: '' };
  } catch (error) {
    return { ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message };
  }
}

const git = (argv, options) => exec('git', argv, options);
const tryGit = (argv, options) => tryExec('git', argv, options);

// ---------------------------------------------------------------------------

log('Project Time Machine — setup');
log(`Project root:   ${root}`);
log(`Time Machine:   ${tmFolderName}/${selfHosted ? '  (self-hosted: the folder IS the project root)' : ''}`);

// -- 1. Location sanity ------------------------------------------------------
step('Checking location');
if (!selfHosted) {
  const relative = path.relative(root, tm);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    die(
      `the Time Machine folder is not inside the project root.\n` +
        `  folder: ${tm}\n  root:   ${root}\n` +
        'Run setup from the project root: node <time-machine-folder>/setup.js'
    );
  }
}
ok(`folder resolves to "${tmRelative || '.'}" relative to the project root`);

// -- 2. Git ------------------------------------------------------------------
step('Preparing Git');
const inWorkTree = tryGit(['rev-parse', '--is-inside-work-tree']);
if (!inWorkTree.ok || inWorkTree.stdout !== 'true') {
  try {
    git(['init']);
    ok('initialised a new Git repository');
  } catch (error) {
    die(`could not initialise a Git repository.\n${error.message}`);
  }
} else {
  const top = tryGit(['rev-parse', '--show-toplevel']);
  ok(`existing repository at ${top.ok ? top.stdout : '(unknown)'}`);
}

// Verify the init actually took effect rather than assuming it did.
const confirm = tryGit(['rev-parse', '--is-inside-work-tree']);
if (!confirm.ok || confirm.stdout !== 'true') {
  die(`${root} is still not a Git work tree after "git init".\n${confirm.stderr}`);
}

const userName = tryGit(['config', 'user.name']);
if (!userName.ok || !userName.stdout) {
  git(['config', 'user.name', 'Project Time Machine']);
  ok('configured user.name (was unset)');
} else {
  ok(`user.name = ${userName.stdout}`);
}

const userEmail = tryGit(['config', 'user.email']);
if (!userEmail.ok || !userEmail.stdout) {
  git(['config', 'user.email', 'time-machine@local.invalid']);
  ok('configured user.email (was unset)');
} else {
  ok(`user.email = ${userEmail.stdout}`);
}

// A gitignored Time Machine folder would silently break every task commit.
if (tmRelative) {
  const ignored = tryGit(['check-ignore', '-q', '--', tmRelative]);
  if (ignored.ok) {
    die(
      `the folder "${tmRelative}" is excluded by a .gitignore rule.\n` +
        'Task records must be committed. Remove the ignore rule, or add an exception:\n' +
        `  !${tmRelative}/`
    );
  }
}
ok('folder is not gitignored');

// -- 3. Directories ----------------------------------------------------------
step('Creating directories');
for (const dir of ['tasks', 'rollbacks', 'runtime']) {
  fs.mkdirSync(path.join(tm, dir), { recursive: true });
}
const runtimeIgnore = path.join(tm, 'runtime', '.gitignore');
if (!fs.existsSync(runtimeIgnore)) {
  fs.writeFileSync(runtimeIgnore, '*\n!.gitignore\n');
}
for (const [dir, file] of [['tasks', '.gitkeep'], ['rollbacks', '.gitkeep']]) {
  const keep = path.join(tm, dir, file);
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
}
touched.add(`${tmPrefix}tasks`);
touched.add(`${tmPrefix}rollbacks`);
touched.add(`${tmPrefix}runtime`);
ok('tasks/, rollbacks/, runtime/ ready');

// -- 4. package.json ---------------------------------------------------------
step('Updating package.json');
const pkgPath = path.join(root, 'package.json');

// A folder name containing a space must be quoted or npm would split it into
// two arguments.
const needsQuoting = /[\s'"]/.test(tmPrefix);
const command = (file, extra) => {
  const target = `${tmPrefix}scripts/${file}`;
  return `node ${needsQuoting ? `"${target}"` : target}${extra ? ` ${extra}` : ''}`;
};

const tmScripts = {
  'tm:status': command('status.js'),
  'tm:audit': command('audit.js'),
  'tm:start': command('start-task.js'),
  'tm:complete': command('complete-task.js'),
  'tm:abort': command('abort-task.js'),
  'tm:list': command('list-tasks.js'),
  'tm:rollback': command('rollback.js'),
  'tm:recover': command('recover.js'),
  'tm:watch': command('watch.js'),
  'tm:checkpoints': command('watch.js', 'list')
};

/** Detect the indentation the file already uses so formatting is preserved. */
function detectIndent(source) {
  const match = /\n([ \t]+)"/.exec(source);
  return match ? match[1] : '  ';
}

let pkg = {};
let indent = '  ';
let trailingNewline = true;
let pkgExisted = false;

if (fs.existsSync(pkgPath)) {
  pkgExisted = true;
  const source = fs.readFileSync(pkgPath, 'utf8');
  indent = detectIndent(source);
  trailingNewline = source.endsWith('\n');
  try {
    pkg = JSON.parse(source);
  } catch (error) {
    die(`package.json is not valid JSON and would be destroyed by editing it.\n${error.message}`);
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    die('package.json does not contain a JSON object.');
  }
  ok('parsed existing package.json (all existing fields preserved)');
} else {
  pkg = {
    name: path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '') || 'project',
    version: '0.0.0',
    private: true
  };
  ok('no package.json found; creating a minimal one');
}

const before = JSON.stringify(pkg);
if (!pkg.scripts || typeof pkg.scripts !== 'object') pkg.scripts = {};
for (const [name, command] of Object.entries(tmScripts)) {
  pkg.scripts[name] = command;
}
if (!pkg.devDependencies || typeof pkg.devDependencies !== 'object') pkg.devDependencies = {};
if (!pkg.devDependencies.chokidar && !(pkg.dependencies && pkg.dependencies.chokidar)) {
  pkg.devDependencies.chokidar = '^4.0.3';
}

if (JSON.stringify(pkg) !== before) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + (trailingNewline ? '\n' : ''));
  ok(`${pkgExisted ? 'updated' : 'created'} package.json with ${Object.keys(tmScripts).length} tm:* scripts`);
} else {
  ok('package.json already up to date');
}
touched.add('package.json');

// -- 5. Dependencies ---------------------------------------------------------
step('Installing dependencies');
let chokidarPresent = false;
try {
  require.resolve('chokidar', { paths: [root, tm] });
  chokidarPresent = true;
} catch (error) {
  chokidarPresent = false;
}

if (chokidarPresent) {
  ok('chokidar already installed');
} else if (skipInstall) {
  info('skipped (--no-install). The watcher needs: npm install --save-dev chokidar');
} else {
  const onWindows = process.platform === 'win32';
  info('running npm install (this can take a moment)...');
  // The argument list is a compile-time constant, so enabling the shell on
  // Windows introduces no injection surface.
  const install = tryExec(onWindows ? 'npm.cmd' : 'npm', ['install', '--save-dev', 'chokidar@^4.0.3'], {
    cwd: root,
    shell: onWindows
  });
  if (install.ok) {
    ok('installed chokidar');
    if (fs.existsSync(path.join(root, 'package-lock.json'))) touched.add('package-lock.json');
  } else {
    problem(
      'npm install failed. The watcher will not run until chokidar is installed.\n' +
        `            Run manually:  npm install --save-dev chokidar\n` +
        `            npm said: ${install.stderr.split('\n').slice(0, 4).join('\n                      ')}`
    );
  }
}

// -- 6. Ignore node_modules --------------------------------------------------
// Installing dependencies into a project with no ignore rule would leave
// thousands of untracked files, which the audit would (correctly) treat as
// unlogged changes and which would block every task.
step('Checking ignore rules');
if (fs.existsSync(path.join(root, 'node_modules'))) {
  const alreadyIgnored = tryGit(['check-ignore', '-q', '--', 'node_modules']).ok;
  if (alreadyIgnored) {
    ok('node_modules is already ignored');
  } else {
    const ignorePath = path.join(root, '.gitignore');
    const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
    const addition = `${existing && !existing.endsWith('\n') ? '\n' : ''}node_modules/\n`;
    fs.writeFileSync(ignorePath, existing + addition);
    touched.add('.gitignore');
    ok(`${existing ? 'appended node_modules/ to' : 'created'} .gitignore`);
  }
} else {
  ok('no node_modules directory present');
}

// -- 7. Agent pointer files --------------------------------------------------
step('Writing agent rule pointers');
const agentsDoc = `${tmPrefix}docs/AGENTS.md`;
const marker = 'Project Time Machine';
const pointer =
  `# ${marker}\n\n` +
  `This project uses the Project Time Machine. Before changing ANY file, read and follow:\n\n` +
  `- \`${agentsDoc}\` — mandatory workflow rules\n` +
  `- \`${tmPrefix}docs/checks.md\` — checks to run before completing a task\n` +
  `- \`${tmPrefix}docs/COMMANDS.md\` — the commands to use\n\n` +
  `Start every session with:\n\n` +
  '```bash\n' +
  `node ${tmPrefix}scripts/status.js\n` +
  `node ${tmPrefix}scripts/audit.js\n` +
  '```\n\n' +
  `No file may be created, edited, renamed, moved or deleted outside an active task.\n`;

for (const file of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.windsurfrules']) {
  const filePath = path.join(root, file);
  if (selfHosted && file === 'CLAUDE.md') {
    info('CLAUDE.md left untouched (self-hosted install)');
    continue;
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, pointer);
    ok(`created ${file}`);
    touched.add(file);
  } else {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(agentsDoc)) {
      ok(`${file} already points at ${agentsDoc}`);
    } else {
      fs.writeFileSync(filePath, content.replace(/\s*$/, '') + '\n\n' + pointer);
      ok(`appended the Time Machine pointer to ${file}`);
      touched.add(file);
    }
  }
}

// -- 8. Baseline commit ------------------------------------------------------
step('Creating the baseline commit');
const stagePaths = [...touched].filter((entry) => fs.existsSync(path.join(root, entry)));
const hasHead = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD']).ok;

if (tmRelative) {
  // Host install: stage the Time Machine folder plus the files we touched.
  stagePaths.push(tmRelative);
} else if (!hasHead) {
  // Self-hosted with no history yet: this really is the project's first
  // commit, so the whole tree belongs in the baseline.
  stagePaths.push('.');
} else {
  // Self-hosted with existing history: stay conservative and stage only the
  // tool's own directories, never the developer's unrelated work.
  stagePaths.push('scripts', 'docs', 'tests', 'setup.js');
}

const staged = [];
for (const entry of stagePaths) {
  const result = tryGit(['add', '--', entry]);
  if (result.ok) staged.push(entry);
  else if (!/did not match any files|pathspec/i.test(result.stderr)) {
    problem(`could not stage ${entry}: ${result.stderr}`);
  }
}

const pending = tryGit(['diff', '--cached', '--name-only']);
if (!pending.ok) {
  problem(`could not inspect the staging area: ${pending.stderr}`);
} else if (!pending.stdout) {
  ok('nothing new to commit; the baseline is already in place');
} else {
  const fileCount = pending.stdout.split('\n').filter(Boolean).length;
  const commit = tryGit(['commit', '--no-verify', '-m', 'chore: install project time machine']);
  if (commit.ok) {
    const hash = tryGit(['rev-parse', 'HEAD']);
    ok(`committed ${fileCount} file(s)${hash.ok ? ` as ${hash.stdout.slice(0, 10)}` : ''}`);
    ok('unrelated changes in your working tree were left unstaged');
  } else {
    problem(`the baseline commit failed: ${commit.stderr}`);
  }
}

// -- Summary -----------------------------------------------------------------
log('');
if (problems.length) {
  console.error(`Setup finished with ${problems.length} problem(s). See FAILED lines above.`);
  process.exit(1);
}

log('Setup complete.');
log('');
log('Next steps:');
log(`  node ${tmPrefix}scripts/status.js       # check state (run at every session start)`);
log(`  node ${tmPrefix}scripts/audit.js        # verify records, commits and tags`);
log(`  node ${tmPrefix}scripts/start-task.js "My change"`);
log('');
log(`Give your coding agent the text in ${tmPrefix}docs/START_PROMPT.txt`);
