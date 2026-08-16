# VOKO E2EE security model

Status: experimental. No production message path currently claims E2EE.

## Security levels

| Level | Meaning |
| --- | --- |
| `transport_only` | TLS protects the network hop. VOKO services may read content. |
| `e2ee_tofu` | After the first fingerprint is pinned, relay services cannot decrypt and later key changes fail closed. The initially delivered web client and fingerprint must be trusted. |
| `e2ee_verified` | Both endpoint fingerprints were verified out of band. |
| `e2ee_transparent` | Verified client distribution, key transparency and an independent witness protect first contact. |

The Web MVP may only claim `e2ee_tofu`. CSP and asset hashes reduce XSS and supply-chain risk, but cannot protect against a server that replaces both HTML and JavaScript. `e2ee_transparent` therefore requires an independently verifiable client.

The browser PoC is served with `default-src 'none'`, same-origin-only scripts and connections, WebAssembly-only `wasm-unsafe-eval`, Trusted Types enforcement, no objects, no framing and no referrer. JavaScript `unsafe-eval` remains forbidden. It verifies the generated WASM SHA-256 digest before instantiation. The digest manifest is served by the same test origin, so this is an integrity and regression gate, not protection from an actively malicious origin.

## Trust and identity

- DID keys authenticate identities and delegation. They are not message-encryption keys.
- Each `userUid + deviceId + keyEpoch` owns one `OwnerDeviceCredential`. Agents owned by that user may share the device credential, but authorization to each Agent DID is separate.
- Every browser has a persistent `BrowserDeviceCredential`. Anonymous credentials bind to a guest principal; authenticated credentials bind to the authoritative actor.
- Each conversation is a distinct MLS group. Each attachment receives a distinct file key.
- AgentDID stores public credentials, authorization, revocation epochs and one-time KeyPackages only. Private keys stay at endpoints.
- A KeyPackage is short-lived, Agent-authorized and one-time. Both the directory and the recipient vault record consumption. Reuse for another group fails closed.

## Threat boundaries

E2EE protects content from network observers and from AgentDID, WuKongIM and OSS reading stored or relayed ciphertext. It does not hide routing identifiers, timestamps, ciphertext sizes, online state or group membership. Local VOKO and the selected Agent Provider are intended plaintext endpoints. A cloud Provider can read content sent to it.

Endpoint compromise, malicious browser code, keyloggers and an already-authorized Provider are outside the cryptographic guarantee. The web client must still use strict CSP, Trusted Types, no third-party scripts, locked dependencies and a verified WASM digest.

## Conversation state

The authoritative security state is conversation-scoped:

`legacy_transport -> e2ee_initializing -> e2ee_active`

Exceptional terminal or blocked states are `identity_changed`, `locked` and `revoked`. An `e2ee_active` conversation never accepts plaintext. An old conversation upgrades by creating a new MLS group and a visible security boundary; old content remains labelled non-E2EE.

## Group establishment

The application state machine is:

`CREATED_LOCAL -> KEY_PACKAGE_RESERVED -> ADD_COMMIT_CREATED -> COMMIT_ACCEPTED_BY_DS -> WELCOME_PERSISTED -> RECIPIENT_JOINED -> GROUP_ESTABLISHED -> ACTIVE`.

The creator starts a one-member RFC 9420 group, adds the recipient KeyPackage, persists the pending Commit and Welcome, and merges the pending Commit only after the delivery service accepts it. The recipient stages and persists the Welcome before emitting an authenticated established acknowledgement. Application messages are sent only after that acknowledgement. Duplicate or reordered Commit, Welcome and acknowledgement events are idempotent and never create another group.

## Authenticated routing

Outer routing is not a security boundary. Canonical binary authenticated data uses fixed field order and length-prefixed byte strings and binds protocol version, content type, group ID, epoch, target Agent DID, conversation scope, sender device key ID, message ID and channel type. Stable internal user IDs are replaced by opaque key or principal IDs. The receiver compares every outer field with authenticated data before accepting plaintext.

All envelope fields have explicit size and nesting limits. A parsing, identity, epoch or decryption failure is rejected before the ordinary visitor path; it never falls back to plaintext.

## Atomicity and recovery

Each group has one writer. Sending atomically persists the new MLS state, fixed ciphertext, message ID and outbox record before network transmission. A retry sends the same ciphertext. Receiving atomically persists new state, replay marker and plaintext delivery record before dispatching once to a Provider.

