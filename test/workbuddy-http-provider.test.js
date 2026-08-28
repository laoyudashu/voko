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

test('WorkBuddy prefers an installed CLI and starts a text-only local service', () => {
  const runtime = resolveWorkBuddyRuntime({ env: { ...process.env } });
  assert.equal(runtime.source, 'path');
  assert.match(runtime.command, /codebuddy/);
  const args = workBuddyServeArgs(['bundled-cli'], 12345, 'voko-session');
  assert.deepEqual(args.slice(0, 10), ['bundled-cli', '--serve', '--host', '127.0.0.1', '--port', '12345',
    '--session-id', 'voko-session', '--permission-mode', 'dontAsk']);
  assert.equal(args[10], '--agents');
  assert.deepEqual(JSON.parse(args[11]).voko.tools, []);
  assert.deepEqual(args.slice(12), ['--agent', 'voko', '--tools', '', '--strict-mcp-config']);
  assert.deepEqual(workBuddyServeArgs(['bundled-cli'], 12345, 'voko-session', {
    agentId: 'expert-a', pluginRoot: 'C:\\safe\\expert-a', dataFile: 'C:\\Users\\test\\.workbuddy\\expert-a\\data.json',
  }).slice(0, 5), ['bundled-cli', '--plugin-dir', 'C:\\safe\\expert-a', '--agent', 'expert-a']);
  assert.deepEqual(workBuddyServeArgs([], 12345, 'voko-session', {
    agentId: 'expert-a', dataFile: 'C:\\Users\\test\\.workbuddy\\expert-a\\data.json',
  }).slice(-7), ['dontAsk', '--tools', 'Read,Write', '--allowedTools',
    'Read(C:\\Users\\test\\.workbuddy\\expert-a\\data.json)',
    'Write(C:\\Users\\test\\.workbuddy\\expert-a\\data.json)', '--strict-mcp-config']);
});

test('WorkBuddy preflight validates the local component without desktop login state', async () => {
  const idle = new WorkBuddyHttpProvider({ binPath: process.execPath });
  const idleResult = await idle.preflightDelivery('agent-1');
  assert.equal(idleResult.ok, false);
  assert.equal(idleResult.status, 'unavailable');
  assert.equal(idleResult.code, 'WORKBUDDY_HTTP_UNHEALTHY');

  const running = readyProvider(async (url) => {
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) {
      return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    }
    throw new Error(`unexpected ${url}`);
  });
  const runningResult = await running.preflightDelivery('agent-1');
  assert.equal(runningResult.ok, true);
  assert.equal(runningResult.status, 'ready');
  assert.equal(runningResult.code, 'WORKBUDDY_COMPONENT_READY');
});

test('WorkBuddy first text turn uses ACP and returns the native session', async () => {
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/acp/connect')) return response({ connectionId: 'connection-1' });
    if (String(url).endsWith('/api/v1/acp') && init.method === 'DELETE') return response({ ok: true });
    if (String(url).endsWith('/api/v1/acp')) {
      const request = JSON.parse(init.body);
      if (request.method === 'session/new') return acpResponse(request, [], { sessionId: 'session-1' });
      if (request.method === 'session/prompt') return acpResponse(request, [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
      ], { stopReason: 'end_turn' });
      return acpResponse(request, [], request.method === 'initialize' ? { protocolVersion: 1 } : {});
    }
    throw new Error(`unexpected ${url}`);
  });
  let reply = null;
  provider.on('agent.reply', event => { reply = event; });
  const receipt = await provider.push({ agentId: 'agent-1', fromUid: 'visitor-secret', senderUid: 'visitor-secret',
    channelId: 'visitor-secret', channelType: 1, content: 'hello', rawContent: 'hello',
    messageId: 'message-1', turnId: 'message-1' });
  const prompt = calls.map(call => call.init.body && JSON.parse(call.init.body)).filter(Boolean)
    .find(request => request.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'hello' }]);
  assert.equal(calls.some(call => call.url.endsWith('/api/v1/runs')), false);
  assert.equal(receipt.nativeSessionId, 'session-1');
  assert.equal(receipt.adapterType, 'workbuddy-http');
  assert.equal(reply.content, '你好');
});

