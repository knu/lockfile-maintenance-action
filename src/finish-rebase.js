import { finishRebase } from './rebase.js';

finishRebase(process.env).catch((error) => {
  console.error(`lockfile-maintenance: ${error.message}`);
  process.exitCode = 1;
});
