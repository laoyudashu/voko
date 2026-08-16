'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, validateStabilitySummary } = require('../scripts/e2ee-stability-policy');

function summary(overrides = {}) {
  return {
    commit: '0123456789abcdef0123456789abcdef01234567', platform: 'win32', arch: 'x64',
    passed: true, durationMs: 1_800_000, messages: 100,
    duplicatesRejected: 1, stateRecoveries: 1, pcsUpdates: 1,
    lost: 0, duplicateDeliveries: 0, crossedSessions: 0,
    startRssBytes: 8_000_000, peakRssBytes: 9_000_000,
    operationP95Micros: 250, messagesPerSecond: 400,
    ...overrides,
  };
}

test('stability policy accepts bounded 30-minute evidence', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.doesNotThrow(() => validateStabilitySummary(summary(), parseDuration('30m')));
});

test('stability policy rejects loss, missing faults and resource regressions', () => {
  assert.throws(() => validateStabilitySummary(summary({ commit: '' }), parseDuration('30m')), /tested commit/);
  assert.throws(() => validateStabilitySummary(summary({ lost: 1 }), parseDuration('30m')), /lost must be zero/);
  assert.throws(() => validateStabilitySummary(summary({ pcsUpdates: 0 }), parseDuration('30m')), /pcsUpdates was not exercised/);
  assert.throws(() => validateStabilitySummary(summary({ peakRssBytes: 50_000_000 }), parseDuration('30m')), /RSS increase exceeds/);
  assert.throws(() => validateStabilitySummary(summary({ operationP95Micros: 5_001 }), parseDuration('5s')), /operation P95/);
});
