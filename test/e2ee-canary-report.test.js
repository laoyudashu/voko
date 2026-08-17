'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('Canary report redacts legacy identifiers and records gates and wire checks', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-canary-report-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, 'summary.json');
  const output = path.join(temp, 'report.json');
  fs.writeFileSync(input, JSON.stringify({ runId: 'run-1', platform: 'linux', serverAgentId: 'secret-agent-id',
    passed: true, checks: { realWuKongImBidirectional: true, restartRecovery: true, offlinePullRecovery: true,
      duplicateReplayRejected: true, outOfOrderDelivery: true, credentialChangeFailClosed: true,
      plaintextFallbacks: 0, capturedWirePlaintextHits: 0 } }));
  execFileSync(process.execPath, ['scripts/report-e2ee-canary.js', `--input=${input}`, `--output=${output}`], { cwd: root });
  const reportText = fs.readFileSync(output, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.passed, true);
  assert.equal(report.platform, 'linux');
  assert.equal(report.productionEnabled, false);
  assert.equal(report.evidence.plaintextFallbacks, 0);
  assert.ok(report.gates.some((gate) => gate.id === 'stability_4h' && gate.status === 'pending_local'));
  assert.doesNotMatch(reportText, /secret-agent-id/);
  assert.match(report.participants.agent, /^[A-Za-z0-9_-]{16}$/);
});
