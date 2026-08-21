const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ProductionE2eeStore } = require('../build/e2ee/production-store');
const { ProductionE2eePolicy } = require('../build/e2ee/production-policy');

function scope(overrides = {}) {
  return { localAgentId:'lawyer',serverAgentId:'server-lawyer',targetAgentDid:'did:wba:test:lawyer',
    creatorPrincipalId:'guest-principal-a',senderDeviceKeyId:'',recipientDeviceKeyId:'lite-device-lawyer',
    ownerScope:'owner-scope',groupId:'group-a',conversationScope:'conversation-a',bindingGeneration:1,...overrides };
}

test('production policy binds principal, agent, context and group before Provider execution', () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const current = scope();
  store.saveKeyPackage({ localAgentId:'lawyer',serverAgentId:'server-lawyer',targetAgentDid:current.targetAgentDid,
    ownerDeviceKeyId:current.recipientDeviceKeyId,ownerScope:current.ownerScope,keyEpoch:1,keyPackageRef:'ref',
    keyPackage:'a2V5',encryptedPendingState:Buffer.from('pending'),publishState:'published' });
  store.commitEstablishment({ establishmentId:'est-1',scope:current,encryptedState:Buffer.from('state'),
    acknowledgement:{ version:'voko.e2ee/1' },nextKeyPackage:{ localAgentId:'lawyer',serverAgentId:'server-lawyer',
      targetAgentDid:current.targetAgentDid,ownerDeviceKeyId:current.recipientDeviceKeyId,ownerScope:current.ownerScope,
      keyEpoch:1,keyPackageRef:'next',keyPackage:'bmV4dA',encryptedPendingState:Buffer.from('next'),publishState:'pending' } });
  const policy = new ProductionE2eePolicy(store,true);
  const envelope = { groupId:'group-a',conversationScope:'conversation-a',targetAgentDid:current.targetAgentDid,
    senderDeviceKeyId:'browser-device-a' };
  const resolved = policy.authorize('lawyer',envelope,{ fromUid:'guest-principal-a',channelType:1 });
  assert.equal(resolved.creatorPrincipalId,'guest-principal-a');
  assert.throws(() => policy.authorize('lawyer',envelope,{ fromUid:'guest-principal-b',channelType:1 }),/E2EE_SCOPE_REJECTED/);
  assert.throws(() => policy.authorize('other',envelope,{ fromUid:'guest-principal-a',channelType:1 }),/E2EE_SCOPE_REJECTED/);
  store.bindSenderDevice('group-a','browser-device-a');
  store.bindChannel('lawyer','group-a','visitor-a');
  assert.equal(store.isChannelActive('lawyer','visitor-a'),true);
  assert.equal(store.isChannelActive('lawyer','visitor-b'),false);
  assert.throws(() => policy.authorize('lawyer',{ ...envelope,senderDeviceKeyId:'browser-device-b' },
    { fromUid:'guest-principal-a',channelType:1 }),/E2EE_SENDER_DEVICE_CHANGED/);
  db.close();
});

test('production store rejects duplicate establishment and message identifiers with changed bindings', () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const current = scope();
  const nextKeyPackage = { localAgentId:'lawyer',serverAgentId:'server-lawyer',targetAgentDid:current.targetAgentDid,
    ownerDeviceKeyId:current.recipientDeviceKeyId,ownerScope:current.ownerScope,keyEpoch:1,keyPackageRef:'next',
    keyPackage:'bmV4dA',encryptedPendingState:Buffer.from('next'),publishState:'pending' };
  assert.equal(store.commitEstablishment({ establishmentId:'est-1',scope:current,encryptedState:Buffer.from('state'),
    acknowledgement:{ ok:true },nextKeyPackage }),'created');
  assert.equal(store.commitEstablishment({ establishmentId:'est-1',scope:current,encryptedState:Buffer.from('state'),
    acknowledgement:{ ok:true },nextKeyPackage }),'duplicate');
  assert.equal(store.reserve(current,'message-1','digest-a'),'new');
  assert.equal(store.reserve(current,'message-1','digest-a'),'duplicate');
  assert.throws(() => store.reserve(current,'message-1','digest-b'),/E2EE_MESSAGE_ID_CONFLICT/);
  db.close();
});

test('production store persists a monotonic device credential epoch independently of pending snapshots', () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  assert.equal(store.deviceKeyEpoch('agent-a'),1);
  store.setDeviceKeyEpoch('agent-a',2);
  assert.equal(store.deviceKeyEpoch('agent-a'),2);
  assert.throws(() => store.setDeviceKeyEpoch('agent-a',1),/E2EE_DEVICE_EPOCH_ROLLBACK/);
  db.close();
});
