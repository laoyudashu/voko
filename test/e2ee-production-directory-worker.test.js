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
    async keyPackageStatus() { return { agents:[{ agentId:'server-lawyer',available:1 }] }; },
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
    async keyPackageStatus() { throw new Error('unexpected status'); },
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

test('directory worker aggregates shared outages and applies exponential backoff', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  let now = 1_000, attempts = 0;
  const errors = [], recoveries = [];
  const process = {
    ready:Promise.resolve({ keyPackage:'a2V5',credentialPublicKey:'Y3JlZGVudGlhbA' }),
    async sealPending() { return Buffer.from('pending'); }, async restorePending() { return 'Y3JlZGVudGlhbA'; },
    async join() { throw new Error('unexpected join'); }, async replenish() { throw new Error('unexpected replenish'); }, close() {},
  };
  const client = {
    async registerDevice() {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error('upstream unavailable'), {
        status:502,code:'E2EE_DIRECTORY_HTTP_502',operation:'/v1/e2ee/devices',
      });
    },
    async publishKeyPackage(input) { return { keyPackageRef:ref(input.keyPackage) }; },
    async pullEstablishments() { return []; },
    async keyPackageStatus(input) { return { agents:[{ agentId:input.agentIds[0],available:1 }] }; },
    async acknowledge() {}, async reject() {},
  };
  const agent = id => ({ localAgentId:id,serverAgentId:`server-${id}`,targetAgentDid:`did:wba:test:${id}`,
    ownerDeviceKeyId:`device-${id}`,ownerScope:'owner-scope',bindingGeneration:1 });
  const agents = [agent('a'),agent('b'),agent('c')];
  const worker = new ProductionE2eeDirectoryWorker({ client,store,agents:()=>agents,processFactory:()=>process,
    intervalMs:2_000,now:()=>now,onError:(agentId,error)=>errors.push({agentId,error}),
    onRecovery:count=>recoveries.push(count) });
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(attempts,1,'the shared backoff suppresses immediate retries');
  assert.equal(errors.length,1,'one outage produces one aggregate error');
  assert.equal(errors[0].agentId,'directory');
  assert.equal(errors[0].error.affectedAgents,3);
  assert.equal(errors[0].error.retryAfterMs,2_000);
  now += 2_000;
  await worker.runOnce();
  assert.equal(attempts,2);
  assert.equal(errors[1].error.retryAfterMs,4_000,'consecutive failures back off exponentially');
  now += 3_999;
  await worker.runOnce();
  assert.equal(attempts,2);
  now += 1;
  await worker.runOnce();
  assert.deepEqual(recoveries,[2]);
  db.close();
});

test('directory worker replenishes a package consumed by an expired establishment', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const packages = ['Y29uc3VtZWQta2V5LXBhY2thZ2U','ZnJlc2gta2V5LXBhY2thZ2U'];
  const calls = [];
  let processIndex = 0;
  const processFactory = () => {
    const initial = processIndex++ === 0;
    return {
      ready:Promise.resolve({ keyPackage:initial ? packages[0] : 'dW51c2Vk',credentialPublicKey:'Y3JlZGVudGlhbA' }),
      async sealPending() { return Buffer.from(initial ? 'consumed-state' : 'fresh-state'); },
      async restorePending() { return 'Y3JlZGVudGlhbA'; },
      async join() { throw new Error('expired establishment must not be joined'); },
      async replenish() { calls.push(['replenish']); return { keyPackage:packages[1],credentialPublicKey:'Y3JlZGVudGlhbA' }; },
      close() {},
    };
  };
  const client = {
    async registerDevice() {},
    async publishKeyPackage(input) { calls.push(['publish',input.keyPackage]); return { keyPackageRef:ref(input.keyPackage) }; },
    async pullEstablishments() { return []; },
    async keyPackageStatus() { return { agents:[{ agentId:'server-gym',available:0 }] }; },
    async acknowledge() {}, async reject() {},
  };
  const agent = { localAgentId:'gym',serverAgentId:'server-gym',targetAgentDid:'did:wba:test:gym',
    ownerDeviceKeyId:'device-gym',ownerScope:'owner-scope',bindingGeneration:1 };
  const worker = new ProductionE2eeDirectoryWorker({ client,store,agents:()=>[agent],processFactory });
  await worker.runOnce();
  assert.deepEqual(calls,[['publish',packages[0]],['replenish'],['publish',packages[1]]]);
  assert.equal(store.keyPackage('gym').key_package_ref,ref(packages[1]));
  db.close();
});

test('directory worker scans large agent sets in bounded round-robin batches', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const seen = [];
  const agents = Array.from({ length:12 },(_,index) => ({ localAgentId:`agent-${index}`,
    serverAgentId:`server-${index}`,targetAgentDid:`did:wba:test:${index}`,ownerDeviceKeyId:`device-${index}`,
    ownerScope:'owner-scope',bindingGeneration:1 }));
  const processFactory = scope => {
    const keyPackage = Buffer.from(`package-${scope.localAgentId}`).toString('base64url');
    return { ready:Promise.resolve({ keyPackage,credentialPublicKey:'Y3JlZGVudGlhbA' }),
      async sealPending() { return Buffer.from('pending'); }, async restorePending() { return 'Y3JlZGVudGlhbA'; },
      async join() { throw new Error('unexpected join'); }, async replenish() { throw new Error('unexpected replenish'); }, close() {} };
  };
  const client = {
    async registerDevice() {},
    async publishKeyPackage(input) { return { keyPackageRef:ref(input.keyPackage) }; },
    async pullEstablishments(input) { seen.push(input.agentId); return []; },
    async keyPackageStatus(input) { return { agents:[{ agentId:input.agentIds[0],available:1 }] }; },
    async acknowledge() {}, async reject() {},
  };
  const worker = new ProductionE2eeDirectoryWorker({ client,store,agents:()=>agents,processFactory,maxAgentsPerRun:5 });
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(seen,agents.map(item=>item.serverAgentId).concat(agents.slice(0,3).map(item=>item.serverAgentId)));
  db.close();
});

test('a new establishment atomically replaces the previous group for the same conversation scope', () => {
  const db = new DatabaseSync(':memory:');
  const store = new ProductionE2eeStore(db);
  const scope = groupId => ({ localAgentId:'gym',serverAgentId:'server-gym',targetAgentDid:'did:wba:test:gym',
    creatorPrincipalId:'guest-a',senderDeviceKeyId:'',recipientDeviceKeyId:'device-gym',ownerScope:'owner',
    groupId,conversationScope:'scope-1',bindingGeneration:1 });
  const nextKeyPackage = { localAgentId:'gym',serverAgentId:'server-gym',targetAgentDid:'did:wba:test:gym',
    ownerDeviceKeyId:'device-gym',ownerScope:'owner',keyEpoch:1,keyPackageRef:'ref',keyPackage:'package',
    encryptedPendingState:Buffer.from('pending'),publishState:'pending' };
  store.commitEstablishment({ establishmentId:'est-old',scope:scope('group-old'),encryptedState:Buffer.from('old'),
    acknowledgement:{ok:true},nextKeyPackage });
  store.reserve(scope('group-old'),'message-old','digest-old');
  store.commitEstablishment({ establishmentId:'est-new',scope:scope('group-new'),encryptedState:Buffer.from('new'),
    acknowledgement:{ok:true},nextKeyPackage });
  assert.equal(store.session('group-old'),undefined);
  assert.equal(store.session('group-new').status,'active');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM e2ee_production_receipts WHERE group_id='group-old'").get().n,0);
  db.close();
});
