const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkBuddyHttpProvider, opaqueScope, mergeMarkdown, workBuddyServeArgs } = require('../build/core/dispatcher/providers/workbuddy-http');
const { resolveWorkBuddyRuntime, workBuddySpawnCommand } = require('../build/core/dispatcher/workbuddy-command');
const catalog = require('../build/core/dispatcher/provider-catalog');

function response(body, status = 200, headers = { 'content-type': 'application/json' }) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function streamResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function acpResponse(request, updates = [], result = {}) {
  const events = updates.map(update => ({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: request.params?.sessionId, update } }));
  if (request.id) events.push({ jsonrpc: '2.0', id: request.id, result });
  return streamResponse(events);
}

function readyProvider(fetchImpl) {
  const provider = new WorkBuddyHttpProvider({ fetchImpl, binPath: process.execPath });
  provider._server = { exitCode: null };
  provider._port = 18888;
  return provider;
}

const requiredPaths = [
  '/api/v1/runs', '/api/v1/runs/{runId}', '/api/v1/runs/{runId}/stream', '/api/v1/runs/{runId}/cancel',
  '/api/v1/acp/connect', '/api/v1/acp',
];

test('WorkBuddy catalog declares HTTP then Pull without CLI fallback', () => {
  const family = catalog.getProviderFamily('workbuddy');
  const transport = catalog.getProviderTransport('workbuddy-http');
  assert.deepEqual(family.defaultDeliveryModes, ['http', 'pull']);
  assert.equal(family.requiresInstance, false);
  assert.deepEqual(family.transports.map(item => item.id), ['workbuddy-http']);
  assert.equal(transport.mode, 'http');
  assert.equal(transport.capabilities.streaming, true);
  assert.equal(transport.capabilities.sessionResume, true);
  assert.equal(transport.capabilities.cancel, true);
});

test('WorkBuddy bundled CLI may be configured without PATH and launches through Node', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-command-'));
  const command = path.join(dir, 'codebuddy');
  fs.writeFileSync(command, 'console.log("test")');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = resolveWorkBuddyRuntime({ configuredCommand: command, env: {} });
  assert.equal(runtime.command, path.resolve(command));
  assert.equal(runtime.source, 'configured');
  assert.deepEqual(workBuddySpawnCommand(runtime), { command: process.execPath, argsPrefix: [path.resolve(command)] });
});

test('WorkBuddy only resolves its bundled runtime and starts a text-only local service', () => {
  assert.notEqual(resolveWorkBuddyRuntime({ env: { ...process.env } }).source, 'path');
  assert.deepEqual(workBuddyServeArgs(['bundled-cli'], 12345, 'voko-session'), [
    'bundled-cli', '--serve', '--host', '127.0.0.1', '--port', '12345',
    '--session-id', 'voko-session', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config',
  ]);
});

test('WorkBuddy request uses Gateway Protocol, opaque scopes and returns the native session', async () => {
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/runs')) return response({ data: { runId: 'run-1', status: 'accepted' } }, 202);
    if (String(url).endsWith('/api/v1/runs/run-1/stream')) return streamResponse([
      { replyTo: 'old-message', status: 'completed', content: { markdown: '旧回复' }, agent: { sessionId: 'session-1' } },
      { replyTo: 'message-1', status: 'running', content: { markdown: '你' }, agent: { sessionId: 'session-1' } },
      { replyTo: 'message-1', status: 'completed', content: { markdown: '你好' }, agent: { sessionId: 'session-1' } },
    ]);
    throw new Error(`unexpected ${url}`);
  });
  let reply = null;
  provider.on('agent.reply', event => { reply = event; });
  const receipt = await provider.push({ agentId: 'agent-1', fromUid: 'visitor-secret', senderUid: 'visitor-secret',
    channelId: 'visitor-secret', channelType: 1, content: 'hello', rawContent: 'hello',
    messageId: 'message-1', turnId: 'message-1' });
  const create = calls.find(call => call.url.endsWith('/api/v1/runs'));
  const body = JSON.parse(create.init.body);
  assert.equal(body.id, 'message-1');
  assert.equal(body.type, 'message');
  assert.equal(body.source.platform, 'voko');
  assert.equal(body.source.conversation.type, 'direct');
  assert.equal(body.source.sender.id.includes('visitor-secret'), false);
  assert.equal(body.source.conversation.id.includes('visitor-secret'), false);
  assert.deepEqual(body.payload, { text: 'hello' });
  assert.equal(receipt.nativeSessionId, 'session-1');
  assert.equal(receipt.adapterType, 'workbuddy-http');
  assert.equal(reply.content, '你好');
});

