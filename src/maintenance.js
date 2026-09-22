import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseAge } from './age.js';
import { listFiles, selectFiles } from './files.js';
import { defaultPatterns, managers } from './managers/index.js';
import { pullRequestPaths } from './pull-request.js';
import { changedFiles, restore, snapshot } from './transaction.js';
import { changeReport, packageVersions, versionChanges } from './version-changes.js';

async function requireFile(file) {
  const stat = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`required file missing: ${file}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`file must be a regular file: ${file}`);
}

export async function maintainLockfile(env) {
  const age = parseAge(env['INPUT_MINIMUM-RELEASE-AGE'] ?? '3 days');
  if (!env.GITHUB_WORKSPACE) throw new Error('GITHUB_WORKSPACE is required');
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');

  const workspace = await realpath(env.GITHUB_WORKSPACE);
  const root = await realpath(path.resolve(workspace, env['INPUT_WORKING-DIRECTORY'] ?? '.'));
  const relative = path.relative(workspace, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('working-directory must be inside the checkout');
  }

  const selected = selectFiles(env.INPUT_FILES ?? defaultPatterns);
  const targets = [];
  const manifests = new Set();
  for (const file of await listFiles(root, env)) {
    const manager = managers.get(path.basename(file));
    if (!manager || !selected(file)) continue;
    const lockfile = path.join(root, file);
    const directory = path.dirname(lockfile);
    if ((await realpath(directory)) !== directory)
      throw new Error(`lockfile directory must not contain symlinks: ${file}`);
    const manifest = path.join(directory, manager.manifest);
    await requireFile(lockfile);
    await requireFile(manifest);
    if (manifests.has(manifest))
      throw new Error(`multiple package managers selected for ${manifest}`);
    manifests.add(manifest);
    targets.push({
      manager,
      directory,
      age,
      env,
      file: path.relative(workspace, lockfile).split(path.sep).join('/'),
    });
  }
  if (!targets.length) throw new Error('files matched no supported lockfiles');

  const lockfiles = targets.map(({ file }) => file);
  const prPaths = await pullRequestPaths(workspace, lockfiles, env);
  const originals = await snapshot(workspace);
  let changed;
  try {
    // Complete version checks before any manager changes a lockfile.
    for (const target of targets) await target.manager.prepare(target);
    const before = new Map();
    if (env.LOCKFILE_REPORT_PATH) {
      for (const target of targets)
        before.set(
          target.file,
          await packageVersions(
            target.manager.name,
            originals.get(target.file).contents.toString(),
            target,
          ),
        );
    }
    for (const target of targets) {
      console.log(`Updating ${JSON.stringify(target.file)} with ${target.manager.name}`);
      await target.manager.update(target);
    }
    changed = await changedFiles(workspace, originals, new Set(lockfiles));
    if (env.LOCKFILE_REPORT_PATH) {
      const files = [];
      for (const target of targets.filter(({ file }) => changed.includes(file))) {
        const after = await packageVersions(
          target.manager.name,
          await readFile(path.join(workspace, target.file), 'utf8'),
          target,
        );
        files.push({ file: target.file, changes: versionChanges(before.get(target.file), after) });
      }
      const report = changeReport(files, env['INPUT_MINIMUM-RELEASE-AGE'] ?? '3 days');
      await writeFile(env.LOCKFILE_REPORT_PATH, report);
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, report);
    }
    const delimiter = randomUUID();
    await appendFile(
      env.GITHUB_OUTPUT,
      [
        `changed=${changed.length > 0}`,
        `lockfiles=${JSON.stringify(lockfiles)}`,
        `changed-lockfiles=${JSON.stringify(changed)}`,
        ...(prPaths === undefined ? [] : [`pr-paths<<${delimiter}`, prPaths, delimiter]),
        '',
      ].join('\n'),
    );
  } catch (error) {
    try {
      await restore(workspace, originals);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `${error.message}; restoring files failed: ${restoreError.message}`,
      );
    }
    throw new Error(`${error.message}; original files restored`);
  }
  console.log(`${changed.length} of ${targets.length} lockfiles changed`);
}
