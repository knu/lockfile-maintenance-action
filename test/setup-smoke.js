import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('.tmp/smoke/src', { recursive: true });
await writeFile(
  '.tmp/smoke/Cargo.toml',
  '[package]\nname = "smoke"\nversion = "0.1.0"\nedition = "2021"\n',
);
await writeFile('.tmp/smoke/src/lib.rs', '');
await writeFile('.tmp/smoke/Cargo.lock', 'version = 4\n');
