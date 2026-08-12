const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OwnerEventOutbox, OwnerLinkStore, initOwnerLinkDatabase, signOwnerEnvelope } = require('../build/owner-link');

function fixture() {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-outbox-')), 'owner.db'));
  const store = new OwnerLinkStore(db); const keys = crypto.generateKeyPairSync('ed25519'); const now = Date.now();
  const command = signOwnerEnvelope({ version: 'voko.owner/1', kind: 'command', messageId: 'command-1',
    ownerConversationId: 'conversation-1', ownerIdentityId: 'identity-1', ownerImUid: 'owner_remote-1',
    agentId: 'agent-1', ownershipEpoch: 1, conversationEpoch: 1, sequence: 1, operation: 'execute',
    payload: { text: 'status' }, keyId: 'gateway-key', createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString() }, keys.privateKey);
  store.persistVerified(command, command.ownerImUid, now);
  store.enqueueSignedEvent(command.messageId, 'receipt', sequence => ({ eventId: 'event-1',
    rawEnvelope: JSON.stringify({ messageId: 'event-1', sequence }) }));
  return { db, store };
}

test('Owner event outbox sends raw envelope from the Agent IM identity with stable clientMsgNo', async () => {
  const f = fixture(); const calls = [];
  try {
    const outbox = new OwnerEventOutbox(f.store, { async deliver(...args) { calls.push(args); return { success: true }; } });
    assert.equal(await outbox.flush(), 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['agent-1', 'owner_remote-1']);
    assert.equal(calls[0][2], JSON.stringify({ messageId: 'event-1', sequence: 1 }));
    assert.equal(calls[0][6], 'event-1');
    assert.equal(f.db.prepare('SELECT status FROM owner_link_outbox').get().status, 'sent');
    assert.equal(await outbox.flush(), 0);
    assert.equal(calls.length, 1);
  } finally { f.db.close(); }
});

test('definite send failure is retryable while uncertain outcome is never resent automatically', async () => {
  const definite = fixture();
  try {
    const outbox = new OwnerEventOutbox(definite.store, { async deliver() { return { success: false, code: 'OFFLINE' }; } });
    assert.equal(await outbox.flush(), 0);
    assert.equal(definite.db.prepare('SELECT status FROM owner_link_outbox').get().status, 'pending');
  } finally { definite.db.close(); }
  const unknown = fixture(); let calls = 0;
  try {
    const outbox = new OwnerEventOutbox(unknown.store, { async deliver() { calls += 1; return { success: false,
      code: 'SENDACK_TIMEOUT', outcomeUnknown: true }; } });
    await outbox.flush();
    assert.equal(unknown.db.prepare('SELECT status FROM owner_link_outbox').get().status, 'outcome_unknown');
    await outbox.flush();
    assert.equal(calls, 1);
  } finally { unknown.db.close(); }
});

test('concurrent outbox flush calls claim each event once', async () => {
  const f = fixture(); let calls = 0; let release;
  try {
    const blocker = new Promise(resolve => { release = resolve; });
    const outbox = new OwnerEventOutbox(f.store, { async deliver() { calls += 1; await blocker; return { success: true }; } });
    const first = outbox.flush(); const second = outbox.flush(); release();
    assert.deepEqual(await Promise.all([first, second]), [1, 0]);
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test('Owner outbox revalidates Agent authority before every send', async () => {
  const f = fixture(); let calls = 0;
  try {
    const outbox = new OwnerEventOutbox(f.store, { async deliver() { calls += 1; return { success: true }; } },
      2_000, () => false);
    assert.equal(await outbox.flush(), 0);
    assert.equal(calls, 0);
    assert.deepEqual({ ...f.db.prepare('SELECT status,last_error_code FROM owner_link_outbox').get() }, {
      status: 'dead', last_error_code: 'OWNER_EVENT_AUTHORIZATION_REVOKED',
    });
  } finally { f.db.close(); }
});

test('Owner outbox preserves conversation event order across retryable failure', async () => {
  const f = fixture(); const calls = [];
  try {
    f.store.enqueueSignedEvent('command-1', 'event', sequence => ({ eventId: 'event-2',
      rawEnvelope: JSON.stringify({ messageId: 'event-2', sequence }) }));
    const outbox = new OwnerEventOutbox(f.store, { async deliver(_agentId, _ownerImUid, raw) {
      calls.push(JSON.parse(raw).messageId);
      return calls.length === 1 ? { success: false, code: 'OFFLINE' } : { success: true };
    } });
    await outbox.flush();
    assert.deepEqual(calls, ['event-1']);
    assert.deepEqual(f.db.prepare('SELECT event_id,status FROM owner_link_outbox ORDER BY producer_sequence').all().map(row => ({ ...row })), [
      { event_id: 'event-1', status: 'pending' }, { event_id: 'event-2', status: 'pending' },
    ]);
  } finally { f.db.close(); }
});
