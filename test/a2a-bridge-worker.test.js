'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path'); const test = require('node:test');
const { A2ABridgeWorker, A2ALocalTaskStore, A2AScopeResolver, initA2ADatabase } = require('../build/a2a');
function setup(t, execute) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-bridge-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const envelope = { eventId: 'event-1', gatewayTaskId: 'task-1', contextId: 'ctx-1', executionId: 'exec-1', agentId: 'agent-1', commandSequence: 1, operation: 'execute', caller:{principalId:'principal-1',actorKind:'agent',provenance:'guest_a2a'} };
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
  assert.match(logs[0], /^\[\d{2}:\d{2}:\d{2}\] \[A2A\] A2A-[A-Za-z0-9_-]{8} → agent-1（收到消息）$/);
  assert.doesNotMatch(logs.join('\n'), /payload|content|secret/i);
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