test('WorkBuddy ACP denies an interactive question without hanging the turn', async () => {
  const methods = [];
  const provider = readyProvider(async (url, init = {}) => {
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/acp/connect')) return response({ connectionId: 'connection-interruption' });
    if (String(url).endsWith('/api/v1/acp') && init.method === 'DELETE') return response({ ok: true });
    if (String(url).endsWith('/api/v1/acp')) {
      const request = JSON.parse(init.body); methods.push(request.method);
      if (request.method === 'session/new') return acpResponse(request, [], { sessionId: 'session-interruption' });
      if (request.method === 'session/prompt') return acpResponse(request, [
        { sessionUpdate: 'interruption_request', toolCallId: 'ask-1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已跳过提问' } },
      ], { stopReason: 'end_turn' });
      return acpResponse(request, [], request.method === 'initialize' ? { protocolVersion: 1 } : {});
    }
    throw new Error(`unexpected ${url}`);
  });
  let reply = '';
  provider.on('agent.reply', event => { reply = event.content; });
  await provider.push({ agentId: 'a', fromUid: 'v', content: 'hello', channelId: 'v', channelType: 1,
    messageId: 'm-interruption', turnId: 'm-interruption' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply, '已跳过提问');
  assert.equal(methods.includes('_codebuddy.ai/resolveInterruption'), true);
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

test('WorkBuddy sends verified image attachments as ACP image blocks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-image-'));
  const imagePath = path.join(dir, 'tongue.jpg');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  fs.writeFileSync(imagePath, bytes);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/acp/connect')) return response({ connectionId: 'connection-image' });
    if (String(url).endsWith('/api/v1/acp') && init.method === 'DELETE') return response({ ok: true });
    if (String(url).endsWith('/api/v1/acp')) {
      const request = JSON.parse(init.body);
      if (request.method === 'session/new') return acpResponse(request, [], { sessionId: 'session-image' });
      if (request.method === 'session/prompt') return acpResponse(request, [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看到了图片' } },
      ], { stopReason: 'end_turn' });
      return acpResponse(request, [], request.method === 'initialize' ? { protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } } } : { protocolVersion: 1 });
    }
    throw new Error(`unexpected ${url}`);
  });
  const receipt = await provider.push({ agentId: 'agent-1', fromUid: 'visitor-1', channelId: 'visitor-1',
    channelType: 1, content: '[图片] tongue.jpg', rawContent: '[图片] tongue.jpg',
    messageId: 'message-image', turnId: 'message-image', attachments: [{ path: imagePath, name: 'tongue.jpg',
      mediaType: 'image/jpeg', size: bytes.length,
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }] });
  const prompt = calls.map(call => call.init.body && JSON.parse(call.init.body)).filter(Boolean)
    .find(request => request.method === 'session/prompt').params.prompt;
  assert.deepEqual(prompt[0], { type: 'text', text: '[图片] tongue.jpg' });
  assert.deepEqual(prompt[1], { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' });
  assert.equal(calls.some(call => call.url.endsWith('/api/v1/runs')), false);
  assert.equal(receipt.nativeSessionId, 'session-image');
});

