import { parseDocument } from 'yaml';

export function parseActionsLock(contents) {
  const document = parseDocument(contents);
  if (document.errors.length) throw document.errors[0];
  const data = document.toJS();
  if (data?.version !== 'v0.0.3') throw new Error('unsupported actions.lock version');
  if (
    !data.workflows ||
    Array.isArray(data.workflows) ||
    typeof data.workflows !== 'object' ||
    Object.values(data.workflows).some(
      (refs) => !Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string'),
    )
  )
    throw new Error('invalid actions.lock workflows');
  data.dependencies ??= {};
  if (Array.isArray(data.dependencies) || typeof data.dependencies !== 'object')
    throw new Error('missing actions.lock dependencies');
  for (const [name, dependency] of Object.entries(data.dependencies)) {
    if (
      !dependency ||
      typeof dependency.ref !== 'string' ||
      !/^sha1-[0-9a-f]{40}$/i.test(dependency.commit) ||
      !Number.isSafeInteger(dependency.owner_id) ||
      !Number.isSafeInteger(dependency.repo_id) ||
      (dependency.uses !== undefined &&
        (!Array.isArray(dependency.uses) || dependency.uses.some((ref) => typeof ref !== 'string')))
    )
      throw new Error(`invalid actions.lock dependency: ${name}`);
  }
  return data;
}

export function actionDependencies(contents) {
  return Object.entries(parseActionsLock(contents).dependencies).map(([name, dependency]) => ({
    ...dependency,
    name,
  }));
}
