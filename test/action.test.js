import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main, project, run, temporaryDirectory, trackFiles } from './helpers.js';

const tools = {
  npm: ['package-lock.json', 'package.json', '11.19.0'],
  rustup: ['Cargo.lock', 'Cargo.toml', '1.100.0'],
  pnpm: ['pnpm-lock.yaml', 'package.json', '12.4.2'],
  yarn: ['yarn.lock', 'package.json', '4.18.0'],
  uv: ['uv.lock', 'pyproject.toml', '0.12.17'],
  bundle: ['Gemfile.lock', 'Gemfile', '4.0.21'],
};

async function fixture(t) {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  await project(workspace);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  for (const name of Object.keys(tools)) {
    const shim = path.join(bin, name);
    await writeFile(
      shim,
      `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const [lockfile, manifest, version] = ${JSON.stringify(tools)}[tool];
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ tool, args, cwd: process.cwd(), age: process.env.YARN_NPM_MINIMAL_AGE_GATE }) + '\\n');
if (args.includes('--version')) {
  if (process.env.TEST_MODE === 'install' && tool === 'rustup') process.exit(1);
  console.log(process.env.TEST_OLD_TOOL === tool ? '0.1.0' : version);
  process.exit(0);
}
if (args[0] === 'toolchain') process.exit(0);
if (process.env.TEST_MODE !== 'unchanged') fs.writeFileSync(lockfile, 'updated\\n');
if (process.env.TEST_MODE === 'manifest') fs.writeFileSync(manifest, 'modified\\n');
if (process.env.TEST_MODE === 'other-lock') fs.writeFileSync('../other/Cargo.lock', 'modified\\n');
if (process.env.TEST_FAIL_TOOL === tool || process.env.TEST_MODE === 'failure') process.exit(42);
`,
    );
    await chmod(shim, 0o755);
  }
  const output = path.join(directory, 'output');
  const log = path.join(directory, 'calls');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: log,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: output,
    'INPUT_MINIMUM-RELEASE-AGE': '3 days',
    'INPUT_WORKING-DIRECTORY': '.',
  };
  const invoke = async (overrides = {}, entry = main, stage = true) => {
    if (stage) await trackFiles(workspace);
    return run(process.execPath, [entry], { cwd: directory, env: { ...env, ...overrides } });
  };
  const add = async (relative, tool) => {
    const cwd = path.join(workspace, relative);
    await mkdir(cwd, { recursive: true });
    for (const file of tools[tool].slice(0, 2)) await writeFile(path.join(cwd, file), 'original\n');
  };
  return { directory, workspace, output, log, invoke, add };
}

async function outputs(file) {
  return Object.fromEntries(
    (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
      }),
  );
}

