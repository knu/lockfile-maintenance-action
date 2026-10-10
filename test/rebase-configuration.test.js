import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { configuredRebase, rebaseConfiguration } from '../src/rebase-configuration.js';

const env = {
  INPUT_AUTH: 'oidc',
  INPUT_TOKEN: 'test-token',
  GITHUB_REPOSITORY: 'owner/project',
  GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/lockfile-maintenance.yml@refs/heads/main',
};
const disabled = { verified: true, checkbox: false, comment: false };
const enabled = { verified: true, checkbox: true, comment: true };
const dispatch = 'on: [schedule, workflow_dispatch]\njobs: {}\n';

test('App requests require matching authentication, workflow, branches and dispatch subscription', () => {
  assert.deepEqual(configuredRebase(env, 'main', 'rebase: true', dispatch), enabled);
  for (const auth of [undefined, '', 'rebase: false', 'allowed_branches: [release]\nrebase: true'])
    assert.deepEqual(configuredRebase(env, 'main', auth, dispatch), disabled);
  for (const overrides of [
    { INPUT_AUTH: 'token' },
    { INPUT_BRANCH: 'other' },
    { INPUT_BASE: 'release' },
    {
      GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('lockfile-maintenance.yml', 'other.yml'),
    },
  ])
    assert.deepEqual(
      configuredRebase({ ...env, ...overrides }, 'main', 'rebase: true', dispatch),
      disabled,
    );
  assert.deepEqual(configuredRebase(env, 'main', 'rebase: true', 'on: schedule'), disabled);
  assert.deepEqual(configuredRebase(env, 'main', 'rebase: true', undefined), disabled);
  const auth =
    'allowed_branches: [release]\nrebase:\n  branch: updates\n  base: release\n  ref: release\n';
  assert.deepEqual(
    configuredRebase(
      { ...env, INPUT_BRANCH: 'updates', INPUT_BASE: 'release' },
      'main',
      auth,
      dispatch,
    ),
    enabled,
  );
});

test('invalid App policies cannot be mistaken for enabled requests', () => {
  for (const auth of [
    'rebase: yes',
    'rebase: true\nrebase: false',
    'allowed_branches: main\nrebase: true',
    'rebase: { workflow: lockfile-maintenance.yml }',
    'rebase: { branch: "*" }',
    'rebase: { ref: refs/heads/main }',
    'rebase: &target {}\nallowed_branches: [*target]',
    '#'.repeat(16385),
  ])
    assert.throws(() => configuredRebase(env, 'main', auth, dispatch));
});

test('Actions requests require the handler as well as the relevant event subscriptions', async () => {
  const workflow = await readFile('examples/multi-tool-maintenance.yml', 'utf8');
  const configured = (contents, overrides = {}) =>
    configuredRebase({ ...env, ...overrides }, 'main', undefined, contents);
  assert.deepEqual(configured(workflow), enabled);
  assert.deepEqual(configured(workflow.replace('types: [edited]', 'types: [opened]')), {
    ...enabled,
    checkbox: false,
  });
  assert.deepEqual(configured(workflow.replace('types: [created]', 'types: [edited]')), {
    ...enabled,
    comment: false,
  });
  assert.deepEqual(configured(workflow.replace('types: [created]', '')), enabled);
  assert.deepEqual(
    configured(
      workflow.replace('knu/lockfile-maintenance-action/request-rebase@', 'other/action@'),
    ),
    disabled,
  );
  assert.deepEqual(
    configured(
      workflow.replace(
        'request-rebase:\n    if: >-',
        'request-rebase:\n    if: false\n    name: >-',
      ),
    ),
    disabled,
  );
  assert.deepEqual(configured(workflow, { INPUT_BRANCH: 'other' }), disabled);
  const explicitBase = workflow.replace(
    'knu/lockfile-maintenance-action/request-rebase@v2',
    "knu/lockfile-maintenance-action/request-rebase@v2\n        with:\n          base: '${{ github.event.repository.default_branch }}'\n          branch: custom",
  );
  assert.deepEqual(configured(explicitBase, { INPUT_BRANCH: 'custom' }), enabled);
});

function api(auth, workflow, failure = 0) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push(new URL(url));
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.redirect, 'error');
      if (calls.length === failure) return new Response(null, { status: 403 });
      if (calls.length === 1)
        return url.pathname.endsWith('/')
          ? new Response(null, { status: 404 })
          : Response.json({ default_branch: 'release/next' });
      const contents = url.pathname.endsWith('lockfile-maintenance-auth.yml') ? auth : workflow;
      return contents === undefined
        ? new Response(null, { status: 404 })
        : Response.json({
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(contents).toString('base64'),
          });
    },
  };
}

test('lookup reads remote default branch configuration rather than checkout or PR branch', async () => {
  const mock = api('rebase: true', dispatch);
  assert.deepEqual(await rebaseConfiguration(env, mock.request), enabled);
  assert.equal(mock.calls.length, 3);
  for (const url of mock.calls.slice(1)) assert.equal(url.searchParams.get('ref'), 'release/next');
  assert.ok(
    mock.calls.some((url) => url.pathname.endsWith('/.github/workflows/lockfile-maintenance.yml')),
  );
  const missing = api(undefined, dispatch);
  assert.deepEqual(await rebaseConfiguration(env, missing.request), disabled);
});

test('lookup failures and missing tokens suppress controls without failing maintenance', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const unknown = { verified: false, checkbox: false, comment: false };
  assert.deepEqual(
    await rebaseConfiguration({ ...env, INPUT_TOKEN: '' }, () => assert.fail('unexpected request')),
    unknown,
  );
  for (const failure of [1, 2, 3]) {
    const mock = api('rebase: true', dispatch, failure);
    assert.deepEqual(await rebaseConfiguration(env, mock.request), unknown);
  }
  const invalid = api('rebase: yes', dispatch);
  assert.deepEqual(await rebaseConfiguration(env, invalid.request), unknown);
  assert.deepEqual(
    await rebaseConfiguration(env, () => {
      throw new Error('network unavailable');
    }),
    unknown,
  );
});
