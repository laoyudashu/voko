# Changelog

All notable user-facing changes are documented in this file.

## Unreleased

## 0.5.6 - 2026-09-11

- Unify Hermes and OpenClaw Gateway startup and authenticated readiness, respect the selected runtime, and report startup failures instead of treating an open port as a working connection.
- Preserve Hermes profile-specific authentication and routing, safely update Gateway YAML configuration, and bound recovery across shutdown, key refresh, and reconnect.
- Mark Hermes replies arriving after Provider shutdown or replacement as outcome unknown; do not report completion without delivering the reply or automatically replay submitted work.
- Discover Hermes profiles from local configuration before invoking the native CLI, avoiding repeated startup delays during registration, especially on Windows.
- Restore WorkBuddy runtime verification and tighten Provider routing and submission boundaries.
- Replace the deprecated crypto-js dependency with Node.js crypto while preserving the IM AES-CBC/PKCS7 text wire format; this does not change the E2EE protocol.
- Update the locked transitive Hono dependency to 4.13.7 to address dependency audit findings.
- See [release notes](docs/releases/0.5.6.md) and the [Hermes guide](docs/providers/hermes.md) for compatibility and verification limits.

## 0.5.5 - 2026-09-08

- Integrate collaboration chat, tasks, board, assets, members, and settings in the local Web UI. Separate public announcements from member-only instructions and allow announcements to be cleared.
- Add explicit Agent dispatch from shared tasks, isolated execution context, input downloads, output uploads, and result receipts. Execution success remains separate from human task acceptance.
- Persist execution outcomes and retain files after uncertain execution or upload; reconcile eligible late replies with the original execution without automatically replaying work.
- Add provider-specific storage configuration for Qiniu, Tencent COS, Amazon S3, and Cloudflare R2, using the Chatroom server's provider catalog. New providers require a separate server upgrade; real-account upload/download acceptance for COS, S3 and R2 is pending.
- Align DeepSeek Harness HTTP RPC/session handling and visitor permission presets with its checked Remote contract; refuse unsafe fallback when a target permission preset is configured.
- Read collaboration output uploads from checked, bounded file-handle snapshots so path replacement during upload preparation cannot substitute unchecked content.
- Keep visitor QR codes working with uploaded Agent logos.
- Verify delayed npm availability in a separate release job without republishing an already uploaded version.
- See [release notes](docs/releases/0.5.5.md) and the [collaboration guide](docs/collaboration.md) for prerequisites and limits.

## 0.5.4 - 2026-09-07

- Apply visitor admission consistently across Push, Pull, history recovery and group mentions, preserving explicit access settings and blacklist/unpublished restrictions.
- Map supported native Provider permissions and safe defaults to the actual transport, version and operating system without overriding explicit user choices.
- Preserve terminal send failures and unknown delivery outcomes in MCP/CLI message results, including after restart; uncertain execution is never automatically replayed.
- Move visitor sharing controls to Agent details, add QR downloads and explicit link access choices, and simplify registration prompts.
- Show the permission transport selector on its own row in Agent security settings.
- Stabilize cross-platform CI teardown and offline-sync test reporting; allow bounded Windows process identity inspection under load without weakening lock ownership checks.
- See [release notes](docs/releases/0.5.4.md) for compatibility limits, the separate AgentDID directory fix and persistent historical E2EE locks.

## 0.5.3 - 2026-09-06

- Added version-aware OpenClaw CLI/configuration handling and authenticated Gateway version/protocol discovery. Serialized calls sharing a state directory and recovered a migration-requested Gateway restart once within the existing startup deadline.
- Added Codex CLI contract and native sandbox checks tied to the actual runtime, including consistent first/resumed-turn permissions and actionable failure diagnostics. Unverified controls remain unavailable; version numbers alone do not grant permissions.
- Hardened local Web session/event authorization, MCP input boundaries, and encrypted delivery after directory-access refusal.
- Fixed offline synchronization continuation and gap handling, terminal receipt retries, and Provider shutdown/late-result resource lifetimes without retrying execution of uncertain outcome.
- Fixed ACP failure classification, WorkBuddy startup and loopback isolation, OpenHands safety-hook failure handling, Windows Copilot discovery/process ownership, and Aider reply footer filtering.
- Hardened scanning of the exact npm artifact against path aliases, oversized entries, and special files. See [release notes](docs/releases/0.5.3.md) for compatibility limits and release status.
- Unified update discovery, installation, and release verification on the official npm registry. Removed the unused OSS staged-update implementation and its separate release manifest, and made the local Web UI show the exact available version before users run `voko update`.

## 0.5.2 - 2026-09-03

- Added Provider capability discovery and a capability-driven permissions UI. Controls are now derived from the active Provider transport, operating system, architecture, framework/runtime version, runtime fingerprint, and verified enforcement evidence instead of a shared front-end template.
- Added Schema 9 scoped Provider security policies, including Agent-level policy identity, independent transport-level policy revisions, capability-bound preflight/Turn evidence, and safe recovery for interrupted native-policy updates. ZeroClaw, Hermes, and OpenCode now exercise the scoped model while existing Providers remain backward compatible.
- Added runtime probe caching, single-flight refresh, bounded timeouts, circuit breaking, stale-compatible fallback, and safe Pull retention when a changed runtime cannot be verified. Invocation previews and actual Provider calls now share the same planner.
- Added the resumable three-platform Provider runtime matrix and real-browser visitor coverage for capability initialization, policy changes, refresh, transport switching, timeout/fallback behavior, session continuity, rollback, and reply delivery.
- Hardened visitor delivery and reply recovery across WorkBuddy, Qwen Office, DuMate, ZeroClaw, Hermes, OpenCode, Copilot, Cursor, Grok, Goose, and other adapters. Provider status events no longer become business chat history, and only confirmed `not_delivered` outcomes may cross transports.

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
