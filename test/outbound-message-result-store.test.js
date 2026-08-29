const test = require('node:test');
const assert = require('node:assert/strict');

const { OutboundMessageResultStore, normalizeTurnReceipt } = require('../build/core/outbound-message-result-store');

function receipt(overrides = {}) {
  return { version: 1, sourceMessageIds: ['message-1'], turnId: 'turn-1', sequence: 1,
    state: 'SUBMITTED', phase: 'receiver', occurredAt: Date.now(), ...overrides };
}

test('validates bounded hidden turn receipts', () => {
  assert.ok(normalizeTurnReceipt(receipt()));
  assert.equal(normalizeTurnReceipt(receipt({ sourceMessageIds: [] })), null);
  assert.equal(normalizeTurnReceipt(receipt({ sourceMessageIds: Array.from({ length: 11 }, (_, i) => `m-${i}`) })), null);
  assert.equal(normalizeTurnReceipt(receipt({ reasonCode: 'not normalized' })), null);
  assert.equal(normalizeTurnReceipt(receipt({ occurredAt: Date.now() + 10 * 60 * 1000 })), null);
});

test('applies only scoped, increasing receipts and protects terminal results', () => {
  const store = new OutboundMessageResultStore();
  store.register('agent-1', 'message-1', 'agent-peer');
  assert.equal(store.apply('agent-1', 'wrong-peer', receipt()), 0);
  assert.equal(store.apply('agent-1', 'agent-peer', receipt()), 1);
  assert.equal(store.apply('agent-1', 'agent-peer', receipt({ sequence: 1, state: 'WORKING', phase: 'provider' })), 0);
  assert.equal(store.apply('agent-1', 'agent-peer', receipt({ sequence: 2, state: 'FAILED', phase: 'provider' })), 1);
  assert.equal(store.apply('agent-1', 'agent-peer', receipt({ sequence: 3, state: 'COMPLETED', phase: 'reply' })), 0);
  assert.equal(store.get('agent-1', 'message-1').state, 'FAILED');
});

test('allows a later confirmed reply to resolve delivery unknown', () => {
  const store = new OutboundMessageResultStore();
  store.register('agent-1', 'message-1', 'agent-peer');
  store.apply('agent-1', 'agent-peer', receipt({ state: 'DELIVERY_UNKNOWN', phase: 'reply' }));
  assert.equal(store.apply('agent-1', 'agent-peer', receipt({ sequence: 2, state: 'COMPLETED', phase: 'reply', replyMessageId: 'reply-1' })), 1);
  assert.equal(store.get('agent-1', 'message-1').replyMessageId, 'reply-1');
});