test('selects lockfiles by ordered patterns, with exclusions, reinclusion and spaces', async (t) => {
  const f = await fixture(t);
  for (const directory of ['rust project', 'vendor/skip', 'vendor/keep'])
    await project(path.join(f.workspace, directory));
  const result = await f.invoke({
    INPUT_FILES: 'Cargo.lock\n!/Cargo.lock\n!vendor/\nvendor/keep/Cargo.lock',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await outputs(f.output), {
    changed: true,
    lockfiles: ['rust project/Cargo.lock', 'vendor/keep/Cargo.lock'],
    'changed-lockfiles': ['rust project/Cargo.lock', 'vendor/keep/Cargo.lock'],
  });
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
  assert.equal(
    await readFile(path.join(f.workspace, 'vendor/skip/Cargo.lock'), 'utf8'),
    'version = 4\n',
  );
});

test('auto-selects all six tools and rounds up age for each native unit', async (t) => {
  const f = await fixture(t);
  for (const tool of ['npm', 'pnpm', 'yarn', 'uv', 'bundle']) await f.add(tool, tool);
  const started = Date.now();
  const result = await f.invoke({ 'INPUT_MINIMUM-RELEASE-AGE': '86401 seconds' });
  assert.equal(result.code, 0, result.stderr);
  const output = await outputs(f.output);
  assert.equal(output.lockfiles.length, 6);
  assert.equal(output['changed-lockfiles'].length, 6);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const update = (tool) =>
    calls.find((call) => call.tool === tool && !call.args.includes('--version'));
  const cutoff = Date.parse(
    update('npm')
      .args.find((arg) => arg.startsWith('--before='))
      .slice(9),
  );
  assert.ok(cutoff >= started - 86401000 && cutoff <= Date.now() - 86401000);
  assert.ok(update('pnpm').args.includes('--config.minimum-release-age=1441'));
  assert.ok(update('pnpm').args.includes('--config.minimum-release-age-strict=true'));
  assert.equal(update('yarn').age, '1441');
  assert.deepEqual(update('uv').args.slice(-2), ['--exclude-newer', '86401 seconds']);
  assert.deepEqual(update('bundle').args.slice(-2), ['--cooldown', '2']);
  assert.ok(update('rustup').args.includes('registry.min-publish-age="86401 seconds"'));
});

test('reports no changes for unchanged lockfiles', async (t) => {
  const f = await fixture(t);
  const result = await f.invoke({ TEST_MODE: 'unchanged' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await outputs(f.output), {
    changed: false,
    lockfiles: ['Cargo.lock'],
    'changed-lockfiles': [],
  });
});

test('exports literal PR paths when PR creation is enabled, including unchanged runs', async (t) => {
  const f = await fixture(t);
  await trackFiles(f.workspace);
  const committed = await run(
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
    { cwd: f.workspace },
  );
  assert.equal(committed.code, 0, committed.stderr);
  const result = await f.invoke({ INPUT_CREATE_PULL_REQUEST: 'true', TEST_MODE: 'unchanged' });
  assert.equal(result.code, 0, result.stderr);
  const output = await readFile(f.output, 'utf8');
  assert.match(output, /changed=false\n/);
  assert.match(output, /pr-paths<<([^\n]+)\n:\(literal\)Cargo.lock\n\1\n/);
});

test('scopes patterns to working-directory without excluding tracked directories', async (t) => {
  const f = await fixture(t);
  for (const directory of ['project', 'project/node_modules/fake', 'project/target/fake']) {
    await project(path.join(f.workspace, directory));
  }
  const result = await f.invoke({
    'INPUT_WORKING-DIRECTORY': 'project',
    INPUT_FILES: 'Cargo.lock',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await outputs(f.output)).lockfiles, [
    'project/Cargo.lock',
    'project/node_modules/fake/Cargo.lock',
    'project/target/fake/Cargo.lock',
  ]);
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
});

test('ignores untracked and ignored lockfiles even when explicitly matched', async (t) => {
  const f = await fixture(t);
  await project(path.join(f.workspace, ' leading space'));
  await writeFile(path.join(f.workspace, '.gitignore'), 'ignored/\n');
  await trackFiles(f.workspace);
  for (const directory of ['untracked', 'ignored'])
    await project(path.join(f.workspace, directory));
  const result = await f.invoke(
    { INPUT_FILES: 'Cargo.lock\nuntracked/Cargo.lock\nignored/Cargo.lock' },
    main,
    false,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await outputs(f.output)).lockfiles, [
    ' leading space/Cargo.lock',
    'Cargo.lock',
  ]);
  for (const directory of ['untracked', 'ignored'])
    assert.equal(
      await readFile(path.join(f.workspace, directory, 'Cargo.lock'), 'utf8'),
      'version = 4\n',
    );
  const unmatched = await f.invoke({ INPUT_FILES: 'untracked/Cargo.lock' }, main, false);
  assert.equal(unmatched.code, 1);
  assert.match(unmatched.stderr, /matched no supported lockfiles/);
});

test('restores files if success outputs cannot be written', async (t) => {
  const f = await fixture(t);
  const result = await f.invoke({ GITHUB_OUTPUT: f.directory });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /original files restored/);
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
});

test('restores lockfiles if a changed lockfile cannot be parsed for the PR report', async (t) => {
  const f = await fixture(t);
  const report = path.join(f.directory, 'report.md');
  const result = await f.invoke({ LOCKFILE_REPORT_PATH: report });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /original files restored/);
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await assert.rejects(readFile(report), { code: 'ENOENT' });
});

test('installs the pinned Cargo toolchain when absent', async (t) => {
  const f = await fixture(t);
  const result = await f.invoke({ TEST_MODE: 'install' });
  assert.equal(result.code, 0, result.stderr);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls[1].args[0], 'toolchain');
  assert.equal(calls[1].args[2], calls[2].args[1]);
  assert.ok(calls[1].args.includes('--no-self-update'));
});

