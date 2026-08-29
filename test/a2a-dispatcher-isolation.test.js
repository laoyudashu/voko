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
function keepEventLoopAlive(promise) {
  const timer = setInterval(() => {}, 1000);
  return promise.finally(() => clearInterval(timer));
}
test('isolated execution captures reply without ordinary reply callback or binding commit', async () => {
  const provider = new Provider(); const ordinary = [];
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': provider }, onAgentReply: reply => ordinary.push(reply) });
  const result = await dispatcher.executeIsolated({ agentId: 'agent-1', taskId: 'task-1', contextId: 'context-1', content: 'hello', timeoutMs: 1000,
    executionScope:'a2a_mailbox',principalScope:'principal-scope-1',sessionScopeId:'session-scope-1',protocolContextId:'context-1',bindingGeneration:1 });
  assert.equal(result.reply.content, 'isolated-result'); assert.equal(result.receipt.deliveryReceipt.nativeSessionId, 'native-a2a-session');
  assert.equal(ordinary.length, 0); assert.equal(provider.payload.executionScope, 'a2a_mailbox');
  assert.equal(provider.payload.securityContext.sourceType, 'agent_peer');
  assert.match(provider.payload.content, /普通问候、问题和任务请求仍应正常回复/);
  assert.equal(provider.payload.providerBinding, null);
});
test('E2EE Agent peer uses Agent governance and strips control state from the visible reply', async()=>{
  const provider=new Provider();
  provider.push=function(payload){this.payload=payload;setImmediate(()=>this.emit('agent.reply',{
    agentId:payload.agentId,visitorId:payload.fromUid,turnId:payload.turnId,replyId:'e2ee-peer-reply',
    content:'[STATE]{"goal":"finish","agenda":[],"turn":1,"proposal":"done","expects_reply":false,"converged":true}[/STATE]\n[FINAL]peer-visible result[/FINAL]',done:true}));
    return{nativeSessionId:'provider-native-thread'};};
  const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  const result=await dispatcher.executeE2ee({agentId:'agent-1',taskId:'e2ee-task-1',
    contextId:'67ad73dc-bc3d-4463-8e5b-7637765935f4',content:'peer request',
    sourceType:'agent_peer',peerUid:'peer-agent-uid',sessionScopeId:'isolated-session-scope',timeoutMs:1000});
  assert.equal(result.reply.content,'peer-visible result');
  assert.equal(provider.payload.sourceType,'agent_peer');
  assert.equal(provider.payload.securityContext.sourceType,'agent_peer');
  assert.match(provider.payload.content,/\[VOKO A2A CONTROL\]/);
  assert.equal(provider.payload.protocolContextId,'67ad73dc-bc3d-4463-8e5b-7637765935f4');
  assert.equal(provider.payload.sessionScopeId,'isolated-session-scope');
});
test('E2EE owner intervention ends the original turn without waiting for a Provider reply', async()=>{
  const provider=new Provider();
  provider.push=function(payload){this.payload=payload;return{nativeSessionId:'provider-native-thread'};};
  let markIntervention;
  const interventionCreated=new Promise(resolve=>{markIntervention=resolve;});
  const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  const pending=dispatcher.executeE2ee({agentId:'agent-1',taskId:'e2ee-owner-task',
    contextId:'e2ee-owner-context',content:'need owner',sourceType:'visitor',
    sessionScopeId:'e2ee-owner-scope',timeoutMs:1000,ownerInterventionCreated:interventionCreated});
  await new Promise(resolve=>setImmediate(resolve));
  markIntervention();
  const result=await pending;
  assert.equal(result.reply.content,'NO_REPLY');
});
test('A2A execution without a verified principal scope fails before Provider selection', async()=>{
  const provider=new Provider();const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  await assert.rejects(dispatcher.executeIsolated({agentId:'agent-1',taskId:'task-1',contextId:'same',content:'x',executionScope:'a2a_mailbox'}),
    error=>error.code==='A2A_PRINCIPAL_SCOPE_REQUIRED');
  assert.equal(provider.payload,undefined);
});
test('A2A exact routing rejects an incompatible native session namespace without fallback',async()=>{
  const provider=new Provider();const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  const binding={id:'a2a-binding',bindingVersion:1,providerType:'codex',providerInstanceId:null,deliveryMode:'cli',adapterType:'codex-cli',
    nativeSessionId:'native-old',nativeSessionNamespace:'other-cli',restoreCompatibilityGroup:'other-cli',sessionOrigin:'voko_managed',
    channelId:'session-scope-1',channelType:1,sourceScope:'a2a',strictSessionRoute:true};
  await assert.rejects(dispatcher.executeIsolated({agentId:'agent-1',taskId:'task-1',contextId:'ctx',content:'x',binding,
    executionScope:'a2a_mailbox',principalScope:'principal-scope-1',sessionScopeId:'session-scope-1',protocolContextId:'ctx',bindingGeneration:1}),
    error=>['not_delivered','outcome_unknown'].includes(error.deliveryOutcome));
  assert.equal(provider.payload,undefined);
});
test('A2A exact routing rejects a stale binding generation before Provider execution',async()=>{
  const provider=new Provider();const dispatcher=createDispatcher({db:db(),providers:{'codex-cli':provider},onAgentReply(){}});
  const binding={id:'a2a-binding',bindingVersion:1,providerType:'codex',providerInstanceId:null,deliveryMode:'cli',adapterType:'codex-cli',
    nativeSessionId:'native-old',nativeSessionNamespace:'codex-cli',restoreCompatibilityGroup:'codex-cli',sessionOrigin:'voko_managed',
    channelId:'session-scope-1',channelType:1,sourceScope:'a2a',strictSessionRoute:true};
  await assert.rejects(dispatcher.executeIsolated({agentId:'agent-1',taskId:'task-1',contextId:'ctx',content:'x',binding,
    executionScope:'a2a_mailbox',principalScope:'principal-scope-1',sessionScopeId:'session-scope-1',protocolContextId:'ctx',bindingGeneration:2}),
    error=>['not_delivered','outcome_unknown'].includes(error.deliveryOutcome));
  assert.equal(provider.payload,undefined);
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
  const ordinary = [];
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': provider }, onAgentReply(reply) { ordinary.push(reply); } });
  await assert.rejects(keepEventLoopAlive(dispatcher.executeIsolated({ agentId: 'agent-1', taskId: 'slow-message',
    contextId: 'slow-conversation', content: 'slow delivery', sourceType: 'agent_peer',
    executionScope: 'a2a_mailbox', principalScope:'principal-scope-1',sessionScopeId:'session-scope-1',protocolContextId:'slow-conversation',bindingGeneration:1,timeoutMs: 5_000 })), error => {
      assert.match(error.message, /Provider reply timed out/);
      assert.equal(error.deliveryOutcome, 'outcome_unknown');
      assert.equal(error.code, 'A2A_PROVIDER_REPLY_TIMEOUT');
      return true;
    });
  provider.emit('agent.reply', { agentId: 'agent-1', visitorId: provider.payload.fromUid,
    turnId: provider.payload.turnId, replyId: 'late-reply', content: 'late isolated result', done: true });
  provider.emit('agent.reply', { agentId: 'agent-1', visitorId: provider.payload.fromUid,
    replyId: 'missing-turn', content: 'unattributed isolated result', done: true });
  assert.equal(ordinary.length, 0, 'late or unattributed isolated replies must never enter the ordinary message path');
});

