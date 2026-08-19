# VOKO E2EE internal security pre-audit report

Date: 2026-08-19

## Executive conclusion

**Review completion: complete.**

**Security disposition after remediation: PASS - PRODUCTION GATES REMAIN OPEN.**

The reviewed E2EE implementation passed its protocol, fail-closed, persistence,
browser, macOS Keychain, fault-injection, attachment, scale and secret-leakage
checks. The initial review found four High and two Medium Rust dependency
advisories in the HPKE/OpenMLS graph. Remediation upgraded the graph to OpenMLS
`0.9.0-rc.2`, OpenMLS RustCrypto `0.6.0-rc.2`, HPKE `0.7.0` and fixed libcrux
versions. RustSec now reports zero vulnerabilities, strict Clippy is clean, and
the complete affected regression matrix passes.

This internal report does not satisfy `external_security_audit`, does not prove
independent Witness operation, does not convert the deferred four-hour test
into a pass, and does not permit `productionEnabled=true`.

## Review baseline

| Field | Value |
| --- | --- |
| Git commit | `6f0e51388d863f0379983107bc1afde885cbeefc` |
| Audit manifest | `e2ee-audit-bundle.json` |
| Manifest state at generation | clean (`dirty=false`) |
| Files in manifest | 76 |
| Security claim | `experimental_e2ee_tofu` |
| Production enabled | `false` |
| Rust | `1.97.1` |
| OpenMLS | `0.8.1` |
| OpenMLS RustCrypto | `0.5.1` |

The manifest hashes are the source inventory for this report. Generated build,
CodeQL and local evidence directories are supporting artifacts rather than part
of the reviewed source inventory.

## Scope and method

The review covered credential and Agent DID binding, one-time KeyPackages, MLS
establishment ordering, canonical authenticated routing, replay and reordering,
single-writer state, fixed-ciphertext retries, persistence and rollback anchors,
recovery and device revocation, PCS updates, attachment encryption, browser
WASM state, client integrity controls, Witness split-view handling, dependency
risk and plaintext/secret leakage.

The following remain outside the production E2EE claim:

- Active production VOKO message path.
- Ordinary A2A mailbox.
- Owner-intervention email plaintext.
- Unverified cloud Provider endpoints.
- Endpoint compromise or malicious replacement of the initially trusted web client.

The method combined source-invariant review, executable adversarial scenarios,
platform lifecycle tests, resource gates, dependency advisories, secret-history
scanning and CodeQL security-extended analysis.

## Findings

### E2EE-INT-001: vulnerable HPKE/libcrux dependency graph

Severity: **High**

Status: **Closed**

Affected dependency path:

`voko-e2ee-core -> openmls_rust_crypto 0.5.1 -> hpke-rs 0.6.1 -> libcrux`

| Advisory | Package | Version | Severity | Required fix |
| --- | --- | ---: | --- | --- |
| `RUSTSEC-2026-0124` | `libcrux-chacha20poly1305` | `0.0.7` | High 8.2 | Upgrade to `>=0.0.8` |
| `RUSTSEC-2026-0212` | `libcrux-secrets` | `0.0.5` | High 8.2 | Upgrade to `>=0.0.6` |
| `RUSTSEC-2026-0207` | `libcrux-sha3` | `0.0.8` | High 8.2 | Upgrade to `>=0.0.10` |
| `RUSTSEC-2026-0208` | `libcrux-sha3` | `0.0.8` | High 8.2 | Upgrade to `>=0.0.10` |

Impact includes a potential panic on overlong ciphertext, incorrect constant-time
selection on AArch64, incorrect SHAKE output and an AVX2 SHAKE panic. The
AArch64 advisory is directly relevant to this Apple Silicon macOS target.

Attempted lockfile-only updates were rejected by Cargo because `hpke-rs 0.6.1`
requires `libcrux-sha3 ^0.0.8`, and the relevant `libcrux-aead` graph pins
`libcrux-secrets =0.0.5` and `libcrux-chacha20poly1305 =0.0.7`. No compatible
package was silently substituted.

Completed remediation:

1. Upgraded OpenMLS to `0.9.0-rc.2`, OpenMLS RustCrypto, traits and Basic
   Credential to `0.6.0-rc.2`, HPKE to `0.7.0`, and TLS Codec to `0.5.0`.
