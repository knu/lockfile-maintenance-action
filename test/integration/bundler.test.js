import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main, run, temporaryDirectory, trackFiles } from '../helpers.js';

test('real Bundler excludes young direct and transitive gems', async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, 'checkout');
  await mkdir(workspace);
  let initial = true;
  const now = Date.now();
  const info = (name) => {
    const dependencies = name === 'maint_fixture' ? 'maint_child:>= 1.0' : '';
    return (
      '---\n' +
      [
        ['1.0.0', 30],
        ['1.1.0', 10],
        ['1.2.0', 0],
      ]
        .filter(([version]) => !initial || version === '1.0.0')
        .map(
          ([version, days]) =>
            `${version} ${dependencies}|created_at:${new Date(now - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`,
        )
        .join('')
    );
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    let contents;
    if (pathname === '/versions') {
      contents =
        '---\n' +
        ['maint_fixture', 'maint_child']
          .map(
            (name) =>
              `${name} ${initial ? '1.0.0' : '1.0.0,1.1.0,1.2.0'} ${createHash('md5').update(info(name)).digest('hex')}\n`,
          )
          .join('');
    } else if (
      pathname.startsWith('/info/') &&
      ['maint_fixture', 'maint_child'].includes(pathname.slice(6))
    ) {
      contents = info(pathname.slice(6));
    } else {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'text/plain');
    response.setHeader('ETag', `"${createHash('md5').update(contents).digest('hex')}"`);
    response.end(contents);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const manifest = `source "http://127.0.0.1:${server.address().port}"\ngem "maint_fixture", "~> 1.0"\n`;
  await writeFile(path.join(workspace, 'Gemfile'), manifest);
  const env = {
    ...process.env,
    BUNDLE_USER_HOME: path.join(directory, 'bundle-home'),
    BUNDLE_USER_CACHE: path.join(directory, 'bundle-cache'),
    BUNDLE_GEMFILE: path.join(workspace, 'Gemfile'),
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(directory, 'output'),
    'INPUT_MINIMUM-RELEASE-AGE': '3 days',
    LOCKFILE_REPORT_PATH: path.join(directory, 'report.md'),
  };
  const generated = await run('bundle', ['lock'], { cwd: workspace, env });
  assert.equal(generated.code, 0, generated.stderr + generated.stdout);
  initial = false;
  await trackFiles(workspace);
  const result = await run(process.execPath, [main], { cwd: workspace, env });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = await readFile(env.LOCKFILE_REPORT_PATH, 'utf8');
  assert.match(report, /<code>1\.0\.0<\/code> \| <code>1\.1\.0<\/code>/);
  const lockfile = await readFile(path.join(workspace, 'Gemfile.lock'), 'utf8');
  assert.match(lockfile, /maint_fixture \(1\.1\.0\)/);
  assert.match(lockfile, /maint_child \(1\.1\.0\)/);
  assert.doesNotMatch(lockfile, /1\.2\.0/);
  assert.equal(await readFile(path.join(workspace, 'Gemfile'), 'utf8'), manifest);
  await writeFile(path.join(workspace, 'Gemfile'), manifest.replace('~> 1.0', '= 1.2.0'));
  const denied = await run(process.execPath, [main], { cwd: workspace, env });
  assert.equal(denied.code, 1, denied.stderr);
  assert.equal(await readFile(path.join(workspace, 'Gemfile.lock'), 'utf8'), lockfile);
});
