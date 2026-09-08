const {test}=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {createProjectWorker}=require('../build/core/project-worker');
function fixture(t){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE agents(agent_id TEXT,publish_status TEXT);INSERT INTO agents VALUES('agent','published')");t.after(()=>db.close());return db;}
test('an explicit claimed execution returns a durable result without completing the business task',async t=>{
 const db=fixture(t);let claims=0,runs=0,finishes=0,queued=true,failFinish=true;
 const client=async(_a,_c,action,input)=>{let data={};if(action==='executionQueue')data={jobs:queued?[{id:'run',channel_id:'group'}]:[]};if(action==='executionClaim'){claims++;queued=false;data={task:{id:'task',title:'Task',description:'Goal'},messages:[],executions:[],assets:[],instructions:'',execution:{instruction:'Do this'}}}if(action==='storageGet')data={configuration:{bucket:'customer'}};if(action==='executionFinish'){finishes++;if(failFinish)return {status:503,body:{success:false,code:'PROJECT_UNAVAILABLE'}};assert.equal(input.status,'succeeded');assert.equal(input.result,'Done')};return{status:200,body:{success:true,data}}};
 const worker=createProjectWorker({db,client,dispatcher:{getAgentDeliveryStatus:()=>({automaticDeliveryReady:true}),executeIsolated:async options=>{runs++;assert.equal(options.sourceType,'external');assert.match(options.content,/Do this/);return{reply:{content:'```voko-result\n'+JSON.stringify({status:'succeeded',summary:'Done',files:[]})+'\n```'}}}}});
 await worker.tick();assert.equal(runs,1);assert.equal(db.prepare('SELECT state FROM project_execution_outbox').get().state,'result');failFinish=false;await worker.tick();assert.equal(runs,1);assert.equal(claims,1);assert.ok(finishes>=2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_execution_outbox').get().n,0);
});
test('lost claim response never executes or silently reclaims',async t=>{const db=fixture(t);let claims=0,runs=0;const worker=createProjectWorker({db,dispatcher:{getAgentDeliveryStatus:()=>({automaticDeliveryReady:true}),executeIsolated:async()=>{runs++}},client:async(_a,_c,action)=>{if(action==='executionQueue')return{status:200,body:{success:true,data:{jobs:[{id:'run',channel_id:'group'}]}}};if(action==='executionClaim')claims++;return{status:503,body:{success:false,code:'PROJECT_UNAVAILABLE'}}}});await worker.tick();await worker.tick();assert.equal(runs,0);assert.equal(claims,1);assert.match(db.prepare('SELECT payload FROM project_execution_outbox').get().payload,/unknown/);});
test('blocked Provider output is never published in task results',async t=>{const db=fixture(t);let queued=true,published;const worker=createProjectWorker({db,safety:{assertAllowed:async(_text,direction)=>{if(direction==='outbound'){const e=new Error('blocked');e.name='A2ASafetyRejection';throw e}}},dispatcher:{getAgentDeliveryStatus:()=>({automaticDeliveryReady:true}),executeIsolated:async()=>({reply:{content:'BLOCKED_OUTPUT'}})},client:async(_a,_c,action,input)=>{let data={};if(action==='executionQueue')data={jobs:queued?[{id:'run',channel_id:'group'}]:[]};if(action==='executionClaim'){queued=false;data={task:{id:'task',title:'test',description:''},messages:[],executions:[],assets:[],execution:{instruction:'test'}}}if(action==='storageGet')data={configuration:{bucket:'test'}};if(action==='executionFinish')published=input;return{status:200,body:{success:true,data}}}});await worker.tick();assert.equal(published.status,'failed');assert.ok(!published.result.includes('BLOCKED_OUTPUT'));});

test('an unauthorized stale Agent does not starve the next Agent queue',async t=>{
 const db=fixture(t);db.exec("INSERT INTO agents VALUES('healthy','published')");const queried=[];
 const worker=createProjectWorker({db,dispatcher:{getAgentDeliveryStatus:()=>({automaticDeliveryReady:true})},client:async(agent,_channel,action)=>{
  assert.equal(action,'executionQueue');queried.push(agent);
  return agent==='agent'?{status:401,body:{success:false,code:'PROJECT_AGENT_AUTH_REQUIRED'}}:{status:200,body:{success:true,data:{jobs:[]}}};
 }});await worker.tick();assert.deepEqual(queried,['agent','healthy']);
});

const fs=require('node:fs/promises'),path=require('node:path');
const receipt=(status,files=[],summary='Done')=>'```voko-result\n'+JSON.stringify({status,files,summary})+'\n```';
function scenario(t,execute,hooks={}){const db=fixture(t);let queued=true,finish=[],uploads=0,options;
 const client=async(_a,_c,action,input)=>{let data={};
 if(action==='executionQueue')data={jobs:queued?[{id:'run',channel_id:'group'}]:[]};
 if(action==='executionClaim'){queued=false;data={task:{id:'task',title:'File',description:''},messages:[],executions:[],assets:[],execution:{instruction:'Generate'}};}
 if(action==='storageGet')data={configuration:{bucket:'test'}};
 if(action==='assetPrepare'){await hooks.prepare?.(options);uploads++;data={id:'asset',url:'https://cloud.invalid/test',headers:{}};}
 if(action==='executionFinish')finish.push(input);
 if(action==='taskGet')data={executions:[{id:'run',status:'unknown'}]};
 return{status:200,body:{success:true,data}};};
 const dispatcher={getAgentDeliveryStatus:()=>({automaticDeliveryReady:true}),executeIsolated:async o=>{options=o;return execute(o)}};
 const worker=createProjectWorker({db,client,dispatcher,fetchImpl:async(_url,request)=>{await hooks.upload?.(request);return{ok:true}}});
 t.after(async()=>{if(options?.attachmentOutputDirectory)await fs.rm(path.dirname(options.attachmentOutputDirectory),{recursive:true,force:true})});
 return{db,worker,client,dispatcher,finish,get uploads(){return uploads},get options(){return options}};
}
test('plain refusal is never transport success and its directory is retained',async t=>{
 const f=scenario(t,async()=>({reply:{content:'I cannot write files'}}));await f.worker.tick();
 assert.equal(f.finish.at(-1).status,'unknown');assert.equal(f.uploads,0);
 assert.equal(f.db.prepare('SELECT state FROM project_execution_outbox').get().state,'uncertain');
 assert.ok(await fs.stat(f.options.attachmentOutputDirectory));
});
test('explicit input requirement is reported without pretending work succeeded',async t=>{
 const f=scenario(t,async()=>({reply:{content:receipt('input_required',[],'Please authorize file tools')}}));await f.worker.tick();
 assert.equal(f.finish.at(-1).status,'input_required');assert.equal(f.uploads,0);
 await assert.rejects(fs.stat(f.options.attachmentOutputDirectory),{code:'ENOENT'});
});
test('a claimed file missing from disk prevents success and upload',async t=>{
 const f=scenario(t,async()=>({reply:{content:receipt('succeeded',['missing.csv'])}}));await f.worker.tick();
 assert.equal(f.finish.at(-1).status,'unknown');assert.equal(f.uploads,0);
});
test('verified declared file is uploaded before success acknowledgement and cleanup',async t=>{
 const f=scenario(t,async o=>{await fs.writeFile(path.join(o.attachmentOutputDirectory,'report.txt'),'real');return{reply:{content:receipt('succeeded',['report.txt'])}}});await f.worker.tick();
 assert.equal(f.finish.at(-1).status,'succeeded');assert.equal(f.uploads,1);
 await assert.rejects(fs.stat(f.options.attachmentOutputDirectory),{code:'ENOENT'});
});
test('timeout preserves outputs; persisted late reply recovers once without executing again',async t=>{
 let runs=0;const f=scenario(t,async()=>{runs++;throw Object.assign(new Error('timeout'),{deliveryOutcome:'outcome_unknown'})});await f.worker.tick();
 assert.equal(f.finish.at(-1).status,'unknown');await fs.writeFile(path.join(f.options.attachmentOutputDirectory,'late.txt'),'late');
 await f.options.onLateReply({content:receipt('succeeded',['late.txt'])});
 const restarted=createProjectWorker({db:f.db,client:f.client,dispatcher:f.dispatcher,fetchImpl:async()=>({ok:true})});
 await restarted.tick();await restarted.tick();assert.equal(runs,1);assert.equal(f.uploads,1);assert.equal(f.finish.at(-1).status,'succeeded');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_execution_outbox').get().n,0);
});

test('result contract rejects traversal, duplicates, and ambiguous receipts',()=>{
 const {parseProjectResult}=require('../build/core/project-result');
 assert.equal(parseProjectResult(receipt('succeeded',['../secret'])),null);
 assert.equal(parseProjectResult(receipt('succeeded',['a','a'])),null);
 assert.equal(parseProjectResult(receipt('succeeded')+receipt('failed')),null);
 assert.equal(parseProjectResult(receipt('succeeded')+'more contradictory text'),null);
 assert.equal(parseProjectResult(receipt('failed',[],'No tools')).status,'failed');
});

test('upload uses the checked snapshot when output is replaced during ticket creation',async t=>{
 let uploaded;
 const f=scenario(t,async o=>{await fs.writeFile(path.join(o.attachmentOutputDirectory,'report.txt'),'original');return{reply:{content:receipt('succeeded',['report.txt'])}}}, {
  prepare:async o=>{const file=path.join(o.attachmentOutputDirectory,'report.txt');await fs.rename(file,file+'.old');await fs.writeFile(file,'replacement-content')},
  upload:async request=>{uploaded=Buffer.from(request.body).toString()}
 });
 await f.worker.tick();assert.equal(uploaded,'original');assert.equal(f.finish.at(-1).status,'succeeded');
});
test('non-file output is rejected before creating an upload ticket',async t=>{
 const f=scenario(t,async o=>{await fs.mkdir(path.join(o.attachmentOutputDirectory,'report.txt'));return{reply:{content:receipt('succeeded',['report.txt'])}}});
 await f.worker.tick();assert.equal(f.uploads,0);assert.equal(f.finish.at(-1).status,'unknown');
});
