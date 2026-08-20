const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ProductionE2eeStore } = require('../build/e2ee/production-store');
const { ProductionE2eeDirectoryWorker } = require('../build/e2ee/production-directory-worker');

const ref = value => crypto.createHash('sha256').update(Buffer.from(value,'base64url')).digest('base64url');

test('directory worker persists session before ACK and replenishes the same device epoch', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const calls = [];
  const packages = ['a2V5LXBhY2thZ2UtMQ','a2V5LXBhY2thZ2UtMg'];
  let processIndex = 0;
  const processFactory = () => {
    const index = processIndex++;
    const keyPackage = index === 0 ? packages[0] : 'dW51c2VkLWZyZXNoLXBhY2thZ2U';
    return {
      ready:Promise.resolve({ keyPackage,credentialPublicKey:'Y3JlZGVudGlhbA' }),
      async sealPending() { return Buffer.from(`pending-${keyPackage}`); },
      async restorePending(value) { calls.push(['restore',Buffer.from(value).toString()]); return 'Y3JlZGVudGlhbA'; },
      async join(scope,_welcome,id) { calls.push(['join',scope.creatorPrincipalId,id]); return {
        encryptedState:Buffer.from('active-state'),acknowledgement:{ version:'voko.e2ee/1',messageId:id } }; },
      async replenish() { calls.push(['replenish']); return { keyPackage:packages[1],credentialPublicKey:'Y3JlZGVudGlhbA' }; },
      close() { calls.push(['close',keyPackage]); },
    };
  };
  let pulled = false;
  const client = {
    async registerDevice(input) { calls.push(['register',input.keyEpoch]); return { duplicate:false }; },
    async publishKeyPackage(input) { calls.push(['publish',input.keyEpoch,input.keyPackage]); return { keyPackageRef:ref(input.keyPackage) }; },
    async pullEstablishments() {
      if (pulled) return [];
      pulled = true;
      return [{ establishmentId:'est-1',creatorPrincipalId:'guest-a',keyPackageRef:ref(packages[0]),keyEpoch:1,
        groupId:'Z3JvdXAtMQ',conversationScope:'Y29udGV4dC0x',commit:'Y29tbWl0',welcome:'d2VsY29tZQ',
        state:'commit_accepted',conversationMode:'e2ee_available',ownerEpoch:1,bindingGeneration:1,policyRevision:1,mlsEpoch:0,
        expiresAt:new Date(Date.now()+60_000).toISOString() }];
    },
    async acknowledge(input) {
      assert.ok(store.session('Z3JvdXAtMQ'),'session must commit before receipt ACK');
      calls.push(['ack',input.establishmentId]); return { accepted:true };
    },
    async reject() { throw new Error('unexpected reject'); },
  };
  const agent = { localAgentId:'lawyer',serverAgentId:'server-lawyer',targetAgentDid:'did:wba:test:lawyer',
    ownerDeviceKeyId:'device-lawyer',ownerScope:'owner-scope',bindingGeneration:1 };
  const worker = new ProductionE2eeDirectoryWorker({ client,store,agents:()=>[agent],processFactory,now:()=>Date.now() });
  await worker.runOnce();
  assert.equal(store.session('Z3JvdXAtMQ').creator_principal_id,'guest-a');
  assert.equal(store.establishment('est-1').ack_state,'acknowledged');
  assert.equal(store.keyPackage('lawyer').key_epoch,1,'KeyPackage replenishment must not rotate device identity');
  assert.deepEqual(calls.filter(call => call[0] === 'publish').map(call => call[2]),
    ['a2V5LXBhY2thZ2UtMQ','a2V5LXBhY2thZ2UtMg']);
  assert.equal(calls.filter(call => call[0] === 'join').length,1);
  assert.deepEqual(calls.filter(call => call[0] === 'close'),[['close','a2V5LXBhY2thZ2UtMQ']]);
  await worker.runOnce();
  assert.equal(calls.filter(call => call[0] === 'join').length,1,'redelivery must not join twice');
  assert.equal(calls.filter(call => call[0] === 'register').length,2,
    'device registration may accompany each newly published package but must not repeat on an idle poll');
  db.close();
});

test('directory worker honors server rate-limit backoff without scanning remaining agents', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  let now = 1_000;
  const calls = [];
  const process = {
    ready:Promise.resolve({ keyPackage:'a2V5',credentialPublicKey:'Y3JlZGVudGlhbA' }),
    async sealPending() { return Buffer.from('pending'); }, async restorePending() {},
    async join() { throw new Error('unexpected join'); }, async replenish() { return 'a2V5Mg'; }, close() {},
  };
  const limited = Object.assign(new Error('limited'), { status:429,retryAfterMs:10_000 });
  const client = {
    async registerDevice(input) { calls.push(['register',input.ownerDeviceKeyId]); throw limited; },
    async publishKeyPackage() { throw new Error('unexpected publish'); },
    async pullEstablishments() { throw new Error('unexpected pull'); }, async acknowledge() {},
  };
  const agent = id => ({ localAgentId:id,serverAgentId:`server-${id}`,targetAgentDid:`did:wba:test:${id}`,
    ownerDeviceKeyId:`device-${id}`,ownerScope:'owner-scope',bindingGeneration:1 });
  const worker = new ProductionE2eeDirectoryWorker({ client,store,agents:()=>[agent('a'),agent('b')],
    processFactory:()=>process,now:()=>now });
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(calls,[['register','device-a']]);
  now += 10_000;
  await worker.runOnce();
  assert.deepEqual(calls,[['register','device-a'],['register','device-a']]);
  db.close();
});
