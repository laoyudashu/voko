const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { initDatabase } = require('../build/core/database');
const { createDispatcher } = require('../build/core/dispatcher');
const { MessageHandler } = require('../build/core/messenger');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');

describe('Lite reply idempotency end-to-end', () => {
  it('同一 OpenClaw turn 的延迟重复 final 只落库并投递一次', async () => {
    const db = initDatabase(':memory:', { silent: true });
    const provider = new OpenClawWsProvider(null, null);
    const delivered = [];
    const now = Date.now();
    db.prepare(`INSERT INTO agents
      (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, backend_type, agent_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'published', 'public', 'openclaw', ?, ?, ?)`)
      .run('gym-row', 'gym', 'gym-uid', 'token', 'ws://fake', 'Gym', now, now);

    try {
      provider._replyProtocol = 'session.message';
      provider.isAvailable = () => true;
      provider.push = (payload) => {
        provider._sessionTurns.set(
          `agent:${payload.agentId}:${payload.fromUid}`.toLowerCase(),
          { turnId: payload.turnId, timestamp: Date.now() },
        );
      };

      const handler = new MessageHandler(db, {
        deliver: async (...args) => {
          delivered.push(args);
          return { success: true };
        },
      });
      const dispatcher = createDispatcher({
        db,
        providers: { 'openclaw-ws': provider },
        onAgentReply: (reply) => handler.handleAgentReply(reply),
      });
      handler.setDispatcher(dispatcher);

      dispatcher.dispatch('gym', {
        agentId: 'gym',
        fromUid: 'visitor-1',
        senderUid: 'visitor-1',
        content: '什么时候可以健身',
        channelId: 'visitor-1',
        channelType: 1,
        messageId: 'incoming-turn-1',
        timestamp: Math.floor(now / 1000),
      });

      const connectionTimer = setTimeout(() => {}, 1000);
      const finalEvent = (content, replyId) => ({
        type: 'event',
        event: 'session.message',
        payload: {
          sessionKey: 'agent:gym:visitor-1',
          runId: 'backend-run-may-change',
          message: {
            id: replyId,
            role: 'assistant',
            content: [{ type: 'text', text: content }],
            stopReason: 'stop',
          },
        },
      });

      await provider.handleMessage(
        finalEvent('已经在确认时间，请稍等。', 'reply-short'),
        undefined,
        connectionTimer,
      );
      await new Promise((resolve) => setTimeout(resolve, 130));
      await provider.handleMessage(
        finalEvent('我已经在确认时间，请稍等。已经在确认时间，请稍等。', 'reply-full'),
        undefined,
        connectionTimer,
      );
      clearTimeout(connectionTimer);
      await new Promise((resolve) => setTimeout(resolve, 130));

      const rows = db.prepare(
        `SELECT content FROM messages WHERE agent_id = ? AND is_me = 1 ORDER BY timestamp, rowid`,
      ).all('gym');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, '已经在确认时间，请稍等。');
      assert.equal(delivered.length, 2);
      assert.equal(delivered[0][2], '已经在确认时间，请稍等。');
      assert.equal(delivered[1][7]._voko.turnStatus, 'reply_delivered');
    } finally {
      provider.destroy();
      db.close();
    }
  });
});
