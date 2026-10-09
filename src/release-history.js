import semver from 'semver';

export function githubRepository(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(
      value.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/'),
    );
    if (url.hostname !== 'github.com' || url.username || url.password) return undefined;
    const parts = url.pathname
      .replace(/\.git\/?$/, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[\w.-]+$/.test(part)))
      return undefined;
    return parts.slice(0, 2).join('/');
  } catch {
    return undefined;
  }
}

function releaseVersion(tag, name, scoped) {
  for (const candidate of new Set([name, name.split('/').at(-1)]))
    for (const prefix of [`${candidate}@`, `${candidate}-`, `${candidate}/`])
      if (tag.startsWith(prefix)) return semver.valid(tag.slice(prefix.length));
  return scoped ? null : semver.valid(tag);
}

export async function addReleaseHistory(files, { token, request = fetch } = {}) {
  const cache = new Map();
  const deadline = AbortSignal.timeout(60000);
  let remaining = 300;
  const json = async (url) => {
    if (!cache.has(url)) {
      cache.set(
        url,
        (async () => {
          if (deadline.aborted || remaining-- <= 0) return undefined;
          try {
            const github = new URL(url).origin === 'https://api.github.com';
            const response = await request(url, {
              headers: {
                Accept: 'application/json',
                'User-Agent': 'lockfile-maintenance-action',
                ...(github && token ? { Authorization: `Bearer ${token}` } : {}),
              },
              redirect: 'error',
              signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
            });
            if (!response.ok) {
              await response.body?.cancel();
              return undefined;
            }
            return await response.json();
          } catch {
            return undefined;
          }
        })(),
      );
    }
    return cache.get(url);
  };
  const list = async (base) => {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await json(`${base}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) return { items, complete: false };
      items.push(...batch);
      if (batch.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  };
  for (const { manager, changes } of files) {
    for (const change of changes) {
      try {
        const from = change.from.filter((v) => !change.to.includes(v));
        const to = change.to.filter((v) => !change.from.includes(v));
        if (from.length !== 1 || to.length !== 1 || !semver.valid(from[0]) || !semver.valid(to[0]))
          continue;
        const name = encodeURIComponent(change.name);
        let source;
        let directory;
        if (['npm', 'pnpm', 'yarn'].includes(manager)) {
          const data = await json(
            `https://registry.npmjs.org/${name}/${encodeURIComponent(to[0])}`,
          );
          source = typeof data?.repository === 'string' ? data.repository : data?.repository?.url;
          directory = data?.repository?.directory;
        } else if (manager === 'cargo') {
          source = (await json(`https://crates.io/api/v1/crates/${name}`))?.crate?.repository;
        } else if (manager === 'bundler') {
          const data = await json(`https://rubygems.org/api/v1/gems/${name}.json`);
          source = data?.source_code_uri;
        } else if (manager === 'uv') {
          const links = (
            await json(`https://pypi.org/pypi/${name}/${encodeURIComponent(to[0])}/json`)
          )?.info?.project_urls;
          source = Object.values(links ?? {}).find((url) => githubRepository(url));
        }
        const repository = githubRepository(source);
        if (!repository) continue;
        const base = `https://api.github.com/repos/${repository}`;
        const web = `https://github.com/${repository}`;
        const releases = await list(`${base}/releases`);
        const tags = await list(`${base}/tags`);
        const scoped = [...releases.items, ...tags.items].some((item) =>
          releaseVersion(item.tag_name ?? item.name ?? '', change.name, true),
        );
        const version = (tag) => releaseVersion(tag ?? '', change.name, scoped);
        const refs = new Map();
        for (const item of [...releases.items, ...tags.items]) {
          const tag = item.tag_name ?? item.name;
          const v = version(tag);
          if (v && !refs.has(v)) refs.set(v, tag);
        }
        const contents = await json(
          `${base}/contents${directory ? `/${directory.split('/').map(encodeURIComponent).join('/')}` : ''}`,
        );
        const findChangelog = (items) =>
          Array.isArray(items)
            ? items.find(
                (item) => item.type === 'file' && item.name.toLowerCase() === 'changelog.md',
              )
            : undefined;
        const changelog =
          findChangelog(contents) ??
          (directory ? findChangelog(await json(`${base}/contents`)) : undefined);
        const history = {
          releases: semver.lt(from[0], to[0])
            ? releases.items
                .filter(
                  (item) =>
                    !item.draft &&
                    version(item.tag_name) &&
                    semver.gt(version(item.tag_name), from[0]) &&
                    semver.lte(version(item.tag_name), to[0]),
                )
                .sort((a, b) => semver.rcompare(version(a.tag_name), version(b.tag_name)))
                .map((item) => ({
                  tag: item.tag_name,
                  body: item.body ?? '',
                  url: `${web}/releases/tag/${encodeURIComponent(item.tag_name)}`,
                }))
            : [],
          incomplete: !releases.complete,
          releasesUrl: `${web}/releases`,
          versionUrls: {},
        };
        for (const v of [from[0], to[0]]) {
          if (refs.has(v))
            history.versionUrls[v] = `${web}/tree/${encodeURIComponent(refs.get(v))}`;
          const release = history.releases.find((item) => version(item.tag) === v);
          if (release) history.versionUrls[v] = release.url;
        }
        if (refs.has(from[0]) && refs.has(to[0]))
          history.compareUrl = `${web}/compare/${encodeURIComponent(refs.get(from[0]))}...${encodeURIComponent(refs.get(to[0]))}`;
        if (changelog)
          history.changelogUrl = `${web}/blob/HEAD/${changelog.path.split('/').map(encodeURIComponent).join('/')}`;
        change.history = history;
      } catch {
        // Optional upstream metadata must not prevent lockfile maintenance.
      }
    }
  }
}
