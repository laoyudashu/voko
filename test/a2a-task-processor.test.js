'use strict';
const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const fs = require('node:fs');
const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2AIdentityStore, A2ALocalTaskStore, A2ATaskProcessor, initA2ADatabase, verifyEnvelope } = require('../build/a2a');
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-processor-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); const store = new A2ALocalTaskStore(db);
  store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', gatewayUid: 'gateway' }); return { db, store }; }
function request() { const now = Date.now(); return { version: 'voko.a2a/1', kind: 'request', operation: 'execute', eventId: 'request-1',
  gatewayTaskId: 'task-1', contextId: 'ctx-1', gatewayMessageId: 'message-1', executionId: 'exec-1', sequence: 1,
  agentId: 'agent-1', caller: {}, payload: { text: 'hello' }, trace: { correlationId: 'trace-1' },
  timestamps: { createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 300000).toISOString() } }; }
test('processor atomically queues signed accepted, working and completed events', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { return { content: 'answer' }; } }, identity);
  await processor.process(request()); const rows = db.prepare('SELECT producer_sequence,operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence').all();
  assert.deepEqual(rows.map(row => [row.producer_sequence, row.operation]), [[1, 'accepted'], [2, 'working'], [3, 'completed']]);
  for (const row of rows) assert.equal(verifyEnvelope(JSON.parse(row.envelope_json), identity.publicKey), true);
  assert.equal(JSON.parse(rows[2].envelope_json).payload.text, 'answer');
});
test('Provider failure never fabricates a failed event', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { throw new Error('outcome unknown'); } }, identity);
  await assert.rejects(() => processor.process(request()), /outcome unknown/);
  const operations = db.prepare('SELECT operation FROM a2a_local_outbox ORDER BY producer_sequence').all().map(row => row.operation);
  assert.deepEqual(operations, ['accepted', 'working']); assert.equal(operations.includes('failed'), false);
});
