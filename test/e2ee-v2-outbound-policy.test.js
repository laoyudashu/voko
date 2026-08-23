'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const {reviewE2eeOutboundReply}=require('../build/e2ee/v2-outbound-policy');

test('E2EE outbound policy strips protocol state and replaces a blocked secret',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE user_cache(uid TEXT PRIMARY KEY,locale TEXT); INSERT INTO user_cache VALUES (\'guest-1\',\'en\');');
    const safe=await reviewE2eeOutboundReply({db,databaseAPI:null,agentId:'gym',channelId:'guest-1',
      messageId:'message-safe',content:'Visible answer\n[STATE]{"converged":true}[/STATE]'});
    assert.equal(safe,'Visible answer');
    const blocked=await reviewE2eeOutboundReply({db,databaseAPI:null,agentId:'gym',channelId:'guest-1',
      messageId:'message-blocked',content:'credential sk-abcdefghijklmnopqrstuvwxyz123456'});
    assert.equal(blocked,'[System] This reply contained sensitive information and was not delivered. Please ask again.');
    assert.doesNotMatch(blocked,/sk-/);
  }finally{db.close();}
});

test('E2EE production integration includes private Agents and hides key indicators unless debug is enabled',()=>{
  const index=fs.readFileSync('src/index.ts','utf8');
  const web=fs.readFileSync('src/web/index.js','utf8');
  assert.match(index,/publish_status IN \('published','private'\)/);
  assert.match(index,/reviewE2eeOutboundReply/);
  assert.match(web,/VOKO_E2EE_DEBUG_UI/);
  assert.match(web,/e2eeDebugUi&&e2eeState==='active'/);
});
