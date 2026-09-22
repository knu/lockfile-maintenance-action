import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { cargoToolchain } from '../../src/managers/cargo.js';
import { main, run, temporaryDirectory, trackFiles } from '../helpers.js';

test('real Cargo excludes young direct and transitive versions and refuses an unsatisfiable age policy', async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  await mkdir(path.join(workspace, '.cargo'), { recursive: true });
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src/lib.rs'), '');
  const manifest =
    '[package]\nname = "age-test"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nmaint-fixture = "1"\n';
  await writeFile(path.join(workspace, 'Cargo.toml'), manifest);

  let initial = true;
  const versions = [
    ['1.0.0', 30],
    ['1.1.0', 10],
    ['1.2.0', 0],
  ];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/config.json') {
      res.end(JSON.stringify({ dl: 'http://127.0.0.1/unused' }));
      return;
    }
    const name = req.url.split('/').at(-1);
    if (!['maint-fixture', 'maint-child'].includes(name)) {
      res.writeHead(404).end();
      return;
    }
    res.end(
      (initial ? versions.slice(0, 1) : versions)
        .map(([version, days]) =>
          JSON.stringify({
            name,
            vers: version,
            deps:
              name === 'maint-child'
                ? []
                : [
                    {
                      name: 'maint-child',
                      req: '1',
                      features: [],
                      optional: false,
                      default_features: true,
                      target: null,
                      kind: 'normal',
                    },
                  ],
            cksum: '0'.repeat(64),
            features: {},
            yanked: false,
            pubtime: new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          }),
        )
        .join('\n') + '\n',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(
    path.join(workspace, '.cargo/config.toml'),
    `
[source.crates-io]
replace-with = "fixture"
[source.fixture]
registry = "sparse+http://127.0.0.1:${server.address().port}/"
[resolver]
incompatible-publish-age = "allow"
[registry]
min-publish-age = "0"
`,
  );
  const env = {
    ...process.env,
    CARGO_HOME: path.join(directory, 'cargo-home'),
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(directory, 'output'),
    'INPUT_MINIMUM-RELEASE-AGE': '3 days',
    LOCKFILE_REPORT_PATH: path.join(directory, 'report.md'),
    'INPUT_WORKING-DIRECTORY': '.',
  };
  const generated = await run('rustup', ['run', cargoToolchain, 'cargo', 'generate-lockfile'], {
    cwd: workspace,
    env,
  });
  assert.equal(generated.code, 0, generated.stderr);
  const original = await readFile(path.join(workspace, 'Cargo.lock'));
  initial = false;

  await trackFiles(workspace);
  const aged = await run(process.execPath, [main], { cwd: directory, env });
  assert.equal(aged.code, 0, aged.stderr);
  const report = await readFile(env.LOCKFILE_REPORT_PATH, 'utf8');
  assert.match(report, /<code>1\.0\.0<\/code> \| <code>1\.1\.0<\/code>/);
  const lock = await readFile(path.join(workspace, 'Cargo.lock'), 'utf8');
  assert.equal((lock.match(/version = "1.1.0"/g) ?? []).length, 2, lock);
  assert.doesNotMatch(lock, /version = "1.2.0"/);
  assert.equal(
    await readFile(env.GITHUB_OUTPUT, 'utf8'),
    'changed=true\nlockfiles=["Cargo.lock"]\nchanged-lockfiles=["Cargo.lock"]\n',
  );
  assert.equal(await readFile(path.join(workspace, 'Cargo.toml'), 'utf8'), manifest);

  const unchanged = await run(process.execPath, [main], { cwd: directory, env });
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.match(
    await readFile(env.GITHUB_OUTPUT, 'utf8'),
    /changed=false\nlockfiles=\["Cargo.lock"\]\nchanged-lockfiles=\[\]\n$/,
  );

  await writeFile(path.join(workspace, 'Cargo.lock'), original);
  const unrestricted = await run('rustup', ['run', cargoToolchain, 'cargo', 'update'], {
    cwd: workspace,
    env,
  });
  assert.equal(unrestricted.code, 0, unrestricted.stderr);
  assert.equal(
    ((await readFile(path.join(workspace, 'Cargo.lock'), 'utf8')).match(/version = "1.2.0"/g) ?? [])
      .length,
    2,
  );

  const downgraded = await run(process.execPath, [main], { cwd: directory, env });
  assert.equal(downgraded.code, 0, downgraded.stderr);
  assert.equal(await readFile(path.join(workspace, 'Cargo.lock'), 'utf8'), lock);

  await writeFile(path.join(workspace, 'Cargo.lock'), original);
  await writeFile(
    path.join(workspace, 'Cargo.toml'),
    manifest.replace('maint-fixture = "1"', 'maint-fixture = "=1.2.0"'),
  );
  const denied = await run(process.execPath, [main], { cwd: directory, env });
  assert.equal(denied.code, 1, denied.stderr);
  assert.deepEqual(await readFile(path.join(workspace, 'Cargo.lock')), original);
});
