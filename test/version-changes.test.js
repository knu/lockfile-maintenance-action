import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  changeReport,
  changeType,
  packageVersions,
  versionChanges,
} from '../src/version-changes.js';
import { temporaryDirectory } from './helpers.js';

for (const manager of ['cargo', 'uv']) {
  test(`${manager} parses TOML and compares all locked versions without inventing pairs`, async () => {
    const before = await packageVersions(
      manager,
      `version = 1
[[package]]
name = "example"
version = "1.0.0"
[[package]]
name = "example"
version = "2.0.0"
[[package]]
name = "removed"
version = "1.0.0"
`,
    );
    const after = await packageVersions(
      manager,
      `version = 1
package = [
  {name = "example", version = "2.0.0"},
  {name = "example", version = "2.1.0"},
  {name = "added", version = "1.0.0"},
  {name = "virtual"},
]
`,
    );
    assert.deepEqual(versionChanges(before, after), [
      { name: 'added', from: [], to: ['1.0.0'] },
      { name: 'example', from: ['1.0.0', '2.0.0'], to: ['2.0.0', '2.1.0'] },
      { name: 'removed', from: ['1.0.0'], to: [] },
    ]);
  });
}

test('pnpm handles scoped names, peer contexts, and package metadata for non-registry sources', async () => {
  const versions = await packageVersions(
    'pnpm',
    `lockfileVersion: '9.0'
packages:
  '@scope/example@1.2.0(peer@2.0.0)': {}
  '@scope/example@1.2.0(peer@3.0.0)': {}
  'https://example.com/archive.tgz':
    name: archive
    version: 3.0.0
snapshots:
  '@scope/example@1.2.0(peer@2.0.0)': {}
`,
  );
  assert.deepEqual([...versions.get('@scope/example')], ['1.2.0']);
  assert.deepEqual([...versions.get('archive')], ['3.0.0']);
});

test('Yarn groups descriptors and uses resolved names for aliases and patched packages', async () => {
  const versions = await packageVersions(
    'yarn',
    `__metadata:
  version: 8
"alias@npm:@scope/example@^1, @scope/example@npm:^1":
  version: 1.2.0
  resolution: "@scope/example@npm:1.2.0"
"pkg@patch:pkg@npm%3A2.0.0#./fix.patch":
  version: 2.0.0
  resolution: "pkg@patch:pkg@npm%3A2.0.0#./fix.patch::version=2.0.0&hash=abc"
`,
  );
  assert.deepEqual([...versions.get('@scope/example')], ['1.2.0']);
  assert.deepEqual([...versions.get('pkg')], ['2.0.0']);
});

test('Bundler uses its native parser and combines platforms without dependency requirement noise', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'Gemfile'), 'source "https://rubygems.org"\n');
  const versions = await packageVersions(
    'bundler',
    `GEM
  remote: https://rubygems.org/
  specs:
    example (1.2.0)
      child (~> 2.0)
    example (1.2.0-arm64-darwin)
    child (2.0.1)

PLATFORMS
  ruby
  arm64-darwin

DEPENDENCIES
  example

BUNDLED WITH
   4.0.21
`,
    { directory, env: process.env },
  );
  assert.deepEqual([...versions.get('example')], ['1.2.0']);
  assert.deepEqual([...versions.get('child')], ['2.0.1']);
  assert.equal(versions.size, 2);
});

