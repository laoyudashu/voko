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
