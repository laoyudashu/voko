'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebRouter } = require('../build/web');

function db() {
  return {
    prepare(sql) {
      return {
        get() {
          if (String(sql).includes("type='runtime'")) return { data: JSON.stringify({ port: 3100, userEmail: 'owner@example.com' }) };
          if (String(sql).includes("type='user_access_token'")) return { data: JSON.stringify({ 'owner@example.com': 'token' }) };
          return null;
        },
        all() { return []; },
      };
    },
  };
}

async function start(t) {
  const app = express();
  app.use(express.json());
  app.use(createWebRouter({
    list_agents: async () => ({ agents: [] }),
    get_status: async () => ({ agent: { imConnected: false } }),
  }, db(), { trustedRemoteEnabled: false }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('parked trusted remote UI and local proxy routes are hard-disabled', async t => {
  const base = await start(t);
  // Do not leave Undici keep-alive handles racing the temporary server cleanup.
  // Node 24 on Windows can otherwise abort in libuv while the test process exits.
  const headers = { Accept: 'application/json', Connection: 'close' };
  const page = await fetch(`${base}/`, { headers: { Connection: 'close' } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.doesNotMatch(html, /href="\/trusted-remote"/);

  for (const path of [
    '/trusted-remote',
    '/api/owner-link/create',
    '/API/OWNER-LINK/CREATE',
    '/api/owner-link/devices',
    '/api/owner-chat/policy',
    '/API/OWNER-CHAT/POLICY',
    '/api/owner-codex-config/agent-1',
    '/agents/agent-1/owner-chats/conversation-1',
  ]) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 404, path);
  }
});
