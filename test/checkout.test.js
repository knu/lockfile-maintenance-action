import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run, temporaryDirectory } from './helpers.js';

const script = fileURLToPath(new URL('../scripts/checkout.js', import.meta.url));

for (const kind of ['absent', 'directory', 'worktree']) {
  test(`checkout detection with ${kind} Git metadata`, async (t) => {
    const directory = await temporaryDirectory(t);
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const metadata = path.join(workspace, '.git');
    if (kind === 'directory') await mkdir(metadata);
    if (kind === 'worktree')
      await writeFile(metadata, 'gitdir: /some/repository/worktrees/example\n');
    const output = path.join(directory, 'output');
    const result = await run(process.execPath, [script], {
      // The parent is inside this repository; only the workspace's own metadata counts.
      cwd: directory,
      env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), `required=${kind === 'absent'}\n`);
  });
}
