import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main, run, temporaryDirectory, trackFiles } from '../helpers.js';

for (const manager of ['pnpm', 'yarn']) {
  test(`real ${manager} excludes young direct and scoped transitive versions`, async (t) => {
    const directory = await temporaryDirectory(t);
    const workspace = path.join(directory, 'checkout');
    await mkdir(workspace);
    const archives = new Map();
    for (const name of ['maint-fixture', '@scope/maint-child']) {
      for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
        const packageRoot = path.join(directory, 'archive');
        await mkdir(path.join(packageRoot, 'package'), { recursive: true });
        await writeFile(
          path.join(packageRoot, 'package/package.json'),
          JSON.stringify({
            name,
            version,
            ...(name === 'maint-fixture'
              ? { dependencies: { '@scope/maint-child': '^1.0.0' } }
              : {}),
          }),
        );
        const result = await run('tar', ['-czf', path.join(directory, 'package.tgz'), 'package'], {
          cwd: packageRoot,
        });
        assert.equal(result.code, 0, result.stderr);
        archives.set(`${name}/${version}`, await readFile(path.join(directory, 'package.tgz')));
      }
    }
    let initial = true;
    let registry;
    const server = createServer((request, response) => {
      const url = new URL(request.url, registry);
      const name = decodeURIComponent(url.pathname.slice(1));
      if (name.startsWith('tarballs/')) {
        const archive = archives.get(name.slice('tarballs/'.length));
        if (!archive) return response.writeHead(404).end();
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(archive);
        return;
      }
      if (!['maint-fixture', '@scope/maint-child'].includes(name))
        return response.writeHead(404).end();
      const versions = {};
      const time = {};
      for (const [version, days] of [
        ['1.0.0', 30],
        ['1.1.0', 10],
        ['1.2.0', 0],
      ]) {
        if (initial && version !== '1.0.0') continue;
        versions[version] = {
          name,
          version,
          ...(name === 'maint-fixture' ? { dependencies: { '@scope/maint-child': '^1.0.0' } } : {}),
          dist: {
            tarball: `${registry}/tarballs/${name}/${version}`,
            shasum: createHash('sha1')
              .update(archives.get(`${name}/${version}`))
              .digest('hex'),
          },
        };
        time[version] = new Date(Date.now() - days * 86400000).toISOString();
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          name,
          versions,
          time,
          'dist-tags': { latest: initial ? '1.0.0' : '1.2.0' },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    registry = `http://127.0.0.1:${server.address().port}`;
    const manifest = JSON.stringify({
      name: 'test-project',
      private: true,
      dependencies: { 'maint-fixture': '^1.0.0' },
    });
    await writeFile(path.join(workspace, 'package.json'), manifest);
    await writeFile(path.join(workspace, '.npmrc'), `registry=${registry}\n`);
    await writeFile(
      path.join(workspace, '.yarnrc.yml'),
      `npmRegistryServer: ${JSON.stringify(registry)}\nunsafeHttpWhitelist:\n  - 127.0.0.1\n`,
    );
    if (manager === 'yarn') await writeFile(path.join(workspace, 'yarn.lock'), '');
    const env = {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      pnpm_config_store_dir: path.join(directory, 'pnpm-store'),
      pnpm_config_cache_dir: path.join(directory, 'pnpm-cache'),
      YARN_CACHE_FOLDER: path.join(directory, 'yarn-cache'),
      YARN_GLOBAL_FOLDER: path.join(directory, 'yarn-global'),
      YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
      YARN_ENABLE_SCRIPTS: 'false',
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: path.join(directory, 'output'),
      'INPUT_MINIMUM-RELEASE-AGE': '3 days',
      LOCKFILE_REPORT_PATH: path.join(directory, 'report.md'),
    };
    const generated = await run(
      manager,
      manager === 'pnpm'
        ? ['install', '--lockfile-only', '--ignore-scripts']
        : ['install', '--mode=update-lockfile'],
      {
        cwd: workspace,
        env: {
          ...env,
          pnpm_config_cache_dir: path.join(directory, 'initial-pnpm-cache'),
          YARN_GLOBAL_FOLDER: path.join(directory, 'initial-yarn-global'),
        },
      },
    );
    assert.equal(generated.code, 0, generated.stderr + generated.stdout);
    await writeFile(path.join(workspace, 'package.json'), manifest);
    initial = false;
    await trackFiles(workspace);
    const result = await run(process.execPath, [main], { cwd: workspace, env });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const report = await readFile(env.LOCKFILE_REPORT_PATH, 'utf8');
    assert.match(report, /<code>1\.0\.0<\/code> \| <code>1\.1\.0<\/code>/);
    const lockfile = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock';
    const updated = await readFile(path.join(workspace, lockfile), 'utf8');
    assert.match(updated, /1\.1\.0/);
    assert.doesNotMatch(updated, /1\.2\.0/);
    assert.doesNotMatch(updated, /version: ["']?1\.0\.0/);
    assert.equal(await readFile(path.join(workspace, 'package.json'), 'utf8'), manifest);
    await writeFile(path.join(workspace, 'package.json'), manifest.replace('^1.0.0', '1.2.0'));
    const denied = await run(process.execPath, [main], { cwd: workspace, env });
    assert.equal(denied.code, 1, denied.stderr + denied.stdout);
    assert.equal(await readFile(path.join(workspace, lockfile), 'utf8'), updated);
  });
}
