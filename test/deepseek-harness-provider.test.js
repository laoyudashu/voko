const test = require('node:test');
const assert = require('node:assert/strict');

const { DeepSeekHarnessHttpProvider, loopbackBaseUrl } = require('../build/core/dispatcher/providers/deepseek-harness-http');
const { DeepSeekHarnessCliProvider } = require('../build/core/dispatcher/providers/deepseek-harness-cli');

function rpcResponse(request, value) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchImpl) {
  return new DeepSeekHarnessHttpProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'standard' }) }) },
    fetchImpl, startServer: false, turnTimeoutMs: 5000,
  });
}

test('DeepSeek Harness transport creates a preset-bound session and correlates its exact turn', async () => {
  let promptRpcId = '';
  const methods = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method === 'agentPreset.list') return rpcResponse(request, { presets: [{ id: 'standard' }] });
    if (request.method === 'session.create') {
      assert.deepEqual(request.payload, { agentPreset: 'standard' });
      return rpcResponse(request, { sessionId: 'dsh-session-1', agentPreset: 'standard' });
    }
    if (request.method === 'session.prompt') {
      promptRpcId = request.rpcId;
      assert.equal(request.payload.sessionId, 'dsh-session-1');
      return rpcResponse(request, { accepted: true });
    }
    if (request.method === 'session.history') return rpcResponse(request, { events: [
      { event: { type: 'turn/start', seq: 0, data: { turn: 7 } } },
      { event: { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: promptRpcId }, content: [] } } },
      { event: { type: 'assistant/message', seq: 2, data: { turn: 7, message: { content: [{ type: 'text', text: 'DSH reply' }] } } } },
      { event: { type: 'turn/end', seq: 3, data: { turn: 7, reason: { kind: 'completed' } } } },
    ] });
    throw new Error(`unexpected method ${request.method}`);
  };
  const p = provider(fetchImpl);
  await p.start();
  let reply;
  p.on('agent.reply', event => { reply = event; });
  const receipt = await p.push({ agentId: 'a1', fromUid: 'visitor', content: 'hello', messageId: 'm1', turnId: 'm1' });
  assert.equal(reply.content, 'DSH reply');
  assert.deepEqual(receipt, {
    nativeSessionId: 'dsh-session-1', providerInstanceId: 'standard',
    deliveryMode: 'http', adapterType: 'deepseek-harness-http',
  });
  assert.deepEqual(methods, ['agentPreset.list', 'session.create', 'session.prompt', 'session.history']);
});

test('DeepSeek Harness exact-session probe is read-only and stale preset bindings fail closed', async () => {
  let prompts = 0;
  const p = provider(async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'session.history') return rpcResponse(request, { events: [] });
    if (request.method === 'session.prompt') prompts += 1;
    return rpcResponse(request, {});
  });
  const binding = {
    id: 'b1', bindingVersion: 1, providerType: 'deepseek-harness', providerInstanceId: 'other',
    deliveryMode: 'http', adapterType: 'deepseek-harness-http', nativeSessionId: 's1',
    sessionOrigin: 'voko_managed', channelId: 'c1', channelType: 1,
  };
  await assert.rejects(() => p.push({ agentId: 'a1', fromUid: 'v', content: 'x', messageId: 'm', providerBinding: binding }),
    error => error.deliveryOutcome === 'not_delivered' && /preset binding is stale/.test(error.message));
  assert.equal(prompts, 0);
  assert.equal(await p.canRestoreExactSession({ ...binding, providerInstanceId: 'standard', strictSessionRoute: true }, 'a1'), true);
});

test('DeepSeek Harness API is restricted to loopback HTTP', () => {
  assert.equal(loopbackBaseUrl('http://localhost:3080/path'), 'http://localhost:3080');
  assert.throws(() => loopbackBaseUrl('https://example.com'), /loopback HTTP/);
});

test('DeepSeek Harness Profile CLI fails closed for an existing native session', async () => {
  const provider = new DeepSeekHarnessCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_type: 'deepseek-harness', backend_instance_id: 'standard' }) }) },
  });
  await assert.rejects(provider.push({
    agentId: 'agent-1', fromUid: 'visitor-1', content: 'continue', messageId: 'm2', turnId: 't2',
    providerBinding: { providerType: 'deepseek-harness', adapterType: 'deepseek-harness-http',
      deliveryMode: 'http', nativeSessionId: 'session-1' },
  }), error => error.deliveryOutcome === 'not_delivered' && /cannot restore/.test(error.message));
});
