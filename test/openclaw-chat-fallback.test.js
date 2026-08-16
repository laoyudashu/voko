'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');

test('OpenClaw falls back to a terminal session.message when advertised chat events never arrive', async (t) => {
  const provider = new OpenClawWsProvider(null, null);
  t.after(() => provider.destroy());
  const replies = [];
  provider.on('agent.reply', (reply) => replies.push(reply));
  const connectionTimer = setTimeout(() => {}, 1000);
  await provider.handleMessage({ type: 'res', ok: true, payload: {
    protocol: 4, features: { methods: ['chat.send'], events: ['session.message', 'chat'] },
  } }, () => {}, connectionTimer);
  await provider.handleMessage({ type: 'event', event: 'session.message', payload: {
    sessionKey: 'agent:gym:a2a:test', runId: 'turn-fallback', message: {
      id: 'legacy-only', role: 'assistant', content: [{ type: 'text', text: 'fallback reply' }], stopReason: 'stop',
    },
  } }, undefined, connectionTimer);
  clearTimeout(connectionTimer);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(provider._replyProtocol, 'chat');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, 'fallback reply');
  assert.equal(replies[0].turnId, 'turn-fallback');
});
