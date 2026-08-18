'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createWebRouter } = require('../build/web');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');

test('global owner link creation uses the authenticated API without an Agent requirement', () => {
  const route = source.match(/R\.post\('\/api\/owner-link\/create'[\s\S]*?\n  \}\);/)[0];
  assert.match(route, /let requestBody=\{\}/);
  assert.match(route, /if\(localAgentId\)/);
  assert.match(route, /getUserAccessToken\(db,ownerEmail\)/);
  assert.match(route, /body:JSON\.stringify\(requestBody\)/);
  assert.match(route, /Authorization:'Bearer '\+userAccessToken/);
  assert.match(route, /ownerUrl\.startsWith\('https:\/\/'\)/);
  assert.doesNotMatch(route, /if\(!localAgentId\)return/);
  assert.doesNotMatch(route, /INSERT|UPDATE|owner_link_url/);
});

test('home access entries exclude owner and include external integration management', () => {
  const home = source.match(/R\.get\('\/'[\s\S]*?R\.get\('\/trusted-remote'/)[0];
  assert.match(home, /accessIcon\('visitor'\)/);
  assert.match(home, /accessIcon\('a2a'\)/);
  assert.match(home, /accessIcon\('external'\)/);
  assert.match(home, /href="\/external-integrations\?agentId=/);
  assert.doesNotMatch(home, /accessIcon\('owner'\)/);
  assert.doesNotMatch(home, /data-role="gen-owner-link"/);
  assert.doesNotMatch(home, /data-owner-agent/);
  assert.match(home, /href="\/trusted-remote"/);
  assert.ok(home.indexOf('href="/trusted-remote"') < home.indexOf('href="/audit-rules"'));
});

test('trusted remote page owns generation, device SSE and revocation without persisting tokens', () => {
  const route = source.match(/R\.get\('\/trusted-remote'[\s\S]*?R\.use\(createRegisterRouter/)[0];
  assert.match(route, /data-testid="trusted-remote-page"/);
  assert.match(route, /body:"\{\}"/);
  assert.match(route, /new EventSource\("\/api\/owner-link\/device-events"\)/);
  assert.match(route, /\/api\/owner-link\/devices\//);
  assert.match(route, /replaceChildren/);
  assert.doesNotMatch(route, /localStorage|sessionStorage/);
  assert.doesNotMatch(route, /vokovoko\.com\/owner/);
  assert.doesNotMatch(route, /setInterval/);
});

test('device proxy remains account scoped', () => {
  const route = source.match(/R\.get\('\/api\/owner-link\/devices'[\s\S]*?\n  \}\);/)[0];
  assert.match(route, /result\.data\?\.devices\|\|\[\]/);
  assert.doesNotMatch(route, /remoteToLocal|serverAgentIdFromDid/);
  assert.match(source, /R\.delete\('\/api\/owner-link\/devices\/:deviceId'/);
  assert.match(source, /R\.get\('\/api\/owner-link\/device-events'/);
});

test('trusted remote page renders an account-level Agent count', async t => {
  const app = express();
  app.use(createWebRouter({
    list_agents: async () => ({ agents: [
      { agentId: 'a', publishStatus: 'published' },
      { agentId: 'b', publishStatus: 'published' },
      { agentId: 'c', publishStatus: 'unpublished' },
    ] }),
  }, { prepare: () => ({ get: () => null, all: () => [] }) }, { trustedRemoteEnabled: true }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/trusted-remote`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-testid="trusted-remote-page"/);
  assert.match(html, /当前可访问 2 个 Agent/);
  assert.doesNotMatch(html, /https:\/\/www\.vokovoko\.com\/owner/);
});
