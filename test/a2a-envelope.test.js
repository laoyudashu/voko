'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { canonicalJson, signEnvelope, validateEnvelope, verifyEnvelope } = require('../build/a2a');

const now = Date.now();
function envelope() { return { version: 'voko.a2a/1', kind: 'request', operation: 'execute', eventId: 'evt-1',
  gatewayTaskId: 'task-1', contextId: 'ctx-1', gatewayMessageId: 'msg-1', executionId: 'exec-1', sequence: 1,
  agentId: 'agent-1', caller: { principalId: 'p-1', actorKind: 'agent', provenance: 'registered' },
  payload: { text: 'hello' }, trace: { correlationId: 'trace-1' }, timestamps: {
    createdAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString() } }; }

test('canonical JSON sorts nested object keys', () => assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}'));
test('Ed25519 signature detects envelope tampering', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signEnvelope(envelope(), 'gateway-key-1', privateKey);
  assert.equal(verifyEnvelope(signed, publicKey, { now }), true);
  assert.equal(verifyEnvelope({ ...signed, sequence: 2 }, publicKey, { now }), false);
});
test('expired and oversized-lifetime envelopes fail closed', () => {
  assert.throws(() => validateEnvelope(envelope(), { now: now + 300_001 }), /Expired/);
  const value = envelope(); value.timestamps.expiresAt = new Date(now + 86_400_001).toISOString();
  assert.throws(() => validateEnvelope(value, { now }), /Expired/);
});
