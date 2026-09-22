import ignore from 'ignore';
import { command } from './command.js';

export async function listFiles(directory, env, includeUntracked = false) {
  const args = ['ls-files', '--cached', '-z'];
  if (includeUntracked) args.push('--others', '--exclude-standard');
  const output = await command('git', [...args, '--'], { directory, env });
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

export function selectFiles(patterns) {
  const rules = patterns.split(/\r?\n/).map((line) => {
    const include = !line.startsWith('!');
    let pattern = include ? line : line.slice(1);
    if (!include && (pattern.startsWith('#') || pattern.startsWith('!'))) pattern = `\\${pattern}`;
    return { include, matcher: ignore({ ignorecase: false }).add(pattern) };
  });
  return (file) => {
    let selected = false;
    for (const { include, matcher } of rules) {
      if (matcher.ignores(file)) selected = include;
    }
    return selected;
  };
}
