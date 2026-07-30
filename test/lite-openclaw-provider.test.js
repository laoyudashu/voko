const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');

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
    assert.equal(sent[0].params.sessionKey, 'agent:gym:visitorabc');
    const message = JSON.parse(sent[0].params.message);
    assert.equal(message.content, 'hello');
    assert.equal(message.fromUid, 'sender-1');
    assert.equal(message.messageId, 'message-1');
    assert.equal(
      provider._caseMap.get('agent:gym:visitorabc'),
      'agent:Gym:VisitorABC',
    );
    assert.equal(
      provider._sessionTurns.get('agent:gym:visitorabc').turnId,
      'message-1',
    );
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
