'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { RegistrationOrchestrator } = require('../build/core/registration-orchestrator');
const { runWithRegistrationCaller } = require('../build/core/registration-caller-context');
const { probeRuntimeIdentity } = require('../build/core/runtime-probe');
const { normalizeRegistrationNetworkError } = require('../build/core/agent-registration');

const ENTRY = path.join(__dirname, '..', 'build', 'index.js');

function createService(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)');
  const service = new RegistrationOrchestrator({
    db,
    getLoggedEmail: () => 'owner@example.test',
    sendCode: async () => ({ success: true }),
    loginByCode: async () => ({ success: true }),
    ...overrides,
  });
  return { db, service };
}

test('tool help is available without a runtime or database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-registration-help-'));
  try {
    const result = spawnSync(process.execPath, [
      ENTRY, 'manage_agent_registration', '--help', '--db', path.join(dir, 'voko.db'),
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--action/);
    assert.match(result.stdout, /--registrationId/);
    assert.equal(fs.existsSync(path.join(dir, 'voko.db')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status without registrationId returns a stable parameter error', async () => {
  const { db, service } = createService();
  try {
    const result = await service.manage({ action: 'status' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'REGISTRATION_ID_REQUIRED');
    assert.doesNotMatch(result.error, /Cannot read properties/);
  } finally {
    db.close();
  }
});

test('MCP cannot self-assert trusted human registration mode', async () => {
  const { db, service } = createService();
  try {
    const result = await runWithRegistrationCaller(
      { source: 'mcp', providerType: 'openclaw' },
      () => service.start({ registrationMode: 'human' }),
    );
    assert.equal(result.success, false);
    assert.equal(result.code, 'REGISTRATION_MODE_NOT_ALLOWED');
  } finally {
    db.close();
  }
});

test('status omits the full environment while explicit inspection returns it', async () => {
  const { db, service } = createService();
  try {
    const environment = {
      detected: Array.from({ length: 20 }, (_, index) => ({
        type: `provider-${index}`,
        instances: Array.from({ length: 5 }, (_unused, instance) => ({ id: `${index}-${instance}` })),
        diagnostics: 'x'.repeat(1_000),
      })),
    };
    service.inspectEnvironment = () => environment;
    const started = await service.start({ registrationMode: 'agent' });
    const status = await service.manage({ action: 'status', registrationId: started.registrationId });

    const inspected = await service.manage({ action: 'inspect_environment', registrationId: started.registrationId });
    assert.equal(status.environment, undefined);
    assert.ok(JSON.stringify(status).length < 2_000);
    assert.equal(started.environment.detected[0].diagnostics, undefined);
    assert.deepEqual(inspected.environment, environment);
  } finally {
    db.close();
  }
});

test('runtime identity probing retries a starting runtime and remains bounded', async () => {
  let attempts = 0;
  const result = await probeRuntimeIdentity({
    port: 3210,
    instance: { instanceId: 'expected', pid: 12, port: 3210 },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({
        status: 'ok', instanceId: 'expected', pid: 12, port: 3210, version: '0.5.0', edition: 'lite',
      }) };
    },
    retryDelayMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});

test('registration network errors expose a stable stage and cause', () => {
  const error = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  const result = normalizeRegistrationNetworkError(error, 'verify_email');
  assert.deepEqual(result, {
    success: false,
    code: 'REGISTRATION_NETWORK_ERROR',
    retryable: true,
    stage: 'verify_email',
    cause: 'DNS_FAILURE',
    error: 'fetch failed',
  });
});
