# VOKO E2EE security model

Status: **production for explicitly enabled browser-visitor ↔ local-Agent private conversations**. Groups, A2A, REST/Webhook, MCP/CLI, email, and payment flows are outside this claim and continue to use their documented TLS transport.

[Visitor private-chat guide](e2ee-private-chat.md) · [Privacy](../PRIVACY.md) · [Resource and test evidence](e2ee-resource-budget.md) · [External review guide](e2ee-audit-guide.md)

## Security claim

The production Web path provides `e2ee_tofu` for a conversation after the visitor explicitly establishes it:

| Level | Meaning |
| --- | --- |
| `transport_only` | TLS protects a hop; relay services may read content. This is the default for ordinary conversations and non-E2EE protocols. |
| `e2ee_tofu` | After first-contact credentials are accepted, AgentDID, WuKongIM, and OSS relay ciphertext. A later identity or key-state failure locks the conversation instead of downgrading it. |
| `e2ee_verified` | Endpoint fingerprints were verified out of band. Not claimed by the ordinary Web flow. |
| `e2ee_transparent` | Independently distributed client verification and independent Witnesses protect first contact. Research exists, but this is not a production claim. |

The initially delivered Web application remains in the trust boundary. CSP, fixed WASM assets, release manifests, and dependency controls reduce supply-chain and XSS risk, but a malicious origin capable of replacing the entire client is not defeated by TOFU alone.

## Current product scope

Production E2EE is conversation-scoped and opt-in. A capable new private conversation starts as plaintext over TLS and exposes a gray key. Establishment shows an amber key and blocks input. Success changes it to green. A first establishment failure returns to plaintext; a conversation that has ever become active cannot silently fall back.

The supported production data path is:

```text
Browser visitor
  ⇄ voko.e2ee/1 ciphertext
AgentDID / WuKongIM / private OSS relay
  ⇄ voko.e2ee/1 ciphertext
local VOKO Lite
  ⇄ local plaintext execution
selected Provider
```

Text and supported private-chat attachments are encrypted before leaving the browser. The relay sees routing metadata and ciphertext. Lite decrypts locally, applies VOKO safety policy, persists the trusted local plaintext through the ordinary conversation path, and sends it to the selected Provider. The Provider reply is encrypted by Lite before it returns through the relay.

The local VOKO database, local Web UI, Lite process, and selected Provider are plaintext endpoints. A cloud-backed Provider can read content sent to it. E2EE is transport-and-relay content protection, not protection against endpoint compromise or an authorized Provider.

## Identity and cryptographic state

- DID credentials authenticate Agent identity and authorization; they are not reused as message-encryption keys.
- Each browser profile has a persistent device credential protected by non-extractable WebCrypto material.
- Lite protects its device and group state with the platform credential store and a separate E2EE database.
- Every private conversation is a distinct MLS group; each attachment uses a distinct file key and nonce domain.
- One-time, short-lived KeyPackages are bound to the target Agent, device, key epoch, and intended establishment. Reuse conflicts.
- AgentDID stores public credentials, authorization, revocation information, establishment state, and ciphertext only. It does not receive endpoint private keys or decrypted messages.

## Authenticated routing

Outer IM routing is not a cryptographic security boundary. Authenticated data binds at least the protocol version, content type, group ID, MLS epoch, target Agent DID, conversation scope, sender device key ID, message ID, and channel type. Lite compares authenticated values with the trusted route before accepting plaintext.

Malformed, oversized, replayed, cross-Agent, cross-conversation, wrong-epoch, or identity-mismatched envelopes are rejected before the ordinary visitor path. `contentType=13` is never reinterpreted as an ordinary text message.

## State, atomicity, and recovery

The product modes are:

```text
plaintext → e2ee_available → e2ee_active
                                  ↘ locked
```

- Establishment and message processing use a single writer per group.
- Sending persists the advanced MLS state, fixed ciphertext, message ID, and Outbox before network transmission.
- A retry resends the same ciphertext; it does not re-encrypt with the same generation.
- Receiving commits post-decryption state, replay marker, and local delivery state before Provider dispatch.
- Provider acceptance followed by an unknown result is not executed again automatically.
- Missing key material, identity change, rollback, epoch mismatch, or decryption failure locks an active conversation.
- A locked conversation shows a red key and requires explicit rebuild. Rebuild creates a new security boundary; it cannot decrypt historical ciphertext whose keys are gone.

## Attachments

Private-chat attachments are encrypted locally in authenticated chunks before private-object upload. The encrypted manifest is carried inside the MLS application message. The receiver verifies file identity, chunk order/count, size, hash, epoch, and authenticated metadata before exposing plaintext locally.

Object storage must not receive plaintext file names, plaintext MIME metadata, file keys, local paths, or long-lived client OSS credentials as part of the E2EE object. Temporary upload authorization is scoped to server-selected object keys and ownership.

## Metadata and explicit exclusions

E2EE does not hide participant and routing identifiers, timing, online state, ciphertext size, device/key identifiers, delivery state, or the fact that a conversation uses E2EE. Rate limits, membership, publication state, blocklists, and task ownership remain server-enforced metadata policies.

The following are **not** covered by the production visitor-private-chat E2EE claim:

- group chat;
- ordinary A2A 1.0 Tasks and Artifacts;
- External REST/Webhook Gateway requests and callbacks;
- MCP, CLI, and the local management Web UI;
- owner intervention, email, payment, reporting, and other side channels;
- plaintext that a user explicitly exports or includes in a report;
- endpoint compromise, malicious browser code, keyloggers, or a compromised Provider.

Ordinary A2A and External Gateway traffic uses HTTPS/TLS and source-specific authorization. Experimental A2A E2EE contracts or group-MLS tests in this repository are not production capabilities and must not appear in Agent Cards or public capability claims.

## Operations and review

- Production and internal Canary modes cannot run simultaneously.
- Disabling the feature stops new establishment; active conversations lock rather than silently becoming plaintext.
- Logs and diagnostics may contain only redacted stage, error code, and short opaque identifiers—never plaintext, private keys, full ciphertext, KeyPackage private material, or native Provider Session IDs.
- Internal test reports and the historical Canary guide are engineering evidence, not proof of independent external audit.
- `e2ee/release-gates.json` and the commands documented in [testing.md](testing.md) record reproducible protocol, browser, platform, recovery, and stability gates. The repository does not claim that an external audit or independent Witness deployment has completed unless an external report says so.
