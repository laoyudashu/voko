'use strict';

const { readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { validateStabilitySummary } = require('./e2ee-stability-policy');

const REQUIRED_DURATIONS = Object.freeze({
  stability_30m: 30 * 60 * 1000,
  stability_4h: 4 * 60 * 60 * 1000,
});

function formatManifest(manifest) {
  const gates = manifest.gates.map((gate) => (
    `    { "id": ${JSON.stringify(gate.id)}, "status": ${JSON.stringify(gate.status)}, "evidence": ${JSON.stringify(gate.evidence)} }`
  )).join(',\n');
  return [
    '{',
    `  "schemaVersion": ${JSON.stringify(manifest.schemaVersion)},`,
    `  "securityClaim": ${JSON.stringify(manifest.securityClaim)},`,
    `  "productionEnabled": ${JSON.stringify(manifest.productionEnabled)},`,
    '  "gates": [',
    gates,
    '  ]',
    '}',
    '',
  ].join('\n');
}

function recordStabilityGate({ gateId, summaryFile, manifestFile }) {
  const requiredDuration = REQUIRED_DURATIONS[gateId];
  if (!requiredDuration) throw new Error(`Unsupported stability gate: ${gateId}`);

  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  if (summary.diagnosticOnly || summary.worktreeDirty) {
    throw new Error('Diagnostic or dirty-worktree evidence cannot update a release gate');
  }
  validateStabilitySummary(summary, requiredDuration);

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const gate = manifest.gates?.find((candidate) => candidate.id === gateId);
  if (!gate) throw new Error(`Missing release gate: ${gateId}`);
  if (manifest.productionEnabled) throw new Error('Refusing to edit an enabled production manifest');

  gate.status = 'passed';
  gate.evidence = [
    `commit=${summary.commit}`,
    `platform=${summary.platform}/${summary.arch}`,
    `durationMs=${summary.durationMs}`,
    `messages=${summary.messages}`,
    `lost=${summary.lost}`,
    `duplicateDeliveries=${summary.duplicateDeliveries}`,
    `crossedSessions=${summary.crossedSessions}`,
    `rssStart=${summary.startRssBytes}`,
    `rssPeak=${summary.peakRssBytes}`,
    `p95Micros=${summary.operationP95Micros}`,
    `messagesPerSecond=${Number(summary.messagesPerSecond).toFixed(2)}`,
  ].join('; ');

  const temporary = resolve(dirname(manifestFile), `.release-gates-${process.pid}.tmp`);
  writeFileSync(temporary, formatManifest(manifest), { flag: 'wx' });
  renameSync(temporary, manifestFile);
  return gate;
}

if (require.main === module) {
  const [gateId, summary = 'e2ee-stability-summary.json'] = process.argv.slice(2);
  if (!gateId) throw new Error('Usage: record-e2ee-stability-gate <stability_30m|stability_4h> [summary]');
  const root = resolve(__dirname, '..');
  const gate = recordStabilityGate({
    gateId,
    summaryFile: resolve(root, summary),
    manifestFile: resolve(root, 'e2ee', 'release-gates.json'),
  });
  console.log(`Recorded ${gate.id}: ${gate.evidence}`);
}

module.exports = { recordStabilityGate };
