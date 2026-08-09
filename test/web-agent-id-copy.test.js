'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebRouter } = require('../build/web');

test('agent detail exposes a double-click copy affordance for the Agent ID', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-copy-id', agentName: 'Copy Test', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [], total: 0 }),
    list_groups: async () => ({ groups: [], total: 0 }),
  };
  const app = express();
  app.use(createWebRouter(handlers, { prepare: () => ({ get: () => null, all: () => [] }) }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-copy-id`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-copy-agent-id/);
  assert.match(html, /data-copy-value="agent-copy-id"/);
  assert.match(html, /addEventListener\("dblclick"/);
  assert.match(html, /voko-copy-toast/);
  assert.match(html, /Agent ID 已复制/);
  const script = html.split('<script>').map((value) => value.split('</script>')[0]).find((value) => value.includes('data-copy-agent-id'));
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('empty conversation detail still renders the reply composer', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-empty-chat', agentName: 'Empty Chat', backendType: 'others', publishStatus: 'published' }] }),
    get_chat_history: async () => ({ messages: [] }),
    list_access_lists: async () => ({ data: [] }),
    agent_pricing: async () => ({}),
  };
  const app = express();
  app.use(createWebRouter(handlers, { prepare: () => ({ get: () => null, all: () => [] }) }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-empty-chat/c/visitor-empty?action=reply&focus=1`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /暂无消息/);
  assert.match(html, /id="reply"/);
  assert.match(html, /action="\/messages\/send"/);
  assert.match(html, /name="content"/);
  assert.match(html, /name="channelType" value="1"/);
});

test('conversation detail exposes an expand control for long text', async (t) => {
  const longText = '完整消息内容 '.repeat(80);
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-copy-id', agentName: 'Copy Test', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    get_chat_history: async () => ({ messages: [{ contentType: 1, content: longText, isMe: false, timestamp: 1 }] }),
    list_access_lists: async () => ({ data: [] }),
    agent_pricing: async () => ({}),
  };
  const app = express();
  app.use(createWebRouter(handlers, { prepare: () => ({ get: () => null, all: () => [] }) }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-copy-id/c/visitor-1`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-voko-expandable/);
  assert.match(html, /data-voko-message-preview/);
  assert.match(html, /data-voko-message-full hidden/);
  assert.match(html, /展开全文/);
});
