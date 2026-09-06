'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const QRCode = require('qrcode');
const { createWebRouter } = require('../build/web');

async function fixture(t, link) {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-qr', agentName: 'QR Test', accessMode: 'private', backendType: 'others' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [], total: 0 }),
    list_groups: async () => ({ groups: [], total: 0 }),
  };
  const db = { prepare: (sql) => ({ get: () => {
    if (sql.includes("type='user_access_token'")) return {data:JSON.stringify({'owner@example.com':'redacted-test-token'})};
    if (sql.includes("type='runtime'")) return {data:JSON.stringify({userEmail:'owner@example.com',agents:[]})};
    return sql.includes('short_link_url') ? { short_link_url: link, imUid: 'visitor-im' } : null;
  }, all: () => [] }) };
  const app = express();
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
  const detail = await (await fetch(base+'/agents/agent-qr')).text();
  assert.match(detail, /href="\/agents\/agent-qr\/access-mode" class="op-card"[^>]*>访客访问 · 仅白名单<\/a>/);
  const response = await fetch(base+'/agents/agent-qr/visitor-qr');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const expected = await QRCode.toDataURL(link, {type:'image/png',width:768,margin:4,errorCorrectionLevel:'M'});
  assert.ok(html.includes('src="'+expected+'"'));
  assert.ok(html.includes('href="'+expected+'" download="voko-visitor-qr.png"'));
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
