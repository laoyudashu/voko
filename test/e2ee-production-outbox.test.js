const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { ProductionE2eeStore } = require('../build/e2ee/production-store');
const { ProductionE2eePolicy } = require('../build/e2ee/production-policy');
const { CanaryRuntime } = require('../build/e2ee/canary-runtime');

function directScope() {
  return {
    localAgentId:'gym',serverAgentId:'server-gym',targetAgentDid:'did:wba:test:gym',
    creatorPrincipalId:'visitor-1',creatorDeviceBindingId:'guest-device-1',protocolMode:'direct_v2',
    senderDeviceKeyId:'',recipientDeviceKeyId:'lite-device-gym',ownerScope:'owner',
    groupId:'group-direct',conversationScope:'conversation-direct',bindingGeneration:1,
  };
}

function seed(store) {
  const scope = directScope();
  store.commitEstablishment({establishmentId:'est-direct',scope,encryptedState:Buffer.from('state-1'),
    acknowledgement:{ok:true},nextKeyPackage:{localAgentId:'gym',serverAgentId:'server-gym',
      targetAgentDid:scope.targetAgentDid,ownerDeviceKeyId:scope.recipientDeviceKeyId,
      ownerScope:scope.ownerScope,keyEpoch:1,keyPackageRef:'next',keyPackage:'bmV4dA',
      encryptedPendingState:Buffer.from('pending'),publishState:'pending'}});
}

function inbound() {
  const scope = directScope();
  const content = JSON.stringify({version:'voko.e2ee/1',contentType:13,groupId:scope.groupId,epoch:1,
    targetAgentDid:scope.targetAgentDid,conversationScope:scope.conversationScope,
    senderDeviceKeyId:'browser-device-1',messageId:'request-1',channelType:1,ciphertext:'Y2lwaGVy'});
  return {contentType:13,content,fromUid:'visitor-1',channelType:1,ack(){}};
}

test('production Direct v2 retries the exact committed reply ciphertext without re-running Provider', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const scope = directScope();
  const nextKeyPackage = { localAgentId:'gym',serverAgentId:'server-gym',targetAgentDid:scope.targetAgentDid,
    ownerDeviceKeyId:scope.recipientDeviceKeyId,ownerScope:scope.ownerScope,keyEpoch:1,keyPackageRef:'next',
    keyPackage:'bmV4dA',encryptedPendingState:Buffer.from('pending'),publishState:'pending' };
  store.commitEstablishment({ establishmentId:'est-direct',scope,encryptedState:Buffer.from('state-1'),
    acknowledgement:{ok:true},nextKeyPackage });

  let providerCalls = 0;
  const deliveries = [];
  let failDelivery = true;
  const runtime = new CanaryRuntime({
    policy:new ProductionE2eePolicy(store,true),store,
    crypto:{
      async decrypt() { return { plaintext:'hello',encryptedState:Buffer.from('state-2'),stateVersion:2 }; },
      async encrypt(input) { return { envelope:{ version:'voko.e2ee/1',contentType:13,groupId:scope.groupId,
        epoch:1,targetAgentDid:scope.targetAgentDid,conversationScope:scope.conversationScope,
        senderDeviceKeyId:scope.recipientDeviceKeyId,messageId:input.messageId,channelType:1,ciphertext:'Zml4ZWQ' },
        encryptedState:Buffer.from('state-3'),stateVersion:3 }; }
    },
    dispatcher:{ async executeE2ee(input) { providerCalls += 1; input.onProviderAccepted(); return { reply:{content:'fixed reply'} }; } },
    persistInbound:()=>true,persistOutbound:()=>{},
    async deliverRaw(_agentId,_channelId,envelope,messageId) {
      deliveries.push({envelope,messageId});
      if (failDelivery) throw new Error('IM_DOWN');
      return {success:true};
    }
  });
  const envelope = JSON.stringify({ version:'voko.e2ee/1',contentType:13,groupId:scope.groupId,epoch:1,
    targetAgentDid:scope.targetAgentDid,conversationScope:scope.conversationScope,
    senderDeviceKeyId:'browser-device-1',messageId:'request-1',channelType:1,ciphertext:'Y2lwaGVy' });
  const message = { contentType:13,content:envelope,fromUid:'visitor-1',channelType:1,ack(){} };
  const first = await runtime.handle('gym',message);
  assert.equal(first.accepted,false);
  assert.equal(providerCalls,1);
  assert.equal(store.receipt('request-1').state,'outcome_unknown');
  assert.equal(store.session(scope.groupId).state_version,3);

  failDelivery = false;
  assert.deepEqual(await runtime.recoverPendingReplies(),{delivered:1,failed:0});
  assert.equal(store.receipt('request-1').state,'completed');
  assert.equal(store.receipt('request-1').delivery_attempts,2);
  assert.equal(deliveries.length,2);
  assert.deepEqual(deliveries[1],deliveries[0],'retry must reuse the exact reply ID and ciphertext');

  const duplicate = await runtime.handle('gym',{...message,ack(){}});
  assert.equal(duplicate.code,'duplicate');
  assert.equal(providerCalls,1,'completed redelivery must not execute Provider again');
  db.close();
});

