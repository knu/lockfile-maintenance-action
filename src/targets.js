import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseAge } from './age.js';
import { listFiles, selectFiles } from './files.js';
import { defaultPatterns, managers } from './managers/index.js';

async function requireFile(file) {
  const stat = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`required file missing: ${file}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`file must be a regular file: ${file}`);
}

export async function lockfileTargets(env) {
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

  return { workspace, targets };
}
