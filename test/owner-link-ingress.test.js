const assert = require('node:assert/strict');
const test = require('node:test');
const { OwnerLinkIngress } = require('../build/owner-link');

test('disabled Owner Link still hard-rejects reserved Owner identities', () => {
  const ingress = new OwnerLinkIngress(null);
  assert.deepEqual(ingress.handle('agent-1', { fromUid: 'owner_abcdefgh', content: 'not signed' }),
    { handled: true, accepted: false, code: 'OWNER_LINK_DISABLED' });
});

test('disabled Owner Link leaves ordinary visitors untouched', () => {
  const ingress = new OwnerLinkIngress(null);
  assert.deepEqual(ingress.handle('agent-1', { fromUid: 'visitor-1', content: 'hello' }), { handled: false });
});

test('enabled ingress delegates reserved messages to the verified bridge only', () => {
  const calls = [];
  const bridge = {
    isReservedOwnerSender: (uid) => uid === 'previously-bound-owner',
    handleInbound: (agentId, message) => { calls.push({ agentId, message }); return { handled: true, accepted: true, state: 'PERSISTED' }; },
  };
  const ingress = new OwnerLinkIngress(bridge);
  assert.equal(ingress.handle('agent-1', { fromUid: 'previously-bound-owner', content: '{}' }).accepted, true);
  assert.equal(calls.length, 1);
});
