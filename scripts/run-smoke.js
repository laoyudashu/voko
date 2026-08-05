#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

// Keep this suite intentionally small: it exercises the main contracts and
// successful user journeys without running the dedicated timeout/disconnect
// fault suites. The full CI/E2E commands remain the release gates.
const NODE_TESTS = [
  'test/lite-mcp-contract.test.js',
  'test/mcp-checkpoint-cursors.test.js',
  'test/heartbeat-delivery-status.test.js',
  'test/web-attachment-send.test.js',
  'test/web-security-regressions.test.js',
  'test/web-group.test.js',
];

const DISPATCHER_SMOKE_PATTERN = [
  'dispatcher respects',
  'delivery diagnostics',
  'dispatcher falls back',
  'dispatcher remembers',
  'dispatcher start',
  'availability recovery invalidates',
  'stop and restart',
  'an older availability',
  'availability invalidation',
  'empty and pull-only',
  'confirmed failure',
].join('|');

const E2E_SPECS = [
  'e2e/core.spec.js',
  'e2e/business.spec.js',
  'e2e/mcp-protocol.spec.js',
  'e2e/web-business.spec.js',
  'e2e/provider-matrix.spec.js',
  'e2e/message-recovery.spec.js',
  'e2e/security-isolation.spec.js',
];

function run(label, command, args, envPatch = null) {
  const started = performance.now();
  console.log(`[smoke] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: envPatch ? { ...process.env, ...envPatch } : process.env,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[smoke] ${label} failed after ${seconds}s`);
    process.exit(result.status || 1);
  }
  console.log(`[smoke] ${label} passed in ${seconds}s`);
}

function main() {
  const started = performance.now();
  run('TypeScript build', process.execPath, [path.join(__dirname, 'build-ts.js')]);
  run('i18n consistency', process.execPath, [path.join(__dirname, 'i18n-check.js')]);
  run('dispatcher main-path tests', process.execPath, [
    '--test',
    '--test-name-pattern',
    DISPATCHER_SMOKE_PATTERN,
    path.join(ROOT, 'test/lite-dispatcher-routing.test.js'),
  ]);
  run('core contract tests', process.execPath, [
    '--test',
    '--test-concurrency=4',
    ...NODE_TESTS.map((file) => path.join(ROOT, file)),
  ]);
  run('group message contract', process.execPath, [path.join(ROOT, 'test/group-message.test.js')]);
  run('Chromium main-path E2E', process.execPath, [
    PLAYWRIGHT_CLI,
    'test',
    ...E2E_SPECS,
    '--grep-invert',
    'timeout|1006|SENDACK|oversized',
  ], { VOKO_E2E_BROWSER: 'chromium' });
  console.log(`[smoke] completed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

try {
  main();
} catch (error) {
  console.error('[smoke] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
