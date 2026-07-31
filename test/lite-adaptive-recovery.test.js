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

