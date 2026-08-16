'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {initOwnerChatSchema,OwnerChatInboxRecovery}=require('../build/owner-chat');

function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-chat-recovery-'));const db=new DatabaseSync(path.join(dir,'chat.db'));initOwnerChatSchema(db);return{db,close(){db.close();fs.rmSync(dir,{recursive:true,force:true})}}}
function message(db,{id,state='persisted',leaseExpires=null,at=100}){db.prepare(`INSERT INTO owner_chat_messages
  (message_id,client_message_id,conversation_id,owner_identity_id,owner_im_uid,agent_id,local_agent_id,ownership_epoch,conversation_epoch,sequence,content_type,payload_json,payload_digest,state,execution_state,lease_owner,lease_expires_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,id,'conversation-'+id,'owner-id','owner-im','remote-agent','local-agent',1,1,1,1,'{"text":"hello"}','digest-'+id,state,state==='leased'?'DISPATCH_RESERVED':'PERSISTED',state==='leased'?'old-worker':null,leaseExpires,at,at)}

test('runtime recovery never replays an expired in-flight lease',async()=>{const f=fixture();try{
  const now=Date.now();message(f.db,{id:'expired',state:'leased',leaseExpires:now-1});message(f.db,{id:'live',state:'leased',leaseExpires:now+60000});
  const calls=[];const updates=[];const recovery=new OwnerChatInboxRecovery(f.db,{process:async id=>{calls.push(id);f.db.prepare("UPDATE owner_chat_messages SET state='replied' WHERE message_id=?").run(id);return{status:'replied'}}},60000,event=>updates.push(event));
  assert.equal(await recovery.flush(),0);assert.deepEqual(calls,[]);assert.equal(f.db.prepare("SELECT state FROM owner_chat_messages WHERE message_id='expired'").get().state,'outcome_unknown');assert.equal(f.db.prepare("SELECT state FROM owner_chat_messages WHERE message_id='live'").get().state,'leased');assert.deepEqual(updates,[]);
}finally{f.close()}});