test('WorkBuddy sends files as embedded resources when ACP advertises embedded context', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'report.txt');
  const bytes = Buffer.from('transport-file-token');
  fs.writeFileSync(filePath, bytes);
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/health')) return response({ status: 'ok' });
    if (String(url).endsWith('/api/openapi.json')) return response({ paths: Object.fromEntries(requiredPaths.map(item => [item, {}])) });
    if (String(url).endsWith('/api/v1/acp/connect')) return response({ connectionId: 'connection-file' });
    if (String(url).endsWith('/api/v1/acp') && init.method === 'DELETE') return response({ ok: true });
    if (String(url).endsWith('/api/v1/acp')) {
      const request = JSON.parse(init.body);
      if (request.method === 'session/new') return acpResponse(request, [], { sessionId: 'session-file' });
      if (request.method === 'session/prompt') return acpResponse(request, [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'received' } },
      ], { stopReason: 'end_turn' });
      return acpResponse(request, [], request.method === 'initialize' ? { protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { embeddedContext: true } } } : { protocolVersion: 1 });
    }
    throw new Error(`unexpected ${url}`);
  });
  await provider.push({ agentId: 'agent-file', fromUid: 'visitor-file', content: '[附件] report.txt',
    messageId: 'message-file', turnId: 'message-file', attachments: [{ path: filePath, name: 'report.txt',
      mediaType: 'text/plain', size: bytes.length,
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }] });
  assert.equal(calls.some(call => call.url.endsWith('/api/v1/runs')), false);
  const prompt = calls.map(call => call.init.body && JSON.parse(call.init.body)).filter(Boolean)
    .find(request => request.method === 'session/prompt').params.prompt;
  assert.deepEqual(prompt[1], { type: 'resource', resource: {
    uri: 'voko-attachment:///report.txt', mimeType: 'text/plain', text: bytes.toString('utf8'),
  } });
});

test('WorkBuddy cancellation targets only the recorded Run or exact ACP session', async () => {
  const calls = [];
  const provider = readyProvider(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/runs/run-1/cancel')) return response({ data: { status: 'cancelled' } });
    if (String(url).endsWith('/api/v1/acp')) return acpResponse(JSON.parse(init.body), []);
    throw new Error(`unexpected ${url}`);
  });
  const state = provider._currentState();
  provider._activeRuns.set('turn-run', { runId: 'run-1', state });
  provider._activeAcp.set('turn-acp', { connectionId: 'connection-1', sessionId: 'session-1', state });
  assert.deepEqual(await provider.cancelTurn('turn-run'), { canceled: true, outcome: 'delivered' });
  assert.deepEqual(await provider.cancelTurn('turn-acp'), { canceled: true, outcome: 'delivered' });
  assert.deepEqual(await provider.cancelTurn('missing'), { canceled: false, outcome: 'not_delivered' });
  const cancel = calls.find(call => call.url.endsWith('/api/v1/acp'));
  assert.equal(JSON.parse(cancel.init.body).method, 'session/cancel');
  assert.equal(JSON.parse(cancel.init.body).params.sessionId, 'session-1');
});

test('WorkBuddy bound agents use isolated server states and preserve ACP affinity', async () => {
  const rows = new Map([['voko-a', 'expert-a'], ['voko-b', 'expert-b']]);
  const provider = new WorkBuddyHttpProvider({ binPath: process.execPath,
    db: { prepare: () => ({ get: (agentId) => ({ backend_instance_id: rows.get(agentId) }) }) },
    resolveAgentTarget: id => ({ instance: { id }, pluginRoot: `C:\\experts\\${id}` }),
  });
  const stateA = provider._stateFor({ agentId: 'voko-a' });
  const stateB = provider._stateFor({ agentId: 'voko-b' });
  assert.notEqual(stateA, stateB);
  assert.equal(provider._stateFor({ agentId: 'voko-a' }), stateA);
  assert.equal(stateA.instanceId, 'expert-a');
  assert.equal(stateB.instanceId, 'expert-b');
  assert.throws(() => provider._stateFor({ agentId: 'voko-a', providerBinding: {
    providerType: 'workbuddy', adapterType: 'workbuddy-http', deliveryMode: 'http',
    providerInstanceId: 'expert-b', nativeSessionId: 'session-b',
  } }), /binding is stale/);
  provider._activeAcp.set('turn-a', { connectionId: 'c-a', sessionId: 's-a', state: stateA });
  assert.equal(provider._activeAcp.get('turn-a').state, stateA);
});
