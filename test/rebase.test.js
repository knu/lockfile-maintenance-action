import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  dispatchRebase,
  finishRebase,
  rebaseCheckbox,
  rebaseInstructions,
  rebaseRequest,
  rebaseSetup,
  workflowFile,
  workflowUrl,
} from '../src/rebase.js';
import { changeReport } from '../src/version-changes.js';
import { run, temporaryDirectory } from './helpers.js';

const env = {
  GITHUB_REPOSITORY: 'owner/project',
  GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/maintenance.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'issue_comment',
  INPUT_TOKEN: 'test-token',
};
const event = {
  action: 'created',
  sender: { login: 'maintainer', type: 'User' },
  repository: { full_name: 'owner/project', default_branch: 'main' },
  issue: { number: 42, pull_request: {} },
  comment: { id: 123, body: '/lockfile rebase' },
};
const pr = {
  state: 'open',
  head: { ref: 'automation/lockfile-maintenance', repo: { full_name: 'owner/project' } },
  base: { ref: 'main', repo: { full_name: 'owner/project' } },
};

function api({ permission = 'write', pull = pr, fail = 0, status = 204 } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    if (calls.length === fail) return new Response('failure', { status: 403 });
    if (url.endsWith('/permission')) return Response.json({ permission });
    if (url.endsWith('/pulls/42')) return Response.json(pull);
    if (url.includes('/reactions?'))
      return Response.json([{ id: 456, content: '+1', user: { id: 1 } }]);
    if (options.method === 'DELETE') {
      assert.ok(url.endsWith('/reactions/456'));
      return new Response(null, { status: 204 });
    }
    assert.equal(options.method, 'POST');
    if (url.endsWith('/reactions'))
      return Response.json({ id: 456, user: { id: 1 } }, { status: 201 });
    return status === 204 ? new Response(null, { status }) : Response.json({ workflow_run_id: 1 });
  };
  return { calls, request };
}

test('new PR comments accept a standalone command line with surrounding text', () => {
  assert.equal(rebaseRequest('issue_comment', event), 42);
  for (const body of [
    'Please refresh this PR.\n/lockfile rebase\nThanks!',
    'Please refresh this PR.\r\n  /lockfile rebase \r\nThanks!',
  ])
    assert.equal(rebaseRequest('issue_comment', { ...event, comment: { body } }), 42);
  assert.equal(
    rebaseRequest('issue_comment', { ...event, comment: { body: ' /lockfile rebase\n' } }),
    42,
  );
  for (const body of ['Please /lockfile rebase', '/lockfile rebase now', '`/lockfile rebase`', ''])
    assert.equal(rebaseRequest('issue_comment', { ...event, comment: { body } }), undefined);
  for (const override of [
    { action: 'edited' },
    { issue: { number: 42 } },
    { sender: { type: 'Bot' } },
  ])
    assert.equal(rebaseRequest('issue_comment', { ...event, ...override }), undefined);
  assert.equal(rebaseRequest('pull_request', event), undefined);
});

test('checkbox requests require a unique generated unchecked-to-checked transition', () => {
  const checked = rebaseCheckbox.replace('[ ]', '[x]');
  const edit = {
    ...event,
    action: 'edited',
    changes: { body: { from: `Report\n${rebaseCheckbox}\n` } },
    pull_request: { number: 42, body: `Report\n${checked}\n` },
  };
  assert.equal(rebaseRequest('pull_request_target', edit), 42);
  for (const body of [rebaseCheckbox, `${checked}\n${checked}`, '- [x] Rebase'])
    assert.equal(
      rebaseRequest('pull_request_target', { ...edit, pull_request: { number: 42, body } }),
      undefined,
    );
  for (const from of [undefined, checked, '', `${rebaseCheckbox}\n${rebaseCheckbox}`])
    assert.equal(
      rebaseRequest('pull_request_target', { ...edit, changes: { body: { from } } }),
      undefined,
    );
  assert.equal(rebaseRequest('pull_request_target', { ...edit, changes: {} }), undefined);
});

