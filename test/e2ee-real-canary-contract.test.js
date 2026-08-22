'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'real-e2ee-canary.js'), 'utf8');

test('real E2EE Canary is restricted to allowlisted Windows and Linux devices and uses contentType 13', () => {
  assert.match(source, /\['win32', 'linux'\]\.includes\(process\.platform\)/);
  assert.match(source, /status\.platforms\.includes\(process\.platform\)/);
  assert.match(source, /VOKO_E2EE_CANARY_ALLOW_AGENT_SESSION/);
  assert.match(source, /CONTENT_TYPE_E2EE = 13/);
});

test('real E2EE Canary emits redacted success and failure diagnostics', () => {
  assert.match(source, /participants: \{ owner: opaqueRef/);
  assert.match(source, /schemaVersion: 2/);
  assert.match(source, /failures: \[\{ stage: 'canary'/);
  assert.doesNotMatch(source, /serverAgentId: config\.serverAgentId/);
});

test('real E2EE Canary uses AgentDID establishment and real WuKongIM without plaintext fallback', () => {
  for (const pathFragment of ['e2ee/key-packages', 'e2ee/establishments', 'messages/fetch']) assert.ok(source.includes(pathFragment));
  assert.match(source, /new VokoIMClient/);
  assert.match(source, /sendRaw/);
  assert.match(source, /plaintextFallbacks: 0/);
  assert.match(source, /assertNoPlaintext/);
});

test('real E2EE Canary covers delivery recovery and fail-closed identity boundaries', () => {
  for (const check of ['idempotentRetry', 'duplicateReplayRejected', 'outOfOrderDelivery',
    'offlinePullRecovery', 'credentialChangeFailClosed', 'keyPackageExhaustionFailClosed']) {
    assert.match(source, new RegExp(`${check}: true`));
  }
  assert.match(source, /identity_changed/);
  assert.match(source, /KEY_PACKAGE_UNAVAILABLE/);
});

test('real E2EE Canary proves the deployed allowlist rejects other Agents and devices', () => {
  assert.match(source, /nonAllowlistedDeviceRejected: true/);
  assert.match(source, /nonAllowlistedAgentRejected: true/);
  assert.match(source, /-not-allowlisted/);
});
