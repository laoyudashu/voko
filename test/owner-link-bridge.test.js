const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OwnerLinkBridge, actionDigest, initOwnerLinkDatabase, matchesLocalAgentIdentity, signOwnerEnvelope } = require('../build/owner-link');

function createFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-bridge-'));
  const db = initOwnerLinkDatabase(path.join(dir, 'owner.db'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  const make = (overrides = {}) => {
    const messageId = overrides.messageId || 'owner-msg-1'; const expiresAt = new Date(now + 60_000).toISOString();
    const action = { type: 'message', text: 'Report status.' };
    const payload = overrides.payload || { action, approval: { approvalId: `owa_${messageId}`,
      actionDigest: actionDigest(action), expiresAt, enforcement: 'required_before_execute' } };
    return signOwnerEnvelope({ version: 'voko.owner/1', kind: 'command', messageId,
      ownerConversationId: 'owner-conversation-1', ownerIdentityId: 'owner-identity-1',
      ownerImUid: 'owner_abcdefgh', agentId: 'agent-1', ownershipEpoch: 1, conversationEpoch: 1,
      sequence: 1, operation: 'execute', createdAt: new Date(now - 1000).toISOString(),
      expiresAt, payload, keyId: 'owner-key-1', ...overrides }, keys.privateKey);
  };
  const bridge = new OwnerLinkBridge({ database: db, now: () => now,
    resolvePublicKey: (id) => id === 'owner-key-1' ? keys.publicKey : null, ...options });
  return { db, bridge, make, now, close: () => db.close() };
}

function wire(envelope) { return JSON.stringify(envelope); }

test('ordinary visitor messages are not consumed by Owner Link', () => {
  const f = createFixture();
  try { assert.deepEqual(f.bridge.handleInbound('agent-1', { fromUid: 'visitor-1', content: 'hello' }), { handled: false }); }
  finally { f.close(); }
});

test('valid reserved Owner message is verified and persisted before acknowledgement', () => {
  const f = createFixture();
  try {
    const envelope = f.make();
    assert.deepEqual(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', clientMsgNo: envelope.messageId,
      content: wire(envelope) }), { handled: true, accepted: true, state: 'PERSISTED' });
    assert.equal(f.db.prepare('SELECT state FROM owner_link_commands WHERE message_id=?').get(envelope.messageId).state, 'PERSISTED');
  } finally { f.close(); }
});

test('unsigned or malformed messages from reserved Owner identities are hard rejected', () => {
  const f = createFixture();
  try {
    const result = f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', content: 'visitor-like text' });
    assert.equal(result.handled, true);
    assert.equal(result.accepted, false);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM owner_link_commands').get().count, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM owner_link_security_events').get().count, 1);
  } finally { f.close(); }
});

test('owner envelope cannot target another local Agent or change transport message ID', () => {
  const f = createFixture();
  try {
    const envelope = f.make();
    assert.equal(f.bridge.handleInbound('agent-2', { fromUid: 'owner_abcdefgh', content: wire(envelope) }).code, 'OWNER_AGENT_MISMATCH');
    assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', clientMsgNo: 'other', content: wire(envelope) }).code,
      'OWNER_TRANSPORT_MESSAGE_ID_MISMATCH');
  } finally { f.close(); }
});

test('an injected authoritative mapping can match local Agent ID to AgentDID UUID', () => {
  const remoteAgentId = '2b4a3c62-efba-4c97-add9-6f09ee092462';
  const f = createFixture({ matchesAgentId: (localAgentId, envelopeAgentId) =>
    localAgentId === 'gym' && envelopeAgentId === remoteAgentId });
  try {
    const envelope = f.make({ agentId: remoteAgentId });
    assert.equal(f.bridge.handleInbound('gym', { fromUid: envelope.ownerImUid,
      clientMsgNo: envelope.messageId, content: wire(envelope) }).accepted, true);
    assert.equal(f.bridge.handleInbound('other-local-agent', { fromUid: envelope.ownerImUid,
      clientMsgNo: envelope.messageId, content: wire(envelope) }).code, 'OWNER_AGENT_MISMATCH');
  } finally { f.close(); }
});

