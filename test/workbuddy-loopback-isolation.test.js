const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyHttpProvider } = require('../build/core/dispatcher/providers/workbuddy-http');

const challenge = 'voko-0123456789abcdef01234567';
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture({ pause, empty = false } = {}) {
  const replies = [], events = [], disconnected = [];
  let nextConnection = 0;
  const provider = new WorkBuddyHttpProvider({ binPath: process.execPath,
    async fetchImpl(url, init = {}) {
      if (String(url).endsWith('/connect')) return Response.json({ connectionId: `c-${++nextConnection}` });
      const connection = init.headers['acp-connection-id'];
      if (init.method === 'DELETE') { disconnected.push(connection); return Response.json({ ok: true }); }
      const request = JSON.parse(init.body);
      let result = {}, updates = [];
      if (request.method === 'initialize') result = { protocolVersion: 1 };
      if (request.method === 'session/new') result = { sessionId: `s-${connection}` };
      if (request.method === 'session/prompt') {
        const text = request.params.prompt.map(p => p.text || '').join('');
        const isProbe = text.includes('VOKO local loopback test.');
        if (isProbe && pause) { pause.entered.resolve(); await pause.release.promise; }
        if (!isProbe || !empty) updates = [{ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: isProbe ? text.match(/voko-[a-f0-9]{24}/)[0] : 'business answer' } },
        } }];
        result = { stopReason: 'end_turn' };
      }
      return new Response([...updates, { jsonrpc: '2.0', id: request.id, result }]
        .map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  provider._ensureServer = async () => {};
  provider._port = 18888;
  provider.on('agent.reply', e => replies.push(e));
  provider.on('provider.event', e => events.push(e));
  return { provider, replies, events, disconnected };
}
function businessPayload(turnId = 'business-turn') {
  return { agentId: 'agent-1', fromUid: 'real-visitor', content: 'ordinary message',
    channelId: 'real-visitor', channelType: 1, messageId: turnId, turnId, timestamp: Date.now() };
}

test('WorkBuddy loopback captures its answer without business replies, lifecycle or delivery evidence', async () => {
  const { provider, replies, events, disconnected } = fixture();
  const previous = { status: 'failed', code: 'PREVIOUS_BUSINESS_FAILURE', observedAt: 123 };
  provider._lastDelivery.set('agent-1', previous);
  const result = await provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge });
  assert.equal(result.ok, true);
  assert.equal(result.challengeMatched, true);
  assert.equal(result.loopbackSessionId, 's-c-1');
  assert.deepEqual(replies, []);
  assert.deepEqual(events.filter(e => ['accepted', 'completed'].includes(e.type)), []);
  assert.equal(provider._lastDelivery.get('agent-1'), previous);
  assert.deepEqual(disconnected, ['c-1']);
  assert.equal(provider._activeAcp.size, 0);
});

test('WorkBuddy loopback failure disconnects without changing business delivery or swallowing the failure', async () => {
  const { provider, replies, events, disconnected } = fixture({ empty: true });
  await assert.rejects(provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge }),
    { code: 'WORKBUDDY_NEW_EMPTY_REPLY', deliveryOutcome: 'outcome_unknown' });
  assert.deepEqual(replies, []);
  assert.deepEqual(events.filter(e => ['accepted', 'completed'].includes(e.type)), []);
  assert.equal(provider._lastDelivery.has('agent-1'), false);
  assert.deepEqual(disconnected, ['c-1']);
  assert.equal(provider._activeAcp.size, 0);
});

test('WorkBuddy normal delivery continues while loopback is pending, even with a challenge-shaped turn id', async () => {
  const pause = { entered: deferred(), release: deferred() };
  const { provider, replies, events, disconnected } = fixture({ pause });
  const probe = provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge });
  await pause.entered.promise;
  try {
    await provider.push(businessPayload('voko-abcdef0123456789abcdef01'));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].visitorId, 'real-visitor');
    assert.equal(replies[0].content, 'business answer');
    assert.deepEqual(events.filter(e => ['accepted', 'completed'].includes(e.type)).map(e => e.type), ['accepted', 'completed']);
  } finally { pause.release.resolve(); }
  assert.equal((await probe).ok, true);
  assert.equal(replies.length, 1);
  assert.equal(events.filter(e => ['accepted', 'completed'].includes(e.type)).length, 2);
  assert.equal(disconnected.length, 2);
});
