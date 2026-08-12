'use strict';
const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const fs = require('node:fs');
const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2AEventOutboxWorker, A2AIdentityStore, A2ALocalTaskStore, initA2ADatabase } = require('../build/a2a');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbox-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return { db, store: new A2ALocalTaskStore(db) }; }
test('local Ed25519 identity is stable and can sign without exposing native sessions', t => {
  const { db } = fixture(t); const identities = new A2AIdentityStore(db); const first = identities.getOrCreate(); const second = identities.getOrCreate();
  assert.deepEqual(second, first); const signature = crypto.sign(null, Buffer.from('test'), first.privateKey);
  assert.equal(crypto.verify(null, Buffer.from('test'), first.publicKey, signature), true);
  assert.doesNotMatch(JSON.stringify({ keyId: first.keyId, publicKey: first.publicKey }), /nativeSession/i);
});
test('event outbox marks successful delivery acked', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { signed: true });
  const worker = new A2AEventOutboxWorker(store, { async sendEvent() { return { status: 'accepted' }; } });
  assert.deepEqual(await worker.flushOnce('worker'), { sent: 1, uncertain: 0 });
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-1'").get().status, 'acked');
});
test('unknown delivery result is quarantined and never automatically claimed again', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { signed: true });
  const worker = new A2AEventOutboxWorker(store, { async sendEvent() { throw new Error('connection reset'); } });
  assert.deepEqual(await worker.flushOnce('worker'), { sent: 0, uncertain: 1 });
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-1'").get().status, 'outcome_unknown');
  assert.deepEqual(store.claimEvents('other'), []);
});
