'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');
const HermesHttpProvider = require('../build/core/dispatcher/providers/hermes-http');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');

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

test('OpenClaw restores once, then sends only current content until reconnect', async () => {
  const db = dbWithHistory();
  const provider = new OpenClawWsProvider(db, null);
  const sent = [];
  try {
    provider.sendToSession = async (_sessionKey, prompt) => sent.push(prompt);
    await provider.push(basePayload);
    await provider.push({ ...basePayload, content: 'second message' });
    provider._recoveryWarmedSessions.clear();
    await provider.push({ ...basePayload, content: 'after reconnect' });

    assert.match(sent[0], /remembered fact/);
    assert.equal(sent[1], 'second message');
    assert.match(sent[2], /remembered fact/);
  } finally {
    provider.destroy();
    db.close();
  }
});

test('Hermes restores once, then sends only current content until unavailable', async () => {
  const db = dbWithHistory();
  const provider = new HermesHttpProvider(db, null);
  const sent = [];
  try {
    provider.sendToSession = async (_sessionKey, prompt) => sent.push(prompt);
    await provider.push(basePayload);
    await provider.push({ ...basePayload, content: 'second message' });
    provider._recoveryWarmedSessions.clear();
    await provider.push({ ...basePayload, content: 'after reconnect' });

    assert.match(sent[0], /remembered fact/);
    assert.equal(sent[1], 'second message');
    assert.match(sent[2], /remembered fact/);
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
