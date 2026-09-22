import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const main = fileURLToPath(new URL('../src/main.js', import.meta.url));

export async function temporaryDirectory(t) {
  const root = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function project(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'Cargo.toml'), '[workspace]\nmembers = []\n');
  await writeFile(path.join(directory, 'Cargo.lock'), 'version = 4\n');
}

export async function trackFiles(directory) {
  for (const args of [
    ['init', '--quiet'],
    ['add', '--force', '--all', '--', '.'],
  ]) {
    const result = await run('git', args, { cwd: directory });
    assert.equal(result.code, 0, result.stderr);
  }
}

export async function run(command, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