2. Removed the vulnerable libcrux versions without suppressing RustSec advisories.
3. Re-ran core, WASM, browser, cross-process, platform, fault, stress and scale gates.
4. Confirmed `cargo audit --file e2ee/Cargo.lock` reports zero vulnerabilities.

### E2EE-INT-002: medium libcrux AES-GCM advisories

Severity: **Medium**

Status: **Closed with E2EE-INT-001**

| Advisory | Package | Version | Severity | Summary |
| --- | --- | ---: | --- | --- |
| `RUSTSEC-2026-0209` | `libcrux-aesgcm` | `0.0.7` | Medium 6.3 | AAD length limits not enforced |
| `RUSTSEC-2026-0211` | `libcrux-aesgcm` | `0.0.7` | Medium 6.3 | Non-constant-time authentication-tag check |

The OpenMLS/HPKE migration removed `libcrux-aesgcm 0.0.7` and replaced the old
libcrux graph. RustSec no longer reports either advisory.

### E2EE-INT-003: strict Clippy gate is not clean

Severity: **Low**

Status: **Closed**

`cargo clippy --all-targets -- -D warnings` reported five findings:

- `BoundedSecretCache` exposes `len` without `is_empty`.
- `TransparencyLog::new` has no `Default` implementation.
- `TransparencyWitness::new` has no `Default` implementation.
- Two modulo checks can use `is_multiple_of`.

The cache now exposes `is_empty`, transparency types implement `Default`, and
the integer checks use `is_multiple_of`. Strict Clippy now passes with
`-D warnings` across all targets.

### E2EE-INT-004: production assurance gates remain open

Severity: **Release policy**

Status: **Open**

- `stability_4h` is `pending_local`. Owner risk acceptance is recorded, but no
  passing four-hour summary exists.
- `independent_witnesses` is `pending_external`. Two local OS processes used
  separate keys and rejected a fork, but they do not provide organizational or
  infrastructure independence.
- `external_security_audit` is `pending_external`. This internal review must not
  be used to mark it passed.

## Control-by-control result

| Control | Result | Evidence |
| --- | --- | --- |
| Credential and Agent DID binding | Pass | Cross-agent binding rejection and persisted credential-pin tests |
| KeyPackage authorization, expiry and single use | Pass | Single-use, cross-group replay rejection and bounded replenishment tests |
| Commit/Welcome/ack establishment ordering | Pass | Lifecycle and independent-endpoint integration tests |
| Bidirectional MLS messages | Pass | Core and cross-process canaries |
| Canonical AAD and route tamper rejection | Pass | AAD, envelope and fake-relay mutation tests |
| Replay and duplicate rejection | Pass | Core MLS, Fake IM and canary tests |
| Reordered delivery | Pass | Fake IM and macOS fault-injection tests |
| No plaintext downgrade | Pass | Rollout policy, relay and canary assertions |
| Atomic state plus fixed-ciphertext Outbox | Pass | Persistence, restart and lost-ack tests |
| Rollback-anchor enforcement | Pass | Persistence tests and macOS fault injection |
| Database upgrade/rollback drill | Pass | Temporary-copy rollback contract; source backup unchanged |
| macOS Keychain lifecycle | Pass | Provision, reopen, decrypt, revoke and reopen-denied platform gate |
| Recovery and replacement-device boundary | Pass | Read-only recovery and successor-epoch tests |
| Multi-device add/remove and revocation | Pass | Real MLS Add/Remove integration test |
| PCS update and crash recovery | Pass | Pending-commit recovery and replay-safe update tests |
| Attachment chunk AEAD | Pass | 1 MiB chunks, 25 MiB bound, corruption/missing chunk/retry tests |
| Fake OSS fault behavior | Pass | HTTP 500, timeout, restart, reverse order, missing chunk and corruption |
| Browser WASM | Pass | Round trip, digest validation and constrained Pixel 5 emulation |
| Browser persistence | Pass | IndexedDB atomic commit, abort rollback and reload recovery |
| Browser single writer | Pass | Web Locks two-tab test |
| Browser CSP and Trusted Types | Pass | Browser security gate |
| Witness append-only and split-view rejection | Pass locally | Two independent local processes and signatures; not production independence |
| 100,000-message stress | Pass | Release-mode stress gate |
| 10,000 persisted groups | Pass | Fixed active-cache scale gate |
| 30-minute macOS stability | Pass from release record | 598,755 messages, zero loss/duplicates/crossed sessions |
| Four-hour stability | Not passed | Owner waiver only |
| JavaScript/npm dependency audit | Pass | `npm audit --omit=dev`: zero vulnerabilities |
| Rust dependency audit | Pass after remediation | Zero vulnerabilities; one unmaintained-package warning |
| Repository secret history | Pass | Gitleaks scanned 383 commits, no leaks |
| Package secret scan | Pass | 322 packaged files scanned |
| JavaScript/TypeScript CodeQL | Pass with reviewed allowlist | 287/287 JS/TS files and 3/3 workflows extracted |