for (const mode of ['failure', 'manifest']) {
  test(`rolls back all changes after ${mode} without success outputs`, async (t) => {
    const f = await fixture(t);
    await f.add('other', 'rustup');
    const result = await f.invoke({ INPUT_FILES: '/Cargo.lock', TEST_MODE: mode });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /original files restored/);
    assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  });
}

test('restores an unselected lockfile changed by workspace discovery', async (t) => {
  const f = await fixture(t);
  await f.add('selected', 'rustup');
  await f.add('other', 'rustup');
  const result = await f.invoke({ INPUT_FILES: 'selected/Cargo.lock', TEST_MODE: 'other-lock' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unselected lockfile: other\/Cargo.lock/);
  assert.equal(await readFile(path.join(f.workspace, 'other/Cargo.lock'), 'utf8'), 'original\n');
  assert.equal(await readFile(path.join(f.workspace, 'selected/Cargo.lock'), 'utf8'), 'original\n');
});

test('restores earlier successful updates when a later tool fails', async (t) => {
  const f = await fixture(t);
  await f.add('z-python', 'uv');
  const result = await f.invoke({ TEST_FAIL_TOOL: 'uv' });
  assert.equal(result.code, 1);
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
  assert.equal(await readFile(path.join(f.workspace, 'z-python/uv.lock'), 'utf8'), 'original\n');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('rejects old tools before updating any lockfiles', async (t) => {
  const f = await fixture(t);
  await f.add('z-python', 'uv');
  const result = await f.invoke({ TEST_OLD_TOOL: 'uv' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /uv >=0.9.17/);
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
});

for (const age of [
  '',
  '0',
  '-1 days',
  '3 days\nfoo',
  '3 days"; touch unexpected',
  'three days',
  '9999999999999999999 days',
]) {
  test(`rejects invalid age ${JSON.stringify(age)} before executing tools`, async (t) => {
    const f = await fixture(t);
    const result = await f.invoke({ 'INPUT_MINIMUM-RELEASE-AGE': age });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /minimum-release-age/);
    await assert.rejects(readFile(f.log), { code: 'ENOENT' });
  });
}

test('rejects multiple package managers for the same manifest', async (t) => {
  const f = await fixture(t);
  await f.add('js', 'pnpm');
  await f.add('js', 'yarn');
  const result = await f.invoke();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /multiple package managers/);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('rejects npm shrinkwrap before modifying any lockfiles', async (t) => {
  const f = await fixture(t);
  await f.add('npm', 'npm');
  await writeFile(path.join(f.workspace, 'npm/npm-shrinkwrap.json'), '{}\n');
  const result = await f.invoke();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /npm-shrinkwrap.json takes precedence/);
  assert.equal(
    await readFile(path.join(f.workspace, 'npm/package-lock.json'), 'utf8'),
    'original\n',
  );
  assert.equal(await readFile(path.join(f.workspace, 'Cargo.lock'), 'utf8'), 'version = 4\n');
});

test('requires a matching lockfile and its manifest', async (t) => {
  const f = await fixture(t);
  const result = await f.invoke({ INPUT_FILES: 'not-found/Cargo.lock' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /matched no supported lockfiles/);
  await writeFile(path.join(f.workspace, 'uv.lock'), '');
  const missing = await f.invoke({ INPUT_FILES: 'uv.lock' });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /required file missing.*pyproject.toml/);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('rejects paths and symlinks escaping the checkout', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await project(outside);
  await symlink(outside, path.join(f.workspace, 'linked'));
  for (const directory of ['../outside', 'linked', outside]) {
    const result = await f.invoke({ 'INPUT_WORKING-DIRECTORY': directory });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /inside the checkout/);
  }
});

test('rejects selected symlinked lockfiles and preserves unrelated symlinks', async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.workspace, 'nested');
  await mkdir(nested);
  await writeFile(path.join(nested, 'Cargo.toml'), '[workspace]\n');
  await symlink('../Cargo.lock', path.join(nested, 'Cargo.lock'));
  const result = await f.invoke({ 'INPUT_WORKING-DIRECTORY': 'nested' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /regular file/);
  const excluded = await f.invoke({ INPUT_FILES: '/Cargo.lock' });
  assert.equal(excluded.code, 0, excluded.stderr);
});
