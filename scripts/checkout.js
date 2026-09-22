import { appendFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const present = await lstat(path.join(process.env.GITHUB_WORKSPACE, '.git')).then(
  () => true,
  (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  },
);
await appendFile(process.env.GITHUB_OUTPUT, `required=${!present}\n`);
