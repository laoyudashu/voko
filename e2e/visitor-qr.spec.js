'use strict';

const { test: base, expect } = require('./fixtures');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { createWebRouter } = require('../build/web');

const officialIcon = 'https://vokofiles.oss-cn-beijing.aliyuncs.com/public/agent_icon/uploaded.png';
const visitorLink = 'https://example.com/s/visitor-qr?code=a%2Bb';
const logo = fs.readFileSync(path.join(__dirname, '../assets/voko-icon.png'));
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve({server,base:'http://127.0.0.1:'+server.address().port}));
});

const test = base.extend({
  qr: async ({}, use) => {
    const state = {icon:null,unavailable:false,uploaded:null};
    const iconApp = express();
    iconApp.get('/icon.png', (req,res) => {
      res.set('Cache-Control','no-store'); // Deliberately no CORS permission.
      if(state.unavailable)return res.status(404).end();
      res.type('png').send(state.uploaded || logo);
    });
    const remote = await listen(iconApp);
    const handlers = {
      list_agents: async () => ({agents:[{agentId:'agent-qr',agentName:'QR Test',backendType:'others'}]}),
      get_status: async () => ({agent:{imConnected:true},warnings:[]}),
      update_agent_profile: async args => {state.icon=args.iconUrl;return {success:true};},
    };
    const db = {prepare: sql => ({get: type => {
      if(type==='user_access_token'||sql.includes("type='user_access_token'"))return {data:JSON.stringify({'owner@example.test':'synthetic-owner-token'})};
      if(sql.includes("type='runtime'"))return {data:JSON.stringify({userEmail:'owner@example.test',agents:[]})};
      if(sql.includes('SELECT imUid, owner_email'))return {imUid:'fixture-im',owner_email:'owner@example.test'};
      return sql.includes('short_link_url')||sql.includes('icon_url')?{short_link_url:visitorLink,icon_url:state.icon}:null;
    },all:()=>[]})};
    const app = express();
    app.use(express.raw({type:'multipart/form-data',limit:'6mb'}));
    app.use((req,res,next)=>{if(Buffer.isBuffer(req.body))req.rawBody=req.body;next();});
    app.use(createWebRouter(handlers,db,{
      localAuthToken:'e2e-test-local-auth',
      uploadAgentIcon:async data=>{state.uploaded=data;return officialIcon;},
      visitorQrIconFetch:async (url,options)=>{
        expect(url).toBe(officialIcon);
        return fetch(remote.base+'/icon.png',options);
      },
    }));
    const local = await listen(app);
    try{await use({state,base:local.base,remote:remote.base});}
    finally{await Promise.all([local.server,remote.server].map(server=>new Promise(resolve=>server.close(resolve))));}
  },
});

async function expectComposedQr(page) {
  await expect.poll(()=>page.locator('#visitor-qr-image').evaluate(img=>img.src!==img.dataset.qr)).toBe(true);
  await expect(page.locator('#visitor-qr-error')).toBeHidden();
  await expect(page.locator('#visitor-qr-image')).toBeVisible();
  const preview = await page.locator('#visitor-qr-image').getAttribute('src');
  await expect(page.locator('#visitor-qr-download')).toHaveAttribute('href',preview);
  const downloaded = page.waitForEvent('download');
  await page.locator('#visitor-qr-download').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('voko-visitor-qr.png');
  expect(fs.readFileSync(await download.path())).toEqual(Buffer.from(preview.split(',')[1],'base64'));
}

test('default icon QR and its download stay available',async({page,qr})=>{
  await page.goto(qr.base+'/agents/agent-qr/visitor-qr');
  await expectComposedQr(page);
});

test('uploaded icon without CORS composes and downloads from a LAN page origin',async({page,request,qr})=>{
  const upload = await request.post(qr.base+'/api/agents/agent-qr/icon',{
    multipart:{file:{name:'logo.png',mimeType:'image/png',buffer:logo}},
  });
  expect(upload.status()).toBe(200);
  expect(await upload.json()).toMatchObject({success:true,iconUrl:officialIcon});
  expect(qr.state.uploaded).toEqual(logo);
  const origin = 'http://192.168.1.10:3100';
  // Simulate the page's LAN origin; all page/icon bytes come from real local HTTP servers.
  await page.route(origin+'/**',async route=>route.fulfill({response:await request.get(qr.base+new URL(route.request().url()).pathname)}));
  let directRequests = 0;
  await page.route(officialIcon,async route=>{
    directRequests++;
    await route.fulfill({response:await request.get(qr.remote+'/icon.png')});
  });
  expect((await request.get(qr.remote+'/icon.png')).headers()['access-control-allow-origin']).toBeUndefined();
  await page.goto(origin+'/agents/agent-qr/visitor-qr');
  await expectComposedQr(page);
  expect(directRequests).toBe(0);
});

test('unavailable uploaded icon preserves the basic QR and download, and reload recovers',async({page,qr})=>{
  qr.state.icon=officialIcon;
  qr.state.unavailable=true;
  await page.goto(qr.base+'/agents/agent-qr/visitor-qr');
  await expect(page.locator('#visitor-qr-error')).toBeVisible();
  await expect(page.locator('#visitor-qr-image')).toBeVisible();
  const original = await page.locator('#visitor-qr-image').getAttribute('data-qr');
  await expect(page.locator('#visitor-qr-image')).toHaveAttribute('src',original);
  await expect(page.locator('#visitor-qr-download')).toBeVisible();
  await expect(page.locator('#visitor-qr-download')).toHaveAttribute('href',original);
  const downloaded=page.waitForEvent('download');
  await page.locator('#visitor-qr-download').click();
  expect(fs.readFileSync(await (await downloaded).path())).toEqual(Buffer.from(original.split(',')[1],'base64'));
  qr.state.unavailable=false;
  await page.reload();
  await expectComposedQr(page);
});
