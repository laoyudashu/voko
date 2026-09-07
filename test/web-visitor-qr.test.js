'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const QRCode = require('qrcode');
const vm = require('node:vm');
const { createWebRouter } = require('../build/web');

async function fixture(t, link, modeChanges = [], iconUrl = null) {
  const handlers = {
    set_private_mode: async (args) => { modeChanges.push(args); return {success:true}; },
    list_agents: async () => ({ agents: [{ agentId: 'agent-qr', agentName: 'QR Test', accessMode: 'private', backendType: 'others' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [], total: 0 }),
    list_groups: async () => ({ groups: [], total: 0 }),
  };
  const db = { prepare: (sql) => ({ get: (type) => {
    if (type === "user_access_token" || sql.includes("type='user_access_token'")) return {data:JSON.stringify({'owner@example.com':'redacted-test-token'})};
    if (sql.includes("type='runtime'")) return {data:JSON.stringify({userEmail:'owner@example.com',agents:[]})};
    if (sql.includes('SELECT imUid, owner_email')) return {imUid:'visitor-im',owner_email:'owner@example.com'};
    return sql.includes('short_link_url') ? { short_link_url: link, icon_url: iconUrl, imUid: 'visitor-im' } : null;
  }, all: () => [] }) };
  const app = express();
  app.use(express.json());
  app.use(createWebRouter(handlers, db));
  const server = await new Promise(resolve => { const s=app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('visitor QR uses the exact saved link and provides the same PNG for preview and download', async t => {
  const link = 'https://example.com/visit/agent-qr?code=a%2Bb&lang=zh#chat';
  const base = await fixture(t, link);
  const home = await (await fetch(base)).text();
  assert.match(home, /href="\/agents\/agent-qr\/visitor-qr"[^>]*data-role="visitor-qr"/);
  assert.doesNotMatch(home, /data-role="toggle-acc"/);
  for (const script of home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!script[0].includes('application/ld+json')) new vm.Script(script[1]);
  }
  const detail = await (await fetch(base+'/agents/agent-qr')).text();
  assert.doesNotMatch(detail, /href="\/agents\/agent-qr\/access-mode"/);
  assert.match(home, /data-role="gen-link" data-agent="agent-qr" data-existing="true" data-access-mode="private"/);
  assert.match(home, /name="link-access" value="public" checked/);
  assert.match(home, /name="link-access" value="private"/);
  const response = await fetch(base+'/agents/agent-qr/visitor-qr');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const expected = await QRCode.toDataURL(link, {type:'image/png',width:768,margin:4,errorCorrectionLevel:'H'});
  assert.ok(html.includes('data-qr="'+expected+'"'));
  assert.match(html, /data-icon="\/favicon.png"/);
  assert.match(html, /id="visitor-qr-download" hidden class="btn" download="voko-visitor-qr.png"/);
  assert.ok(html.includes('code=a%2Bb&amp;lang=zh#chat'));
  assert.equal((await fetch(base+'/agents/missing/visitor-qr', {redirect:'manual'})).status, 302);
});

for (const link of [null, 'javascript:alert(1)', 'https://user:password@example.com/']) {
  test(`visitor QR rejects missing or unsafe saved link: ${link === null ? 'missing' : new URL(link).protocol}`, async t => {
    const base = await fixture(t, link);
    const response = await fetch(base+'/agents/agent-qr/visitor-qr');
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /data:image\/png/);
    if (link === null) assert.match(await (await fetch(base)).text(), /data-role="visitor-qr"[^>]* disabled/);
  });
}

test('saved visitor link is reused when switching either access mode', async t => {
  const changes = [];
  const link = 'https://example.com/visit/saved';
  const base = await fixture(t, link, changes);
  for (const accessMode of ['public', 'private']) {
    const result = await (await fetch(base+'/api/short-link/create', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({agentId:'agent-qr',accessMode})
    })).json();
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.shortUrl, link);
  }
  assert.deepEqual(changes, [
    {agentId:'agent-qr',enabled:false}, {agentId:'agent-qr',enabled:true}
  ]);
});

test('visitor QR reads the saved Agent icon even when list_agents omits it', async t => {
  const icon='https://example.com/agent-icon.png';
  const base=await fixture(t, 'https://example.com/visit/saved', [], icon);
  const html=await (await fetch(base+'/agents/agent-qr/visitor-qr')).text();
  assert.ok(html.includes('data-icon="'+icon+'"'));
  assert.doesNotMatch(html,/data-icon="\/favicon.png"/);
});
