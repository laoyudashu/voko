'use strict';

process.env.VOKO_A2A_MAX_TURNS = '2';
process.env.VOKO_A2A_RATE_THRESHOLD = '100';
process.env.VOKO_A2A_CIRCUIT_OPEN_MS = '60000';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDispatcher } = require('../build/core/dispatcher');

class Provider extends EventEmitter {
  constructor() { super(); this.calls = []; }
  match() { return true; }
  isAvailable() { return true; }
  push(payload) {
    this.calls.push(payload);
    setImmediate(() => this.emit('agent.reply', { agentId: payload.agentId, visitorId: payload.fromUid,
      turnId: payload.turnId, replyId: `reply-${this.calls.length}`, content: 'ordinary business reply', done: true }));
    return { nativeSessionId: 'a2a-session' };
  }
}

function db() {
  const audit = [];
  return { audit, prepare(sql) { return {
    get: (...args) => sql.includes('SELECT backend_type')
      ? { backend_type: 'codex', backend_instance_id: null, delivery_modes: '["cli"]', imUid: 'local-agent-uid' }
      : sql.includes('FROM agents WHERE imUid=') ? { agent_id: 'peer-agent', 1: 1 } : undefined,
    all: () => [],
    run: (...args) => { if (sql.includes('INSERT OR REPLACE INTO messages')) audit.push(args); return { changes: 1 }; },
  }; } };
}

test('A2A circuit remains open after the limit and control stays outside peer content', async () => {
  const provider = new Provider();
  const database = db();
  const dispatcher = createDispatcher({ db: database, providers: { 'codex-cli': provider }, onAgentReply() {} });
  const send = index => dispatcher.executeE2ee({ agentId: 'agent-1', taskId: `task-${index}`,
    contextId: 'conversation-1', content: `peer business message ${index}`, sourceType: 'agent_peer',
    peerUid: 'peer-agent-uid', sessionScopeId: 'session-1', timeoutMs: 1000 });

  assert.equal((await send(1)).reply.content, 'ordinary business reply');
  assert.equal((await send(2)).reply.content, 'ordinary business reply');
  assert.equal((await send(3)).reply.content, 'NO_REPLY');
  assert.equal((await send(4)).reply.content, 'NO_REPLY');
  assert.equal(provider.calls.length, 2);
  assert.equal(database.audit.length, 2, 'one circuit audit row per locally known Agent side');

  const prompt = provider.calls[0].content;
  const controlEnd = prompt.indexOf('[/VOKO SECURITY CONTEXT]');
  const peerStart = prompt.indexOf('[VOKO EXTERNAL MESSAGE]');
  assert.ok(prompt.indexOf('[VOKO A2A CONTROL]') < controlEnd);
  assert.ok(peerStart > controlEnd);
  assert.match(prompt.slice(peerStart), /peer business message 1/);
  assert.doesNotMatch(prompt.slice(peerStart), /\[VOKO A2A CONTROL\]/);
});
