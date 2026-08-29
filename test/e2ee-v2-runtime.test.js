'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const {E2eeV2Crypto}=require('../build/e2ee/v2-wasm');
const {E2eeV2Store}=require('../build/e2ee/v2-store');
const {E2eeV2Runtime}=require('../build/e2ee/v2-runtime');
const {E2eeV2DirectoryClient}=require('../build/e2ee/v2-directory-client');

const PROTOCOL='voko.e2ee/2';
const SUITE='X25519-HKDF-SHA256-CHACHA20POLY1305';

test('directory client converts the opaque DOM timeout code 23 into a diagnosable error',async()=>{
  const client=new E2eeV2DirectoryClient({baseUrl:'https://directory.invalid',token:'test-token',timeoutMs:321,
    async fetchImpl(){const error=new Error('The operation was aborted due to timeout');
      error.name='TimeoutError';error.code=23;throw error;}});
  await assert.rejects(client.status(),error=>{
    assert.equal(error.code,'E2EE_V2_DIRECTORY_TIMEOUT');
    assert.equal(error.causeCode,23);
    assert.equal(error.name,'TimeoutError');
    assert.equal(error.operation,'/v1/e2ee/status');
    assert.equal(error.timeoutMs,321);
    return true;
  });
});

test('directory client does not mutate a native DOMException timeout',async()=>{
  const source=new DOMException('The operation was aborted due to timeout','TimeoutError');
  const originalCode=source.code;
  const client=new E2eeV2DirectoryClient({baseUrl:'https://directory.invalid',token:'test-token',timeoutMs:432,
    async fetchImpl(){throw source;}});
  await assert.rejects(client.status(),error=>{
    assert.notEqual(error,source);
    assert.equal(error.cause,source);
    assert.equal(error.code,'E2EE_V2_DIRECTORY_TIMEOUT');
    assert.equal(error.causeCode,originalCode);
    assert.equal(error.name,'TimeoutError');
    assert.equal(error.operation,'/v1/e2ee/status');
    assert.equal(error.timeoutMs,432);
    assert.equal(source.code,originalCode);
    return true;
  });
});