test('dispatch validates write access and current PR before requesting trusted workflow', async () => {
  for (const status of [200, 204]) {
    const mock = api({ status });
    assert.equal(await dispatchRebase(env, event, mock.request), true);
    assert.equal(mock.calls.length, 4);
    assert.match(mock.calls[0].url, /collaborators\/maintainer\/permission$/);
    assert.match(mock.calls[2].url, /issues\/comments\/123\/reactions$/);
    assert.deepEqual(JSON.parse(mock.calls[2].body), { content: '+1' });
    assert.match(mock.calls[3].url, /actions\/workflows\/maintenance.yml\/dispatches$/);
    assert.deepEqual(JSON.parse(mock.calls[3].body), {
      ref: 'main',
      inputs: { 'request-comment': '123', 'request-pull-request': '42' },
    });
  }
});

test('read and triage users cannot dispatch, regardless of PR association', async () => {
  for (const permission of ['read', 'triage', 'none']) {
    const mock = api({ permission });
    await assert.rejects(dispatchRebase(env, event, mock.request), /write access/);
    assert.equal(mock.calls.length, 1);
  }
});

test('closed, forked, wrong head and wrong base PRs do not dispatch', async () => {
  for (const pull of [
    { ...pr, state: 'closed' },
    { ...pr, head: { ...pr.head, repo: { full_name: 'outsider/project' } } },
    { ...pr, head: { ...pr.head, ref: 'feature' } },
    { ...pr, base: { ...pr.base, ref: 'other' } },
    { ...pr, head: { ...pr.head, repo: null } },
  ]) {
    const mock = api({ pull });
    assert.equal(await dispatchRebase(env, event, mock.request), false);
    assert.equal(mock.calls.length, 2);
  }
});

test('API failures fail closed without retrying dispatch', async () => {
  for (const fail of [1, 2, 3]) {
    const mock = api({ fail });
    await assert.rejects(dispatchRebase(env, event, mock.request), /HTTP 403/);
    assert.equal(mock.calls.length, fail);
  }
});

test('custom maintenance branches and workflows come only from trusted inputs', async () => {
  const mock = api({ pull: { ...pr, base: { ...pr.base, ref: 'v1' } } });
  assert.equal(
    await dispatchRebase(
      {
        ...env,
        INPUT_BASE: 'v1',
        INPUT_REF: 'v1',
        INPUT_WORKFLOW: 'release.yml',
      },
      event,
      mock.request,
    ),
    true,
  );
  assert.match(mock.calls[3].url, /release.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(mock.calls[3].body), {
    ref: 'v1',
    inputs: { 'request-comment': '123', 'request-pull-request': '42' },
  });
  const ignored = api();
  assert.equal(
    await dispatchRebase(env, { ...event, comment: { body: 'hello' } }, ignored.request),
    false,
  );
  assert.equal(ignored.calls.length, 0);
});

test('setup links use the calling workflow and escape its filename', () => {
  const special = {
    ...env,
    GITHUB_WORKFLOW_REF:
      'owner/project/.github/workflows/maintain (locks).yml@refs/heads/release/@next',
    GITHUB_SERVER_URL: 'https://github.example.com',
  };
  // Git ref names can include @, so split at the workflow/ref boundary.
  assert.equal(workflowFile(env), 'maintenance.yml');
  assert.equal(workflowFile(special), 'maintain (locks).yml');
  assert.match(
    workflowUrl(special),
    /^https:\/\/github.example.com\/owner\/project\/actions\/workflows\/maintain%20%28locks%29.yml$/,
  );
  const setup = rebaseSetup(special);
  for (const text of [
    'issue_comment',
    'pull_request_target',
    'workflow_dispatch',
    workflowUrl(special),
    'id="user-content-rebase-setup"',
  ])
    assert.ok(setup.includes(text));
});

