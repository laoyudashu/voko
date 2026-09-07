'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { finishAdmission, assertMessagesReadable } = require('../build/core/message-admission');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');
const HermesHttpProvider = require('../build/core/dispatcher/providers/hermes-http');
const { DuMateHttpProvider } = require('../build/core/dispatcher/providers/dumate-http');
const { DeepSeekHarnessHttpProvider } = require('../build/core/dispatcher/providers/deepseek-harness-http');

function fixture(t, backend='hermes') {
  const db=initDatabase(':memory:',{silent:true});t.after(()=>db.close());
  db.prepare(`INSERT INTO agents(id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,backend_instance_id,created_at,updated_at)
    VALUES('a','a','a-uid','test','','published','public',?,'expert',1,1)`).run(backend);
  db.prepare(`INSERT INTO messages(id,agent_id,from_uid,to_uid,channel_id,channel_type,content,timestamp,is_me,status)
    VALUES('m','a','v','a-uid','v',1,'ADMITTED_TEXT',1,0,'received')`).run();
  finishAdmission(db,'a','m','allowed','ALLOWED');
  const payload={agentId:'a',fromUid:'v',channelId:'v',channelType:1,content:'ADMITTED_TEXT',messageId:'m',turnId:'m',
    assertSubmissionCurrent:async()=>assertMessagesReadable(db,'a',['m'],'trigger')};
  const revoke=()=>db.prepare(`INSERT INTO agent_access_lists(id,agent_id,visitor_id,list_type,created_at,updated_at)
    VALUES('bl','a','v','blacklist',1,1)`).run();
  return {db,payload,revoke};
}
const rejected=e=>e.code==='MESSAGE_ADMISSION_REJECTED' && e.deliveryOutcome==='rejected';

test('ACP refuses submission when access changes during session startup',async t=>{
  const f=fixture(t);const adapter=new AcpAdapter({db:f.db});let prompts=0;
  const session={sessionId:'s',prompt:async()=>{prompts++}};
  adapter._ensureAgent=async()=>({sessions:new Map(),agentIds:new Set(['a'])});
  adapter._ensureSession=async()=>{f.revoke();return session};
  await assert.rejects(adapter._pushViaAcp(f.payload),rejected);assert.equal(prompts,0);
});

test('Hermes HTTP refuses submission after a delayed gateway startup',async t=>{
  const f=fixture(t); const p=new HermesHttpProvider(f.db,null);let prompts=0;
  p._profileForAgent=()=> 'expert';p._ensureGatewayRunning=async()=>{f.revoke();return true};p.connected=true;
  p.client={chat:async()=>{prompts++;return {reply:'reply'}}};
  await assert.rejects(p.push(f.payload),rejected);assert.equal(prompts,0);
});

test('DuMate checks again after looking up the previous assistant result',async t=>{
  const f=fixture(t,'dumate');const p=new DuMateHttpProvider({db:f.db,resolveAgentTarget:()=>({})});let prompts=0;
  p._routeForAgent=()=> 'expert';p._ensureState=async()=>({});
  p._json=async(_state,url)=>{if(url==='/session')return {id:'s'};prompts++;return {}};
  p._latestAssistant=async()=>{f.revoke();return {id:'old',reply:''}};
  await assert.rejects(p.push(f.payload),rejected);assert.equal(prompts,0);
});

test('DeepSeek Harness preserves rejection and does not send after session creation',async t=>{
  const f=fixture(t,'deepseek-harness');const p=new DeepSeekHarnessHttpProvider({db:f.db,startServer:false});let prompts=0;
  p._rpc=async(method)=>{if(method==='session.create'){f.revoke();return {value:{sessionId:'s'}}}prompts++;return {}};
  await assert.rejects(p.push(f.payload),rejected);assert.equal(prompts,0);
});
