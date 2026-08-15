'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initA2ADatabase, A2ALocalTaskStore } = require('../build/a2a');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-a2a-store-'));
  const db = initA2ADatabase(path.join(dir, 'a2a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new A2ALocalTaskStore(db);
  store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', gatewayUid: 'gateway-1',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  return { db, store };
}

test('task creation and inbox commands are idempotent', (t) => {
  const { store } = fixture(t);
  assert.equal(store.createTask({ gatewayTaskId: 'task-1', contextId: 'other', executionId: 'other', agentId: 'other', gatewayUid: 'other',principalScope:'scope-2',scopeVersion:1,scopeKeyId:'key-1' }), false);
  assert.equal(store.acceptCommand('event-1', 'task-1', 1, 'execute'), 'accepted');
  assert.equal(store.acceptCommand('event-1', 'task-1', 1, 'execute'), 'duplicate');
  assert.equal(store.acceptCommand('event-2', 'task-1', 1, 'execute'), 'duplicate');
});

test('inbox persists the verified envelope before execution and clears it after success', (t) => {
  const { db, store } = fixture(t); const envelope = { version: 'voko.a2a/1', payload: { text: 'hello' } };
  assert.equal(store.acceptCommand('event-envelope', 'task-1', 2, 'execute', envelope), 'accepted');
  assert.deepEqual(JSON.parse(db.prepare("SELECT envelope_json FROM a2a_local_inbox WHERE event_id='event-envelope'").get().envelope_json), envelope);
  store.finishCommand('event-envelope', 'processed');
  assert.equal(db.prepare("SELECT envelope_json FROM a2a_local_inbox WHERE event_id='event-envelope'").get().envelope_json, null);
});

test('terminal task state cannot be changed', (t) => {
  const { store } = fixture(t);
  assert.equal(store.updateState('task-1', 'WORKING', 'EXECUTING'), true);
  assert.equal(store.updateState('task-1', 'COMPLETED', 'DELIVERED'), true);
  assert.equal(store.updateState('task-1', 'FAILED', 'DELIVERY_UNKNOWN'), false);
});

test('outbox deduplicates producer sequence and uses expiring leases', (t) => {
  const { db, store } = fixture(t);
  assert.equal(store.enqueueEvent('reply-1', 'task-1', 1, 'accepted', { ok: true }), true);
  assert.equal(store.enqueueEvent('reply-2', 'task-1', 1, 'accepted', { ok: true }), false);
  assert.equal(store.claimEvents('worker-a', 10, 60_000).length, 1);
  assert.equal(store.claimEvents('worker-b', 10, 60_000).length, 0);
  db.prepare("UPDATE a2a_local_outbox SET lease_expires_at=0 WHERE event_id='reply-1'").run();
  const reclaimed = store.claimEvents('worker-b');
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].lease_owner, 'worker-b');
  assert.equal(reclaimed[0].attempt_count, 2);
});
test('later task events wait until the previous event is acknowledged', (t) => {
  const { db, store } = fixture(t);
  store.enqueueEvent('event-1', 'task-1', 1, 'accepted', {});
  store.enqueueEvent('event-2', 'task-1', 2, 'working', {});
  assert.deepEqual(store.claimEvents('worker').map(row => row.event_id), ['event-1']);
  store.finishOutboxEvent('event-1', 'acked');
  assert.deepEqual(store.claimEvents('worker').map(row => row.event_id), ['event-2']);
});