function fixture({failFirstDelivery=false,reviewOutbound,peerKind='guest',providerAcceptedCalls=1,
  deliverSecureReply,providerReply,providerError,directoryErrorOnce=false,keyRegistrationErrorOnce=false,inboundDisposition=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voko-e2ee-v2-'));
  const databasePath=path.join(directory,'e2ee.db');
  const db=new DatabaseSync(databasePath);
  const store=new E2eeV2Store(db,databasePath);
  const guestDevices=new Map();
  function addGuestDevice(deviceId){const endpoint=E2eeV2Crypto.generate();const publicBundle=endpoint.publicBundle();
    guestDevices.set(deviceId,{endpoint,publicBundle});return endpoint;}
  const guest=addGuestDevice('guest-device');
  const guestPublic=guest.publicBundle();
  const agent={localAgentId:'gym',serverAgentId:'agent-server',agentDid:'did:wba:vokovoko.com:agent-server',
    imUid:'agent-im-1'};
  let registered=null,registrationCalls=0,providerCalls=0,deliveryCalls=0,replyEnvelope=null,senderDirectoryCalls=0;
  const sessionScopes=[],dispatcherInputs=[];
  const directoryClient={
    async registerAgentKey(input){registrationCalls+=1;
      if(keyRegistrationErrorOnce&&registrationCalls===1){
        throw Object.assign(new Error('The operation was aborted due to timeout'),{
          name:'TimeoutError',code:'E2EE_V2_DIRECTORY_TIMEOUT',operation:'/v1/e2ee/agent-keys',timeoutMs:10_000});
      }
      registered=input;return{duplicate:false};},
    async resolveSender(input){
      senderDirectoryCalls+=1;
      if(directoryErrorOnce&&senderDirectoryCalls===1){
        throw Object.assign(new Error('bad gateway'),{code:'E2EE_V2_DIRECTORY_HTTP_502'});
      }
      assert.equal(input.localAgentId,agent.serverAgentId);
      const sender=guestDevices.get(input.senderDeviceId);
      assert.ok(sender);
      assert.equal(input.senderKeyId,sender.publicBundle.keyId);
      return{peerKind,peerScopeId:`scope:${input.fromUid}`,
        protocolConversationId:input.conversationKey,
        sender:{deviceId:input.senderDeviceId,generation:1,keyId:sender.publicBundle.keyId,
          publicBundle:sender.publicBundle}};
    },
  };
  const persisted={inbound:[],outbound:[],delivered:[]};
  const runtime=new E2eeV2Runtime({store,directory:directoryClient,agents:()=>[agent],keySyncRetryDelayMs:0,
    dispatcher:{async executeE2ee(input){providerCalls+=1;sessionScopes.push(input.sessionScopeId);dispatcherInputs.push(input);
      if(providerError)throw providerError;
      for(let index=0;index<providerAcceptedCalls;index+=1)input.onProviderAccepted();
      return{reply:{content:providerReply===undefined?`reply:${input.content}`:providerReply}};}},
    persistInbound(agentId,message,plaintext,messageId){persisted.inbound.push({agentId,plaintext,messageId,
      projectedMessageId:message.messageId,clientMsgNo:message.clientMsgNo,routeContext:message._voko,
      toUid:message.toUid,e2eeStrictRoute:message.e2eeStrictRoute,e2eeAgentPeer:message.e2eeAgentPeer});return inboundDisposition;},
    persistOutbound(agentId,channelId,plaintext,messageId,sourceMessageId){
      persisted.outbound.push({agentId,channelId,plaintext,messageId,sourceMessageId});
    },
    markOutboundDelivered(agentId,messageId){persisted.delivered.push({agentId,messageId});},
    reviewOutbound,
    deliverSecureReply,
    async deliverRaw(_agentId,_channelId,envelope){deliveryCalls+=1;replyEnvelope=JSON.parse(envelope);
      if(failFirstDelivery&&deliveryCalls===1)return{success:false,error:'network unknown'};
      return{success:true};},
  });
  async function createEnvelope(messageId,plaintext='hello',overrides={}){
    await runtime.synchronizeAgentKeys();
    assert.ok(registered);
    const recipient=registered.publicBundle;
    const senderDeviceId=overrides.senderDeviceId||'guest-device';
    const sender=guestDevices.get(senderDeviceId);assert.ok(sender);
    const header={version:PROTOCOL,suite:SUITE,messageId,conversationId:'conversation-1',channelId:'guest-im-1',
      agentDid:agent.agentDid,senderDeviceId,senderKeyId:sender.publicBundle.keyId,
      recipientDeviceId:registered.deviceId,recipientKeyId:recipient.keyId,createdAtMs:Date.now(),contentKind:'text',...overrides};
    return sender.endpoint.seal(recipient,header,new TextEncoder().encode(plaintext));
  }
  function close(){runtime.close();for(const sender of guestDevices.values())sender.endpoint.free();
    db.close();fs.rmSync(directory,{recursive:true,force:true});}
  return{runtime,store,guest,guestPublic,agent,persisted,createEnvelope,close,
    counts:()=>({providerCalls,deliveryCalls,senderDirectoryCalls,registrationCalls}),reply:()=>replyEnvelope,sessionScopes,dispatcherInputs,addGuestDevice};
}

test('agent key synchronization retries one transient timeout before reporting success',async()=>{
  const f=fixture({keyRegistrationErrorOnce:true});
  const warnings=[];
  const originalWarn=console.warn;
  console.warn=(message)=>warnings.push(String(message));
  try{
    assert.deepEqual(await f.runtime.synchronizeAgentKeys(),{registered:1,failed:0});
    assert.equal(f.counts().registrationCalls,2);
    assert.match(warnings[0],/code="E2EE_V2_DIRECTORY_TIMEOUT"/);
    assert.match(warnings[0],/name="TimeoutError"/);
    assert.match(warnings[0],/operation="\/v1\/e2ee\/agent-keys"/);
    assert.match(warnings[0],/timeoutMs="10000"/);
    assert.match(warnings[0],/retrying=true/);
  }finally{console.warn=originalWarn;f.close();}
});

test('v2 runtime decrypts, persists, executes once and returns a decryptable reply',async()=>{
  const f=fixture();
  try{
    const envelope=await f.createEnvelope('message-1','hello');
    const message={content:JSON.stringify(envelope),fromUid:'guest-im-1',channelId:'guest-im-1',channelType:1,contentType:13,
      ack(){this.acked=true;}};
    const result=await f.runtime.handle('gym',message);
    assert.equal(result.accepted,true);
    assert.equal(message.acked,true);
    assert.deepEqual(f.persisted.inbound.map(row=>row.plaintext),['hello']);
    assert.deepEqual(f.persisted.outbound.map(row=>row.plaintext),['reply:hello']);
    assert.deepEqual(f.persisted.outbound.map(row=>row.sourceMessageId),['message-1']);
    assert.equal(f.persisted.delivered.length,1);
    assert.equal(f.counts().providerCalls,1);
    assert.equal(f.store.receipt('message-1').state,'completed');
    const reply=f.reply();
    const opened=JSON.parse(new TextDecoder().decode(f.guest.open(JSON.parse(f.store.key('gym').public_bundle_json),reply)));
    assert.equal(opened.version,'voko.e2ee.payload/1');
    assert.equal(opened.text,'reply:hello');
    const duplicate=await f.runtime.handle('gym',message);
    assert.equal(duplicate.code,'duplicate');
    assert.equal(f.counts().providerCalls,1);
  }finally{f.close();}
});

test('business-policy interception completes the receipt without executing Provider',async()=>{
  const f=fixture({inboundDisposition:'intercepted'});
  try{
    const envelope=await f.createEnvelope('message-intercepted','expired service');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.deepEqual(result,{handled:true,accepted:true,code:'inbound_intercepted'});
    assert.equal(f.store.receipt('message-intercepted').state,'completed');
    assert.equal(f.counts().providerCalls,0);
  }finally{f.close();}
});

test('pull-only delivery emits an explicit automatic-delivery-disabled terminal state',async()=>{
  const statuses=[];
  const providerError=Object.assign(new Error('automatic delivery disabled'),{
    code:'AUTOMATIC_DELIVERY_DISABLED',deliveryOutcome:'not_delivered'});
  const f=fixture({providerError,async deliverSecureReply(input){statuses.push(input);return{success:true,deliveryState:'delivered'};}});
  try{
    const envelope=await f.createEnvelope('message-pull-only','please reply');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,false);
    assert.equal(result.code,'AUTOMATIC_DELIVERY_DISABLED');
    assert.deepEqual(statuses.map(item=>item.turnStatus),['processing','automatic_delivery_disabled']);
    assert.equal(statuses.at(-1).content,'Agent 尚未启用自动回复');
  }finally{f.close();}
});

