'use strict';
const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const fs = require('node:fs');
const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2AIdentityStore, A2ALocalTaskStore, A2ATaskProcessor, initA2ADatabase, verifyEnvelope } = require('../build/a2a');
const { A2ASafetyRejection } = require('../build/a2a');
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-processor-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); const store = new A2ALocalTaskStore(db);
  store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' }); return { db, store }; }
function request() { const now = Date.now(); return { version: 'voko.a2a/1', kind: 'request', operation: 'execute', eventId: 'request-1',
  gatewayTaskId: 'task-1', contextId: 'ctx-1', gatewayMessageId: 'message-1', executionId: 'exec-1', commandSequence: 1,
  agentId: 'agent-1', caller: {principalId:'principal-1',actorKind:'agent',provenance:'guest_a2a'}, payload: { text: 'hello' }, trace: { correlationId: 'trace-1' },
  timestamps: { createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 300000).toISOString() } }; }
test('processor atomically queues signed accepted, working and completed events', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { return { content: 'answer' }; } }, identity);
  await processor.process(request()); const rows = db.prepare('SELECT producer_sequence,operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence').all();
  assert.deepEqual(rows.map(row => [row.producer_sequence, row.operation]), [[1, 'accepted'], [2, 'working'], [3, 'completed']]);
  for (const row of rows) assert.equal(verifyEnvelope(JSON.parse(row.envelope_json), identity.publicKey), true);
  assert.equal(JSON.parse(rows[2].envelope_json).payload.text, 'answer');
});
test('Provider uncertainty is persisted without fabricating a failed event or retry', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { const error = new Error('outcome unknown');
    error.code = 'A2A_PROVIDER_REPLY_TIMEOUT'; throw error; } }, identity);
  await processor.process(request());
  const rows = db.prepare('SELECT operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence').all();
  const operations = rows.map(row => row.operation);
  assert.deepEqual(operations, ['accepted', 'working', 'working']); assert.equal(operations.includes('failed'), false);
  assert.equal(JSON.parse(rows[2].envelope_json).payload.reasonCode, 'A2A_PROVIDER_REPLY_TIMEOUT');
  const task = db.prepare("SELECT standard_state,delivery_state FROM a2a_local_tasks WHERE gateway_task_id='task-1'").get();
  assert.equal(task.standard_state, 'WORKING'); assert.equal(task.delivery_state, 'DELIVERY_UNKNOWN');
});
test('known safety rejection produces a standard rejected event without unsafe body', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { throw new A2ASafetyRejection('explicit_prompt_injection'); } }, identity);
  await processor.process(request()); const last = db.prepare('SELECT operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence DESC LIMIT 1').get();
  assert.equal(last.operation, 'rejected'); const envelope = JSON.parse(last.envelope_json);
  assert.equal(envelope.payload.reasonCode, 'explicit_prompt_injection'); assert.equal(JSON.stringify(envelope).includes('Ignore all'), false);
});
test('no-reply completion carries a control marker instead of sentinel text', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { return { content: '', noReply: true }; } }, identity);
  await processor.process(request());
  const last = db.prepare('SELECT operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence DESC LIMIT 1').get();
  assert.equal(last.operation, 'completed');
  const payload = JSON.parse(last.envelope_json).payload;
  assert.deepEqual(payload, { noReply: true });
  assert.equal(JSON.stringify(payload).includes('NO_REPLY'), false);
});
test('interrupted execution is reported as unknown without re-running the Provider', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate();
  const processor = new A2ATaskProcessor(store, { async execute() { assert.fail('must not execute during recovery'); } }, identity);
  const incoming = request(); store.acceptCommand(incoming.eventId, incoming.gatewayTaskId, incoming.commandSequence, incoming.operation, incoming);
  assert.equal(store.beginCommand(incoming.eventId), true);
  processor.recoverInterrupted(incoming); store.finishCommand(incoming.eventId, 'processed');
  processor.recoverInterrupted(incoming);
  const last = db.prepare('SELECT operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence DESC LIMIT 1').get();
  assert.equal(last.operation, 'working');
  assert.deepEqual(JSON.parse(last.envelope_json).payload, { deliveryState: 'DELIVERY_UNKNOWN', reasonCode: 'LITE_RESTART_DURING_EXECUTION' });
  const task = db.prepare("SELECT standard_state,delivery_state FROM a2a_local_tasks WHERE gateway_task_id='task-1'").get();
  assert.equal(task.standard_state, 'WORKING'); assert.equal(task.delivery_state, 'DELIVERY_UNKNOWN');
  assert.equal(store.commandStatus(incoming.eventId), 'processed');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM a2a_local_outbox WHERE gateway_task_id='task-1'").get().count, 1);
});
test('cancel control never starts Provider execution and reports unsupported safely', async t => {
  const { db, store } = setup(t); const identity = new A2AIdentityStore(db).getOrCreate(); let executions = 0;
  store.updateState('task-1', 'WORKING', 'EXECUTING');
  const processor = new A2ATaskProcessor(store, { async execute() { executions += 1; return { content: 'wrong' }; } }, identity);
  const control = { ...request(), kind: 'control', operation: 'cancel', eventId: 'cancel-1', commandSequence: 2 };
  await processor.process(control);
  const last = db.prepare('SELECT operation,envelope_json FROM a2a_local_outbox ORDER BY producer_sequence DESC LIMIT 1').get();
  assert.equal(executions, 0); assert.equal(last.operation, 'cancel_ack');
  assert.equal(JSON.parse(last.envelope_json).payload.result, 'unsupported');
});
