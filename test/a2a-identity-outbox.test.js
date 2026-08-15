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
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { signed: true });
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent() { return { status: 'accepted' }; } });
  assert.deepEqual(await worker.flushOnce('worker'), { sent: 1, uncertain: 0 });
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-1'").get().status, 'acked');
});
test('event upload network failure retries the same immutable event without marking Provider outcome unknown', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { signed: true });
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent() { throw new Error('connection reset'); } });
  assert.deepEqual(await worker.flushOnce('worker'), { sent: 0, uncertain: 0 });
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-1'").get().status, 'pending');
  assert.deepEqual(store.claimEvents('other'), []);
});
test('sequence-gap conflict is deferred for ordered event retry', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-gap', 'task-1', 1, 'working', { signed: true });
  const error = Object.assign(new Error('gap'), { status: 409, code: 'A2A_EVENT_SEQUENCE_GAP', expectedSequence: 1 });
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent() { throw error; } });
  await worker.flushOnce('worker');
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-gap'").get().status, 'pending');
});
test('canonical event payload conflict is dead-lettered instead of retried', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-conflict', 'task-1', 1, 'working', { signed: true });
  const error = Object.assign(new Error('conflict'), { status: 409, code: 'A2A_EVENT_PAYLOAD_CONFLICT' });
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent() { throw error; } });
  await worker.flushOnce('worker');
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-conflict'").get().status, 'dead');
});
test('unknown event is acknowledged only after the Gateway confirms the same task', async t => {
  const { db, store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { signed: true }); store.finishOutboxEvent('event-1', 'outcome_unknown');
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: true, taskId: 'task-1', gatewaySequence: 2 }; },
    async sendEvent() { throw new Error('must not resend'); } });
  assert.deepEqual(await worker.flushOnce('worker'), { sent: 1, uncertain: 0 });
  assert.equal(db.prepare("SELECT status FROM a2a_local_outbox WHERE event_id='event-1'").get().status, 'acked');
});
test('drain sends ordered task events before returning to long polling', async t => {
  const { store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-1', 'task-1', 1, 'accepted', { producerSequence: 1 }); store.enqueueEvent('event-2', 'task-1', 2, 'working', { producerSequence: 2 });
  store.enqueueEvent('event-3', 'task-1', 3, 'completed', { producerSequence: 3 }); const sent = [];
  const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent(event) { sent.push(event.producerSequence); return { status: 'accepted' }; } });
  assert.deepEqual(await worker.drain('worker'), { sent: 3, uncertain: 0 }); assert.deepEqual(sent, [1, 2, 3]);
});

test('A2A logs contain only message-level summaries and never stream payload details', async t => {
  const { store } = fixture(t); store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx', executionId: 'exec', agentId: 'agent', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  store.enqueueEvent('event-1', 'task-1', 1, 'working', { secret: 'stream-detail' });
  store.enqueueEvent('event-2', 'task-1', 2, 'completed', { text: 'private-reply' });
  const logs = []; const original = console.log; console.log = (...args) => logs.push(args.join(' '));
  try {
    const worker = new A2AEventOutboxWorker(store, { async findEvent() { return { found: false }; }, async sendEvent() { return { status: 'accepted' }; } });
    await worker.drain('worker');
  } finally { console.log = original; }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[\d{2}:\d{2}:\d{2}\] \[A2A\] /);
  assert.doesNotMatch(logs.join('\n'), /stream-detail|private-reply/);
});