test('v2 reply recovery resends the same ciphertext without re-executing Provider',async()=>{
  const f=fixture({failFirstDelivery:true});
  try{
    const envelope=await f.createEnvelope('message-2','recover');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,false);
    const stored=f.store.receipt('message-2');
    assert.equal(stored.state,'outcome_unknown');
    const immutableReply=stored.reply_envelope_json;
    await f.runtime.recover();
    assert.equal(f.store.receipt('message-2').state,'completed');
    assert.equal(f.store.receipt('message-2').reply_envelope_json,immutableReply);
    assert.deepEqual(f.counts(),{providerCalls:1,deliveryCalls:2,senderDirectoryCalls:1,registrationCalls:1});
  }finally{f.close();}
});

test('transient inbound Directory failure remains recoverable after transport ACK',async()=>{
  const f=fixture({directoryErrorOnce:true});
  try{
    const envelope=await f.createEnvelope('message-transient','retry me');
    const message={content:JSON.stringify(envelope),fromUid:'guest-im-1',channelType:1,contentType:13,
      ack(){this.acked=true;}};
    const first=await f.runtime.handle('gym',message);
    assert.equal(first.accepted,false);
    assert.equal(first.code,'E2EE_V2_DIRECTORY_HTTP_502');
    assert.equal(message.acked,true);
    assert.equal(f.store.receipt('message-transient').state,'received');
    assert.equal(f.counts().providerCalls,0);
    await f.runtime.recover();
    assert.equal(f.store.receipt('message-transient').state,'completed');
    assert.equal(f.counts().providerCalls,1);
  }finally{f.close();}
});

