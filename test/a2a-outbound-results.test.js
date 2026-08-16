'use strict'; const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2ALocalTaskStore, A2AOutboundResultWorker, initA2ADatabase } = require('../build/a2a');
test('outbound result is durable, monotonic and ACKed after local commit', async t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-result-')); const db = initA2ADatabase(path.join(dir, 'a.db')); t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});
  const store = new A2ALocalTaskStore(db); const calls=[]; const client={async claimOutboundResults(){return {leaseId:'lease-1',items:[{eventId:'event-1',taskId:'task-1',sequence:2,payload:{standardState:'COMPLETED',deliveryState:'DELIVERED',response:{ok:true}}}]};},
    async acknowledgeOutboundResult(...args){calls.push(args);}}; const worker=new A2AOutboundResultWorker(store,client); assert.deepEqual(await worker.pollOnce(),{claimed:1,updated:1});
  assert.equal(store.getOutboundResult('task-1').standard_state,'COMPLETED'); assert.deepEqual(calls,[['lease-1','event-1']]);
  assert.equal(store.saveOutboundResult({taskId:'task-1',sequence:1,payload:{standardState:'WORKING'}}),false); assert.equal(store.getOutboundResult('task-1').standard_state,'COMPLETED');
});
