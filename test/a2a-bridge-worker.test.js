'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path'); const test = require('node:test');
const { A2ABridgeWorker, A2AIdentityStore, A2ALocalTaskStore, A2AScopeResolver,
  A2ATaskProcessor, initA2ADatabase } = require('../build/a2a');
function setup(t, execute, provenance = 'guest_a2a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bridge-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const envelope = { eventId: 'event-1', gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', commandSequence: 1, operation: 'execute', caller:{principalId:'principal-1',actorKind:'agent',provenance} };
  const acknowledgements = []; const client = { async claim() { return { leaseId: 'lease-1', items: [{ eventId: 'event-1', taskId: 'task-1', envelope }] }; },
    async acknowledge(lease, event) { acknowledgements.push([lease, event]); } };
  return { worker: new A2ABridgeWorker({ client, store: new A2ALocalTaskStore(db), scopes:new A2AScopeResolver(db), verify: value => value, execute }), store: new A2ALocalTaskStore(db), acknowledgements };
}
test('bridge persists command before execution and ACKs only after success', async t => {
  let calls = 0; const f = setup(t, async () => { calls += 1; });
  assert.deepEqual(await f.worker.pollOnce(), { claimed: 1, processed: 1, uncertain: 0 });
  assert.equal(calls, 1); assert.deepEqual(f.acknowledgements, [['lease-1', 'event-1']]);
  assert.deepEqual(await f.worker.pollOnce(), { claimed: 1, processed: 0, uncertain: 0 }); assert.equal(calls, 1);
});
test('unknown execution outcome is receipt-ACKed but not executed again', async t => {
  let calls = 0; const f = setup(t, async () => { calls += 1; throw new Error('lost connection'); });
  assert.deepEqual(await f.worker.pollOnce(), { claimed: 1, processed: 0, uncertain: 1 });
  assert.deepEqual(await f.worker.pollOnce(), { claimed: 1, processed: 0, uncertain: 0 });
  assert.equal(calls, 1); assert.deepEqual(f.acknowledgements, [['lease-1', 'event-1'],['lease-1', 'event-1']]);
});
test('received but not started command is safely re-delivered after restart', async t => {
  let calls = 0; const f = setup(t, async () => { calls += 1; });
  f.store.createTask({ gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', gatewayUid: 'gateway',principalScope:'scope-1',scopeVersion:1,scopeKeyId:'key-1' });
  f.store.acceptCommand('event-1', 'task-1', 1, 'execute', { eventId: 'event-1' });
  assert.deepEqual(await f.worker.pollOnce(), { claimed: 1, processed: 1, uncertain: 0 });
  assert.equal(calls, 1); assert.deepEqual(f.acknowledgements, [['lease-1', 'event-1']]);
});
test('claim identity mismatch fails before persistence or execution', async t => {
  const f = setup(t, async () => assert.fail('must not execute'));
  f.worker.options = f.worker.options;
  const original = f.worker.options.verify; f.worker.options.verify = value => ({ ...original(value), eventId: 'forged' });
  await assert.rejects(() => f.worker.pollOnce(), /identity mismatch/);
});

test('A2A receive log is a single message-level summary', async t => {
  const f = setup(t, async () => {}); const logs = []; const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { await f.worker.pollOnce(); } finally { console.log = original; }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[A2A\] A2A-[A-Za-z0-9_-]{8} → agent-1（收到消息）$/);
  assert.doesNotMatch(logs.join('\n'), /payload|content|secret/i);
});

test('REST Webhook receive log uses its actual protocol name', async t => {
  const f = setup(t, async () => {}, 'external_gateway'); const logs = []; const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { await f.worker.pollOnce(); } finally { console.log = original; }
  assert.deepEqual(logs, ['[REST/Webhook] 外部接入 → agent-1（收到消息）']);
});

test('bridge runs different agents up to the limit while serializing each agent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bridge-concurrency-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const items = [0, 1, 2, 3].map(index => ({ eventId: `event-${index}`, taskId: `task-${index}`,
    envelope: { eventId: `event-${index}`, gatewayTaskId: `task-${index}`, contextId: `ctx-${index}`, executionId: `exec-${index}`,
      agentId: index < 2 ? 'agent-a' : `agent-${index}`, commandSequence: 1, operation: 'execute',
      caller: { principalId: 'principal-1', actorKind: 'agent', provenance: 'guest_a2a' } } }));
  let active = 0; let peak = 0; const perAgent = new Map(); let sameAgentOverlap = false;
  const client = { async claim() { return { leaseId: 'lease', items }; }, async acknowledge() {} };
  const worker = new A2ABridgeWorker({ client, store: new A2ALocalTaskStore(db), scopes: new A2AScopeResolver(db),
    verify: value => value, concurrency: 2, execute: async envelope => {
      active += 1; peak = Math.max(peak, active);
      const agentActive = (perAgent.get(envelope.agentId) || 0) + 1; perAgent.set(envelope.agentId, agentActive);
      if (agentActive > 1) sameAgentOverlap = true;
      await new Promise(resolve => setTimeout(resolve, 15));
      perAgent.set(envelope.agentId, agentActive - 1); active -= 1;
    } });
  assert.deepEqual(await worker.pollOnce(), { claimed: 4, processed: 4, uncertain: 0 });
  assert.equal(peak, 2); assert.equal(sameAgentOverlap, false);
});

