const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');
const {
  buildOpenClawSessionKey,
  parseOpenClawSessionTarget,
} = require('../build/core/dispatcher/openclaw-session');

const providers = [];

function createProvider() {
  const provider = new OpenClawWsProvider(null, null);
  providers.push(provider);
  return provider;
}

afterEach(() => {
  for (const provider of providers.splice(0)) provider.destroy();
});

describe('Lite OpenClaw WS provider', () => {
  it('uses a 90 second cold-start budget and shares an in-flight gateway start', async () => {
    const provider = createProvider();
    assert.equal(provider.gatewayStartupTimeoutMs, 90000);
    let starts = 0;
    let release;
    provider._startGatewayAndWait = () => {
      starts += 1;
      return new Promise((resolve) => { release = resolve; });
    };

    const first = provider._ensureGatewayRunning();
    const second = provider._ensureGatewayRunning();
    assert.equal(starts, 1);
    release(true);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  });

  it('does not consume reconnect attempts while the gateway is starting', async () => {
    const provider = createProvider();
    provider.enabled = true;
    provider.gatewayProbeIntervalMs = 5;
    provider._gatewayStarting = true;
    provider.reconnectAttempts = 4;
    provider.scheduleReconnect();
    assert.equal(provider.reconnectAttempts, 4);
    provider._gatewayStarting = false;
    clearTimeout(provider.reconnectTimer);
    provider.reconnectTimer = null;
  });

  it('does not consume reconnect attempts while the gateway accepts sockets but is warming up', () => {
    const provider = createProvider();
    provider.enabled = true;
    provider.gatewayProbeIntervalMs = 5;
    provider._gatewayWarmupUntil = Date.now() + 1000;
    provider.reconnectAttempts = 4;
    provider.scheduleReconnect();
    assert.equal(provider.reconnectAttempts, 4);
    clearTimeout(provider.reconnectTimer);
    provider.reconnectTimer = null;
  });

  it('resets reconnect state and connects immediately when the gateway becomes ready', async () => {
    const provider = createProvider();
    provider.enabled = true;
    provider.gatewayStartupTimeoutMs = 20;
    provider.gatewayProbeIntervalMs = 1;
    provider.reconnectAttempts = 7;
    provider._probeGateway = async () => true;
    let connected = 0;
    provider.connect = async () => { connected += 1; };

    assert.equal(await provider._waitForGatewayReady(), true);
    assert.equal(provider.reconnectAttempts, 0);
    assert.equal(connected, 1);
  });

  it('keeps WS eligible and waits for authentication during gateway cold start', async () => {
    const provider = createProvider();
    provider.enabled = true;
    provider._gatewayStarting = true;
    provider.gatewayProbeIntervalMs = 1;
    provider._ensureGatewayRunning = async () => true;
    provider.connect = async () => { provider.connected = true; };
    assert.equal(provider.isAvailable('gym'), true);

    setTimeout(() => {
      provider._gatewayStarting = false;
    }, 5);
    await provider._waitForAuthenticatedConnection(100);
    assert.equal(provider.connected, true);
  });

  it('fails as not_delivered when WS cold start never authenticates', async () => {
    const provider = createProvider();
    provider.enabled = true;
    provider._gatewayStarting = true;
    provider.gatewayProbeIntervalMs = 1;
    await assert.rejects(
      provider._waitForAuthenticatedConnection(5),
      (error) => error.deliveryOutcome === 'not_delivered',
    );
  });

  it('push 保持 session key 大小写映射和结构化消息协议', async () => {
    const provider = createProvider();
    const sent = [];
    provider._gatewayMethods = ['chat.send'];
    provider.connected = true;
    provider.ws = {
      readyState: WebSocket.OPEN,
      send: (data) => sent.push(JSON.parse(data)),
      removeAllListeners: () => {},
      close: () => {},
    };

    await provider.push({
      agentId: 'Gym',
      fromUid: 'VisitorABC',
      senderUid: 'sender-1',
      content: 'hello',
      channelId: 'channel-1',
      channelType: 1,
      contentType: 1,
      messageId: 'message-1',
      timestamp: 123,
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'chat.send');
    const expectedSession = buildOpenClawSessionKey('Gym', 'Gym', 'VisitorABC');
    assert.equal(sent[0].params.sessionKey, expectedSession.toLowerCase());
    const message = JSON.parse(sent[0].params.message);
    assert.equal(message.content, 'hello');
    assert.equal(message.fromUid, 'sender-1');
    assert.equal(message.messageId, 'message-1');
    assert.equal(
      provider._caseMap.get(expectedSession.toLowerCase()),
      expectedSession,
    );
    assert.equal(
      provider._sessionTurns.get(expectedSession.toLowerCase()).turnId,
      'message-1',
    );
  });

  it('isolates VOKO Agents sharing one OpenClaw instance and preserves the reply target', () => {
    const first = buildOpenClawSessionKey('shared', 'agent-a', 'group:one');
    const second = buildOpenClawSessionKey('shared', 'agent-b', 'group:one');
    assert.notEqual(first, second);
    assert.equal(parseOpenClawSessionTarget(first.split(':').slice(2).join(':')), 'group:one');
    assert.equal(parseOpenClawSessionTarget(second.split(':').slice(2).join(':')), 'group:one');
  });

  it('does not reuse a binding from a different OpenClaw instance', async () => {
    const provider = new OpenClawWsProvider({
      prepare: () => ({ get: () => ({ backend_instance_id: 'instance-new' }) }),
    }, null);
    providers.push(provider);
    let sessionKey = '';
    provider.sendToSession = async (key) => { sessionKey = key; };
    const receipt = await provider.push({
      agentId: 'agent-a', fromUid: 'visitor-a', content: 'hello', messageId: 'message-a',
      providerBinding: {
        id: 'binding-old', bindingVersion: 1, providerType: 'openclaw',
        providerInstanceId: 'instance-old', deliveryMode: 'websocket', adapterType: 'openclaw-ws',
        nativeSessionId: 'agent:instance-old:voko-old:visitor-a', sessionOrigin: 'voko_managed',
        channelId: 'visitor-a', channelType: 1,
      },
    });
    assert.equal(sessionKey, buildOpenClawSessionKey('instance-new', 'agent-a', 'visitor-a'));
    assert.equal(receipt.providerInstanceId, 'instance-new');
  });

  it('accepts an exact A2A session only for the connected matching OpenClaw instance', async () => {
    const provider = createProvider(); provider.connected = true;
    const binding = {
      strictSessionRoute: true, providerType: 'openclaw', providerInstanceId: 'agent-a',
      deliveryMode: 'websocket', adapterType: 'openclaw-ws', nativeSessionId: 'agent:agent-a:voko-session:a2a:ctx-1',
    };
    assert.equal(await provider.canRestoreExactSession(binding, 'agent-a'), true);
    assert.equal(await provider.canRestoreExactSession({ ...binding, providerInstanceId: 'other' }, 'agent-a'), false);
    assert.equal(await provider.canRestoreExactSession({ ...binding, nativeSessionId: 'agent:other:voko-session:a2a:ctx-1' }, 'agent-a'), false);
  });

  it('同一 session 在订阅中按发送顺序共享订阅结果', async () => {
    const provider = createProvider();
    const requests = [];
    const sent = [];
    provider._gatewayMethods = ['sessions.messages.subscribe'];
    provider.connected = true;
    provider.send = (message) => requests.push(message);
    provider.sendChatSend = (sessionKey, message) => sent.push({ sessionKey, message });

    const first = provider.sendToSession('agent:instance:visitor', 'first');
    const second = provider.sendToSession('agent:instance:visitor', 'second');
    assert.equal(requests.length, 1, 'only one subscription request is sent');

    const timer = setTimeout(() => {}, 1000);
    await provider.handleMessage({
      type: 'res', payload: { key: 'agent:instance:visitor', subscribed: true },
    }, undefined, timer);
    clearTimeout(timer);
    await Promise.all([first, second]);
    assert.deepEqual(sent.map((item) => item.message), ['first', 'second']);
  });

  it('同一 session 的订阅失败对等待消息返回同一失败结果', async () => {
    const provider = createProvider();
    const requests = [];
    provider._gatewayMethods = ['sessions.messages.subscribe'];
    provider.connected = true;
    provider.send = (message) => requests.push(message);

    const first = provider.sendToSession('agent:instance:visitor', 'first');
    const second = provider.sendToSession('agent:instance:visitor', 'second');
    assert.equal(requests.length, 1);

    const timer = setTimeout(() => {}, 1000);
    await provider.handleMessage({
      type: 'res', payload: { key: 'agent:instance:visitor', subscribed: false },
    }, undefined, timer);
    clearTimeout(timer);
    await assert.rejects(first, /subscription failed/);
    await assert.rejects(second, /subscription failed/);
  });

  it('final 回复还原原始 session key，并在短时间内去重', () => {
    const provider = createProvider();
    const replies = [];
    provider._caseMap.set('agent:gym:visitorabc', 'agent:Gym:VisitorABC');
    provider.on('agent.reply', (reply) => replies.push(reply));
    const event = {
      payload: {
        state: 'final',
        sessionKey: 'agent:gym:visitorabc',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    };

    provider._handleChatEvent(event);
    provider._handleChatEvent(event);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].sessionKey, 'agent:Gym:VisitorABC');
    assert.equal(replies[0].visitorId, 'VisitorABC');
    assert.equal(replies[0].content, 'answer');
  });

  it('同一轮旧版片段和新版完整回复只投递新版完整回复', async () => {
    const provider = createProvider();
    const replies = [];
    provider.on('agent.reply', (reply) => replies.push(reply));
    const connectionTimer = setTimeout(() => {}, 1000);

    await provider.handleMessage({
      type: 'event',
      event: 'session.message',
      payload: {
        sessionKey: 'agent:gym:visitor',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '已经在问店里同事了，确认好时间我第一时间回复你！',
          }],
          stopReason: 'stop',
        },
      },
    }, undefined, connectionTimer);
    await provider.handleMessage({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'agent:gym:visitor',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '我先确认一下店里的安排。已经在问店里同事了，确认好时间我第一时间回复你！',
          }],
        },
      },
    }, undefined, connectionTimer);
    clearTimeout(connectionTimer);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(replies.length, 1);
    assert.equal(
      replies[0].content,
      '我先确认一下店里的安排。已经在问店里同事了，确认好时间我第一时间回复你！',
    );
  });

  it('仅有旧版 final 时仍正常投递', async () => {
    const provider = createProvider();
    const replies = [];
    provider.on('agent.reply', (reply) => replies.push(reply));

    provider._scheduleLegacyAgentReply('agent:gym:visitor', '旧网关回复');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '旧网关回复');
  });

  it('握手声明 chat 时只用 chat 形成业务回复', async () => {
    const provider = createProvider();
    const replies = [];
    const internalSessionEvents = [];
    provider.on('agent.reply', (reply) => replies.push(reply));
    provider.on('session.message', (event) => internalSessionEvents.push(event));
    const connectionTimer = setTimeout(() => {}, 1000);
    await provider.handleMessage({
      type: 'res',
      ok: true,
      payload: {
        protocol: 4,
        features: { methods: ['chat.send'], events: ['session.message', 'chat'] },
      },
    }, () => {}, connectionTimer);

    await provider.handleMessage({
      type: 'event',
      event: 'session.message',
      payload: {
        sessionKey: 'agent:gym:visitor',
        runId: 'turn-1',
        message: {
          id: 'legacy-reply',
          role: 'assistant',
          content: [{ type: 'text', text: '旧事件回复' }],
          stopReason: 'stop',
        },
      },
    }, undefined, connectionTimer);
    await provider.handleMessage({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'agent:gym:visitor',
        runId: 'turn-1',
        message: {
          id: 'chat-reply',
          role: 'assistant',
          content: [{ type: 'text', text: '新版完整回复' }],
        },
      },
    }, undefined, connectionTimer);

    assert.equal(provider._replyProtocol, 'chat');
    assert.equal(internalSessionEvents.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '新版完整回复');
    assert.equal(replies[0].turnId, 'turn-1');
    assert.equal(replies[0].replyId, 'chat-reply');
  });

  it('握手声明 session.message 时忽略 chat 业务回复', async () => {
    const provider = createProvider();
    const replies = [];
    provider.on('agent.reply', (reply) => replies.push(reply));
    const connectionTimer = setTimeout(() => {}, 1000);
    await provider.handleMessage({
      type: 'res',
      ok: true,
      payload: {
        protocol: 3,
        features: { methods: ['sessions.messages.subscribe'], events: ['session.message'] },
      },
    }, () => {}, connectionTimer);

    await provider.handleMessage({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'agent:gym:visitor',
        runId: 'turn-old',
        message: { role: 'assistant', content: [{ type: 'text', text: '不应投递' }] },
      },
    }, undefined, connectionTimer);
    await provider.handleMessage({
      type: 'event',
      event: 'session.message',
      payload: {
        sessionKey: 'agent:gym:visitor',
        runId: 'turn-old',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '旧协议回复' }],
          stopReason: 'stop',
        },
      },
    }, undefined, connectionTimer);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(provider._replyProtocol, 'session.message');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '旧协议回复');
    assert.equal(replies[0].turnId, 'turn-old');
  });

  it('旧协议同一 turn 的多个 final 合并为最后一个完整回复', async () => {
    const provider = createProvider();
    const replies = [];
    provider._replyProtocol = 'session.message';
    provider.on('agent.reply', (reply) => replies.push(reply));
    const connectionTimer = setTimeout(() => {}, 1000);
    const event = (text, id) => ({
      type: 'event',
      event: 'session.message',
      payload: {
        sessionKey: 'agent:gym:visitor',
        runId: 'tool-turn-1',
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text }],
          stopReason: 'stop',
        },
      },
    });

    await provider.handleMessage(event('工具调用后的片段', 'reply-1'), undefined, connectionTimer);
    await provider.handleMessage(event('工具调用前的说明。工具调用后的片段', 'reply-2'), undefined, connectionTimer);
    clearTimeout(connectionTimer);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '工具调用前的说明。工具调用后的片段');
    assert.equal(replies[0].turnId, 'tool-turn-1');
    assert.equal(replies[0].replyId, 'reply-2');
  });
});
