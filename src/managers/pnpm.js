import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { command, requireVersion } from '../command.js';

export const defaultPnpmVersion = '12.4.2';

export function pnpmVersion(manifest) {
  const specification = manifest.packageManager;
  const engine = manifest.devEngines?.packageManager;
  let version = engine?.version;
  if (specification !== undefined) {
    if (typeof specification !== 'string' || !specification.startsWith('pnpm@'))
      throw new Error('pnpm lockfile requires a pnpm package manager declaration');
    version = specification.slice(5);
  }
  if (specification === undefined && engine && engine.name !== 'pnpm')
    throw new Error('pnpm lockfile requires a pnpm package manager declaration');
  if (version === undefined) return undefined;
  if (
    typeof version !== 'string' ||
    !semver.valid(version) ||
    version.includes('+') ||
    !semver.satisfies(version, '>=11.0.0')
  )
    throw new Error(
      'pnpm setup requires an exact version >=11 without an integrity suffix; use setup-pnpm: false for a custom setup',
    );
  return version;
}

export async function preparePnpm(context) {
  if (context.env.INPUT_SETUP_PNPM === 'false') return requireVersion('pnpm', '11.0.0', context);
  const manifest = JSON.parse(await readFile(path.join(context.directory, 'package.json'), 'utf8'));
  let version = pnpmVersion(manifest);
  if (!version) {
    try {
      await requireVersion('pnpm', '11.0.0', context);
      return;
    } catch {
      version = defaultPnpmVersion;
    }
  }
  if (!context.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required for pnpm setup');
  const directory = await mkdtemp(path.join(context.env.RUNNER_TEMP, 'lockfile-pnpm-'));
  context.cleanup = () => rm(directory, { recursive: true, force: true });
  const installContext = { directory, env: context.env };
  await command(
    'npm',
    [
      'install',
      '--prefix',
      directory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      `pnpm@${version}`,
    ],
    installContext,
  );
  if (semver.gte(version, '12.0.0'))
    await command(
      process.execPath,
      [path.join(directory, 'node_modules/pnpm/install.js')],
      installContext,
    );
  context.env = {
    ...context.env,
    PATH: `${path.join(directory, 'node_modules/.bin')}${path.delimiter}${context.env.PATH ?? ''}`,
  };
  await requireVersion('pnpm', version, context);
}

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
