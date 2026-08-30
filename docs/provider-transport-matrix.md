# Provider transport behavior matrix（架构真相源）

This is the normative architecture matrix for VOKO Provider transports. It is the
single source of truth for transport order, Session/Binding ownership, fallback,
availability invalidation, and delivery outcomes. The developer guide and
Provider-specific pages explain implementation or installation details only;
they must not redefine these invariants.

## Ownership model

```text
Provider Catalog → Runtime Registry → Dispatcher → Delivery Executor
                                      ↓
                           Session Coordinator / Binding Store
```

- **Catalog** declares the canonical family, transport ID, mode, priority,
  operations, capabilities and safety policy.
- **Runtime Registry** owns Provider lifecycle and availability event
  subscription. Events use the exact transport ID, optional Agent scope,
  affected operations and a monotonic generation.
- **Dispatcher** is the only component that chooses a transport, performs the
  one-time fallback and invalidates the `push`/`steer` route cache.
- **Delivery Executor** classifies the result and attempts at most two
  transports for one message.
- **Session Coordinator / Binding Store** owns durable VOKO bindings. A
  transport may restore or create a native Session, but does not choose another
  transport or bypass the Coordinator when persisting a binding.
- **Pull** is durable on-demand consumption, not a Provider transport and never
  enters the Push/Steer route cache.

## Transport matrix

| Family | Transport order | Native session | Reply model | Binding owner | Cross-transport fallback |
|---|---|---|---|---|---|
| Goose | ACP, CLI, Pull | Agent-issued ID | ACP streaming / CLI final | Dispatcher when `enabled`; transport compatibility only in `disabled`/`shadow` | Dispatcher only |
| Cline, Cursor, GitHub Copilot | ACP, CLI, Pull | Agent-issued ID | ACP streaming / CLI final | Dispatcher | Dispatcher only; failed bound sessions are not silently replaced |
| OpenCode | ACP, Attach, CLI, Pull | Agent-issued ID | Streaming or final | Dispatcher | Dispatcher only; compatible native sessions may move across ACP, Attach and CLI |
| ZeroClaw | ACP WebSocket, ACP, CLI, Pull | Instance-scoped ID | Async/streaming or final | Dispatcher | Dispatcher only |
| OpenClaw | WebSocket, CLI, Pull | Profile/session ID | Async/streaming or final | Dispatcher | Dispatcher only |
| Hermes | HTTP, CLI, Pull | Profile/session ID | Async or final | Dispatcher | Dispatcher only; queued CLI failures remain asynchronous |
| CLI-only families (Claude Code, Codex, Gemini, Pi, Qwen Code, Kiro, Aider, Grok, Reasonix) | CLI, Pull | Provider-specific | Final | Dispatcher | Pull after confirmed `not_delivered` |
| Qwen Office | CLI, Pull | Optional Expert-kit instance + QwenWork `session_id` | stream-json final | Dispatcher | With a selected kit, `--cwd` + `--plugin-dir` pins it; without one, the runtime creates an isolated session. Stale explicit instance/session bindings fail closed, and confirmed `not_delivered` may fall back to Pull |
| DuMate | HTTP, Pull | Optional Plugin Pack Agent or VOKO-private ephemeral route + DuMate `sessionId` | HTTP event stream / committed final | Dispatcher | VOKO starts an isolated loopback `dumate-opencode` service, sends the selected or ephemeral Plugin Part, and verifies `activePlugins`; instance/session mismatch fails closed |
| Trae | ACP, Pull | Agent-issued ACP session ID | ACP streaming | Dispatcher | Desktop `trae` is MCP client only; `traecli` is required for ACP |
| WorkBuddy | HTTP, Pull | Optional Expert binding + WorkBuddy session ID | ACP streaming | Dispatcher | Requires separately installed and logged-in `@tencent-ai/codebuddy-code`; an explicit Expert remains pinned, while an unbound Agent gets an isolated session; uncertain results are not resubmitted |
| DeepSeek Harness | Web Host HTTP, Profile CLI, Pull | Web Host: persisted Session ID scoped to one Agent Preset; CLI: none (one-shot) | Web Host: committed messages after correlated `turn/end`; CLI: successful exit plus stdout | Dispatcher | Web Host supports exact resume/steer. The shipped `headless` CLI creates a fresh Agent per invocation and is never used for a bound conversation |
| CodeBuddy | ACP, Pull | Agent-issued ACP session ID | ACP streaming | Dispatcher | Official standalone CodeBuddy CLI only; embedded WorkBuddy CLI is not auto-selected |
| Pull-only families (OpenHands, Amazon Q, ZCode, Doubao, Others when no Push transport is registered) | Pull | None required | On demand | N/A | N/A |

