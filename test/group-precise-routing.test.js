const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const { MessageRouteStore, RoutingConversationStore } = require('../build/core/provider-routing');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-group-route-'));
  const db = initDatabase(path.join(dir, 'test.db'), { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,backend_type,backend_instance_id,publish_status,access_mode,owner_email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('1', 'agent-a', 'agent-im-a', 'tok', 'ws://fake', 'codex', 'instance-a', 'published', 'public', 'a@example.com', now, now);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function inbound(replyToRouteId, routeId = 'remote-route-12345678901234567890') {
  return {
    fromUid: 'member-b', toUid: 'group-1', channelId: 'group-1', channelType: 2,
    contentType: 1, content: 'reply', messageId: `in-${Math.random()}`, timestamp: 1,
    mention: { uids: ['agent-im-a'] },
    _voko: { protocolVersion: 1, routeId, ...(replyToRouteId ? { replyToRouteId } : {}) },
  };
}

test('an unthreaded mention uses the only active group conversation', async (t) => {
  const db = fixture(t);
  const conversation = new RoutingConversationStore(db).resolveOrCreate({
    agentId: 'agent-a', providerFamily: 'codex', providerInstanceKey: 'instance-a',
    nativeSessionId: 'session-a', channelId: 'group-1', channelType: 2,
  });
  const forwarded = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (_agentId, payload) => forwarded.push(payload) },
    getGroupInfo: async () => ({ status: 'active', members: [
      { uid: 'member-b', role: 'member' }, { uid: 'agent-im-a', role: 'member' },
    ] }),
  });
  handler.handleAgentMessage('agent-a', inbound(null));
  await settle();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].routeState, 'valid');
  assert.equal(forwarded[0].replyRouteContext.conversationId, conversation.id);
});

test('an unthreaded mention with multiple conversations waits for an MCP session claim', async (t) => {
  const db = fixture(t);
  const conversations = new RoutingConversationStore(db);
  conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
    nativeSessionId: 'session-a', channelId: 'group-1', channelType: 2 });
  conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
    nativeSessionId: 'session-b', channelId: 'group-1', channelType: 2 });
  const forwarded = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (_agentId, payload) => forwarded.push(payload) },
    getGroupInfo: async () => ({ status: 'active', members: [
      { uid: 'member-b', role: 'member' }, { uid: 'agent-im-a', role: 'member' },
    ] }),
  });
  handler.handleAgentMessage('agent-a', inbound(null));
  await settle();
  assert.equal(forwarded.length, 0);
});

async function settle() { await new Promise((resolve) => setTimeout(resolve, 25)); }

test('a valid group reply route restores the exact native session', async (t) => {
  const db = fixture(t);
  const conversation = new RoutingConversationStore(db).resolveOrCreate({
    agentId: 'agent-a', providerFamily: 'codex', providerInstanceKey: 'instance-a',
    nativeSessionId: 'session-a', channelId: 'group-1', channelType: 2,
  });
  const routes = new MessageRouteStore(db);
  const replyToRouteId = routes.createPending({ messageId: 'out-a', conversationId: conversation.id,
    agentId: 'agent-a', peerUid: 'group-1', channelId: 'group-1', channelType: 2, direction: 'outbound' });
  routes.setStatus(replyToRouteId, 'active');
  const forwarded = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (_agentId, payload) => forwarded.push(payload) },
    getGroupInfo: async () => ({ status: 'active', members: [
      { uid: 'member-b', role: 'member' }, { uid: 'agent-im-a', role: 'member' },
    ] }),
  });
  handler.handleAgentMessage('agent-a', inbound(replyToRouteId));
  await settle();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].routeState, 'valid');
  assert.equal(forwarded[0].replyRouteContext.nativeSessionId, 'session-a');
  assert.equal(forwarded[0].replyRouteContext.conversationId, conversation.id);
});

test('a present but invalid group route fails closed and cannot enter Pull', async (t) => {
  const db = fixture(t);
  const forwarded = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (_agentId, payload) => forwarded.push(payload) },
    getGroupInfo: async () => ({ status: 'active', members: [
      { uid: 'member-b', role: 'member' }, { uid: 'agent-im-a', role: 'member' },
    ] }),
  });
  const message = inbound('missing-route-12345678901234567890');
  handler.handleAgentMessage('agent-a', message);
  await settle();
  assert.equal(forwarded.length, 0);
  const route = db.prepare(`SELECT status FROM provider_message_routes
    WHERE message_id=? AND agent_id=? AND direction='inbound'`).get(message.messageId, 'agent-a');
  assert.equal(route.status, 'invalid');
});

test('membership lookup failure makes an otherwise valid group route fail closed', async (t) => {
  const db = fixture(t);
  const conversation = new RoutingConversationStore(db).resolveOrCreate({
    agentId: 'agent-a', providerFamily: 'codex', nativeSessionId: 'session-a',
    channelId: 'group-1', channelType: 2,
  });
  const routes = new MessageRouteStore(db);
  const replyToRouteId = routes.createPending({ messageId: 'out-a', conversationId: conversation.id,
    agentId: 'agent-a', peerUid: 'group-1', channelId: 'group-1', channelType: 2, direction: 'outbound' });
  routes.setStatus(replyToRouteId, 'active');
  const forwarded = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (_agentId, payload) => forwarded.push(payload) },
    getGroupInfo: async () => { throw new Error('offline'); },
  });
  handler.handleAgentMessage('agent-a', inbound(replyToRouteId));
  await settle();
  assert.equal(forwarded.length, 0);
});
