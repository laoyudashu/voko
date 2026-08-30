# VOKO E2EE security model

Status: `voko.e2ee/2` protects supported visitor ↔ local-Agent and VOKO Agent ↔ Agent private IM. Web UI, CLI, MCP, Provider replies, and private system notifications share the same outbound policy. Groups, A2A, REST/Webhook, and email remain outside this claim and use their documented TLS transport.

[Visitor private-chat guide](e2ee-private-chat.md) · [Privacy](../PRIVACY.md) · [Testing](testing.md)

## Security claim

The browser and Lite are plaintext endpoints. AgentDID, WuKongIM, and private object storage relay ciphertext. The initially delivered Web application remains in the trust boundary; E2EE does not protect against a compromised endpoint, malicious page code, keylogger, or authorized Provider.

The data path is:

```text
browser visitor or VOKO Agent
  ⇄ voko.e2ee/2 signed HPKE envelopes
AgentDID / WuKongIM / private OSS relay
  ⇄ voko.e2ee/2 signed HPKE envelopes
local VOKO Lite
  ⇄ local plaintext execution
selected Provider
```

## Cryptographic construction

- HPKE Base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, and ChaCha20Poly1305 protects each message independently.
- Ed25519 signs a domain-separated, length-prefixed canonical header together with the HPKE encapsulated key and ciphertext.
- Every browser device and Agent scope has a distinct X25519/Ed25519 key bundle. Agent DID signing keys are not reused as message-encryption keys. One business message is sealed separately for every active recipient device.
- Private keys remain at the endpoint. AgentDID stores authenticated public bundles and routing metadata.
- Attachments use a fresh AES-256-GCM content key, authenticated chunk indexes, and a SHA-256 plaintext digest; the manifest and content key are inside HPKE ciphertext.

Independent per-message encryption removes shared ratchet, MLS group, epoch, KeyPackage, Commit, Welcome, establishment polling, and cross-process native endpoint state from the private-chat protocol.

## Authenticated routing and replay handling

The signed and authenticated envelope binds the protocol/suite, message and conversation IDs, channel, Agent DID, sender and recipient device/key IDs, content kind, and creation time. Lite compares these fields with the trusted IM route before exposing plaintext.

Malformed, oversized, replayed, cross-Agent, cross-conversation, wrong-recipient, unknown-key, or signature-invalid envelopes are rejected before ordinary visitor processing. Receipt and reply IDs are durable and deterministic, so retransmission reuses the same logical message and cannot dispatch the Provider twice merely because an acknowledgement was lost.

## Persistence and recovery

- Browser and Lite device private keys are persisted locally and are not rotated on page refresh or ordinary process restart.
- Lite persists the received envelope and receipt before Provider execution.
- Decrypted messages enter the ordinary local conversation store, so local history and Web UI use the same plaintext projection as non-E2EE messages.
- Provider acceptance followed by an unknown outcome is not automatically executed again.
- A reply envelope is persisted before transport and resent with the same message ID if delivery acknowledgement is lost.
- Provider Turn coalescing occurs only after each envelope has been authenticated, decrypted, acknowledged and deduplicated. Turn IDs are in-memory execution correlation and do not replace per-message persistence or receipt semantics.
- Recipient capabilities, encrypted outbox state, and Conversation security mode live in the independent E2EE database; the main VOKO schema is unchanged.
- Once a Conversation has become E2EE-active, an unavailable Directory, revoked key, or changed peer identity locks it instead of silently falling back to plaintext.
- Loss of an endpoint private key makes old ciphertext unavailable. The new key applies only to later messages; there is no v1 migration or silent historical recovery claim.

## Metadata and exclusions

E2EE does not hide participant/routing identifiers, timing, online state, ciphertext size, device/key identifiers, delivery state, or the fact that E2EE is used. Server-side publication, blocklist, rate-limit, ownership, and authorization policies still operate on trusted metadata.

This claim excludes group chat, A2A Tasks/Artifacts, External REST/Webhook traffic, owner actions, email, exports, reports, and plaintext passed to the selected Provider. MCP and CLI are local control planes rather than encrypted transports; eligible private IM messages initiated through them are covered after they enter the secure outbound router. Excluded paths must not advertise `voko.e2ee/2` unless a separate protocol is implemented and reviewed.

Logs and diagnostics may contain only redacted stages, error codes, and short opaque identifiers—never plaintext, private keys, full ciphertext, attachment CEKs, or native Provider Session IDs.
