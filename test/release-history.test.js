import assert from 'node:assert/strict';
import test from 'node:test';
import { addReleaseHistory, githubRepository } from '../src/release-history.js';
import { changeReport } from '../src/version-changes.js';

function fixture({
  repository = { url: 'git+https://github.com/org/repo.git' },
  releases,
  tags,
  contents = [],
} = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    const data = pathname.includes('/releases')
      ? (releases ?? [])
      : pathname.includes('/tags')
        ? (tags ?? [])
        : pathname.includes('/contents')
          ? contents
          : { repository };
    return { ok: true, json: async () => data };
  };
  const files = [
    {
      file: 'package-lock.json',
      manager: 'npm',
      changes: [{ name: 'example', from: ['1.0.0'], to: ['1.2.0'] }],
    },
  ];
  return { calls, request, files };
}

test('normalizes GitHub repositories and rejects credential-bearing or unrelated hosts', () => {
  for (const value of [
    'git+https://github.com/org/repo.git',
    'git@github.com:org/repo.git',
    'https://github.com/org/repo/tree/main',
  ])
    assert.equal(githubRepository(value), 'org/repo');
  for (const value of [
    'https://github.com.evil.test/org/repo',
    'https://secret@github.com/org/repo',
    'invalid',
    undefined,
  ])
    assert.equal(githubRepository(value), undefined);
});

test('includes intermediate releases, excludes the old version and drafts, and links existing tags and changelog', async () => {
  const f = fixture({
    releases: [
      { tag_name: 'v1.0.0', body: 'old' },
      { tag_name: 'v1.1.0', body: 'intermediate' },
      { tag_name: 'v1.2.0', body: 'new' },
      { tag_name: 'v1.3.0', body: 'future' },
      { tag_name: 'v1.1.1', draft: true, body: 'draft' },
    ],
    contents: [{ name: 'CHANGELOG.md', path: 'CHANGELOG.md', type: 'file' }],
  });
  await addReleaseHistory(f.files, { request: f.request, token: 'test-token' });
  const history = f.files[0].changes[0].history;
  assert.deepEqual(
    history.releases.map((r) => r.tag),
    ['v1.2.0', 'v1.1.0'],
  );
  assert.equal(history.compareUrl, 'https://github.com/org/repo/compare/v1.0.0...v1.2.0');
  assert.equal(history.changelogUrl, 'https://github.com/org/repo/blob/HEAD/CHANGELOG.md');
  assert.deepEqual(history.versionUrls, {
    '1.0.0': 'https://github.com/org/repo/tree/v1.0.0',
    '1.2.0': 'https://github.com/org/repo/releases/tag/v1.2.0',
  });
  for (const { url, options } of f.calls)
    assert.equal(
      options.headers.Authorization,
      url.startsWith('https://api.github.com/') ? 'Bearer test-token' : undefined,
    );
  const report = changeReport(f.files, '3 days');
  assert.match(report, /intermediate/);
  assert.match(report, /\[CHANGELOG.md\]/);
});

test('matches package-prefixed monorepo tags without including sibling releases', async () => {
  const f = fixture({
    repository: { url: 'https://github.com/org/repo', directory: 'packages/example' },
    releases: [
      { tag_name: 'other@1.1.0', body: 'sibling' },
      { tag_name: 'example@1.2.0', body: 'own' },
      { tag_name: 'v1.1.0', body: 'root' },
    ],
    tags: [{ name: 'example@1.0.0' }, { name: 'example@1.2.0' }],
  });
  await addReleaseHistory(f.files, { request: f.request });
  const history = f.files[0].changes[0].history;
  assert.deepEqual(
    history.releases.map((r) => r.body),
    ['own'],
  );
  assert.match(history.compareUrl, /example%401.0.0\.\.\.example%401.2.0/);
  assert.ok(f.calls.some(({ url }) => url.endsWith('/contents/packages/example')));
});

test('paginates releases and caches shared upstream requests', async () => {
  const f = fixture();
  f.files[0].changes.push({ name: 'example', from: ['1.0.0'], to: ['1.2.0'] });
  const calls = [];
  const request = async (url, options) => {
    calls.push(url);
    if (url.includes('/releases?'))
      return {
        ok: true,
        json: async () =>
          url.endsWith('page=1')
            ? Array.from({ length: 100 }, () => ({ tag_name: 'v2.0.0' }))
            : [{ tag_name: 'v1.1.0', body: 'second page' }],
      };
    return f.request(url, options);
  };
  await addReleaseHistory(f.files, { request });
  assert.equal(calls.filter((url) => url.includes('/releases?')).length, 2);
  assert.equal(f.files[0].changes[0].history.releases[0].body, 'second page');
});

