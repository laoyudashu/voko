const test = require('node:test');
const assert = require('node:assert/strict');
const { nextE2eeMode, maySendPlaintext } = require('../build/e2ee/session-mode');

test('a trusted unsupported capability may remain plaintext before encryption', () => {
  const state = nextE2eeMode({ mode: 'plaintext', capability: 'unknown', everActive: false },
    { type: 'capability', evidence: 'unsupported' });
  assert.deepEqual(state, { mode: 'plaintext', capability: 'unsupported', everActive: false });
  assert.equal(maySendPlaintext(state), true);
});

test('an active encrypted conversation never downgrades when capability disappears', () => {
  const active = nextE2eeMode({ mode: 'e2ee_available', capability: 'supported', everActive: false }, { type: 'activate' });
  const changed = nextE2eeMode(active, { type: 'capability', evidence: 'unsupported' });
  assert.equal(changed.mode, 'e2ee_active');
  assert.equal(changed.capability, 'identity_changed');
  assert.equal(maySendPlaintext(changed), false);
});

test('timeout and handshake failure do not masquerade as unsupported', () => {
  const state = nextE2eeMode({ mode: 'e2ee_available', capability: 'supported', everActive: false },
    { type: 'capability', evidence: 'handshake_failed' });
  assert.equal(state.mode, 'e2ee_available');
  assert.equal(maySendPlaintext(state), false);
});

test('explicit plaintext requires a new conversation', () => {
  const required = nextE2eeMode({ mode: 'e2ee_active', capability: 'supported', everActive: true }, { type: 'require' });
  assert.equal(maySendPlaintext(required), false);
  assert.equal(maySendPlaintext(nextE2eeMode(required, { type: 'new_plaintext_conversation' })), true);
});