test('PR guidance selects one configured trigger and preserves checkbox transitions with a link', () => {
  const configuration = { verified: true, checkbox: true, comment: true };
  const checkbox = rebaseInstructions(configuration);
  assert.ok(checkbox.includes(`${rebaseCheckbox}\n  [Rebase setup]`));
  assert.ok(!checkbox.includes('/lockfile rebase'));
  assert.equal(
    rebaseRequest('pull_request_target', {
      sender: { type: 'User' },
      action: 'edited',
      changes: { body: { from: checkbox } },
      pull_request: { number: 42, body: checkbox.replace('[ ]', '[x]') },
    }),
    42,
  );
  const comment = rebaseInstructions({ ...configuration, checkbox: false });
  assert.ok(comment.includes('/lockfile rebase'));
  assert.ok(!comment.includes(rebaseCheckbox));
  for (const verified of [true, false]) {
    const instructions = rebaseInstructions({ verified, checkbox: false, comment: false });
    assert.match(instructions, /Rebase setup/);
    assert.ok(!instructions.includes(rebaseCheckbox) && !instructions.includes('/lockfile rebase'));
  }
});

test('PR body budget reserves trigger guidance and setup before truncating version changes', () => {
  const instructions = rebaseInstructions({ verified: true, checkbox: true, comment: true });
  const setup = rebaseSetup(env);
  const report = changeReport(
    [
      {
        file: 'Cargo.lock',
        changes: Array.from({ length: 5000 }, (_, i) => ({
          name: `package-${i}`,
          from: ['1.0.0'],
          to: ['2.0.0'],
        })),
      },
    ],
    '3 days',
    60000,
    'separate',
    { afterTables: `\n${instructions}\n`, footer: `\n${setup}` },
  );
  assert.ok(Buffer.byteLength(report) <= 60000);
  assert.match(report, /Report truncated/);
  assert.ok(report.includes(instructions) && report.endsWith(setup));
});

