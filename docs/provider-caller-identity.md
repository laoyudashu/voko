# Provider caller identity

This document defines how VOKO identifies the caller of `whoami` and other Agent-scoped MCP/CLI tools. It is separate from Conversation routing: caller identity selects the VOKO `agentId`; a message `conversationId` and `routeId` are resolved later when a message is sent or answered.

VOKO accepts only these evidence classes:

- `voko_created`: a VOKO-managed CLI/ACP adapter supplies the Provider type, instance and native session.
- `provider_env`: the Provider itself exports a documented session variable to the VOKO MCP process.
- `provider_process`: on Linux Codex only, a bounded parent-process/file-descriptor check finds exactly one active rollout owned by the caller. Zero or multiple matches are treated as no evidence.

VOKO does not use the current directory alone, the newest file, process recency, a guessed session name, `connectionId`, or a model-guided handshake. Missing or ambiguous evidence always means explicit Agent selection.

The MCP stdio proxy, direct `voko whoami`, and the runtime-proxy CLI all call the same resolver. A Provider instance is accepted only when a VOKO-managed adapter supplies `VOKO_CALLER_INSTANCE`; no provider-specific profile, workspace, or config filename is promoted to an instance identity unless the Provider documents it as a caller value.

| Provider | Stable caller evidence | Linux | Windows | macOS | If unavailable |
| --- | --- | --- | --- | --- | --- |
| Codex | `CODEX_THREAD_ID` when Codex passes it; VOKO-managed adapters; bounded `/proc` rollout evidence on Linux | `/proc` fallback may resolve exactly one active rollout | stdio MCP currently has no reliable thread injection | stdio MCP currently has no reliable thread injection | `voko_list_agents`, then retry `voko_whoami --agent <id>` |
| Claude Code | `CLAUDE_CODE_SESSION_ID` in current Claude Code stdio MCP versions; also supplied to hooks/Bash | supported | supported with the current Claude Code runtime (Git Bash/WSL or native supported setup) | supported | update Claude Code/restart the MCP process; otherwise select explicitly |
| Goose | `AGENT_SESSION_ID` (Goose documents this for local stdio extensions); `AGENT=goose` is only a type hint | supported | supported | supported | configure the extension so the Provider-owned variable reaches the MCP child, or select explicitly |
| Hermes | `HERMES_SESSION_ID` when Hermes passes it to the MCP/tool subprocess; profile is not a session ID | supported | Hermes is not natively supported; use WSL/Unix environment | supported where Hermes runs | select explicitly if the MCP environment filter omits the variable |
| OpenClaw | VOKO-managed adapter context only; Gateway `sessionKey` is a routing selector, not automatic external MCP caller identity | supported | supported | supported | select explicitly; do not infer from workspace or newest Gateway session |
| OpenCode | no current stable session injection into MCP; VOKO-managed adapter context only | manual unless an adapter supplies context | manual unless an adapter supplies context | manual unless an adapter supplies context | `voko_list_agents`, then select explicitly |
| Kiro CLI | no documented stable caller variable for MCP; VOKO-managed adapter context only | manual unless an adapter supplies context | manual unless an adapter supplies context | manual unless an adapter supplies context | `voko_list_agents`, then select explicitly |
| Other Providers | only a documented Provider variable or VOKO-managed adapter context | depends on Provider | depends on Provider | depends on Provider | select explicitly |

## Rules for multiple Agents

If the caller Provider family maps to exactly one owned VOKO Agent, `whoami` returns it without requiring a native Session. If multiple owned Agents share the family, VOKO uses an exact trusted `(provider family, provider instance, native session)` binding. If that binding is missing, stale, or ambiguous, VOKO returns only the matching candidates and requires `agentId` selection. Selection verifies ownership and does not silently create or change an identity binding.

## Operational guidance

After changing a Provider version, MCP configuration, login state, or environment, restart the Provider MCP process and VOKO so the child environment is rebuilt. Do not manually set a Provider's session variable to impersonate another session. Do not put native session IDs, tokens, or local configuration paths into prompts, public documents, or ordinary logs.

The relevant upstream behavior is documented by [OpenAI Codex issue #19937](https://github.com/openai/codex/issues/19937), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [Goose environment variables](https://github.com/block/goose/blob/main/documentation/docs/guides/environment-variables.md), [Hermes environment variables](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/environment-variables.md), [OpenCode MCP session issue #6279](https://github.com/anomalyco/opencode/issues/6279), [Kiro session commands](https://kiro.dev/docs/cli/reference/cli-commands/), and [OpenClaw session/agent CLI documentation](https://docs.openclaw.ai/cli/agent).
