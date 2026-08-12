const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OwnerLinkModule, OwnerLinkSecurityError, OwnerLinkStore, digestPayload, initOwnerLinkDatabase,
  parseOwnerEnvelopeJson, resolveOwnerLinkDatabasePath, signOwnerEnvelope, verifyOwnerEnvelope } = require('../build/owner-link');

function fixture(now = Date.now(), overrides = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const messageId = overrides.messageId || 'omsg-1';
  const expiresAt = new Date(now + 60_000).toISOString();
  const action = { type: 'message', text: 'Read the current status only.' };
  const payload = overrides.payload || { action, approval: { approvalId: `owa_${messageId.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    actionDigest: digestPayload(action), expiresAt, enforcement: 'required_before_execute' } };
  const unsigned = {
    version: 'voko.owner/1', kind: overrides.kind || 'command',
    messageId, ownerConversationId: overrides.ownerConversationId || 'oconv-1',
    ownerIdentityId: overrides.ownerIdentityId || 'oid-1', ownerImUid: overrides.ownerImUid || 'owner_im-1',
    agentId: overrides.agentId || 'agent-1', operation: overrides.operation || 'execute',
    ownershipEpoch: overrides.ownershipEpoch || 1, conversationEpoch: overrides.conversationEpoch || 1,
    sequence: overrides.sequence || 1, createdAt: new Date(now - 1000).toISOString(),
    expiresAt, payload, keyId: 'owner-key-1',
  };
  return { envelope: signOwnerEnvelope(unsigned, privateKey), privateKey, publicKey, now };
}

function wire(envelope) { return JSON.stringify(envelope); }

test('Owner Link is disabled by default and does not create its database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-disabled-'));
  const databasePath = path.join(dir, 'owner.db');
  const module = new OwnerLinkModule({ databasePath, env: {} });
  assert.equal(module.enabled, false);
  assert.equal(module.start(), undefined);
  assert.equal(fs.existsSync(databasePath), false);
});

test('Owner Link uses a separate cross-platform database path', () => {
  assert.equal(resolveOwnerLinkDatabasePath({ platform: 'win32', env: { APPDATA: 'C:\\Data' }, homeDir: 'C:\\Home' }), 'C:\\Data\\voko\\voko-owner.db');
  assert.equal(resolveOwnerLinkDatabasePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, homeDir: '/home/u' }), '/cfg/voko/voko-owner.db');
  assert.equal(resolveOwnerLinkDatabasePath({ platform: 'darwin', env: {}, homeDir: '/Users/u' }), '/Users/u/Library/Application Support/voko/voko-owner.db');
});

test('strict parser rejects duplicate keys and unknown fields', () => {
  const { envelope } = fixture();
  const duplicate = wire(envelope).replace('"messageId":"omsg-1"', '"messageId":"omsg-1","messageId":"omsg-2"');
  assert.throws(() => parseOwnerEnvelopeJson(duplicate), /OWNER_JSON_DUPLICATE_KEY/);
  assert.throws(() => parseOwnerEnvelopeJson(JSON.stringify({ ...envelope, extra: true })), /OWNER_ENVELOPE_ADDITIONAL_PROPERTY/);
});

test('signature covers payload digest, identity, epoch and algorithm', () => {
  const { envelope, publicKey, now } = fixture();
  assert.equal(verifyOwnerEnvelope(parseOwnerEnvelopeJson(wire(envelope), { now }), () => publicKey, { now }), true);
  assert.throws(() => parseOwnerEnvelopeJson(wire({ ...envelope, payload: { text: 'changed' } }), { now }), /OWNER_DIGEST_MISMATCH/);
  assert.equal(verifyOwnerEnvelope({ ...envelope, ownershipEpoch: 2 }, () => publicKey, { now }), false);
  assert.throws(() => parseOwnerEnvelopeJson(wire({ ...envelope, algorithm: 'none' }), { now }), /OWNER_ALGORITHM_UNSUPPORTED/);
});

test('store persists receipt before dispatch and treats same digest as idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-store-'));
  const db = initOwnerLinkDatabase(path.join(dir, 'owner.db'));
  try {
    const store = new OwnerLinkStore(db);
    const { envelope } = fixture();
    assert.deepEqual(store.persistVerified(envelope, 'owner-im-1'), { status: 'inserted', state: 'PERSISTED' });
    assert.deepEqual(store.persistVerified(envelope, 'owner-im-1'), { status: 'duplicate', state: 'PERSISTED' });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM owner_link_commands').get().count, 1);
    assert.deepEqual(db.prepare('SELECT to_state FROM owner_link_command_events ORDER BY id').all().map((row) => row.to_state), ['VERIFIED','PERSISTED']);
  } finally { db.close(); }
});

test('store rejects conflicting message IDs, sequence reuse and observed IM identity changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-conflict-'));
  const db = initOwnerLinkDatabase(path.join(dir, 'owner.db'));
  try {
    const store = new OwnerLinkStore(db);
    const first = fixture();
    store.persistVerified(first.envelope, 'owner-im-1');
    const changed = fixture(first.now, { payload: (() => { const action = { type: 'message', text: 'different' }; return {
      action, approval: { approvalId: 'owa_omsg-1', actionDigest: digestPayload(action),
        expiresAt: new Date(first.now + 60_000).toISOString(), enforcement: 'required_before_execute' } }; })() }).envelope;
    assert.throws(() => store.persistVerified(changed, 'owner-im-1'), (error) => error instanceof OwnerLinkSecurityError && error.code === 'OWNER_MESSAGE_ID_DIGEST_CONFLICT');
    const sameSequence = fixture(first.now, { messageId: 'omsg-2' }).envelope;
    assert.throws(() => store.persistVerified(sameSequence, 'owner-im-1'), /OWNER_SEQUENCE_CONFLICT/);
    const next = fixture(first.now, { messageId: 'omsg-3', sequence: 2 }).envelope;
    assert.throws(() => store.persistVerified(next, 'forged-owner-im'), /OWNER_BINDING_MISMATCH/);
    assert.deepEqual(db.prepare('SELECT code FROM owner_link_security_events ORDER BY id').all().map((row) => row.code),
      ['OWNER_MESSAGE_ID_DIGEST_CONFLICT','OWNER_SEQUENCE_CONFLICT','OWNER_BINDING_MISMATCH']);
  } finally { db.close(); }
});

test('CAS lease permits one dispatcher and prevents retry after unknown outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-lease-'));
  const db = initOwnerLinkDatabase(path.join(dir, 'owner.db'));
  try {
    const store = new OwnerLinkStore(db);
    store.persistVerified(fixture().envelope, 'owner-im-1');
    assert.equal(store.acquireDispatchLease('omsg-1', 'worker-a'), true);
    assert.equal(store.acquireDispatchLease('omsg-1', 'worker-b'), false);
    assert.equal(store.markOutcomeUnknown('omsg-1', 'worker-b', 'disconnect'), false);
    assert.equal(store.markOutcomeUnknown('omsg-1', 'worker-a', 'disconnect'), true);
    assert.equal(store.acquireDispatchLease('omsg-1', 'worker-b'), false);
    assert.equal(store.getCommand('omsg-1').state, 'OUTCOME_UNKNOWN');
  } finally { db.close(); }
});

test('Owner Provider binding is exact, versioned and cannot be reused by another conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-binding-'));
  const db = initOwnerLinkDatabase(path.join(dir, 'owner.db'));
  try {
    const store = new OwnerLinkStore(db);
    const first = store.saveProviderBinding({ ownerConversationId: 'oconv-1', agentId: 'agent-1',
      providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'codex-cli',
      deliveryMode: 'cli', nativeSessionId: 'native-session-1', expectedVersion: 0 });
    assert.equal(first.binding_version, 1);
    assert.equal(first.provider_instance_id, 'instance-1');
    assert.throws(() => store.saveProviderBinding({ ownerConversationId: 'oconv-2', agentId: 'agent-1',
      providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'codex-cli',
      deliveryMode: 'cli', nativeSessionId: 'native-session-1', expectedVersion: 0 }),
      /OWNER_NATIVE_SESSION_ALREADY_BOUND/);
    assert.throws(() => store.saveProviderBinding({ ownerConversationId: 'oconv-1', agentId: 'agent-1',
      providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'codex-cli',
      deliveryMode: 'cli', nativeSessionId: 'native-session-2', expectedVersion: 0 }),
      /OWNER_PROVIDER_BINDING_VERSION_CONFLICT/);
    const second = store.saveProviderBinding({ ownerConversationId: 'oconv-1', agentId: 'agent-1',
      providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'codex-cli',
      deliveryMode: 'cli', nativeSessionId: 'native-session-2', expectedVersion: 1 });
    assert.equal(second.binding_version, 2);
    assert.equal(store.markProviderBindingUnavailable('oconv-1', 1), false);
    assert.equal(store.markProviderBindingUnavailable('oconv-1', 2), true);
  } finally { db.close(); }
});

test('Owner database upgrades a v1 database without losing verified commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-upgrade-'));
  const databasePath = path.join(dir, 'owner.db');
  const db1 = initOwnerLinkDatabase(databasePath);
  db1.prepare('PRAGMA user_version=1').run();
  db1.exec('DROP TABLE owner_link_approvals; DROP TABLE owner_link_provider_bindings');
  db1.close();
  const db2 = initOwnerLinkDatabase(databasePath);
  try {
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_link_provider_bindings'").get());
  } finally { db2.close(); }
});

test('approved action digest, expiry and one-time approval are enforced before dispatch', () => {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-approval-')), 'owner.db'));
  try {
    const store = new OwnerLinkStore(db); const first = fixture();
    store.persistVerified(first.envelope, 'owner-im-1', first.now);
    const binding = { providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'codex-cli',
      deliveryMode: 'cli', bindingVersion: 1, nativeSessionId: 'thread-1' };
    assert.equal(store.acquireApprovedDispatchLease('omsg-1', 'worker-a', binding), true);
    assert.equal(store.acquireApprovedDispatchLease('omsg-1', 'worker-b', binding), false);
    const second = fixture(first.now, { messageId: 'omsg-2', sequence: 2, payload: first.envelope.payload }).envelope;
    assert.throws(() => store.persistVerified(second, 'owner-im-1', first.now), /OWNER_APPROVAL_REUSED/);
  } finally { db.close(); }
});

test('terminal state and signed outbox event commit or roll back together', () => {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-atomic-')), 'owner.db'));
  try {
    const store = new OwnerLinkStore(db); store.persistVerified(fixture().envelope, 'owner-im-1');
    assert.equal(store.acquireDispatchLease('omsg-1', 'worker-a'), true);
    assert.equal(store.markProviderAccepted('omsg-1', 'worker-a'), true);
    assert.throws(() => store.transitionAndEnqueueSignedEvent({
      messageId: 'omsg-1', from: 'PROVIDER_ACCEPTED', to: 'COMPLETED', build: () => ({
        eventId: 'event-too-large', rawEnvelope: 'x'.repeat(8193),
      }),
    }), /OWNER_EVENT_INVALID/);
    assert.equal(store.getCommand('omsg-1').state, 'PROVIDER_ACCEPTED');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM owner_link_outbox').get().count, 0);
    store.transitionAndEnqueueSignedEvent({
      messageId: 'omsg-1', from: 'PROVIDER_ACCEPTED', to: 'COMPLETED', build: sequence => ({
        eventId: 'event-ok', rawEnvelope: JSON.stringify({ messageId: 'event-ok', sequence }),
      }),
    });
    assert.equal(store.getCommand('omsg-1').state, 'COMPLETED');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM owner_link_outbox').get().count, 1);
  } finally { db.close(); }
});
