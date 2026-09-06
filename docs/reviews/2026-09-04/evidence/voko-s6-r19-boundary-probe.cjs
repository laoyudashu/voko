'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {A2ABridgeWorker,A2ALocalTaskStore,A2AScopeResolver,initA2ADatabase}=require(path.join(process.cwd(),'build/a2a'));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voko-r19-proof-')),db=initA2ADatabase(path.join(dir,'isolated.db'));
 try {
  const store=new A2ALocalTaskStore(db);
  store.createTask({gatewayTaskId:'synthetic-task',contextId:'ctx',executionId:'exec',agentId:'agent',gatewayUid:'gateway',principalScope:'scope',scopeVersion:1,scopeKeyId:'key'});
  store.acceptCommand('synthetic-seq2','synthetic-task',2,'continue',{eventId:'synthetic-seq2'});
  assert.equal(store.beginCommand('synthetic-seq2'),true);
  console.log('CONFIRMED actual task store begins sequence 2 with no predecessor row; dedupe is not a predecessor guard.');
  const envelope={eventId:'synthetic-valid',gatewayTaskId:'synthetic-independent',contextId:'ctx',executionId:'exec',agentId:'agent',commandSequence:1,operation:'execute',caller:{principalId:'principal',actorKind:'agent',provenance:'guest_a2a'}};
  for(const badPosition of [0,1,2]) {
   let executed=0,acked=0;
   const items=[{eventId:envelope.eventId,taskId:envelope.gatewayTaskId,envelope},{eventId:envelope.eventId,taskId:envelope.gatewayTaskId,envelope}];
   items.splice(badPosition,0,{eventId:'synthetic-bad',taskId:'claimed-unverified-task',envelope:{bad:true}});
   const worker=new A2ABridgeWorker({store,scopes:new A2AScopeResolver(db),client:{async claim(){return{leaseId:'lease',items}},async acknowledge(){acked++}},verify(value){if(value.bad)throw Error('synthetic verification failure');return value},async execute(){executed++}});
   await assert.rejects(()=>worker.pollOnce(),/synthetic verification failure/);
   assert.equal(executed,0);assert.equal(acked,0);
  }
  console.log('CONFIRMED verification failure at first/middle/last claim positions keeps entire batch unexecuted/unacknowledged.');
  console.log('BOUNDARY mock verify proves worker ordering only; no live Gateway contract or signature exploit is claimed. R19 deferred_design.');
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
