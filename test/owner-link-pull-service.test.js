const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOwnerPullCallerAuthorizer, OwnerLinkStore, OwnerPullService,
  actionDigest, initOwnerLinkDatabase, signOwnerEnvelope } = require('../build/owner-link');
const { AgentIdentityBindingStore } = require('../build/core/provider-agent-identity');
const { initDatabase } = require('../build/core/database');

function fixture(options = {}) {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-pull-')), 'owner.db'));
  const store = new OwnerLinkStore(db); const gateway = crypto.generateKeyPairSync('ed25519');
  const agent = crypto.generateKeyPairSync('ed25519'); const now = Date.now();
  const expiresAt = new Date(now + 60_000).toISOString();
  const action = { type: 'message', text: 'Summarize the current status.' };
  const command = signOwnerEnvelope({ version: 'voko.owner/1', kind: 'command', messageId: 'command-pull-1',
    ownerConversationId: 'conversation-pull-1', ownerIdentityId: 'identity-pull-1', ownerImUid: 'owner_pull-1',
    agentId: options.remoteAgentId || 'agent-1', ownershipEpoch: 1, conversationEpoch: 1, sequence: 1, operation: 'execute',
    payload: { action, approval: { approvalId: 'owa_command-pull-1', actionDigest: actionDigest(action), expiresAt,
      enforcement: 'required_before_execute' } }, keyId: 'gateway-key',
    createdAt: new Date(now - 1000).toISOString(), expiresAt }, gateway.privateKey);
  store.persistVerified(command, command.ownerImUid, now, options.localAgentId || command.agentId);
  const identity = { privateKey: agent.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: 'agent-key', imUid: 'agent-im-1' };
  return { db, store, command, identity };
}

test('Pull requires an exact verified Agent caller and does not expose a command otherwise', () => {
  const f = fixture();
  try {
    const service = new OwnerPullService({ store: f.store, authorizeAgent: () => false,
      resolveAgentIdentity: () => f.identity });
    assert.deepEqual(service.fetch('agent-1'), { success: false, code: 'OWNER_PULL_CALLER_UNVERIFIED' });
    assert.equal(f.store.getCommand(f.command.messageId).state, 'PERSISTED');
  } finally { f.db.close(); }
});

test('Pull claim shares the dispatch lease and produces signed accepted/working/completed events', () => {
  const f = fixture();
  try {
    const service = new OwnerPullService({ store: f.store, authorizeAgent: id => id === 'agent-1' ? ({
      providerType: 'codex', providerInstanceId: 'instance-1', adapterType: 'owner-pull', deliveryMode: 'pull',
      bindingVersion: 0, nativeSessionId: 'thread-1' }) : null,
      resolveAgentIdentity: () => f.identity });
    const fetched = service.fetch('agent-1');
    assert.equal(fetched.success, true);
    assert.equal(fetched.command.content, 'Summarize the current status.');
    assert.equal(fetched.command.trust, 'verified_owner');
    assert.equal(f.store.getCommand(f.command.messageId).state, 'PROVIDER_ACCEPTED');
    assert.deepEqual(service.complete('agent-1', f.command.messageId, fetched.command.claimId, 'Ready.'),
      { success: true, status: 'completed' });
    assert.equal(f.store.getCommand(f.command.messageId).state, 'COMPLETED');
    assert.deepEqual(f.db.prepare('SELECT payload_json FROM owner_link_outbox ORDER BY producer_sequence').all()
      .map(row => JSON.parse(row.payload_json).operation), ['accepted', 'working', 'completed']);
  } finally { f.db.close(); }
});

