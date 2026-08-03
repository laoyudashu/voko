# Public Release Checklist

## P0 — release blockers

- [ ] Confirm VOKO cloud service terms and privacy terms for public third-party use.
- [ ] Revoke and rotate every historical npm, API, OSS, database, and signing credential.
- [ ] Enable 2FA for GitHub and npm accounts.
- [ ] Complete source-provenance review and resolve every unknown or incompatible license.
- [ ] Complete payment-data legal/security review or disable payment features by default.
- [ ] Verify independent signatures for OSS update metadata and packages.
- [ ] Confirm control of the `voko` GitHub owner and `@voko/lite` npm package.

## Automated gate

- [ ] `npm ci`
- [ ] `npm run release:preflight` (includes `release:gate` and `npm pack --dry-run`)
- [ ] GitHub Actions security job and Gitleaks scan pass on the exact commit to release.
- [ ] ScanCode license/copyright scan
- [ ] ORT dependency/license evaluation
- [ ] CycloneDX SBOM generation

## Post-publication verification

- [ ] `npm run verify:published-release`
- [ ] Record GitHub Release URL, npm version, commit SHA, and gate results.

## GitHub settings

- [ ] Default branch is `main`.
- [ ] Branch protection requires pull requests and passing checks.
- [ ] Force pushes and branch deletion are disabled for `main`.
- [ ] Secret scanning and push protection are enabled.
- [ ] Dependabot alerts, security updates, and dependency review are enabled.
- [ ] Private vulnerability reporting is enabled.
- [ ] `v0.4.0` tag is signed and release assets have checksums/provenance.
