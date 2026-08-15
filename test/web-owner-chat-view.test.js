'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const { createWebRouter } = require('../build/web');
const {initOwnerChatSchema}=require('../build/owner-chat');

const db = { prepare: () => ({ get: () => null, all: () => [] }) };
const handlers = {
  list_agents: async () => ({ agents: [
    { agentId: 'owner-agent-a', agentName: 'Owner Agent A', backendType: 'others', publishStatus: 'published' },
    { agentId: 'owner-agent-b', agentName: 'Owner Agent B', backendType: 'others', publishStatus: 'published' },
  ] }),
  get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
  list_conversations: async () => ({ conversations: [], total: 0 }),
  list_groups: async () => ({ groups: [], total: 0 }),
};

async function startApp(t, ownerChatReadStore, ownerChatDatabase=null) {
  const app = express();
  app.use(express.json());app.use(createWebRouter(handlers, db, { ownerChatReadStore,ownerChatDatabase,trustedRemoteEnabled:true }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('trusted remote policy API keeps host access disabled and renders local controls',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-policy-web-'));const ownerDb=new DatabaseSync(path.join(dir,'db.sqlite'));initOwnerChatSchema(ownerDb);t.after(()=>{ownerDb.close();fs.rmSync(dir,{recursive:true,force:true})});const base=await startApp(t,{countForAgent:()=>0,listForAgent:()=>[],getTranscript:()=>[]},ownerDb);const page=await fetch(`${base}/trusted-remote`);const html=await page.text();assert.match(html,/data-policy="ownerChatEnabled"/);assert.match(html,/data-policy="remoteExecutionEnabled"/);const response=await fetch(`${base}/api/owner-chat/policy`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({remoteExecutionEnabled:true,hostFullAccessEnabled:true})});assert.equal(response.status,200);const data=await response.json();assert.equal(data.data.remoteExecutionEnabled,true);assert.equal(data.data.hostFullAccessEnabled,false)});

test('owner chat tab is hidden until an Agent has a real owner message', async t => {
  const base = await startApp(t, {
    countForAgent: () => 0,
    listForAgent: () => [],
    getTranscript: () => [],
  });
  const response = await fetch(`${base}/agents/owner-agent-a`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /data-tab="owner"/);
  assert.match(html, /owner-chat:updated/);
  assert.doesNotMatch(html, /setInterval/);
});

test('owner chat tab links directly to the single trusted conversation', async t => {
  const base = await startApp(t, {
    countForAgent: agentId => agentId === 'owner-agent-a' ? 1 : 0,
    listForAgent: () => [{
      conversationId: 'owner-conversation-1', lastMessage: 'Trusted hello',
      lastDirection: 'owner', status: 'processing', lastActivityAt: Date.now(),
    }],
    getTranscript: () => [],
  });
  const page = await fetch(`${base}/agents/owner-agent-a`);
  const html = await page.text();
  assert.doesNotMatch(html, /data-tab="owner"/);
  assert.match(html, /主人会话 \(1\)/);
  assert.match(html, /\/agents\/owner-agent-a\/owner-chats\/owner-conversation-1/);
  assert.doesNotMatch(html, /ownerImUid|nativeSessionId|signature/);
  assert.doesNotMatch(html, /<form[^>]+owner-chat/i);
  const response = await fetch(`${base}/agents/owner-agent-a?tab=owner`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/agents/owner-agent-a/owner-chats/owner-conversation-1');
});

test('owner chat detail renders safe bubbles without a composer and enforces Agent scope', async t => {
  const readStore = {
    countForAgent: () => 1,
    listForAgent: () => [],
    getTranscript: (agentId, conversationId) => agentId === 'owner-agent-a' && conversationId === 'owner-conversation-1' ? [
      { direction: 'owner', sequence: 1, contentType: 1, state: 'accepted', createdAt: Date.now(), payload: { text: 'Owner instruction' } },
      { direction: 'agent', sequence: 1, contentType: 3, state: 'sent', createdAt: Date.now(), payload: { text: 'Done', name: 'result.txt', size: 12, mimeType: 'text/plain', downloadUrl: 'https://files.vokovoko.com/result.txt' } },
    ] : [],
  };
  const base = await startApp(t, readStore);
  const response = await fetch(`${base}/agents/owner-agent-a/owner-chats/owner-conversation-1`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<strong>主人<\/strong>/);
  assert.match(html, /Owner instruction/);
  assert.match(html, /result\.txt/);
  assert.match(html, /owner-chat-detail/);
  assert.match(html, /id="msg-box"/);
  assert.match(html, /<h2[^>]*>操作<\/h2><div class="ops"><a href="\/trusted-remote" class="op-card"/);
  assert.match(html, /可信远程链接/);
  assert.doesNotMatch(html, /action="\/messages\/send"|name="content"|type="file"/);

  const fragment = await fetch(`${base}/agents/owner-agent-a/owner-chats/owner-conversation-1?fragment=owner-chat`);
  const fragmentHtml = await fragment.text();
  assert.equal(fragment.status, 200);
  assert.match(fragmentHtml, /^<section class="owner-chat-detail"/);
  assert.doesNotMatch(fragmentHtml, /<!DOCTYPE html>|<nav/);

  const crossAgent = await fetch(`${base}/agents/owner-agent-b/owner-chats/owner-conversation-1`);
  assert.equal(crossAgent.status, 404);
});
