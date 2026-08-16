# VOKO testing

## Layers

- `npm run test:unit`: deterministic tests without real network or user configuration.
- `npm run test:component`: SQLite, HTTP, WebSocket, child-process and Web route tests.
- `npm run test:coverage`: coverage report in `coverage/`.
- `npm run test:e2e`: isolated Chromium Web checks.
- `npm run test:smoke`: fast main-path smoke check (build, i18n, core contracts
  and selected Chromium journeys); it excludes dedicated timeout/disconnect
  fault suites.
- `npm run test:doctor`: focused read-only CLI diagnosis tests; it uses a
  temporary SQLite database and never contacts production services.
- `npm run test:ci`: the local equivalent of the code CI gate.
- `npm run test:real:*`: explicit local-only checks using `.env.real-test.local`.
- Windows + WSL Ubuntu production acceptance reuses `.env.dual-machine.local`; see [双机生产环境测试手册](dual-machine-production-testing.md). Read that local file before rediscovering paths, ports, test Agents, whitelist prerequisites, or WSL runtime PATH.
- `npm run release:gate:code`: the release code gate (typecheck, build, i18n,
  full baseline coverage, all deterministic tests and package-secret scan).
- The npm release workflow additionally runs Chromium E2E before creating the
  verified tarball; real IM checks remain manual and are never run in CI.

The test runners use four-way cross-file concurrency by default. Build-mutating
and process-identity tests run in isolated serial groups so concurrent tests do
not replace `build/` or race Windows process inspection. Override the worker
count with `VOKO_TEST_CONCURRENCY=1` when diagnosing a flaky test.

Repeat a layer and write a machine-readable stability report:

```powershell
node scripts/repeat-test.js --count=10 --suite=unit
node scripts/repeat-test.js --count=10 --suite=targeted
```

Supported suites are `unit`, `component`, `targeted` and `ci`. Reports are
written under `test-reports/` and are intentionally ignored by Git.

The source of truth for file classification and business mapping is `test/test-matrix.json`. New test files default to the component layer until explicitly reviewed as deterministic unit tests.

## Cline acceptance

The deterministic Cline coverage includes runtime resolution, ACP/CLI provider wiring,
plan-only CLI restrictions, JSONL parsing, Dispatcher fallback, per-Agent ACP health,
shared-connection recovery, stop races and Windows npm-package entry resolution:

```powershell
node --test test/agent-runtime-resolver.test.js test/lite-adaptive-recovery.test.js test/lite-expanded-cli-providers.test.js test/lite-dispatcher-routing.test.js
```

Real Cline acceptance requires an explicitly installed and authenticated Cline
(`cline auth`). Use a temporary VOKO database and a safe, tool-free prompt. The
minimum release sequence is: ACP first reply, ACP session continuation, terminate
the ACP process, verify exactly one CLI reply, run health recovery, verify the next
reply returns to ACP, and scan captured logs for tokens, full prompts and user
configuration paths. The current real result covers Windows; Linux/macOS, long-running
stability and multi-Agent concurrency remain separate acceptance work.

Real E2EE credential-store evidence is collected on each target machine with:

```bash
npm run test:e2ee:platform
```

The command provisions a random owner-scoped secret in the native Windows Credential Manager, macOS Keychain or Linux Secret Service, reopens and uses it, revokes it, then verifies it cannot be reopened. It writes the ignored `e2ee-platform-summary.json` with platform, architecture, exact commit, Cargo version and result; it never records the secret or credential slot. Linux must run inside an unlocked desktop Secret Service session—headless fallback storage is not accepted.

The remaining deterministic E2EE gates use these exact entry points:

```bash
npm run test:e2ee:browser
npm run test:e2ee:cross-process
npm run test:e2ee:stability -- --duration=30m --output=e2ee-stability-30m-summary.json
npm run e2ee:gate:stability -- stability_30m e2ee-stability-30m-summary.json
npm run test:e2ee:readiness
```

`test:e2ee:browser` is one combined Chromium gate covering the WASM round trip,
single-writer lease, IndexedDB crash recovery, CSP/WASM integrity and constrained
mobile emulation. There are no separate `browser:persistence`, `browser:leader`
or `browser:mobile` npm commands. Stability summaries are local evidence and are
ignored by Git; only reviewed results are recorded in `e2ee/release-gates.json`.
The recording command validates the same duration, correctness and resource
policy before atomically changing a gate; it refuses short or failing summaries.
The runner also requires a clean worktree, records the exact Git commit and
platform, and fails if the worktree or HEAD changes before the run completes.

## Isolation contract

Deterministic tests must not contact public VOKO, WuKongIM or OSS endpoints, inspect a user's Provider configuration, or reuse the normal VOKO database. Use `test/support/runtime.js` and injected dependencies. Every server, socket, timer, worker and database must be registered for cleanup.

## Coverage policy

`test/coverage-policies.json` records both the measured baseline and target branch coverage for critical subsystems. `test:coverage:gate` prevents regressions below the baseline; `test:coverage:target` enforces the final 90/85/80/70 targets while the missing branches are added. Coverage is a release signal, not a replacement for protocol, fault and real-environment acceptance tests.

## Failure artifacts

Browser failures are written to `test-results/` and `playwright-report/`. Local real-environment checks write `artifacts/real-tests/<runId>/summary.json`, `report.html` and sanitized logs. These directories must not contain credentials.
