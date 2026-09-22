import { spawn } from 'node:child_process';

// This version's publish-age behavior is covered by the integration tests.
export const cargoToolchain = 'nightly-2026-09-10';

async function rustup(args, directory, env, quiet = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn('rustup', args, {
      cwd: directory,
      env,
      stdio: quiet ? 'ignore' : 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`rustup terminated by ${signal}`));
      else resolve(code);
    });
  });
}

export async function prepareCargo({ directory, env }) {
  if (await rustup(['run', cargoToolchain, 'cargo', '--version'], directory, env, true)) {
    const code = await rustup(
      ['toolchain', 'install', cargoToolchain, '--profile', 'minimal', '--no-self-update'],
      directory,
      env,
    );
    if (code) throw new Error(`installing Cargo toolchain failed (exit ${code})`);
  }
}

export async function updateCargo({ directory, age, env }) {
  const code = await rustup(
    [
      'run',
      cargoToolchain,
      'cargo',
      'update',
      '--config',
      `registry.global-min-publish-age=${JSON.stringify(`${age.seconds} seconds`)}`,
      '--config',
      `registry.min-publish-age=${JSON.stringify(`${age.seconds} seconds`)}`,
      '--config',
      'resolver.incompatible-publish-age="deny"',
    ],
    directory,
    env,
  );
  if (code) throw new Error(`cargo update failed (exit ${code}); original lockfile restored`);
}