test('request entrypoint ignores unrelated events without API or checkout', async (t) => {
  const directory = await temporaryDirectory(t);
  const payload = path.join(directory, 'event.json');
  const output = path.join(directory, 'output');
  await writeFile(payload, JSON.stringify({ ...event, comment: { body: 'hello' } }));
  const result = await run(process.execPath, ['src/request-rebase.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, ...env, GITHUB_EVENT_PATH: payload, GITHUB_OUTPUT: output },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(output, 'utf8'), 'dispatched=false\n');
});

test('workflow examples isolate privileged requests from maintenance execution', async () => {
  for (const file of ['examples/cargo-maintenance.yml', 'examples/multi-tool-maintenance.yml']) {
    const workflow = parseYaml(await readFile(file, 'utf8'));
    assert.deepEqual(workflow.on.issue_comment.types, ['created']);
    assert.deepEqual(workflow.on.pull_request_target.types, ['edited']);
    assert.equal(workflow.concurrency, undefined);
    const request = workflow.jobs['request-rebase'];
    assert.deepEqual(request.permissions, {
      actions: 'write',
      issues: 'write',
      'pull-requests': 'read',
    });
    assert.ok(request.steps.every((step) => !step.uses?.startsWith('actions/checkout')));
    const update = workflow.jobs.update ?? workflow.jobs.maintain;
    assert.ok(
      update.if.includes(
        "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
      ),
    );
    assert.equal(update.concurrency['cancel-in-progress'], false);
    assert.equal(update.permissions.issues, 'write');
    const maintenance = update.steps.find((step) =>
      step.uses?.startsWith('knu/lockfile-maintenance-action@'),
    );
    for (const key of ['request-comment', 'request-pull-request']) {
      assert.equal(workflow.on.workflow_dispatch.inputs[key].type, 'string');
      assert.equal(maintenance.with[key], '${{ inputs.' + key + ' }}');
    }
  }
});

test('dispatch failure adds a failure reaction after acceptance', async () => {
  const mock = api({ fail: 4 });
  await assert.rejects(dispatchRebase(env, event, mock.request), /HTTP 403/);
  assert.equal(mock.calls.length, 7);
  assert.deepEqual(JSON.parse(mock.calls[4].body), { content: 'confused' });
});

test('checkbox dispatch needs neither comment metadata nor reactions', async () => {
  const mock = api();
  const edit = {
    ...event,
    action: 'edited',
    changes: { body: { from: rebaseCheckbox } },
    pull_request: { number: 42, body: rebaseCheckbox.replace('[ ]', '[x]') },
  };
  assert.equal(
    await dispatchRebase({ ...env, GITHUB_EVENT_NAME: 'pull_request_target' }, edit, mock.request),
    true,
  );
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(JSON.parse(mock.calls[2].body), { ref: 'main' });
});

test('completion reacts only to the source PR command and distinguishes failures', async () => {
  for (const [outcome, number, content] of [
    ['success', '42', 'hooray'],
    ['failure', '', 'confused'],
    ['skipped', '', 'confused'],
    ['success', '43', 'confused'],
  ]) {
    const calls = [];
    const request = async (url, options) => {
      calls.push({ url, ...options });
      if (url.includes('/reactions?'))
        return Response.json([{ id: 456, content: '+1', user: { id: 1 } }]);
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({
        user: { id: 1 },
        issue_url: 'https://api.github.com/repos/owner/project/issues/42',
        body: 'Please refresh this PR.\n/lockfile rebase\nThanks!',
      });
    };
    assert.equal(
      await finishRebase(
        {
          ...env,
          INPUT_REQUEST_COMMENT: '123',
          INPUT_REQUEST_PULL_REQUEST: '42',
          UPDATE_OUTCOME: outcome,
          UPDATED_PULL_REQUEST: number,
        },
        request,
      ),
      true,
    );
    assert.match(calls[0].url, /issues\/comments\/123$/);
    assert.match(calls[1].url, /issues\/comments\/123\/reactions$/);
    assert.deepEqual(JSON.parse(calls[1].body), { content });
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.ok(calls.at(-1).url.endsWith('/reactions/456'));
  }
});

test('completion refuses invalid identifiers and comments on another PR', async () => {
  const noRequest = () => assert.fail('unexpected API call');
  assert.equal(await finishRebase(env, noRequest), false);
  await assert.rejects(
    finishRebase(
      { ...env, INPUT_REQUEST_COMMENT: '../42', INPUT_REQUEST_PULL_REQUEST: '42' },
      noRequest,
    ),
    /invalid/,
  );
  let count = 0;
  await assert.rejects(
    finishRebase(
      { ...env, INPUT_REQUEST_COMMENT: '123', INPUT_REQUEST_PULL_REQUEST: '42' },
      async () => {
        count++;
        return Response.json({
          issue_url: 'https://api.github.com/repos/owner/project/issues/43',
          body: '/lockfile rebase',
        });
      },
    ),
    /does not match/,
  );
  assert.equal(count, 1);
});

test('result notification runs on failures before token revocation and uses its own token', async () => {
  const action = parseYaml(await readFile('action.yml', 'utf8'));
  const steps = action.runs.steps;
  const finish = steps.find((step) => step.name === 'Report rebase result');
  assert.equal(finish.if, "always() && inputs.request-comment != ''");
  assert.equal(finish.env.INPUT_TOKEN, '${{ inputs.reaction-token }}');
  assert.equal(finish.env.UPDATE_OUTCOME, '${{ steps.pull-request.outcome }}');
  assert.ok(
    steps.indexOf(finish) <
      steps.findIndex((step) => step.name === 'Revoke OIDC installation token'),
  );
});

test('completion tracking omits dispatch inputs and follows only the returned run', async () => {
  for (const conclusion of ['success', 'failure', 'cancelled']) {
    const mock = api({ status: 200 });
    const polls = [];
    let waits = 0;
    const request = async (url, options) => {
      if (url.includes('/actions/runs/')) {
        polls.push(url);
        return Response.json(
          polls.length === 1 ? { status: 'in_progress' } : { status: 'completed', conclusion },
        );
      }
      return mock.request(url, options);
    };
    assert.equal(
      await dispatchRebase(
        { ...env, INPUT_WAIT_FOR_COMPLETION: 'true' },
        event,
        request,
        async () => {
          waits++;
        },
      ),
      true,
    );
    assert.equal(waits, 1);
    assert.deepEqual(
      polls,
      Array(2).fill('https://api.github.com/repos/owner/project/actions/runs/1'),
    );
    assert.deepEqual(JSON.parse(mock.calls[3].body), { ref: 'main' });
    assert.deepEqual(
      JSON.parse(
        mock.calls
          .filter((call) => call.method === 'POST' && call.url.endsWith('/reactions'))
          .at(-1).body,
      ),
      {
        content: conclusion === 'success' ? 'hooray' : 'confused',
      },
    );
  }
});

test('completion tracking reports missing run IDs and timeout as failures', async () => {
  for (const status of [204, 200]) {
    const mock = api({ status });
    const request = async (url, options) =>
      url.includes('/actions/runs/')
        ? Response.json({ status: 'queued' })
        : mock.request(url, options);
    await assert.rejects(
      dispatchRebase({ ...env, INPUT_WAIT_FOR_COMPLETION: 'true' }, event, request, async () => {}),
      status === 204 ? /run ID/ : /timed out/,
    );
    assert.deepEqual(
      JSON.parse(
        mock.calls
          .filter((call) => call.method === 'POST' && call.url.endsWith('/reactions'))
          .at(-1).body,
      ),
      { content: 'confused' },
    );
  }
});

test('reusable workflow needs no request job and uses its own pinned source', async () => {
  const workflow = parseYaml(
    await readFile(new URL('../.github/workflows/maintenance.yml', import.meta.url), 'utf8'),
  );
  const maintain = workflow.jobs.maintain;
  assert.deepEqual(Object.keys(workflow.jobs), ['maintain']);
  assert.equal(
    maintain.if,
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
  );
  assert.equal(maintain.permissions['id-token'], 'write');
  assert.equal(maintain.permissions.contents, 'read');
  assert.equal(workflow.concurrency, undefined);
  assert.equal(maintain.concurrency['cancel-in-progress'], false);
  const action = maintain.steps.find((step) => step.id === 'maintenance');
  assert.equal(action.uses, '$/');
  assert.equal(action.with['request-comment'], undefined);
  assert.equal(action.with['request-pull-request'], undefined);
  for (const name of Object.keys(workflow.on.workflow_call.inputs))
    assert.ok(Object.hasOwn(action.with, name), name);
  const caller = parseYaml(
    await readFile(new URL('../examples/reusable-maintenance.yml', import.meta.url), 'utf8'),
  );
  assert.equal(Object.keys(caller.jobs).length, 1);
  assert.equal(caller.on.workflow_dispatch, null);
  assert.equal(caller.on.issue_comment, undefined);
  assert.equal(caller.on.pull_request_target, undefined);
  assert.deepEqual(caller.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(maintain.permissions, caller.permissions);
});

test('cleanup failure does not replace a successful result with failure', async () => {
  const mock = api({ status: 200 });
  const request = async (url, options) => {
    if (url.includes('/actions/runs/'))
      return Response.json({ status: 'completed', conclusion: 'success' });
    if (options.method === 'DELETE') return new Response(null, { status: 503 });
    return mock.request(url, options);
  };
  await assert.rejects(
    dispatchRebase({ ...env, INPUT_WAIT_FOR_COMPLETION: 'true' }, event, request),
    /HTTP 503/,
  );
  assert.deepEqual(
    mock.calls
      .filter((call) => call.method === 'POST' && call.url.endsWith('/reactions'))
      .map((call) => JSON.parse(call.body).content),
    ['+1', 'hooray'],
  );
});
