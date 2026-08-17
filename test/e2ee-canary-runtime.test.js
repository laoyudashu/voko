'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { CanaryRuntimePolicy } = require('../build/e2ee/canary-policy');
const { CanaryStore } = require('../build/e2ee/canary-store');
const { CanaryRuntime } = require('../build/e2ee/canary-runtime');

const scope = { localAgentId:'agent-local',targetAgentDid:'did:voko:agent',senderDeviceKeyId:'browser-device',
  recipientDeviceKeyId:'lite-device',ownerScope:'owner-test',groupId:'group-1',conversationScope:'conversation-1' };
function envelope(messageId='message-1',ciphertext='Y2lwaGVydGV4dA') { return { version:'voko.e2ee/1',contentType:13,
  groupId:scope.groupId,epoch:1,targetAgentDid:scope.targetAgentDid,conversationScope:scope.conversationScope,
  senderDeviceKeyId:scope.senderDeviceKeyId,messageId,channelType:1,ciphertext }; }
function fixture(enabled=true) {
  const db=new DatabaseSync(':memory:');
  const env={VOKO_E2EE_INTERNAL_RUNTIME_ENABLED:enabled?'true':'false',VOKO_E2EE_INTERNAL_RUNTIME_SCOPES:JSON.stringify([scope])};
  const policy=new CanaryRuntimePolicy(env,false);const store=new CanaryStore(db);const delivered=[];const dispatched=[];
  const crypto={async decrypt(input){return{plaintext:'private canary plaintext',encryptedState:Buffer.from(`state-${input.stateVersion+1}`),stateVersion:input.stateVersion+1}},
    async encrypt(input){return{envelope:envelope(input.messageId,'cmVwbHk'),encryptedState:Buffer.from(`state-${input.stateVersion+1}`),stateVersion:input.stateVersion+1}}};
  const runtime=new CanaryRuntime({policy,store,crypto,dispatcher:{async executeCanary(input){dispatched.push(input);return{reply:{content:'private reply'}}}},
    async deliverRaw(...args){delivered.push(args);return{success:true}}});return{db,store,runtime,delivered,dispatched};
}

test('contentType 13 is always claimed and disabled Canary fails closed before visitor routing',async()=>{const f=fixture(false);
  assert.equal(f.runtime.claims({contentType:13}),true);const result=await f.runtime.handle('agent-local',{contentType:13,content:JSON.stringify(envelope()),fromUid:'guest',channelType:1});
  assert.deepEqual(result,{handled:true,accepted:false,code:'E2EE_CANARY_DISABLED'});assert.equal(f.dispatched.length,0);f.db.close()});

test('exact scope decrypts, dispatches in isolation, encrypts reply and never stores plaintext',async()=>{const f=fixture();
  const body=JSON.stringify(envelope());const input={contentType:13,content:body,fromUid:'guest-principal',channelType:1};
  assert.equal((await f.runtime.handle('agent-local',input)).accepted,true);assert.equal(f.dispatched.length,1);assert.equal(f.delivered.length,1);
  assert.equal(f.delivered[0][1],'guest-principal');assert.equal(f.dispatched[0].content,'private canary plaintext');
  const dump=JSON.stringify({sessions:f.db.prepare('SELECT * FROM e2ee_canary_sessions').all(),receipts:f.db.prepare('SELECT * FROM e2ee_canary_receipts').all()});
  assert.doesNotMatch(dump,/private canary plaintext|private reply/);assert.match(dump,/completed/);
  assert.deepEqual(await f.runtime.handle('agent-local',input),{handled:true,accepted:true,code:'duplicate'});assert.equal(f.dispatched.length,1);f.db.close()});

test('scope mismatch, message ID conflict and emergency disable fail closed',async()=>{const f=fixture();
  const wrong={...envelope(),senderDeviceKeyId:'other-device'};assert.equal((await f.runtime.handle('agent-local',{contentType:13,content:JSON.stringify(wrong),fromUid:'g',channelType:1})).accepted,false);
  const input={contentType:13,content:JSON.stringify(envelope()),fromUid:'g',channelType:1};assert.equal((await f.runtime.handle('agent-local',input)).accepted,true);
  const changed={...envelope(),ciphertext:'ZGlmZmVyZW50'};assert.equal((await f.runtime.handle('agent-local',{...input,content:JSON.stringify(changed)})).accepted,false);
  await f.runtime.emergencyDisable();assert.equal(f.store.session(scope.groupId).status,'locked');f.db.close()});
