'use strict';

/**
 * Full consistency audit.
 *
 * Verifies the three artifacts of every task agree with each other, that no id
 * was reused, that nothing is half-finished, and that the installation itself
 * (dependencies, package scripts, documentation) is coherent.
 *
 * Exit code 0 when clean or warnings only, 1 when any error is found.
 *
 * Usage:
 *   node <tm>/scripts/audit.js [--json] [--strict]
 *   --strict  treat warnings as errors
 */

const {
  fs,
  path,
  root,
  tm,
  tmFolderName,
  tmChildPath,
  scriptsDir,
  docsDir,
  tasksDir,
  rollbacksDir,
  insideRepo,
  inspectActive,
  statusEntries,
  projectEntries,
  describeEntries,
  loadTaskRecords,
  listTaskFiles,
  listTaskTags,
  readJsonSafe,
  readdirSafe,
  taskNumber,
  taskPath,
  tagExists,
  isAnnotatedTag,
  resolveCommit,
  refExists,
  gitOk,
  gitTry,
  listBackupBranches,
  listCheckpoints,
  readHighWater,
  usedTaskNumbers,
  TASK_ID_PATTERN,
  TASK_TYPES,
  parseArgs,
  main
} = require('./common');

const REQUIRED_SCRIPTS = [
  'common.js',
  'start-task.js',
  'complete-task.js',
  'abort-task.js',
  'list-tasks.js',
  'status.js',
  'audit.js',
  'rollback.js',
  'recover.js',
  'watch.js'
];

// Assembled at runtime so this file does not itself contain the literal it is
// looking for — otherwise the audit would always flag its own source.
const LEGACY_FOLDER = '.' + ['project', 'time', 'machine'].join('-');
const LEGACY_INSTALLER = 'scripts/' + 'install' + '.js';

const TM_SCRIPT_NAMES = [
  'tm:start',
  'tm:complete',
  'tm:abort',
  'tm:list',
  'tm:status',
  'tm:audit',
  'tm:rollback',
  'tm:recover',
  'tm:watch',
  'tm:checkpoints'
];

