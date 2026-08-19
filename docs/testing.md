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
npm run test:e2ee:witness-processes
npm run test:e2ee:stability -- --duration=30m --output=e2ee-stability-30m-summary.json
npm run e2ee:gate:stability -- stability_30m e2ee-stability-30m-summary.json
npm run test:e2ee:readiness
```

Windows 和 macOS 内部 E2EE-TOFU Canary 使用一个命令执行 readiness、核心协议、浏览器
WASM、Browser→Lite 跨进程、Fake IM 故障以及明文泄漏审计。macOS 还会执行真实
Keychain 生命周期和隔离子进程 `SIGKILL` 恢复门禁：

```powershell
npm run test:e2ee:canary
```

Canary 会先运行 `npm run build:e2ee:wasm` 生成浏览器产物，要求 Rust `1.97.1`、
`wasm32-unknown-unknown` target 和 `wasm-bindgen-cli 0.2.127`。它不依赖 CI 或上一次
构建残留的 `target/web-poc` 目录。

浏览器门禁默认使用 Playwright 管理的 Chromium。对于 Playwright 不再提供下载的旧版
macOS ARM runner，可回退到 `/Applications` 中的 Chrome、Chromium 或 Edge；也可用
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 显式指定受控浏览器路径。测试不会从任意 PATH 猜测浏览器。

该命令只允许在 Windows 或 macOS 运行，并要求 `productionEnabled=false`。验收范围精确绑定
主人、Agent DID 和设备三元组；非白名单主体保持旧传输，已经进入 E2EE 的会话在能力
缺失、身份变化或 KeyPackage 缺失时锁定，不允许降级明文。生成的
`e2ee-canary-summary.json` 默认被 Git 忽略，人工审核后才可将摘要写入发布门禁。

macOS 故障注入也可独立执行：

```bash
npm run test:e2ee:macos-faults
```

它只使用随机、测试专属的 Keychain scope 和隔离 crypto endpoint，不锁定登录 Keychain，
不修改系统网络。它强制终止双方 endpoint、恢复密封状态、拒绝重放，并验证撤销后的
Keychain wrapping key 必须 fail closed。

未提交修改期间可运行诊断稳定性测试：

```bash
npm run test:e2ee:stability -- --duration=5m --allow-dirty --output=e2ee-stability-macos-5m.json
```

该摘要会标记 `diagnosticOnly=true` 和 `worktreeDirty=true`，不能用于发布门禁；
`e2ee:gate:stability` 会明确拒绝此类摘要。正式 30 分钟或 4 小时发布证据仍必须来自
干净 worktree。

限定账号的真实服务、白名单、换钥、撤销、紧急关闭、明文检查和数据库回滚
操作统一遵循 [E2EE Canary 运维手册](e2ee-canary-operations.md)。该手册明确区分
“已通过”“不适用”和“尚未验证”；纯文本 Canary 不得将 OSS 标记为已验证。

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
