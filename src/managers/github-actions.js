import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { command } from '../command.js';
import { parseActionsLock } from '../actions-lockfile.js';
import { agedActionPins, githubActionsAPI } from './actions-candidates.js';

const extensionVersion = 'v0.4.0';

async function verify(context) {
  const lock = parseActionsLock(
    await readFile(path.join(context.directory, '.github/workflows/actions.lock'), 'utf8'),
  );
  const workflows = Object.keys(lock.workflows);
  if (!workflows.length) throw new Error('actions.lock has no onboarded workflows');
  if (workflows.some((file) => !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)))
    throw new Error('invalid actions.lock workflow path');
  await command(
    'gh',
    ['actions-lock', '--hostname', 'github.com', '--verify', '--no-interactive', ...workflows],
    context,
  );
}

export async function prepareGitHubActions(context) {
  if (context.env.GITHUB_SERVER_URL && context.env.GITHUB_SERVER_URL !== 'https://github.com')
    throw new Error('Actions lockfile maintenance supports github.com only');
  context.env = {
    ...context.env,
    GH_TOKEN: context.env.INPUT_TOKEN || context.env.GH_TOKEN,
    GH_HOST: 'github.com',
    GH_ACTIONS_LOCK_REPO_ROOT: context.directory,
  };
  delete context.env.GH_ACTIONS_LOCK_WORKFLOWS_DIR;
  delete context.env.GH_REPO;
  let version;
  try {
    version = (await command('gh', ['actions-lock', '--version'], context)).trim();
  } catch {
    /* Install below when setup is enabled. */
  }
  if (version !== `actions-lock version ${extensionVersion}`) {
    if (context.env.INPUT_SETUP_ACTIONS_LOCK === 'false')
      throw new Error(`gh actions-lock ${extensionVersion} is required`);
    await command(
      'gh',
      ['extension', 'install', 'github/gh-actions-lock', '--pin', extensionVersion, '--force'],
      context,
    );
    version = (await command('gh', ['actions-lock', '--version'], context)).trim();
    if (version !== `actions-lock version ${extensionVersion}`)
      throw new Error('unexpected gh actions-lock version');
  }
  await verify(context);
}

export async function updateGitHubActions(context) {
  const file = path.join(context.directory, '.github/workflows/actions.lock');
  const contents = await readFile(file, 'utf8');
  const before = parseActionsLock(contents);
  const after = await agedActionPins(before, {
    api: githubActionsAPI(context.env.GH_TOKEN),
    cutoff: Date.now() - context.age.seconds * 1000,
  });
  if (isDeepStrictEqual(before, after)) return;
  const document = parseDocument(contents);
  document.set('dependencies', after.dependencies);
  document.commentBefore =
    ' Maintained by lockfile-maintenance-action; verified with gh actions-lock.\n Do not edit by hand.';
  await writeFile(file, document.toString());
  await verify(context);
}
