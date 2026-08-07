'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');
const HermesHttpProvider = require('../build/core/dispatcher/providers/hermes-http');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');
const { GooseAcpProvider } = require('../build/core/dispatcher/providers/goose-acp');

function dbWithHistory() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_me INTEGER NOT NULL,
      content_type INTEGER NOT NULL,
      agent_id TEXT NOT NULL
    );
    INSERT INTO messages VALUES
      ('m1', 'visitor-a', 1, 'remembered fact', 1, 0, 1, 'agent-a');
  `);
  return db;
}

const basePayload = {
  agentId: 'agent-a',
  fromUid: 'visitor-a',
  content: 'first message',
  channelType: 1,
};

test('AcpAdapter steer reuses push and preserves the owner turnId', async () => {
  const sent = [];
  class TestAcpProvider extends AcpAdapter {
    async push(payload) {
      sent.push(payload);
    }
  }
  const provider = new TestAcpProvider({ name: 'TEST ACP' });
  await provider.steer('agent-a', 'visitor-a', 'owner reply', { turnId: 'turn-owner-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, 'agent-a');
  assert.equal(sent[0].fromUid, 'visitor-a');
  assert.equal(sent[0].content, 'owner reply');
  assert.equal(sent[0].messageId, 'turn-owner-1');
  assert.equal(sent[0].turnId, 'turn-owner-1');
  assert.equal(sent[0].channelId, 'visitor-a');
  assert.equal(sent[0].channelType, 1);
  assert.equal(sent[0].providerBinding, null);
  await provider.steer('agent-a', 'group:group-1', 'group owner reply', {
    turnId: 'turn-group-1', channelType: 2, channelId: 'group-1',
  });
  assert.equal(sent[1].fromUid, 'group:group-1');
  assert.equal(sent[1].sessionTarget, 'group:group-1');
  assert.equal(sent[1].channelType, 2);
});

test('Goose ACP inherits the common owner steer implementation', async () => {
  const sent = [];
  const provider = new GooseAcpProvider({ binPath: 'goose' });
  provider.push = async payload => sent.push(payload);
  await provider.steer('agent-goose', 'visitor-a', 'owner reply', { turnId: 'goose-turn-1' });
  assert.equal(sent[0].turnId, 'goose-turn-1');
  assert.equal(sent[0].fromUid, 'visitor-a');
});

function binding(providerType, deliveryMode, adapterType, nativeSessionId) {
  return {
    id: `${providerType}-binding`, bindingVersion: 1, providerType,
    providerInstanceId: null, deliveryMode, adapterType, nativeSessionId,
    sessionOrigin: 'voko_managed', channelId: 'visitor-a', channelType: 1,
  };
}

test('OpenClaw sends history only when no resumable binding is available', async () => {
  const db = dbWithHistory();
  const provider = new OpenClawWsProvider(db, null);
  const sent = [];
  try {
    provider.sendToSession = async (_sessionKey, prompt) => sent.push(prompt);
    await provider.push(basePayload);
    const providerBinding = binding('openclaw', 'websocket', 'openclaw-ws', 'agent:agent-a:visitor-a');
    await provider.push({ ...basePayload, content: 'second message', providerBinding });
    await provider.push({ ...basePayload, content: 'after reconnect', providerBinding });
    await provider.push({ ...basePayload, content: 'after failed resume', providerBinding: null });

    assert.match(sent[0], /remembered fact/);
    assert.equal(sent[1], 'second message');
    assert.equal(sent[2], 'after reconnect');
    assert.match(sent[3], /remembered fact/);
  } finally {
    provider.destroy();
    db.close();
  }
});

test('Hermes sends history only when no resumable binding is available', async () => {
  const db = dbWithHistory();
  const provider = new HermesHttpProvider(db, null);
  const sent = [];
  try {
    provider.sendToSession = async (_sessionKey, prompt) => sent.push(prompt);
    await provider.push(basePayload);
    const providerBinding = binding('hermes', 'http', 'hermes-http', 'hermes:agent-a:visitor-a');
    await provider.push({ ...basePayload, content: 'second message', providerBinding });
    await provider.push({ ...basePayload, content: 'after reconnect', providerBinding });
    await provider.push({ ...basePayload, content: 'after failed resume', providerBinding: null });

    assert.match(sent[0], /remembered fact/);
    assert.equal(sent[1], 'second message');
    assert.equal(sent[2], 'after reconnect');
    assert.match(sent[3], /remembered fact/);
  } finally {
    db.close();
  }
});

test('ACP restores only when its session is newly created', async () => {
  const db = dbWithHistory();
  try {
    const adapter = new AcpAdapter({ db });
    const prompts = [];
    const session = {
      sessionId: 'session-a',
      prompt: async (prompt) => { prompts.push(prompt); },
      nextUpdate: async () => ({ kind: 'stop' }),
      dispose() {},
    };
    const state = { sessions: new Map() };
    let created = false;
    adapter._ensureAgent = async () => state;
    adapter._ensureSession = async () => {
      if (!created) {
        created = true;
        adapter._recoveryNeededSessions.add('acp:agent-a:visitor-a');
      }
      return session;
    };

    await adapter._pushViaAcp(basePayload);
    await adapter._pushViaAcp({ ...basePayload, content: 'second message' });

    assert.match(prompts[0], /remembered fact/);
    assert.equal(prompts[1], '【外部消息】\nsecond message');
  } finally {
    db.close();
  }
});

test('ACP attaches the requested session ID when resume returns an empty result', async () => {
  const adapter = new AcpAdapter();
  adapter._loadSdk = async () => ({ methods: { agent: { session: { resume: 'resume' } } } });
  let attachedResponse;
  const state = {
    agentCtx: {
      request: async () => ({}),
      attachSession: (response) => {
        attachedResponse = response;
        return { sessionId: response.sessionId, dispose() {} };
      },
    },
  };

  const session = await adapter._resumeSession(state, 'existing-session');
  assert.equal(session.sessionId, 'existing-session');
  assert.equal(attachedResponse.sessionId, 'existing-session');
});

test('ACP prefers the standard loadSession method when the SDK exposes it', async () => {
  const adapter = new AcpAdapter();
  adapter._loadSdk = async () => ({ methods: { agent: { session: { load: 'session/load', resume: 'session/resume' } } } });
  const requested = [];
  const state = {
    agentCtx: {
      request: async (method, params) => { requested.push({ method, params }); return {}; },
      attachSession: (response) => ({ sessionId: response.sessionId, dispose() {} }),
    },
  };
  const session = await adapter._resumeSession(state, 'standard-session');
  assert.equal(session.sessionId, 'standard-session');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].method, 'session/load');
});

test('ACP propagates a rejected resume request', async () => {
  const adapter = new AcpAdapter();
  adapter._loadSdk = async () => ({ methods: { agent: { session: { resume: 'resume' } } } });
  const state = {
    agentCtx: {
      request: async () => { throw new Error('session unavailable'); },
      attachSession: () => assert.fail('failed resume must not attach a session'),
    },
  };

  await assert.rejects(adapter._resumeSession(state, 'existing-session'), /session unavailable/);
});

test('ACP propagates prompt failures instead of emitting an empty successful reply', async () => {
  const adapter = new AcpAdapter();
  const replies = [];
  adapter.on('agent.reply', (reply) => replies.push(reply));
  adapter._ensureAgent = async () => ({ sessions: new Map() });
  adapter._ensureSession = async () => ({
    sessionId: 'session-a',
    prompt: async () => { throw new Error('prompt failed'); },
    nextUpdate: async () => new Promise(() => {}),
    dispose() {},
  });

  await assert.rejects(adapter._pushViaAcp(basePayload), /prompt failed/);
  assert.equal(replies.length, 0);
});

test('ACP CLI fallback failures remain unhandled so dispatcher can leave the message for Pull', async () => {
  const adapter = new AcpAdapter({
    cliFallback: {
      cmd: process.execPath,
      args: ['-e', 'process.exit(7)'],
      parser: 'raw',
    },
  });
  const replies = [];
  adapter.on('agent.reply', (reply) => replies.push(reply));

  await assert.rejects(adapter._pushViaCli(basePayload), /code 7/);
  assert.equal(replies.length, 0);
});

test('ACP runtime availability is separate from per-agent process health', async () => {
  const adapter = new AcpAdapter({
    runtimeRequest: {
      providerId: 'test-acp',
      mode: 'acp',
      candidates: [],
    },
    runtimeResolver: {
      resolve: () => ({ available: true, executable: process.execPath, argvPrefix: [], resolvedAt: Date.now() }),
      invalidate() {},
    },
  });
  const events = [];
  adapter.on('availability', (event) => events.push(event));
  adapter._started = true;

  adapter._markAgentHealth('agent-a', false, 'process-exit:1');
  assert.equal(adapter.isAvailable('agent-a'), false);
  assert.equal(adapter.isAvailable('agent-b'), true);

  const state = {
    child: null,
    transportAlive: true,
    transportClose: null,
    agentCtx: {},
    sessions: new Map(),
    ready: Promise.resolve(),
    _readyResolve: null,
    _shutdownResolve: null,
  };
  let allowedRecovery = false;
  adapter._ensureAgent = async (agentId, allowRecovery) => {
    allowedRecovery = allowRecovery;
    adapter._agents.set(agentId, state);
    return state;
  };

  const result = await adapter.healthCheck();
  assert.equal(result.ok, true);
  assert.equal(result.agents['agent-a'].status, 'recovered');
  assert.equal(allowedRecovery, true);
  assert.equal(adapter.isAvailable('agent-a'), true);
  assert.equal(events.some((event) => event.agentId === 'agent-a' && event.available === false), true);
  assert.equal(events.some((event) => event.agentId === 'agent-a' && event.available === true), true);
});

test('ACP health gate blocks a still-live process until explicit recovery', async () => {
  const adapter = new AcpAdapter();
  const state = {
    child: null,
    transportAlive: true,
    transportClose: null,
    agentCtx: {},
    agentIds: new Set(['agent-a']),
    sessions: new Map(),
    ready: Promise.resolve(),
    _readyResolve: null,
    _shutdownResolve: null,
  };
  adapter._agents.set('agent-a', state);
  adapter._markAgentHealth('agent-a', false, 'process-error:transport');

  await assert.rejects(
    adapter._ensureAgent('agent-a'),
    (error) => error.deliveryOutcome === 'not_delivered',
  );
  assert.equal(await adapter._ensureAgent('agent-a', true), state);
});

test('shared ACP recovery is single-flight across agents using one connection key', async () => {
  let calls = 0;
  const adapter = new AcpAdapter({ connectionKey: () => 'shared-profile' });
  adapter._started = true;
  const state = {
    child: null,
    transportAlive: true,
    transportClose: null,
    agentCtx: {},
    agentIds: new Set(['agent-a', 'agent-b']),
    sessions: new Map(),
    ready: Promise.resolve(),
    _readyResolve: null,
    _shutdownResolve: null,
  };
  adapter._ensureAgent = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    adapter._agents.set('shared-profile', state);
    return state;
  };

  const [first, second] = await Promise.all([
    adapter.recover('agent-a'),
    adapter.recover('agent-b'),
  ]);
  assert.deepEqual([first, second], [true, true]);
  assert.equal(calls, 1);
});

test('recovery started before stop cannot restore availability afterwards', async () => {
  const adapter = new AcpAdapter();
  adapter._started = true;
  let release;
  adapter._ensureAgent = () => new Promise((resolve) => { release = resolve; });
  const recovery = adapter.recover('agent-a');
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.stop();
  release({
    child: null,
    transportAlive: true,
    transportClose: null,
    agentCtx: {},
    agentIds: new Set(['agent-a']),
    sessions: new Map(),
    ready: Promise.resolve(),
    _readyResolve: null,
    _shutdownResolve: null,
  });
  assert.equal(await recovery, false);
  assert.equal(adapter.isAvailable('agent-a'), false);
});

test('stop cancels a pending ACP streamFactory connection and closes its transport', async () => {
  let closeCalls = 0;
  const adapter = new AcpAdapter({
    streamFactory: async () => ({
      stream: {},
      close: async () => { closeCalls += 1; },
    }),
  });
  adapter._loadSdk = async () => ({
    methods: { agent: { session: { resume: 'resume' } }, client: { session: { requestPermission: 'permission' } } },
    client: () => ({
      onRequest: () => ({
        connectWith: () => new Promise(() => {}),
      }),
    }),
  });
  await adapter.start();
  const connecting = adapter._ensureAgent('agent-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter._agents.has('agent-a'), true);

  await adapter.stop();
  await assert.rejects(connecting, (error) => error.deliveryOutcome === 'not_delivered');
  assert.equal(closeCalls, 1);
  assert.equal(adapter._agents.size, 0);
});

test('healthCheck recovers a shared dead ACP state once for all bound agents', async () => {
  let recoverCalls = 0;
  const adapter = new AcpAdapter({ connectionKey: () => 'shared-profile' });
  adapter._started = true;
  const deadState = {
    child: null,
    transportAlive: false,
    transportClose: null,
    agentCtx: null,
    agentIds: new Set(['agent-a', 'agent-b']),
    sessions: new Map(),
    ready: Promise.resolve(),
    _readyResolve: null,
    _shutdownResolve: null,
  };
  adapter._agents.set('shared-profile', deadState);
  adapter._markAgentHealth('agent-a', false, 'process-exit:1');
  adapter._markAgentHealth('agent-b', false, 'process-exit:1');
  const liveState = {
    ...deadState,
    transportAlive: true,
    agentCtx: {},
    agentIds: new Set(['agent-a', 'agent-b']),
  };
  adapter._ensureAgent = async () => {
    recoverCalls += 1;
    adapter._agents.set('shared-profile', liveState);
    return liveState;
  };

  const result = await adapter.healthCheck();
  assert.equal(result.ok, true);
  assert.deepEqual(result.agents, {
    'agent-a': { ok: true, status: 'recovered' },
    'agent-b': { ok: true, status: 'recovered' },
  });
  assert.equal(recoverCalls, 1);
});
