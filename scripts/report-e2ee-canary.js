'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const reportsRoot = path.join(root, 'artifacts', 'real-tests');

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function ref(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('base64url').slice(0, 16);
}

function latestSummary() {
  const requested = arg('input');
  if (requested) {
    const resolved = path.resolve(root, requested);
    return fs.statSync(resolved).isDirectory() ? path.join(resolved, 'summary.json') : resolved;
  }
  const candidates = fs.readdirSync(reportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('e2ee-real-'))
    .map((entry) => path.join(reportsRoot, entry.name, 'summary.json'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates[0]) throw new Error('No real E2EE Canary summary was found');
  return candidates[0];
}

const input = latestSummary();
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const gates = JSON.parse(fs.readFileSync(path.join(root, 'e2ee', 'release-gates.json'), 'utf8'));
const checks = source.checks || {};
const participants = source.participants || {
  owner: ref(source.ownerScope || source.runId), agent: ref(source.serverAgentId),
  ownerDevice: ref(source.ownerDeviceKeyId || source.runId), browserDevice: ref(source.browserDeviceKeyId || source.runId),
};
const failures = Array.isArray(source.failures) ? source.failures.map((failure) => ({
  stage: String(failure.stage || 'unknown').slice(0, 80), code: String(failure.code || 'FAILED').slice(0, 80),
  message: String(failure.message || '').slice(0, 300),
})) : [];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runId: source.runId,
  platform: source.platform || 'win32',
  securityMode: source.securityMode || 'e2ee_tofu',
  productionEnabled: gates.productionEnabled,
  participants,
  evidence: {
    bidirectional: checks.realWuKongImBidirectional === true,
    restartRecovery: checks.restartRecovery === true,
    offlinePullRecovery: checks.offlinePullRecovery === true,
    duplicateReplayRejected: checks.duplicateReplayRejected === true,
    outOfOrderDelivery: checks.outOfOrderDelivery === true,
    credentialChangeFailClosed: checks.credentialChangeFailClosed === true,
    plaintextFallbacks: Number(checks.plaintextFallbacks ?? -1),
    capturedWirePlaintextHits: Number(checks.capturedWirePlaintextHits ?? -1),
  },
  gates: gates.gates.map(({ id, status }) => ({ id, status })),
  failures,
  passed: source.passed === true && failures.length === 0
    && checks.plaintextFallbacks === 0 && checks.capturedWirePlaintextHits === 0,
};
const output = path.resolve(root, arg('output') || 'artifacts/real-tests/e2ee-canary-latest-report.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed || report.productionEnabled !== false) process.exitCode = 1;
console.log(`E2EE Canary report: ${report.passed ? 'PASS' : 'FAIL'}; platform=${report.platform}; output=${output}`);
