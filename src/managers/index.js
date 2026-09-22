import { rm } from 'node:fs/promises';
import path from 'node:path';
import { command, requireVersion } from '../command.js';
import { prepareCargo, updateCargo } from './cargo.js';

export const managers = new Map([
  [
    'Cargo.lock',
    {
      name: 'cargo',
      manifest: 'Cargo.toml',
      prepare: prepareCargo,
      update: updateCargo,
    },
  ],
  [
    'pnpm-lock.yaml',
    {
      name: 'pnpm',
      manifest: 'package.json',
      prepare: (context) => requireVersion('pnpm', '11.0.0', context),
      async update(context) {
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
      },
    },
  ],
  [
    'yarn.lock',
    {
      name: 'yarn',
      manifest: 'package.json',
      prepare: (context) => requireVersion('yarn', '4.10.0', context),
      async update(context) {
        await command('yarn', ['up', '-R', '--mode=update-lockfile', '*', '@*/*'], {
          ...context,
          env: {
            ...context.env,
            YARN_NPM_MINIMAL_AGE_GATE: String(context.age.minutes),
            YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
            YARN_ENABLE_SCRIPTS: 'false',
          },
        });
      },
    },
  ],
  [
    'uv.lock',
    {
      name: 'uv',
      manifest: 'pyproject.toml',
      prepare: (context) => requireVersion('uv', '0.9.17', context),
      update: (context) =>
        command(
          'uv',
          [
            'lock',
            '--project',
            context.directory,
            '--upgrade',
            '--exclude-newer',
            `${context.age.seconds} seconds`,
          ],
          context,
        ),
    },
  ],
  [
    'Gemfile.lock',
    {
      name: 'bundler',
      manifest: 'Gemfile',
      prepare: (context) => requireVersion('bundle', '4.0.18', context),
      update: (context) =>
        command('bundle', ['lock', '--update', '--cooldown', String(context.age.days)], {
          ...context,
          env: { ...context.env, BUNDLE_GEMFILE: path.join(context.directory, 'Gemfile') },
        }),
    },
  ],
]);

export const defaultPatterns = [...managers.keys()].join('\n');
