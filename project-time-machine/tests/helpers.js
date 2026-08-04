'use strict';

/**
 * Integration-test harness.
 *
 * Every test runs the real scripts, as a real child process, against a real
 * temporary Git repository. Nothing about Git is mocked — the point of these
 * tests is that the Git behaviour is correct.
 *
 * Git configuration is fully isolated (GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM
 * point at empty files) so the machine running the suite cannot influence the
 * result through autocrlf, commit signing, default branch names or hooks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const TMP_BASE = process.env.TM_TEST_TMPDIR || os.tmpdir();
const DEFAULT_FOLDER = 'project-time-machine';

/** Only these entries make up a deliverable Time Machine folder. */
const DELIVERABLE = ['scripts', 'docs', 'setup.js'];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function mkdtemp(prefix) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, prefix)));
}

/**
 * A host project with the Time Machine copied in under `folder`.
 * `folder` may contain a slash (nested install) or a space.
 */
function createHost(options = {}) {
  const folder = options.folder || DEFAULT_FOLDER;

  // The isolated Git config files live OUTSIDE the project directory, so they
  // never show up as untracked files in the repository under test.
  const base = mkdtemp('tm-test-');
  const dir = path.join(base, 'host');
  fs.mkdirSync(dir, { recursive: true });

  const emptyGlobal = path.join(base, 'gitconfig-global');
  const emptySystem = path.join(base, 'gitconfig-system');
  fs.writeFileSync(emptyGlobal, '');
  fs.writeFileSync(emptySystem, '');

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_CONFIG_SYSTEM: emptySystem,
    GIT_AUTHOR_NAME: 'Time Machine Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Time Machine Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    TM_DEBUG: '1'
  };
  delete env.TM_ROOT;

  const tmDir = path.join(dir, folder);
  fs.mkdirSync(tmDir, { recursive: true });
  for (const entry of DELIVERABLE) {
    fs.cpSync(path.join(REPO, entry), path.join(tmDir, entry), { recursive: true });
  }

  const host = {
    dir,
    folder,
    tmDir,
    env,

    /** Absolute path for a project-relative path. */
    at(relative) {
      return path.join(dir, relative);
    },

    exec(program, args, execOptions = {}) {
      const result = cp.spawnSync(program, args, {
        cwd: execOptions.cwd || dir,
        env: { ...env, ...(execOptions.env || {}) },
        encoding: 'utf8',
        shell: false,
        maxBuffer: 64 * 1024 * 1024
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: (result.stdout || '').toString(),
        stderr: (result.stderr || '').toString(),
        get output() {
          return this.stdout + this.stderr;
        }
      };
    },

    git(args, execOptions) {
      return host.exec('git', args, execOptions);
    },

    /** Run a git command that must succeed, returning trimmed stdout. */
    gitOut(args) {
      const result = host.git(args);
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}):\n${result.stderr}`);
      }
      return result.stdout.trim();
    },

    /** Run a Time Machine script by file name, e.g. tm('status.js'). */
    tm(script, args = [], execOptions) {
      return host.exec('node', [path.join(folder, 'scripts', script), ...args], execOptions);
    },

    setup(args = ['--no-install']) {
      return host.exec('node', [path.join(folder, 'setup.js'), ...args]);
    },

    write(relative, content) {
      const target = host.at(relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },

    read(relative) {
      return fs.readFileSync(host.at(relative), 'utf8');
    },

    exists(relative) {
      return fs.existsSync(host.at(relative));
    },

    remove(relative) {
      rmrf(host.at(relative));
    },

    readJson(relative) {
      return JSON.parse(host.read(relative));
    },

    /** Path of a task record, relative to the project root. */
    taskFile(id) {
      return path.posix.join(folder.split(path.sep).join('/'), 'tasks', `${id}.json`);
    },

    task(id) {
      return host.readJson(host.taskFile(id));
    },

    /** Convenience: start a task, apply a mutation, complete it. */
    doTask(name, mutate, completeArgs = []) {
      const started = host.tm('start-task.js', [name]);
      if (started.status !== 0) throw new Error(`start-task failed:\n${started.output}`);
      const id = /(TASK-\d{4,})/.exec(started.stdout)[1];
      mutate(host);
      const completed = host.tm('complete-task.js', ['--summary', `Did: ${name}`, ...completeArgs]);
      if (completed.status !== 0) throw new Error(`complete-task failed:\n${completed.output}`);
      return id;
    },

    tags() {
      const out = host.gitOut(['tag', '--list']);
      return out ? out.split(/\r?\n/).filter(Boolean) : [];
    },

    refs(prefix) {
      const out = host.gitOut(['for-each-ref', '--format=%(refname)', prefix]);
      return out ? out.split(/\r?\n/).filter(Boolean) : [];
    },

    porcelain() {
      return host.gitOut(['status', '--porcelain']);
    },

    cleanup() {
      rmrf(base);
    }
  };

  if (options.setup !== false) {
    const result = host.setup(options.setupArgs || ['--no-install']);
    if (result.status !== 0) {
      throw new Error(`setup failed (${result.status}):\n${result.output}`);
    }
  }

  return host;
}

/** Assert a command succeeded, with the full output in the failure message. */
function assertOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} expected exit 0 but got ${result.status}:\n${result.output}`);
  }
  return result;
}

/** Assert a command failed, with the full output in the failure message. */
function assertFails(result, label) {
  if (result.status === 0) {
    throw new Error(`${label} expected a non-zero exit but succeeded:\n${result.output}`);
  }
  return result;
}

function idFrom(result) {
  const match = /(TASK-\d{4,})/.exec(result.stdout);
  if (!match) throw new Error(`No task id in output:\n${result.stdout}`);
  return match[1];
}

module.exports = { createHost, assertOk, assertFails, idFrom, rmrf, REPO };