## Normative invariants

- `delivery_modes = null` uses Catalog priority and keeps the legacy Pull
  fallback; `[]` disables Push; a non-empty list is strict and ordered; `pull`
  is always on-demand.
- A route cache key is `agentId + operation(push|steer)`. The default TTL is
  30 seconds. Availability events invalidate only the affected Provider,
  Agent and operation; generations prevent an in-flight old request from
  repopulating the cache.
- A cache hit performs only the current Provider's synchronous, read-only
  `isAvailable(agentId)` guard. It must not start a Gateway, call a model or
  scan all Providers.
- Only `not_delivered` permits the second transport attempt. `outcome_unknown`
  and `rejected` never trigger cross-transport retry. Recovery changes the
  next message's route; it never replays the previous message.
- `messageId` and `turnId` remain stable across the attempted transports.
  Async CLI queue acceptance is a `delivered` Dispatcher result with
  `accepted`/`queued` metadata; a later queue failure is a separate diagnostic
  event, not permission to resend through another transport.
- Inbound messages are persisted and validated individually, then coalesced in
  memory by Agent, sender, channel and routing Conversation. One closed Turn
  invokes the Provider once and carries its ordered `sourceMessageIds`, message
  segments and attachments. Messages arriving after execution begins form the
  next Turn.
- Online IM, offline synchronization and E2EE use the same Turn construction
  rules. E2EE decryption, signature checks, per-message acknowledgement,
  cursor advancement and deduplication happen before coalescing and remain
  message-scoped.
- Caller-origin bindings are never rewritten by availability or automatic
  fallback. Cross-transport binding reuse requires an explicit compatibility
  check for family, instance, adapter, mode and native Session.
- A transport may reconnect or recreate an invalid Session within itself, but
  it cannot invoke another transport, modify Dispatcher route cache, or guess
  the most recent Session. If exact restoration is impossible, the message
  remains available through Pull.
- Provider diagnostics do not define platform online status. IM heartbeat is
  based on IM connectivity; Push/ACP/HTTP/CLI readiness is reported separately.

## Delivery diagnostics contract

`getAgentDeliveryStatus(agentId)` and the runtime/Web/Doctor snapshots use the
same fields:

```text
backendType
configuredModes
automaticDeliveryReady
automaticReadyModes
activeAutomaticMode
pullReady
pullOnly
lastDeliveredMode
methods[]
```

Each `methods[]` entry contains `mode`, `provider`, `family`, `configured`,
`available`, `status` and an optional `reason`. Status values are
`available`, `unavailable`, `on-demand`, `fallback` and `unknown`.
Diagnostics are read-only: they do not start a Gateway, invoke a model, probe
the public network or mutate configuration. Explicit Pull is
`on-demand/configured-on-demand`; missing legacy `delivery_modes` is
`fallback/legacy-fallback`; a family with no registered Push transport is
`provider-pull-only`.

`send_message` may additionally expose result tracking. The corresponding MCP
and CLI result query separates persisted transport state, authenticated remote
execution state and correlated reply state. Execution receipts are bounded
runtime memory; after restart, persisted transport remains queryable while the
execution result becomes `UNCONFIRMED/RUNTIME_STATE_NOT_AVAILABLE`.

## Rollout and testing

`feature:provider_modular_dispatch_v1` supports `disabled`, `shadow` and
`enabled`, with an optional family allowlist. Shadow mode compares route,
binding and outcome decisions without invoking a second Provider or writing a
second binding. A family may enter `enabled` only after its shared Provider
contract tests, fault/recovery tests and real acceptance evidence pass.

When another document needs to describe a transport, link back to this matrix
for generic behavior and state only the Provider-specific command, version,
instance semantics, security flags or known limitation.
