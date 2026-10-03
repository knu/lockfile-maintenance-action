import { rm } from 'node:fs/promises';
import path from 'node:path';
import { command } from '../command.js';
import { packageManagerVersion, prepareNodeManager } from './node-setup.js';

export const defaultPnpmVersion = '12.4.2';
export const pnpmVersion = (manifest) => packageManagerVersion(manifest, 'pnpm', '11.0.0');
export const preparePnpm = (context) =>
  prepareNodeManager(context, {
    name: 'pnpm',
    packageName: 'pnpm',
    minimum: '11.0.0',
    fallback: defaultPnpmVersion,
  });

export async function updatePnpm(context) {
  await rm(path.join(context.directory, 'pnpm-lock.yaml'));
  await command(
    'pnpm',
    [
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      `--config.minimum-release-age=${context.age.minutes}`,
      '--config.minimum-release-age-strict=true',
      '--config.minimum-release-age-ignore-missing-time=false',
    ],
    context,
  );
}
