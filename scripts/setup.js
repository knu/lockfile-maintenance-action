import { createHash } from 'node:crypto';
import { appendFile, cp, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'lockfile-maintenance-'));
for (const file of ['package.json', 'package-lock.json', 'src'])
  await cp(path.join(source, file), path.join(directory, file), { recursive: true });
const hash = createHash('sha256')
  .update(await readFile(path.join(directory, 'package-lock.json')))
  .digest('hex');
await appendFile(process.env.GITHUB_OUTPUT, `directory=${directory}\nlock-hash=${hash}\n`);
