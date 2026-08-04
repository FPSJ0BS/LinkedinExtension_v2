'use strict';

/**
 * Project Time Machine — shared core.
 *
 * Design rules enforced here:
 *  - The Time Machine folder name is never hardcoded. Every path is derived
 *    from __dirname so the folder can be renamed freely.
 *  - Git is the source of truth. JSON records are an index over it.
 *  - Records are written atomically and completed records are immutable.
 *  - Task IDs are allocated from the union of records, annotated tags and a
 *    gitignored high-water mark, so an id is never reused after a reset,
 *    recovery or branch change.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SCHEMA_VERSION = 2;

/**
 * Canonicalise a path so two references to the same directory always compare
 * equal. This matters on Windows, where `process.cwd()` and
 * `git rev-parse --show-toplevel` routinely disagree about 8.3 short names
 * (C:\Users\RUNNER~1 vs C:\Users\runneradmin) and drive-letter case. Without
 * it, path.relative() between them produces a long `../..` chain and every
 * repo-relative path breaks.
 */
function canonical(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    return resolved;
  }
}

const tm = canonical(path.resolve(__dirname, '..'));
const tmFolderName = path.basename(tm);
const scriptsDir = path.join(tm, 'scripts');
const tasksDir = path.join(tm, 'tasks');
const rollbacksDir = path.join(tm, 'rollbacks');
const runtimeDir = path.join(tm, 'runtime');
const docsDir = path.join(tm, 'docs');
const activePath = path.join(runtimeDir, 'active-task.json');
const highWaterPath = path.join(runtimeDir, 'id-high-water.json');

const root = canonical(process.env.TM_ROOT || process.cwd());

const CHECKPOINT_REF_PREFIX = 'refs/tm-checkpoint';
const BACKUP_REF_PREFIX = 'refs/heads/tm-backup';
const TASK_ID_PATTERN = /^TASK-(\d{4,})$/;

const TASK_TYPES = ['change', 'rollback', 'restore', 'recovery', 'checkpoint-restore'];

// ---------------------------------------------------------------------------
// Errors and process helpers
// ---------------------------------------------------------------------------

class TimeMachineError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TimeMachineError';
    this.details = details;
  }
}

function fail(message, details) {
  throw new TimeMachineError(message, details);
}

/**
 * Run a program. Never swallows failures: a non-zero exit or a spawn error
 * always throws with the captured stderr/stdout attached.
 */
function run(program, args = [], options = {}) {
  const result = cp.spawnSync(program, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.inherit ? 'inherit' : 'pipe'
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(`Required program not found on PATH: ${program}`);
    }
    throw result.error;
  }

  const stdout = (result.stdout || '').toString();
  const stderr = (result.stderr || '').toString();

  if (result.status !== 0) {
    if (options.allowFailure) {
      return { ok: false, status: result.status, stdout: stdout.trim(), stderr: stderr.trim() };
    }
    const details = (stderr || stdout).trim();
    fail(`${program} ${args.join(' ')} failed with exit code ${result.status}${details ? `:\n${details}` : ''}`, {
      program,
      args,
      status: result.status,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    });
  }

  if (options.allowFailure) {
    return { ok: true, status: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  }
  return stdout.trim();
}

function git(args, options = {}) {
  return run('git', args, options);
}

/** Run git and return true/false instead of throwing. */
function gitOk(args) {
  return git(args, { allowFailure: true }).ok;
}