test('guest route with only routeId uses the authenticated protocol conversation and reactivates its transient lock',async()=>{
  const f=fixture();
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im-1',routingConversationId:'conversation-1',
      wireConversationKey:'conversation-1',protocolConversationId:'conversation-1',peerScopeId:'scope:guest-im-1',
      peerKind:'guest',mode:'e2ee_active'});
    f.store.lockConversation('gym','guest-im-1','conversation-1','E2EE_V2_DIRECTORY_HTTP_502');
    const payload=JSON.stringify({version:'voko.e2ee.payload/1',kind:'text',text:'route fallback',
      routeContext:{protocolVersion:1,routeId:'voko_abcdefghijklmnopqrstuvwxyz0123456789'}});
    const envelope=await f.createEnvelope('message-route-fallback',payload);
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.equal(f.store.conversation('gym','guest-im-1','conversation-1').mode,'e2ee_active');
    assert.equal(f.store.conversation('gym','guest-im-1',''),null);
    assert.equal(f.counts().providerCalls,1);
  }finally{f.close();}
});

test('guest secure reply carries the authenticated inbound route id for browser correlation',async()=>{
  let replyInput=null;
  const f=fixture({async deliverSecureReply(input){replyInput=input;return{success:true,deliveryState:'delivered'};}});
  try{
    const routeId='voko_abcdefghijklmnopqrstuvwxyz0123456789';
    const payload=JSON.stringify({version:'voko.e2ee.payload/1',kind:'text',text:'correlate reply',
      routeContext:{protocolVersion:1,routeId}});
    const envelope=await f.createEnvelope('message-reply-correlation',payload);
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.equal(replyInput.replyToRouteId,routeId);
  }finally{f.close();}
});

test('historical pre-Provider locked receipt is recovered exactly once after transient lock revalidation',async()=>{
  const f=fixture();
  try{
    const envelope=await f.createEnvelope('message-old-locked','old locked message');
    const envelopeJson=JSON.stringify(envelope);
    const digest=crypto.createHash('sha256').update(envelopeJson).digest('base64url');
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im-1',routingConversationId:'conversation-1',
      wireConversationKey:'conversation-1',protocolConversationId:'conversation-1',peerScopeId:'scope:guest-im-1',
      peerKind:'guest',mode:'e2ee_active'});
    f.store.lockConversation('gym','guest-im-1','conversation-1','E2EE_V2_DIRECTORY_HTTP_502');
    f.store.reserve({messageId:envelope.messageId,digest,envelopeJson,localAgentId:'gym',
      channelId:'guest-im-1',conversationId:'conversation-1'});
    assert.equal(f.store.claim(envelope.messageId,'old-worker'),true);
    assert.equal(f.store.transition(envelope.messageId,['processing'],'failed','E2EE_V2_CONVERSATION_LOCKED'),true);
    await f.runtime.recover();
    await f.runtime.recover();
    assert.equal(f.store.receipt(envelope.messageId).state,'completed');
    assert.equal(f.counts().providerCalls,1);
    assert.equal(f.persisted.inbound[0].toUid,'agent-im-1');
  }finally{f.close();}
});

test('historical Turn-status Provider conflict lock is revalidated and recovered after upgrade',async()=>{
  const f=fixture();
  try{
    const envelope=await f.createEnvelope('message-old-status-conflict','recover status conflict');
    const envelopeJson=JSON.stringify(envelope);
    const digest=crypto.createHash('sha256').update(envelopeJson).digest('base64url');
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im-1',routingConversationId:'conversation-1',
      wireConversationKey:'conversation-1',protocolConversationId:'conversation-1',peerScopeId:'scope:guest-im-1',
      peerKind:'guest',mode:'e2ee_active'});
    f.store.lockConversation('gym','guest-im-1','conversation-1','E2EE_V2_PROVIDER_STATE_CONFLICT');
    f.store.reserve({messageId:envelope.messageId,digest,envelopeJson,localAgentId:'gym',
      channelId:'guest-im-1',conversationId:'conversation-1'});
    assert.equal(f.store.claim(envelope.messageId,'old-worker'),true);
    assert.equal(f.store.transition(envelope.messageId,['processing'],'failed','E2EE_V2_CONVERSATION_LOCKED'),true);
    await f.runtime.recover();
    assert.equal(f.store.receipt(envelope.messageId).state,'completed');
    assert.equal(f.store.conversation('gym','guest-im-1','conversation-1').mode,'e2ee_active');
    assert.equal(f.counts().providerCalls,1);
  }finally{f.close();}
});

