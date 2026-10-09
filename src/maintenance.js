import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lockfileTargets } from './targets.js';
import { pullRequestPaths } from './pull-request.js';
import { rebaseInstructions } from './rebase.js';
import { changedFiles, restore, snapshot } from './transaction.js';
import {
  changeReport,
  packageVersions,
  releaseHistoryLayout,
  versionChanges,
} from './version-changes.js';
import { addReleaseHistory } from './release-history.js';

export async function maintainLockfile(env) {
  const layout = releaseHistoryLayout(env.INPUT_RELEASE_HISTORY_LAYOUT);
  const { workspace, targets } = await lockfileTargets(env);

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
        files.push({
          file: target.file,
          manager: target.manager.name,
          changes: versionChanges(before.get(target.file), after),
        });
      }
      await addReleaseHistory(files, { token: env.INPUT_TOKEN });
      const instructions = prPaths === undefined ? '' : rebaseInstructions(env);
      const report =
        changeReport(
          files,
          env['INPUT_MINIMUM-RELEASE-AGE'] ?? '3 days',
          60000 - Buffer.byteLength(instructions),
          layout,
        ) + (instructions ? `\n${instructions}` : '');
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
  } finally {
    for (const target of targets) await target.cleanup?.();
  }
  console.log(`${changed.length} of ${targets.length} lockfiles changed`);
}
