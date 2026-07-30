const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');

function createFixture(overrides = {}) {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, backend_type, agent_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'published', 'public', 'mock', ?, ?, ?)`)
    .run('agent-row', 'agent-1', 'agent-uid', 'token', 'ws://fake', 'Agent One', now, now);

  const dispatched = [];
  const delivered = [];
  const notified = [];
  const handler = new MessageHandler(db, {
    dispatcher: {
      dispatch(agentId, payload) {
        dispatched.push({ agentId, payload });
      },
      ...overrides.dispatcher,
    },
    deliver: async (...args) => {
      delivered.push(args);
      return { success: true, via: 'test' };
    },
    notifyUI(event, data) {
      notified.push({ event, data });
    },
    ...overrides,
  });

  return { db, handler, dispatched, delivered, notified };
}

function inbound(overrides = {}) {
  return {
    fromUid: 'visitor-1',
    toUid: 'agent-uid',
    channelId: 'visitor-1',
    channelType: 1,
    contentType: 1,
    content: 'hello agent',
    messageId: 'incoming-1',
    messageSeq: 1,
    clientMsgNo: 'client-1',
    timestamp: 1700000000,
    ...overrides,
  };
}

describe('Lite Messenger contract smoke', () => {
  it('persists and forwards one direct inbound message with stable identifiers', () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound());

      const row = fixture.db.prepare(
        'SELECT id, agent_id, channel_id, channel_type, from_uid, content, message_seq, client_msg_no, is_me FROM messages',
      ).get();
      assert.deepEqual({ ...row }, {
        id: 'incoming-1',
        agent_id: 'agent-1',
        channel_id: 'visitor-1',
        channel_type: 1,
        from_uid: 'visitor-1',
        content: 'hello agent',
        message_seq: 1,
        client_msg_no: 'client-1',
        is_me: 0,
      });
      assert.equal(fixture.dispatched.length, 1);
      assert.equal(fixture.dispatched[0].agentId, 'agent-1');
      assert.equal(fixture.dispatched[0].payload.messageId, 'incoming-1');
      assert.equal(fixture.dispatched[0].payload.channelType, 1);
    } finally {
      fixture.db.close();
    }
  });

  it('keeps group scope, sender and mention metadata when forwarding an @ message', () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        channelId: 'group-1',
        channelType: 2,
        messageId: 'group-incoming-1',
        clientMsgNo: 'group-client-1',
        mention: { all: false, uids: ['agent-uid'] },
      }));

      const row = fixture.db.prepare(
        'SELECT channel_id, channel_type, mention, is_me FROM messages WHERE id=?',
      ).get('group-incoming-1');
      assert.equal(row.channel_id, 'group-1');
      assert.equal(row.channel_type, 2);
      assert.deepEqual(JSON.parse(row.mention), { all: false, uids: ['agent-uid'] });
      assert.equal(row.is_me, 0);

      assert.equal(fixture.dispatched.length, 1);
      const payload = fixture.dispatched[0].payload;
      assert.equal(payload.fromUid, 'visitor-1');
      assert.equal(payload.senderUid, 'visitor-1');
      assert.equal(payload.sessionTarget, 'group:group-1');
      assert.equal(payload.channelId, 'group-1');
      assert.equal(payload.channelType, 2);
      assert.equal(payload.messageId, 'group-incoming-1');
      assert.match(payload.content, /\[VOKO_GROUP_CONTEXT\]/);
    } finally {
      fixture.db.close();
    }
  });

  it('returns a stable offline-forward payload without dispatching, including legacy group routing', () => {
    const fixture = createFixture();
    try {
      const direct = fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'offline-direct-1',
        clientMsgNo: 'offline-client-1',
      }), true);
      const group = fixture.handler.handleAgentMessage('agent-1', inbound({
        channelId: 'group_legacy',
        channelType: 1,
        messageId: 'offline-group-1',
        clientMsgNo: 'offline-group-client-1',
        mention: { uids: ['agent-uid'] },
      }), true);

      assert.deepEqual(direct, {
        agentId: 'agent-1',
        fromUid: 'visitor-1',
        content: 'hello agent',
        channelId: 'visitor-1',
        channelType: 1,
        contentType: 1,
        messageId: 'offline-direct-1',
        timestamp: 1700000000,
      });
      assert.equal(group.channelId, 'group_legacy');
      assert.equal(group.channelType, 2);
      assert.deepEqual(group.mention, { uids: ['agent-uid'] });
      assert.equal(fixture.dispatched.length, 0);
    } finally {
      fixture.db.close();
    }
  });

  it('hard-denies inbound content while soft-deny still forwards, with auditable records', () => {
    const interventions = [];
    const systemMessages = [];
    let action = 'hard_deny';
    const fixture = createFixture({
      databaseAPI: {
        saveOwnerIntervention(record) {
          interventions.push(record);
        },
      },
      enqueueIntervention(record) {
        interventions.push(record);
      },
      sendSystemMessage(...args) {
        systemMessages.push(args);
      },
      checkAuditRules() {
        return {
          action,
          matchedKeyword: 'blocked-word',
          matchedRule: { prompt_key: 'audit.default.sensitive_keyword' },
        };
      },
    });
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'audit-hard-1',
        clientMsgNo: 'audit-hard-client-1',
      }));
      assert.equal(fixture.dispatched.length, 0);
      assert.equal(systemMessages.length, 1);

      const hardRow = fixture.db.prepare(
        'SELECT content_type, content FROM messages WHERE id=?',
      ).get('audit-hard-1');
      const hardContent = JSON.parse(hardRow.content);
      assert.equal(hardRow.content_type, 11);
      assert.equal(hardContent.direction, 'inbound');
      assert.equal(hardContent.action, 'hard_deny');

      action = 'soft_deny';
      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'audit-soft-1',
        clientMsgNo: 'audit-soft-client-1',
      }));
      assert.equal(fixture.dispatched.length, 1);
      assert.equal(fixture.dispatched[0].payload.messageId, 'audit-soft-1');
      assert.equal(interventions.length, 4);
    } finally {
      fixture.db.close();
    }
  });

  it('hard-denies outbound replies while soft-deny still delivers, with auditable records', async () => {
    const interventions = [];
    const systemMessages = [];
    let action = 'hard_deny';
    const fixture = createFixture({
      databaseAPI: {
        saveOwnerIntervention(record) {
          interventions.push(record);
        },
      },
      enqueueIntervention(record) {
        interventions.push(record);
      },
      sendSystemMessage(...args) {
        systemMessages.push(args);
      },
      checkAuditRules(_content, direction) {
        return direction === 'outbound'
          ? { action, matchedKeyword: 'secret', matchedRule: null }
          : { action: 'allow', matchedKeyword: null, matchedRule: null };
      },
    });
    try {
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'hard blocked reply',
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.delivered.length, 0);
      assert.equal(systemMessages.length, 1);

      action = 'soft_deny';
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'soft audited reply',
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.delivered.length, 1);
      assert.equal(fixture.delivered[0][2], 'soft audited reply');
      assert.equal(interventions.length, 4);

      const rows = fixture.db.prepare(
        'SELECT content_type, content FROM messages WHERE agent_id=? AND is_me=1 ORDER BY rowid',
      ).all('agent-1');
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => JSON.parse(row.content).action), [
        'hard_deny',
        'soft_deny',
      ]);
      assert.deepEqual(rows.map((row) => row.content_type), [11, 11]);
    } finally {
      fixture.db.close();
    }
  });

  it('wraps a pending capability reply with the original request ID', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        content: JSON.stringify({
          type: 'voko.capability.request',
          requestId: 'capability-request-1',
          capability: 'calendar',
        }),
        messageId: 'capability-inbound-1',
        clientMsgNo: 'capability-client-1',
      }));
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'capability ready',
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(fixture.delivered.length, 1);
      const deliveredContent = JSON.parse(fixture.delivered[0][2]);
      assert.deepEqual(deliveredContent, {
        type: 'voko.capability.response',
        requestId: 'capability-request-1',
        content: 'capability ready',
      });
      const stored = fixture.db.prepare(
        'SELECT content FROM messages WHERE agent_id=? AND is_me=1 ORDER BY rowid DESC LIMIT 1',
      ).get('agent-1');
      assert.deepEqual(JSON.parse(stored.content), deliveredContent);
    } finally {
      fixture.db.close();
    }
  });

  it('delegates friend-request approval through the configured access-control boundary', () => {
    const calls = [];
    const sendSystemMessage = () => {};
    const fixture = createFixture({
      sendSystemMessage,
      ac: {
        isBlacklisted: () => false,
        isWhitelisted: () => true,
        addEntry: () => {},
        autoApproveIfFriendRequest(...args) {
          calls.push(args);
          return { approved: true };
        },
      },
    });
    try {
      const intervention = { id: 'friend-request-1', visitorId: 'visitor-1' };
      const result = fixture.handler.autoApproveWhitelistIfFriendRequest(
        intervention,
        '同意',
      );
      assert.deepEqual(result, { approved: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], fixture.db);
      assert.equal(calls[0][1], sendSystemMessage);
      assert.equal(calls[0][2], intervention);
      assert.equal(calls[0][3], '同意');
    } finally {
      fixture.db.close();
    }
  });

  it('ignores stream chunks and persists, delivers and notifies only the final reply', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'partial',
        done: false,
        turnId: 'turn-1',
        replyId: 'reply-1',
      });
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'final answer',
        done: true,
        turnId: 'turn-1',
        replyId: 'reply-1',
      });
      await new Promise((resolve) => setImmediate(resolve));

      const rows = fixture.db.prepare(
        'SELECT channel_id, channel_type, content, is_me FROM messages WHERE agent_id=? ORDER BY rowid',
      ).all('agent-1');
      assert.equal(rows.length, 1);
      assert.deepEqual({ ...rows[0] }, {
        channel_id: 'visitor-1',
        channel_type: 1,
        content: 'final answer',
        is_me: 1,
      });
      assert.equal(fixture.delivered.length, 1);
      assert.equal(fixture.delivered[0][1], 'visitor-1');
      assert.equal(fixture.delivered[0][2], 'final answer');
      assert.equal(fixture.delivered[0][4], 1);
      assert.equal(fixture.notified.length, 1);
      assert.equal(fixture.notified[0].data.content, 'final answer');
    } finally {
      fixture.db.close();
    }
  });
});
