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
    whoami: async () => ({ agents: [{ agentId: 'agent-home', agentName: 'Home Agent', backendType: 'qwen', publishStatus: 'published' }] }),
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
});

test('home truncates long agent names but keeps the full name in a hover hint', async (t) => {
  const fullName = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const handlers = {
    whoami: async () => ({ agents: [{ agentId: 'agent-long-name', agentName: fullName, backendType: 'others', publishStatus: 'published' }] }),
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
    whoami: async () => ({ agents: [{ agentId: 'agent-loading', agentName: 'Loading Agent', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => { throw new Error('status unavailable'); },
  };
  const server = await startApp(handlers);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-role="message-mode"[^>]*>获取中<\/td>/);
});
