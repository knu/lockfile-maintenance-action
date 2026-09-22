import { command } from './command.js';

export async function pullRequestPaths(directory, files, env) {
  const enabled = env.INPUT_CREATE_PULL_REQUEST ?? 'false';
  if (!['true', 'false'].includes(enabled))
    throw new Error('create-pull-request must be true or false');
  if (enabled === 'false') return undefined;
  // create-pull-request separates add-paths on commas and newlines.
  if (files.some((file) => /[,\r\n]/.test(file)))
    throw new Error('PR paths cannot contain commas or newlines; use create-pull-request: false');
  const status = await command('git', ['status', '--porcelain', '-z', '--untracked-files=no'], {
    directory,
    env,
  });
  if (status) throw new Error('PR creation requires a clean tracked working tree and index');
  return files.map((file) => `:(literal)${file}`).join('\n');
}
