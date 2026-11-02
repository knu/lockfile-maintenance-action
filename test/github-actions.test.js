import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { maintainLockfile } from '../src/maintenance.js';
import { lockfileTargets } from '../src/targets.js';
import { parseActionsLock } from '../src/actions-lockfile.js';
import { temporaryDirectory, trackFiles } from './helpers.js';

async function fixture(t) {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  await mkdir(path.join(workspace, '.github/workflows'), { recursive: true });
  const workflow =
    'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: example/action@v1\n';
  await writeFile(path.join(workspace, '.github/workflows/ci.yml'), workflow);
  const contents = stringify({
    version: 'v0.0.3',
    workflows: { '.github/workflows/ci.yml': ['example/action@v1'] },
    dependencies: {
      'example/action@v1': { ref: 'v1', commit: `sha1-${'a'.repeat(40)}`, owner_id: 1, repo_id: 2 },
    },
  });
  const file = path.join(workspace, '.github/workflows/actions.lock');
  await writeFile(file, contents);
  await trackFiles(workspace);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const executable = path.join(bin, 'gh');
  await writeFile(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args.includes('--version')) console.log('actions-lock version v0.4.0');
if (args.includes('--verify') && process.env.FAIL_VERIFY === 'true' && fs.readFileSync('.github/workflows/actions.lock', 'utf8').includes('sha1-${'b'.repeat(40)}')) process.exit(1);
`,
  );
  await chmod(executable, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(directory, 'outputs'),
    CALL_LOG: path.join(directory, 'calls'),
    INPUT_SETUP_ACTIONS_LOCK: 'false',
    INPUT_TOKEN: 'test-token',
    INPUT_CREATE_PULL_REQUEST: 'false',
    LOCKFILE_REPORT_PATH: path.join(directory, 'report.md'),
    'INPUT_MINIMUM-RELEASE-AGE': '7 days',
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    let data;
    if (route.endsWith('/releases'))
      data = [{ tag_name: 'v1.1.0', published_at: '2020-01-01T00:00:00Z' }];
    else if (route.includes('/commits/')) data = { sha: 'b'.repeat(40) };
    else if (route.includes('/compare/')) data = { status: 'ahead' };
    else if (route.includes('/contents/'))
      data = {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('runs:\n  using: node24\n  main: index.js\n').toString('base64'),
      };
    else data = { id: 2, owner: { id: 1 } };
    return Response.json(data);
  });
  return { workspace, env, file, contents, workflow };
}

test('maintenance selects the canonical tracked lockfile, reports commits, and verifies without editing workflows', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, 'other'));
  await writeFile(path.join(f.workspace, 'other/actions.lock'), 'not an Actions lockfile');
  await trackFiles(f.workspace);
  assert.deepEqual(
    (await lockfileTargets(f.env)).targets.map(({ file }) => file),
    ['.github/workflows/actions.lock'],
  );
  await maintainLockfile(f.env);
  assert.equal(
    parseActionsLock(await readFile(f.file, 'utf8')).dependencies['example/action@v1'].commit,
    `sha1-${'b'.repeat(40)}`,
  );
  assert.equal(
    await readFile(path.join(f.workspace, '.github/workflows/ci.yml'), 'utf8'),
    f.workflow,
  );
  const calls = (await readFile(f.env.CALL_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((args) => args.includes('--verify')).length, 2);
  assert.ok(calls.every((args) => !args.includes('--accept-moved') && !args.includes('--relock')));
  assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), /changed=true/);
  assert.match(
    await readFile(f.env.LOCKFILE_REPORT_PATH, 'utf8'),
    new RegExp(`sha1-${'b'.repeat(40)}`),
  );
});

test('failed official verification restores the original lockfile and emits no success output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    maintainLockfile({ ...f.env, FAIL_VERIFY: 'true' }),
    /original files restored/,
  );
  assert.equal(await readFile(f.file, 'utf8'), f.contents);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
});