test('Agent identity mapping only accepts the exact UUID encoded by the local DID', () => {
  const agentId = '2b4a3c62-efba-4c97-add9-6f09ee092462';
  assert.equal(matchesLocalAgentIdentity('gym', 'did:wba:example.test:2b4a3c62efba4c97add96f09ee092462', agentId), true);
  assert.equal(matchesLocalAgentIdentity(agentId, null, agentId), true);
  assert.equal(matchesLocalAgentIdentity('gym', 'did:wba:example.test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentId), false);
  assert.equal(matchesLocalAgentIdentity('gym', 'not-a-did:2b4a3c62efba4c97add96f09ee092462', agentId), false);
  assert.equal(matchesLocalAgentIdentity('gym', 'did:wba:example.test:2b4a3c62efba4c97add96f09ee092462', 'gym'), true);
  assert.equal(matchesLocalAgentIdentity('gym', 'did:wba:example.test:2b4a3c62efba4c97add96f09ee092462', 'other'), false);
});

test('tampered signature, unknown key and expired envelope never fall through', () => {
  const f = createFixture();
  try {
    const envelope = f.make();
    const tampered = { ...envelope, signature: Buffer.alloc(64, 1).toString('base64') };
    assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', content: wire(tampered) }).handled, true);
    const unknown = { ...envelope, keyId: 'unknown-key' };
    assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', content: wire(unknown) }).code, 'OWNER_KEY_UNKNOWN');
    const expired = f.make({ createdAt: new Date(f.now - 120_000).toISOString(), expiresAt: new Date(f.now - 60_000).toISOString() });
    assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', content: wire(expired) }).handled, true);
  } finally { f.close(); }
});

test('sequence window is bounded while limited out-of-order delivery remains valid', () => {
  const f = createFixture();
  try {
    for (const sequence of [1, 3, 2]) {
      const envelope = f.make({ messageId: `owner-msg-${sequence}`, sequence });
      assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', clientMsgNo: envelope.messageId,
        content: wire(envelope) }).accepted, true);
    }
    const far = f.make({ messageId: 'owner-msg-99', sequence: 99 });
    assert.equal(f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', clientMsgNo: far.messageId,
      content: wire(far) }).code, 'OWNER_SEQUENCE_WINDOW_EXCEEDED');
  } finally { f.close(); }
});

test('database failures are NACK candidates rather than security-drop acknowledgements', () => {
  const f = createFixture();
  try {
    f.db.close();
    const envelope = f.make();
    assert.throws(() => f.bridge.handleInbound('agent-1', { fromUid: 'owner_abcdefgh', content: wire(envelope) }));
  } finally { try { f.close(); } catch (_) {} }
});

test('new Owner commands notify the processor once while replay remains idempotent', async () => {
  const f = createFixture(); const handled = [];
  try {
    f.bridge.setCommandHandler(messageId => handled.push(messageId));
    const envelope = f.make();
    const message = { fromUid: envelope.ownerImUid, clientMsgNo: envelope.messageId, content: wire(envelope) };
    assert.equal(f.bridge.handleInbound('agent-1', message).accepted, true);
    assert.equal(f.bridge.handleInbound('agent-1', message).accepted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(handled, [envelope.messageId]);
  } finally { f.close(); }
});

test('a gateway-signed execute command with mismatched approval digest is rejected before persistence', () => {
  const f = createFixture();
  try {
    const action = { type: 'message', text: 'Report status.' };
    const envelope = f.make({ payload: { action, approval: { approvalId: 'owa_bad-digest',
      actionDigest: '0'.repeat(64), expiresAt: new Date(f.now + 60_000).toISOString(),
      enforcement: 'required_before_execute' } } });
    const result = f.bridge.handleInbound('agent-1', { fromUid: envelope.ownerImUid,
      clientMsgNo: envelope.messageId, content: wire(envelope) });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'OWNER_APPROVAL_DIGEST_MISMATCH');
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM owner_link_commands').get().count, 0);
  } finally { f.close(); }
});

test('approve and reject are Portal-only operations and never enter the IM command path', () => {
  const f = createFixture();
  try {
    for (const operation of ['approve', 'reject']) {
      assert.throws(() => f.make({ operation }), /OWNER_ENVELOPE_UNSUPPORTED/);
    }
  } finally { f.close(); }
});