## CodeQL review

The security-extended suite produced 88 raw results. Fifteen had a security score
of 7 or greater. All fifteen matched the repository's exact rule, file and
fingerprint allowlist entries; the gate would fail on a stale or unmatched
fingerprint. The accepted groups are:

- Four path-injection flows in `src/core/agent-files.js`, where canonicalized
  workspace boundaries and symlink rejection are covered by regression tests.
- One remote-property flow in the i18n cookie parser, which rejects prototype
  keys and uses a null-prototype container.
- Ten user-controlled-condition flows in registration, local-host validation
  and OpenClaw challenge dispatch, where the condition selects protocol state
  and does not replace authoritative credential, OTP, host or signature checks.

The remaining 73 results have scores from 6.1 to 6.5 and concern log injection,
file/network data flow, prototype-property flow and HTTP/file flow. They are not
specific evidence of an E2EE cryptographic failure. They remain available in
the SARIF for broader application-security hardening.

## Executed evidence

The following commands were executed during this review:

```text
cargo test --locked --manifest-path e2ee/Cargo.toml
npm run test:e2ee:poc
npm run test:e2ee:fake-im
npm run test:e2ee:relay
npm run test:e2ee:cross-process
npm run test:e2ee:witness-processes
npm run test:e2ee:browser
npm run test:e2ee:attachment:fake
npm run test:e2ee:macos-faults
npm run test:e2ee:platform
node --test test/e2ee-database-rollback-drill.test.js
npm run test:e2ee:stress
npm run test:e2ee:scale
npm run scan:package-secrets
npm run security:gitleaks
npm run security:codeql
npm audit --omit=dev --audit-level=high
cargo audit --file e2ee/Cargo.lock
cargo clippy --locked --manifest-path e2ee/Cargo.toml --all-targets -- -D warnings
npm run test:e2ee:readiness
```

Supporting local evidence:

- `.audit-evidence/internal-preaudit-tests.log`
- `.audit-evidence/internal-preaudit-extended.log`
- `.audit-evidence/internal-preaudit-static.log`
- `.audit-evidence/internal-preaudit-rust.log`
- `.audit-evidence/clippy.log`
- `.audit-evidence/codeql-findings.json`
- `.codeql-results/javascript-typescript.sarif`
- `e2ee-platform-summary.json`
- `e2ee-macos-fault-summary.json`

## Approval criteria after remediation

The technical remediation satisfies items 1 through 3 below. Items 4 through 6
remain release-process conditions for a newly frozen commit:

1. `cargo audit --file e2ee/Cargo.lock` reports no vulnerabilities.
2. The OpenMLS/HPKE dependency change has passed the complete control matrix above.
3. Strict Clippy is clean or each remaining warning has a documented, narrow rationale.
4. A new audit manifest is generated from a clean worktree.
5. The four-hour stability gate is either passed or remains explicitly marked as
   a rollout blocker; a waiver must not be represented as technical evidence.
6. `productionEnabled` remains false until every production gate is actually passed.

## Final statement

The internal pre-audit and dependency remediation are complete. No demonstrated
protocol-state, plaintext-downgrade, macOS Keychain, persistence, attachment,
browser or Witness PoC failure remains in the executed matrix, and the six
RustSec vulnerabilities are closed. Internal technical pre-audit passes.
Production promotion remains forbidden until the separate four-hour stability,
independent Witness and external audit gates are resolved under release policy.
