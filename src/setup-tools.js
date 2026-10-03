import { appendFile } from 'node:fs/promises';
import { setupTools } from './tool-setup.js';

try {
  const outputs = await setupTools(process.env);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => key + '=' + value + '\n')
      .join(''),
  );
} catch (error) {
  console.error('lockfile-maintenance: ' + error.message);
  process.exitCode = 1;
}
