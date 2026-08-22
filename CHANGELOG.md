# Changelog

All notable user-facing changes are documented in this file.

## Unreleased

- Added a public A2A 1.0 Mailbox Gateway with Agent Cards, durable Task/Context handling, streaming/subscription/polling, independent Lite storage, and local trusted execution.
- Added per-Agent External REST/Webhook integrations with isolated credentials, REST ingestion, signed callbacks, task views, delivery diagnostics, and secure attachment handling.
- Added production visitor-private-chat E2EE for supported browsers and Lite endpoints, including explicit opt-in, visible key state, non-downgrading active sessions, rebuild after key loss, encrypted attachments, and local plaintext delivery to the selected Provider.
- Added temporary private-object upload authorization and completion/binding flows so clients no longer require long-lived OSS credentials.
- Expanded Provider support, exact-session routing, A2A/Owner source isolation, conversation-aware Web UI, and cross-platform recovery and reliability tests.

## 0.4.1 - 2026-08-03

- Hardened local Web and Provider boundaries with route rate limits, safer command spawning, stronger output encoding, and registration-session identity validation.
- Fixed Linux orphan Worker termination handling, including short-lived zombie processes, without weakening process identity checks.
- Improved Windows ACL verification and stabilized the complete Node 22/24 test suite across Windows, Linux, and macOS.
- Updated GitHub security Actions and pinned every external Action to an immutable commit SHA.
- Added a documented secure release gate and corrected macOS temporary-path tests for `/var` and `/private/var` equivalence.

## 0.4.0 - 2026-08-03

- Prepared VOKO Lite and MCP as a standalone GNU AGPL v3.0-only repository with commercial licensing options.
- Removed Desktop packaging and release-administration code.
- Added open-source security, privacy, cloud dependency, trademark, and contribution guidance.
- Added release gates for tests, i18n, secrets, dependencies, and package contents.
- Removed the deprecated Feishu/Lark integration.
- Changed Windows Goose execution to spawn `goose.exe` directly and pass visitor content through stdin.
- Changed short-link creation to use the current owner's User Access Token and server-derived Agent targets.
- Clarified VOKO's public positioning as a local Agent IM runtime for direct cross-Agent communication and collaboration.
- Added bilingual README guidance, an Agent IM hero image, and a documented Provider compatibility evidence matrix.
