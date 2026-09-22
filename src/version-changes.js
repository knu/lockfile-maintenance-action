import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { parseSyml } from '@yarnpkg/parsers';
import { parse as parseDependencyPath } from '@pnpm/dependency-path';
import semver from 'semver';
import { command } from './command.js';

export async function packageVersions(manager, contents, context) {
  let packages;
  switch (manager) {
    case 'cargo':
    case 'uv': {
      const data = parseToml(contents);
      if (!Number.isInteger(data.version)) throw new Error('missing lockfile version');
      packages = (data.package ?? []).map(({ name, version }) => [name, version]);
      break;
    }
    case 'pnpm': {
      const data = parseYaml(contents);
      if (!data?.lockfileVersion) throw new Error('missing lockfileVersion');
      packages = Object.entries(data.packages ?? {}).map(([key, value]) => {
        const parsed = parseDependencyPath(key.replace(/^\//, ''));
        return [value.name ?? parsed.name, value.version ?? parsed.version];
      });
      break;
    }
    case 'yarn': {
      const data = parseSyml(contents);
      if (!data.__metadata) throw new Error('missing Yarn lockfile metadata');
      packages = Object.entries(data)
        .filter(([key]) => key !== '__metadata')
        .map(([, value]) => {
          const resolution = value.resolution;
          if (typeof resolution !== 'string') throw new Error('missing Yarn resolution');
          const separator = resolution.indexOf('@', 1);
          if (separator < 1) throw new Error('invalid Yarn resolution');
          return [resolution.slice(0, separator), value.version];
        });
      break;
    }
    case 'bundler':
      packages = JSON.parse(
        await command('ruby', [fileURLToPath(new URL('./lockfile_versions.rb', import.meta.url))], {
          ...context,
          input: contents,
        }),
      );
      break;
    default:
      throw new Error(`unsupported lockfile manager: ${manager}`);
  }
  const result = new Map();
  for (const [name, version] of packages) {
    // Local/virtual packages may not declare a version.
    if (version === undefined) continue;
    if (typeof name !== 'string' || typeof version !== 'string')
      throw new Error('invalid package name or version');
    if (!result.has(name)) result.set(name, new Set());
    result.get(name).add(version);
  }
  return result;
}

export function versionChanges(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((name) => {
    const from = [...(before.get(name) ?? [])].sort();
    const to = [...(after.get(name) ?? [])].sort();
    return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ name, from, to }];
  });
}

export function changeType(from, to) {
  if (!from.length) return 'added';
  if (!to.length) return 'removed';
  const removed = from.filter((version) => !to.includes(version));
  const added = to.filter((version) => !from.includes(version));
  if (!removed.length) return 'added version';
  if (!added.length) return 'removed version';
  if (removed.length !== 1 || added.length !== 1) return 'multiple';
  const parse = (value) =>
    semver.parse(
      /^\d+(?:\.\d+)?$/.test(value) ? value + '.0'.repeat(3 - value.split('.').length) : value,
    );
  const oldVersion = parse(removed[0]);
  const newVersion = parse(added[0]);
  if (!oldVersion || !newVersion) return 'other';
  const direction = semver.lt(newVersion, oldVersion) ? ' downgrade' : '';
  for (const component of ['major', 'minor', 'patch'])
    if (oldVersion[component] !== newVersion[component]) return component + direction;
  if (semver.compare(oldVersion, newVersion)) return 'prerelease' + direction;
  if (oldVersion.build.join('.') !== newVersion.build.join('.')) return 'build';
  return 'other';
}

function code(value) {
  const escaped = value.replace(
    /[&<>|\r\n`*_[\]\\@]/g,
    (character) => `&#${character.codePointAt(0)};`,
  );
  return `<code>${escaped}</code>`;
}

export function changeReport(files, age, maxBytes = 60000) {
  const lines = [
    `Update selected lockfiles with a minimum release age of ${code(age)}.`,
    '',
    "The package managers' native exceptions still apply.  Validate updates with the repository's PR CI.",
    '',
    '## Version changes',
    '',
    'Versions are grouped by package name.  — means the package was not present.',
    '',
  ];
  let size = Buffer.byteLength(lines.join('\n'));
  const append = (line) => {
    if (size + Buffer.byteLength(line) + 1 > maxBytes - 200) return false;
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
    return true;
  };
  let truncated = false;
  for (const { file, changes } of files) {
    const section =
      `### ${code(file)}\n\n` +
      (changes.length
        ? '| Package | Before | After | Change |\n| --- | --- | --- | --- |'
        : 'No package version changes (metadata, source, or dependency graph changes only).');
    if (!append(section)) {
      truncated = true;
      break;
    }
    for (const { name, from, to } of changes) {
      const versions = (values) => (values.length ? values.map(code).join(', ') : '—');
      if (
        !append(`| ${code(name)} | ${versions(from)} | ${versions(to)} | ${changeType(from, to)} |`)
      ) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    append('');
  }
  if (!files.length) append('No lockfile changes.');
  if (truncated)
    lines.push(
      '',
      'Report truncated to fit the PR body limit.  See the file diff for the remaining changes.',
    );
  return `${lines.join('\n')}\n`;
}
