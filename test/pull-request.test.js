import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pullRequestPaths } from '../src/pull-request.js';
import { run, temporaryDirectory, trackFiles } from './helpers.js';

const env = { ...process.env, INPUT_CREATE_PULL_REQUEST: 'true' };

async function checkout(t) {
  const directory = await temporaryDirectory(t);
  const files = [' leading space/Cargo.lock', '[app]/Cargo.lock', 'app/Cargo.lock'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), 'version = 4\n');
  }
  await trackFiles(directory);
  const result = await run(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Fixture',
    ],
    { cwd: directory },
  );
  assert.equal(result.code, 0, result.stderr);
  return { directory, files };
}

test('PR pathspecs preserve spaces and match metacharacters literally', async (t) => {
  const { directory, files } = await checkout(t);
  const selected = files.slice(0, 2);
  const paths = await pullRequestPaths(directory, selected, env);
  const result = await run('git', ['ls-files', '-z', '--', ...paths.split('\n')], {
    cwd: directory,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\0').filter(Boolean), selected);
});

test('PR creation rejects unrelated tracked changes and staged files', async (t) => {
  const { directory, files } = await checkout(t);
  await writeFile(path.join(directory, files[2]), 'changed\n');
  await assert.rejects(pullRequestPaths(directory, files.slice(0, 1), env), /clean tracked/);
  await trackFiles(directory);
  await assert.rejects(pullRequestPaths(directory, files.slice(0, 1), env), /clean tracked/);
  assert.equal(
    await pullRequestPaths(directory, files, { ...env, INPUT_CREATE_PULL_REQUEST: 'false' }),
    undefined,
  );
});

test('untracked generated files do not enter the PR selection', async (t) => {
  const { directory, files } = await checkout(t);
  await writeFile(path.join(directory, 'generated.txt'), 'generated\n');
  const paths = await pullRequestPaths(directory, files, env);
  assert.equal(paths.split('\n').length, files.length);
  assert.ok(!paths.includes('generated.txt'));
});

test('rejects ambiguous PR path separators and invalid opt-out values', async (t) => {
  const { directory } = await checkout(t);
  for (const file of ['a,b/Cargo.lock', 'a\nb/Cargo.lock', 'a\rb/Cargo.lock'])
    await assert.rejects(pullRequestPaths(directory, [file], env), /commas or newlines/);
  await assert.rejects(
    pullRequestPaths(directory, [], { ...env, INPUT_CREATE_PULL_REQUEST: 'yes' }),
    /true or false/,
  );
});
