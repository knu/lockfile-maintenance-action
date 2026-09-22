import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { command, requireVersion } from '../command.js';

export async function prepareNpm(context) {
  await requireVersion('npm', '11.10.0', context);
  const shrinkwrap = await lstat(path.join(context.directory, 'npm-shrinkwrap.json')).catch(
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  if (shrinkwrap) throw new Error('npm-shrinkwrap.json takes precedence over package-lock.json');
}

export async function updateNpm(context) {
  const before = new Date(Date.now() - context.age.seconds * 1000).toISOString();
  await rm(path.join(context.directory, 'package-lock.json'));
  await command(
    'npm',
    [
      'update',
      '--package-lock-only',
      '--package-lock=true',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--before=${before}`,
    ],
    context,
  );
}