test('empty remote claim atomically terminates an expired local retry without Provider execution', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-expired-retry-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new A2ALocalTaskStore(db); const now = Date.now();
  const envelope = { version: 'voko.a2a/1', kind: 'request', operation: 'execute', eventId: 'event-expired',
    gatewayTaskId: 'task-expired', contextId: 'ctx-expired', gatewayMessageId: 'message-expired', executionId: 'exec-expired',
    agentId: 'agent-expired', commandSequence: 1, caller: { principalId: 'principal-1', actorKind: 'agent', provenance: 'guest_a2a' },
    payload: { text: 'must-not-run' }, trace: { correlationId: 'correlation-expired' },
    timestamps: { createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString() } };
  store.createTask({ gatewayTaskId: envelope.gatewayTaskId, contextId: envelope.contextId, executionId: envelope.executionId,
    agentId: envelope.agentId, gatewayUid: 'gateway', principalScope: 'scope-1', scopeVersion: 1, scopeKeyId: 'key-1' });
  store.acceptCommand(envelope.eventId, envelope.gatewayTaskId, 1, 'execute', envelope);
  store.retryCommand(envelope.eventId, 'PROVIDER_NOT_DELIVERED', 0);
  let providerCalls = 0; let expiredVerifications = 0;
  const processor = new A2ATaskProcessor(store, { async execute() { providerCalls += 1; } }, new A2AIdentityStore(db).getOrCreate());
  const worker = new A2ABridgeWorker({ client: { async claim() { return { leaseId: 'empty', items: [] }; } }, store,
    scopes: new A2AScopeResolver(db), verify() { throw new Error('Expired A2A envelope'); },
    verifyExpiredRetry(value) { expiredVerifications += 1; return value; },
    expireRetry: (eventId, value) => processor.expireBeforeDelivery(eventId, value),
    async execute() { providerCalls += 1; } });

  assert.deepEqual(await worker.pollOnce(), { claimed: 0, processed: 0, uncertain: 0 });
  assert.deepEqual(await worker.pollOnce(), { claimed: 0, processed: 0, uncertain: 0 });
  assert.equal(providerCalls, 0); assert.equal(expiredVerifications, 1);
  const inbox = db.prepare('SELECT status,execution_state,error_code,envelope_json FROM a2a_local_inbox WHERE event_id=?')
    .get(envelope.eventId);
  assert.deepEqual({ ...inbox }, { status: 'processed', execution_state: 'processed',
    error_code: 'A2A_COMMAND_EXPIRED_BEFORE_DELIVERY', envelope_json: null });
  const task = db.prepare('SELECT standard_state,delivery_state FROM a2a_local_tasks WHERE gateway_task_id=?')
    .get(envelope.gatewayTaskId);
  assert.deepEqual({ ...task }, { standard_state: 'FAILED', delivery_state: 'DEAD_LETTER' });
  const outbox = db.prepare("SELECT operation,envelope_json FROM a2a_local_outbox WHERE gateway_task_id=? AND operation='failed'")
    .get(envelope.gatewayTaskId);
  assert.equal(outbox.operation, 'failed');
  const terminal = JSON.parse(outbox.envelope_json);
  assert.equal(terminal.payload.reasonCode, 'A2A_COMMAND_EXPIRED_BEFORE_DELIVERY');
  assert.equal(terminal.signature.algorithm, 'Ed25519');
});
