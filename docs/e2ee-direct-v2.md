# E2EE Direct v2 release contract

Direct v2 is the product/session model for a stable `browser device x Agent` private channel. It deliberately reuses the audited `voko.e2ee/1` WireEnvelope and the existing two-member OpenMLS group. `direct_v2` is therefore not a second cryptographic wire format.

## First release boundary

- Eligible caller: an anonymous Chatroom web session with an authenticated `guest_device_uid`.
- Members: exactly one browser device and one VOKO Lite Agent device.
- VOKO-account multi-device fan-out, WeChat embedded-browser E2EE, and group chat are disabled for this release.
- Legacy MLS sessions remain decryptable from an existing local snapshot. No new device may join a legacy group and no legacy session is silently downgraded to plaintext.
- A Direct channel may be rebuilt explicitly. Activating the replacement supersedes the previous Direct channel for the same authenticated guest device.

## Authenticated routing

Every ciphertext uses canonical AAD containing all of the following fields:

1. protocol version and content type;
2. MLS group ID and epoch;
3. target Agent DID;
4. conversation scope;
5. sender device-key ID;
6. immutable message ID;
7. channel type.

The conversation scope is `direct:<browser-device-key-id>:<server-agent-id>:<agent-im-uid>` encoded as base64url. Replaying ciphertext across an Agent, device, channel, group, epoch, conversation, or message ID must fail authentication.

## Directory binding

KeyPackage reservations bind atomically to `guest_principal_uid`, `guest_device_uid`, `protocol_mode`, and Agent. Establishment submission must present the same authenticated browser session. Lite receives only the opaque guest-device binding ID; private browser device material is never stored by AgentDID.

The first release keeps old records as `legacy_group_v1`. New Chatroom establishments explicitly request `direct_v2`. Missing mode fields are interpreted as legacy only for backward compatibility.

## Crash and retry contract

- Browser state, display cache, and fixed outbound ciphertext are committed in one IndexedDB transaction under a single-writer fence.
- Lite claims the immutable inbound message ID before Provider execution.
- The allowlisted OpenClaw transport uses that immutable message ID as its downstream idempotency key; its local reply-correlation turn remains attempt-scoped.
- Lite does not advance the persisted receive state immediately after decrypting. The final receive-plus-reply MLS state and the fixed encrypted reply Outbox row commit in one SQLite transaction.
- A delivery retry reuses the exact reply message ID and ciphertext. Provider execution is not repeated after a committed reply exists.
- A receipt/state compare-and-swap failure rolls back the whole transaction.

## Resource contract

- The browser runtime is fetched only for restore or an explicit enable action and is cached by immutable digest for the page lifetime.
- The Brotli-compressed JS plus WASM first package must not exceed 400 KiB.
- Lite keeps at most `min(4, logical CPUs)` pending-recipient crypto processes resident by default. Evicted processes restore their encrypted pending state when needed.
- Direct sessions do not poll, add, remove, or commit MLS members.

## Safe stop and rollout

- `VOKO_E2EE_PRODUCTION_ENABLED=false` stops new directory work and causes ciphertext to fail closed; it never enables plaintext fallback for an encrypted channel.
- AgentDID and Chatroom rollout is allowlist-only. The public Lite updater is not changed by this release.
- Rollback may stop new Direct v2 activation, but an older client must not be used to send plaintext into a Direct-encrypted conversation.
- Full release requires unit, cross-process, browser, crash/outbox, replay, resource, secret-scan, and production allowlist canary evidence. Real WeChat E2EE remains hidden until a physical-device test passes.

## Future group upgrade

The core WireEnvelope, canonical AAD, OpenMLS implementation, and KeyPackage directory remain reusable. Group chat will require a separate membership/fan-out product layer and a new protocol mode; Direct v2 does not pretend that this work is already solved.
