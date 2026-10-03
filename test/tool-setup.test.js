import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { setupTools } from '../src/tool-setup.js';
import { cargoToolchain } from '../src/managers/cargo.js';
import { packageManagerVersion } from '../src/managers/node-setup.js';
import { temporaryDirectory, trackFiles } from './helpers.js';

test('tool setup uses the same tracked file selection and working directory as maintenance', async (t) => {
  const root = await temporaryDirectory(t);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'rustup'),
    `#!${process.execPath}\nprocess.exit(Number(process.env.RUSTUP_EXIT));\n`,
  );
  await chmod(path.join(bin, 'rustup'), 0o755);
  for (const [directory, files] of [
    ['rust', ['Cargo.toml', 'Cargo.lock']],
    ['python', ['pyproject.toml', 'uv.lock']],
    ['ruby', ['Gemfile', 'Gemfile.lock']],
  ]) {
    await mkdir(path.join(root, directory));
    for (const file of files) await writeFile(path.join(root, directory, file), '');
  }
  await trackFiles(root);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUSTUP_EXIT: '1',
    GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: path.join(root, 'outputs'),
  };
  assert.deepEqual(await setupTools(env), {
    uv: true,
    bundler: true,
    rustup: true,
    'cargo-toolchain': cargoToolchain,
  });
  assert.equal((await setupTools({ ...env, RUSTUP_EXIT: '0' })).rustup, false);
  assert.deepEqual(await setupTools({ ...env, INPUT_FILES: 'uv.lock\n!ruby/\n!rust/' }), {
    uv: true,
    bundler: false,
    rustup: false,
    'cargo-toolchain': cargoToolchain,
  });
  assert.deepEqual(await setupTools({ ...env, 'INPUT_WORKING-DIRECTORY': 'ruby' }), {
    uv: false,
    bundler: true,
    rustup: false,
    'cargo-toolchain': cargoToolchain,
  });
});

test('Yarn uses exact modern versions and rejects incompatible declarations', () => {
  assert.equal(
    packageManagerVersion({ packageManager: 'yarn@4.18.0' }, 'yarn', '4.10.0'),
    '4.18.0',
  );
  for (const packageManager of ['yarn@1.22.0', 'yarn@latest', 'pnpm@12.4.2'])
    assert.throws(() => packageManagerVersion({ packageManager }, 'yarn', '4.10.0'));
});

test('composite setup runs after checkout and respects selection and opt-outs without installing dependencies', async () => {
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'));
  const steps = action.runs.steps;
  const detection = steps.findIndex((step) => step.id === 'tools');
  const update = steps.findIndex((step) => step.id === 'maintenance');
  assert.ok(detection > steps.findIndex((step) => step.uses?.startsWith('actions/checkout@')));
  for (const [name, repo] of [
    ['uv', 'astral-sh/setup-uv'],
    ['bundler', 'ruby/setup-ruby'],
    ['rustup', 'actions-rust-lang/setup-rust-toolchain'],
  ]) {
    const index = steps.findIndex((step) => step.uses?.startsWith(repo + '@'));
    assert.ok(index > detection && index < update);
    assert.equal(
      steps[index].if,
      `steps.tools.outputs.${name} == 'true' && inputs.setup-${name} == 'true'`,
    );
  }
  assert.equal(
    steps.find((step) => step.uses?.startsWith('ruby/setup-ruby@')).with['bundler-cache'],
    false,
  );
  assert.equal(
    steps.find((step) => step.uses?.startsWith('astral-sh/setup-uv@')).with['enable-cache'],
    false,
  );
});