test('historical locked receipt ignores a stale blank route when the authenticated protocol row is active',async()=>{
  const f=fixture();
  try{
    const envelope=await f.createEnvelope('message-old-blank-lock','old blank route message');
    const envelopeJson=JSON.stringify(envelope);
    const digest=crypto.createHash('sha256').update(envelopeJson).digest('base64url');
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im-1',routingConversationId:'conversation-1',
      wireConversationKey:'conversation-1',protocolConversationId:'conversation-1',peerScopeId:'scope:guest-im-1',
      peerKind:'guest',mode:'e2ee_active'});
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im-1',routingConversationId:'',
      wireConversationKey:'',protocolConversationId:'conversation-1',peerScopeId:'scope:guest-im-1',
      peerKind:'guest',mode:'e2ee_active'});
    f.store.lockConversation('gym','guest-im-1','','E2EE_V2_DIRECTORY_HTTP_502');
    f.store.reserve({messageId:envelope.messageId,digest,envelopeJson,localAgentId:'gym',
      channelId:'guest-im-1',conversationId:'conversation-1'});
    assert.equal(f.store.claim(envelope.messageId,'old-worker'),true);
    assert.equal(f.store.transition(envelope.messageId,['processing'],'failed','E2EE_V2_CONVERSATION_LOCKED'),true);
    await f.runtime.recover();
    assert.equal(f.store.receipt(envelope.messageId).state,'completed');
    assert.equal(f.store.conversation('gym','guest-im-1','').mode,'locked');
    assert.equal(f.counts().providerCalls,1);
  }finally{f.close();}
});

test('v2 route mismatch is rejected before Provider execution',async()=>{
  const f=fixture();
  try{
    const envelope=await f.createEnvelope('message-3');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'another-guest',channelType:1,contentType:13});
    assert.equal(result.accepted,false);
    assert.equal(result.code,'E2EE_V2_ROUTE_MISMATCH');
    assert.equal(f.counts().providerCalls,0);
  }finally{f.close();}
});

test('v2 reviews the visible reply before persistence and encryption',async()=>{
  const reviewed=[];
  const f=fixture({reviewOutbound:async input=>{reviewed.push(input);return 'safe replacement';}});
  try{
    const envelope=await f.createEnvelope('message-4','review');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',channelType:1,
      contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.equal(reviewed.length,1);
    assert.equal(reviewed[0].content,'reply:review');
    assert.deepEqual(f.persisted.outbound.map(row=>row.plaintext),['safe replacement']);
    const reply=f.reply();
    const opened=JSON.parse(new TextDecoder().decode(f.guest.open(JSON.parse(f.store.key('gym').public_bundle_json),reply)));
    assert.equal(opened.text,'safe replacement');
  }finally{f.close();}
});

test('v2 Provider sessions stay isolated when two visitors reuse protocol conversation identifiers',async()=>{
  const f=fixture();
  try{
    for(const [messageId,channelId] of [['message-5','guest-im-1'],['message-6','guest-im-2']]){
      const envelope=await f.createEnvelope(messageId,'same conversation',{channelId});
      const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:channelId,
        channelType:1,contentType:13,ack(){}});
      assert.equal(result.accepted,true);
    }
    assert.equal(f.sessionScopes.length,2);
    assert.notEqual(f.sessionScopes[0],f.sessionScopes[1]);
  }finally{f.close();}
});

test('two devices of the same visitor and protocol conversation reuse one Provider session scope',async()=>{
  const f=fixture();
  try{
    f.addGuestDevice('guest-device-2');
    for(const [messageId,senderDeviceId] of [['message-7','guest-device'],['message-8','guest-device-2']]){
      const envelope=await f.createEnvelope(messageId,'same visitor',{senderDeviceId});
      const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
        channelType:1,contentType:13,ack(){}});
      assert.equal(result.accepted,true);
    }
    assert.equal(f.sessionScopes.length,2);
    assert.equal(f.sessionScopes[0],f.sessionScopes[1]);
  }finally{f.close();}
});

