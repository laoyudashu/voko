const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const { ProviderConversationBindingStore } = require('../build/core/provider-conversation-bindings');
const { createDispatcher } = require('../build/core/dispatcher');
const { detectProviderSessionFromEnv } = require('../build/core/registration-caller-context');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-binding-'));
  const db = initDatabase(path.join(dir, 'voko.db'), { silent: true });
  const store = new ProviderConversationBindingStore(db);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, store };
}

function pending(store, session, message, channelId = 'visitor-1', channelType = 1) {
  return store.beginCallerBinding({
    agentId: 'agent-1', channelId, channelType,
    providerType: 'codex', providerInstanceId: 'codex-local',
    nativeSessionId: session, pendingMessageId: message,
    deliveryMode: 'mcp', adapterType: 'codex-cli',
  });
}

test('only stable provider session environment fields are accepted', () => {
  assert.equal(detectProviderSessionFromEnv('codex', { CODEX_THREAD_ID: 'thread-1' }), 'thread-1');
  assert.equal(detectProviderSessionFromEnv('claude-code', { CLAUDE_CODE_SESSION_ID: 'session-1' }), 'session-1');
  assert.equal(detectProviderSessionFromEnv('kiro', { KIRO_SESSION_ID: 'kiro-1' }), 'kiro-1');
  assert.equal(detectProviderSessionFromEnv('opencode', { OPENCODE_SESSION_ID: 'open-1' }), 'open-1');
  assert.equal(detectProviderSessionFromEnv('codex', { SESSION_ID: 'untrusted-latest-session' }), null);
});

test('successful caller sends activate atomically and the latest commit wins', (t) => {
  const { db, store } = fixture(t);
  const first = pending(store, 'thread-a', 'message-a');
  const second = pending(store, 'thread-b', 'message-b');
  assert.ok(first && second);

  const activeA = store.activatePending(first.id);
  const activeB = store.activatePending(second.id);
  assert.equal(activeA.bindingVersion, 1);
  assert.equal(activeB.bindingVersion, 2);
  assert.equal(store.getActive('agent-1', 'visitor-1', 1).nativeSessionId, 'thread-b');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_conversation_bindings WHERE status='active'").get().count, 1);
});

test('failed caller send leaves the existing binding unchanged', (t) => {
  const { store } = fixture(t);
  const first = pending(store, 'thread-a', 'message-a');
  store.activatePending(first.id);
  const failed = pending(store, 'thread-b', 'message-b');
  store.discardPending(failed.id);
  assert.equal(store.getActive('agent-1', 'visitor-1', 1).nativeSessionId, 'thread-a');
});

test('reusing one native session updates its delivery adapter without changing identity', (t) => {
  const { store } = fixture(t);
  const first = store.saveManaged({
    agentId: 'goose-agent', channelId: 'visitor', channelType: 1,
    providerType: 'goose', providerInstanceId: null, nativeSessionId: '20260806_1',
    deliveryMode: 'acp', adapterType: 'goose-acp', expectedVersion: 0,
  });
  const switched = store.saveManaged({
    agentId: 'goose-agent', channelId: 'visitor', channelType: 1,
    providerType: 'goose', providerInstanceId: null, nativeSessionId: '20260806_1',
    deliveryMode: 'cli', adapterType: 'goose-cli', expectedVersion: first.bindingVersion,
  });
  assert.equal(switched.id, first.id);
  assert.equal(switched.bindingVersion, first.bindingVersion);
  assert.equal(switched.deliveryMode, 'cli');
  assert.equal(switched.adapterType, 'goose-cli');
});