test('E2EE and Owner Chat timeouts use stable outcome-unknown results', async () => {
  const e2eeProvider = new Provider();
  e2eeProvider.push = payload => { e2eeProvider.payload = payload; return { nativeSessionId: 'e2ee-timeout-session' }; };
  const ownerProvider = new Provider();
  ownerProvider.pushOwner = payload => { ownerProvider.payload = payload; return { nativeSessionId: 'owner-timeout-session' }; };
  const e2eeDispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': e2eeProvider }, onAgentReply() {} });
  const ownerDispatcher = createDispatcher({ db: db(), providers: { 'codex-app-server': ownerProvider }, onAgentReply() {} });
  const transport = ownerDispatcher.getOwnerTransportStatus('agent-1');
  const ownerExecutionContext = { sourceType:'owner_chat',authority:'verified_owner_conversation',executionScope:'owner_chat',
    ownerConversationId:'owner-timeout-context',commandMessageId:'owner-timeout-task',configDigest:transport.configDigest,
    providerId:transport.providerId };
  const [e2ee, owner] = await keepEventLoopAlive(Promise.allSettled([
    e2eeDispatcher.executeE2ee({ agentId:'agent-1',taskId:'e2ee-timeout-task',contextId:'e2ee-timeout-context',
      content:'wait',sessionScopeId:'e2ee-timeout-scope',timeoutMs:5_000 }),
    ownerDispatcher.executeOwner({ agentId:'agent-1',taskId:'owner-timeout-task',contextId:'owner-timeout-context',
      content:'wait',sourceType:'owner_chat',executionScope:'owner_chat',ownerExecutionContext,timeoutMs:5_000 }),
  ]));
  for (const [result, code] of [[e2ee, 'E2EE_V2_PROVIDER_REPLY_TIMEOUT'], [owner, 'OWNER_PROVIDER_REPLY_TIMEOUT']]) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, code);
    assert.equal(result.reason.deliveryOutcome, 'outcome_unknown');
  }
});

