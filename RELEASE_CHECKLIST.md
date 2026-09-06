# Public Release Checklist

Use this checklist for each release. The original first-publication assessment
is preserved in [OPEN_SOURCE_RELEASE_REPORT.md](OPEN_SOURCE_RELEASE_REPORT.md);
it is historical evidence, not the current package's publication status.

## Version pull request

- [ ] Update `package.json`, both root version fields in `package-lock.json`, the
  Chinese/English README badges, `CHANGELOG.md`, and versioned release notes.
- [ ] Describe compatibility limits and distinguish model execution from IM delivery.
- [ ] Run `npm ci`, `npm run release:gate`, `npm run test:e2e`, and
  `npm run security:local`; review the exact package contents and secret scan.
- [ ] Wait for PR checks, including three-platform Node 22 tests, Chromium,
  security/dependency checks, Rust E2EE, and CodeQL. Review the complete diff.
- [ ] Confirm no credentials, personal data, or generated local artifacts are included.

Do not run `release:preflight` on a release branch: its state guard intentionally
requires synchronized `main`. Preparation does not publish a package or Release.

## Merged main and publication

- [ ] Merge the reviewed PR and wait for the Node 22/24 three-platform main
  matrix, browser matrix, security checks/SBOM, Rust E2EE, and CodeQL.
- [ ] Synchronize local `main` with `github/main`, then run `npm ci` and
  `npm run release:preflight` against the intended commit.
- [ ] Verify package ownership, npm Trusted Publisher configuration, GitHub/npm
  account protection, and the protected `npm-production` environment.
- [ ] Resolve any new credential exposure or license/provenance issue. Historical
  legal/security attestations are owner-maintained and are not certified by CI.
- [ ] Dispatch **Publish npm** from `main` with the exact version. For a stable
  release explicitly set `prerelease=false` (the workflow defaults to true).
- [ ] Review the preparation gate and immutable tarball before approving
  `npm-production`. Publish only through OIDC; never from a workstation.
- [ ] Allow the workflow to create the tag and GitHub Release only after npm
  verification succeeds. Do not pre-create either: existing names are rejected.

## Post-publication verification

- [ ] Run `npm run verify:published-release` on the published source checkout.
- [ ] Verify npm version/provenance, Git tag target, and GitHub Release against
  the workflow commit; record their URLs, SHA, and gate results.
- [ ] Add the reviewed versioned release notes to the generated GitHub Release
  body and update the checked-in release status/date through a documentation PR.
- [ ] Confirm update discovery reports the published version.

## Repository controls

- [ ] `main` requires pull requests, `ci-gate`, and CodeQL `analyze`; force pushes
  and branch deletion are disabled.
- [ ] Secret scanning/push protection, Dependabot, dependency review, and private
  vulnerability reporting are configured for the repository's available features.

See [.github/RELEASING.md](.github/RELEASING.md) for workflow ownership and permissions.
