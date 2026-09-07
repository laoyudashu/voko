'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderA2AShare}=require('../build/web/a2a-share');
const options={agent:{agentId:'local-id',visibilityType:1},row:{did:'did:voko:0123456789abcdef0123456789abcdef',publish_status:'published'},enabled:true,baseUrl:'https://www.vokovoko.com',t:key=>key,esc:value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')};
test('unavailable sharing states explain the reason without copy controls',()=>{
 for(const [change,reason] of [[{enabled:false},'share_disabled'],[{row:{publish_status:'unpublished'}},'verify_not_published'],[{agent:{agentId:'local-id',visibilityType:2}},'share_hidden']]){
  const html=renderA2AShare({...options,...change});assert.ok(html.includes(reason));assert.ok(!html.includes('data-voko-copy-value'));
 }
});
