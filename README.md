# VOKO

VOKO is an open-source intelligent agent communication runtime. It connects local AI agents to visitors and other AI agents through MCP, CLI, HTTP, Web UI, email, and WuKongIM-based messaging.

VOKO 是一个开源的智能体通信运行时，通过 MCP、CLI、HTTP、Web UI、邮件和基于 WuKongIM 的消息通道，将本地 AI Agent 与访客或其他 AI Agent 连接起来。

> Status: `v0.4.0` release candidate. The public release has not been published yet.

## Features

- MCP server and CLI for agent communication workflows
- OpenClaw and Hermes adapters
- Visitor conversations, owner intervention, groups, audit rules, and access control
- Optional email, WeChat, payment, and OSS update integrations
- Chinese and English user-facing messages, with a Japanese locale skeleton

## Requirements

- Node.js `>=22.5.0`
- npm
- A VOKO cloud account for cloud-backed registration, messaging, and payment features

## Install and run

```bash
npm install
npm run build:ts
node build/index.js start
```

For a published npm release:

```bash
npm install --global @voko/lite
voko start
```

Run the MCP stdio entry point:

```bash
voko mcp
```

## Register or add an Agent

People can open `/agent/add` in the local Web UI and use the four-step wizard. Web, local HTTP, MCP, and CLI all use the same registration state machine.

Agents should call `voko_manage_agent_registration` (CLI name: `manage_agent_registration`). Start with:

```json
{ "action": "start", "email": "owner@example.com" }
```

Keep the returned `registrationId` and follow each response's `nextAction`. The supported actions are `verify_email`, `set_basic_info`, `inspect_environment`, `select_provider`, `select_delivery`, `configure_delivery`, `configuration_status`, `test_delivery`, `complete`, and `status`.

Provider configuration is never changed by inspection or testing. `configure_delivery` first returns a change plan; the caller must repeat the action with `"approved": true` before VOKO writes local Provider configuration. Active message retrieval (`pull`) is always retained as the final fallback.

Run the release checks:

```bash
npm test
npm run package:build
npm pack --dry-run
```

## Configuration

Copy `.env.example` to a local environment file or export only the variables required by the integrations you enable. Never commit live credentials.

Cloud-backed behavior and external endpoints are documented in [CLOUD_DEPENDENCIES.md](CLOUD_DEPENDENCIES.md). Data handling is summarized in [PRIVACY.md](PRIVACY.md).

The default runtime database is named `voko.db`. It is stored in the platform-specific VOKO application-data directory. `VOKO_DB_PATH` or the CLI `--db` option may be used to select an explicit path. Database files contain local application data and must not be committed.

## Security

Do not report vulnerabilities or credentials in a public issue. Follow [SECURITY.md](SECURITY.md) for private reporting.

Payment-related features may process identity, bank-card, phone, and account data. They should remain disabled until the operator has completed a legal/privacy review and configured appropriate access controls, retention, encryption, and incident response.

## Project scope

This repository contains VOKO Lite and its MCP implementation. It does not contain VOKO Desktop, Electron packaging, Windows installers, or Desktop release/upload administration.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Before synchronizing this source candidate to GitHub, follow [GITHUB_SYNC_POLICY.md](GITHUB_SYNC_POLICY.md). Local databases, credentials, generated output, and audit artifacts must not be uploaded.

## License and trademarks

Code is licensed under the [Apache License 2.0](LICENSE). Third-party components retain their own licenses; see [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md).

Apache-2.0 does not grant rights to use VOKO trademarks or branding beyond customary attribution. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2026 Hong Kong Leung Pin Ho On Technology Limited.
