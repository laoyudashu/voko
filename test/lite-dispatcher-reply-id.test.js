const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createDispatcher } = require('../build/core/dispatcher');

class ReplyProvider extends EventEmitter {
  constructor() {
    super();
    this.payloads = [];
  }

  get priority() { return 10; }
  match() { return true; }
  isAvailable() { return true; }
  push(payload) { this.payloads.push(payload); }
}

function createDb() {
  return {
    prepare() {
      return {
        get: () => ({ backend_type: 'mock', imUid: 'agent-uid' }),
        all: () => [],
        run: () => ({ changes: 1 }),
      };
    },
  };
}

describe('Dispatcher final reply idempotency', () => {
  it('filters explicit reasoning blocks and rejects output without a final-answer boundary', async () => {
    const provider = new ReplyProvider();
    const replies = [];
    const statuses = [];
    const dispatcher = createDispatcher({
      db: createDb(),
      providers: { 'mock-echo': provider },
      onAgentReply: reply => replies.push(reply),
      onTurnStatus: status => statuses.push(status),
    });

    dispatcher.dispatch('gym', {
      agentId: 'gym', fromUid: 'visitor', content: 'first', channelId: 'visitor',
      channelType: 1, senderUid: 'sender-1', messageId: 'turn-reasoning-closed',
    });
    dispatcher.dispatch('gym', {
      agentId: 'gym', fromUid: 'visitor', content: 'second', channelId: 'visitor',
      channelType: 1, senderUid: 'sender-1', messageId: 'turn-reasoning-open',
    });
    await new Promise(resolve => setImmediate(resolve));

    provider.emit('agent.reply', {
      agentId: 'gym', visitorId: 'visitor', done: true,
      content: '<think>private chain of thought</think>\n'
        + '┌─ Reasoning ───┐\nprivate recap\n└────────────────┘\nVisible answer',
      turnId: 'turn-reasoning-closed', replyId: 'reply-reasoning-closed',
    });
    provider.emit('agent.reply', {
      agentId: 'gym', visitorId: 'visitor', done: true,
      content: '┌─ Reasoning ───────────────────┐\nprivate chain of thought\nVisible but ambiguous answer',
      turnId: 'turn-reasoning-open', replyId: 'reply-reasoning-open',
    });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, 'Visible answer');
    assert.ok(statuses.some(status => status.status === 'failed'
      && status.code === 'PROVIDER_OUTPUT_UNPARSEABLE'
      && status.turnId === 'turn-reasoning-open'));
  });

  it('同一 turn 的重复 final 只向下游投递一次，且不消费下一轮上下文', async () => {
    const provider = new ReplyProvider();
    const replies = [];
    const dispatcher = createDispatcher({
      db: createDb(),
      providers: { 'mock-echo': provider },
      onAgentReply: (reply) => replies.push(reply),
    });

    dispatcher.dispatch('gym', {
      agentId: 'gym',
      fromUid: 'visitor',
      content: 'first',
      channelId: 'visitor',
      channelType: 1,
      senderUid: 'sender-1',
      messageId: 'turn-1',
    });
    dispatcher.dispatch('gym', {
      agentId: 'gym',
      fromUid: 'visitor',
      content: 'second',
      channelId: 'visitor',
      channelType: 1,
      senderUid: 'sender-2',
      messageId: 'turn-2',
    });

    await new Promise(resolve => setImmediate(resolve));

    assert.equal(provider.payloads[0].turnId, 'turn-1');
    assert.equal(provider.payloads[1].turnId, 'turn-2');

    provider.emit('agent.reply', {
      agentId: 'gym',
      visitorId: 'visitor',
      content: 'second reply',
      done: true,
      sessionKey: 'agent:gym:visitor',
      turnId: 'turn-2',
      replyId: 'reply-2',
    });
    provider.emit('agent.reply', {
      agentId: 'gym',
      visitorId: 'visitor',
      content: 'first reply',
      done: true,
      sessionKey: 'agent:gym:visitor',
      turnId: 'turn-1',
      replyId: 'reply-1',
    });
    provider.emit('agent.reply', {
      agentId: 'gym',
      visitorId: 'visitor',
      content: 'duplicate first reply',
      done: true,
      sessionKey: 'agent:gym:visitor',
      turnId: 'turn-1',
      replyId: 'reply-1b',
    });

    assert.equal(replies.length, 2);
    assert.equal(replies[0].senderUid, 'sender-2');
    assert.equal(replies[0].sourceMessageId, 'turn-2');
    assert.equal(replies[0].sourceRouteClaimSafe, true);
    assert.equal(replies[0].content, 'second reply');
    assert.equal(replies[1].senderUid, 'sender-1');
    assert.equal(replies[1].sourceMessageId, 'turn-1');
    assert.equal(replies[1].sourceRouteClaimSafe, true);
    assert.equal(replies[1].content, 'first reply');

    dispatcher.dispatch('gym', {
      agentId: 'gym', fromUid: 'visitor', content: 'third', channelId: 'visitor',
      channelType: 1, senderUid: 'sender-3', messageId: 'turn-3',
    });
    provider.emit('agent.reply', {
      agentId: 'gym', visitorId: 'visitor', content: 'late reply', done: true,
      sessionKey: 'agent:gym:visitor', turnId: 'unknown-turn', replyId: 'late-reply',
    });
    assert.equal(replies[2].senderUid, undefined, 'unknown turn must not consume the FIFO context');
    assert.equal(replies[2].sourceMessageId, undefined);
    assert.equal(replies[2].content, 'late reply');
  });

  it('does not authorize an inbound route claim when a reply lacks turn identity and multiple turns are pending', async () => {
    const provider = new ReplyProvider();
    const replies = [];
    const dispatcher = createDispatcher({ db: createDb(), providers: { 'mock-echo': provider },
      onAgentReply: (reply) => replies.push(reply) });
    dispatcher.dispatch('gym', { agentId: 'gym', fromUid: 'visitor', content: 'first',
      channelId: 'visitor', channelType: 1, messageId: 'ambiguous-1' });
    dispatcher.dispatch('gym', { agentId: 'gym', fromUid: 'visitor', content: 'second',
      channelId: 'visitor', channelType: 1, messageId: 'ambiguous-2' });
    await new Promise(resolve => setImmediate(resolve));

    provider.emit('agent.reply', { agentId: 'gym', visitorId: 'visitor', content: 'reply without turn',
      done: true, sessionKey: 'agent:gym:visitor' });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].sourceMessageId, 'ambiguous-1');
    assert.equal(replies[0].sourceRouteClaimSafe, false);
  });

  it('流式中间块不占用 final 幂等键', () => {
    const provider = new ReplyProvider();
    const replies = [];
    createDispatcher({
      db: createDb(),
      providers: { 'mock-echo': provider },
      onAgentReply: (reply) => replies.push(reply),
    });

    provider.emit('agent.reply', {
      agentId: 'gym', visitorId: 'visitor', content: 'partial',
      done: false, turnId: 'turn-stream', replyId: 'reply-stream',
    });
    provider.emit('agent.reply', {
      agentId: 'gym', visitorId: 'visitor', content: 'complete',
      done: true, turnId: 'turn-stream', replyId: 'reply-stream',
    });

    assert.equal(replies.length, 2);
    assert.equal(replies[1].content, 'complete');
  });
});
