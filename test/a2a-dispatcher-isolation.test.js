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

test('trusted Owner Chat forwards raw content without Provider security restrictions', async () => {
  const provider = new Provider();
  provider.pushOwner = function(payload, context) { this.payload=payload;this.ownerContext=context;
    setImmediate(() => this.emit('agent.reply',{agentId:payload.agentId,visitorId:payload.fromUid,turnId:payload.turnId,
      replyId:'owner-chat-reply',content:'isolated-result',done:true}));return{nativeSessionId:'owner-native'}; };
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-app-server': provider }, onAgentReply() {} });
  const content = 'continue the local work session';
  const transport=dispatcher.getOwnerTransportStatus('agent-1');
  const ownerExecutionContext={sourceType:'owner_chat',authority:'verified_owner_conversation',executionScope:'owner_chat',
    ownerConversationId:'owner-chat-conversation',commandMessageId:'owner-chat-message',ownershipEpoch:1,
    conversationEpoch:1,policyEpoch:1,configDigest:transport.configDigest,providerId:transport.providerId};
  const result = await dispatcher.executeOwner({ agentId: 'agent-1', taskId: 'owner-chat-message',
    contextId: 'owner-chat-conversation', content, sourceType: 'owner_chat',
    executionScope: 'owner_chat', ownerExecutionContext, timeoutMs: 1000 });
  assert.equal(result.reply.content, 'isolated-result');
  assert.equal(provider.payload.content, content);
  assert.equal(provider.payload.rawContent, content);
  assert.equal(provider.payload.securityContext, undefined);
  assert.equal(provider.payload.executionScope, 'owner_chat');
  assert.equal(provider.payload.content.includes('[VOKO SECURITY CONTEXT]'), false);
  assert.equal(provider.payload.content.includes('[VOKO VERIFIED OWNER MESSAGE]'), false);
  assert.equal(provider.ownerContext,ownerExecutionContext);
});

test('Owner Chat never falls back to an ordinary visitor push transport',async()=>{
  const provider=new Provider();
  const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  const context={sourceType:'owner_chat',authority:'verified_owner_conversation',executionScope:'owner_chat',ownerConversationId:'c',commandMessageId:'m',configDigest:'x',providerId:'codex-cli'};
  await assert.rejects(dispatcher.executeOwner({agentId:'agent-1',taskId:'m',contextId:'c',content:'hello',ownerExecutionContext:context,timeoutMs:100}),
    error=>error.code==='OWNER_WORKSPACE_ISOLATION_UNAVAILABLE');
  assert.equal(provider.payload,undefined);
});

test('isolated reply timeout is handled while Provider delivery is still pending', async () => {
  const provider = new Provider();
  provider.push = async function (payload) { this.payload = payload; await new Promise(resolve => setTimeout(resolve, 30));
    return { nativeSessionId: 'slow-native-session' }; };
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': provider }, onAgentReply() {} });
  await assert.rejects(dispatcher.executeIsolated({ agentId: 'agent-1', taskId: 'slow-message',
    contextId: 'slow-conversation', content: 'slow delivery', sourceType: 'agent_peer',
    executionScope: 'a2a_mailbox', timeoutMs: 10 }), /Provider reply timed out/);
});

test('trusted Owner bootstrap selects only the explicit native I/O bridge', async () => {
  const safe = new Provider(); safe.pushOwner = () => {};
  const unsafe = new Provider();
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': unsafe, 'codex-app-server': safe }, onAgentReply() {} });
  assert.deepEqual(dispatcher.resolveTrustedOwnerTransport('agent-1'), {
    providerId: 'codex-app-server', providerType: 'codex', providerInstanceId: null, deliveryMode: 'owner_io' });
});
