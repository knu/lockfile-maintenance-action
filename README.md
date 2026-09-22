# Lockfile Maintenance Action for GitHub Actions

This Action updates Git-tracked lockfiles using Cargo, pnpm, Yarn, uv, or Bundler, with a minimum release age passed to each tool's dependency resolver.  It selects the tool from the lockfile name and updates dependencies within the existing manifest constraints.

By default, all supported lockfiles in the repository, including subdirectories, are selected.  Use gitignore-style patterns to limit the selection.  Untracked files are never selected.

The Action creates or updates a pull request by default, committing only the selected lockfiles.  Set `create-pull-request: false` to update files without committing or opening a PR.  Run project tests in the consuming repository's PR CI.

## Usage

``` yaml
on:
  schedule:
    - cron: "0 0 * * 1"  # At 00:00 UTC on Mondays

  workflow_dispatch:

name: "Lockfile Maintenance"

concurrency:
  group: lockfile-maintenance
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: step-security/harden-runner@e14015d583714f6e62063499dc959a02595150a1 # v2.21.1
        with:
          egress-policy: audit

      - uses: knu/lockfile-maintenance-action@v1 # zizmor: ignore[unpinned-uses] -- Follow the v1 release series in this example.
        id: maintenance
        with:
          files: /Cargo.lock
          minimum-release-age: 3 days
          token: ${{ secrets.LOCKFILE_MAINTENANCE_TOKEN }}
```

Configure `LOCKFILE_MAINTENANCE_TOKEN` with a fine-grained personal access token or supply a GitHub App installation token with contents and pull requests write access.  These allow the consuming repository's PR CI to run without the approval required for [PR workflows triggered by `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

See [the Cargo workflow](examples/cargo-maintenance.yml) and [the multi-tool workflow](examples/multi-tool-maintenance.yml) for complete examples.  The default token is `github.token`; when using it, grant `contents: write` and `pull-requests: write`, and enable GitHub Actions to create pull requests in repository settings.

`@v1` follows the latest `main` commit that passes this repository's CI.  The Action is tested on Linux runners.

### Supported tools

| Tool | Lockfile | Required manifest | Setup |
| --- | --- | --- | --- |
| Cargo | `Cargo.lock` | `Cargo.toml` | Requires `rustup`; installs `nightly-2026-09-10` if absent |
| pnpm | `pnpm-lock.yaml` | `package.json` | Install pnpm >=11 before use |
| Yarn | `yarn.lock` | `package.json` | Install Yarn >=4.10 before use |
| uv | `uv.lock` | `pyproject.toml` | Install uv >=0.9.17 before use |
| Bundler | `Gemfile.lock` | `Gemfile` | Install Bundler >=4.0.18 before use |

Each manifest must be in the same directory as its lockfile.  Select workspace-root lockfiles for package-manager workspaces.  Selecting both pnpm and Yarn lockfiles for the same manifest is an error.  npm and Poetry lockfiles are not supported.

The Action sets up Node.js 24 for its own runtime and installs its runtime dependencies in a temporary directory, reusing an npm download cache.  Cargo uses the pinned nightly without changing the default Rust toolchain.

### Inputs

- `auth` (string, optional)

  Authentication mode: `token` uses the supplied `token` or `github.token`; `oidc` exchanges a GitHub Actions identity token for a repository-scoped installation token from the Lockfile Maintenance App.  OIDC requires `id-token: write`, an App installation, and authorization by the broker.  It never falls back to another credential on failure.

  Default: `token`

- `create-pull-request` (string, optional)

  Create or update a maintenance PR.  Use `false` to only update files; this mode needs no write token or PR permissions.  Existing file-change outputs remain available in either mode.

  Default: `true`

- `token` (string, optional)

  Token used for automatic checkout and to push the maintenance branch and create or update its PR.  Checkout requires contents read access; PR creation also requires contents and pull requests write access.

  Ignored when `auth` is `oidc`.

  Default: `${{ github.token }}`

- `branch` (string, optional)

  Branch used for the maintenance PR.  Repeated runs update the same PR.  Use distinct branches for independent file selections, and serialize workflow runs that use the same branch.

  Default: `automation/lockfile-maintenance`

- `base` (string, optional)

  Target branch for the PR and automatic checkout.  An existing checkout keeps its current ref; check out the desired base yourself when supplying an existing checkout.

  Default: the repository's default branch

- `labels` (string, optional)

  Comma or newline-separated labels applied to the PR.

  Default: `dependencies`

- `files` (string, optional)

  Newline-separated gitignore-style patterns, relative to `working-directory`.  Positive patterns include files, `!` excludes them, and the last matching pattern wins.  Only Git-tracked files with supported lockfile names are considered.

  A basename such as `Cargo.lock` matches at any depth; `/Cargo.lock` matches only the root.  Patterns support `*`, `**`, directory names, `#` comments, and backslash escapes.  Blank lines are ignored.  Unlike gitignore's directory traversal rules, a later inclusion can re-include a file inside an excluded directory.

  Default: all supported lockfiles, including subdirectories.

  ``` yaml
  files: |
    Cargo.lock
    pnpm-lock.yaml
    yarn.lock
    uv.lock
    Gemfile.lock
    !vendor/
    vendor/example/Cargo.lock
  ```

