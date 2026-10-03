export const rebaseCommand = '/lockfile rebase';
const checkboxLabel = 'Rebase this PR by regenerating lockfiles from the latest base branch.';
const marker = '<!-- lockfile-maintenance:rebase -->';
export const rebaseCheckbox = `- [ ] ${checkboxLabel} ${marker}`;

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
}

export function workflowFile(env) {
  const prefix = `${env.GITHUB_REPOSITORY}/.github/workflows/`;
  const ref = env.GITHUB_WORKFLOW_REF ?? '';
  if (!ref.startsWith(prefix)) throw new Error('cannot determine the maintenance workflow');
  const separator = ref.indexOf('@refs/', prefix.length);
  if (separator < 0) throw new Error('invalid workflow ref');
  const file = ref.slice(prefix.length, separator);
  if (!/^[^/\r\n]+\.ya?ml$/.test(file)) throw new Error('invalid workflow file');
  return file;
}

export function workflowUrl(env, file = workflowFile(env)) {
  const repository = env.GITHUB_REPOSITORY.split('/').map(encode).join('/');
  return new URL(
    `${repository}/actions/workflows/${encode(file)}`,
    `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/`,
  ).href;
}

export function rebaseInstructions(env) {
  return [
    '## Rebase',
    '',
    rebaseCheckbox,
    '',
    `Check the box above or post a new PR comment with \`${rebaseCommand}\` on its own line.  Requires repository write access.`,
    '',
    '<details>',
    '<summary>Workflow requirements and manual fallback</summary>',
    '',
    'Enable App-based rebase handling with `rebase: true` in `.github/lockfile-maintenance-auth.yml`, or configure an Actions request handler as described below.',
    '',
    'For Actions-based handling, the workflow must subscribe to `pull_request_target: types: [edited]` for the checkbox and `issue_comment: types: [created]` for comments, and configure the request-rebase job.',
    `If these handlers are not configured, [open the maintenance workflow](<${workflowUrl(env)}>) and select **Run workflow** on the branch used for maintenance.  This requires \`workflow_dispatch\`.`,
    '',
    '</details>',
    '',
  ].join('\n');
}

function checkboxState(body) {
  // This is the Action's exact generated control, not arbitrary Markdown task lists.
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n');
  const controls = lines.filter((line) => line.includes(marker));
  if (controls.length !== 1) return undefined;
  if (controls[0] === rebaseCheckbox) return false;
  if (['x', 'X'].some((check) => controls[0] === rebaseCheckbox.replace('[ ]', `[${check}]`)))
    return true;
  return undefined;
}

function hasRebaseCommand(body) {
  return (body ?? '').split(/\r?\n/).some((line) => line.trim() === rebaseCommand);
}

export function rebaseRequest(eventName, event) {
  if (event.sender?.type !== 'User') return undefined;
  if (
    eventName === 'issue_comment' &&
    event.action === 'created' &&
    event.issue?.pull_request &&
    hasRebaseCommand(event.comment?.body)
  )
    return event.issue.number;
  if (
    eventName === 'pull_request_target' &&
    event.action === 'edited' &&
    checkboxState(event.changes?.body?.from) === false &&
    checkboxState(event.pull_request?.body) === true
  )
    return event.pull_request.number;
  return undefined;
}

