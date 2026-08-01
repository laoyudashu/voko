# Provider compatibility matrix

[Documentation index](README.md)

This matrix describes the 16 Provider families exposed by VOKO's initial public compatibility set. It separates a completed implementation from evidence that the integration has been validated.

| Provider | Connection modes | Public status | Evidence / notes |
| --- | --- | --- | --- |
| OpenClaw | WebSocket, CLI | Verified | Real-environment validation; gateway connection with CLI fallback where available. |
| ZeroClaw | WebSocket, ACP | Verified | Automated adapter/contract tests; requires a compatible local ZeroClaw installation. |
| Hermes | HTTP, CLI | Verified | Real-environment validation; HTTP connection with CLI fallback where available. |
| Goose | CLI, ACP | Verified | Automated adapter/contract tests; configure a platform-appropriate `goose` executable when necessary. |
| Claude Code | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `claude` CLI. |
| Codex | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `codex` CLI. |
| Gemini | CLI | Implemented, pending field validation | CLI Provider is implemented; no dedicated behavior-test coverage is claimed. |
| Cursor | CLI, ACP | Verified | Automated adapter/contract tests; detects the Cursor agent command or compatible `agent` command. |
| Grok | CLI / pull-only | Discovery / pull-only | Command/process detection and active retrieval only. |
| OpenCode | CLI, ACP, Attach | Verified | Automated adapter/contract tests; ACP, attach, and CLI are distinct runtime paths. |
| Pi Coding Agent | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `pi` CLI. |
| Qwen Code | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `qwen` CLI. |
| Kiro CLI | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `kiro-cli` CLI. |
| GitHub Copilot CLI | ACP, CLI | Verified | Automated adapter/contract tests; requires a compatible locally installed Copilot runtime. |
| OpenHands | CLI / pull-only | Discovery / pull-only | Command/process detection and active retrieval only. |
| Aider | CLI | Verified | Automated adapter/contract tests; VOKO invokes the installed `aider` CLI. |

## What the status means

- **Verified**: the evidence column records whether VOKO has real-environment validation or automated adapter/contract-test coverage. Neither guarantees every Provider release, account plan, operating system, or model configuration.
- **Implemented, pending field validation**: a dedicated integration exists, but no claimed automated behavior coverage or real-environment validation exists yet.
- **Discovery / pull-only**: VOKO can recognize the command or process and retain active retrieval, but does not promise automatic delivery.

## Contribute a result

Open a public [GitHub Issue](https://github.com/voko/voko/issues) for a non-sensitive compatibility report, or include it in a pull request for an adapter change. Provide:

1. VOKO version and operating system/version.
2. Provider name, version, and connection mode.
3. The minimum reproduction steps and the observed result.
4. Sanitized logs only; never include credentials, tokens, private keys, verification codes, or private conversations.

Use the local Web UI's [Report a bug page](http://localhost:3100/bug-report) for product issues that benefit from the built-in report flow. See [Contributing](../CONTRIBUTING.md) for code changes.
