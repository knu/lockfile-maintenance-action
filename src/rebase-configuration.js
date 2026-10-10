import { parseDocument } from 'yaml';
import { workflowFile } from './rebase.js';

function yaml(contents, strict = false) {
  if (contents === undefined) return undefined;
  if (strict && Buffer.byteLength(contents) > 16384) throw new Error('App policy too large');
  const document = parseDocument(contents, { merge: false, resolveKnownTags: false });
  if (document.errors.length || document.warnings.length) throw new Error('invalid YAML');
  const value = document.toJS({ maxAliasCount: strict ? 0 : 100 });
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected a YAML mapping');
  return value;
}

function subscriptions(on) {
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [event, null]));
  return on ?? {};
}

function appTarget(auth, defaultBranch) {
  if (!auth) return undefined;
  const branchName = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !value.startsWith('refs/') &&
    !/[*?[\]\\]/.test(value);
  if (
    Object.keys(auth).some((key) => !['allowed_branches', 'rebase'].includes(key)) ||
    (auth.allowed_branches !== undefined &&
      (!Array.isArray(auth.allowed_branches) || !auth.allowed_branches.every(branchName)))
  )
    throw new Error('invalid App policy');
  const rebase = auth.rebase;
  if (rebase === undefined || rebase === false) return undefined;
  const target = rebase === true ? {} : rebase;
  if (
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    Object.entries(target).some(
      ([key, value]) => !['branch', 'base', 'ref'].includes(key) || !branchName(value),
    )
  )
    throw new Error('invalid App rebase policy');
  return {
    branch: target.branch ?? 'automation/lockfile-maintenance',
    base: target.base ?? defaultBranch,
    authorized: (auth.allowed_branches ?? [defaultBranch]).includes(target.ref ?? defaultBranch),
  };
}

export function configuredRebase(env, defaultBranch, authContents, workflowContents) {
  const target = appTarget(yaml(authContents, true), defaultBranch);
  const workflow = yaml(workflowContents);
  const on = subscriptions(workflow?.on);
  if (!Object.hasOwn(on, 'workflow_dispatch'))
    return { verified: true, checkbox: false, comment: false };
  const branch = env.INPUT_BRANCH || 'automation/lockfile-maintenance';
  const base = env.INPUT_BASE || defaultBranch;
  if (
    env.INPUT_AUTH === 'oidc' &&
    target &&
    workflowFile(env) === 'lockfile-maintenance.yml' &&
    target.branch === branch &&
    target.base === base &&
    target.authorized
  )
    return { verified: true, checkbox: true, comment: true };

  const input = (value, fallback) =>
    value === '${{ github.event.repository.default_branch }}' ? defaultBranch : value || fallback;
  const handler = Object.values(workflow?.jobs ?? {}).some(
    (job) =>
      job.if !== false &&
      job.steps?.some(
        (step) =>
          step.if !== false &&
          step.uses?.startsWith('knu/lockfile-maintenance-action/request-rebase@') &&
          (step.with?.workflow || workflowFile(env)) === workflowFile(env) &&
          (step.with?.branch || 'automation/lockfile-maintenance') === branch &&
          input(step.with?.base, defaultBranch) === base,
      ),
  );
  return {
    verified: true,
    checkbox: handler && on.pull_request_target?.types?.includes('edited') === true,
    comment:
      handler &&
      Object.hasOwn(on, 'issue_comment') &&
      (!on.issue_comment?.types || on.issue_comment.types.includes('created')),
  };
}

export async function rebaseConfiguration(env, request = fetch) {
  const unknown = { verified: false, checkbox: false, comment: false };
  if (!env.INPUT_TOKEN) return unknown;
  const root = new URL(
    `repos/${env.GITHUB_REPOSITORY}/`,
    `${env.GITHUB_API_URL ?? 'https://api.github.com'}/`,
  );
  const deadline = AbortSignal.timeout(15000);
  const json = async (route, optional = false) => {
    const response = await request(new URL(route, root), {
      headers: {
        Authorization: `Bearer ${env.INPUT_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      redirect: 'error',
      signal: deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (optional && response.status === 404) return undefined;
      throw new Error(`configuration lookup failed (HTTP ${response.status})`);
    }
    return response.json();
  };
  try {
    const repository = await json('');
    const ref = repository.default_branch;
    if (typeof ref !== 'string' || !ref) throw new Error('missing default branch');
    const contents = async (file) => {
      const route = `contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
      const value = await json(route, true);
      if (value === undefined) return undefined;
      if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string')
        throw new Error('invalid configuration contents');
      return Buffer.from(value.content, 'base64').toString('utf8');
    };
    const [auth, workflow] = await Promise.all([
      contents('.github/lockfile-maintenance-auth.yml'),
      contents(`.github/workflows/${workflowFile(env)}`),
    ]);
    return configuredRebase(env, ref, auth, workflow);
  } catch {
    console.warn('Could not verify rebase configuration; PR instructions will link to setup.');
    return unknown;
  }
}