test('production Direct v2 online delivery and recovery drain share one atomic lease', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const scope = directScope();
  seed(store);
  let deliveryCalls = 0;
  let releaseDelivery;
  let markStarted;
  const deliveryStarted = new Promise(resolve => { markStarted = resolve; });
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  const runtime = new CanaryRuntime({
    policy:new ProductionE2eePolicy(store,true),store,
    crypto:{
      async decrypt() { return {plaintext:'hello',encryptedState:Buffer.from('state-2'),stateVersion:2}; },
      async encrypt({messageId}) { return {envelope:{version:'voko.e2ee/1',messageId,
        groupId:scope.groupId,senderDeviceKeyId:'agent-device',ciphertext:'fixed-reply'},
        encryptedState:Buffer.from('state-3'),stateVersion:3}; },
    },
    dispatcher:{async executeE2ee(input) {
      input.onProviderAccepted();
      return {reply:{content:'fixed reply'}};
    }},
    persistInbound:()=>true,persistOutbound:()=>{},
    async deliverRaw() {
      deliveryCalls += 1;
      markStarted();
      await deliveryGate;
      return {success:true};
    },
  });
  const processing = runtime.handle('gym',inbound());
  await deliveryStarted;
  assert.deepEqual(await runtime.recoverPendingReplies(),{delivered:0,failed:0});
  releaseDelivery();
  assert.equal((await processing).accepted,true);
  assert.equal(deliveryCalls,1);
  assert.equal(store.receipt('request-1').delivery_attempts,1);
  assert.equal(store.receipt('request-1').state,'completed');
  db.close();
});

test('production Direct v2 resumes a provider-accepted task without projecting inbound twice', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  seed(store);
  let executions = 0;
  let inboundProjections = 0;
  const runtime = new CanaryRuntime({
    policy:new ProductionE2eePolicy(store,true),store,
    crypto:{
      async decrypt({encryptedState,stateVersion}) { return {plaintext:'hello',encryptedState,stateVersion:stateVersion+1}; },
      async encrypt({messageId,encryptedState,stateVersion}) { return {envelope:{version:'voko.e2ee/1',messageId,
        groupId:'group-direct',senderDeviceKeyId:'agent-device',ciphertext:'fixed-reply'},encryptedState,stateVersion:stateVersion+1}; },
    },
    dispatcher:{async executeE2ee(input) {
      executions += 1;
      input.onProviderAccepted();
      if (executions === 1) throw new Error('simulated process exit after provider acceptance');
      return {reply:{content:'recovered reply'}};
    }},
    persistInbound:()=>{inboundProjections += 1; return true;},persistOutbound:()=>{},
    deliverRaw:async()=>({success:true}),
  });
  const message = inbound();
  const first = await runtime.handle('gym',message);
  assert.equal(first.accepted,false);
  assert.equal(store.receipt('request-1').state,'provider_accepted');
  const second = await runtime.handle('gym',message);
  assert.equal(second.accepted,true);
  assert.equal(executions,2,'the immutable task id may be resumed after an accepted process exits');
  assert.equal(inboundProjections,1,'the local inbound projection must not be duplicated during recovery');
  assert.equal(store.receipt('request-1').state,'completed');
  db.close();
});

test('allowlisted OpenClaw delivery derives its downstream idempotency key from the immutable message id', () => {
  const source = readFileSync(require.resolve('../build/core/dispatcher/providers/openclaw-ws'), 'utf8');
  assert.match(source, /idempotencyKey: String\(extraData\?\.messageId \|\| extraData\?\.turnId \|\| this\.generateId\(\)\)/);
});
