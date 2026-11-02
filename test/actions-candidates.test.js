import assert from 'node:assert/strict';
import test from 'node:test';
import { agedActionPins, githubActionsAPI } from '../src/managers/actions-candidates.js';

const sha = (n) => n.toString(16).padStart(40, '0');
const pin = (n, uses = []) => ({
  ref: 'v1',
  commit: `sha1-${sha(n)}`,
  owner_id: 1,
  repo_id: 2,
  ...(uses.length ? { uses } : {}),
});
const release = (tag, date = '2026-01-01T00:00:00Z') => ({ tag_name: tag, published_at: date });
const cutoff = Date.parse('2026-01-15T00:00:00Z');
const lock = (dependencies, roots = Object.keys(dependencies)) => ({
  version: 'v0.0.3',
  workflows: { '.github/workflows/ci.yml': roots },
  dependencies,
});

function registry(repos) {
  return async (endpoint) => {
    const [owner, name, ...segments] = endpoint.split('/');
    const repo = repos[`${owner}/${name}`];
    assert.ok(repo, endpoint);
    const route = segments.join('/');
    if (!route) return { id: repo.id ?? 2, owner: { id: 1 } };
    if (route === 'releases?per_page=100&page=1') return repo.releases;
    if (route.startsWith('commits/')) {
      const ref = decodeURIComponent(route.slice(8));
      const value =
        repo.refs[ref] ?? (/^[0-9a-f]{40}$/.test(ref) ? Number.parseInt(ref, 16) : undefined);
      return value === undefined ? undefined : { sha: sha(value) };
    }
    if (route.startsWith('compare/')) {
      const [base, head] = route
        .slice(8)
        .split('...')
        .map((v) => Number.parseInt(v, 16));
      return { status: base < head ? 'ahead' : 'behind' };
    }
    if (route.startsWith('contents/')) {
      const ref = Number.parseInt(
        new URL(`https://example.com/${route}`).searchParams.get('ref'),
        16,
      );
      const manifest = repo.manifests?.[ref] ?? 'runs:\n  using: node24\n  main: index.js\n';
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(manifest).toString('base64'),
      };
    }
    assert.fail(endpoint);
  };
}

const update = (before, repos) =>
  agedActionPins(before, { api: registry(repos), cutoff, report() {} });

test('weekly releases select the newest aged candidate and stay idempotent without downgrades', async () => {
  const repos = {
    'example/action': {
      refs: { v1: 4, 'v1.1.0': 1, 'v1.2.0': 2, 'v1.3.0': 3, 'v1.4.0': 4, 'v2.0.0': 5 },
      releases: [
        release('v1.4.0', '2026-01-21T00:00:00Z'),
        release('v2.0.0'),
        release('v1.3.0', '2026-01-14T00:00:00Z'),
        release('v1.2.0'),
        release('v1.1.0'),
      ],
    },
  };
  const after = await update(lock({ 'example/action@v1': pin(1) }), repos);
  assert.equal(after.dependencies['example/action@v1'].commit, `sha1-${sha(3)}`);
  assert.deepEqual(await update(after, repos), after);
  const newer = lock({ 'example/action@v1': pin(4) });
  assert.deepEqual(await update(newer, repos), newer);
});

test('a blocked dependency does not hold back independent updates', async () => {
  const before = lock({
    'example/action@v1': pin(1),
    'example/other@v1.2': { ...pin(1), ref: 'v1.2' },
  });
  const after = await update(before, {
    'example/action': { refs: { v1: 2, 'v1.2.0': 2 }, releases: [release('v1.2.0', null)] },
    'example/other': {
      refs: { 'v1.2': 3, 'v1.2.1': 2, 'v1.3.0': 3 },
      releases: [release('v1.3.0'), release('v1.2.1')],
    },
  });
  assert.deepEqual(
    after.dependencies['example/action@v1'],
    before.dependencies['example/action@v1'],
  );
  assert.equal(after.dependencies['example/other@v1.2'].commit, `sha1-${sha(2)}`);
});

test('falls back to an older parent when its new transitive dependency cannot meet cooldown', async () => {
  const after = await update(lock({ 'example/action@v1': pin(1) }), {
    'example/action': {
      refs: { v1: 3, 'v1.2.0': 2, 'v1.3.0': 3 },
      releases: [release('v1.3.0'), release('v1.2.0')],
      manifests: { 3: 'runs:\n  using: composite\n  steps:\n    - uses: example/child@v1\n' },
    },
    'example/child': { refs: { v1: 1 }, releases: [release('v1.0.0', '2026-01-20T00:00:00Z')] },
  });
  assert.deepEqual(Object.keys(after.dependencies), ['example/action@v1']);
  assert.equal(after.dependencies['example/action@v1'].commit, `sha1-${sha(2)}`);
});

test('ages new transitive dependencies and refreshes shared dependencies under fixed parents', async () => {
  const parent = { ...pin(1, ['example/child@v1']), ref: 'v1.0.0' };
  const before = lock({ 'example/action@v1.0.0': parent, 'example/child@v1': pin(1) }, [
    'example/action@v1.0.0',
  ]);
  const after = await update(before, {
    'example/child': {
      refs: { v1: 3, 'v1.1.0': 2, 'v1.2.0': 3 },
      releases: [release('v1.2.0', null), release('v1.1.0')],
    },
  });
  assert.deepEqual(after.dependencies['example/action@v1.0.0'], parent);
  assert.equal(after.dependencies['example/child@v1'].commit, `sha1-${sha(2)}`);
  const newGraph = await update(lock({ 'example/action@v1': pin(1) }), {
    'example/action': {
      refs: { v1: 2, 'v1.1.0': 2 },
      releases: [release('v1.1.0')],
      manifests: {
        2: 'runs:\n  using: composite\n  steps:\n    - uses: example/child/sub@v1.0.0\n',
      },
    },
    'example/child': { refs: { 'v1.0.0': 1 }, releases: [release('v1.0.0')] },
  });
  assert.deepEqual(newGraph.dependencies['example/action@v1'].uses, ['example/child/sub@v1.0.0']);
  assert.equal(newGraph.dependencies['example/child/sub@v1.0.0'].commit, `sha1-${sha(1)}`);
});

test('retains branches and excludes drafts, prereleases, unknown dates, and unsafe graph changes', async () => {
  const before = lock({
    'example/action@v1': pin(1),
    'example/branch@main': { ...pin(1), ref: 'main' },
  });
  const after = await update(before, {
    'example/action': {
      refs: { v1: 7, 'v1.1.0': 2, 'v1.2.0': 3, 'v1.3.0': 4, 'v1.4.0': 5, 'v1.5.0': 6 },
      releases: [
        { ...release('v1.5.0'), draft: true },
        { ...release('v1.4.0'), prerelease: true },
        release('v1.3.0', 'bad'),
        release('v1.2.0'),
        release('v1.1.0'),
      ],
      manifests: {
        3: 'runs:\n  using: composite\n  steps:\n    - uses: ./local\n',
        2: 'runs:\n  using: composite\n  steps:\n    - uses: example/action@v1\n',
      },
    },
  });
  assert.deepEqual(after, before);
});

test('repository identity changes and API failures fail rather than silently skipping', async () => {
  await assert.rejects(
    update(lock({ 'example/action@v1': pin(1) }), {
      'example/action': { id: 9, releases: [], refs: {} },
    }),
    /identity changed/,
  );
  const api = githubActionsAPI('test-token', async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return new Response('', { status: 403 });
  });
  await assert.rejects(api('example/action'), /HTTP 403/);
});