test('restart recovery activates sent candidates and discards failed candidates', (t) => {
  const { db, store } = fixture(t);
  const sent = pending(store, 'thread-sent', 'outbound-sent');
  const failed = pending(store, 'thread-failed', 'outbound-failed', 'visitor-2');
  const insertMessage = db.prepare(`INSERT INTO messages
    (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type)
    VALUES (?, 'agent', 'visitor', 'test', ?, 1, 'agent-1', ?, 1, ?, 1)`);
  insertMessage.run('outbound-sent', 'visitor-1', Date.now(), 'sent');
  insertMessage.run('outbound-failed', 'visitor-2', Date.now(), 'failed');

  const recovered = new ProviderConversationBindingStore(db).recoverPending();
  assert.deepEqual(recovered, { activated: 1, discarded: 1 });
  assert.equal(store.getActive('agent-1', 'visitor-1', 1).id, sent.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_conversation_bindings WHERE id=?').get(failed.id).count, 0);
});

test('one native session cannot become active for two VOKO conversations', (t) => {
  const { store } = fixture(t);
  const first = pending(store, 'thread-a', 'message-a');
  store.activatePending(first.id);
  assert.equal(pending(store, 'thread-a', 'message-b', 'visitor-2'), null);
  assert.equal(store.isActiveElsewhere({
    agentId: 'agent-1', channelId: 'visitor-2', channelType: 1,
    providerType: 'codex', providerInstanceId: 'codex-local', nativeSessionId: 'thread-a',
  }), true);
});

test('untrusted shell metacharacters cannot become a native session binding', (t) => {
  const { store } = fixture(t);
  assert.equal(pending(store, 'thread-ok & whoami', 'message-a'), null);
  assert.equal(pending(store, 'thread-ok\nforged', 'message-b'), null);
  assert.equal(store.getActive('agent-1', 'visitor-1', 1), null);
});

test('private and group channels with the same id remain isolated', (t) => {
  const { store } = fixture(t);
  store.activatePending(pending(store, 'thread-private', 'message-private', 'same-id', 1).id);
  store.activatePending(pending(store, 'thread-group', 'message-group', 'same-id', 2).id);
  assert.equal(store.getActive('agent-1', 'same-id', 1).nativeSessionId, 'thread-private');
  assert.equal(store.getActive('agent-1', 'same-id', 2).nativeSessionId, 'thread-group');
});

test('legacy handles import once and all subsequent writes use the new table', (t) => {
  const { db, store } = fixture(t);
  db.prepare(`INSERT INTO agent_session_handles
    (agent_id, visitor_id, adapter_type, session_handle, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('agent-1', 'visitor-1', 'acp', 'legacy-session', Date.now());
  const imported = store.importLegacy({
    agentId: 'agent-1', channelId: 'visitor-1', channelType: 1,
    providerType: 'zeroclaw', deliveryMode: 'acp', adapterType: 'acp',
  });
  assert.equal(imported.nativeSessionId, 'legacy-session');
  assert.equal(imported.sessionOrigin, 'voko_managed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_conversation_bindings').get().count, 1);
});

test('stale snapshots cannot overwrite a newer active binding', (t) => {
  const { store } = fixture(t);
  const old = store.saveManaged({
    agentId: 'agent-1', channelId: 'visitor-1', providerType: 'codex',
    nativeSessionId: 'managed-a', deliveryMode: 'cli', adapterType: 'codex-cli', expectedVersion: 0,
  });
  const newer = store.saveManaged({
    agentId: 'agent-1', channelId: 'visitor-1', providerType: 'codex',
    nativeSessionId: 'managed-b', deliveryMode: 'cli', adapterType: 'codex-cli', expectedVersion: old.bindingVersion,
  });
  const rejected = store.saveManaged({
    agentId: 'agent-1', channelId: 'visitor-1', providerType: 'codex',
    nativeSessionId: 'managed-stale', deliveryMode: 'cli', adapterType: 'codex-cli', expectedVersion: old.bindingVersion,
  });
  assert.equal(rejected.id, newer.id);
  assert.equal(store.getActive('agent-1', 'visitor-1', 1).nativeSessionId, 'managed-b');
});

test('messages queued before a rebind keep their original binding snapshot', async (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, created_at, updated_at,
     backend_type, backend_instance_id, delivery_modes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('row-1', 'agent-1', 'agent-im-1', 'token', 'ws://local', 'published', now, now,
      'codex', 'codex-local', JSON.stringify(['cli', 'pull']));
  const first = store.saveManaged({
    agentId: 'agent-1', channelId: 'visitor-1', providerType: 'codex',
    nativeSessionId: 'thread-a', deliveryMode: 'cli', adapterType: 'codex-cli', expectedVersion: 0,
  });

  const received = [];
  let releaseFirst;
  let signalFirst;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const dispatcher = createDispatcher({
    db,
    providers: {
      'codex-cli': {
        priority: 1,
        match: () => true,
        isAvailable: () => true,
        async push(payload) {
          received.push(payload.providerBinding?.nativeSessionId || null);
          if (received.length === 1) {
            signalFirst();
            await gate;
          }
        },
      },
    },
  });

  const payload = {
    agentId: 'agent-1', fromUid: 'visitor-1', channelId: 'visitor-1',
    content: 'hello', messageId: 'message-a',
  };
  dispatcher.dispatch('agent-1', payload);
  await firstStarted;
  store.saveManaged({
    agentId: 'agent-1', channelId: 'visitor-1', providerType: 'codex',
    nativeSessionId: 'thread-b', deliveryMode: 'cli', adapterType: 'codex-cli',
    expectedVersion: first.bindingVersion,
  });
  dispatcher.dispatch('agent-1', { ...payload, messageId: 'message-b', content: 'next' });
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(received, ['thread-a', 'thread-b']);
});

test('owner steer receives the active Provider binding snapshot', async (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, created_at, updated_at,
     backend_type, backend_instance_id, delivery_modes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('row-steer', 'agent-steer', 'agent-im-steer', 'token', 'ws://local', 'published', now, now,
      'codex', 'codex-local', JSON.stringify(['cli', 'pull']));
  store.saveManaged({
    agentId: 'agent-steer', channelId: 'visitor-1', channelType: 1,
    providerType: 'codex', providerInstanceId: 'codex-local', nativeSessionId: 'thread-owner',
    deliveryMode: 'cli', adapterType: 'codex-cli', expectedVersion: 0,
  });
  const received = [];
  const dispatcher = createDispatcher({
    db,
    providers: {
      'codex-cli': {
        priority: 1,
        match: () => true,
        isAvailable: () => true,
        async push() {},
        async steer(_agentId, _visitorId, _content, metadata) { received.push(metadata); },
      },
    },
  });

  await dispatcher.steer('agent-steer', 'visitor-1', 'owner reply');
  assert.equal(received.length, 1);
  assert.equal(received[0].providerBinding.nativeSessionId, 'thread-owner');
  assert.equal(received[0].channelId, 'visitor-1');
  assert.equal(received[0].channelType, 1);
});

test('cross-adapter routing never reuses an incompatible managed binding', async (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, created_at, updated_at,
     backend_type, backend_instance_id, delivery_modes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('row-switch', 'agent-switch', 'agent-im-switch', 'token', 'ws://local', 'published', now, now,
      'hermes', 'profile-switch', JSON.stringify(['cli', 'pull']));
  const binding = store.saveManaged({
    agentId: 'agent-switch', channelId: 'visitor-1', providerType: 'hermes',
    providerInstanceId: 'profile-switch', nativeSessionId: 'http-session',
    deliveryMode: 'http', adapterType: 'hermes-http', expectedVersion: 0,
  });
  const received = [];
  const dispatcher = createDispatcher({
    db,
    providers: {
      'hermes-cli': {
        priority: 1,
        match: () => true,
        isAvailable: () => true,
        _instanceForAgent: () => 'profile-switch',
        async push(payload) { received.push(payload.providerBinding); },
      },
    },
  });

  dispatcher.dispatch('agent-switch', {
    agentId: 'agent-switch', fromUid: 'visitor-1', channelId: 'visitor-1',
    content: 'hello', messageId: 'switch-message',
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(received, [null]);
  assert.equal(db.prepare('SELECT status FROM provider_conversation_bindings WHERE id=?').get(binding.id).status, 'stale');
});

test('provider compatibility hook permits a verified native session across adapters', async (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, created_at, updated_at,
     backend_type, delivery_modes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('row-goose', 'agent-goose', 'agent-im-goose', 'token', 'ws://local', 'published', now, now,
      'goose', JSON.stringify(['cli', 'pull']));
  store.saveManaged({
    agentId: 'agent-goose', channelId: 'visitor-1', providerType: 'goose',
    nativeSessionId: '20260806_1', deliveryMode: 'acp', adapterType: 'goose-acp', expectedVersion: 0,
  });
  const received = [];
  const dispatcher = createDispatcher({
    db,
    providers: {
      'goose-cli': {
        priority: 1, match: () => true, isAvailable: () => true,
        acceptsBinding: (binding) => binding.providerType === 'goose' && binding.adapterType === 'goose-acp',
        push: async (payload) => received.push(payload.providerBinding?.nativeSessionId || null),
      },
    },
  });
  dispatcher.dispatch('agent-goose', {
    agentId: 'agent-goose', fromUid: 'visitor-1', channelId: 'visitor-1', channelType: 1,
    content: 'hello', messageId: 'message-goose',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, ['20260806_1']);
  assert.equal(store.getActive('agent-goose', 'visitor-1', 1).status, 'active');
});

test('caller-origin binding is not mutated when the selected adapter differs', async (t) => {
  const { db, store } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, created_at, updated_at,
     backend_type, backend_instance_id, delivery_modes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('row-caller', 'agent-caller', 'agent-im-caller', 'token', 'ws://local', 'published', now, now,
      'hermes', 'profile-caller', JSON.stringify(['cli', 'pull']));
  const pendingBinding = store.beginCallerBinding({
    agentId: 'agent-caller', channelId: 'visitor-1', channelType: 1,
    providerType: 'hermes', providerInstanceId: 'profile-caller', nativeSessionId: 'caller-http-session',
    pendingMessageId: 'caller-pending', deliveryMode: 'http', adapterType: 'hermes-http',
  });
  const binding = store.activatePending(pendingBinding.id);
  const received = [];
  const dispatcher = createDispatcher({
    db,
    providers: {
      'hermes-cli': {
        priority: 1,
        match: () => true,
        isAvailable: () => true,
        _instanceForAgent: () => 'profile-caller',
        async push(payload) { received.push(payload.providerBinding); },
      },
    },
  });

  dispatcher.dispatch('agent-caller', {
    agentId: 'agent-caller', fromUid: 'visitor-1', channelId: 'visitor-1',
    content: 'hello', messageId: 'caller-message',
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(received, [null]);
  assert.equal(db.prepare('SELECT status FROM provider_conversation_bindings WHERE id=?').get(binding.id).status, 'active');
});

// ── invalidateForAgentConfigChange：按 Agent 配置变更失效绑定 ──

function managedBinding(db, { id, agentId, channelId, providerType, providerInstanceId, nativeSessionId }) {
  // 直接插一条 active 绑定，避免依赖 caller/pending 流程
  const now = Date.now();
  db.prepare(`
    INSERT INTO provider_conversation_bindings
      (id, agent_id, channel_id, channel_type, provider_type, provider_instance_id,
       delivery_mode, adapter_type, native_session_id, session_origin, status,
       binding_version, pending_message_id, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, 1, ?, ?, 'push', ?, ?, 'voko_managed', 'active', 1, NULL, ?, ?, ?)
  `).run(id, agentId, channelId, providerType, providerInstanceId, providerType, nativeSessionId, now, now, now);
}

test('invalidateForAgentConfigChange: 类型变化时该 Agent 全部 active/pending 绑定失效', (t) => {
  const { db, store } = fixture(t);
  managedBinding(db, { id: 'b1', agentId: 'agent-1', channelId: 'v1', providerType: 'hermes', providerInstanceId: 'p-a', nativeSessionId: 'sess-1' });
  managedBinding(db, { id: 'b2', agentId: 'agent-1', channelId: 'v2', providerType: 'openclaw', providerInstanceId: 'oc-1', nativeSessionId: 'sess-2' });

  const invalidated = store.invalidateForAgentConfigChange({
    agentId: 'agent-1', prevProviderType: 'hermes', prevInstanceId: 'p-a',
    nextProviderType: 'codex', nextInstanceId: null,
  });

  assert.equal(invalidated, 2);
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b1'").get().status, 'stale');
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b2'").get().status, 'stale');
  // stale 绑定不再被 getActive 返回（路由不会复用旧 session）
  assert.equal(store.getActive('agent-1', 'v1', 1), null);
  // 历史记录保留（行未删除，仅状态变化）
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM provider_conversation_bindings WHERE agent_id='agent-1'").get().c, 2);
});

test('invalidateForAgentConfigChange: 仅实例变化时只失效旧实例绑定', (t) => {
  const { db, store } = fixture(t);
  managedBinding(db, { id: 'b1', agentId: 'agent-1', channelId: 'v1', providerType: 'hermes', providerInstanceId: 'p-a', nativeSessionId: 'sess-1' });
  managedBinding(db, { id: 'b2', agentId: 'agent-1', channelId: 'v2', providerType: 'hermes', providerInstanceId: 'p-b', nativeSessionId: 'sess-2' });

  const invalidated = store.invalidateForAgentConfigChange({
    agentId: 'agent-1', prevProviderType: 'hermes', prevInstanceId: 'p-a',
    nextProviderType: 'hermes', nextInstanceId: 'p-b',
  });

  assert.equal(invalidated, 1);
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b1'").get().status, 'stale');
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b2'").get().status, 'active');
});

test('invalidateForAgentConfigChange: 不影响其他 Agent 的绑定', (t) => {
  const { db, store } = fixture(t);
  managedBinding(db, { id: 'b1', agentId: 'agent-1', channelId: 'v1', providerType: 'hermes', providerInstanceId: 'p-a', nativeSessionId: 'sess-1' });
  managedBinding(db, { id: 'b2', agentId: 'agent-2', channelId: 'v1', providerType: 'hermes', providerInstanceId: 'p-a', nativeSessionId: 'sess-2' });

  const invalidated = store.invalidateForAgentConfigChange({
    agentId: 'agent-1', prevProviderType: 'hermes', prevInstanceId: 'p-a',
    nextProviderType: 'codex', nextInstanceId: null,
  });

  assert.equal(invalidated, 1);
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b1'").get().status, 'stale');
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='b2'").get().status, 'active');
});

test('invalidateForAgentConfigChange: 类型与实例都没变时返回 0', (t) => {
  const { store } = fixture(t);
  const invalidated = store.invalidateForAgentConfigChange({
    agentId: 'agent-1', prevProviderType: 'hermes', prevInstanceId: 'p-a',
    nextProviderType: 'hermes', nextInstanceId: 'p-a',
  });
  assert.equal(invalidated, 0);
});
