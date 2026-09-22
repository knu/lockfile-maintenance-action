import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  AuthenticationError,
  authenticate,
  audience,
  brokerUrl,
  requestIdentity,
  revoke,
} from '../src/authentication.js';

test('identity requests set one audience and preserve existing URL parameters', async () => {
  for (const query of [
    '',
    '?api-version=2.0',
    '?audience=old&api-version=2.0&audience=duplicate',
  ]) {
    const value = await requestIdentity(
      audience,
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: `https://example.test/token${query}`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-credential',
      },
      async (url, init) => {
        assert.deepEqual(url.searchParams.getAll('audience'), [audience]);
        if (query) assert.equal(url.searchParams.get('api-version'), '2.0');
        assert.equal(init.headers.Authorization, 'Bearer test-credential');
        assert.equal(init.redirect, 'error');
        return Response.json({ value: 'identity' });
      },
    );
    assert.equal(value, 'identity');
  }
});

test('identity request rejection does not expose the provider response', async () => {
  await assert.rejects(
    requestIdentity(
      audience,
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-credential',
      },
      async () => new Response('sensitive response', { status: 400 }),
    ),
    {
      message: 'GitHub OIDC identity request failed (HTTP 400)',
    },
  );
});

test('the entrypoint explains missing runner OIDC environment without requesting credentials', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('../src/authenticate.js', import.meta.url).pathname],
    {
      env: { INPUT_AUTH: 'oidc' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /GitHub OIDC environment is unavailable; set id-token: write/);
});

test('authentication errors identify the failed stage without exposing provider details', async () => {
  const base = { mode: 'oidc', mask() {}, getIDToken: async () => 'identity' };
  await assert.rejects(
    authenticate({
      ...base,
      getIDToken: async () => {
        throw new Error('secret identity failure');
      },
    }),
    {
      constructor: AuthenticationError,
      message: 'GitHub OIDC identity request failed; check id-token: write',
    },
  );
  await assert.rejects(
    authenticate({
      ...base,
      request: async () => {
        throw new Error('secret transport failure');
      },
    }),
    { constructor: AuthenticationError, message: 'OIDC broker request failed' },
  );
});

test('token mode preserves explicit credentials without calling the broker', async () => {
  const masked = [];
  assert.equal(
    await authenticate({ mode: 'token', token: 'existing', mask: (t) => masked.push(t) }),
    'existing',
  );
  assert.deepEqual(masked, ['existing']);
  assert.equal(await authenticate({ mode: 'token', token: '', mask: () => assert.fail() }), '');
  await assert.rejects(authenticate({ mode: 'other' }), /auth must/);
});

test('OIDC uses the fixed audience and endpoint and masks both tokens', async () => {
  const masked = [];
  const result = await authenticate({
    mode: 'oidc',
    token: 'unused',
    mask: (t) => masked.push(t),
    getIDToken: async (aud) => {
      assert.equal(aud, audience);
      return 'identity';
    },
    request: async (url, init) => {
      assert.equal(url, brokerUrl);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer identity');
      return Response.json({
        token: 'installation',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });
    },
  });
  assert.equal(result, 'installation');
  assert.deepEqual(masked, ['identity', 'installation']);
});

test('OIDC rejection never falls back to the supplied token or exposes the response', async () => {
  await assert.rejects(
    authenticate({
      mode: 'oidc',
      token: 'fallback',
      mask() {},
      getIDToken: async () => 'identity',
      request: async () => new Response('sensitive response', { status: 403 }),
    }),
    { message: 'OIDC exchange failed (HTTP 403)' },
  );
});

test('revocation uses GitHub installation endpoint and accepts already expired tokens', async () => {
  for (const status of [204, 401, 500]) {
    const result = revoke('installation', async (url, init) => {
      assert.equal(url, 'https://api.github.com/installation/token');
      assert.equal(init.method, 'DELETE');
      assert.equal(init.headers.Authorization, 'Bearer installation');
      assert.equal(init.redirect, 'error');
      return new Response(null, { status });
    });
    if (status === 500) await assert.rejects(result, /revocation failed/);
    else await result;
  }
});
