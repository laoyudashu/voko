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

test('external integration page filters by Agent and never renders stored secrets', async (t) => {
  const calls = [];
  const externalGatewayFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ success: true, data: { integrations: [
      { integration_id: 'int-matching', name: 'CRM', webhook_url: 'https://crm.example.com/events', token_prefix: 'voko_abc', status: 'active', agentIds: [PUBLIC_AGENT_ID] },
      { integration_id: 'int-other', name: 'Other', webhook_url: 'https://other.example.com/events', token_prefix: 'voko_xyz', status: 'active', agentIds: ['11111111-1111-1111-1111-111111111111'] },
    ] } });
  };
  const server = await startApp(externalGatewayFetch);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/external-integrations?agentId=${LOCAL_AGENT_ID}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /CRM/);
  assert.match(html, /https:\/\/crm\.example\.com\/events/);
  assert.match(html, new RegExp('/api/external/v1/gateway/agents/' + PUBLIC_AGENT_ID + '/messages'));
  assert.match(html, /data-voko-copy-value="https:[^"]+\/messages"/);
  assert.doesNotMatch(html, />Other</);
  assert.match(html, /id="external-credentials"/);
  assert.match(html, /data-role="confirm-external-revoke"/);
  assert.doesNotMatch(html, /confirm\(/);
  assert.doesNotMatch(html, /user-access-secret/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer user-access-secret');
});

test('external integration proxy maps local Agent ID and preserves one-time credentials', async (t) => {
  const calls = [];
  const externalGatewayFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST') {
      return jsonResponse({ success: true, data: {
        integrationId: 'int-created', token: 'voko_once_token', webhookSecret: 'whsec_once_secret',
      } }, 201);
    }
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

  const revoked = await fetch(`${base}/api/external-integrations/int-created`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).success, true);
  assert.ok(calls.some((call) => call.init.method === 'DELETE' && call.url.endsWith('/int-created')));
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
