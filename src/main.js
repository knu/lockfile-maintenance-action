import { maintainLockfile } from './maintenance.js';

maintainLockfile(process.env).catch((error) => {
  // Plain stderr avoids interpreting repository-controlled text as workflow commands.
  console.error(`lockfile-maintenance: ${error.message}`);
  process.exitCode = 1;
});