test('monorepo directories can use shared version tags', async () => {
  const f = fixture({
    repository: { url: 'https://github.com/org/repo', directory: 'packages/example' },
    releases: [
      { tag_name: 'v1.1.0', body: 'shared release' },
      { tag_name: 'v1.2.0', body: 'new' },
    ],
    tags: [{ name: 'v1.0.0' }],
  });
  await addReleaseHistory(f.files, { request: f.request });
  const history = f.files[0].changes[0].history;
  assert.deepEqual(
    history.releases.map((r) => r.tag),
    ['v1.2.0', 'v1.1.0'],
  );
  assert.match(history.compareUrl, /v1.0.0\.\.\.v1.2.0$/);
});

test('scoped package names match monorepo tags using the unscoped name', async () => {
  const f = fixture({
    repository: { url: 'https://github.com/org/repo', directory: 'packages/example' },
    releases: [
      { tag_name: 'example@1.2.0', body: 'own' },
      { tag_name: 'other@1.1.0', body: 'sibling' },
    ],
    tags: [{ name: 'example@1.0.0' }],
  });
  f.files[0].changes[0].name = '@scope/example';
  await addReleaseHistory(f.files, { request: f.request });
  assert.deepEqual(
    f.files[0].changes[0].history.releases.map((r) => r.body),
    ['own'],
  );
  assert.match(f.files[0].changes[0].history.compareUrl, /example%401.0.0\.\.\.example%401.2.0$/);
});

test('API errors and absent metadata are optional; ambiguous and non-SemVer changes are skipped', async () => {
  for (const request of [
    async () => {
      throw new Error('unavailable');
    },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => null }),
  ]) {
    const f = fixture();
    await addReleaseHistory(f.files, { request });
    assert.equal(f.files[0].changes[0].history, undefined);
  }
  const f = fixture();
  f.files[0].changes = [
    { name: 'example', from: [], to: ['1.2.0'] },
    { name: 'example', from: ['1.0.0', '2.0.0'], to: ['1.2.0', '2.2.0'] },
    { name: 'example', from: ['1.0rc1'], to: ['1.0'] },
  ];
  await addReleaseHistory(f.files, { request: f.request });
  assert.equal(f.calls.length, 0);
});

test('missing releases retain tag comparison; downgrades do not invent forward release notes', async () => {
  const f = fixture({ tags: [{ name: 'v1.0.0' }, { name: 'v1.2.0' }] });
  await addReleaseHistory(f.files, { request: f.request });
  assert.match(f.files[0].changes[0].history.compareUrl, /v1.0.0\.\.\.v1.2.0$/);
  f.files[0].changes[0].from = ['1.2.0'];
  f.files[0].changes[0].to = ['1.0.0'];
  await addReleaseHistory(f.files, { request: f.request });
  assert.deepEqual(f.files[0].changes[0].history.releases, []);
  assert.match(f.files[0].changes[0].history.compareUrl, /v1.2.0\.\.\.v1.0.0$/);
});

for (const [manager, metadata, host] of [
  ['cargo', { crate: { repository: 'https://github.com/org/repo' } }, 'crates.io'],
  ['bundler', { source_code_uri: 'https://github.com/org/repo' }, 'rubygems.org'],
  ['uv', { info: { project_urls: { Source: 'https://github.com/org/repo' } } }, 'pypi.org'],
]) {
  test(`${manager} discovers the source repository from registry metadata`, async () => {
    const f = fixture();
    f.files[0].manager = manager;
    const request = async (url, options) =>
      new URL(url).hostname === host
        ? { ok: true, json: async () => metadata }
        : f.request(url, options);
    await addReleaseHistory(f.files, { request });
    assert.equal(f.files[0].changes[0].history.releasesUrl, 'https://github.com/org/repo/releases');
  });
}

test('monorepos fall back to a root changelog and failed release lookups are marked incomplete', async () => {
  const f = fixture({
    repository: { url: 'https://github.com/org/repo', directory: 'packages/example' },
  });
  const request = async (url, options) => {
    if (url.includes('/releases?')) return { ok: false };
    if (url.endsWith('/contents'))
      return {
        ok: true,
        json: async () => [{ name: 'CHANGELOG.md', path: 'CHANGELOG.md', type: 'file' }],
      };
    return f.request(url, options);
  };
  await addReleaseHistory(f.files, { request });
  assert.equal(
    f.files[0].changes[0].history.changelogUrl,
    'https://github.com/org/repo/blob/HEAD/CHANGELOG.md',
  );
  assert.match(changeReport(f.files, '3 days'), /lookup was incomplete/);
});

test('release bodies cannot close HTML wrappers or mention users, and respect PR byte limits', async () => {
  const f = fixture({
    releases: [{ tag_name: 'v1.2.0', body: '</details> @everyone\n' + 'あ'.repeat(30000) }],
  });
  await addReleaseHistory(f.files, { request: f.request });
  const report = changeReport(f.files, '3 days');
  assert.ok(Buffer.byteLength(report) <= 60000);
  assert.match(report, /Report truncated/);
  f.files[0].changes[0].history.releases[0].body = '</details> @everyone';
  const small = changeReport(f.files, '3 days');
  assert.equal(small.match(/<\/details>/g)?.length, 1);
  assert.ok(!small.includes('@everyone'));
  assert.match(small, /@\u200beveryone/);
});
