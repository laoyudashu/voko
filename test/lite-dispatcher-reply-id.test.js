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
  it('同一 turn 的重复 final 只向下游投递一次，且不消费下一轮上下文', () => {
    const provider = new ReplyProvider();
    const replies = [];
    const dispatcher = createDispatcher({
      db: createDb(),
      providers: { provider },
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

    assert.equal(provider.payloads[0].turnId, 'turn-1');
    assert.equal(provider.payloads[1].turnId, 'turn-2');

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
    provider.emit('agent.reply', {
      agentId: 'gym',
      visitorId: 'visitor',
      content: 'first reply',
      done: true,
      sessionKey: 'agent:gym:visitor',
      turnId: 'turn-2',
      replyId: 'reply-2',
    });

    assert.equal(replies.length, 2);
    assert.equal(replies[0].senderUid, 'sender-1');
    assert.equal(replies[1].senderUid, 'sender-2');
    assert.equal(replies[1].content, 'first reply');
  });

  it('流式中间块不占用 final 幂等键', () => {
    const provider = new ReplyProvider();
    const replies = [];
    createDispatcher({
      db: createDb(),
      providers: { provider },
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
