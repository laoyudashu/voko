'use strict';
const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events'); const test = require('node:test');
const { createDispatcher } = require('../build/core/dispatcher');
class Provider extends EventEmitter {
  match() { return true; } isAvailable() { return true; }
  canRestoreExactSession() { return true; }
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
  assert.equal(result.reply.content, 'isolated-result'); assert.equal(result.receipt.deliveryReceipt.nativeSessionId, 'native-a2a-session');
  assert.equal(ordinary.length, 0); assert.equal(provider.payload.executionScope, 'a2a_mailbox');
  assert.equal(provider.payload.securityContext.sourceType, 'agent_peer');
  assert.equal(provider.payload.providerBinding, null);
});

test('trusted Owner execution uses owner security context and an exact transport without fallback', async () => {
  const primary = new Provider(); const fallback = new Provider();
  primary.push = function (payload) { this.payload = payload; setImmediate(() => this.emit('agent.reply', {
    agentId: payload.agentId, visitorId: payload.fromUid, turnId: payload.turnId, replyId: 'owner-reply',
    content: 'owner-result', done: true })); return { nativeSessionId: 'owner-native-session' }; };
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': primary, 'other-cli': fallback }, onAgentReply() {} });
  const binding = { id: 'owner-binding', bindingVersion: 4, providerType: 'codex', providerInstanceId: null,
    deliveryMode: 'cli', adapterType: 'codex-cli', nativeSessionId: 'owner-native-session',
    sessionOrigin: 'voko_managed', channelId: 'owner-conversation', channelType: 1,
    sourceScope: 'trusted_owner', strictSessionRoute: true };
  const result = await dispatcher.executeIsolated({ agentId: 'agent-1', taskId: 'owner-message',
    contextId: 'owner-conversation', content: 'trusted command', binding, sourceType: 'owner',
    executionScope: 'owner_link', timeoutMs: 1000 });
  assert.equal(result.reply.content, 'owner-result');
  assert.equal(primary.payload.securityContext.sourceType, 'owner');
  assert.equal(primary.payload.securityContext.trustLevel, 'trusted_owner');
  assert.equal(primary.payload.providerBinding.sourceScope, 'trusted_owner');
  assert.equal(fallback.payload, undefined);
});

test('trusted Owner bootstrap accepts only an exact-version full sandbox transport', async () => {
  const safe = new Provider(); const unsafe = new Provider();
  safe.getSandboxStatus = () => ({ effective: true, versionState: 'verified', coverage: 'full', dimensions: {
    filesystem: 'read_only', network: 'blocked', commandExecution: 'sandboxed' } });
  unsafe.getSandboxStatus = () => ({ effective: true, versionState: 'known_unverified', coverage: 'full', dimensions: {
    filesystem: 'read_only', network: 'blocked', commandExecution: 'sandboxed' } });
  const dispatcher = createDispatcher({ db: db(), providers: { 'unsafe-cli': unsafe, 'codex-cli': safe }, onAgentReply() {} });
  assert.deepEqual(dispatcher.resolveTrustedOwnerTransport('agent-1'), {
    providerId: 'codex-cli', providerType: 'codex', deliveryMode: 'cli' });
});
