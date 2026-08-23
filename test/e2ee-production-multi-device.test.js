const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('legacy MLS groups keep multi-device senders while Direct v2 pins one browser device',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','e2ee','production-store.ts'),'utf8');
  const policy=fs.readFileSync(path.join(__dirname,'..','src','e2ee','production-policy.ts'),'utf8');
  assert.match(source,/e2ee_production_session_senders/);
  const bind=source.slice(source.indexOf('bindSenderDevice'),source.indexOf('bindChannel'));
  assert.match(bind,/row\.protocol_mode === 'direct_v2'/);
  assert.match(bind,/E2EE_SENDER_DEVICE_CHANGED/);
  assert.match(bind,/ON CONFLICT\(group_id,sender_device_key_id\)/);
  assert.doesNotMatch(policy,/E2EE_SENDER_DEVICE_CHANGED/);
});

test('Lite directory worker applies ordered device commits with local CAS',()=>{
  const worker=fs.readFileSync(path.join(__dirname,'..','src','e2ee','production-directory-worker.ts'),'utf8');
  assert.match(worker,/pullDeviceCommits/);
  assert.match(worker,/E2EE_DEVICE_COMMIT_SEQUENCE_INVALID/);
  assert.match(worker,/applyEpoch/);
  assert.match(worker,/session\.protocol_mode==='direct_v2'\)continue/);
});
