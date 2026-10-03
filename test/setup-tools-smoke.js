import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtures = {
  yarn: {
    'package.json': JSON.stringify({
      name: 'yarn-smoke',
      private: true,
      packageManager: 'yarn@4.18.0',
    }),
    'yarn.lock': '__metadata:\n  version: 8\n',
  },
  uv: {
    'pyproject.toml':
      '[project]\nname = "uv-smoke"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = []\n',
    'uv.lock': 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n',
  },
  bundler: { Gemfile: "source 'https://rubygems.org'\n", 'Gemfile.lock': '' },
};
for (const [tool, files] of Object.entries(fixtures)) {
  const directory = path.join('.tmp/tool-smoke', tool);
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files))
    await writeFile(path.join(directory, name), contents);
}
