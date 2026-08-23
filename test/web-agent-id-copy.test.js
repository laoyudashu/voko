'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebRouter } = require('../build/web');

test('agent detail exposes the shared icon copy control for the Agent ID', async (t) => {
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
  assert.match(html, /class="voko-copy-button"/);
  assert.match(html, /data-voko-copy-value="agent-copy-id"/);
  assert.match(html, /window\.vokoCopyText/);
  assert.match(html, /classList\.add\("is-copied"\)/);
  const script = html.split('<script>').map((value) => value.split('</script>')[0]).find((value) => value.includes('__VOKO_COPY_READY__'));
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('agent detail truncates long visitor names and keeps the full name in a tooltip', async (t) => {
  const visitorName = '这是一个很长的访客名称用于验证列表截断效果';
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-visitor-name', agentName: 'Visitor Name Test', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [{ channelId: 'visitor-long', name: visitorName, lastMessage: 'hello', lastTimestamp: 1, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 }], total: 1 }),
    list_groups: async () => ({ groups: [], total: 0 }),
  };
  const app = express();
  app.use(createWebRouter(handlers, { prepare: () => ({ get: () => null, all: () => [] }) }, { refreshUserProfiles: async () => {} }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-visitor-name`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`title="${visitorName}"`));
  assert.match(html, /display:inline-block;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.match(html, /width:180px;max-width:180px;white-space:nowrap;overflow:hidden/);
});

test('agent detail renders authoritative E2EE conversation key states', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-e2ee', agentName: 'E2EE Test', backendType: 'others', publishStatus: 'published' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [
      { channelId: 'visitor-secure', name: 'Secure visitor', lastMessage: 'hello', lastTimestamp: 2, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 },
      { channelId: 'visitor-available', name: 'Available visitor', lastMessage: 'hello', lastTimestamp: 2, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 },
      { channelId: 'visitor-checking', name: 'Checking visitor', lastMessage: 'hello', lastTimestamp: 2, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 },
      { channelId: 'visitor-error', name: 'Error visitor', lastMessage: 'hello', lastTimestamp: 2, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 },
      { channelId: 'visitor-plain', name: 'Plain visitor', lastMessage: 'hello', lastTimestamp: 1, lastIsMe: 0, lastContentType: 1, needsReply: true, unreadCount: 0 },
    ], total: 5 }),
    list_groups: async () => ({ groups: [], total: 0 }),
  };
  const app = express();
  app.use(createWebRouter(handlers, { prepare: () => ({ get: () => null, all: () => [] }) }, {
    refreshUserProfiles: async () => {},
    e2eeRuntime: {
      isChannelActive: (_agentId, channelId) => channelId === 'visitor-secure',
      getChannelEncryptionStatuses: async () => ({
        'visitor-secure':'active','visitor-available':'available','visitor-checking':'checking',
        'visitor-error':'error','visitor-plain':'unsupported'
      })
    },
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-e2ee`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal((html.match(/aria-label="端到端加密已启用"/g) || []).length, 1);
  assert.equal((html.match(/aria-label="双方支持端到端加密，尚未启用"/g) || []).length, 1);
  assert.equal((html.match(/aria-label="正在检测或建立端到端加密"/g) || []).length, 1);
  assert.equal((html.match(/aria-label="端到端加密异常，请在访客端重试"/g) || []).length, 1);
  assert.match(html, /attributeName="opacity" values="1;.25;1"/);
  assert.match(html, /Secure visitor<\/a> <svg role="img"/);
  assert.doesNotMatch(html, /Plain visitor<\/a> <svg role="img"/);
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
