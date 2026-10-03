import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { command, requireVersion } from '../command.js';

export function packageManagerVersion(manifest, name, minimum) {
  const specification = manifest.packageManager;
  const engine = manifest.devEngines?.packageManager;
  let version = engine?.version;
  if (specification !== undefined) {
    if (typeof specification !== 'string' || !specification.startsWith(`${name}@`))
      throw new Error(`${name} lockfile requires a ${name} package manager declaration`);
    version = specification.slice(name.length + 1);
  }
  if (specification === undefined && engine && engine.name !== name)
    throw new Error(`${name} lockfile requires a ${name} package manager declaration`);
  if (version === undefined) return undefined;
  if (
    typeof version !== 'string' ||
    !semver.valid(version) ||
    version.includes('+') ||
    !semver.satisfies(version, `>=${minimum}`)
  )
    throw new Error(
      `${name} setup requires an exact version >=${minimum} without an integrity suffix; use setup-${name}: false for a custom setup`,
    );
  return version;
}

export async function prepareNodeManager(context, { name, packageName, minimum, fallback }) {
  if (context.env[`INPUT_SETUP_${name.toUpperCase()}`] === 'false')
    return requireVersion(name, minimum, context);
  const manifest = JSON.parse(await readFile(path.join(context.directory, 'package.json'), 'utf8'));
  let version = packageManagerVersion(manifest, name, minimum);
  if (!version) {
    try {
      await requireVersion(name, minimum, context);
      return;
    } catch {
      version = fallback;
    }
  }
  if (!context.env.RUNNER_TEMP) throw new Error(`RUNNER_TEMP is required for ${name} setup`);
  const directory = await mkdtemp(path.join(context.env.RUNNER_TEMP, `lockfile-${name}-`));
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
      `${packageName}@${version}`,
    ],
    installContext,
  );
  if (name === 'pnpm' && semver.gte(version, '12.0.0'))
    await command(
      process.execPath,
      [path.join(directory, 'node_modules/pnpm/install.js')],
      installContext,
    );
  context.env = {
    ...context.env,
    PATH: `${path.join(directory, 'node_modules/.bin')}${path.delimiter}${context.env.PATH ?? ''}`,
  };
  await requireVersion(name, version, context);
}