test('Agent peer projection uses a receiver-scoped local id while preserving the business id',async()=>{
  const f=fixture({peerKind:'agent'});
  try{
    const envelope=await f.createEnvelope('shared-business-message','agent peer');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.match(f.persisted.inbound[0].messageId,/^e2ee-peer-/);
    assert.equal(f.persisted.inbound[0].projectedMessageId,f.persisted.inbound[0].messageId);
    assert.equal(f.persisted.inbound[0].clientMsgNo,'shared-business-message');
    assert.equal(f.persisted.inbound[0].routeContext,null);
    assert.equal(f.persisted.inbound[0].e2eeStrictRoute,false);
    assert.equal(f.persisted.inbound[0].e2eeAgentPeer,true);
    assert.equal(f.persisted.outbound[0].sourceMessageId,f.persisted.inbound[0].messageId);
    const conversation=f.store.conversationsForChannel('gym','guest-im-1')[0];
    assert.equal(conversation.routing_conversation_id,'conversation-1');
    assert.equal(conversation.wire_conversation_key,'conversation-1');
    assert.equal(conversation.protocol_conversation_id,'conversation-1');
    assert.equal(f.dispatcherInputs[0].sourceType,'agent_peer');
    assert.equal(f.dispatcherInputs[0].peerUid,'guest-im-1');
  }finally{f.close();}
});

test('duplicate Provider accepted callbacks remain idempotent',async()=>{
  const f=fixture({providerAcceptedCalls:2});
  try{
    const envelope=await f.createEnvelope('duplicate-accepted','accepted once');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.equal(f.store.receipt('duplicate-accepted').state,'completed');
    assert.equal(f.counts().providerCalls,1);
    assert.equal(f.persisted.outbound.length,1);
  }finally{f.close();}
});

test('Agent peer secure reply keeps projection and receipt identifiers separate',async()=>{
  const replyInputs=[];
  const f=fixture({peerKind:'agent',async deliverSecureReply(input){replyInputs.push(input);
    return{success:true,deliveryState:'delivered'};}});
  try{
    const envelope=await f.createEnvelope('agent-business-id','reply routing');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,true);
    assert.equal(replyInputs.length,1);
    const replyInput=replyInputs[0];
    assert.equal(replyInput.turnStatus,undefined);
    assert.match(replyInput.sourceMessageId,/^e2ee-peer-/);
    assert.equal(replyInput.sourceReceiptMessageId,'agent-business-id');
    assert.equal(replyInput.protocolConversationId,'conversation-1');
  }finally{f.close();}
});

test('Agent peer Provider failures do not become human status messages',async()=>{
  const replyInputs=[];
  const providerError=Object.assign(new Error('login required'),{
    code:'PROVIDER_AUTH_REQUIRED',deliveryOutcome:'not_delivered'});
  const f=fixture({peerKind:'agent',providerError,async deliverSecureReply(input){replyInputs.push(input);
    return{success:true,deliveryState:'delivered'};}});
  try{
    const envelope=await f.createEnvelope('agent-provider-failure','do work');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.accepted,false);
    assert.equal(result.code,'PROVIDER_AUTH_REQUIRED');
    assert.deepEqual(replyInputs,[]);
  }finally{f.close();}
});

test('Provider NO_REPLY completes without emitting an encrypted control message',async()=>{
  const f=fixture({peerKind:'agent',providerReply:'NO_REPLY'});
  try{
    const envelope=await f.createEnvelope('agent-no-reply','stop here');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.code,'no_reply');
    assert.equal(f.store.receipt('agent-no-reply').state,'completed');
    assert.equal(f.persisted.outbound.length,0);
    assert.equal(f.counts().deliveryCalls,0);
  }finally{f.close();}
});

test('legacy encrypted Agent control messages complete without Provider execution',async()=>{
  const f=fixture({peerKind:'agent'});
  try{
    const envelope=await f.createEnvelope('legacy-agent-control','NO_REPLY');
    const result=await f.runtime.handle('gym',{content:JSON.stringify(envelope),fromUid:'guest-im-1',
      channelType:1,contentType:13,ack(){}});
    assert.equal(result.code,'agent_control');
    assert.equal(f.store.receipt('legacy-agent-control').state,'completed');
    assert.equal(f.counts().providerCalls,0);
    assert.equal(f.persisted.inbound.length,0);
  }finally{f.close();}
});