test('accepted WorkBuddy Run never creates a second Run when streaming is uncertain', async () => {
  let creates = 0;
  let streams = 0;
  const provider = readyProvider(async (url) => {
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/runs')) { creates += 1; return response({ data: { runId: 'run-uncertain' } }, 202); }
    if (String(url).endsWith('/stream')) { streams += 1; throw new Error('connection reset'); }
    if (String(url).endsWith('/api/v1/runs/run-uncertain')) return response({ data: { runId: 'run-uncertain', active: true } });
    throw new Error(`unexpected ${url}`);
  });
  await assert.rejects(provider.push({ agentId: 'a', fromUid: 'v', content: 'hello', channelId: 'v', channelType: 1,
    messageId: 'm-uncertain', turnId: 'm-uncertain' }), error => error.deliveryOutcome === 'outcome_unknown');
  assert.equal(creates, 1);
  assert.equal(streams, 2);
});

test('requests not accepted are not_delivered while validation failures are rejected', async () => {
  for (const [status, outcome] of [[503, 'not_delivered'], [400, 'rejected']]) {
    const provider = readyProvider(async (url) => {
      if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
      if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
      return response({ error: 'failed' }, status);
    });
    await assert.rejects(provider.push({ agentId: 'a', fromUid: 'v', content: 'hello', channelId: 'v', channelType: 1,
      messageId: `m-${status}`, turnId: `m-${status}` }), error => error.deliveryOutcome === outcome);
  }
});

test('WorkBuddy scopes isolate Agent, source, channel type and channel id', () => {
  const base = opaqueScope('conversation', 'agent-1', 'conversation', 1, 'same');
  assert.notEqual(base, opaqueScope('conversation', 'agent-2', 'conversation', 1, 'same'));
  assert.notEqual(base, opaqueScope('conversation', 'agent-1', 'a2a', 1, 'same'));
  assert.notEqual(base, opaqueScope('conversation', 'agent-1', 'conversation', 2, 'same'));
  assert.notEqual(base, opaqueScope('conversation', 'agent-1', 'conversation', 1, 'other'));
  assert.equal(mergeMarkdown('你', '你好'), '你好');
  assert.equal(mergeMarkdown('你好', '好'), '你好');
});

test('WorkBuddy exact session resume ignores history replay and returns only the current turn', async () => {
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/acp/connect')) return response({ connectionId: 'connection-1' });
    if (String(url).endsWith('/api/v1/acp') && init.method === 'DELETE') return response({ ok: true });
    if (String(url).endsWith('/api/v1/acp')) {
      const request = JSON.parse(init.body);
      if (request.method === 'session/prompt') return acpResponse(request, [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' },
          _meta: { 'codebuddy.ai/historyReplay': true } },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'current prompt' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current answer' } },
      ], { stopReason: 'end_turn' });
      return acpResponse(request, [], request.method === 'initialize' ? { protocolVersion: 1 } : {});
    }
    throw new Error(`unexpected ${url}`);
  });
  let reply = null;
  provider.on('agent.reply', event => { reply = event.content; });
  const receipt = await provider.push({ agentId: 'agent-1', fromUid: 'visitor-1', channelId: 'visitor-1',
    channelType: 1, content: 'current prompt', rawContent: 'current prompt', messageId: 'message-2', turnId: 'message-2',
    providerBinding: { providerType: 'workbuddy', adapterType: 'workbuddy-http', deliveryMode: 'http',
      nativeSessionId: 'session-1', channelId: 'visitor-1', channelType: 1 } });
  assert.equal(reply, 'current answer');
  assert.equal(receipt.nativeSessionId, 'session-1');
  assert.equal(calls.filter(call => call.url.endsWith('/api/v1/runs')).length, 0);
  assert.equal(calls.some(call => call.url.endsWith('/api/v1/acp')
    && JSON.parse(call.init.body || '{}').method === 'session/resume'), true);
});

test('WorkBuddy cancellation targets only the recorded Run or exact ACP session', async () => {
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/runs/run-1/cancel')) return response({ data: { status: 'cancelled' } });
    if (String(url).endsWith('/api/v1/acp')) return acpResponse(JSON.parse(init.body), []);
    throw new Error(`unexpected ${url}`);
  });
  provider._activeRuns.set('turn-run', 'run-1');
  provider._activeAcp.set('turn-acp', { connectionId: 'connection-1', sessionId: 'session-1' });
  assert.deepEqual(await provider.cancelTurn('turn-run'), { canceled: true, outcome: 'delivered' });
  assert.deepEqual(await provider.cancelTurn('turn-acp'), { canceled: true, outcome: 'delivered' });
  assert.deepEqual(await provider.cancelTurn('missing'), { canceled: false, outcome: 'not_delivered' });
  const cancel = calls.find(call => call.url.endsWith('/api/v1/acp'));
  assert.equal(JSON.parse(cancel.init.body).method, 'session/cancel');
  assert.equal(JSON.parse(cancel.init.body).params.sessionId, 'session-1');
});
