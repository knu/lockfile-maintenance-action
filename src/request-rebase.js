import { appendFile, readFile } from 'node:fs/promises';
import { dispatchRebase, workflowUrl, workflowFile } from './rebase.js';

try {
  const env = process.env;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const dispatched = await dispatchRebase(env, event);
  await appendFile(env.GITHUB_OUTPUT, `dispatched=${dispatched}\n`);
  if (dispatched) {
    const url = workflowUrl(env, env.INPUT_WORKFLOW || workflowFile(env));
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `Rebase requested.  [View workflow runs](<${url}>).\n`,
    );
  }
} catch (error) {
  console.error(`lockfile-maintenance: ${error.message}`);
  process.exitCode = 1;
}
