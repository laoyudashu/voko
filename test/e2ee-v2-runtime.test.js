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

const PROTOCOL='voko.e2ee/2';
const SUITE='X25519-HKDF-SHA256-CHACHA20POLY1305';

function fixture({failFirstDelivery=false,reviewOutbound}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voko-e2ee-v2-'));
  const databasePath=path.join(directory,'e2ee.db');
  const db=new DatabaseSync(databasePath);
  const store=new E2eeV2Store(db,databasePath);
  const guest=E2eeV2Crypto.generate();
  const guestPublic=guest.publicBundle();
  const agent={localAgentId:'gym',serverAgentId:'agent-server',agentDid:'did:wba:vokovoko.com:agent-server'};
  let registered=null,providerCalls=0,deliveryCalls=0,replyEnvelope=null;
  const sessionScopes=[];
  const directoryClient={
    async registerAgentKey(input){registered=input;return{duplicate:false};},
    async resolveGuestKey(input){
      assert.equal(input.agentId,agent.serverAgentId);
      assert.equal(input.deviceId,'guest-device');
      assert.equal(input.keyId,guestPublic.keyId);
      return{agentId:agent.serverAgentId,agentDid:agent.agentDid,deviceId:'guest-device',generation:1,publicBundle:guestPublic};
    },
  };
  const persisted={inbound:[],outbound:[]};
  const runtime=new E2eeV2Runtime({store,directory:directoryClient,agents:()=>[agent],
    dispatcher:{async executeE2ee(input){providerCalls+=1;sessionScopes.push(input.sessionScopeId);
      input.onProviderAccepted();return{reply:{content:`reply:${input.content}`}};}},
    persistInbound(agentId,message,plaintext,messageId){persisted.inbound.push({agentId,plaintext,messageId});return true;},
    persistOutbound(agentId,channelId,plaintext,messageId){persisted.outbound.push({agentId,channelId,plaintext,messageId});},
    reviewOutbound,
    async deliverRaw(_agentId,_channelId,envelope){deliveryCalls+=1;replyEnvelope=JSON.parse(envelope);
      if(failFirstDelivery&&deliveryCalls===1)return{success:false,error:'network unknown'};
      return{success:true};},
  });
  async function createEnvelope(messageId,plaintext='hello',overrides={}){
    await runtime.synchronizeAgentKeys();
    assert.ok(registered);
    const recipient=registered.publicBundle;
    const header={version:PROTOCOL,suite:SUITE,messageId,conversationId:'conversation-1',channelId:'guest-im-1',
      agentDid:agent.agentDid,senderDeviceId:'guest-device',senderKeyId:guestPublic.keyId,
      recipientDeviceId:registered.deviceId,recipientKeyId:recipient.keyId,createdAtMs:Date.now(),contentKind:'text',...overrides};
    return guest.seal(recipient,header,new TextEncoder().encode(plaintext));
  }
  function close(){runtime.close();guest.free();db.close();fs.rmSync(directory,{recursive:true,force:true});}
  return{runtime,store,guest,guestPublic,agent,persisted,createEnvelope,close,
    counts:()=>({providerCalls,deliveryCalls}),reply:()=>replyEnvelope,sessionScopes};
}

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
    assert.equal(f.counts().providerCalls,1);
    assert.equal(f.store.receipt('message-1').state,'completed');
    const reply=f.reply();
    assert.equal(new TextDecoder().decode(f.guest.open(JSON.parse(f.store.key('gym').public_bundle_json),reply)),'reply:hello');
    const duplicate=await f.runtime.handle('gym',message);
    assert.equal(duplicate.code,'duplicate');
    assert.equal(f.counts().providerCalls,1);
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
    assert.deepEqual(f.counts(),{providerCalls:1,deliveryCalls:2});
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
    assert.equal(new TextDecoder().decode(f.guest.open(JSON.parse(f.store.key('gym').public_bundle_json),reply)),
      'safe replacement');
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
