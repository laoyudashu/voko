'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebRouter } = require('../build/web');

function createDb() {
  const runtime = {
    port: 3100,
    pid: 1234,
    userEmail: 'owner@example.com',
    agents: [{ agentId: 'agent-home', imConnected: true }],
  };
  return {
    prepare(sql) {
      return {
        get() {
          if (sql.includes("type='user_access_token'")) {
            return { data: JSON.stringify({ 'owner@example.com': 'redacted-test-token' }) };
          }
          if (sql.includes("type='runtime'")) return { data: JSON.stringify(runtime) };
          if (sql.includes('SELECT short_link_url, imUid FROM agents')) return { short_link_url: null, imUid: 'im-home-uid' };
          return null;
        },
        all() { return []; },
      };
    },
  };
}

async function startApp(handlers) {
  const app = express();
  app.use(express.json());
  app.use(createWebRouter(handlers, createDb(), { trustedRemoteEnabled: true }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return server;
}

test('home shows the detected primary message mode and wires runtime partial refresh', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-home', agentName: 'Home Agent', backendType: 'qwen', publishStatus: 'published' }] }),
    get_status: async () => ({
      success: true,
      agent: { imConnected: true, activeAutomaticMode: 'cli', automaticReadyModes: ['cli'], pullReady: true,
        deliveryStatus: { activeAutomaticMode: 'cli', temporaryPreferredMode: null, methods: [] } },
    }),
    refresh_delivery_channels: async () => ({ success: true, deliveryStatus: { activeAutomaticMode: 'cli', temporaryPreferredMode: null, methods: [] } }),
    select_delivery_channel: async ({ mode, providerId }) => ({ success: true, deliveryStatus: { activeAutomaticMode: mode === 'pull' ? null : mode, temporaryPreferredMode: mode, temporaryPreferredProvider: providerId || null, methods: [] } }),
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /消息模式/);
  assert.match(html, /data-role="message-mode"[^>]*>[\s\S]*data-role="message-mode-summary">CLI<\/summary>/);
  assert.ok(html.indexOf('>Agent 类型<') < html.indexOf('>连接状态<'));
  assert.ok(html.indexOf('>连接状态<') < html.indexOf('>消息模式<'));
  assert.match(html, /"message_modes":\s*\{[^}]*"pull"/);
  assert.match(html, /messageModeDetected/);
  assert.match(html, /data-role="message-mode-picker"/);
  assert.match(html, /delivery-channels\/refresh/);
  assert.match(html, /delivery-channels\/select/);
  assert.match(html, /if\(other!==details\)other\.open=false/);
  assert.match(html, /if\(!details\.contains\(e\.target\)\)details\.open=false/);
  assert.match(html, /updateAgentRow/);
  assert.match(html, /class="home-access-stack"/);
  assert.match(html, /class="home-access-row home-access-visitor-row"/);
  assert.match(html, /class="home-access-row home-access-protocol-row"/);
  assert.match(html, />A2A Card<\/span>/);
  assert.match(html, /data-voko-copy-value="im-home-uid"/);
  assert.match(html, />IM UID<\/span>/);
  assert.match(html, /\.home-access-protocol-row\{grid-template-columns:minmax\(0,\.9fr\) minmax\(0,\.85fr\) minmax\(0,1\.25fr\);gap:6px\}/);
  assert.match(html, /\.home-access-compact-item\+\.home-access-compact-item\{border-left:1px solid #d9e0e8;padding-left:6px\}/);
  assert.match(html, /class="home-access-compact-item home-access-compact-link"/);
  assert.match(html, />REST\/Webhook<\/span>/);
  assert.match(html, /href="\/external-integrations\?agentId=agent-home"/);
  assert.doesNotMatch(html, /data-role="external-integration-value"/);
  assert.doesNotMatch(html, /data-role="external-integration-action"/);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /M9 4v5M15 4v5M7 9h10v3a5 5 0 0 1-10 0V9ZM12 17v3/);
  assert.match(source, /visitorValue\+accessModeButton\+visitorAction/);
  assert.doesNotMatch(source, /var actionHtml=.*data-role="toggle-acc"/);
  assert.match(source, /s\.className="btn btn-sm btn-outline home-mode-toggle home-access-mode "/);
  assert.match(source, /style="margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important;line-height:1\.4!important;border-width:2px" data-role="toggle-acc"/);
  assert.doesNotMatch(html, /data-role="gen-owner-link"/);
  assert.doesNotMatch(html, /data-owner-agent/);
  assert.match(html, /href="\/trusted-remote"/);
  assert.doesNotMatch(html, /href="\/agents\/agent-home\/caps"/);
  assert.match(html, /\.home-copy-icon\{display:inline-flex/);
  assert.match(html, /<col style="width:35%"><col style="width:13%">/);
  assert.match(html, /\.home-access-action\{margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important/);
  assert.match(source, /function setAgentAccessAvailability/);
  assert.match(source, /button,a,\.home-access-value/);
  assert.match(source, /control\.classList\.contains\("home-access-value"\).*#b0b5bd/);
  assert.match(source, /\.home-agent-short button,\.home-agent-short a/);
  assert.match(source, /setAgentAccessAvailability\(row,data\.imConnected===true\)/);
  assert.match(source, /if\(d\.pubStatus==="unpublished"\)/);
});

test('delivery channel endpoints refresh and select a process-local preference', async (t) => {
  const calls = [];
  const status = { activeAutomaticMode: 'cli', temporaryPreferredMode: null, temporaryPreferredProvider: null,
    methods: [{ mode: 'cli', provider: 'codex-cli', available: true }, { mode: 'pull', provider: null, available: true }] };
  const handlers = {
    list_agents: async () => ({ agents: [] }),
    refresh_delivery_channels: async ({ agentId }) => { calls.push(['refresh', agentId]); return { success: true, deliveryStatus: status }; },
    select_delivery_channel: async ({ agentId, mode, providerId }) => {
      calls.push(['select', agentId, mode, providerId]);
      return { success: true, deliveryStatus: { ...status, activeAutomaticMode: mode === 'pull' ? null : mode,
        temporaryPreferredMode: mode, temporaryPreferredProvider: providerId || null } };
    },
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const refresh = await fetch(`${base}/api/agents/agent-home/delivery-channels/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).deliveryStatus.activeAutomaticMode, 'cli');
  const select = await fetch(`${base}/api/agents/agent-home/delivery-channels/select`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'pull', providerId: null }),
  });
  assert.equal(select.status, 200);
  assert.equal((await select.json()).deliveryStatus.temporaryPreferredMode, 'pull');
  assert.deepEqual(calls, [['refresh', 'agent-home'], ['select', 'agent-home', 'pull', null]]);
});

test('home disables access-entry actions when the agent is offline', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-offline', agentName: 'Offline Agent', backendType: 'qwen', publishStatus: 'unpublished' }] }),
    get_status: async () => ({ success: true, agent: { imConnected: false, pullReady: true } }),
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /class="home-agent-short is-agent-offline" data-agent-online="false"/);
  assert.match(html, /href="\/external-integrations\?agentId=agent-offline"/);
  assert.match(html, /class="home-message-mode-picker is-agent-offline"[^>]*data-agent-online="false"/);
  assert.match(html, /access_offline_tip/);
  assert.match(html, /home-message-mode-picker\.is-dropup/);
  assert.match(html, /wrap\.getBoundingClientRect\(\)\.bottom-8/);
  assert.match(html, /menuRect\.bottom>bottomBoundary/);
});

test('home preserves the agent list order when connection states differ', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [
      { agentId: 'agent-offline-first', agentName: 'Offline First', backendType: 'qwen', publishStatus: 'unpublished' },
      { agentId: 'agent-online-second', agentName: 'Online Second', backendType: 'qwen', publishStatus: 'published' },
    ] }),
    get_status: async ({ agentId }) => ({ success: true, agent: { imConnected: agentId === 'agent-online-second', pullReady: true } }),
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.indexOf('data-agent-id="agent-offline-first"') < html.indexOf('data-agent-id="agent-online-second"'));
});

test('home truncates long agent names but keeps the full name in a hover hint', async (t) => {
  const fullName = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-long-name', agentName: fullName, backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => ({
      success: true,
      agent: { imConnected: true, activeAutomaticMode: 'cli', automaticReadyModes: ['cli'], pullReady: true },
    }),
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp('title="' + fullName + '" aria-label="' + fullName + '">ABCDEFGHIJKLMNOPQRSTUVW…<\\/a>'));
});

test('home keeps message mode as loading when the status probe has not completed', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-loading', agentName: 'Loading Agent', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => { throw new Error('status unavailable'); },
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-role="message-mode"[^>]*>[\s\S]*data-role="message-mode-summary">获取中<\/summary>/);
});
