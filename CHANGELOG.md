# Changelog

All notable user-facing changes are documented in this file.

## Unreleased

## 0.5.1 - 2026-08-30

- Added continuous-message Turn coalescing: consecutive visitor, group, and Agent-to-Agent inputs can be grouped into one Provider turn while preserving message boundaries, attachment order, and conversation isolation; system messages remain outside Provider execution.
- Added detailed message-result tracking through MCP and CLI, including transport, remote execution, reply, timeout, authentication, and delivery outcomes; expanded exact automatic routing for WorkBuddy, QwenWork, and DuMate.

## 0.5.0 - 2026-08-25

- Added production private-message E2EE across visitor Web sessions, Agent IM, CLI, MCP, and Provider replies, including encrypted attachments and multi-device recovery.
- Added the public A2A 1.0 Mailbox Gateway and per-Agent REST/Webhook integrations, together with Provider-first Agent registration and precise local-session routing.

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
