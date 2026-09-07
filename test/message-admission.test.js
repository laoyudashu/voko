'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const { createToolHandlers } = require('../build/mcp/tools');
const { getAdmission, beginAdmission, finishAdmission, recoverInterruptedAdmissions, messageReadState, readableMessageSql } = require('../build/core/message-admission');
const { buildConversationRecoveryPrompt } = require('../build/core/dispatcher/conversation-context');
const { withOwnerHistory } = require('../build/core/owner-history-context');
const groupClient = require('../build/core/group-client');

function fixture(t, options = {}) {
  const db = initDatabase(':memory:', { silent: true });
  for (const agent of ['a','b']) db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,agent_name,created_at,updated_at)
    VALUES(?,?,?,'test','','published','public','mock',?,1,1)`).run(agent, agent, `${agent}-uid`, agent);
  const members = [{ uid:'v',role:'member' },{ uid:'w',role:'member' },{ uid:'a-uid',role:'member' },{ uid:'b-uid',role:'member' }];
  const getGroupInfo = async () => ({ status:'active', members });
  t.mock.method(groupClient, 'getInfo', getGroupInfo);
  const dispatched = [];
  const handler = new MessageHandler(db, { dispatcher: { dispatch(agentId,payload) { dispatched.push({agentId,payload}); } },
    getGroupInfo, notifyUI() {}, sendSystemMessage() {}, ...options });
  const tools = createToolHandlers({ db, query: (sql,params=[])=>db.prepare(sql).all(...params), exec: (sql,params=[])=>db.prepare(sql).run(...params) });
  t.after(async () => { await handler.flushInboundTurns().catch(()=>{}); db.close(); });
  function receive(id, extra={}, agent='a', skip=false) {
    return handler.handleAgentMessage(agent, { fromUid:'v',toUid:`${agent}-uid`,channelId:'v',channelType:1,
      content:`CANARY_${id}`,messageId:id,messageSeq:Number(id.replace(/\D/g,''))||1,timestamp:1000+(Number(id.replace(/\D/g,''))||1),...extra },skip);
  }
  function blacklist(agent='a', visitor='v') {
    db.prepare(`INSERT INTO agent_access_lists(id,agent_id,visitor_id,list_type,created_at,updated_at) VALUES(?,?,?,'blacklist',1,1)`).run(`${agent}-${visitor}`,agent,visitor);
  }
  const pull = (p={})=>tools.fetch_new_messages({ agentId:'a',channelId:'v',cursor:0,...p });
  return {db,handler,tools,receive,blacklist,pull,dispatched,members};
}

for (const reason of ['blacklist','whitelist','unpublished','audit']) test(`new ${reason} rejection cannot escape through Push/Pull/history`, async t => {
  const f = fixture(t, { checkAuditRules:()=>({action: reason==='audit'?'hard_deny':'allow'}) });
  if(reason==='blacklist') f.blacklist();
  if(reason==='whitelist') f.db.prepare("UPDATE agents SET access_mode='private' WHERE agent_id='a'").run();
  if(reason==='unpublished') f.db.prepare("UPDATE agents SET publish_status='unpublished' WHERE agent_id='a'").run();
  f.receive('m1'); await f.handler.flushInboundTurns();
  assert.equal(f.dispatched.length,0);
  assert.equal((await f.pull()).messages.length,0);
  assert.equal((await f.tools.get_chat_history({agentId:'a',channelId:'v'})).messages.length,0);
  assert.equal((await f.tools.get_visitor_profile({agentId:'a',visitorId:'v'})).recentMessages.length,0);
  assert.ok(!buildConversationRecoveryPrompt(f.db,{agentId:'a',fromUid:'v',content:'next',messageId:'next'}).includes('CANARY_m1'));
  const owner = await withOwnerHistory(()=>f.tools.get_chat_history({agentId:'a',channelId:'v'}));
  assert.ok(JSON.stringify(owner).includes('CANARY_m1'));
});

test('async audit runs with no dispatcher; pending barrier preserves later rows', async t => {
  let resolve;
  const f=fixture(t,{dispatcher:null,checkAuditRules:content=>({action:'allow',verdict:content.includes('m1')?'uncertain':'allow'}),
    classifyAuditDecision:()=>new Promise(r=>{resolve=r})});
  f.receive('m1'); f.receive('m2');
  const first=await f.pull(); assert.equal(first.messages.length,0); assert.equal(first.cursor,0);
  await new Promise(setImmediate); resolve({action:'allow',verdict:'allow'});
  await f.handler.flushInboundTurns();
  const second=await f.pull(); assert.equal(second.messages.length,2); assert.equal(second.cursor,2);
});

test('audit failures and interrupted checks terminate denied without reopening',async t=>{
  const f=fixture(t,{dispatcher:null,checkAuditRules:()=>({action:'soft_deny'}),classifyAuditDecision:async()=>{throw new Error('test')}});
  f.receive('m1'); await f.handler.flushInboundTurns();
  assert.equal(getAdmission(f.db,'a','m1').state,'denied');
  beginAdmission(f.db,'a','interrupted'); recoverInterruptedAdmissions(f.db);
  assert.equal(getAdmission(f.db,'a','interrupted').reason,'ADMISSION_CHECK_INTERRUPTED');
  finishAdmission(f.db,'a','m1','allowed','ALLOWED');
  assert.equal((await f.pull()).messages.length,0);
});

test('same group message: A blacklisted, B allowed; raw body stays shared and intact',async t=>{
  const f=fixture(t); f.blacklist('a');
  const group={channelId:'group_one',channelType:2,toUid:'group_one',mention:{uids:['a-uid','b-uid']}};
  f.receive('m1',group,'a'); f.receive('m1',group,'b'); await f.handler.flushInboundTurns();
  assert.equal(getAdmission(f.db,'a','m1').state,'denied');
  assert.equal(getAdmission(f.db,'b','m1').state,'allowed');
  assert.deepEqual(f.dispatched.map(d=>d.agentId),['b']);
  assert.equal(f.db.prepare("SELECT content FROM messages WHERE id='m1'").get().content,'CANARY_m1');
  assert.equal((await f.pull({channelId:'group_one',channelType:2})).messages.length,0);
  assert.equal((await f.pull({agentId:'b',channelId:'group_one',channelType:2})).messages.length,1);
});

test('group audit denial is scoped and does not overwrite another Agent content',async t=>{
  let deny=true;
  const f=fixture(t,{checkAuditRules:()=>({action:deny?'hard_deny':'allow'})});
  const group={channelId:'group_one',channelType:2,toUid:'group_one',mention:{uids:['a-uid','b-uid']}};
  f.receive('m1',group,'a'); await f.handler.flushInboundTurns(); deny=false;
  f.receive('m1',group,'b'); await f.handler.flushInboundTurns();
  const row=f.db.prepare("SELECT * FROM messages WHERE id='m1'").get();
  assert.equal(row.content,'CANARY_m1'); assert.equal(row.content_type,1);
  assert.equal(messageReadState(f.db,'a',row),'skip'); assert.equal(messageReadState(f.db,'b',row),'readable');
});

for(const scenario of ['valid','all-admin','all-member','mixed-all','malformed','outsider','inactive','no-membership','unpublished']) test(`first group trigger checks ${scenario}`,async t=>{
  const f=fixture(t,scenario==='no-membership'?{getGroupInfo:async()=>{throw new Error('unavailable')}}:{});
  if(scenario==='all-admin') f.members[0].role='admin';
  if(scenario==='outsider') f.members.splice(0,1);
  if(scenario==='inactive') f.members.splice(2,1); // target no longer in group
  if(scenario==='unpublished') f.db.prepare("UPDATE agents SET publish_status='unpublished' WHERE agent_id='a'").run();
  const mention=scenario==='malformed'?{all:'true',uids:['a-uid']}:
    scenario==='mixed-all'?{all:true,uids:['a-uid']}:
    scenario.startsWith('all-')?{all:true}:{uids:['a-uid']};
  f.receive('m1',{channelId:'group_one',channelType:2,mention}); await f.handler.flushInboundTurns();
  assert.equal(f.dispatched.length,['valid','all-admin'].includes(scenario)?1:0);
});

test('unmentioned history does not block Pull, rejected history never enters next mention',async t=>{
  const f=fixture(t); const group={channelId:'group_one',channelType:2};
  f.blacklist('a','w'); f.receive('m1',{...group,fromUid:'w'});
  f.db.prepare("DELETE FROM agent_access_lists WHERE visitor_id='w'").run();
  f.receive('m2',group); assert.equal(getAdmission(f.db,'a','m2'),undefined);
  f.receive('m3',{...group,mention:{uids:['a-uid']}}); await f.handler.flushInboundTurns();
  const prompt=f.dispatched[0].payload.content;
  assert.ok(prompt.includes('CANARY_m2')); assert.ok(!prompt.includes('CANARY_m1'));
  const pull=await f.pull({channelId:'group_one',channelType:2});
  assert.equal(pull.messages.length,1); assert.equal(pull.cursor,3);
});

test('queued current sender and later revoked group context fail final submission',async t=>{
  const f=fixture(t); f.receive('m1'); f.blacklist();
  await f.handler.flushInboundTurns(); assert.equal(f.dispatched.length,0);
  f.db.prepare('DELETE FROM agent_access_lists').run();
  const group={channelId:'group_one',channelType:2};
  f.receive('m2',{...group,fromUid:'w'}); f.receive('m3',{...group,mention:{uids:['a-uid']}});
  await f.handler.flushInboundTurns(); const payload=f.dispatched[0].payload;
  assert.ok(payload.content.includes('CANARY_m2')); f.blacklist('a','w');
  await assert.rejects(payload.assertSubmissionCurrent(),/admission/);
});

test('global Pull paginates independent sequences without advancing withheld channels',async t=>{
  const f=fixture(t,{dispatcher:null});
  for (const visitor of ['v','w']) for(const n of [1,2]) f.receive(`${visitor}${n}`,{fromUid:visitor,channelId:visitor,messageSeq:n});
  const all=[];
  for(let n=0;n<5;n++) {const page=await f.tools.fetch_new_messages({agentId:'a',limit:1}); all.push(...page.messages.map(m=>m.content));}
  assert.equal(all.length,4); assert.equal(new Set(all).size,4);
});

test('manual mode keeps content decision separate from trigger; unknown history stays owner-only',async t=>{
  const f=fixture(t,{dispatcher:null});
  f.db.prepare(`INSERT INTO conversations(user_uid,channel_id,channel_type,agent_id,mode,name,last_timestamp) VALUES('a-uid','v',1,'a','MANUAL','v',1)`).run();
  f.receive('m1');
  assert.equal(getAdmission(f.db,'a','m1').state,'allowed'); assert.equal((await f.pull()).messages.length,0);
  assert.equal((await f.tools.get_chat_history({agentId:'a',channelId:'v'})).messages.length,1);
  f.db.prepare('DELETE FROM agent_message_admissions').run();
  assert.equal((await f.tools.get_chat_history({agentId:'a',channelId:'v'})).messages.length,0);
});

test('history SQL and per-row current checks agree for per-Agent group decisions',async t=>{
  const f=fixture(t); f.receive('m1'); await f.handler.flushInboundTurns();
  for(const blacklist of [false,true]) {
    if(blacklist)f.blacklist();
    const row=f.db.prepare("SELECT * FROM messages WHERE id='m1'").get();
    assert.equal(f.db.prepare(`SELECT id FROM messages WHERE ${readableMessageSql()}`).all('a').length>0,
      messageReadState(f.db,'a',row)==='readable');
  }
});

test('global pending pages contain no holes and cannot skip the waiting message',async t=>{
  let resolve;
  const f=fixture(t,{dispatcher:null,checkAuditRules:()=>({action:'soft_deny'}),classifyAuditDecision:()=>new Promise(r=>{resolve=r})});
  f.receive('m1');
  const page=await f.tools.fetch_new_messages({agentId:'a',limit:50});
  assert.deepEqual(page.messages,[]); assert.equal(page.hasMore,true); assert.equal(page.cursorByChannel['1:v'],0);
  await new Promise(setImmediate); resolve({action:'allow',verdict:'allow'}); await f.handler.flushInboundTurns();
  assert.equal((await f.tools.fetch_new_messages({agentId:'a'})).messages.length,1);
});

test('synchronous audit exceptions are terminal and do not block later delivery',async t=>{
  const f=fixture(t,{dispatcher:null,checkAuditRules:content=>{if(content.includes('m1'))throw new Error('bad rule');return {action:'allow'}}});
  f.receive('m1'); f.receive('m2');
  assert.equal(getAdmission(f.db,'a','m1').reason,'ADMISSION_CHECK_FAILED');
  const page=await f.pull(); assert.deepEqual(page.messages.map(m=>m.content),['CANARY_m2']); assert.equal(page.cursor,2);
});

test('Pull and history recheck blacklist after awaiting trusted group information',async t=>{
  const f=fixture(t); f.receive('m1',{channelId:'group_one',channelType:2,mention:{uids:['a-uid']}}); await f.handler.flushInboundTurns();
  t.mock.method(groupClient,'getInfo',async()=>{f.blacklist();return {status:'active',members:f.members}});
  assert.equal((await f.pull({channelId:'group_one',channelType:2})).messages.length,0);
});

test('raw insert and pending admission roll back together on admission storage failure',async t=>{
  const f=fixture(t,{dispatcher:null});
  f.db.exec("CREATE TEMP TRIGGER fail_admission BEFORE INSERT ON agent_message_admissions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>f.receive('m1'),/synthetic failure/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE id='m1'").get().n,0);
});

test('blocked polling resumes only after a pending audit decision becomes allowed',async t=>{
  let resolve;
  const f=fixture(t,{dispatcher:null,checkAuditRules:()=>({action:'soft_deny'}),classifyAuditDecision:()=>new Promise(r=>{resolve=r})});
  f.receive('m1'); await new Promise(setImmediate);
  const response=f.pull({blockTimeout:2}); resolve({action:'allow',verdict:'allow'});
  assert.equal((await response).messages.length,1);
});

test('audit intervention tools cannot recover the quarantined original or suggestion',async t=>{
  const f=fixture(t,{checkAuditRules:()=>({action:'hard_deny'})});f.receive('m1');
  f.db.prepare(`INSERT INTO owner_interventions(id,agent_id,visitor_id,session_key,problem,agent_suggestion,ask_time,status,created_at,updated_at,source_message_id)
    VALUES('audit_test','a','v','agent:a:v','CANARY_m1','CANARY_suggestion',1,'pending',1,1,'m1')`).run();
  const single=await f.tools.check_human_replies({agentId:'a',id:'audit_test'});
  assert.ok(!JSON.stringify(single).includes('CANARY'));
  const page=await f.tools.check_human_replies({agentId:'a',since:0});assert.ok(!JSON.stringify(page).includes('CANARY'));
  const owner=await withOwnerHistory(()=>f.tools.check_human_replies({agentId:'a',id:'audit_test'}));assert.ok(JSON.stringify(owner).includes('CANARY_m1'));
});

test('group audit counters and owner intervention remain scoped to the rejecting Agent',async t=>{
  let deny=true;const f=fixture(t,{checkAuditRules:()=>({action:deny?'hard_deny':'allow',matchedKeyword:'fixture-rule'})});
  const group={channelId:'group_one',channelType:2,mention:{uids:['a-uid','b-uid']}};
  f.receive('m1',group);await f.handler.flushInboundTurns();deny=false;f.receive('m1',group,'b');await f.handler.flushInboundTurns();
  assert.equal((await f.tools.get_visitor_profile({agentId:'a',visitorId:'v'})).audit.hardDenyCount,1);
  assert.equal((await f.tools.get_visitor_profile({agentId:'b',visitorId:'v'})).audit.totalHits,0);
});

test('legacy group replay cannot acquire new admission merely by being received again',async t=>{
  const f=fixture(t);const mention={uids:['a-uid']};
  f.db.prepare(`INSERT INTO messages(id,agent_id,from_uid,to_uid,channel_id,channel_type,content,timestamp,is_me,status,mention)
    VALUES('m1','a','v','group_one','group_one',2,'CANARY_m1',1001,0,'received',?)`).run(JSON.stringify(mention));
  f.receive('m1',{channelId:'group_one',channelType:2,toUid:'group_one',mention});await f.handler.flushInboundTurns();
  assert.equal(f.dispatched.length,0);assert.equal(getAdmission(f.db,'a','m1'),undefined);
});

test('new group history is distinguishable from legacy history even after rowid reuse',async t=>{
  const f=fixture(t);f.receive('m9');await f.handler.flushInboundTurns();
  f.db.prepare('DELETE FROM messages').run();
  f.receive('m1',{channelId:'group_one',channelType:2});
  f.receive('m2',{channelId:'group_one',channelType:2,mention:{uids:['a-uid']}});await f.handler.flushInboundTurns();
  assert.ok(f.dispatched.at(-1).payload.content.includes('CANARY_m1'));
});

test('v9 upgrade backs up and preserves unknown history without granting permission',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voko-admission-migration-'));const file=path.join(dir,'test.db');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let db=initDatabase(file,{silent:true});
  db.exec(`INSERT INTO messages(id,channel_id,channel_type,from_uid,to_uid,content,timestamp,is_me,status,agent_id)
    VALUES('legacy','v',1,'v','a-uid','legacy raw body',1,0,'received','a');
    DROP TABLE agent_message_admissions;
    ALTER TABLE messages DROP COLUMN admission_received_at;
    PRAGMA user_version=9;
    UPDATE config SET data='9' WHERE type='schema_version'`);
  db.close();db=initDatabase(file,{silent:true});
  assert.equal(db.prepare("SELECT admission_received_at FROM messages WHERE id='legacy'").get().admission_received_at,null);
  assert.equal(getAdmission(db,'a','legacy'),undefined);
  assert.ok(fs.existsSync(file+'.pre-schema-v10.bak'));
  db.close();db=initDatabase(file,{silent:true});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);db.close();
});

test('a freshly persisted local Agent group message is not mistaken for legacy history',async t=>{
  const f=fixture(t);const {persistAgentMessage}=require('../build/core/send-message');
  const mention={uids:['b-uid']};
  const saved=persistAgentMessage(f.db,'a','group_one','CANARY_m1','a-uid','text',2,mention,'m1');
  f.receive('m1',{fromUid:'a-uid',toUid:'group_one',channelId:'group_one',channelType:2,mention,timestamp:saved.timestamp},'b');
  await f.handler.flushInboundTurns();assert.equal(f.dispatched.length,1);assert.equal(f.dispatched[0].agentId,'b');
});

 test('runtime Pull lazily admits new unmentioned group history while standalone reads stay filtered',async t=>{
  const f=fixture(t,{dispatcher:null});
  f.receive('m1',{channelId:'group_one',channelType:2,toUid:'group_one',mention:{uids:[]}});
  await f.handler.flushInboundTurns();
  assert.equal(getAdmission(f.db,'a','m1'),undefined);
  assert.equal((await f.tools.get_chat_history({agentId:'a',channelId:'group_one',channelType:2})).messages.length,0);
  const runtimeTools=createToolHandlers({db:f.db,query:(sql,params=[])=>f.db.prepare(sql).all(...params),exec:(sql,params=[])=>f.db.prepare(sql).run(...params),
    prepareGroupHistory:(agentId,channelId)=>f.handler.prepareGroupHistory(agentId,channelId)});
  assert.equal((await runtimeTools.get_chat_history({agentId:'a',channelId:'group_one',channelType:2})).messages.length,1);
  assert.equal(getAdmission(f.db,'a','m1').state,'allowed');
  assert.equal(f.dispatched.length,0);
 });

test('global Pull rechecks earlier channels after later membership awaits',async t=>{
  const f=fixture(t);
  for(const [id,channelId,fromUid] of [['m1','group_a','v'],['m2','group_z','w']]) {
    f.receive(id,{channelId,channelType:2,fromUid,mention:{uids:['a-uid']}});
  }
  await f.handler.flushInboundTurns();
  let calls=0;
  t.mock.method(groupClient,'getInfo',async()=>{if(++calls===2)f.blacklist();return {status:'active',members:f.members};});
  const result=await f.tools.fetch_new_messages({agentId:'a',cursor:0});
  assert.equal(calls,2);
  assert.ok(!JSON.stringify(result.messages).includes('CANARY_m1'));
  assert.ok(JSON.stringify(result.messages).includes('CANARY_m2'));
});
