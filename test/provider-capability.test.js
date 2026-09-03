'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { snapshotFromProvider, redactedInvocation } = require('../build/core/provider-capability');

test('capability snapshot binds controls to a redacted runtime fingerprint', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-capability-'));
  const executable = path.join(dir, 'codebuddy');
  fs.writeFileSync(executable, 'runtime');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = {
    _resolveRuntime: () => ({ available: true, executable, canonicalPath: executable }),
    getSecurityControlEvidence: () => ({ runtimeVersion: process.platform === 'darwin' ? '2.139.0' : '2.141.0', versionVerified: true }),
  };
  const snapshot = snapshotFromProvider(provider, 'workbuddy-http', 'agent-1');
  assert.equal(snapshot.runtimeVersion, process.platform === 'darwin' ? '2.139.0' : '2.141.0');
  assert.equal(['static_compatible','unknown'].includes(snapshot.evidenceState), true);
  assert.equal(snapshot.runtimeFingerprint.includes(executable), false);
  assert.equal(snapshot.supportedControls.dataFileAccess.boundary, 'not_enforced');
  assert.equal(snapshot.supportedControls.shell, undefined);
});

test('shared invocation planner labels WorkBuddy allowedTools as high-risk preapproval', () => {
  const preview = redactedInvocation('workbuddy-http', {
    dataFileAccess: 'read', sessionPersistence: 'conversation', mcpProfile: 'isolated',
  });
  assert.equal(preview.some(item => item.text === '--tools Read' && item.risk === 'high'), true);
  assert.equal(preview.some(item => /仅自动审批，非路径隔离/.test(item.text) && item.risk === 'high'), true);
});

test('shared invocation planner covers native and prompt-only Provider transports', () => {
  assert.equal(redactedInvocation('hermes-cli', { toolProfile: 'default', approvalMode: 'bypass', acceptHooks: 'enabled' })
    .some(item => item.text === '--yolo' && item.risk === 'high' && item.sourceControl === 'approvalMode'), true);
  assert.equal(redactedInvocation('claude-cli', { toolAccess: 'read_only', browser: 'disabled' })
    .some(item => /--tools Read,Grep,Glob/.test(item.text) && item.sourceControl === 'toolAccess'), true);
  assert.equal(redactedInvocation('codex-cli', { sandboxMode: 'workspace_write' })
    .some(item => item.text === 'workspace-write' && item.risk === 'high'), true);
  assert.equal(redactedInvocation('goose-cli', { extensionProfile: 'disabled' })
    .some(item => item.sourceControl === 'extensionProfile'), true);
  assert.equal(redactedInvocation('grok-cli', { additionalPrompt: 'visitor' })
    .some(item => item.sourceControl === 'additionalPrompt'), true);
});

test('a verified delivery probe exposes only controls backed by the adapter contract', () => {
  const provider = {
    isAvailable: () => true,
    getDeliveryReadiness: () => ({ verificationStatus: 'loopback_verified' }),
  };
  const hermes = snapshotFromProvider(provider, 'hermes-cli', 'agent-1');
  assert.deepEqual(Object.keys(hermes.supportedControls),
    ['toolProfile', 'safeMode', 'approvalMode', 'acceptHooks', 'additionalPrompt']);
  const grok = snapshotFromProvider(provider, 'grok-cli', 'agent-1');
  assert.deepEqual(Object.keys(grok.supportedControls), ['additionalPrompt']);
});

test('runtime identity and version probing preserve the Agent scope', () => {
  const calls = [];
  const provider = {
    isAvailable: agentId => { calls.push(agentId); return agentId === 'agent-bound'; },
    getProviderVersion: () => ({ version: '0.20.2', source: 'command', result: 'known' }),
  };
  const snapshot = snapshotFromProvider(provider, 'hermes-cli', 'agent-bound');
  assert.deepEqual(calls, ['agent-bound']);
  assert.equal(snapshot.runtimeVersion, '0.20.2');
  assert.equal(snapshot.frameworkVersion, '0.20.2');
  if (process.platform === 'darwin') {
    assert.equal(snapshot.evidenceState, 'static_compatible');
    assert.equal(snapshot.supportedControls.approvalMode.enforcement, 'provider_enforced');
  }
});
