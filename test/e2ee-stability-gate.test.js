'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { recordStabilityGate } = require('../scripts/record-e2ee-stability-gate');

function files(summary) {
  const directory = mkdtempSync(join(tmpdir(), 'voko-e2ee-gate-'));
  const manifestFile = join(directory, 'release-gates.json');
  const summaryFile = join(directory, 'summary.json');
  writeFileSync(manifestFile, JSON.stringify({
    productionEnabled: false,
    gates: [{ id: 'stability_30m', status: 'pending_local', evidence: 'pending' }],
  }));
  writeFileSync(summaryFile, JSON.stringify(summary));
  return { manifestFile, summaryFile };
}

function passingSummary() {
  return {
    commit: '0123456789abcdef0123456789abcdef01234567',
    platform: 'win32',
    arch: 'x64',
    passed: true,
    durationMs: 30 * 60 * 1000,
    messages: 1000,
    duplicatesRejected: 10,
    stateRecoveries: 2,
    pcsUpdates: 1,
    lost: 0,
    duplicateDeliveries: 0,
    crossedSessions: 0,
    startRssBytes: 8 * 1024 * 1024,
    peakRssBytes: 9 * 1024 * 1024,
    operationP95Micros: 250,
    messagesPerSecond: 400,
  };
}

test('records a stability gate only after the machine policy passes', () => {
  const paths = files(passingSummary());
  recordStabilityGate({ gateId: 'stability_30m', ...paths });
  const gate = JSON.parse(readFileSync(paths.manifestFile, 'utf8')).gates[0];
  assert.equal(gate.status, 'passed');
  assert.match(gate.evidence, /lost=0/);
  assert.match(gate.evidence, /rssPeak=/);
});

test('does not modify the manifest when the run is too short or lossy', () => {
  const summary = passingSummary();
  summary.durationMs = 5000;
  summary.lost = 1;
  const paths = files(summary);
  const before = readFileSync(paths.manifestFile, 'utf8');
  assert.throws(() => recordStabilityGate({ gateId: 'stability_30m', ...paths }), /stability gate failed/);
  assert.equal(readFileSync(paths.manifestFile, 'utf8'), before);
});