- `minimum-release-age` (string, optional)

  Minimum age passed to each native resolver.  Use a positive integer followed by `seconds`, `minutes`, `hours`, `days`, `weeks`, or `months`, for example `3 days`.  A month means 30 days.  Values are rounded up to whole minutes for pnpm and Yarn, and whole days for Bundler.

  Default: `3 days`

- `working-directory` (string, optional)

  Root for file selection, relative to the checkout.  It must remain inside the checkout.  Symlinked lockfiles and lockfile directories are rejected.

  Default: `.` (the repository root)

## Outputs

- `pull-request-number`
- `pull-request-url`

  Number and URL of the maintenance PR.  Empty when no PR exists or PR creation is disabled.

- `changed`

  `true` if any selected lockfile changed, otherwise `false`.

- `lockfiles`

  JSON array of selected lockfile paths, relative to the checkout.

- `changed-lockfiles`

  JSON array of changed lockfile paths, relative to the checkout.

## Pull request behavior

The PR body and Actions job summary include a version-change table for each changed lockfile.  Each row shows a package's locked versions before and after the update, including transitive dependencies.  Multiple versions are grouped under the package name; `—` marks additions or removals.  Packages without a declared version are omitted.  Metadata-only or source-only changes are identified when no package versions changed.  Very large reports are truncated with a notice to stay within the PR body limit.

The Change column distinguishes `major`, `minor`, and `patch` changes, and marks downgrades, prereleases, additions, and removals.  One- and two-component numeric versions are padded with zeroes for comparison.  Non-SemVer versions are marked `other`; changes involving several removed and added versions are marked `multiple` rather than guessing version pairs.

The Action automatically checks out `base` when `GITHUB_WORKSPACE` has no `.git` entry.  Existing checkouts, including Git worktrees, are preserved.  To customize checkout options or install tools using repository files, run `actions/checkout` explicitly first.  Install the required package managers before running the Action.  PR creation requires a clean tracked working tree and index, so unrelated staged or modified files cannot enter the maintenance commit.  Files generated by package managers are excluded from the PR unless they are selected, Git-tracked lockfiles.

If no changes are needed, no new PR is created.  The PR integration also closes an existing maintenance PR when its changes are no longer needed, and deletes its branch when appropriate.  Reserve the configured branch for this Action.

The PR integration cannot accept commas or newlines in selected file paths.  For these paths, or for a custom test/commit/PR workflow, disable PR creation:

``` yaml
- uses: knu/lockfile-maintenance-action@v1
  with:
    create-pull-request: false
```

A PR creation failure fails the Action; the file-update rollback applies to dependency-update failures, not to a later push or API failure.

## OIDC authentication

Install the [Lockfile Maintenance App](https://github.com/apps/lockfile-maintenance) and select the repositories to maintain.  No registration with the broker operator is needed.  Add `.github/workflows/lockfile-maintenance.yml` to the repository's default branch and enable `auth: oidc` with `id-token: write`:

``` yaml
name: Lockfile maintenance

on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * 5"

permissions:
  contents: read
  id-token: write

jobs:
  maintain:
    runs-on: ubuntu-latest
    steps:
      - uses: knu/lockfile-maintenance-action@v1
        with:
          auth: oidc
          files: /Cargo.lock
          minimum-release-age: 3 days
```

Only `schedule` and `workflow_dispatch` runs of this workflow on the current default branch and GitHub-hosted runners are accepted.  For manual runs, select the default branch.  The workflow must use GitHub's default branch-based OIDC subject; jobs with an environment or a customized OIDC subject are not supported.

The broker checks the App installation and the repository's current ID, owner, and default branch on each exchange.  Removing the repository from the installation, uninstalling the App, or suspending it prevents new tokens from being issued.  Limits apply independently to each repository: three exchanges per run attempt, ten per hour, and thirty per day.  Failed exchanges after identity verification also count toward these limits.

The fixed broker endpoint is `https://lockfile-maintenance-auth.idaemons.org/token`.  GitHub remains the identity provider; the broker validates the signed identity and returns an installation token restricted to the calling repository, with contents and pull requests write permissions.  No App private key or `token:` input is needed in the consuming repository.  The Action masks issued tokens and attempts to revoke the installation token on both success and failure.  A terminated runner may leave it valid until its GitHub expiry (normally one hour).

OIDC identifies the workflow, not this composite Action or its version.  Treat the authorized workflow and its repository configuration as trusted code.  The installation token grants repository write access; GitHub does not restrict it to lockfiles.

## Release-age behavior

The age setting uses each tool's native policy, including its package and source exceptions.  It is not a universal timestamp check: Git dependencies and Cargo/Bundler registry entries without publish timestamps are not covered.  Named Cargo registries and uv package/index settings can override the general age policy.  Bundler may retain already locked young gems, while Cargo may downgrade them.

Matching no supported lockfiles, missing manifests, and unsupported tool versions are errors.  If an update fails or changes a protected manifest, configuration, or unselected lockfile, the Action attempts to restore the original files.  Package-manager caches and other generated files are not rolled back.

Run this Action against trusted project configuration.  Gemfiles, Yarn plugins, and uv workspace metadata can execute code even when install scripts are disabled.

## Author

Copyright (c) 2026 Akinori MUSHA.

Licensed under the MIT license.  See `LICENSE` for details.

Visit the [GitHub Repository](https://github.com/knu/lockfile-maintenance-action) for the latest information.
