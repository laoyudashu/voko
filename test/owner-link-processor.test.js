const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OwnerCommandProcessor, OwnerLinkStore, actionDigest, canonicalJson, initOwnerLinkDatabase, signOwnerEnvelope } = require('../build/owner-link');

function setup() {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-processor-')), 'owner.db'));
  const store = new OwnerLinkStore(db);
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  const expiresAt = new Date(now + 60_000).toISOString();
  const action = { type: 'message', text: 'Report status only.' };
  const envelope = signOwnerEnvelope({ version: 'voko.owner/1', kind: 'command', messageId: 'owner-message-1',
    ownerConversationId: 'owner-conversation-1', ownerIdentityId: 'owner-identity-1', ownerImUid: 'owner_im-1',
    agentId: 'agent-1', ownershipEpoch: 1, conversationEpoch: 1, sequence: 1, operation: 'execute',
    payload: { action, approval: { approvalId: 'owa_owner-message-1', actionDigest: actionDigest(action), expiresAt,
      enforcement: 'required_before_execute' } }, keyId: 'owner-key-1',
    createdAt: new Date(now - 1_000).toISOString(), expiresAt }, keys.privateKey);
  store.persistVerified(envelope, envelope.ownerImUid, now);
  return { db, store, envelope, keys, identity: { privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: 'agent-key-1', imUid: 'agent-im-1' } };
}

test('disabled Owner Provider dispatch leaves a persisted command claimable by Pull', async () => {
  const f = setup();
  try {
    const processor = new OwnerCommandProcessor({ store: f.store, dispatcher: {}, dispatchEnabled: false,
      resolveAgentIdentity: () => f.identity });
    assert.deepEqual(await processor.process(f.envelope.messageId), { status: 'held' });
    assert.equal(f.store.getCommand(f.envelope.messageId).state, 'PERSISTED');
  } finally { f.db.close(); }
});

test('Owner command uses one verified safe transport and persists its exact native session', async () => {
  const f = setup(); const calls = [];
  try {
    const dispatcher = {
      resolveTrustedOwnerTransport: () => ({ providerId: 'codex-cli', providerType: 'codex',
        providerInstanceId: 'codex-instance', deliveryMode: 'cli' }),
      async executeIsolated(options) { calls.push(options); return { reply: { content: 'All systems normal.' }, receipt: {
        deliveryReceipt: { nativeSessionId: 'native-owner-session', providerInstanceId: 'codex-instance' },
        provider: { providerId: 'codex-cli', providerType: 'codex', deliveryMode: 'cli' } } }; },
    };
    const processor = new OwnerCommandProcessor({ store: f.store, dispatcher, dispatchEnabled: true,
      resolveAgentIdentity: () => f.identity });
    const result = await processor.process(f.envelope.messageId);
    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executionScope, 'owner_link');
    assert.equal(calls[0].sourceType, 'owner');
    assert.equal(calls[0].binding, null);
    const binding = f.store.getActiveProviderBinding(f.envelope.ownerConversationId);
    assert.equal(binding.adapter_type, 'codex-cli');
    assert.equal(binding.native_session_id, 'native-owner-session');
    assert.equal(f.store.getCommand(f.envelope.messageId).state, 'COMPLETED');
    const events = f.db.prepare('SELECT producer_sequence,payload_json,status FROM owner_link_outbox ORDER BY producer_sequence').all();
    assert.deepEqual(events.map(row => row.producer_sequence), [1, 2, 3]);
    assert.deepEqual(events.map(row => JSON.parse(row.payload_json).operation), ['accepted', 'working', 'completed']);
    assert.ok(events.every(row => row.status === 'pending'));
    for (const row of events) {
      const signed = JSON.parse(row.payload_json);
      assert.equal(signed.payload.commandMessageId, f.envelope.messageId);
      assert.equal(signed.ownerImUid, f.envelope.ownerImUid);
      assert.equal(crypto.verify(null, Buffer.from(canonicalJson((({ signature, ...rest }) => rest)(signed))),
        f.keys.publicKey, Buffer.from(signed.signature, 'base64')), true);
    }
  } finally { f.db.close(); }
});

test('unknown Provider outcome is terminal for automatic retry and never changes transport', async () => {
  const f = setup(); let calls = 0;
  try {
    const dispatcher = {
      resolveTrustedOwnerTransport: () => ({ providerId: 'codex-cli', providerType: 'codex',
        providerInstanceId: 'codex-instance', deliveryMode: 'cli' }),
      async executeIsolated() { calls += 1; const error = new Error('connection closed'); error.deliveryOutcome = 'outcome_unknown'; throw error; },
    };
    const processor = new OwnerCommandProcessor({ store: f.store, dispatcher, dispatchEnabled: true,
      resolveAgentIdentity: () => f.identity });
    assert.equal((await processor.process(f.envelope.messageId)).status, 'outcome_unknown');
    assert.equal(f.store.getCommand(f.envelope.messageId).state, 'OUTCOME_UNKNOWN');
    assert.equal((await processor.process(f.envelope.messageId)).status, 'OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test('no exact-version full sandbox transport leaves the command for Pull without invoking a Provider', async () => {
  const f = setup(); let invoked = false;
  try {
    const processor = new OwnerCommandProcessor({ store: f.store, dispatcher: {
      resolveTrustedOwnerTransport: () => null,
      async executeIsolated() { invoked = true; },
    }, dispatchEnabled: true, resolveAgentIdentity: () => f.identity });
    assert.equal((await processor.process(f.envelope.messageId)).status, 'pull_required');
    assert.equal(invoked, false);
    assert.equal(f.store.getCommand(f.envelope.messageId).state, 'FAILED_NOT_DELIVERED');
  } finally { f.db.close(); }
});

test('missing Agent DID signing identity prevents automatic Provider execution', async () => {
  const f = setup(); let invoked = false;
  try {
    const processor = new OwnerCommandProcessor({ store: f.store, dispatcher: {
      resolveTrustedOwnerTransport: () => ({ providerId: 'codex-cli', providerType: 'codex',
        providerInstanceId: 'codex-instance', deliveryMode: 'cli' }),
      async executeIsolated() { invoked = true; },
    }, dispatchEnabled: true, resolveAgentIdentity: () => null });
    assert.equal((await processor.process(f.envelope.messageId)).status, 'signing_identity_required');
    assert.equal(invoked, false);
    assert.equal(f.store.getCommand(f.envelope.messageId).state, 'PERSISTED');
  } finally { f.db.close(); }
});
