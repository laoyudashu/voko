# VOKO E2EE resource budget

These are engineering gates, not measured production claims. PoC reports must record hardware, OS, Rust/OpenMLS versions and exact test parameters.

| Metric | Initial gate |
| --- | ---: |
| Idle native crypto runtime RSS increase | <= 30 MiB |
| Cached state per active direct conversation | <= 128 KiB |
| Text encrypt/decrypt P95, excluding I/O | <= 5 ms |
| Two-member group establishment P95, excluding network | <= 500 ms |
| Event-loop delay introduced in Node | <= 20 ms P95 |
| Lost, duplicated Provider deliveries or crossed sessions | 0 |

## Runtime policy

- Persisted groups load on demand. A memory- and entry-bounded LRU evicts idle groups and zeroizes secret buffers where supported.
- One group has one writer. Independent groups use a bounded worker pool of at most `min(4, logical CPU count)`; low-memory systems reduce concurrency, not cryptographic strength.
- Heartbeats, SENDACK and WebSocket control traffic never wait behind the crypto work queue.
- Offline ciphertext is paged, grouped by conversation, serialized within a group and processed with bounded inter-group parallelism.
- KeyPackages replenish at an idle-time low-water mark and never in an unbounded burst on the send path.
- Attachments use 1 MiB chunks by default, a reusable buffer pool and at most two concurrent uploads and two downloads. Peak memory must scale with chunk size and concurrency, not file size.

## Required benchmarks

- 100,000 bidirectional text messages in one group.
- 1, 100, 1,000 and 10,000 persisted groups with a fixed active cache.
- Concurrent active groups while measuring RSS, CPU, handles, queue depth and storage P50/P95/P99.
- Process restart, cache eviction and 30-minute idle memory recovery.
- KeyPackage generation and low-water replenishment under load.
- Browser WASM download size, initialization, low-memory mobile behavior and multi-tab leader contention.
- Attachment sizes 1 KiB, 1 MiB and 25 MiB with interruption, retry, corrupt chunks and insufficient disk.
- Five-minute quick gate, 30-minute release gate and 4-12 hour stability gate with injected disconnects.

If a gate fails, implementation may add backpressure, paging, caching limits or lower concurrency. It may not reduce key strength, KDF strength, identity checks, nonce uniqueness or the no-plaintext-fallback rule.

## Initial PoC measurement

On 2026-08-16, OpenMLS 0.8.1 with Rust 1.97.1 under WSL2 x86_64 on an Intel Core Ultra 9 185H measured direct-message encryption at 27.455-27.591 microseconds in Criterion quick mode. This passes the initial 5 ms computation gate, but is not a Windows, macOS, browser WASM, storage or production latency claim.

The same source tree also passed a `wasm32-unknown-unknown` compile check with OpenMLS' `js` feature and the explicit JavaScript randomness backend. This establishes build feasibility only; browser execution, bundle size, IndexedDB atomicity and multi-tab single-writer behavior remain separate gates.

The release stress executable completed 100,000 sequential MLS encrypt/decrypt deliveries in 6.62 seconds with a reported 4,576 KiB maximum RSS for the test process. Every message used a unique authenticated message ID and plaintext was compared after decryption. This is a single-group cryptographic throughput result, not a multi-group storage or full VOKO process memory result.

The browser feasibility package produced a 1,464,933-byte uncompressed release WASM module and passed a real headless Chromium MLS round trip. A two-tab Web Locks test also confirmed that only one tab can hold the writer lease for a group and that a new tab can recover the lease after the leader releases it. Bundle compression, IndexedDB crash atomicity and mobile memory remain open production gates.

The isolated Fake IM test initially took 29.29 seconds because it incorrectly ran Argon2id for every state and payload write. After separating one-time Vault unlock from hot-path record AEAD, the same debug test completed in 0.13 seconds (excluding compilation). Argon2id remains mandatory for passphrase unlock/recovery, while message processing uses a zeroizing in-memory 256-bit master key, random per-record nonces and context-bound AES-256-GCM.

The Fake IM test covers WebSocket `1006`, authentication rejection, lost SENDACK, duplicate ciphertext delivery, reversed delivery order and authenticated route tampering. It asserts ciphertext-only relay storage, exactly-once Provider delivery and zero plaintext fallback. It is still an isolated protocol environment rather than a production WuKongIM integration.

The system credential store is accessed only when provisioning, unlocking, revoking or advancing a rollback anchor. It is not consulted for each encrypted message. The unlocked 32-byte master key remains in zeroizing process memory and the bounded state cache controls decrypted MLS state residency.

The Chromium IndexedDB gate now uses actual serialized WASM/OpenMLS state rather than placeholder bytes. State encryption, atomic state/outbox commit, page reload recovery, sequence continuation and transaction abort rollback all pass in one browser test. IndexedDB size, 1,000-10,000 conversation scale and low-memory mobile measurements remain open performance gates.

All browser fixtures now run under strict CSP and Trusted Types enforcement. The generated WASM SHA-256 digest is checked before instantiation; this detects packaging corruption but does not expand the Web client's trust boundary beyond E2EE-TOFU.

The native scale gate persists 1,000 conversation state records while keeping only 32 decrypted states in the bounded cache. A release-only 10,000-group gate uses the same fixed cache and is available as `npm run test:e2ee:scale`. This verifies bounded cache cardinality and bytes; process RSS, SQLite file size and low-memory mobile behavior remain separate measurements.

The cross-platform CI compiles and tests the E2EE core on Windows, Ubuntu and macOS. Windows and macOS additionally exercise the real OS credential store by provisioning a random owner-scoped key, reopening it in a new manager, decrypting a record, revoking it and verifying it cannot be unlocked again. Headless Ubuntu runners do not provide a trustworthy Secret Service session, so Linux real-keyring lifecycle remains assigned to a dedicated desktop runner rather than being silently replaced with a file or environment variable.

The real Windows Credential Manager lifecycle gate passed locally on 2026-08-16. This is direct platform evidence for Windows only; macOS Keychain and Linux Secret Service still require their respective runners before those platforms can be claimed.
