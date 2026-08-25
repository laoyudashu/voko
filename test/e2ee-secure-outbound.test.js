'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const {E2eeV2Store}=require('../build/e2ee/v2-store');
const {SecureOutboundRouter}=require('../build/e2ee/secure-outbound-router');
const {decryptE2eeV2Attachment,parseE2eeV2Attachment}=require('../build/e2ee/v2-attachment');

function fixture({capability='supported',directoryError=null,agentPeerEnabled=true,attachmentsEnabled=true,
  peerKind='guest',enabled=true,projectionErrorOnce=false,
  sealError=false,peerScopeId='peer-scope',
  routeContext=()=>({routingConversationId:'routing-1',wireConversationKey:'wire-1'})}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voko-secure-out-'));
  const databasePath=path.join(root,'e2ee.db');
  const db=new DatabaseSync(databasePath);
  const store=new E2eeV2Store(db,databasePath);
  let directoryCalls=0,rawCalls=0;const directoryInputs=[];
  const encrypted=[];
  const delivered=[];const uploads=[];
  let projectionFailures=projectionErrorOnce?1:0;
  const recipients=[1,2].map(index=>({deviceId:`device-${index}`,generation:index,keyId:`key-${index}`,
    publicBundle:{protocolVersion:'voko.e2ee/2',suite:'X25519-HKDF-SHA256-CHACHA20POLY1305',
      keyId:`key-${index}`,hpkePublicKey:'h',signingPublicKey:'s'}}));
  const directory={async resolveRecipients(input){directoryCalls+=1;directoryInputs.push(input);if(directoryError)throw directoryError;
    return{peerKind,peerScopeId,...(peerKind==='agent'?{peerAgentDid:'did:wba:peer-agent'}:{}),capability,
      protocolConversationId:peerKind==='agent'?(input.conversationKey||'agent-context-1'):'guest-conversation',
      revision:'revision-1',expiresAt:Date.now()+300_000,recipients:capability==='supported'?recipients:[]};}};
  const runtime={sealOutbound(_agentId,input){if(sealError)throw new Error('E2EE_V2_SEAL_FAILED');return JSON.stringify({messageId:input.messageId,
    channelId:input.channelId,targetAgentDid:input.targetAgentDid,recipientDeviceId:input.recipientDeviceId,
    recipientKeyId:input.recipientKeyId,plaintext:input.plaintext});}};
  const router=new SecureOutboundRouter({store,directory,runtime,
    rawDeliver:async(...args)=>{rawCalls+=1;return{success:true,messageId:args[6],messageSeq:7,clientMsgNo:args[6]};},
    deliverEncrypted:async(agentId,channelId,envelope,transportMessageId)=>{
      encrypted.push({agentId,channelId,envelope:JSON.parse(envelope),transportMessageId});return{success:true};},
    resolveAgent:()=>({serverAgentId:'server-agent',agentDid:'did:wba:agent',imUid:'agent-im'}),
    resolveRouteContext:routeContext,
    uploadCiphertext:async input=>{uploads.push({...input,ciphertext:Buffer.from(input.ciphertext)});
      return{uploadId:'upload1234',url:'/api/uploads/upload1234'};},
    onBusinessDelivered:(agentId,messageId)=>{if(projectionFailures>0){projectionFailures-=1;throw new Error('projection failed');}
      delivered.push({agentId,messageId});},
    enabled:()=>enabled,agentPeerEnabled:()=>agentPeerEnabled,attachmentsEnabled:()=>attachmentsEnabled});
  return{router,store,db,root,encrypted,delivered,uploads,directoryInputs,counts:()=>({directoryCalls,rawCalls}),
    close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('secure outbound seals one business message for every active guest device',async()=>{
  const f=fixture();
  try{
    const result=await f.router.deliver('gym','guest-im','hello','text',1,null,'business-1',
      {_voko:{protocolVersion:1,routeId:'voko_abcdefghijklmnopqrstuvwxyz0123456789',conversationKey:'wire-1'}});
    assert.equal(result.securityMode,'e2ee');
    assert.equal(result.encryptedDeviceCount,2);
    assert.equal(result.deliveryState,'delivered');
    assert.deepEqual(f.counts(),{directoryCalls:1,rawCalls:0});
    assert.equal(f.encrypted.length,2);
    assert.equal(new Set(f.encrypted.map(row=>row.transportMessageId)).size,2);
    assert.deepEqual(new Set(f.encrypted.map(row=>row.envelope.messageId)),new Set(['business-1']));
    assert.equal(f.store.outboundEnvelopes('business-1').every(row=>row.state==='sent'),true);
    assert.equal(f.store.conversation('gym','guest-im','routing-1').mode,'e2ee_active');
  }finally{f.close();}
});

test('supported recipient snapshot is cached and avoids a second directory query',async()=>{
  const f=fixture();
  try{
    await f.router.deliver('gym','guest-im','one','text',1,null,'business-2');
    await f.router.deliver('gym','guest-im','two','text',1,null,'business-3');
    assert.equal(f.counts().directoryCalls,1);
    assert.equal(f.encrypted.length,4);
  }finally{f.close();}
});

test('never-encrypted unsupported and transient peers use plaintext without being marked unsupported on errors',async()=>{
  for(const options of [{capability:'unsupported'},{directoryError:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})}]){
    const f=fixture(options);
    try{
      const result=await f.router.deliver('gym','guest-im','plain','text',1,null,'business-4');
      assert.equal(result.securityMode,'plaintext');
      assert.equal(result.success,true);
      assert.equal(f.counts().rawCalls,1);
      assert.equal(f.store.conversation('gym','guest-im','routing-1'),null);
    }finally{f.close();}
  }
});

