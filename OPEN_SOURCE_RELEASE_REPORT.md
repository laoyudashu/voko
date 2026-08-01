# VOKO v0.4.0 Open-Source Release Report

Date: 2026-07-30
Scope: VOKO Lite and MCP only
Candidate directory: repository root
License: Apache-2.0
Copyright holder: Hong Kong Leung Pin Ho On Technology Limited

This is an engineering release review, not a legal opinion or a guarantee that no third party will assert a claim.

## Decision

**Technical build status: PASS.**

**Public release status: NO-GO until the remaining P0 owner actions below are completed.**

The candidate is isolated from the Desktop repository and has a new local Git history with no inherited Desktop commits. At the time of this review, no public GitHub remote was configured and no code had been pushed to GitHub.

## What was changed

- Promoted Lite/MCP to the repository root.
- Set npm and planned GitHub release version to `0.4.0`.
- Added Apache-2.0 `LICENSE`, `NOTICE`, trademark, security, privacy, cloud dependency, contribution, and release checklist documents.
- Removed Desktop build, installer, release dashboard, changelog upload, arbitrary release-file upload, and Electron runtime dependencies.
- Removed obsolete Desktop MCP test documents and the dead release i18n namespace.
- Changed invitation download links from a Windows Desktop installer to the `@voko/lite` npm page.
- Removed `javascript-obfuscator`; this eliminated four high-severity development dependency findings and makes published code easier to audit.
- Added GitHub CI, CodeQL, Dependabot, issue templates, pull-request template, and `CODEOWNERS`.
- Added an isolated standalone smoke test.
- Changed Windows Goose execution to spawn `goose.exe` directly and pass visitor messages/context through stdin.
- Changed short-link creation from client HMAC credentials to the current owner's User Access Token; the server now derives the target from the owned Agent identity.

## Verification evidence

| Check | Result |
| --- | --- |
| TypeScript build | PASS |
| Node test suite | PASS — 178/178 |
| Group MCP tests | PASS — 21/21 |
| i18n zh/en alignment | PASS — missing 0, mismatch 0 |
| Standalone health check | PASS |
| MCP `tools/list` smoke | PASS — 53 tools, including `voko_get_status` |
| Package secret scanner | PASS — 152 files, 0 findings |
| Gitleaks 8.30.1 directory scan | PASS — 0 findings |
| npm audit, full dependency tree | PASS — 0 vulnerabilities |
| npm package dry run | PASS — 148 entries, 500,811-byte archive; no repository scripts included |
| Package contents | PASS — no `.env`, `.npmrc`, database, Desktop installer, or Git history |
| Lock-file license inventory | PASS — no unknown or strong-copyleft package license |
| SBOM generation | PASS — CycloneDX 1.5, 138 components |

Dependency licenses observed in the lock file: Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, and MIT-0.

## P0 — owner actions that still block publication

1. **Credentials:** revoke and rotate every historical npm token, VOKO API key/secret, OSS key, database credential, signing credential, and test credential. The clean history prevents old commits from being published, but it cannot invalidate credentials that may still be live.
2. **Account security:** enable 2FA on GitHub and npm before creating the public repository or publishing `@voko/lite`.
3. **Cloud terms:** approve public service terms and privacy terms for VOKO registration, messaging, update, and payment services. The repository is not fully self-hosted.
4. **Payment/data review:** decide whether payment will be disabled by default for `v0.4.0`, or complete a jurisdiction-specific privacy/security review covering identity and bank-card data, encryption, access control, retention/deletion, breach response, and cross-border transfers.
5. **Update trust:** add an independently verifiable signature for OSS update manifests/packages, or disable OSS automatic updates for the first public release. A SHA-512 value hosted beside the archive detects corruption but does not independently authenticate the publisher.
6. **Source provenance:** manually review code whose origin was marked uncertain. Gitleaks and dependency-license checks passed, but ScanCode/ORT source provenance analysis and human author/origin sign-off are still required.
7. **Package ownership:** confirm access to the existing `@voko/lite` npm package and rotate its npm token before publishing `0.4.0`.

## P1 — complete before tagging v0.4.0

- Run ScanCode Toolkit against `src`, `scripts`, `test`, and documentation; resolve every unknown copyright/license result.
- Run ORT or an equivalent policy evaluator against `package-lock.json`.
- Review `THIRD-PARTY-NOTICE.md` against the final SBOM and retain dependency notices required in redistribution.
- Confirm all GitHub Actions pass on both Ubuntu and Windows.
- Configure `main` branch protection, required checks, secret scanning, push protection, Dependabot, private vulnerability reporting, and signed releases.
- Confirm the repository description and topics include `agent-communication`, `ai-agent`, `intelligent-agent`, `multi-agent`, `mcp`, `智能体`, and `智能体通信`.

## P2 — after the first release

- Configure a one-way Gitee mirror from the GitHub primary repository.
- Publish architecture, cloud API boundary, privacy, and operator hardening documentation.
- Add signed checksums/provenance for npm and any separately hosted artifacts.
- Define and publish a vulnerability response SLA and version support policy.

## Clean-history publication sequence

1. Complete every P0 item above.
2. Copy or retain only this candidate directory; delete ignored `node_modules`, `build`, and local `audit-results` if a minimal source checkout is desired.
3. Run `npm ci`, `npm run release:gate`, `npm run smoke:standalone`, `npm run sbom`, and `npm pack --dry-run`.
4. Initialize a new Git repository with default branch `main`.
5. Inspect the staged file list and run Gitleaks against the exact staged source.
6. Create one signed initial commit.
7. Create the private GitHub repository, apply security settings and branch protection, then push.
8. Let CI pass before changing repository visibility to public.
9. Publish npm with 2FA/provenance enabled.
10. Publish the matching signed OSS update manifest/package, then run `npm run verify:published-release`.
11. Create a signed `v0.4.0` tag and GitHub release, then enable the Gitee mirror.
