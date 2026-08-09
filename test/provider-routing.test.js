'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initDatabase, SCHEMA_VERSION } = require('../build/core/database');
const { AgentIdentityBindingStore, MessageRouteStore, RoutingConversationStore,
  fingerprintProviderSession, getRoutingFeaturePolicy, isRoutingPolicyEligible } = require('../build/core/provider-routing');

function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-routing-'));
  const dbPath = path.join(dir, 'voko.db');
  const db = initDatabase(dbPath, { silent: true });
  return { db, dbPath, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('schema 8 creates additive provider routing tables and a private HMAC key', () => {
  const fixture = database();
  try {
    assert.equal(SCHEMA_VERSION, 8);
    assert.equal(fixture.db.prepare('PRAGMA user_version').get().user_version, 8);
    for (const name of ['provider_agent_identity_bindings', 'provider_routing_conversations', 'provider_message_routes']) {
      assert.ok(fixture.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    }
    const key = fixture.db.prepare("SELECT data FROM config WHERE type='provider_session_hmac_key_v1'").get();
    assert.equal(Buffer.from(JSON.parse(key.data), 'base64').length, 32);
  } finally { fixture.close(); }
});

test('v7 upgrade is backed up and schema 8 migration is idempotent', () => {
  const fixture = database();
  const dbPath = fixture.dbPath;
  fixture.db.exec('PRAGMA user_version=7');
  fixture.db.prepare("DELETE FROM config WHERE type='provider_session_hmac_key_v1'").run();
  fixture.db.close();
  const upgraded = initDatabase(dbPath, { silent: true });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 8);
    assert.ok(fs.existsSync(`${dbPath}.pre-schema-v8.bak`));
    upgraded.close();
    const reopened = initDatabase(dbPath, { silent: true });
    assert.equal(reopened.prepare("SELECT COUNT(*) AS c FROM config WHERE type='provider_session_hmac_key_v1'").get().c, 1);
    reopened.close();
  } finally { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); }
});

test('routing conversation is stable per session and peer, and isolated across either dimension', () => {
  const fixture = database();
  try {
    const store = new RoutingConversationStore(fixture.db);
    const base = { agentId: 'agent-a', providerFamily: 'codex', providerInstanceKey: 'home',
      nativeSessionId: 'thread-a', channelId: 'peer-a', channelType: 1, origin: 'caller' };
    const first = store.resolveOrCreate(base);
    assert.equal(store.resolveOrCreate(base).id, first.id);
    assert.notEqual(store.resolveOrCreate({ ...base, nativeSessionId: 'thread-b' }).id, first.id);
    assert.notEqual(store.resolveOrCreate({ ...base, channelId: 'peer-b' }).id, first.id);
    assert.notEqual(store.resolveOrCreate({ ...base, channelType: 2 }).id, first.id);
    assert.notEqual(first.nativeSessionFingerprint, first.nativeSessionId);
  } finally { fixture.close(); }
});

test('message reply route validates agent, peer, channel, direction and expiry', () => {
  const fixture = database();
  try {
    const conversations = new RoutingConversationStore(fixture.db);
    const routes = new MessageRouteStore(fixture.db);
    const conversation = conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
      nativeSessionId: 'thread-a', channelId: 'peer-a', channelType: 1, origin: 'caller' });
    const routeId = routes.createPending({ messageId: 'out-1', conversationId: conversation.id,
      agentId: 'agent-a', peerUid: 'peer-a', channelId: 'peer-a', channelType: 1, direction: 'outbound' });
    routes.setStatus(routeId, 'active');
    assert.equal(routes.resolveReply({ replyToRouteId: routeId, agentId: 'agent-a', peerUid: 'peer-a',
      channelId: 'peer-a', channelType: 1 }).conversation.nativeSessionId, 'thread-a');
    assert.equal(routes.resolveReply({ replyToRouteId: routeId, agentId: 'agent-b', peerUid: 'peer-a',
      channelId: 'peer-a', channelType: 1 }), null);
    assert.equal(routes.resolveReply({ replyToRouteId: routeId, agentId: 'agent-a', peerUid: 'peer-b',
      channelId: 'peer-a', channelType: 1 }), null);
    fixture.db.prepare('UPDATE provider_message_routes SET expires_at=? WHERE route_id=?').run(0, routeId);
    assert.equal(routes.resolveReply({ replyToRouteId: routeId, agentId: 'agent-a', peerUid: 'peer-a',
      channelId: 'peer-a', channelType: 1 }), null);
  } finally { fixture.close(); }
});

