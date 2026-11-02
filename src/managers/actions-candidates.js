import { parseDocument } from 'yaml';
import semver from 'semver';

function remoteAction(value) {
  const separator = value.lastIndexOf('@');
  const parts = value.slice(0, separator).split('/');
  if (
    separator < 0 ||
    parts.length < 2 ||
    !parts.every((part) => /^[\w.-]+$/.test(part) && !['.', '..'].includes(part))
  )
    return undefined;
  return {
    repository: parts.slice(0, 2).join('/'),
    subpath: parts.slice(2).join('/'),
    ref: value.slice(separator + 1),
  };
}

export function githubActionsAPI(token, request = fetch) {
  const cache = new Map();
  return async (endpoint) => {
    if (!cache.has(endpoint))
      cache.set(
        endpoint,
        (async () => {
          const response = await request(`https://api.github.com/repos/${endpoint}`, {
            headers: {
              Accept: 'application/vnd.github+json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
          });
          if (response.status === 404) {
            await response.body?.cancel();
            return undefined;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`GitHub Actions metadata lookup failed: HTTP ${response.status}`);
          }
          return response.json();
        })(),
      );
    return cache.get(endpoint);
  };
}

function remoteUses(manifest) {
  const document = parseDocument(manifest);
  if (document.errors.length) throw document.errors[0];
  const runs = document.toJS()?.runs;
  if (!runs?.using) return undefined;
  if (runs.using !== 'composite') return [];
  const refs = [];
  const visit = (steps) => {
    if (!Array.isArray(steps)) throw new Error('invalid composite action steps');
    for (const step of steps) {
      if (step.parallel) visit(step.parallel);
      if (step.uses !== undefined) {
        if (typeof step.uses !== 'string') throw new Error('invalid composite action reference');
        if (!step.uses.startsWith('docker://')) refs.push(step.uses);
      }
    }
  };
  visit(runs.steps);
  return [...new Set(refs)].sort();
}

// Select a complete dependency graph without widening workflow refs.  The
// official verifier remains the authority for provenance and runner parity.
export async function agedActionPins(lock, { api, cutoff, report = console.log }) {
  const original = lock.dependencies;
  const resolved = new Map();
  const active = new Set();
  const releases = new Map();
  const commit = async (repository, ref) => {
    const result = await api(`${repository}/commits/${encodeURIComponent(ref)}`);
    return /^[0-9a-f]{40}$/i.test(result?.sha) ? result.sha : undefined;
  };
  const ancestor = async (repository, base, head) => {
    if (base === head) return true;
    const result = await api(
      `${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return ['ahead', 'identical'].includes(result?.status);
  };
  const listReleases = async (repository) => {
    if (!releases.has(repository)) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await api(`${repository}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error(`cannot list action releases: ${repository}`);
        all.push(...batch);
        if (batch.length < 100) break;
        if (page === 100) throw new Error(`too many action releases: ${repository}`);
      }
      releases.set(
        repository,
        all.filter(
          (release) =>
            !release.draft &&
            !release.prerelease &&
            typeof release.published_at === 'string' &&
            Number.isFinite(Date.parse(release.published_at)) &&
            Date.parse(release.published_at) <= cutoff,
        ),
      );
    }
    return releases.get(repository);
  };
  const retain = async (key, old) => {
    if (!old) return undefined;
    const deps = { [key]: old };
    for (const child of old.uses ?? []) {
      const graph = await resolve(child);
      if (!graph) throw new Error(`existing action dependency is missing: ${child}`);
      Object.assign(deps, graph);
    }
    return deps;
  };
  const resolve = async (key) => {
    if (active.has(key)) return undefined;
    if (resolved.has(key)) return resolved.get(key);
    active.add(key);
    try {
      const old = original[key];
      const action = remoteAction(key);
      if (!action) return undefined;
      const { repository, subpath, ref } = action;
      if (old?.hostname && old.hostname !== 'github.com')
        throw new Error('Actions maintenance supports github.com only');
      const partial = /^v?(\d+)(?:\.(\d+))?$/.exec(ref);
      // Exact refs and undated branches retain their existing pins.  New
      // transitive refs still need a dated release before entering the graph.
      if (old && !partial) {
        const graph = await retain(key, old);
        resolved.set(key, graph);
        return graph;
      }
      const metadata = await api(repository);
      if (!metadata?.id || !metadata.owner?.id)
        throw new Error(`action repository unavailable: ${repository}`);
      if (old && (old.repo_id !== metadata.id || old.owner_id !== metadata.owner.id))
        throw new Error(`action repository identity changed: ${repository}`);
      const available = await listReleases(repository);
      const candidates = partial
        ? available
            .filter((release) => {
              const version = semver.parse(release.tag_name);
              return (
                version &&
                !version.prerelease.length &&
                version.major === Number(partial[1]) &&
                (partial[2] === undefined || version.minor === Number(partial[2]))
              );
            })
            .sort(
              (a, b) =>
                semver.rcompare(a.tag_name, b.tag_name) || a.tag_name.localeCompare(b.tag_name),
            )
        : available.filter((release) => release.tag_name === ref || /^[0-9a-f]{40}$/i.test(ref));
      const live = await commit(repository, ref);
      const previous = old?.commit.slice(5);
      let chosen;
      for (const release of candidates) {
        const sha = await commit(repository, release.tag_name);
        if (
          !sha ||
          !live ||
          (!partial && sha !== live) ||
          !(await ancestor(repository, sha, live)) ||
          (previous && !(await ancestor(repository, previous, sha)))
        )
          continue;
        if (sha === previous) break;
        const prefix = subpath ? `${subpath}/` : '';
        let contents = await api(`${repository}/contents/${prefix}action.yml?ref=${sha}`);
        if (!contents)
          contents = await api(`${repository}/contents/${prefix}action.yaml?ref=${sha}`);
        if (contents?.type !== 'file' || contents.encoding !== 'base64') continue;
        const uses = remoteUses(Buffer.from(contents.content, 'base64').toString('utf8'));
        if (!uses || uses.some((child) => !remoteAction(child))) continue;
        const graph = {};
        let eligible = true;
        for (const child of uses) {
          const childGraph = await resolve(child);
          if (!childGraph) {
            eligible = false;
            break;
          }
          Object.assign(graph, childGraph);
        }
        if (!eligible) continue;
        graph[key] = {
          ref: /^[0-9a-f]{40}$/i.test(ref) ? release.tag_name : ref,
          commit: `sha1-${sha}`,
          owner_id: metadata.owner.id,
          repo_id: metadata.id,
          ...(uses.length ? { uses } : {}),
        };
        chosen = graph;
        break;
      }
      if (!chosen) {
        chosen = await retain(key, old);
        report(`${key}: ${old ? 'keeping current pin' : 'no eligible dated release'}`);
      }
      resolved.set(key, chosen);
      return chosen;
    } finally {
      active.delete(key);
    }
  };
  const dependencies = {};
  for (const key of new Set(Object.values(lock.workflows).flat())) {
    const graph = await resolve(key);
    if (!graph) throw new Error(`cannot preserve action dependency: ${key}`);
    Object.assign(dependencies, graph);
  }
  return {
    ...lock,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}