test('internal Provider tool protocol is never delivered as a final reply', async () => {
  const provider = new Provider();
  provider.push = function(payload) {
    setImmediate(() => this.emit('agent.reply', { agentId:payload.agentId,visitorId:payload.fromUid,
      turnId:payload.turnId,replyId:'internal-protocol',done:true,
      content:'< | | DSML | | tool_calls>\n< | | DSML | | invoke name="Read">' }));
    return { nativeSessionId:'internal-protocol-session' };
  };
  const ordinary = [];
  const dispatcher = createDispatcher({ db:db(),providers:{'codex-cli':provider},onAgentReply:reply=>ordinary.push(reply) });
  await assert.rejects(dispatcher.executeE2ee({ agentId:'agent-1',taskId:'internal-task',contextId:'internal-context',
    content:'hello',sessionScopeId:'internal-scope',timeoutMs:5_000 }), error => {
    assert.equal(error.code, 'PROVIDER_INTERNAL_PROTOCOL_OUTPUT');
    assert.equal(error.deliveryOutcome, 'outcome_unknown');
    return true;
  });
  assert.equal(ordinary.length, 0);
});

test('internal Provider tool protocol is rejected even after ordinary-looking text', async () => {
  const provider = new Provider();
  provider.push = function(payload) {
    setImmediate(() => this.emit('agent.reply', { agentId:payload.agentId,visitorId:payload.fromUid,
      turnId:payload.turnId,replyId:'prefixed-internal-protocol',done:true,
      content:'I will inspect the file now.\n<tool_calls>\n<Read><file_path>/private/file</file_path></Read>\n</tool_calls>' }));
    return { nativeSessionId:'prefixed-internal-protocol-session' };
  };
  const ordinary = [];
  const dispatcher = createDispatcher({ db:db(),providers:{'qwen-office-cli':provider},onAgentReply:reply=>ordinary.push(reply) });
  await assert.rejects(dispatcher.executeE2ee({ agentId:'agent-1',taskId:'prefixed-internal-task',
    contextId:'prefixed-internal-context',content:'hello',sessionScopeId:'prefixed-internal-scope',timeoutMs:5_000 }), error => {
    assert.equal(error.code, 'PROVIDER_INTERNAL_PROTOCOL_OUTPUT');
    return true;
  });
  assert.equal(ordinary.length, 0);
});

test('trusted Owner bootstrap selects only the explicit native I/O bridge', async () => {
  const safe = new Provider(); safe.pushOwner = () => {};
  const unsafe = new Provider();
  const dispatcher = createDispatcher({ db: db(), providers: { 'codex-cli': unsafe, 'codex-app-server': safe }, onAgentReply() {} });
  assert.deepEqual(dispatcher.resolveTrustedOwnerTransport('agent-1'), {
    providerId: 'codex-app-server', providerType: 'codex', providerInstanceId: null, deliveryMode: 'owner_io' });
});

test('unknown remote Agent uid stays classified as Agent while the cloud lookup is unavailable', () => {
  const emptyDb = { prepare() { return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }; } };
  const dispatcher = createDispatcher({ db: emptyDb, providers: {}, onAgentReply() {} });
  assert.equal(dispatcher.isAgentImUid('agent_remote_not_cached'), true);
  assert.equal(dispatcher.isAgentImUid('visitor_remote_not_cached'), false);
});
