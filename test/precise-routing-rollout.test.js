'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initDatabase } = require('../build/core/database');
const { createDispatcher } = require('../build/core/dispatcher');

function fixture(t, backendType, deliveryModes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-routing-rollout-'));
  const db = initDatabase(path.join(dir, 'voko.db'), { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('row-1', 'agent-1', 'agent-uid', 'token', 'http://im', 'published',
      backendType, JSON.stringify(deliveryModes), 'private', now, now);
  const policy = JSON.stringify({ enabled: true,
    providerFamilies: ['codex', 'claude-code', 'opencode', 'kiro'], channelTypes: [1], contentTypes: [1] });
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('feature:precise_reply_routing_v1', policy, now);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function candidate(providerFamily) {
  return { strictSessionRoute: true, conversationId: 'conversation-1', providerFamily,
    providerInstanceKey: '', nativeSessionId: 'native-session-1' };
}

function provider(name, calls, failure) {
  return { priority: name.endsWith('acp') ? 100 : 10, match: () => true, isAvailable: () => true,
    canRestoreExactSession: async (binding) => !!binding?.nativeSessionId,
    async push(payload) {
      calls.push({ name, binding: payload.providerBinding });
      if (failure) throw failure;
    } };
}

function enableGroupExact(db, providerFamilies = ['codex']) {
  const policy = JSON.stringify({ enabled: true, providerFamilies, channelTypes: [2], contentTypes: [1] });
  db.prepare(`INSERT INTO config(type,data,updated_at) VALUES(?,?,?)
    ON CONFLICT(type) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
    .run('feature:precise_group_reply_routing_v1', policy, Date.now());
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 25)); }

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test('precise routing injects a strict native session only for allowlisted private text', async (t) => {
  const db = fixture(t, 'codex', ['cli', 'pull']);
  const calls = [];
  const dispatcher = createDispatcher({ db, providers: { 'codex-cli': provider('codex-cli', calls) } });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'peer-1', channelId: 'peer-1', channelType: 1,
    contentType: 1, content: 'reply', messageId: 'm1', replyRouteContext: candidate('codex') });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binding.strictSessionRoute, true);
  assert.equal(calls[0].binding.nativeSessionId, 'native-session-1');
  assert.equal(dispatcher.getRoutingStats()['precise_hit:codex'], 1);
});

test('precise routing leaves group and non-allowlisted providers on the compatibility path', async (t) => {
  const db = fixture(t, 'codex', ['cli', 'pull']);
  const calls = [];
  const dispatcher = createDispatcher({ db, providers: { 'codex-cli': provider('codex-cli', calls) } });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'group:peer-1', channelId: 'peer-1', channelType: 2,
    contentType: 1, content: 'group', messageId: 'm2', replyRouteContext: candidate('codex') });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'peer-1', channelId: 'peer-1', channelType: 1,
    contentType: 1, content: 'goose', messageId: 'm3', replyRouteContext: candidate('goose') });
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.binding == null), true);
  assert.equal(dispatcher.getRoutingStats()['precise_rejected:codex'], 1);
  assert.equal(dispatcher.getRoutingStats()['precise_rejected:goose'], 1);
});

test('group exact routing is enabled only by the dedicated group policy', async (t) => {
  const db = fixture(t, 'codex', ['cli', 'pull']);
  enableGroupExact(db);
  const calls = [];
  const dispatcher = createDispatcher({ db, providers: { 'codex-cli': provider('codex-cli', calls) } });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'group:peer-1', senderUid: 'peer-1',
    channelId: 'peer-1', channelType: 2, contentType: 1, content: 'group', messageId: 'm-group',
    replyRouteContext: candidate('codex') });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binding.strictSessionRoute, true);
  assert.equal(calls[0].binding.nativeSessionId, 'native-session-1');
});

test('ACP failure falls back once while retaining the same strict native session', async (t) => {
  const db = fixture(t, 'opencode', ['acp', 'cli', 'pull']);
  const calls = [];
  const unavailable = new Error('ACP unavailable');
  unavailable.deliveryOutcome = 'not_delivered';
  const dispatcher = createDispatcher({ db, providers: {
    'opencode-acp': provider('opencode-acp', calls, unavailable),
    'opencode-cli': provider('opencode-cli', calls),
  } });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'peer-1', channelId: 'peer-1', channelType: 1,
    contentType: 1, content: 'reply', messageId: 'm4', replyRouteContext: candidate('opencode') });
  assert.equal(await waitFor(() => calls.length === 2), true, 'expected ACP failure to reach the CLI fallback');
  assert.deepEqual(calls.map((call) => call.name), ['opencode-acp', 'opencode-cli']);
  assert.equal(calls.every((call) => call.binding?.nativeSessionId === 'native-session-1'), true);
  assert.equal(calls.every((call) => call.binding?.strictSessionRoute === true), true);
});

test('an incompatible provider instance is not invoked and precise delivery falls back to Pull', async (t) => {
  const db = fixture(t, 'opencode', ['acp', 'pull']);
  const calls = [];
  const acp = provider('opencode-acp', calls);
  acp.getInstanceId = () => 'different-instance';
  const dispatcher = createDispatcher({ db, providers: { 'opencode-acp': acp } });
  const route = { ...candidate('opencode'), providerInstanceKey: 'required-instance' };
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'peer-1', channelId: 'peer-1', channelType: 1,
    contentType: 1, content: 'reply', messageId: 'm5', replyRouteContext: route });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(dispatcher.getRoutingStats().precise_fallback_pull, 1);
});
