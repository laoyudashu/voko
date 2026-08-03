# Changelog

All notable user-facing changes are documented in this file.

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