/** Run git, returning trimmed stdout or null when the command fails. */
function gitTry(args) {
  const res = git(args, { allowFailure: true });
  return res.ok ? res.stdout : null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

let atomicCounter = 0;

function ensureDirs() {
  for (const dir of [tm, tasksDir, rollbacksDir, runtimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const gitignore = path.join(runtimeDir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, '*\n!.gitignore\n');
  }
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse without throwing; used by audit to report malformed records. */
function readJsonSafe(file) {
  try {
    return { ok: true, value: readJson(file) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, rename.
 * A crash mid-write can never leave a truncated record behind.
 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${atomicCounter++}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function removeFileIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function safeStamp() {
  return now().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Repository context
// ---------------------------------------------------------------------------

function insideRepo() {
  return gitTry(['rev-parse', '--is-inside-work-tree']) === 'true';
}

function requireRepo() {
  if (!insideRepo()) {
    fail(`Not a Git repository: ${root}\nRun the Time Machine setup script first: node ${tmFolderName}/setup.js`);
  }
}

/** Absolute path of the repository root, or null outside a repo. */
function repoTopLevel() {
  const top = gitTry(['rev-parse', '--show-toplevel']);
  return top ? canonical(top) : null;
}

/**
 * The Time Machine folder as a repo-root-relative POSIX path.
 * Empty string when the folder IS the repository root, which happens while
 * developing the Time Machine itself (it dogfoods its own workflow).
 */
function tmRepoRelative() {
  const top = repoTopLevel();
  const base = top || root;
  return path.relative(base, tm).split(path.sep).join('/');
}

/** Join a child directory onto the Time Machine's repo-relative path. */
function tmChildPath(child) {
  const rel = tmRepoRelative();
  return rel ? `${rel}/${child}` : child;
}

/** Pathspec that is always resolved from the repo root, wildcards disabled. */
function topPathspec(relPosixPath) {
  return `:(top,literal)${relPosixPath}`;
}

function bookkeepingPathspecs() {
  return [topPathspec(tmChildPath('tasks')), topPathspec(tmChildPath('rollbacks'))];
}

function ensureGit() {
  if (!insideRepo()) {
    git(['init']);
    // A brand new repo has no HEAD commit; callers create the baseline.
  }
  const name = gitTry(['config', 'user.name']);
  if (!name) git(['config', 'user.name', 'Project Time Machine']);
  const email = gitTry(['config', 'user.email']);
  if (!email) git(['config', 'user.email', 'time-machine@local.invalid']);
}

function head() {
  return gitTry(['rev-parse', 'HEAD']);
}

function hasCommits() {
  return head() !== null;
}

function currentBranch() {
  const branch = gitTry(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return branch || null;
}

// ---------------------------------------------------------------------------
// Working tree status (porcelain v2, NUL separated — safe for spaces)
// ---------------------------------------------------------------------------

const XY_CHANGE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

function classify(x, y) {
  const code = x !== '.' && x !== ' ' ? x : y;
  return XY_CHANGE[code] || 'modified';
}

/**
 * Parse `git status --porcelain=v2 -z`.
 *
 * Porcelain v2 is used deliberately: it has a documented, stable field layout,
 * paths are never quoted or escaped under -z, and rename/copy entries carry the
 * original path as its own NUL-terminated field. That makes paths containing
 * spaces, quotes or non-ASCII characters parse correctly.
 */
function statusEntries(options = {}) {
  requireRepo();
  const args = ['status', '--porcelain=v2', '-z', '--untracked-files=all'];
  if (options.includeIgnored) args.push('--ignored=matching');
  const raw = git(args);
  if (!raw) return [];

  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const entries = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const kindChar = token[0];

    if (kindChar === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = token.split(' ');
      const xy = parts[1];
      entries.push({
        kind: 'ordinary',
        x: xy[0],
        y: xy[1],
        change: classify(xy[0], xy[1]),
        path: parts.slice(8).join(' ')
      });
    } else if (kindChar === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const parts = token.split(' ');
      const xy = parts[1];
      const newPath = parts.slice(9).join(' ');
      const origPath = tokens[++i];
      entries.push({
        kind: xy.includes('C') ? 'copy' : 'rename',
        x: xy[0],
        y: xy[1],
        change: xy.includes('C') ? 'copied' : 'renamed',
        path: newPath,
        origPath
      });
    } else if (kindChar === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = token.split(' ');
      entries.push({
        kind: 'unmerged',
        x: parts[1][0],
        y: parts[1][1],
        change: 'unmerged',
        path: parts.slice(10).join(' ')
      });
    } else if (kindChar === '?') {
      entries.push({ kind: 'untracked', x: '?', y: '?', change: 'untracked', path: token.slice(2) });
    } else if (kindChar === '!') {
      entries.push({ kind: 'ignored', x: '!', y: '!', change: 'ignored', path: token.slice(2) });
    }
  }

  return entries;
}

function describeEntry(entry) {
  const label = entry.change.padEnd(10);
  return entry.origPath ? `${label} ${entry.origPath} -> ${entry.path}` : `${label} ${entry.path}`;
}

function describeEntries(entries) {
  return entries.map(describeEntry);
}

/** Entries that live inside the Time Machine's own tasks/ or rollbacks/ dirs. */
function isBookkeepingPath(relPath) {
  return ['tasks', 'rollbacks', 'runtime'].some((child) => {
    const base = tmChildPath(child);
    return relPath === base || relPath.startsWith(`${base}/`);
  });
}

/** Working-tree changes excluding the Time Machine's own bookkeeping files. */
function projectEntries() {
  return statusEntries().filter((entry) => {
    if (isBookkeepingPath(entry.path)) return false;
    if (entry.origPath && isBookkeepingPath(entry.origPath)) return false;
    return true;
  });
}

function isDirty() {
  return statusEntries().length > 0;
}

/**
 * Merge pre-stage status (knows which files were untracked) with post-stage
 * status (knows which changes are renames/copies) into one accurate record.
 */
function mergeFileRecords(preEntries, postEntries) {
  const untracked = new Set(preEntries.filter((e) => e.kind === 'untracked').map((e) => e.path));
  return postEntries.map((entry) => {
    const record = {
      change: entry.change,
      path: entry.path
    };
    if (entry.origPath) record.from = entry.origPath;
    if (untracked.has(entry.path)) record.wasUntracked = true;
    return record;
  });
}

function describeFileRecord(record) {
  const suffix = record.wasUntracked ? ' (untracked)' : '';
  return record.from
    ? `${record.change.padEnd(10)} ${record.from} -> ${record.path}${suffix}`
    : `${record.change.padEnd(10)} ${record.path}${suffix}`;
}

// ---------------------------------------------------------------------------
// Task records
// ---------------------------------------------------------------------------

function taskPath(id) {
  return path.join(tasksDir, `${id}.json`);
}

function taskRef(id) {
  return `task/${id}`;
}

function formatTaskId(number) {
  return `TASK-${String(number).padStart(4, '0')}`;
}

function taskNumber(id) {
  const match = TASK_ID_PATTERN.exec(id);
  return match ? Number(match[1]) : null;
}

function listTaskFiles() {
  return readdirSafe(tasksDir)
    .filter((name) => /^TASK-\d{4,}\.json$/.test(name))
    .sort();
}

/** All task records, including malformed ones flagged for the auditor. */
function loadTaskRecords() {
  ensureDirs();
  const records = [];
  for (const name of listTaskFiles()) {
    const file = path.join(tasksDir, name);
    const parsed = readJsonSafe(file);
    if (!parsed.ok) {
      records.push({ __malformed: true, __file: file, __error: parsed.error, id: name.replace(/\.json$/, '') });
      continue;
    }
    records.push(parsed.value);
  }
  return records;
}

/** Well-formed task records only, sorted by id. */
function listTasks() {
  return loadTaskRecords()
    .filter((task) => !task.__malformed)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function getTask(id) {
  const file = taskPath(id);
  if (!fs.existsSync(file)) fail(`Task not found: ${id}`);
  const parsed = readJsonSafe(file);
  if (!parsed.ok) fail(`Task record is malformed: ${id} (${parsed.error})`);
  return parsed.value;
}

function taskExists(id) {
  return fs.existsSync(taskPath(id));
}

/** Annotated task tags currently present in the repository. */
function listTaskTags() {
  if (!insideRepo()) return [];
  const raw = gitTry(['tag', '--list', 'task/TASK-*']);
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean);
}

function readHighWater() {
  if (!fs.existsSync(highWaterPath)) return 0;
  const parsed = readJsonSafe(highWaterPath);
  if (!parsed.ok || typeof parsed.value.highWater !== 'number') return 0;
  return parsed.value.highWater;
}

function writeHighWater(value) {
  ensureDirs();
  writeJsonAtomic(highWaterPath, { highWater: value, updatedAt: now() });
}

/**
 * Every task number this repository has ever used, gathered from:
 *  - task record files on disk
 *  - ids recorded inside rollback/recovery records
 *  - annotated `task/TASK-*` tags (survive `reset --hard` and branch switches)
 *  - a gitignored high-water mark (survives records being reverted away)
 */
function usedTaskNumbers() {
  const numbers = new Set();

  for (const name of listTaskFiles()) {
    const number = taskNumber(name.replace(/\.json$/, ''));
    if (number !== null) numbers.add(number);
  }

  for (const task of loadTaskRecords()) {
    const own = taskNumber(String(task.id || ''));
    if (own !== null) numbers.add(own);
    const target = task.target && task.target.taskId ? taskNumber(String(task.target.taskId)) : null;
    if (target !== null) numbers.add(target);
  }

  for (const name of readdirSafe(rollbacksDir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = readJsonSafe(path.join(rollbacksDir, name));
    if (!parsed.ok) continue;
    for (const key of ['id', 'taskId', 'recordedAs']) {
      const number = taskNumber(String(parsed.value[key] || ''));
      if (number !== null) numbers.add(number);
    }
  }

  for (const tag of listTaskTags()) {
    const number = taskNumber(tag.replace(/^task\//, ''));
    if (number !== null) numbers.add(number);
  }

  const highWater = readHighWater();
  if (highWater > 0) numbers.add(highWater);

  return numbers;
}

/** Allocate the next id and immediately raise the high-water mark. */
function nextTaskId() {
  ensureDirs();
  let max = 0;
  for (const number of usedTaskNumbers()) {
    if (Number.isFinite(number) && number > max) max = number;
  }
  const next = max + 1;
  writeHighWater(next);
  return formatTaskId(next);
}

function createTaskRecord({ id, name, type, request, startCommit }) {
  return {
    schema: SCHEMA_VERSION,
    id,
    name,
    request: request || name,
    type: type || 'change',
    status: 'active',
    startedAt: now(),
    completedAt: null,
    startCommit: startCommit === undefined ? head() : startCommit,
    commit: null,
    gitRef: taskRef(id),
    files: [],
    checks: [],
    result: null
  };
}

// ---------------------------------------------------------------------------
// Active task lock
// ---------------------------------------------------------------------------

function readActive() {
  if (!fs.existsSync(activePath)) return null;
  const parsed = readJsonSafe(activePath);
  if (!parsed.ok) return { __malformed: true, __error: parsed.error };
  return parsed.value;
}

function setActive(data) {
  ensureDirs();
  if (data) writeJsonAtomic(activePath, data);
  else removeFileIfPresent(activePath);
}

/**
 * Classify the active-task lock.
 *   none      — no lock file
 *   healthy   — lock matches an existing record whose status is 'active'
 *   malformed — lock file is unreadable or missing required fields
 *   stale     — lock points at a missing record, or at a record that is no
 *               longer active (i.e. a previous run was interrupted)
 */
function inspectActive() {
  const active = readActive();
  if (!active) return { state: 'none', active: null };

  if (active.__malformed) {
    return { state: 'malformed', active: null, reason: `Active-task lock is not valid JSON: ${active.__error}` };
  }
  if (!active.id || !TASK_ID_PATTERN.test(String(active.id))) {
    return { state: 'malformed', active, reason: 'Active-task lock has no valid task id.' };
  }
  if (!taskExists(active.id)) {
    return { state: 'stale', active, reason: `Active-task lock points at ${active.id} but no task record exists.` };
  }

  const parsed = readJsonSafe(taskPath(active.id));
  if (!parsed.ok) {
    return { state: 'stale', active, reason: `Task record ${active.id} is malformed: ${parsed.error}` };
  }
  const task = parsed.value;
  if (task.status !== 'active') {
    return {
      state: 'stale',
      active,
      task,
      reason: `Active-task lock points at ${active.id} but its record status is "${task.status}". A previous run was interrupted.`
    };
  }
  return { state: 'healthy', active, task };
}

function requireNoActiveTask(action) {
  const info = inspectActive();
  if (info.state === 'none') return;
  if (info.state === 'healthy') {
    fail(`Cannot ${action} while task ${info.active.id} is active.\nComplete it with complete-task.js or abandon it with abort-task.js.`);
  }
  fail(`Cannot ${action}: ${info.reason}\nResolve it with: node ${tmFolderName}/scripts/abort-task.js --execute`);
}

function requireActiveTask() {
  const info = inspectActive();
  if (info.state === 'none') fail('No active task. Start one with start-task.js before changing files.');
  if (info.state !== 'healthy') {
    fail(`${info.reason}\nResolve it with: node ${tmFolderName}/scripts/abort-task.js --execute`);
  }
  return info;
}

/**
 * Refuse to proceed while real project work is uncommitted.
 *
 * The Time Machine's own uncommitted records (for example the record left
 * behind by an aborted task) deliberately do NOT block anything: they are
 * bookkeeping, not user work, and the next operation commits them along with
 * itself so the audit trail is preserved. audit.js reports them separately.
 */
function requireCleanTree(action) {
  const entries = projectEntries();
  if (entries.length) {
    fail(`Cannot ${action}: the working tree has uncommitted changes.\n${describeEntries(entries).join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// Git object verification
// ---------------------------------------------------------------------------

function refExists(ref) {
  return gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

function resolveCommit(ref) {
  const value = gitTry(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!value) fail(`Cannot resolve commit for ref: ${ref}`);
  return value;
}

function tagExists(tagName) {
  return gitOk(['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`]);
}

/** True only for annotated (object type "tag") tags, not lightweight ones. */
function isAnnotatedTag(tagName) {
  const type = gitTry(['cat-file', '-t', `refs/tags/${tagName}`]);
  return type === 'tag';
}

function resolveTaskCommit(id) {
  return resolveCommit(taskRef(id));
}

/** Create a commit + annotated tag, then verify all three artifacts exist. */
function commitAndTagTask(task, message) {
  git(['add', '-A']);
  git(['commit', '--no-verify', '-m', message]);
  const commit = head();
  if (!commit) fail('Commit did not produce a HEAD revision.');

  const tagName = taskRef(task.id);
  if (tagExists(tagName)) {
    fail(`Tag ${tagName} already exists. Task ids must never be reused.`);
  }
  git(['tag', '-a', tagName, commit, '-m', `${task.id}: ${task.name}`]);

  if (!tagExists(tagName)) fail(`Tag ${tagName} was not created.`);
  if (!isAnnotatedTag(tagName)) fail(`Tag ${tagName} is not an annotated tag.`);
  const tagged = resolveCommit(tagName);
  if (tagged !== commit) {
    fail(`Tag ${tagName} points at ${tagged} but the task commit is ${commit}.`);
  }
  return { commit, tagName };
}

// ---------------------------------------------------------------------------
// Backups and checkpoints
// ---------------------------------------------------------------------------

function listBackupBranches() {
  if (!insideRepo()) return [];
  const raw = gitTry([
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)',
    `${BACKUP_REF_PREFIX}/*`
  ]);
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, commit, createdAt] = line.split('\t');
    return { name, commit, createdAt };
  });
}

function listCheckpoints() {
  if (!insideRepo()) return [];
  const raw = gitTry([
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)',
    `${CHECKPOINT_REF_PREFIX}/*`
  ]);
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, short, commit, createdAt, subject] = line.split('\t');
    return { ref, short, id: ref.slice(`${CHECKPOINT_REF_PREFIX}/`.length), commit, createdAt, subject };
  });
}

/**
 * Create a backup branch at the given commit and verify it landed.
 * Names are timestamp-based; a numeric suffix is added when two operations land
 * inside the same millisecond so a backup is never silently skipped.
 */
function createVerifiedBackup(commit, label) {
  const base = `tm-backup/${label || safeStamp()}`;
  let branch = base;
  for (let attempt = 2; refExists(`refs/heads/${branch}`); attempt++) {
    branch = `${base}-${attempt}`;
    if (attempt > 100) fail(`Could not find a free backup branch name based on ${base}.`);
  }
  git(['branch', branch, commit]);
  if (!refExists(`refs/heads/${branch}`)) {
    fail(`Backup branch was not created: ${branch}`);
  }
  const resolved = resolveCommit(`refs/heads/${branch}`);
  if (resolved !== commit) {
    fail(`Backup branch ${branch} points at ${resolved}, expected ${commit}.`);
  }
  return { branch, commit };
}

/**
 * Restore the Time Machine's own tasks/ and rollbacks/ directories from the
 * given commit. Rolling the project back must never rewind the machine's
 * memory of what happened, otherwise records and ids would be lost.
 */
function restoreBookkeeping(fromCommit) {
  const specs = bookkeepingPathspecs();
  for (const spec of specs) {
    // A path may legitimately not exist in that commit; ignore only that case.
    const res = git(['checkout', fromCommit, '--', spec], { allowFailure: true });
    if (!res.ok && !/did not match any file|pathspec/i.test(res.stderr)) {
      fail(`Failed to restore Time Machine records from ${fromCommit}:\n${res.stderr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Task lookup and derived state
// ---------------------------------------------------------------------------

/** Tasks that represent real, finished operations. */
function completedTasks() {
  return listTasks().filter((task) => task.status === 'completed');
}

/**
 * Rollback state is derived, never stored on the original record — completed
 * records are immutable. A task counts as reverted when a completed rollback
 * targets it and no later recovery/restore has superseded that rollback.
 */
function derivedRollbackState(taskId) {
  const ops = completedTasks()
    .filter((task) => task.target && task.target.taskId === taskId && task.type === 'rollback')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!ops.length) return { reverted: false, by: null };

  const lastRollback = ops[ops.length - 1];
  const laterUndo = completedTasks().find(
    (task) =>
      (task.type === 'recovery' || task.type === 'checkpoint-restore') &&
      String(task.id).localeCompare(String(lastRollback.id)) > 0
  );
  if (laterUndo) return { reverted: false, by: null, supersededBy: laterUndo.id };
  return { reverted: true, by: lastRollback.id };
}

/**
 * Resolve a natural-language reference to a task.
 * Accepts "last", an exact id, or a case-insensitive substring of the name.
 * Ambiguity is a hard failure — guessing here would be destructive.
 */
function findTask(query, options = {}) {
  const pool = completedTasks().filter((task) => (options.types ? options.types.includes(task.type) : true));
  if (!pool.length) fail('No completed task found.');

  const trimmed = (query || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'last' || trimmed.toLowerCase() === 'latest') {
    return pool[pool.length - 1];
  }

  const exact = pool.find((task) => String(task.id).toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;

  if (TASK_ID_PATTERN.test(trimmed.toUpperCase())) {
    fail(`No completed task found with id ${trimmed.toUpperCase()}.`);
  }

  const needle = trimmed.toLowerCase();
  const matches = pool.filter((task) => String(task.name).toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(
      `"${trimmed}" matches ${matches.length} tasks. Name one explicitly:\n` +
        matches.map((task) => `  ${task.id} — ${task.name}`).join('\n')
    );
  }
  fail(`No task matches: ${trimmed}`);
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/** Split argv into flags and positionals; `--` ends flag parsing. */
function parseArgs(argv, spec = {}) {
  const valueFlags = new Set(spec.valueFlags || []);
  const flags = {};
  const positionals = [];
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (onlyPositional || !arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositional = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (valueFlags.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`Flag --${name} requires a value.`);
      if (!flags[name]) flags[name] = [];
      flags[name].push(value);
    } else {
      flags[name] = true;
    }
  }
  return { flags, positionals };
}

/** Wrap a script body so TimeMachineError prints cleanly instead of a stack. */
function main(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeMachineError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(`Error: ${error && error.message ? error.message : String(error)}`);
    if (process.env.TM_DEBUG) console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  TASK_ID_PATTERN,
  TASK_TYPES,
  CHECKPOINT_REF_PREFIX,
  BACKUP_REF_PREFIX,
  TimeMachineError,
  fs,
  path,
  root,
  tm,
  tmFolderName,
  scriptsDir,
  tasksDir,
  rollbacksDir,
  runtimeDir,
  docsDir,
  activePath,
  highWaterPath,
  fail,
  run,
  git,
  gitOk,
  gitTry,
  ensureDirs,
  ensureGit,
  readdirSafe,
  readJson,
  readJsonSafe,
  writeJsonAtomic,
  removeFileIfPresent,
  now,
  safeStamp,
  insideRepo,
  requireRepo,
  repoTopLevel,
  tmRepoRelative,
  tmChildPath,
  topPathspec,
  bookkeepingPathspecs,
  head,
  hasCommits,
  currentBranch,
  statusEntries,
  describeEntry,
  describeEntries,
  isBookkeepingPath,
  projectEntries,
  isDirty,
  mergeFileRecords,
  describeFileRecord,
  taskPath,
  taskRef,
  formatTaskId,
  taskNumber,
  listTaskFiles,
  loadTaskRecords,
  listTasks,
  getTask,
  taskExists,
  listTaskTags,
  readHighWater,
  writeHighWater,
  usedTaskNumbers,
  nextTaskId,
  createTaskRecord,
  readActive,
  setActive,
  inspectActive,
  requireNoActiveTask,
  requireActiveTask,
  requireCleanTree,
  refExists,
  resolveCommit,
  tagExists,
  isAnnotatedTag,
  resolveTaskCommit,
  commitAndTagTask,
  listBackupBranches,
  listCheckpoints,
  createVerifiedBackup,
  restoreBookkeeping,
  completedTasks,
  derivedRollbackState,
  findTask,
  parseArgs,
  main
};
