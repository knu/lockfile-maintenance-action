import { command } from './command.js';
import { lockfileTargets } from './targets.js';
import { cargoToolchain } from './managers/cargo.js';

export async function setupTools(env) {
  const { workspace, targets } = await lockfileTargets(env);
  const selected = new Set(targets.map(({ manager }) => manager.name));
  let rustup = selected.has('cargo');
  if (rustup) {
    try {
      await command('rustup', ['--version'], { directory: workspace, env });
      rustup = false;
    } catch {
      // The setup action also repairs an unusable rustup installation.
    }
  }
  return {
    uv: selected.has('uv'),
    bundler: selected.has('bundler'),
    rustup,
    'cargo-toolchain': cargoToolchain,
  };
}
