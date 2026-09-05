'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2] || path.join(__dirname,'../../../..'));
const ts=require(root+'/node_modules/typescript');
const {DatabaseSync}=require('node:sqlite');
function load(rel,mocks={}){const file=path.join(root,rel),exports={}; const source=fs.readFileSync(file,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const req=n=>Object.hasOwn(mocks,n)?mocks[n]:require(n.startsWith('.')?path.resolve(path.dirname(file),n):n);const m={exports};new Function('require','module','exports','__dirname','__filename',js)(req,m,exports,path.dirname(file),file);return m.exports;}
function extract(rel,kind,name){const text=fs.readFileSync(path.join(root,rel),'utf8');const sf=ts.createSourceFile(rel,text,ts.ScriptTarget.Latest,true);let found;const walk=n=>{if(kind(n)&&n.name?.getText(sf)===name)found=n;ts.forEachChild(n,walk);};walk(sf);assert(found,name);return found.getText(sf);}

function method(rel,name,context={}) {
 const m={exports:{}};
 const source=ts.transpileModule('module.exports={'+extract(rel,ts.isMethodDeclaration,name)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('module',...Object.keys(context),source)(m,...Object.values(context));return m.exports[name];
}
function fn(rel,name,context={}) {
 const m={exports:{}};
 const source=ts.transpileModule(extract(rel,ts.isFunctionDeclaration,name)+';module.exports='+name,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('module',...Object.keys(context),source)(m,...Object.values(context));return m.exports;
}
function baseDb(){const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE config(type TEXT PRIMARY KEY,data TEXT,updated_at INTEGER);
CREATE TABLE agents(agent_id TEXT PRIMARY KEY,owner_email TEXT,publish_status TEXT,imUid TEXT,imToken TEXT,im_server_url TEXT);
CREATE TABLE conversations(channel_id TEXT,agent_id TEXT,channel_type INTEGER,last_timestamp INTEGER,name TEXT,user_uid TEXT,last_message TEXT,unread_count INTEGER);
CREATE TABLE messages(id TEXT PRIMARY KEY,channel_id TEXT,agent_id TEXT,message_seq INTEGER,content TEXT,timestamp INTEGER,is_me INTEGER,content_type INTEGER);
CREATE TABLE sync_checkpoints(namespace TEXT,scope_key TEXT,cursor_kind TEXT,committed_value TEXT,pending_value TEXT,pending_meta TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(namespace,scope_key));`);return db;}
(async()=>{
 const db=baseDb(),store=require(root+'/src/core/local-web-session.js').createLocalWebSessionStore(db);
 const a=store.create('A@example.invalid'),a2=store.create('a@example.invalid');
 const request=s=>({headers:{cookie:'voko_session='+s.token+'; voko_csrf='+s.csrfToken,'x-voko-csrf':s.csrfToken}});
 store.destroyRequest(request(a)); assert.equal(store.resolveRequest(request(a)),null);
 const sw=load('src/core/owner-switch.ts');sw.stagePendingOwnerSwitch(db,'b@example.invalid','SYNTHETIC');sw.activatePendingOwnerSwitch(db);
 assert.equal(store.resolveRequest(request(a2)).ownerEmail,'a@example.invalid');assert(store.verifyCsrf(request(a2),store.resolveRequest(request(a2))));
 console.log('PASS R02 counterexample: logout revokes initiating session; independent A session and CSRF survive real owner activation');db.close();
 const crypto=require('node:crypto'),env=load('src/a2a/envelope.ts'),keys=crypto.generateKeyPairSync('ed25519');
 const e={version:'voko.a2a/1',kind:'request',operation:'execute',eventId:'event',gatewayTaskId:'..',contextId:'ctx',gatewayMessageId:'msg',executionId:'exec',commandSequence:1,agentId:'agent',caller:{principalId:'peer',actorKind:'agent',provenance:'a2a'},payload:{attachments:[{attachmentRef:'extatt_abcdefghijklmnop'}]},trace:{correlationId:'corr'},timestamps:{createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}};
 assert(env.verifyEnvelope(env.signEnvelope(e,'synthetic-key',keys.privateKey),keys.publicKey));
 assert.equal(env.verifyEnvelope(e,keys.publicKey),false);
 let removed;
 const {A2AAttachmentWorkspace}=load('src/a2a/attachment-workspace.ts',{'node:fs':{promises:{rm:async p=>{removed=p;throw Error('STOP_FS_MOCK')}}},'./paths':{resolveA2ADataDirectory:()=>'/tmp/never-created-review-root'}});
 await assert.rejects(()=>new A2AAttachmentWorkspace('/tmp/never-created-review-root/attachments').prepare('..',['synthetic'],{}),/STOP_FS_MOCK/);
 assert.equal(removed,'/tmp/never-created-review-root');console.log('PASS R04 signed synthetic dot-id passes validation and targets parent in fs mock; unsigned envelope rejected');
 const {InboundTurnCoalescer,buildMergedTurn}=load('src/core/inbound-turn-coalescer.ts');
 let finish,accepted=false;const providerPromise=new Promise(r=>finish=r);
 const dispatch=method('src/core/messenger.ts','_dispatchInboundTurn',{buildMergedTurn});
 const ctx={dispatcher:{dispatch:()=>{accepted=true;return providerPromise}},_notifyUI:()=>{}};
 const co=new InboundTurnCoalescer({scopeKey:()=> 's',maxMessages:1,flush:b=>dispatch.call(ctx,b)});
 const queued=co.enqueue({messageId:'m',timestamp:1,content:'x',agentId:'a',fromUid:'v'});await queued;await co.flushAll();assert(accepted);assert.equal(co.inFlight.size,0);finish();
 console.log('PASS R13 counterexample: actual messenger callback returns void; coalescer empty while dispatcher Promise remains pending');
 const security=require(root+'/src/core/local-http-security.js');const auth=fn('src/web/live-events-ws.js','authorizeConsoleRequest',security);
 assert(auth({headers:{host:'127.0.0.1:3100'},url:'/voko/events/ws'},''));assert(!auth({headers:{host:'127.0.0.1:3100',origin:'https://evil.invalid'},url:'/voko/events/ws'},''));
 console.log('PASS R11 missing Origin allowed for local native client; hostile website Origin rejected');
 const listDb=baseDb();for(let i=0;i<21;i++){listDb.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('c'+i,'a',1,100-i,'n','v','last',0);listDb.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run('m'+i,'c'+i,'a',i+1,'hello',100-i,i===20?0:1,1);}
 const listing=method('src/mcp/tools.ts','list_conversations',{cx:{query:(sql,p)=>listDb.prepare(sql).all(...p)}});
 assert.equal((await listing({agentId:'a'})).conversations.length,0);assert.equal((await listing({agentId:'a',offset:20})).conversations.length,1);assert.equal((await listing({agentId:'a',filter:'all'})).conversations.length,20);listDb.close();
 console.log('PASS R17 real SQL: default first page empty, offset20 contains unreplied, all filter unaffected');
 async function offlineCase({failCommit=false,total=2,gap=true}={}){
 const d=baseDb();d.prepare('INSERT INTO agents VALUES(?,?,?,?,?,?)').run('a','owner@example.invalid','published','uid','synthetic','');d.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('v','a',1,1,'n','v','',0);
 const cp=load('src/core/checkpoint-store.ts');cp.setCheckpoint(d,'offline_messages',JSON.stringify(['a','v']),'sequence',100);
 const queueSrc=fs.readFileSync(root+'/src/core/database.ts','utf8');
 const q=queueSrc.slice(queueSrc.indexOf('let _dbWriteQueue:'),queueSrc.indexOf('// ============================================',queueSrc.indexOf('let _dbWriteQueue:')));
 const qm={exports:{}};new Function('module',ts.transpileModule(q+';module.exports={enqueueDbWrite,waitForDbQueue}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(qm);
 const starts=[],forwards=[];const data=Array.from({length:total},(_,i)=>({message_id:'m'+i,message_seq:101+i,from_uid:'v',content:'synthetic',content_type:gap&&i===0?13:1}));
 const realFetch=global.fetch;global.fetch=async(url,opts)=>{const start=JSON.parse(opts.body).start_message_seq;starts.push(start);return {ok:true,json:async()=>({messages:data.filter(m=>m.message_seq>=start).slice(0,100)})}};
 const off=load('src/core/offline-sync.ts',{'./database':{...qm.exports,getCurrentUserEmail:()=> 'owner@example.invalid',getUserAccessToken:()=> 'synthetic'},'./checkpoint-store':cp,'../endpoints.json':{im:{apiBaseUrl:'https://synthetic.invalid'}},'./outbound-message-result-store':{normalizeTurnReceipt:()=>null}});
 const wrapped={prepare:s=>d.prepare(s),exec:s=>{if(s==='COMMIT'&&failCommit)throw Error('SYNTHETIC_COMMIT_FAIL');return d.exec(s)}};
 const handler={handleEncryptedMessage:async()=>({handled:true,accepted:false,code:'E2EE_TEMPORARY'}),handleAgentMessage:(a,m)=>{d.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?)').run(m.messageId,m.channelId,a,m.messageSeq,m.content,m.timestamp,0,m.contentType);return {agentId:a,fromUid:m.fromUid,content:m.content,channelId:m.channelId,channelType:1,contentType:m.contentType,messageId:m.messageId,timestamp:m.timestamp}},forwardToAgent:(...args)=>forwards.push(args)};
 try{await off.syncOfflineMessages(wrapped,handler);if(gap)await off.syncOfflineMessages(wrapped,handler);return {starts,forwards:forwards.length,saved:d.prepare('SELECT COUNT(*) n FROM messages').get().n};}finally{global.fetch=realFetch;d.close()}}
 const gap=await offlineCase();assert.deepEqual(gap.starts,[101,103]);console.log('PASS R05 real sync and checkpoint SQL: retryable101, saved102, next request103');
 const rollback=await offlineCase({failCommit:true,gap:false});assert.equal(rollback.saved,0);assert.equal(rollback.forwards,2);console.log('PASS R06 real queue and sync: COMMIT failure rolls back SQLite yet forwards2');
 const page=await offlineCase({total:150,gap:false});assert.equal(page.saved,100);assert.equal(page.starts.length,1);console.log('PASS R07 real sync with150 available performs one request and saves100');
})().catch(e=>{console.error(e);process.exitCode=1});