test('transient Directory failures are single-flight cached for ten seconds',async()=>{
  const f=fixture({directoryError:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})});
  try{
    await Promise.all([
      f.router.deliver('gym','guest-im','one','text',1,null,'transient-1'),
      f.router.deliver('gym','guest-im','two','text',1,null,'transient-2'),
    ]);
    await f.router.deliver('gym','guest-im','three','text',1,null,'transient-3');
    assert.equal(f.counts().directoryCalls,1);
    assert.equal(f.counts().rawCalls,3);
  }finally{f.close();}
});

test('an active encrypted conversation stays revalidatable without downgrading when Directory is transiently unavailable',async()=>{
  const first=fixture();
  try{
    await first.router.deliver('gym','guest-im','activate','text',1,null,'business-5');
    const failedDirectory={async resolveRecipients(){throw Object.assign(new Error('offline'),{code:'ETIMEDOUT'});}};
    const second=new SecureOutboundRouter({store:first.store,directory:failedDirectory,
      runtime:{sealOutbound(){throw new Error('must not seal');}},rawDeliver:async()=>{throw new Error('must not downgrade');},
      deliverEncrypted:async()=>({success:true}),resolveAgent:()=>({serverAgentId:'server-agent',agentDid:'did',imUid:'im'}),
      resolveRouteContext:()=>({routingConversationId:'routing-1',wireConversationKey:'wire-1'}),
      enabled:()=>true,agentPeerEnabled:()=>true});
    const result=await second.deliver('gym','guest-im','blocked','text',1,null,'business-6');
    assert.equal(result.success,false);
    assert.equal(result.securityMode,'e2ee');
    assert.equal(first.store.conversation('gym','guest-im','routing-1').mode,'e2ee_active');
  }finally{first.close();}
});

