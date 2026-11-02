import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { actionDependencies } from '../src/actions-lockfile.js';
import { packageVersions, versionChanges } from '../src/version-changes.js';

const dependency = (commit) => ({
  ref: 'v1',
  commit: `sha1-${commit.repeat(40)}`,
  owner_id: 1,
  repo_id: 2,
});

const lockfile = (dependencies) => stringify({ version: 'v0.0.3', workflows: {}, dependencies });

test('reports moved action commits and transitive additions without losing action subpaths', async () => {
  const before = await packageVersions(
    'github-actions',
    lockfile({ 'example/action/subpath@v1': dependency('a') }),
  );
  const after = await packageVersions(
    'github-actions',
    lockfile({
      'example/action/subpath@v1': dependency('b'),
      'example/other@v1': dependency('c'),
    }),
  );
  assert.deepEqual(versionChanges(before, after), [
    {
      name: 'example/action/subpath@v1',
      from: [`sha1-${'a'.repeat(40)}`],
      to: [`sha1-${'b'.repeat(40)}`],
    },
    { name: 'example/other@v1', from: [], to: [`sha1-${'c'.repeat(40)}`] },
  ]);
});

test('rejects unknown schemas, malformed YAML, and missing commit identities', () => {
  for (const contents of [
    'version: future\ndependencies: {}\n',
    'version: v0.0.3\ndependencies: [\n',
    'version: v0.0.3\n',
    lockfile({ 'example/action@v1': { ...dependency('a'), commit: 'v1' } }),
    lockfile({ 'example/action@v1': { ...dependency('a'), repo_id: null } }),
  ])
    assert.throws(() => actionDependencies(contents));
  assert.deepEqual(actionDependencies(lockfile({})), []);
});