test('renders changes per file, additions, removals, downgrades, and metadata-only changes', () => {
  const report = changeReport(
    [
      {
        file: 'rust/Cargo.lock',
        changes: [
          { name: 'added', from: [], to: ['1.0.0'] },
          { name: 'removed', from: ['1.0.0'], to: [] },
          { name: 'downgraded', from: ['2.0.0'], to: ['1.0.0'] },
        ],
      },
      { file: 'js/yarn.lock', changes: [] },
    ],
    '3 days',
  );
  assert.match(report, /### <code>rust\/Cargo.lock<\/code>/);
  assert.match(report, /\| Package \| Before \| After \| Change \|/);
  assert.match(report, /\| major downgrade \|/);
  assert.match(report, /<code>added<\/code> \| — \| <code>1.0.0<\/code>/);
  assert.match(report, /<code>removed<\/code> \| <code>1.0.0<\/code> \| —/);
  assert.match(report, /<code>downgraded<\/code> \| <code>2.0.0<\/code> \| <code>1.0.0<\/code>/);
  assert.match(report, /### <code>js\/yarn.lock<\/code>[\s\S]*No package version changes/);
});

test('escapes Markdown and HTML in file/package text and bounds large PR bodies', () => {
  const report = changeReport(
    [
      {
        file: '<script>|\n`*/Cargo.lock',
        changes: [{ name: '[evil](@everyone)', from: ['1|2'], to: ['<3>'] }],
      },
    ],
    '3 days',
  );
  assert.ok(!report.includes('<script>'));
  assert.ok(!report.includes('@everyone'));
  assert.ok(!report.includes('[evil]'));
  assert.ok(report.includes('&#124;'));
  const huge = changeReport(
    [
      {
        file: 'Cargo.lock',
        changes: Array.from({ length: 2000 }, (_, i) => ({
          name: `package-${i}`,
          from: ['1.0.0'],
          to: ['2.0.0'],
        })),
      },
    ],
    '3 days',
  );
  assert.ok(Buffer.byteLength(huge) <= 60000);
  assert.match(huge, /Report truncated/);
  assert.match(changeReport([], '3 days'), /No lockfile changes/);
});

test('invalid structured lockfiles fail instead of claiming no changes', async () => {
  for (const manager of ['cargo', 'uv', 'pnpm', 'yarn'])
    await assert.rejects(packageVersions(manager, 'not a lockfile'));
});

test('classifies release components, downgrades, and non-SemVer or ambiguous changes', () => {
  for (const [from, to, expected] of [
    [['1.2.3'], ['2.0.0'], 'major'],
    [['1.2.3'], ['1.3.0'], 'minor'],
    [['1.2.3'], ['1.2.4'], 'patch'],
    [['2.0.0'], ['1.9.9'], 'major downgrade'],
    [['1.3.0'], ['1.2.9'], 'minor downgrade'],
    [['1.2.4'], ['1.2.3'], 'patch downgrade'],
    [['1.0.0-beta.1'], ['1.0.0'], 'prerelease'],
    [['1.0.0'], ['1.0.0-rc.1'], 'prerelease downgrade'],
    [['1.0.0+first'], ['1.0.0+second'], 'build'],
    [['1.2'], ['1.3'], 'minor'],
    [['1!1.2.0'], ['2!1.2.0'], 'other'],
    [['1.2rc1'], ['1.2rc2'], 'other'],
    [['1.0.0', '2.0.0'], ['1.0.0', '3.0.0'], 'major'],
    [['1.0.0', '2.0.0'], ['1.1.0', '2.1.0'], 'multiple'],
    [['1.0.0'], ['1.0.0', '2.0.0'], 'added version'],
    [['1.0.0', '2.0.0'], ['2.0.0'], 'removed version'],
    [[], ['1.0.0'], 'added'],
    [['1.0.0'], [], 'removed'],
  ])
    assert.equal(changeType(from, to), expected, `${from} -> ${to}`);
});

for (const lockfileVersion of [2, 3]) {
  test(`npm v${lockfileVersion} handles aliases, nested versions and workspace links`, async () => {
    const versions = await packageVersions(
      'npm',
      JSON.stringify({
        lockfileVersion,
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'node_modules/example': { version: '1.2.0' },
          'node_modules/parent/node_modules/example': { version: '1.1.0' },
          'node_modules/@scope/example': { version: '2.0.0' },
          'node_modules/alias': { name: '@scope/original', version: '3.0.0' },
          'node_modules/local': { resolved: 'packages/local', link: true },
          'packages/local': { name: 'local', version: '1.0.0' },
          'packages/local/node_modules/example': { version: '1.2.0' },
        },
      }),
    );
    assert.deepEqual(
      [...versions],
      [
        ['example', new Set(['1.2.0', '1.1.0'])],
        ['@scope/example', new Set(['2.0.0'])],
        ['@scope/original', new Set(['3.0.0'])],
      ],
    );
  });
}

test('npm v1 handles nested dependencies and aliases', async () => {
  const versions = await packageVersions(
    'npm',
    JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        example: { version: '1.2.0', dependencies: { example: { version: '1.1.0' } } },
        alias: { version: 'npm:@scope/original@3.0.0' },
      },
    }),
  );
  assert.deepEqual(
    [...versions],
    [
      ['example', new Set(['1.2.0', '1.1.0'])],
      ['@scope/original', new Set(['3.0.0'])],
    ],
  );
  await assert.rejects(packageVersions('npm', '{}'), /lockfileVersion/);
});