test('a conversation locked by a transient Directory failure reactivates only after identity revalidation',async()=>{
  const f=fixture();
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    f.store.lockConversation('gym','guest-im','routing-1','E2EE_V2_DIRECTORY_HTTP_502');
    const result=await f.router.deliver('gym','guest-im','after recovery','text',1,null,'business-revalidated');
    assert.equal(result.success,true);
    assert.equal(result.securityMode,'e2ee');
    const conversation=f.store.conversation('gym','guest-im','routing-1');
    assert.equal(conversation.mode,'e2ee_active');
    assert.equal(conversation.lock_reason,null);
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('background refresh reactivates historical transient locks after Directory recovery',async()=>{
  const f=fixture();
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    f.store.lockConversation('gym','guest-im','routing-1','E2EE_V2_DIRECTORY_HTTP_502');
    f.db.prepare(`UPDATE e2ee_v2_conversations SET last_verified_at=0 WHERE local_agent_id='gym'`).run();
    await f.router.refreshActive();
    assert.equal(f.store.conversation('gym','guest-im','routing-1').mode,'e2ee_active');
  }finally{f.close();}
});

test('a transient lock becomes permanent when Directory reports a different peer identity',async()=>{
  const f=fixture({peerScopeId:'replacement-peer-scope'});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'original-peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    f.store.lockConversation('gym','guest-im','routing-1','E2EE_V2_DIRECTORY_HTTP_502');
    const result=await f.router.deliver('gym','guest-im','must remain blocked','text',1,null,'business-changed-lock');
    assert.equal(result.success,false);
    assert.equal(result.error,'E2EE_V2_PEER_IDENTITY_CHANGED');
    const conversation=f.store.conversation('gym','guest-im','routing-1');
    assert.equal(conversation.mode,'locked');
    assert.equal(conversation.lock_reason,'E2EE_V2_PEER_IDENTITY_CHANGED');
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('disabling new E2EE upgrades does not downgrade an already-active conversation',async()=>{
  const f=fixture({enabled:false});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    const result=await f.router.deliver('gym','guest-im','still encrypted','text',1,null,'business-active-flag');
    assert.equal(result.securityMode,'e2ee');
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('an encryption failure returns a structured error and locks an active conversation',async()=>{
  const f=fixture({sealError:true});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    const result=await f.router.deliver('gym','guest-im','cannot seal','text',1,null,'business-seal-fail');
    assert.equal(result.success,false);
    assert.equal(result.error,'E2EE_V2_SEAL_FAILED');
    assert.equal(f.store.conversation('gym','guest-im','routing-1').mode,'locked');
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('an active conversation locks when the authoritative peer identity changes',async()=>{
  const f=fixture({peerScopeId:'replacement-peer-scope'});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'original-peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    const result=await f.router.deliver('gym','guest-im','must not cross identity','text',1,null,'business-identity');
    assert.equal(result.success,false);
    assert.equal(result.error,'E2EE_V2_PEER_IDENTITY_CHANGED');
    assert.equal(f.store.conversation('gym','guest-im','routing-1').mode,'locked');
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('a present but invalid route context fails closed before Directory and transport access',async()=>{
  const f=fixture({routeContext:()=>{throw new Error('E2EE_V2_ROUTE_INVALID');}});
  try{
    const result=await f.router.deliver('gym','guest-im','must not route','text',1,null,'business-bad-route',
      {_voko:{protocolVersion:1,routeId:'voko_abcdefghijklmnopqrstuvwxyz0123456789'}});
    assert.equal(result.success,false);
    assert.equal(result.error,'E2EE_V2_ROUTE_INVALID');
    assert.deepEqual(f.counts(),{directoryCalls:0,rawCalls:0});
  }finally{f.close();}
});

test('group messages bypass E2EE and preserve the raw delivery path',async()=>{
  const f=fixture();
  try{
    const result=await f.router.deliver('gym','group-1','hello group','text',2,null,'business-7');
    assert.equal(result.securityMode,'plaintext');
    assert.deepEqual(f.counts(),{directoryCalls:0,rawCalls:1});
  }finally{f.close();}
});

test('Provider reply receipt and fixed multi-device outbox commit atomically before delivery',async()=>{
  const f=fixture();
  try{
    f.store.reserve({messageId:'source-1',digest:'digest-1',envelopeJson:'{}',localAgentId:'gym',
      channelId:'guest-im',conversationId:'guest-conversation'});
    assert.equal(f.store.claim('source-1','provider-worker'),true);
    assert.equal(f.store.transition('source-1',['processing'],'provider_accepted'),true);
    const result=await f.router.deliver('gym','guest-im','provider reply','text',1,null,'business-reply-1',null,
      {sourceReceiptMessageId:'source-1'});
    assert.equal(result.deliveryState,'delivered');
    assert.equal(f.store.receipt('source-1').state,'completed');
    assert.equal(f.store.receipt('source-1').reply_message_id,'business-reply-1');
    assert.equal(f.store.outboundEnvelopes('business-reply-1').length,2);
    assert.deepEqual(f.delivered,[{agentId:'gym',messageId:'business-reply-1'}]);
  }finally{f.close();}
});

test('a crash between transport delivery and main message projection is recovered without resending ciphertext',async()=>{
  const f=fixture({projectionErrorOnce:true});
  try{
    const first=await f.router.deliver('gym','guest-im','project later','text',1,null,'business-project-1');
    assert.equal(first.deliveryState,'delivered');
    assert.equal(f.encrypted.length,2);
    assert.equal(f.delivered.length,0);
    await f.router.recover();
    assert.equal(f.encrypted.length,2);
    assert.deepEqual(f.delivered,[{agentId:'gym',messageId:'business-project-1'}]);
    assert.ok(f.store.outboundMessage('business-project-1').projected_at);
  }finally{f.close();}
});

test('private attachment uploads ciphertext once and seals one manifest per recipient device',async()=>{
  const f=fixture();const file=path.join(f.root,'plain.txt');const plaintext=Buffer.from('private attachment body');
  fs.writeFileSync(file,plaintext);
  try{
    const result=await f.router.deliver('gym','guest-im','local-only-url','file',1,null,'business-attachment-1',
      {_e2eeAttachment:{filePath:file,fileName:'plain.txt',mediaType:'text/plain'}});
    assert.equal(result.securityMode,'e2ee');
    assert.equal(result.encryptedDeviceCount,2);
    assert.equal(f.uploads.length,1);
    assert.notDeepEqual(f.uploads[0].ciphertext,plaintext);
    assert.equal(f.counts().rawCalls,0);
    const stored=f.store.outboundAttachment('business-attachment-1');
    assert.ok(stored);
    const manifest=parseE2eeV2Attachment(stored.manifest_json);
    assert.equal(manifest.fileName,'plain.txt');
    assert.deepEqual(decryptE2eeV2Attachment(f.uploads[0].ciphertext,manifest),plaintext);
    assert.equal(f.encrypted.length,2);
    for(const row of f.encrypted){
      const payload=JSON.parse(row.envelope.plaintext);
      assert.equal(payload.version,'voko.e2ee.payload/1');
      assert.equal(payload.kind,'attachment_manifest');
      assert.equal(payload.attachment.messageId,'business-attachment-1');
    }
  }finally{f.close();}
});

test('attachment metadata cannot fall through to a plaintext local URL when E2EE attachments are disabled',async()=>{
  const f=fixture({attachmentsEnabled:false});const file=path.join(f.root,'plain.txt');fs.writeFileSync(file,'secret');
  try{
    const prepared=await f.router.prepare('gym','guest-im',1,null,'attachment');
    assert.equal(prepared.securityMode,'plaintext');
    assert.equal(prepared.securityReason,'attachment_e2ee_disabled');
    const result=await f.router.deliver('gym','guest-im','/api/e2ee-v2/attachments/local','file',1,null,
      'business-attachment-2',{_e2eeAttachment:{filePath:file,fileName:'plain.txt',mediaType:'text/plain'}});
    assert.equal(result.success,false);
    assert.equal(result.error,'E2EE_V2_ATTACHMENT_DISABLED');
    assert.equal(f.counts().rawCalls,0);
    assert.equal(f.uploads.length,0);
  }finally{f.close();}
});

test('an active encrypted conversation cannot downgrade attachments when that rollout flag is disabled',async()=>{
  const f=fixture({attachmentsEnabled:false});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'guest-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'guest-conversation',peerScopeId:'peer-scope',
      peerKind:'guest',mode:'e2ee_active',recipientRevision:'revision-0'});
    const prepared=await f.router.prepare('gym','guest-im',1,null,'attachment');
    assert.equal(prepared.success,false);
    assert.equal(prepared.securityMode,'e2ee');
    assert.equal(prepared.error,'E2EE_V2_ATTACHMENT_DISABLED');
    assert.equal(f.counts().rawCalls,0);
  }finally{f.close();}
});

test('Agent peer without an explicit route persists one stable protocol context',async()=>{
  const f=fixture({peerKind:'agent',routeContext:()=>null});
  try{
    await f.router.deliver('gym','peer-agent-im','first','text',1,null,'agent-business-1');
    await f.router.deliver('gym','peer-agent-im','second','text',1,null,'agent-business-2');
    const conversations=f.store.conversationsForChannel('gym','peer-agent-im');
    assert.equal(conversations.length,1);
    assert.equal(conversations[0].protocol_conversation_id,'agent-context-1');
    assert.equal(conversations[0].wire_conversation_key,'agent-context-1');
    assert.equal(f.directoryInputs[1].conversationKey,'agent-context-1');
    assert.equal(f.encrypted[0].envelope.channelId,'agent-im');
    assert.equal(f.encrypted[0].envelope.targetAgentDid,'did:wba:peer-agent');
    assert.equal(f.encrypted[0].envelope.recipientDeviceId,'device-1');
    assert.equal(f.encrypted[0].envelope.plaintext.includes('first'),true);
    assert.deepEqual(new Set(f.encrypted.map(row=>row.envelope.plaintext&&row.envelope.messageId)),
      new Set(['agent-business-1','agent-business-2']));
  }finally{f.close();}
});

test('Agent peer routing conversations remain separate E2EE protocol contexts',async()=>{
  const f=fixture({peerKind:'agent',routeContext:()=>null});
  try{
    await f.router.deliver('gym','peer-agent-im','one','text',1,null,'agent-business-a',
      {_voko:{protocolVersion:1,conversationKey:'wire-conversation-a'}});
    await f.router.deliver('gym','peer-agent-im','two','text',1,null,'agent-business-b',
      {_voko:{protocolVersion:1,conversationKey:'wire-conversation-b'}});
    assert.deepEqual(f.store.conversationsForChannel('gym','peer-agent-im')
      .map(row=>row.protocol_conversation_id).sort(),['wire-conversation-a','wire-conversation-b']);
  }finally{f.close();}
});

test('trusted inbound Agent context routes the secure reply without resolving a foreign local Route Context',async()=>{
  const f=fixture({peerKind:'agent',routeContext:()=>{throw new Error('foreign route must not be resolved');}});
  try{
    const result=await f.router.deliver('gym','peer-agent-im','reply','text',1,null,'agent-reply-1',
      {_voko:{protocolVersion:1,routeId:'foreign-route',canonicalConversationKey:'foreign-wire'}},
      {protocolConversationId:'trusted-context-1'});
    assert.equal(result.securityMode,'e2ee');
    assert.equal(result.success,true);
    assert.equal(f.directoryInputs[0].conversationKey,'trusted-context-1');
    assert.equal(f.store.conversation('gym','peer-agent-im','trusted-context-1').protocol_conversation_id,
      'trusted-context-1');
  }finally{f.close();}
});

test('a stale sender-local Agent row cannot lock the authoritative protocol context',async()=>{
  const f=fixture({peerKind:'agent'});
  try{
    f.store.saveConversation({localAgentId:'gym',channelId:'peer-agent-im',routingConversationId:'routing-1',
      wireConversationKey:'wire-1',protocolConversationId:'legacy-context',peerScopeId:'old-peer',
      peerKind:'agent',mode:'locked',lockReason:'legacy stale row'});
    const result=await f.router.deliver('gym','peer-agent-im','new turn','text',1,null,'agent-business-clean',
      {_voko:{protocolVersion:1,conversationKey:'authoritative-context-1'}},
      {protocolConversationId:'authoritative-context-1'});
    assert.equal(result.success,true);
    assert.equal(result.securityMode,'e2ee');
    assert.equal(f.store.conversation('gym','peer-agent-im','authoritative-context-1').mode,'e2ee_active');
    assert.equal(f.store.conversation('gym','peer-agent-im','routing-1').mode,'locked');
  }finally{f.close();}
});
