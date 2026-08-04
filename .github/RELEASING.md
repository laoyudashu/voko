# Release workflow

VOKO uses pull requests for code and version changes. Do not commit directly to
`main`, and do not publish npm packages from a developer workstation.

## CI layers

- Pull requests run Node.js 22 on Ubuntu, Windows, and macOS, plus dependency,
  secret, audit, and CodeQL checks.
- Pushes to `main` retain the full Node.js 22 and 24 platform matrix.
- Branch protection should require only `ci-gate` and CodeQL `analyze`. The
  aggregate gate remains stable when the internal test matrix changes.

## npm release

1. Create a pull request that updates `package.json` and `package-lock.json` to
   the intended version.
2. Wait for the pull request checks and merge it into `main`.
3. Run the **Publish npm** workflow from `main` and enter the exact version.
4. Approve the protected `npm-production` environment after reviewing the
   prepared tarball and successful release gate.
5. Verify the published package before creating the matching Git tag and GitHub
   release.

The npm package must configure this repository's `release-npm.yml` workflow as
an npm Trusted Publisher. The workflow uses short-lived OIDC credentials and
publishes the exact tarball produced by the preparation job with provenance.
No long-lived npm token is required in GitHub secrets.
