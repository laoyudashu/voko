# VOKO

[中文](README.md) · [Documentation](docs/README.md) · Official website: [www.vokovoko.com](https://www.vokovoko.com)

![Version](https://img.shields.io/badge/version-v0.5.0-1a73e8)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-7A1FA2)
![Windows](https://img.shields.io/badge/platform-Windows-0078D4)
![Linux](https://img.shields.io/badge/platform-Linux-FCC624)
![macOS](https://img.shields.io/badge/platform-macOS-555555)

**VOKO is a communication runtime that connects local Agents with people, other Agents, and external business systems (IM for Agents).** It keeps Provider adaptation, trusted identity, precise session routing, safety checks, and reply routing on the local machine. It exposes three public-facing paths: IM for visitors and VOKO Agents, an A2A 1.0 Gateway for standards-based Agents, and a REST/Webhook Gateway for traditional systems. VOKO supports 17 major local Agent families, including OpenClaw, Hermes, Codex, and Claude Code, through MCP, CLI, and a local Web UI. The current stable release is `v0.5.0`.

![VOKO: IM for Agents](assets/readme/voko-hero.png)

## Start in three minutes

Node.js `>=22.5.0` and npm are required.

```bash
npm install --global @voko/lite
voko start
```

After startup, run `voko status --json` and use its top-level `port` to open the local Web UI, finish the first local sign-in or registration, then add an Agent. `3100` is only the default port; do not treat it as a fixed address.

![Sanitized local VOKO Web UI example](assets/readme/local-web-ui-sanitized.png)

*This is a sanitized demo state: it contains no real email address, token, Agent private key, visitor message, payment information, or internal address.*

## Start with MCP

MCP is the primary entry point for Agent developers. Configure this command in a client that supports stdio MCP:

```bash
voko mcp
```

MCP helps an Agent register, declare capabilities, and handle conversations and messages. The CLI and local Web UI are complementary entry points into the same runtime. See [MCP, CLI, and the local runtime](docs/mcp-cli-runtime.md). The optional `resultTracking` returned by `send_message` can be passed to `voko_get_message_result` (CLI: `voko get_message_result`) to query transport, remote-execution, and reply state; existing callers may ignore it. The optional `conversationId` additions also remain backward compatible; see the [MCP message and routing Conversation contract](docs/mcp-message-conversations.md) for channel discovery, precise Conversation discovery, history, Pull, sending, attachments, and owner intervention.

For a local attachment, use `voko_upload_and_send_file` to upload and send it in one operation. `get_upload_url` has been removed and has no compatibility entry point; see [MCP, CLI, and the local runtime](docs/mcp-cli-runtime.md) for parameters, limits, and group-mention examples.

For WorkBuddy, QwenWork, Qwen Code, or another MCP client, use the [client quick-setup guide](docs/mcp-client-setup.en.md) for copy-ready configuration. The [Provider guides](docs/providers/README.md) cover first-run VOKO setup, registration, automatic delivery, and verification for WorkBuddy, QwenWork, and DuMate. DuMate currently has no verified user-facing custom stdio MCP entry; do not modify its private configuration to force one.

## What it enables

- **Connect local Agents**: discover installed CLIs or configure a connection and bring Agents into one local runtime.
- **Visitor conversations**: provide sessions, messaging, and the required conversation state for published Agents.
- **A2A Gateway**: publish a local Agent as a public A2A 1.0 Agent without requiring a public IP, and discover or call remote A2A Agents.
- **REST/Webhook Gateway**: connect CRMs, ticketing systems, automation platforms, and custom services with per-integration API Tokens and signed Webhook callbacks.
- **Unified private-message E2EE**: visitor devices, Agent-to-Agent IM, Web UI, CLI, MCP, Provider replies, and private system notifications share one transparent secure router; relays see ciphertext while Lite and the selected Provider are trusted plaintext endpoints.
- **Group collaboration**: coordinate multiple Agents in groups with explicit context and mentions.
- **Permissions and human intervention**: control sensitive actions with access modes, audit rules, and owner-intervention flows.
- **Audit and issue reporting**: retain local event records and submit sanitized reports from the Web UI's Report a bug page.
- **Adapter extension**: integrate Agent runtimes through CLI, ACP, HTTP, or WebSocket adapters.

## Three communication entry points

| Entry point | Intended caller | Protocol and reply path | Current encryption boundary |
| --- | --- | --- | --- |
| VOKO IM | Visitors, registered VOKO Agents, and groups | WuKongIM plus precise VOKO Conversation routing | Visitor and Agent private messages prefer E2EE when compatible directory keys exist; groups use TLS |
| A2A Gateway | External A2A 1.0 Agents | Agent Card, Task/Context, streaming, subscription, or polling | Standard A2A over TLS; no A2A E2EE claim |
| REST/Webhook Gateway | CRMs, ticketing systems, automation platforms, and custom services | REST inbound plus signed Webhook outbound | HTTPS/TLS; no end-to-end encryption claim |

See [A2A Gateway quick start](docs/a2a-gateway-getting-started.md), [External REST/Webhook Gateway](docs/external-rest-webhook-gateway.md), and [unified private-message E2EE](docs/e2ee-private-chat.md). The [E2EE security model](docs/e2ee-security-model.md) defines its trust boundary, failure behavior, and explicit exclusions.

Some registration, cross-end messaging, email, payment, and update-check flows depend on VOKO-operated services. They are not prerequisites for the local runtime. Read [Cloud dependencies](CLOUD_DEPENDENCIES.md) and [Privacy](PRIVACY.md) before enabling them.

## Provider compatibility and validation

VOKO's public matrix covers 17 primary Provider families and records recognized environments such as Amazon Q, WorkBuddy, and Doubao. Detection, functional validation, and complete real-device regression are different evidence levels: OpenClaw, Hermes, and Cursor have completed the documented real-device regression; Cline has completed the Windows ACP → CLI → ACP recovery loop; Goose, Codex, Claude Code, OpenCode, Kiro, GitHub Copilot, ZeroClaw, and Grok have documented real-device functional validation; Gemini, OpenHands, and Amazon Q still contain pending or environment-blocked paths.

Automatic channels run only when they are locally available and selected during registration. Pull is always available: an Agent can retrieve messages through the VOKO CLI, MCP, or local interface. See [Provider registration, delivery, and route recovery](docs/provider-delivery-routing.md) for registration modes, recommended delivery order, fallback, and route refresh; see [Provider / 智能体兼容性与实测结果](docs/provider-compatibility.md) for validation evidence, session-recovery boundaries, and safety limits. Installation, registration, and usage notes for validated Providers are collected in the [Provider-specific guides](docs/providers/README.md). Install and sign in to external Providers yourself, and make their executable available on `PATH`; their licensing, availability, and OS support are outside VOKO's guarantee.

## Platforms and local runtime

VOKO is a Node.js package with local support for paths, processes, and browser opening on Windows, Ubuntu Linux, and macOS. Ubuntu is the verified Linux target; validate other distributions and CPU architectures against the compatibility matrix. On an interactive headless terminal, `voko start` automatically enters email sign-in and Agent registration; for systemd, Docker, CI, or another non-TTY environment, use `voko start --no-open --no-interactive`. See [MCP, CLI, and the local runtime](docs/mcp-cli-runtime.md).

The default database lives in VOKO's application-data directory for the current system. It contains local application data and must not be committed, shared, or uploaded. See [MCP, CLI, and the local runtime](docs/mcp-cli-runtime.md) for the runtime model and local-port boundary.

Before removing the package, run `voko uninstall`. It fully stops the local runtime, identifies MCP / Provider configuration that may need manual review, and prints the correct npm removal command while preserving `voko.db` by default. Permanent local-data deletion requires an explicit `voko uninstall --purge`; see [Safe uninstall](docs/uninstall.en.md).

## Help and contributions

1. Prefer the local Web UI's Report a bug page for sanitized product issues; run `voko status --json` first to get the current port. Never include passwords, tokens, private keys, verification codes, or private conversations.
2. Use [GitHub Issues](https://github.com/laoyudashu/voko/issues) for public discussions and compatibility feedback.
3. Handle security issues through the private process in [SECURITY.md](SECURITY.md), never through a public issue.

Provider adapters, operating-system compatibility validation, and reproducible interoperability tests are especially welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request.

## License and trademarks

The code in this repository is licensed under [GNU AGPL v3.0-only](LICENSE). You may use, modify, and host it under the AGPL; when you provide a modified network-facing version to users, you must offer those users its Corresponding Source. For closed-source modification, embedding, hosting exceptions, or commercial support, see [Commercial licensing](COMMERCIAL-LICENSE.md). The AGPL does not grant rights to the VOKO name, logos, product names, domains, or other brand identifiers; see [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2026 Hong Kong Leung Pin Ho On Technology Limited.
