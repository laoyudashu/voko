'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderA2AShare}=require('../build/web/a2a-share');
const {chromium}=require('playwright');
const {copyControlScript,COPIED_ICON}=require('../build/web/ui-controls');
const options={agent:{agentId:'local-id',visibilityType:1},row:{did:'did:voko:0123456789abcdef0123456789abcdef',publish_status:'published'},enabled:true,baseUrl:'https://www.vokovoko.com',t:key=>key,esc:value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')};
test('unavailable sharing states explain the reason without copy controls',()=>{
 for(const [change,reason] of [[{enabled:false},'share_disabled'],[{row:{publish_status:'unpublished'}},'verify_not_published'],[{agent:{agentId:'local-id',visibilityType:2}},'share_hidden']]){
  const html=renderA2AShare({...options,...change});assert.ok(html.includes(reason));assert.ok(!html.includes('data-voko-copy-value'));
 }
});
test('share controls use public DID and become available only after verification',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();let success=false;
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copiedValue=value}}})});
  await page.route('https://local.test/**',route=>{
   if(route.request().url().endsWith('/verify-a2a-card')){assert.equal(route.request().method(),'GET');return route.fulfill({json:success?{success:true,message:'verified'}:{success:false,error:'Card unavailable'}})}
   return route.fulfill({contentType:'text/html; charset=utf-8',body:renderA2AShare(options)+copyControlScript()});
  });
  await page.goto('https://local.test/caps');await page.locator('#a2a-share-retry').waitFor({state:'visible'});
  assert.equal(await page.locator('#a2a-share-ready').isVisible(),false);
  assert.equal(await page.locator('#a2a-share-status').textContent(),'Card unavailable');
  success=true;await page.locator('#a2a-share-retry').click();await page.locator('#a2a-share-ready').waitFor({state:'visible'});
  const url='https://www.vokovoko.com/a2a/agents/01234567-89ab-cdef-0123-456789abcdef/.well-known/agent-card.json';
  assert.equal(await page.locator('[data-voko-copy-value]').getAttribute('data-voko-copy-value'),url);
  assert.equal(await page.locator('#a2a-share-ready a').getAttribute('href'),url);
  const copy=page.locator('[data-voko-copy-value]');
  await copy.click();
  assert.equal(await copy.innerHTML(),await page.evaluate(html=>{const el=document.createElement('div');el.innerHTML=html;return el.innerHTML},COPIED_ICON));
  assert.equal(await page.evaluate(()=>window.copiedValue),url);
  await page.waitForFunction(()=>document.querySelector('[data-voko-copy-value]').textContent==='web.agent.caps.share_copy');
  await copy.click();
  assert.equal(await copy.innerHTML(),await page.evaluate(html=>{const el=document.createElement('div');el.innerHTML=html;return el.innerHTML},COPIED_ICON));
 }finally{await browser.close()}
});
