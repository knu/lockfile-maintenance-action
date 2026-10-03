import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pnpmVersion, preparePnpm, updatePnpm } from '../src/managers/pnpm.js';
import { temporaryDirectory } from './helpers.js';

test('selects exact pnpm declarations and rejects ambiguous or conflicting versions', () => {
  assert.equal(pnpmVersion({ packageManager: 'pnpm@12.8.1' }), '12.8.1');
  assert.equal(
    pnpmVersion({ devEngines: { packageManager: { name: 'pnpm', version: '11.0.0' } } }),
    '11.0.0',
  );
  assert.equal(pnpmVersion({}), undefined);
  for (const packageManager of [
    'npm@11.0.0',
    'pnpm@latest',
    'pnpm@^12',
    'pnpm@10.0.0',
    'pnpm@12.0.0+sha512.abc',
    {},
  ])
    assert.throws(() => pnpmVersion({ packageManager }));
});

test('prepares independent pnpm versions outside the checkout and uses each for updates', async (t) => {
  const root = await temporaryDirectory(t);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const npm = path.join(bin, 'npm');
  await writeFile(
    npm,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
const root=args[args.indexOf('--prefix')+1];
const version=args.at(-1).slice(5);
if (!args.includes('--ignore-scripts')) process.exit(1);
fs.mkdirSync(path.join(root,'node_modules/.bin'),{recursive:true});
fs.mkdirSync(path.join(root,'node_modules/pnpm'),{recursive:true});
fs.writeFileSync(path.join(root,'node_modules/pnpm/install.js'),'');
const tool=path.join(root,'node_modules/.bin/pnpm');
fs.writeFileSync(tool, ${JSON.stringify(`#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')) console.log(VERSION);
else fs.writeFileSync('pnpm-lock.yaml',VERSION);
`)}.replaceAll('VERSION',JSON.stringify(version)));
fs.chmodSync(tool,0o755);
`,
  );
  await chmod(npm, 0o755);
  const contexts = [];
  for (const version of ['11.0.0', '12.8.1', '12.4.2']) {
    const directory = path.join(root, version);
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(version === '12.4.2' ? {} : { packageManager: `pnpm@${version}` }),
    );
    await writeFile(path.join(directory, 'pnpm-lock.yaml'), 'before');
    const context = {
      directory,
      age: { minutes: 4320 },
      env: { ...process.env, RUNNER_TEMP: root, PATH: bin },
    };
    contexts.push(context);
    t.after(() => context.cleanup?.());
    await preparePnpm(context);
  }
  for (const context of contexts) {
    await updatePnpm(context);
    assert.equal(
      await readFile(path.join(context.directory, 'pnpm-lock.yaml'), 'utf8'),
      path.basename(context.directory),
    );
    await assert.rejects(access(path.join(context.directory, 'node_modules')));
    const tool = context.env.PATH.split(path.delimiter)[0];
    await context.cleanup();
    await assert.rejects(access(tool));
  }
});
