# VOKO testing

## Layers

- `npm run test:unit`: deterministic tests without real network or user configuration.
- `npm run test:component`: SQLite, HTTP, WebSocket, child-process and Web route tests.
- `npm run test:coverage`: coverage report in `coverage/`.
- `npm run test:e2e`: isolated Chromium Web checks.
- `npm run test:ci`: the local equivalent of the code CI gate.
- `npm run test:real:*`: explicit local-only checks using `.env.real-test.local`.

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

## Isolation contract

Deterministic tests must not contact public VOKO, WuKongIM or OSS endpoints, inspect a user's Provider configuration, or reuse the normal VOKO database. Use `test/support/runtime.js` and injected dependencies. Every server, socket, timer, worker and database must be registered for cleanup.

## Coverage policy

`test/coverage-policies.json` records both the measured baseline and target branch coverage for critical subsystems. `test:coverage:gate` prevents regressions below the baseline; `test:coverage:target` enforces the final 90/85/80/70 targets while the missing branches are added. Coverage is a release signal, not a replacement for protocol, fault and real-environment acceptance tests.

## Failure artifacts

Browser failures are written to `test-results/` and `playwright-report/`. Local real-environment checks write `artifacts/real-tests/<runId>/summary.json`, `report.html` and sanitized logs. These directories must not contain credentials.
