import { chmod, lstat, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { listFiles } from './files.js';

const protectedNames = new Set([
  'Cargo.lock',
  'Cargo.toml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.yarnrc.yml',
  'uv.lock',
  'pyproject.toml',
  'uv.toml',
  'poetry.lock',
  'Gemfile',
  'Gemfile.lock',
]);

async function protectedFiles(workspace) {
  return (await listFiles(workspace, process.env, true)).filter((file) =>
    protectedNames.has(path.basename(file)),
  );
}

export async function snapshot(workspace) {
  const originals = new Map();
  for (const file of await protectedFiles(workspace)) {
    const absolute = path.join(workspace, file);
    const stat = await lstat(absolute).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat) continue;
    if (stat.isFile()) originals.set(file, { contents: await readFile(absolute), mode: stat.mode });
    else if (stat.isSymbolicLink()) originals.set(file, { link: await readlink(absolute) });
  }
  return originals;
}

export async function changedFiles(workspace, originals, allowed) {
  const changed = [];
  const files = new Set([...originals.keys(), ...(await protectedFiles(workspace))]);
  for (const file of files) {
    const absolute = path.join(workspace, file);
    const original = originals.get(file);
    const stat = await lstat(absolute).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat && !original) continue;
    if (
      original?.link !== undefined &&
      stat?.isSymbolicLink() &&
      original.link === (await readlink(absolute))
    )
      continue;
    if (!stat?.isFile()) throw new Error(`updated file must be a regular file: ${file}`);
    const contents = await readFile(absolute);
    if (original?.contents?.equals(contents)) continue;
    // Yarn persists package.json even during a recursive lockfile-only update.
    if (
      path.basename(file) === 'package.json' &&
      original?.contents &&
      isDeepStrictEqual(JSON.parse(original.contents.toString()), JSON.parse(contents.toString()))
    ) {
      await writeFile(absolute, original.contents);
      continue;
    }
    if (!allowed.has(file))
      throw new Error(`tool modified a manifest, configuration, or unselected lockfile: ${file}`);
    changed.push(file);
  }
  return changed.sort();
}

export async function restore(workspace, originals) {
  const files = new Set([...originals.keys(), ...(await protectedFiles(workspace))]);
  for (const file of files) {
    const absolute = path.join(workspace, file);
    const original = originals.get(file);
    if (!original) {
      await rm(absolute, { force: true, recursive: true });
      continue;
    }
    const stat = await lstat(absolute).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (original.link !== undefined) {
      if (stat?.isSymbolicLink() && original.link === (await readlink(absolute))) continue;
      await rm(absolute, { force: true, recursive: true });
      await symlink(original.link, absolute);
      continue;
    }
    if (stat && !stat.isFile()) await rm(absolute, { recursive: true });
    if (!stat?.isFile() || !original.contents.equals(await readFile(absolute))) {
      await writeFile(absolute, original.contents);
      await chmod(absolute, original.mode);
    }
  }
}