Recovery exports archive decryption material only. It excludes device signing keys, unused KeyPackage private keys, active group write state and sending generations. Restore creates a new device credential and epoch, revokes the old device and keeps old conversations read-only.

The first recovery PoC deliberately exports an encrypted read-only local message archive rather than a live MLS snapshot. Its type exposes historical records and a replacement-device requirement only; it has no encrypt, send, KeyPackage or active-session API. Import requires a successor key epoch and identifies the prior device that must be revoked. This proves the non-cloning boundary but does not yet provide a production device-revocation transaction.

## Existing product boundaries

- Metadata-based sessions, blocklists, membership, rate and size limits remain server-enforced.
- Content safety checks run locally after decryption.
- E2EE plaintext is not silently included in owner-intervention email, telemetry, crash reports or logs.
- User-selected reporting or email forwarding must warn that selected plaintext leaves the E2EE boundary.
- Ordinary A2A remains TLS transport protection. A future `voko.a2a.e2ee/1` is an explicit, non-downgrading extension with its own review.

## Production gate

Production integration is forbidden until the independent PoC proves credentials, one-time KeyPackages, Commit acceptance, Welcome acknowledgement, bidirectional text, restart recovery, duplicate/reordered input, single-writer persistence and the resource budgets in [e2ee-resource-budget.md](e2ee-resource-budget.md).

The isolated PoC now also defines a strict `voko.e2ee/1` wire envelope and exercises it through a ciphertext-only fake relay. The relay test proves that the plaintext canary is absent from the stored envelope, valid ciphertext decrypts at the intended endpoint, and tampering with the authenticated Agent route fails closed. This is a protocol test only: no production Chatroom, WuKongIM, AgentDID or Provider path uses this envelope yet.

The native PoC host now atomically stores an already-encrypted MLS state snapshot with the exact outbound ciphertext in SQLite. Delivery uses a CAS lease, an expired lease can only resend the stored ciphertext, and a successful lease owner marks it sent once. A state anchor is designed to be sealed outside that SQLite file so a restored or replaced database fails closed. The OS keychain wrapper for that external anchor remains a production gate.

An isolated Fake WuKongIM exercises disconnect, authentication rejection, lost acknowledgement, duplicate delivery, reordering and route tampering against real MLS ciphertext. The receive side atomically commits its encrypted post-decryption state and locally encrypted payload before a CAS-leased Provider handoff. Invalid E2EE envelopes are discarded before visitor routing and never downgrade to plaintext. This remains test-only and does not alter the production IM path.

The native PoC has a system credential-store adapter for Windows Credential Manager, macOS Keychain and Linux Secret Service. Owner-scoped Vault master keys and group-scoped monotonic rollback anchors occupy domain-separated, hashed slots; no raw owner or group identifier is used as the credential name. Missing, corrupt, revoked or unavailable system credentials lock E2EE instead of falling back to a file, environment variable or plaintext. Cross-platform compilation is enforced by CI, while real keychain lifecycle tests on each target OS remain a release gate.

Endpoint KeyPackage references are persisted with a maximum 24-hour lifetime and are bound to the target Agent DID, owner device key ID and key epoch. A second group cannot consume the same KeyPackage even if the directory service replays it. Browser and owner-device credential signing keys are TOFU-pinned by identity scope; a key change fails closed as `identity_changed`, an epoch decrease is rejected, and a successor requires an explicit compare-and-swap approval against the prior fingerprint. These controls do not remove TOFU's first-contact limitation.

PCS self-updates are triggered by message count, elapsed time or a security event. A self-update Commit and its pending MLS state are atomically persisted as a distinct Outbox kind; application messages are blocked while it is pending. The sender merges only after Delivery Service acceptance, the recipient validates and merges the exact Commit, and crash recovery can only resend the stored Commit. Duplicate or stale Commits fail without advancing the established epoch. The default PoC policy is 1,000 messages or 24 hours, with immediate updates for credential, device or revocation events.

The browser PoC serializes actual WASM/OpenMLS endpoint state, immediately encrypts it with a non-extractable WebCrypto AES-256-GCM key, and commits encrypted state plus fixed ciphertext in one IndexedDB transaction while holding the group Web Lock. Chromium reload restores that state, decrypts the original ciphertext, continues the message sequence and proves an aborted transaction changes neither record. Storing the CryptoKey in the same browser profile protects casual disk inspection, not same-origin XSS or malicious replacement JavaScript; the `e2ee_tofu` web threat-model limitation remains.