function githubApi(env, request) {
  return async (route, body, method) => {
    const response = await request(
      `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${route}`,
      {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${env.INPUT_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (method === 'DELETE' && response.status === 404) return;
      throw new Error(`rebase request failed (HTTP ${response.status})`);
    }
    return response.status === 204 ? undefined : response.json();
  };
}

async function finishReaction(api, comment, content) {
  const route = `issues/comments/${comment}/reactions`;
  const result = await api(route, { content });
  if (!Number.isSafeInteger(result?.user?.id) || result.user.id < 1)
    throw new Error('invalid reaction author');
  for (let page = 1; ; page++) {
    const items = await api(`${route}?content=%2B1&per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error('invalid reactions response');
    const ack = items.find((item) => item.content === '+1' && item.user?.id === result.user.id);
    if (ack) {
      if (!Number.isSafeInteger(ack.id) || ack.id < 1) throw new Error('invalid reaction ID');
      await api(`${route}/${ack.id}`, undefined, 'DELETE');
      return;
    }
    if (items.length < 100) return;
  }
}

export async function dispatchRebase(
  env,
  event,
  request = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const number = rebaseRequest(env.GITHUB_EVENT_NAME, event);
  if (!Number.isSafeInteger(number) || number < 1) return false;
  const repository = env.GITHUB_REPOSITORY;
  if (event.repository?.full_name !== repository) throw new Error('repository mismatch');
  const api = githubApi(env, request);
  const permission = await api(`collaborators/${encode(event.sender.login)}/permission`);
  if (!['admin', 'maintain', 'write'].includes(permission.permission))
    throw new Error('rebase requires repository write access');
  const pr = await api(`pulls/${number}`);
  const base = env.INPUT_BASE || event.repository.default_branch;
  const branch = env.INPUT_BRANCH || 'automation/lockfile-maintenance';
  if (
    pr.state !== 'open' ||
    pr.head?.repo?.full_name !== repository ||
    pr.base?.repo?.full_name !== repository ||
    pr.head.ref !== branch ||
    pr.base.ref !== base
  )
    return false;
  const workflow = env.INPUT_WORKFLOW || workflowFile(env);
  const comment = env.GITHUB_EVENT_NAME === 'issue_comment' ? event.comment.id : undefined;
  if (env.GITHUB_EVENT_NAME === 'issue_comment' && (!Number.isSafeInteger(comment) || comment < 1))
    throw new Error('invalid request comment');
  const reaction = (content) => api(`issues/comments/${comment}/reactions`, { content });
  if (comment) await reaction('+1');
  let completed = false;
  try {
    const track = comment && env.INPUT_WAIT_FOR_COMPLETION === 'true';
    const run = await api(`actions/workflows/${encode(workflow)}/dispatches`, {
      ref: env.INPUT_REF || event.repository.default_branch,
      ...(comment && !track
        ? { inputs: { 'request-comment': String(comment), 'request-pull-request': String(number) } }
        : {}),
    });
    if (track) {
      if (!Number.isSafeInteger(run?.workflow_run_id) || run.workflow_run_id < 1)
        throw new Error('dispatch did not return a workflow run ID');
      for (let attempt = 0; ; attempt++) {
        const result = await api(`actions/runs/${run.workflow_run_id}`);
        if (result.status === 'completed') {
          completed = true;
          await finishReaction(
            api,
            comment,
            result.conclusion === 'success' ? 'hooray' : 'confused',
          );
          break;
        }
        if (attempt === 270) throw new Error('timed out waiting for maintenance');
        await wait(10000);
      }
    }
  } catch (error) {
    if (comment && !completed) await finishReaction(api, comment, 'confused');
    throw error;
  }
  return true;
}

export async function finishRebase(env, request = fetch) {
  if (!env.INPUT_REQUEST_COMMENT) return false;
  const comment = env.INPUT_REQUEST_COMMENT;
  const number = env.INPUT_REQUEST_PULL_REQUEST;
  if (
    ![comment, number].every(
      (value) => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value)),
    )
  )
    throw new Error('invalid rebase request identifiers');
  const api = githubApi(env, request);
  const source = await api(`issues/comments/${comment}`);
  const issueUrl = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/issues/${number}`;
  if (source.issue_url !== issueUrl || !hasRebaseCommand(source.body))
    throw new Error('rebase request comment does not match the PR');
  const succeeded = env.UPDATE_OUTCOME === 'success' && env.UPDATED_PULL_REQUEST === number;
  await finishReaction(api, comment, succeeded ? 'hooray' : 'confused');
  return true;
}