test('Pull addresses the local Agent while returning events for the remote AgentDID identity', () => {
  const remoteAgentId = '2b4a3c62-efba-4c97-add9-6f09ee092462';
  const f = fixture({ remoteAgentId, localAgentId: 'gym' });
  try {
    const service = new OwnerPullService({ store: f.store, authorizeAgent: id => id === 'gym' ? ({
      providerType: 'openclaw', providerInstanceId: 'main', adapterType: 'owner-pull', deliveryMode: 'pull',
      bindingVersion: 0, nativeSessionId: 'thread-gym' }) : null,
      resolveAgentIdentity: id => id === 'gym' ? f.identity : null });
    const fetched = service.fetch('gym');
    assert.equal(fetched.success, true); assert.equal(fetched.command.messageId, f.command.messageId);
    assert.equal(service.complete('gym', f.command.messageId, fetched.command.claimId, 'done').success, true);
    assert.ok(f.db.prepare('SELECT payload_json FROM owner_link_outbox').all()
      .every(row => JSON.parse(row.payload_json).agentId === remoteAgentId));
  } finally { f.db.close(); }
});

test('a Pull command can only be completed by its original claim', () => {
  const f = fixture();
  try {
    const service = new OwnerPullService({ store: f.store, authorizeAgent: () => ({ providerType: 'codex',
      providerInstanceId: 'instance-1', adapterType: 'owner-pull', deliveryMode: 'pull', bindingVersion: 0,
      nativeSessionId: 'thread-1' }),
      resolveAgentIdentity: () => f.identity });
    const fetched = service.fetch('agent-1');
    assert.deepEqual(service.complete('agent-1', f.command.messageId, 'wrong-claim', 'ignored'),
      { success: false, code: 'OWNER_PULL_CLAIM_INVALID' });
    assert.equal(f.store.getCommand(f.command.messageId).state, 'PROVIDER_ACCEPTED');
    assert.deepEqual(service.fail('agent-1', f.command.messageId, fetched.command.claimId, 'MODEL_FAILED'),
      { success: true, status: 'failed' });
    assert.equal(f.store.getCommand(f.command.messageId).state, 'FAILED_NOT_DELIVERED');
  } finally { f.db.close(); }
});

test('expired Pull lease becomes outcome unknown and is never offered again', () => {
  const f = fixture();
  try {
    const service = new OwnerPullService({ store: f.store, authorizeAgent: () => ({ providerType: 'codex',
      providerInstanceId: 'instance-1', adapterType: 'owner-pull', deliveryMode: 'pull', bindingVersion: 0,
      nativeSessionId: 'thread-1' }),
      resolveAgentIdentity: () => f.identity, claimTtlMs: 30_000 });
    const fetched = service.fetch('agent-1');
    const command = f.store.getCommand(f.command.messageId);
    assert.ok(fetched.command.claimId);
    assert.equal(f.store.recoverReservedCommands(Number(command.lease_expires_at) + 1), 1);
    assert.equal(f.store.getCommand(f.command.messageId).state, 'OUTCOME_UNKNOWN');
    assert.equal(service.fetch('agent-1').command, null);
  } finally { f.db.close(); }
});

test('Pull caller authorization requires one exact Provider session binding', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const bindings = new AgentIdentityBindingStore(db);
    bindings.bind({ agentId: 'agent-1', providerFamily: 'codex', providerInstanceKey: 'instance-1',
      nativeSessionId: 'thread-1', evidenceType: 'test' });
    let caller = { providerType: 'codex', providerInstanceId: 'instance-1', nativeSessionId: 'thread-1', evidence: 'hook' };
    const authorize = createOwnerPullCallerAuthorizer(db, () => caller);
    assert.deepEqual(authorize('agent-1'), { providerType: 'codex', providerInstanceId: 'instance-1',
      adapterType: 'owner-pull', deliveryMode: 'pull', bindingVersion: 0, nativeSessionId: 'thread-1', evidence: 'hook' });
    assert.equal(authorize('agent-2'), null);
    caller = { providerType: 'codex', providerInstanceId: 'instance-1', nativeSessionId: 'thread-other', evidence: 'hook' };
    assert.equal(authorize('agent-1'), null);
    caller = { providerType: 'codex', providerInstanceId: 'instance-1', nativeSessionId: 'thread-1' };
    assert.equal(authorize('agent-1'), null);
  } finally { db.close(); }
});
