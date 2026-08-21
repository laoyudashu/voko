'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebRouter } = require('../build/web');

const LOCAL_AGENT_ID = 'agent-local';
const PUBLIC_AGENT_ID = '2b4a3c62-efba-4c97-add9-6f09ee092462';

function createDb() {
  const tokenConfig = JSON.stringify({
    'owner@example.com': { user_access_token: 'user-access-secret', updated_at: 10 },
  });
  return {
    prepare(sql) {
      return {
        get(...args) {
          if (sql.includes("type='current_user_email'")) return { data: JSON.stringify('owner@example.com') };
          if (sql.includes("type='user_access_token'")) return { data: tokenConfig };
          if (sql.includes('SELECT data FROM config WHERE type = ?') && args[0] === 'user_access_token') {
            return { data: tokenConfig };
          }
          if (sql.includes('FROM agents WHERE agent_id=? LIMIT 1')) {
            if (args[0] !== LOCAL_AGENT_ID) return null;
            return {
              agent_id: LOCAL_AGENT_ID,
              agent_name: 'Local Agent',
              owner_email: 'owner@example.com',
              did: 'did:wba:voko:2b4a3c62efba4c97add96f09ee092462',
            };
          }
          return null;
        },
        all() { return []; },
        run() { return { changes: 0 }; },
      };
    },
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function startApp(externalGatewayFetch) {
  const app = express();
  app.use(express.json());
  app.use(createWebRouter({ list_agents: async () => ({ agents: [] }) }, createDb(), { externalGatewayFetch }));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

test('external integration page masks credentials and provides copy controls', async (t) => {
  const calls = [];
  const externalGatewayFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ success: true, data: { integrations: [
      { integration_id: 'int-matching', name: 'CRM', webhook_url: 'https://crm.example.com/events', token_prefix: 'vext_abc',
        token: 'vext_abcdefghijklmnopqrstuvwxyz', webhookSecret: 'secret_abcdefghijklmnopqrstuvwxyz', status: 'active', agentIds: [PUBLIC_AGENT_ID] },
      { integration_id: 'int-other', name: 'Other', webhook_url: 'https://other.example.com/events', token_prefix: 'voko_xyz', status: 'active', agentIds: ['11111111-1111-1111-1111-111111111111'] },
    ] } });
  };
  const server = await startApp(externalGatewayFetch);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/external-integrations?agentId=${LOCAL_AGENT_ID}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /CRM/);
  assert.match(html, /<strong title="CRM"[^>]*>CRM<\/strong><\/td>/);
  assert.match(html, /https:\/\/crm\.example\.com\/events/);
  assert.match(html, new RegExp('/api/external/v1/gateway/agents/' + PUBLIC_AGENT_ID + '/messages'));
  assert.match(html, /data-voko-copy-value="https:[^"]+\/messages"/);
  assert.doesNotMatch(html, />复制 REST 地址<\/button>/);
  assert.match(html, /table-layout:fixed/);
  assert.match(html, /<col style="width:15%"><col style="width:37%">/);
  assert.match(html, /max-width:130px;overflow:hidden;text-overflow:ellipsis/);
  assert.match(html, /第三方系统使用 API Token 调用此地址/);
  assert.match(html, /创建后生成 API Token 和 Webhook 密钥，Agent 将回复推送到该地址/);
  assert.match(html, /id="external-webhook"[^>]*style="max-width:none;margin:0"><button type="submit" class="btn-sm" style="margin:0;white-space:nowrap">创建接入<\/button>/);
  assert.match(html, /vext_abc…wxyz/); assert.match(html, /secret_a…wxyz/);
  assert.match(html, /data-voko-copy-value="vext_abcdefghijklmnopqrstuvwxyz"/);
  assert.match(html, /data-voko-copy-value="secret_abcdefghijklmnopqrstuvwxyz"/);
  assert.doesNotMatch(html, />Other</);
  assert.doesNotMatch(html, /id="external-credentials"/);
  assert.doesNotMatch(html, /data-role="copy-external-credentials"/);
  assert.match(html, /data-role="confirm-external-revoke"/);
  assert.match(html, /data-role="edit-external-integration"/);
  assert.match(html, />编辑</);
  assert.match(html, />操作<\/th>/);
  assert.match(html, />停用<\/button>/);
  assert.match(html, /webhook-probe/);
  assert.match(html, /markInvalid/);
  assert.match(html, /L\.invalid/);
  assert.doesNotMatch(html, />停用接入<\/button>/);
  assert.doesNotMatch(html, />最近调用</);
  assert.doesNotMatch(html, /confirm\(/);
  assert.doesNotMatch(html, /user-access-secret/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer user-access-secret');

  const createdResponse = await fetch(`http://127.0.0.1:${server.address().port}/external-integrations?agentId=${LOCAL_AGENT_ID}&created=1`);
  assert.match(await createdResponse.text(), /接入创建成功，已加入下方系统列表/);
});

test('external integration proxy maps local Agent ID and preserves one-time credentials', async (t) => {
  const calls = [];
  const externalGatewayFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/int-created/webhook-probe')) return jsonResponse({ success: true, data: { valid: false, status: 404 } });
    if (init.method === 'POST') {
      return jsonResponse({ success: true, data: {
        integrationId: 'int-created', token: 'voko_once_token', webhookSecret: 'whsec_once_secret',
      } }, 201);
    }
    if (init.method === 'PATCH') return jsonResponse({ success: true, data: { integrationId: 'int-created' } });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ success: true, data: { integrations: [] } });
  };
  const server = await startApp(externalGatewayFetch);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await fetch(`${base}/api/external-integrations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: LOCAL_AGENT_ID, name: 'Support CRM', webhookUrl: 'https://crm.example.com/voko' }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).data, {
    integrationId: 'int-created', token: 'voko_once_token', webhookSecret: 'whsec_once_secret',
  });
  const createCall = calls.find((call) => call.init.method === 'POST');
  assert.deepEqual(JSON.parse(createCall.init.body), {
    name: 'Support CRM', webhookUrl: 'https://crm.example.com/voko', agentIds: [PUBLIC_AGENT_ID],
  });
  assert.equal(createCall.init.headers.Authorization, 'Bearer user-access-secret');

  const edited = await fetch(`${base}/api/external-integrations/int-created`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Support CRM 2', webhookUrl: 'https://crm.example.com/voko-2' }),
  });
  assert.equal(edited.status, 200);
  const editCall = calls.find((call) => call.init.method === 'PATCH');
  assert.equal(editCall.url.endsWith('/int-created'), true);
  assert.deepEqual(JSON.parse(editCall.init.body), { name: 'Support CRM 2', webhookUrl: 'https://crm.example.com/voko-2' });
  assert.equal(editCall.init.headers.Authorization, 'Bearer user-access-secret');

  const probed = await fetch(`${base}/api/external-integrations/int-created/webhook-probe`, { method: 'POST' });
  assert.equal(probed.status, 200);assert.deepEqual((await probed.json()).data,{valid:false,status:404});
  assert.ok(calls.some(call=>call.init.method==='POST'&&call.url.endsWith('/int-created/webhook-probe')));

  const revoked = await fetch(`${base}/api/external-integrations/int-created`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).success, true);
  assert.ok(calls.some((call) => call.init.method === 'DELETE' && call.url.endsWith('/int-created')));
});

test('external integration page shows 10 integrations per page and preserves Agent ID', async (t) => {
  const integrations = Array.from({ length: 12 }, (_, index) => ({
    integration_id: `int-${index + 1}`,
    name: `Integration ${index + 1}`,
    webhook_url: `https://example.com/events/${index + 1}`,
    token_prefix: `vext_${index + 1}`,
    status: 'active',
    agentIds: [PUBLIC_AGENT_ID],
  }));
  const server = await startApp(async () => jsonResponse({ success: true, data: { integrations } }));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/external-integrations?agentId=${LOCAL_AGENT_ID}`;

  const firstPage = await (await fetch(base)).text();
  assert.match(firstPage, />Integration 1</);
  assert.match(firstPage, />Integration 10</);
  assert.doesNotMatch(firstPage, />Integration 11</);
  assert.match(firstPage, new RegExp(`agentId=${LOCAL_AGENT_ID}&page=2`));

  const secondPage = await (await fetch(`${base}&page=2`)).text();
  assert.doesNotMatch(secondPage, />Integration 10</);
  assert.match(secondPage, />Integration 11</);
  assert.match(secondPage, />Integration 12</);
  assert.match(secondPage, new RegExp(`agentId=${LOCAL_AGENT_ID}&page=1`));
});

test('external integration creation rejects unsafe webhook URLs before contacting the server', async (t) => {
  let called = false;
  const server = await startApp(async () => { called = true; return jsonResponse({ success: true }); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/external-integrations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: LOCAL_AGENT_ID, name: 'Unsafe', webhookUrl: 'http://localhost/hook' }),
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});
