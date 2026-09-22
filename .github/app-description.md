Keep lockfiles current without taking every newly published package immediately.

Lockfile Maintenance works with knu/lockfile-maintenance-action to update Git-tracked Cargo, npm, pnpm, Yarn, uv, and Bundler lockfiles and open pull requests with per-file version change tables.

Why use it alongside Renovate?

- Apply minimum release ages during dependency resolution, including transitive dependencies. Cargo maintenance gets a native publish-age policy that Renovate does not yet pass through.
- Run maintenance independently of Renovate's renovate/stability-days status, which can remain pending on maintenance PRs. Normal PR CI and review requirements still apply.
- Authenticate through GitHub Actions OIDC. No personal access token or App private key is needed in your repository.
- Trigger your existing PR CI and dependency merge queue with lockfile-maintenance[bot].

Keep Renovate for manifest updates and security alerts. Select lockfiles with gitignore-style path patterns, choose a minimum release age, and run on a schedule or manually. Yarn 4.10+ is supported. Each package manager's native source and package exceptions apply.

Install this App, then add the workflow described at https://github.com/knu/lockfile-maintenance-action#oidc-authentication. Installing the App alone does not schedule updates; only repositories with the workflow run maintenance.