main(() => {
  const { flags } = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  const notes = [];
  const error = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });

  // -- 0. Repository -------------------------------------------------------
  if (!insideRepo()) {
    error('no-repo', `${root} is not a Git repository. Run: node ${tmFolderName}/setup.js`);
    report();
    return;
  }

  const selfHosted = path.resolve(tm) === path.resolve(root);
  notes.push(
    selfHosted
      ? 'Installation: self-hosted (this repository IS the Time Machine).'
      : `Installation: ${tmChildPath('').replace(/\/$/, '') || tmFolderName}/ inside the host project.`
  );

  // -- 1. Active-task lock -------------------------------------------------
  const active = inspectActive();
  if (active.state === 'malformed' || active.state === 'stale') {
    error('active-lock', `${active.reason} Fix: node ${tmFolderName}/scripts/abort-task.js --execute`);
  } else if (active.state === 'healthy') {
    warn('task-in-progress', `Task ${active.active.id} is currently active — "${active.active.name}".`);
  }

  // -- 2. Unlogged working-tree changes ------------------------------------
  const dirty = statusEntries();
  const dirtyProject = projectEntries();
  if (dirtyProject.length && active.state === 'none') {
    error(
      'unlogged-changes',
      `${dirtyProject.length} change(s) exist without an active task:\n` +
        describeEntries(dirtyProject).map((line) => `    ${line}`).join('\n')
    );
  } else if (dirty.length && active.state === 'none') {
    warn('dirty-bookkeeping', `${dirty.length} uncommitted Time Machine record file(s) with no active task.`);
  }

  // -- 3. Records: malformed, duplicate, mismatched ------------------------
  const records = loadTaskRecords();
  const seenIds = new Map();

  for (const task of records) {
    if (task.__malformed) {
      error('malformed-record', `${path.basename(task.__file)} is not valid JSON: ${task.__error}`);
      continue;
    }

    if (!task.id || !TASK_ID_PATTERN.test(String(task.id))) {
      error('bad-id', `A task record has an invalid id: ${JSON.stringify(task.id)}`);
      continue;
    }
    if (seenIds.has(task.id)) {
      error('duplicate-id', `Task id ${task.id} appears in more than one record.`);
    }
    seenIds.set(task.id, task);

    for (const field of ['name', 'status', 'startedAt']) {
      if (!task[field]) error('incomplete-record', `${task.id} is missing required field "${field}".`);
    }
    if (task.type && !TASK_TYPES.includes(task.type)) {
      warn('unknown-type', `${task.id} has unrecognised type "${task.type}".`);
    }
    if (!['active', 'completed', 'aborted'].includes(task.status)) {
      error('bad-status', `${task.id} has unrecognised status "${task.status}".`);
    }
    if (task.status === 'completed' && !task.completedAt) {
      error('partial-record', `${task.id} is marked completed but has no completedAt timestamp.`);
    }
    if (task.status === 'completed' && (!Array.isArray(task.files) || task.files.length === 0)) {
      warn('empty-task', `${task.id} is completed but records no changed files.`);
    }
    if (task.status === 'active' && (active.state === 'none' || active.active.id !== task.id)) {
      error(
        'interrupted-task',
        `${task.id} has status "active" but is not the locked task — a previous run was interrupted. ` +
          `Fix: node ${tmFolderName}/scripts/abort-task.js --execute`
      );
    }
  }

  // Filename/id agreement.
  for (const name of listTaskFiles()) {
    const idFromName = name.replace(/\.json$/, '');
    const parsed = readJsonSafe(path.join(tasksDir, name));
    if (parsed.ok && parsed.value.id && parsed.value.id !== idFromName) {
      error('id-filename-mismatch', `${name} contains id ${parsed.value.id}.`);
    }
  }

  // -- 4. Git artifacts for each completed task ----------------------------
  const completed = records.filter((task) => !task.__malformed && task.status === 'completed');
  const recordIds = new Set(completed.map((task) => task.id));

  for (const task of completed) {
    const tagName = task.gitRef || `task/${task.id}`;
    if (!tagExists(tagName)) {
      error('missing-tag', `${task.id} has no Git tag ${tagName}.`);
      continue;
    }
    if (!isAnnotatedTag(tagName)) {
      error('lightweight-tag', `${tagName} is a lightweight tag; task tags must be annotated.`);
      continue;
    }
    let commit;
    try {
      commit = resolveCommit(tagName);
    } catch (err) {
      error('unresolvable-tag', `${tagName} does not resolve to a commit.`);
      continue;
    }
    // The record must live inside the commit its tag points at. This is what
    // binds record, commit and tag into one verified unit.
    const recordInCommit = `${commit}:${tmChildPath(`tasks/${task.id}.json`)}`;
    if (!gitOk(['cat-file', '-e', recordInCommit])) {
      error(
        'record-not-in-commit',
        `${task.id}: the tagged commit ${commit.slice(0, 10)} does not contain ${tmChildPath(`tasks/${task.id}.json`)}.`
      );
    }
    if (task.startCommit && !refExists(task.startCommit)) {
      warn('missing-base-commit', `${task.id} references start commit ${task.startCommit.slice(0, 10)}, which is unreachable.`);
    }
  }

  // -- 5. Orphaned tags ----------------------------------------------------
  for (const tag of listTaskTags()) {
    const id = tag.replace(/^task\//, '');
    if (!recordIds.has(id)) {
      const onDisk = fs.existsSync(taskPath(id));
      error(
        'orphaned-tag',
        onDisk
          ? `Tag ${tag} exists but ${id} is not a completed record.`
          : `Tag ${tag} exists with no task record at all.`
      );
    }
  }

  // -- 6. Id allocation safety --------------------------------------------
  const used = [...usedTaskNumbers()].filter(Number.isFinite);
  const maxUsed = used.length ? Math.max(...used) : 0;
  const highWater = readHighWater();
  if (highWater < maxUsed) {
    warn(
      'low-high-water',
      `Id high-water mark is ${highWater} but ${maxUsed} is already used. It will self-correct on the next task.`
    );
  }
  const duplicateNumbers = used.filter((value, index, arr) => arr.indexOf(value) !== index);
  if (duplicateNumbers.length) {
    error('reused-id', `Task numbers used more than once: ${[...new Set(duplicateNumbers)].join(', ')}`);
  }

  // -- 7. Rollback operation log ------------------------------------------
  for (const name of readdirSafe(rollbacksDir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = readJsonSafe(path.join(rollbacksDir, name));
    if (!parsed.ok) {
      error('malformed-rollback', `rollbacks/${name} is not valid JSON: ${parsed.error}`);
      continue;
    }
    const entry = parsed.value;
    if (entry.id && !fs.existsSync(taskPath(entry.id))) {
      warn('rollback-without-task', `rollbacks/${name} references ${entry.id}, which has no task record.`);
    }
    if (entry.targetTaskId && !fs.existsSync(taskPath(entry.targetTaskId))) {
      warn('rollback-target-missing', `rollbacks/${name} targets ${entry.targetTaskId}, which has no task record.`);
    }
  }

  // -- 8. Backup references still resolvable -------------------------------
  const backups = listBackupBranches();
  const backupNames = new Set(backups.map((backup) => backup.name));
  for (const task of records) {
    if (task.__malformed || !task.backup || !task.backup.branch) continue;
    if (!backupNames.has(task.backup.branch) && !refExists(`refs/heads/${task.backup.branch}`)) {
      warn('missing-backup', `${task.id} references backup branch ${task.backup.branch}, which no longer exists.`);
    }
  }
  notes.push(`Backups: ${backups.length}. Checkpoints: ${listCheckpoints().length}.`);

  // -- 9. Installed script files -------------------------------------------
  for (const script of REQUIRED_SCRIPTS) {
    if (!fs.existsSync(path.join(scriptsDir, script))) {
      error('missing-script', `Required script is missing: scripts/${script}`);
    }
  }
  if (fs.existsSync(path.join(scriptsDir, 'install.js'))) {
    warn('legacy-installer', `${LEGACY_INSTALLER} exists; the installer is setup.js at the folder root.`);
  }
  if (!fs.existsSync(path.join(tm, 'setup.js'))) {
    error('missing-setup', 'setup.js is missing from the Time Machine folder root.');
  }

  // -- 10. Dependencies ----------------------------------------------------
  try {
    require.resolve('chokidar', { paths: [tm, root] });
    notes.push('Dependency: chokidar resolved.');
  } catch (err) {
    warn(
      'missing-dependency',
      'chokidar is not installed, so the watcher cannot run. Install it with: npm install --save-dev chokidar'
    );
  }

  // -- 11. Host package scripts -------------------------------------------
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    if (!selfHosted) warn('no-package-json', 'The host project has no package.json, so no tm:* shortcuts are installed.');
  } else {
    const parsed = readJsonSafe(pkgPath);
    if (!parsed.ok) {
      error('bad-package-json', `package.json is not valid JSON: ${parsed.error}`);
    } else {
      const scripts = parsed.value.scripts || {};
      // Compare the path portion only: a folder name containing a space is
      // legitimately quoted by setup.js, which would break a `node <path>` match.
      const expectedPrefix = `${tmChildPath('scripts')}/`;
      const missing = TM_SCRIPT_NAMES.filter((name) => !scripts[name]);
      if (missing.length) {
        warn('missing-tm-scripts', `package.json is missing: ${missing.join(', ')}. Run: node ${tmFolderName}/setup.js`);
      }
      for (const [name, value] of Object.entries(scripts)) {
        if (!name.startsWith('tm:')) continue;
        if (!String(value).includes(expectedPrefix)) {
          error(
            'stale-tm-script',
            `package.json script "${name}" is "${value}" but this folder is "${tmFolderName}". Re-run setup.js.`
          );
        }
      }
    }
  }

  // -- 12. Documentation consistency ---------------------------------------
  const docFiles = [
    ...readdirSafe(docsDir).filter((name) => /\.(md|txt)$/i.test(name)).map((name) => path.join(docsDir, name)),
    ...readdirSafe(tm).filter((name) => /\.md$/i.test(name)).map((name) => path.join(tm, name))
  ];

  for (const file of docFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      continue;
    }
    const label = path.relative(tm, file).split(path.sep).join('/');
    if (content.includes(LEGACY_INSTALLER)) {
      error('doc-bad-installer', `${label} references ${LEGACY_INSTALLER}, which does not exist. The installer is setup.js.`);
    }
    if (content.includes(LEGACY_FOLDER)) {
      error(
        'doc-hardcoded-folder',
        `${label} hardcodes "${LEGACY_FOLDER}". Docs must stay folder-agnostic — use the <tm> placeholder.`
      );
    }
  }

  const sourceFiles = [
    ...readdirSafe(scriptsDir).filter((name) => name.endsWith('.js')).map((name) => path.join(scriptsDir, name)),
    path.join(tm, 'setup.js')
  ];
  for (const file of sourceFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const label = path.relative(tm, file).split(path.sep).join('/');
    if (content.includes(LEGACY_FOLDER)) {
      error('script-hardcoded-folder', `${label} hardcodes "${LEGACY_FOLDER}"; derive the path instead.`);
    }
    if (content.includes(LEGACY_INSTALLER)) {
      error('script-bad-installer', `${label} references ${LEGACY_INSTALLER}, which does not exist.`);
    }
  }

  // -- 13. Git repository sanity ------------------------------------------
  const fsck = gitTry(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!fsck) warn('no-commits', 'The repository has no commits yet.');

  report();

  function report() {
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: errors.length === 0 && (!flags.strict || warnings.length === 0),
            errors,
            warnings,
            notes
          },
          null,
          2
        )
      );
    } else {
      for (const note of notes) console.log(note);
      if (notes.length) console.log('');

      if (errors.length) {
        console.log(`${errors.length} ERROR(S):`);
        for (const item of errors) console.log(`  [${item.code}] ${item.message}`);
        console.log('');
      }
      if (warnings.length) {
        console.log(`${warnings.length} WARNING(S):`);
        for (const item of warnings) console.log(`  [${item.code}] ${item.message}`);
        console.log('');
      }
      if (!errors.length && !warnings.length) console.log('Time Machine audit passed. No issues found.');
      else if (!errors.length) console.log('Time Machine audit passed with warnings.');
      else console.log('Time Machine audit FAILED.');
    }

    if (errors.length || (flags.strict && warnings.length)) process.exitCode = 1;
  }
});
