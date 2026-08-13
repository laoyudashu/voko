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
          return null;
        },
        all() { return []; },
      };
    },
  };
}

async function startApp(handlers) {
  const app = express();
  app.use(createWebRouter(handlers, createDb()));
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
      agent: { imConnected: true, activeAutomaticMode: 'cli', automaticReadyModes: ['cli'], pullReady: true },
    }),
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /消息模式/);
  assert.match(html, /data-role="message-mode"[^>]*>CLI<\/td>/);
  assert.ok(html.indexOf('>Agent 类型<') < html.indexOf('>连接状态<'));
  assert.ok(html.indexOf('>连接状态<') < html.indexOf('>消息模式<'));
  assert.match(html, /"message_modes":\s*\{[^}]*"pull"/);
  assert.match(html, /messageModeDetected/);
  assert.match(html, /updateAgentRow/);
  assert.match(html, /class="home-access-stack"/);
  assert.match(html, /class="home-access-row home-access-visitor-row"/);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /visitorValue\+visitorAction\+accessModeButton/);
  assert.doesNotMatch(source, /var actionHtml=.*data-role="toggle-acc"/);
  assert.match(source, /s\.className="btn btn-sm btn-outline home-mode-toggle home-access-mode "/);
  assert.match(source, /style="margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important;line-height:1\.4!important;border-width:2px" data-role="toggle-acc"/);
  assert.match(source, /class="home-access-value home-owner-devices"/);
  assert.match(source, /min-height:auto!important;font:inherit;line-height:1\.4;color:#667085;cursor:pointer;text-align:left;align-self:center/);
  assert.match(html, /data-role="gen-owner-link" data-agent="agent-home"/);
  assert.match(source, /data-agent-name=/);
  assert.match(html, /href="\/agents\/agent-home\/caps"/);
  assert.match(html, /\.home-copy-icon\{display:inline-flex/);
  assert.match(html, /<col style="width:41%"><col style="width:12%">/);
  assert.match(html, /\.home-access-action\{margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important/);
  assert.match(source, /function setAgentAccessAvailability/);
  assert.match(source, /button,a,\.home-access-value/);
  assert.match(source, /control\.classList\.contains\("home-access-value"\).*#b0b5bd/);
  assert.match(source, /\.home-agent-short button,\.home-agent-short a/);
  assert.match(source, /setAgentAccessAvailability\(row,data\.imConnected===true\)/);
  assert.match(source, /if\(d\.pubStatus==="unpublished"\)/);
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
  assert.match(html, /access_offline_tip/);
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
  assert.match(html, /data-role="message-mode"[^>]*>获取中<\/td>/);
});
