'use strict';
const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events'); const test = require('node:test');
const { createDispatcher } = require('../build/core/dispatcher');
class Provider extends EventEmitter {
  match() { return true; } isAvailable() { return true; }
  push(payload) { this.payload = payload; setImmediate(() => this.emit('agent.reply', { agentId: payload.agentId,
    visitorId: payload.fromUid, turnId: payload.turnId, replyId: 'reply-1', content: 'isolated-result', done: true }));
    return { nativeSessionId: 'native-a2a-session' }; }
}
function db() { return { prepare(sql) { return { get: () => sql.includes('FROM agents')
  ? { backend_type: 'codex', backend_instance_id: null, delivery_modes: '["cli"]', imUid: 'im-agent' } : undefined,
  all: () => [], run: () => ({ changes: 1 }) }; } }; }
test('isolated execution captures reply without ordinary reply callback or binding commit', async () => {
  const provider = new Provider(); const ordinary = [];
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': provider }, onAgentReply: reply => ordinary.push(reply) });
  const result = await dispatcher.executeIsolated({ agentId: 'agent-1', taskId: 'task-1', contextId: 'context-1', content: 'hello', timeoutMs: 1000 });
  assert.equal(result.reply.content, 'isolated-result'); assert.equal(result.receipt.nativeSessionId, 'native-a2a-session');
  assert.equal(ordinary.length, 0); assert.equal(provider.payload.executionScope, 'a2a_mailbox');
  assert.equal(provider.payload.providerBinding, null);
});
