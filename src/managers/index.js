import path from 'node:path';
import { command, requireVersion } from '../command.js';
import { prepareCargo, updateCargo } from './cargo.js';
import { prepareNpm, updateNpm } from './npm.js';
import { preparePnpm, updatePnpm } from './pnpm.js';
import { prepareNodeManager } from './node-setup.js';

export const managers = new Map([
  [
    'package-lock.json',
    {
      name: 'npm',
      manifest: 'package.json',
      prepare: prepareNpm,
      update: updateNpm,
    },
  ],
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
      prepare: preparePnpm,
      update: updatePnpm,
    },
  ],
  [
    'yarn.lock',
    {
      name: 'yarn',
      manifest: 'package.json',
      prepare: (context) =>
        prepareNodeManager(context, {
          name: 'yarn',
          packageName: '@yarnpkg/cli-dist',
          minimum: '4.10.0',
          fallback: '4.18.0',
        }),
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
