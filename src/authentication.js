export const brokerUrl = 'https://lockfile-maintenance-auth.idaemons.org/token';
export const audience = new URL(brokerUrl).origin;

export class AuthenticationError extends Error {}

export async function requestIdentity(audience, env, request = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new AuthenticationError('GitHub OIDC environment is unavailable; set id-token: write');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== 'https:') throw new AuthenticationError('invalid GitHub OIDC request URL');
  url.searchParams.set('audience', audience);
  const response = await request(url, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthenticationError(`GitHub OIDC identity request failed (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (typeof result.value !== 'string' || !result.value)
    throw new AuthenticationError('invalid GitHub OIDC identity response');
  return result.value;
}

export async function authenticate({ mode, token, getIDToken, mask, request = fetch }) {
  if (mode === 'token') {
    if (typeof token !== 'string' || /[\r\n]/.test(token))
      throw new AuthenticationError('invalid token');
    if (token) mask(token);
    return token;
  }
  if (mode !== 'oidc') throw new AuthenticationError('auth must be token or oidc');
  let identity;
  try {
    identity = await getIDToken(audience);
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError('GitHub OIDC identity request failed; check id-token: write');
  }
  mask(identity);
  let response;
  try {
    response = await request(brokerUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new AuthenticationError('OIDC broker request failed');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthenticationError(`OIDC exchange failed (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (
    typeof result.token !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(result.token) ||
    !Number.isFinite(Date.parse(result.expires_at)) ||
    Date.parse(result.expires_at) <= Date.now()
  )
    throw new AuthenticationError('invalid OIDC exchange response');
  mask(result.token);
  return result.token;
}

export async function revoke(token, request = fetch) {
  const response = await request('https://api.github.com/installation/token', {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (response.status !== 204 && response.status !== 401)
    throw new Error(`token revocation failed (HTTP ${response.status})`);
}
