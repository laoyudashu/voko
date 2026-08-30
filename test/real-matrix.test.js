'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { allAutomaticTargets, parseJson, pollResult, resolveAgent, shellQuote } = require('../scripts/real-matrix');
const { confirmsAllSegments } = require('../scripts/real-group-turn');

test('real matrix parses structured CLI output surrounded by logs', () => {
  assert.deepStrictEqual(parseJson('prefix\n{\n  "success": true, "text": "a } b"\n}\ntrailing tip', 'fixture'), {
    success: true, text: 'a } b',
  });
});

test('real matrix resolves one exact host Agent and rejects ambiguity', () => {
  const inventory = { agents: [
    { agentName: 'Agent', backendType: 'codex', agentId: 'a' },
    { agentName: 'Agent', backendType: 'goose', agentId: 'b' },
  ] };
  assert.strictEqual(resolveAgent(inventory, { agentName: 'Agent', backendType: 'codex' }).agentId, 'a');
  assert.throws(() => resolveAgent(inventory, { agentName: 'Agent' }), /found 2/);
});

test('real matrix shell quoting preserves single quotes as one argument', () => {
  assert.strictEqual(shellQuote("a'b"), `'a'"'"'b'`);
});

test('real matrix expands only published public automatic targets', () => {
  const targets = allAutomaticTargets({
    macos: { agents: [
      { agentName: 'ready', backendType: 'codex', publishStatus: 'published', accessMode: 'public', visibilityType: 0,
        runtime: { automaticDeliveryReady: true } },
      { agentName: 'private', backendType: 'codex', publishStatus: 'published', accessMode: 'private', visibilityType: 0,
        runtime: { automaticDeliveryReady: true } },
    ] },
  });
  assert.deepEqual(targets, [{ senderHost: 'linux', host: 'macos', agentName: 'ready', backendType: 'codex', restoreVisibility: 0 }]);
});

test('result polling waits for the reply phase after Provider completion', async () => {
  const rows = [
    { execution: { state: 'COMPLETED', phase: 'provider' }, reply: { state: 'PENDING' } },
    { execution: { state: 'COMPLETED', phase: 'reply' }, reply: { state: 'DELIVERED' } },
  ];
  const host = { json() { return rows.shift(); } };
  const result = await pollResult(host, 'agent-1', 'message-1', 6_000);
  assert.equal(result.reply.state, 'DELIVERED');
  assert.equal(rows.length, 0);
});

test('group turn verifier accepts a natural-language reply that confirms every segment', () => {
  assert.equal(confirmsAllSegments({ content: '收到 ALPHA、BETA 和 GAMMA' }), true);
  assert.equal(confirmsAllSegments({ content: '只收到 ALPHA 和 GAMMA' }), false);
});
