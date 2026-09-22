import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { project, run, temporaryDirectory, trackFiles } from '../helpers.js';

test('installs an isolated Action runtime and reuses its npm cache offline', async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  const runnerTemp = path.join(directory, 'runner');
  await mkdir(runnerTemp);
  await project(workspace);
  await writeFile(
    path.join(workspace, 'Cargo.toml'),
    '[package]\nname = "runtime-test"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src/lib.rs'), '');
  await trackFiles(workspace);
  const output = path.join(directory, 'setup-output');
  const setup = await run(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/setup.js', import.meta.url))],
    { cwd: workspace, env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output } },
  );
  assert.equal(setup.code, 0, setup.stderr);
  const values = Object.fromEntries(
    (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.match(values['lock-hash'], /^[0-9a-f]{64}$/);
  const args = [
    'ci',
    '--prefix',
    values.directory,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
  const env = { ...process.env, NPM_CONFIG_CACHE: path.join(runnerTemp, 'npm-cache') };
  for (const extra of [[], ['--offline']]) {
    const installed = await run('npm', [...args, ...extra], { cwd: workspace, env });
    assert.equal(installed.code, 0, installed.stderr);
  }
  const result = await run(process.execPath, [path.join(values.directory, 'src/main.js')], {
    cwd: workspace,
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: path.join(directory, 'action-output'),
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    await readFile(path.join(directory, 'action-output'), 'utf8'),
    /lockfiles=\["Cargo.lock"\]/,
  );
  await assert.rejects(readFile(path.join(workspace, 'node_modules/ignore/package.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(path.join(values.directory, 'node_modules/pnpm/package.json')), {
    code: 'ENOENT',
  });
});
