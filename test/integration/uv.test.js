import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main, run, temporaryDirectory, trackFiles } from '../helpers.js';

test('real uv excludes young direct and transitive distributions', async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  await mkdir(workspace);
  let initial = true;
  let registry;
  const metadata = new Map();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, registry).pathname;
    if (pathname.endsWith('.metadata')) {
      const contents = metadata.get(pathname);
      if (!contents) return response.writeHead(404).end();
      response.end(contents);
      return;
    }
    const name = pathname.split('/').filter(Boolean).at(-1);
    if (!['maint-fixture', 'maint-child'].includes(name)) return response.writeHead(404).end();
    const files = [];
    for (const [version, days] of [
      ['1.0.0', 30],
      ['1.1.0', 10],
      ['1.2.0', 0],
    ]) {
      if (initial && version !== '1.0.0') continue;
      const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`;
      const contents = `Metadata-Version: 2.3\nName: ${name}\nVersion: ${version}\n${name === 'maint-fixture' ? 'Requires-Dist: maint-child>=1,<2\n' : ''}\n`;
      metadata.set(`/files/${filename}.metadata`, contents);
      files.push({
        filename,
        url: `${registry}/files/${filename}`,
        hashes: { sha256: '0'.repeat(64) },
        'core-metadata': { sha256: createHash('sha256').update(contents).digest('hex') },
        'requires-python': '>=3.8',
        'upload-time': new Date(Date.now() - days * 86400000).toISOString(),
      });
    }
    response.setHeader('Content-Type', 'application/vnd.pypi.simple.v1+json');
    response.end(JSON.stringify({ meta: { 'api-version': '1.4' }, name, files }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  registry = `http://127.0.0.1:${server.address().port}`;
  const manifest = `[project]\nname = "fixture-project"\nversion = "1.0.0"\nrequires-python = ">=3.8"\ndependencies = ["maint-fixture>=1,<2"]\n[[tool.uv.index]]\nurl = "${registry}/simple"\ndefault = true\n`;
  await writeFile(path.join(workspace, 'pyproject.toml'), manifest);
  const env = {
    ...process.env,
    UV_CACHE_DIR: path.join(directory, 'uv-cache'),
    UV_PYTHON: 'python3',
    UV_PYTHON_DOWNLOADS: 'never',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(directory, 'output'),
    'INPUT_MINIMUM-RELEASE-AGE': '3 days',
    LOCKFILE_REPORT_PATH: path.join(directory, 'report.md'),
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
  };
  const generated = await run('uv', ['lock'], { cwd: workspace, env });
  assert.equal(generated.code, 0, generated.stderr);
  initial = false;
  await trackFiles(workspace);
  const result = await run(process.execPath, [main], { cwd: workspace, env });
  assert.equal(result.code, 0, result.stderr);
  const report = await readFile(env.LOCKFILE_REPORT_PATH, 'utf8');
  assert.equal(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), report);
  assert.match(report, /<code>1\.0\.0<\/code> \| <code>1\.1\.0<\/code>/);
  const lockfile = await readFile(path.join(workspace, 'uv.lock'), 'utf8');
  assert.equal((lockfile.match(/version = "1.1.0"/g) ?? []).length, 2, lockfile);
  assert.doesNotMatch(lockfile, /1\.2\.0/);
  assert.equal(await readFile(path.join(workspace, 'pyproject.toml'), 'utf8'), manifest);
  await writeFile(
    path.join(workspace, 'pyproject.toml'),
    manifest.replace('maint-fixture>=1,<2', 'maint-fixture==1.2.0'),
  );
  const denied = await run(process.execPath, [main], { cwd: workspace, env });
  assert.equal(denied.code, 1, denied.stderr);
  assert.equal(await readFile(path.join(workspace, 'uv.lock'), 'utf8'), lockfile);
});
