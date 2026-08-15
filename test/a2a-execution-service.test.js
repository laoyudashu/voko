'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2AExecutionService, A2ALocalTaskStore, initA2ADatabase } = require('../build/a2a');
function envelope(task = 'task-1') { return { agentId: 'agent-1', contextId: 'context-1', gatewayTaskId: task, payload: { text: 'hello' } }; }
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-execution-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return new A2ALocalTaskStore(db); }
test('first task stores native session and later task restores exactly it', async t => {
  const store = setup(t); const calls = []; const dispatcher = { async executeIsolated(options) { calls.push(options); return {
    reply: { content: 'done' }, receipt: { deliveryReceipt: { nativeSessionId: 'native-1' }, provider: {
      providerId: 'codex-cli', providerType: 'codex', deliveryMode: 'cli' } } }; } };
  const service = new A2AExecutionService(store, dispatcher);
  assert.deepEqual(await service.execute(envelope()), { content: 'done' });
  await service.execute(envelope('task-2'));
  assert.equal(calls[0].binding, null); assert.equal(calls[1].binding.nativeSessionId, 'native-1');
  assert.equal(calls[1].binding.strictSessionRoute, true);
});
test('oversized task text is rejected before Provider execution', async t => {
  const store = setup(t); let called = false; const service = new A2AExecutionService(store, { async executeIsolated() { called = true; } });
  const value = envelope(); value.payload.text = 'x'.repeat(6145);
  await assert.rejects(() => service.execute(value), /Invalid/); assert.equal(called, false);
});
test('Provider dispatch rechecks that the local Agent is still eligible', async t => {
  const store = setup(t); let called = false;
  const service = new A2AExecutionService(store, { async executeIsolated() { called = true; } }, undefined,
    () => { throw new Error('A2A_AGENT_NOT_AVAILABLE'); });
  await assert.rejects(() => service.execute(envelope()), /A2A_AGENT_NOT_AVAILABLE/); assert.equal(called, false);
});
test('internal no-reply sentinels never become A2A response text', async t => {
  const store = setup(t); const seen = [];
  const service = new A2AExecutionService(store, {
    async executeIsolated() { return { reply: { content: 'NO_REPLY' }, receipt: { provider: {} } }; },
  }, { async assertAllowed(content, direction) { seen.push([content, direction]); } });
  assert.deepEqual(await service.execute(envelope()), { content: '', noReply: true });
  assert.deepEqual(seen, [['hello', 'inbound']]);
});
