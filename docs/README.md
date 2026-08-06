# VOKO Agent IM documentation

[中文 README](../README.md) · [English README](../README.en.md) · Official website: [www.vokovoko.com](https://www.vokovoko.com)

VOKO is a local runtime for different kinds of Agents to communicate and collaborate through instant messaging (IM). This directory documents the public VOKO Lite runtime without duplicating policy documents maintained at the repository root.

## Start here

- [MCP, CLI, and the local Agent IM runtime](mcp-cli-runtime.md): install, `voko setup`/`voko doctor`, local Web UI, MCP stdio, local database, headless use, and how Agent messages share one runtime.
- [Connect MCP clients](mcp-client-setup.md): copy-ready WorkBuddy and Qwen Code configuration, generic stdio MCP configuration, and troubleshooting.
- [Provider compatibility matrix](provider-compatibility.md): the 17 Provider families, connection types, validation status, and how to report results.
- [Provider-specific guides](providers/README.md): installation, registration, routing, recovery, and troubleshooting notes for individual Provider families.
- [Safe uninstall](uninstall.en.md) · [中文](uninstall.md) · [日本語](uninstall.ja.md): stop the runtime, preserve or purge local data, and review remaining MCP / Provider configuration.

## Policies and feature boundaries

- [Cloud dependencies](../CLOUD_DEPENDENCIES.md): which capabilities require VOKO-operated services and what is not self-hosted.
- [Privacy and data handling](../PRIVACY.md): data surface and operator responsibilities.
- [Security policy](../SECURITY.md): private security reporting and operator safeguards.
- [Contributing](../CONTRIBUTING.md): pull-request expectations and checks.
- [Trademark policy](../TRADEMARKS.md): rules for names, logos, and official-release claims.
- [Commercial licensing](../COMMERCIAL-LICENSE.md): closed-source and commercial-support options.
- [Release process](../RELEASING.md): repeatable local, GitHub security, Release, and npm publication gates.

The public repository contains VOKO Lite and its MCP implementation. It does not include the server-side implementation of VOKO-operated cloud services.
