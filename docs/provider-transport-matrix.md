# Provider Transport behavior matrix

This matrix freezes the behavior that the modular Dispatcher must preserve.
`Pull` is durable on-demand consumption and is not a Provider transport.

| Family | Transport order | Native session | Reply model | Binding owner | Cross-transport fallback |
|---|---|---|---|---|---|
| Goose | ACP, CLI, Pull | Agent-issued ID | ACP streaming / CLI final | Dispatcher when rollout is enabled; legacy transport otherwise | Dispatcher only |
| Cline, Cursor, GitHub Copilot | ACP, CLI, Pull | Agent-issued ID | ACP streaming / CLI final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement; failed bound sessions are not silently replaced |
| OpenCode | ACP, Attach, CLI, Pull | Agent-issued ID | Streaming or final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement; compatible native sessions may move across ACP, Attach and CLI |
| ZeroClaw | ACP WebSocket, ACP, CLI, Pull | Instance-scoped ID | Async/streaming or final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement |
| OpenClaw | WebSocket, CLI, Pull | Profile/session ID | Async/streaming or final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement |
| Hermes | HTTP, CLI, Pull | Profile/session ID | Async or final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement; queued CLI failures remain asynchronous |
| CLI-only families (Claude Code, Codex, Gemini, Pi, Qwen Code, Kiro, Aider, Grok, Reasonix) | CLI, Pull | Provider-specific | Final | Shadow by default; Dispatcher after Family enablement | Dispatcher only after enablement; Pull after confirmed `not_delivered` |

## Invariants

- `delivery_modes=null` uses Catalog priority; `[]` disables Push; a non-empty list is strict and ordered.
- A message is attempted through at most two transports. Only `not_delivered` permits the second attempt.
- `outcome_unknown` and `rejected` never trigger a cross-transport retry.
- Availability invalidation is scoped by provider, optional Agent, and operation, and stale generations are ignored.
- Caller-origin exact-session bindings are never rewritten by automatic recovery or fallback.
- A transport may reconnect or recreate an invalid session within itself, but it cannot invoke another transport.
- Shadow rollout computes diagnostics only; it never invokes a second Provider or persists a second binding.
- The rollout policy supports per-Family modes so Goose can remain enabled while later migration families stay in shadow.
- Generic CLI bindings are adapter-exact by default; cross-adapter reuse requires an explicit Provider compatibility hook.