test('unbound inbound route preserves the remote route id until a local conversation exists', () => {
  const fixture = database();
  try {
    const routes = new MessageRouteStore(fixture.db);
    const remoteRouteId = 'remote-route-1234567890123456';
    routes.recordInbound({ messageId: 'in-1', remoteRouteId, agentId: 'agent-a',
      peerUid: 'peer-a', channelId: 'peer-a', channelType: 1 });
    let row = routes.getByMessage('in-1');
    assert.equal(row.conversation_id, null);
    assert.equal(row.reply_to_route_id, remoteRouteId);
    const conversation = new RoutingConversationStore(fixture.db).resolveOrCreate({ agentId: 'agent-a',
      providerFamily: 'codex', nativeSessionId: 'thread-a', channelId: 'peer-a', origin: 'caller' });
    routes.recordInbound({ messageId: 'in-1', remoteRouteId, conversationId: conversation.id,
      agentId: 'agent-a', peerUid: 'peer-a', channelId: 'peer-a', channelType: 1 });
    row = routes.getByMessage('in-1');
    assert.equal(row.conversation_id, conversation.id);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS c FROM provider_message_routes WHERE message_id='in-1'").get().c, 1);
    assert.throws(() => routes.recordInbound({ messageId: 'in-1', remoteRouteId,
      agentId: 'agent-a', peerUid: 'peer-b', channelId: 'peer-a', channelType: 1 }), /scope conflict/);
    assert.throws(() => routes.recordInbound({ messageId: 'in-2', remoteRouteId: 'short',
      agentId: 'agent-a', peerUid: 'peer-a', channelId: 'peer-a', channelType: 1 }), /invalid/);
  } finally { fixture.close(); }
});

test('identity binding allows shared instances and resolves only exact trusted sessions', () => {
  const fixture = database();
  try {
    const store = new AgentIdentityBindingStore(fixture.db);
    store.bind({ agentId: 'agent-a', providerFamily: 'codex', providerInstanceKey: 'shared',
      nativeSessionId: 'thread-a', evidenceType: 'provider_env' });
    store.bind({ agentId: 'agent-b', providerFamily: 'codex', providerInstanceKey: 'shared',
      nativeSessionId: 'thread-b', evidenceType: 'provider_env' });
    assert.deepEqual(store.resolve('codex', 'shared', 'thread-a'), ['agent-a']);
    assert.deepEqual(store.resolve('codex', 'shared', 'thread-b'), ['agent-b']);
    assert.deepEqual(store.resolve('codex', 'shared', 'thread-c'), []);
    assert.equal(fingerprintProviderSession(fixture.db, 'codex', 'thread-a').length, 64);
  } finally { fixture.close(); }
});

test('precise routing policy is limited to configured provider, channel, and content allowlists', () => {
  const fixture = database();
  try {
    assert.equal(isRoutingPolicyEligible(fixture.db, 'precise_reply_routing_v1', {
      providerFamily: 'codex', channelType: 1, contentType: 1,
    }), false);
    const policy = { enabled: true, providerFamilies: ['codex', 'claude-code', 'opencode', 'kiro'],
      channelTypes: [1], contentTypes: [1] };
    fixture.db.prepare('INSERT INTO config (type,data,updated_at) VALUES (?,?,?)')
      .run('feature:precise_reply_routing_v1', JSON.stringify(policy), Date.now());
    assert.equal(getRoutingFeaturePolicy(fixture.db, 'precise_reply_routing_v1').enabled, true);
    assert.equal(isRoutingPolicyEligible(fixture.db, 'precise_reply_routing_v1', {
      providerFamily: 'codex', channelType: 1, contentType: 1,
    }), true);
    assert.equal(isRoutingPolicyEligible(fixture.db, 'precise_reply_routing_v1', {
      providerFamily: 'goose', channelType: 1, contentType: 1,
    }), false);
    assert.equal(isRoutingPolicyEligible(fixture.db, 'precise_reply_routing_v1', {
      providerFamily: 'codex', channelType: 2, contentType: 1,
    }), false);
    assert.equal(isRoutingPolicyEligible(fixture.db, 'precise_reply_routing_v1', {
      providerFamily: 'codex', channelType: 1, contentType: 2,
    }), false);
  } finally { fixture.close(); }
});
