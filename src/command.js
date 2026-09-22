import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import semver from 'semver';

const execute = promisify(execFile);

export async function command(executable, args, { directory, env, input }) {
  try {
    const execution = execute(executable, args, {
      cwd: directory,
      env,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    if (input !== undefined) execution.child.stdin.end(input);
    const { stdout } = await execution;
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${executable} is required on PATH`);
    throw new Error(
      `${executable} failed (${error.signal ?? `exit ${error.code}`}): ${error.stderr || error.message}`,
    );
  }
}

export async function requireVersion(executable, minimum, context) {
  const output = (await command(executable, ['--version'], context)).trim();
  const version = semver.coerce(output, { includePrerelease: true });
  if (!version || !semver.satisfies(version, `>=${minimum}`)) {
    throw new Error(`${executable} >=${minimum} is required; found ${output}`);
  }
}
