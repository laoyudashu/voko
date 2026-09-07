# Release workflow

VOKO uses pull requests for code and version changes. Do not commit directly to
`main`, and do not publish npm packages from a developer workstation.

## CI layers

- Pull requests run Node.js 22 on Ubuntu, Windows, and macOS, plus dependency,
  secret, audit, and CodeQL checks.
- Pushes to `main` retain the full Node.js 22 and 24 platform matrix.
- CI and CodeQL also support manual `workflow_dispatch` runs. Select `main`
  to verify the exact release candidate; this does not publish npm.
- Branch protection should require only `ci-gate` and CodeQL `analyze`. The
  aggregate gate remains stable when the internal test matrix changes.

## npm release

1. Create a pull request that updates `package.json` and `package-lock.json` to
   the intended version, update the changelog and bilingual README, and add
   versioned notes under `docs/releases/`. Follow [the checklist](../RELEASE_CHECKLIST.md).
2. Wait for the pull request checks and merge it into `main`.
3. Wait for the full `main` checks, then run the **Publish npm** workflow from
   `main` and enter the exact version. Set `prerelease=false` for a stable release;
   the workflow defaults to a prerelease.
4. Approve the protected `npm-production` environment after reviewing the
   prepared tarball and successful release gate.
5. The workflow verifies the published package, then creates the matching
   `vX.Y.Z` Git tag and GitHub Release at the exact `main` commit. It refuses
   to overwrite an existing tag or release.

The npm package must configure this repository's `release-npm.yml` workflow as
an npm Trusted Publisher. The workflow uses short-lived OIDC credentials and
publishes the exact tarball produced by the preparation job with provenance.
No long-lived npm token is required in GitHub secrets.

The release job uses a separate `contents: write` permission only after the
npm publish job succeeds. The npm production environment approval remains the
manual approval point; the GitHub tag/release creation itself is automated.
