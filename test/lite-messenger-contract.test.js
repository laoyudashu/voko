const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const { RoutingConversationStore } = require('../build/core/provider-routing');

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
  const systemMessages = [];
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
    sendSystemMessage(...args) {
      systemMessages.push(args);
    },
    ...overrides,
  });

  return { db, handler, dispatched, delivered, notified, systemMessages };
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
  it('marks an expired timed session as handled after sending its system response', () => {
    const systemMessages = [];
    const fixture = createFixture({ sendSystemMessage: (...args) => systemMessages.push(args) });
    try {
      const now = Date.now();
      fixture.db.prepare(`INSERT INTO agent_pricing
        (id, agent_id, pricing_model, price, duration_minutes, trial_minutes, enabled, created_at, updated_at)
        VALUES (?, ?, 'timed', ?, ?, ?, 1, ?, ?)`).run('pricing-1', 'agent-1', 0.01, 60, 3, now, now);
      fixture.db.prepare(`INSERT INTO conversations
        (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id,
          session_status, session_expire_at)
        VALUES (?, ?, 1, ?, '', ?, 0, ?, 'expired', ?)`).run(
          'agent-uid', 'visitor-1', 'visitor-1', Math.floor(now / 1000), 'agent-1', now - 1);
      const message = inbound();

      const projected = fixture.handler.handleAgentMessage('agent-1', message, true);

      assert.equal(projected, undefined);
      assert.equal(message._vokoInboundIntercepted, 'session_expired');
      assert.equal(systemMessages.length, 1);
      assert.equal(systemMessages[0][2], 'session_expired');
      assert.equal(fixture.dispatched.length, 0);
    } finally {
      fixture.db.close();
    }
  });

  it('does not persist or deliver Provider internal errors as Agent replies', async () => {
    const fixture = createFixture();
    try {
      const internalErrors = [
        'Ran into this error: Request failed: Bad request (400): The `reasoning_content` in the thinking mode must be passed back to the API.\n\nPlease retry if you think this is a transient or recoverable error.',
        'API call failed after 3 retries: Connection error.',
        'I stopped retrying terminal because it hit the tool-call guardrail (same_tool_failure_halt) after 4 repeated non-progressing attempts.',
      ];
      for (const content of internalErrors) {
        await fixture.handler.handleAgentReply({ agentId: 'agent-1', visitorId: 'visitor-1', content });
      }
      assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM messages').get().count, 0);
      assert.equal(fixture.delivered.length, 0);
    } finally {
      fixture.db.close();
    }
  });

  it('projects a deterministic E2EE reply into the UI only once', () => {
    const fixture = createFixture();
    try {
      fixture.handler.persistE2eeAgentReply('agent-1', 'visitor-1', 'encrypted reply', 'e2ee-reply-1');
      fixture.handler.persistE2eeAgentReply('agent-1', 'visitor-1', 'encrypted reply', 'e2ee-reply-1');
      assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM messages WHERE id='e2ee-reply-1'").get().count, 1);
      assert.equal(fixture.notified.filter(row => row.event === 'agent-wukongim:message').length, 1);
    } finally {
      fixture.db.close();
    }
  });

  it('projects an E2EE request and reply onto the unique active Web conversation', () => {
    const fixture = createFixture();
    try {
      const conversation = new RoutingConversationStore(fixture.db).resolveOrCreate({
        agentId: 'agent-1', providerFamily: 'openclaw', providerInstanceKey: '',
        nativeSessionId: 'e2ee-native-session', channelId: 'visitor-1', channelType: 1,
      });
      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'e2ee-inbound-route', clientMsgNo: 'e2ee-inbound-client',
      }), true);
      const inboundRoute = fixture.db.prepare(`SELECT conversation_id,status FROM provider_message_routes
        WHERE message_id='e2ee-inbound-route' AND direction='inbound'`).get();
      assert.equal(inboundRoute.conversation_id, conversation.id);
      assert.equal(inboundRoute.status, 'active');

      fixture.handler.persistE2eeAgentReply('agent-1', 'visitor-1', 'encrypted reply',
        'e2ee-outbound-route', 'e2ee-inbound-route');
      const pending = fixture.db.prepare(`SELECT conversation_id,status FROM provider_message_routes
        WHERE message_id='e2ee-outbound-route' AND direction='outbound'`).get();
      assert.equal(pending.conversation_id, conversation.id);
      assert.equal(pending.status, 'pending');
      fixture.handler.markE2eeAgentReplyDelivered('agent-1', 'e2ee-outbound-route');
      assert.equal(fixture.db.prepare(`SELECT status FROM provider_message_routes
        WHERE message_id='e2ee-outbound-route' AND direction='outbound'`).get().status, 'active');
    } finally {
      fixture.db.close();
    }
  });

  it('keeps an E2EE Agent peer out of foreign local Route Context and ordinary Provider dispatch', () => {
    const fixture = createFixture();
    try {
      const now = Date.now();
      fixture.db.prepare(`INSERT INTO agents
        (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,agent_name,created_at,updated_at)
        VALUES (?,?,?,?,?,'published','public','goose',?,?,?)`)
        .run('peer-row','peer-agent','peer-agent-uid','token','ws://fake','Peer Agent',now,now);
      const conversation = new RoutingConversationStore(fixture.db).resolveOrCreate({
        agentId: 'agent-1', providerFamily: 'openclaw', providerInstanceKey: '',
        nativeSessionId: 'ordinary-native-session', channelId: 'peer-agent-uid', channelType: 1,
      });
      const projected = fixture.handler.handleAgentMessage('agent-1', inbound({
        fromUid: 'peer-agent-uid', channelId: 'peer-agent-uid', messageId: 'e2ee-peer-projection',
        clientMsgNo: 'e2ee-peer-business', content: 'agent peer request',
        _voko: { protocolVersion: 1, routeId: 'foreign-route-id',
          canonicalConversationKey: 'foreign-conversation-key' },
        e2eeAgentPeer: true, e2eeStrictRoute: false,
        e2eeProtocolConversationId: '67ad73dc-bc3d-4463-8e5b-7637765935f4',
      }), true);
      assert.equal(projected.messageId, 'e2ee-peer-projection');
      assert.equal(fixture.dispatched.length, 0);
      const mirrorRoute = fixture.db.prepare(`SELECT r.conversation_id,c.wire_conversation_key,c.provider_family,
        c.native_session_id FROM provider_message_routes r JOIN provider_routing_conversations c
          ON c.id=r.conversation_id WHERE r.message_id='e2ee-peer-projection'`).get();
      assert.equal(mirrorRoute.wire_conversation_key, '67ad73dc-bc3d-4463-8e5b-7637765935f4');
      assert.equal(mirrorRoute.provider_family, null);
      assert.equal(mirrorRoute.native_session_id, null);
      assert.equal(new RoutingConversationStore(fixture.db).getForScope(
        conversation.id, 'agent-1', 'peer-agent-uid', 1).id, conversation.id);
    } finally {
      fixture.db.close();
    }
  });

  it('propagates a primary message persistence failure so the transport can NACK', () => {
    const fixture = createFixture();
    const originalPrepare = fixture.db.prepare.bind(fixture.db);
    fixture.db.prepare = (sql) => {
      if (/INSERT INTO messages/i.test(String(sql))) throw new Error('database unavailable');
      return originalPrepare(sql);
    };
    try {
      assert.throws(
        () => fixture.handler.handleAgentMessage('agent-1', inbound()),
        /database unavailable/,
      );
    } finally {
      fixture.db.close();
    }
  });

  it('persists and forwards one direct inbound message with stable identifiers', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound());
      await fixture.handler.flushInboundTurns();

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

  it('coalesces three consecutive direct messages into one Provider turn', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({ messageId: 'turn-m1', clientMsgNo: 'turn-c1', content: 'first' }));
      fixture.handler.handleAgentMessage('agent-1', inbound({ messageId: 'turn-m2', clientMsgNo: 'turn-c2', content: 'second' }));
      fixture.handler.handleAgentMessage('agent-1', inbound({ messageId: 'turn-m3', clientMsgNo: 'turn-c3', content: 'third' }));
      await fixture.handler.flushInboundTurns();

      assert.equal(fixture.dispatched.length, 1);
      assert.deepEqual(fixture.dispatched[0].payload.sourceMessageIds, ['turn-m1', 'turn-m2', 'turn-m3']);
      assert.equal(fixture.dispatched[0].payload.messageSegments.length, 3);
      assert.match(fixture.dispatched[0].payload.content, /\[Message 1\]\nfirst/);
      assert.match(fixture.dispatched[0].payload.content, /\[Message 3\]\nthird/);
    } finally {
      fixture.db.close();
    }
  });

  it('announces timed pricing and starts the trial on the first inbound message', async () => {
    const fixture = createFixture();
    try {
      const now = Date.now();
      fixture.db.prepare(`INSERT INTO agent_pricing
        (id, agent_id, pricing_model, price, duration_minutes, trial_minutes, enabled, created_at, updated_at)
        VALUES (?, ?, 'timed', ?, ?, ?, 1, ?, ?)`)
        .run('pricing-1', 'agent-1', 0.01, 60, 3, now, now);

      fixture.handler.handleAgentMessage('agent-1', inbound());
      await fixture.handler.flushInboundTurns();

      assert.equal(fixture.systemMessages.length, 1);
      assert.equal(fixture.systemMessages[0][2], 'trial_welcome');
      assert.deepEqual(fixture.systemMessages[0][3], {
        trialMinutes: 3,
        price: 0.01,
        durationMinutes: 60,
      });
      const conversation = fixture.db.prepare(
        'SELECT session_status, session_expire_at FROM conversations WHERE user_uid=? AND channel_id=?',
      ).get('agent-uid', 'visitor-1');
      assert.equal(conversation.session_status, 'active');
      assert.ok(conversation.session_expire_at > now);
      assert.equal(fixture.dispatched.length, 1);
    } finally {
      fixture.db.close();
    }
  });

  it('stays silent before timed service expiry and notifies only after expiry', async () => {
    const fixture = createFixture();
    try {
      const now = Date.now();
      fixture.db.prepare(`INSERT INTO agent_pricing
        (id, agent_id, pricing_model, price, duration_minutes, trial_minutes, enabled, created_at, updated_at)
        VALUES (?, ?, 'timed', ?, ?, ?, 1, ?, ?)`)
        .run('pricing-1', 'agent-1', 0.01, 60, 3, now, now);

      fixture.handler.handleAgentMessage('agent-1', inbound());
      await fixture.handler.flushInboundTurns();
      fixture.db.prepare(`UPDATE conversations SET session_expire_at=?
        WHERE user_uid=? AND channel_id=?`).run(Date.now() + 30000, 'agent-uid', 'visitor-1');
      fixture.systemMessages.length = 0;
      fixture.dispatched.length = 0;

      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'incoming-2', messageSeq: 2, clientMsgNo: 'client-2',
      }));
      await fixture.handler.flushInboundTurns();
      assert.equal(fixture.systemMessages.length, 0);
      assert.equal(fixture.dispatched.length, 1);

      fixture.db.prepare(`UPDATE conversations SET session_expire_at=?
        WHERE user_uid=? AND channel_id=?`).run(Date.now() - 1, 'agent-uid', 'visitor-1');
      fixture.systemMessages.length = 0;
      fixture.dispatched.length = 0;

      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'incoming-3', messageSeq: 3, clientMsgNo: 'client-3',
      }));
      await fixture.handler.flushInboundTurns();
      assert.equal(fixture.systemMessages.length, 1);
      assert.equal(fixture.systemMessages[0][2], 'session_expired');
      assert.equal(fixture.dispatched.length, 0);
      assert.equal(fixture.db.prepare(`SELECT session_status FROM conversations
        WHERE user_uid=? AND channel_id=?`).get('agent-uid', 'visitor-1').session_status, 'expired');
    } finally {
      fixture.db.close();
    }
  });

  it('keeps a Chatroom canonical conversation key on the same Web conversation', async () => {
    const fixture = createFixture();
    try {
      const store = new RoutingConversationStore(fixture.db);
      const pending = store.createPending({ agentId: 'agent-1', channelId: 'visitor-1', channelType: 1 });
      fixture.handler.handleAgentMessage('agent-1', inbound({
        messageId: 'canonical-inbound-1',
        clientMsgNo: 'canonical-client-1',
        _voko: { protocolVersion: 1, routeId: 'canonical-route-12345678901234567890',
          canonicalConversationKey: pending.wireConversationKey },
      }));
      await fixture.handler.flushInboundTurns();

      const inboundRoute = fixture.db.prepare(`SELECT conversation_id,status FROM provider_message_routes
        WHERE message_id='canonical-inbound-1' AND direction='inbound'`).get();
      assert.equal(inboundRoute.conversation_id, pending.id);
      assert.equal(inboundRoute.status, 'active');
      assert.equal(fixture.dispatched[0].payload.remoteConversationKey, pending.wireConversationKey);

      await fixture.handler.handleAgentReply({ agentId: 'agent-1', visitorId: 'visitor-1',
        channelId: 'visitor-1', channelType: 1, content: 'canonical reply',
        remoteConversationKey: pending.wireConversationKey, remoteRouteId: 'canonical-route-12345678901234567890' });
      const outboundRoute = fixture.db.prepare(`SELECT conversation_id FROM provider_message_routes
        WHERE direction='outbound' ORDER BY created_at DESC LIMIT 1`).get();
      assert.equal(outboundRoute.conversation_id, pending.id);
    } finally {
      fixture.db.close();
    }
  });

  it('binds the exact triggering inbound message after the Provider turn confirms its conversation', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({ messageId: 'trigger-exact' }));
      fixture.handler.handleAgentMessage('agent-1', inbound({ messageId: 'trigger-ambiguous', clientMsgNo: 'client-2' }));
      const conversation = new RoutingConversationStore(fixture.db).resolveOrCreate({
        agentId: 'agent-1', providerFamily: 'openclaw', providerInstanceKey: '',
        nativeSessionId: 'agent:agent-1:session-exact', channelId: 'visitor-1', channelType: 1,
      });

      await fixture.handler.handleAgentReply({ agentId: 'agent-1', visitorId: 'visitor-1',
        channelId: 'visitor-1', channelType: 1, content: 'exact reply', sourceMessageId: 'trigger-exact',
        sourceRouteClaimSafe: true, replyRouteContext: { conversationId: conversation.id,
          providerFamily: 'openclaw', providerInstanceKey: '', nativeSessionId: 'agent:agent-1:session-exact',
          strictSessionRoute: true } });
      await fixture.handler.handleAgentReply({ agentId: 'agent-1', visitorId: 'visitor-1',
        channelId: 'visitor-1', channelType: 1, content: 'ambiguous reply', sourceMessageId: 'trigger-ambiguous',
        sourceRouteClaimSafe: false, replyRouteContext: { conversationId: conversation.id,
          providerFamily: 'openclaw', providerInstanceKey: '', nativeSessionId: 'agent:agent-1:session-exact',
          strictSessionRoute: true } });

      const exact = fixture.db.prepare(`SELECT conversation_id,status FROM provider_message_routes
        WHERE message_id='trigger-exact' AND direction='inbound'`).get();
      const ambiguous = fixture.db.prepare(`SELECT conversation_id FROM provider_message_routes
        WHERE message_id='trigger-ambiguous' AND direction='inbound'`).get();
      assert.equal(exact.conversation_id, conversation.id);
      assert.equal(exact.status, 'active');
      assert.equal(ambiguous, undefined);
    } finally {
      fixture.db.close();
    }
  });

  it('keeps group scope, sender and mention metadata when forwarding an @ message', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        channelId: 'group-1',
        channelType: 2,
        messageId: 'group-incoming-1',
        clientMsgNo: 'group-client-1',
        mention: { all: false, uids: ['agent-uid'] },
      }));
      await fixture.handler.flushInboundTurns();

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
        _voko: { protocolVersion: 1, routeId: 'route-direct' },
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
        _voko: { protocolVersion: 1, routeId: 'route-direct' },
      });
      assert.equal(group.channelId, 'group_legacy');
      assert.equal(group.channelType, 2);
      assert.deepEqual(group.mention, { uids: ['agent-uid'] });
      assert.equal(fixture.dispatched.length, 0);
    } finally {
      fixture.db.close();
    }
  });

  it('hard-denies inbound content while soft-deny still forwards, with auditable records', async () => {
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
      await fixture.handler.flushInboundTurns();
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

  it('marks a successfully delivered Agent reply as sent', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'visitor-1',
        content: 'delivered reply',
      });
      await new Promise((resolve) => setImmediate(resolve));
      const row = fixture.db.prepare(
        'SELECT status FROM messages WHERE agent_id=? AND is_me=1 ORDER BY rowid DESC LIMIT 1',
      ).get('agent-1');
      assert.equal(row.status, 'sent');
    } finally {
      fixture.db.close();
    }
  });

  it('delegates friend-request approval through the configured access-control boundary', () => {
    const calls = [];
    const notifications = [];
    const sendSystemMessage = (...args) => { notifications.push(args); };
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
      const intervention = { id: 'friend-request-1', visitorId: 'visitor-1', routingConversationId: 'conversation-1' };
      const result = fixture.handler.autoApproveWhitelistIfFriendRequest(
        intervention,
        '同意',
      );
      assert.deepEqual(result, { approved: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], fixture.db);
      calls[0][1]('agent-1', 'visitor-1', 'whitelist_enabled', {}, 1);
      assert.equal(notifications[0][5].conversationId, 'conversation-1');
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

  it('delivers only the FINAL block from an A2A reply', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'peer-agent-uid',
        content: '[STATE]{"agenda":[],"expects_reply":false,"converged":true}[/STATE]\nInternal protocol note.\n[FINAL]协商已完成。[/FINAL]',
        a2aManaged: true,
        a2aPeerUid: 'peer-agent-uid',
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(fixture.delivered.length, 1);
      assert.equal(fixture.delivered[0][2], '协商已完成。');
      const stored = fixture.db.prepare(
        'SELECT content FROM messages WHERE agent_id=? AND is_me=1 ORDER BY rowid DESC LIMIT 1',
      ).get('agent-1');
      assert.equal(stored.content, '协商已完成。');
    } finally {
      fixture.db.close();
    }
  });

  it('drops legacy A2A protocol narration instead of exposing it', async () => {
    const fixture = createFixture();
    try {
      fixture.handler.handleAgentReply({
        agentId: 'agent-1',
        visitorId: 'peer-agent-uid',
        content: 'Peer 已划清文字闲聊边界并询问问题；按 A2A 规则回复 STATE，不推动支付。',
        a2aManaged: true,
        a2aPeerUid: 'peer-agent-uid',
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(fixture.delivered.length, 0);
      assert.equal(fixture.db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE agent_id=? AND is_me=1',
      ).get('agent-1').count, 0);
    } finally {
      fixture.db.close();
    }
  });

  it('never sends Provider processing or failure status back to an Agent peer', async () => {
    const fixture = createFixture({ dispatcher: { isAgentImUid: uid => uid === 'agent-peer' } });
    const projected = [];
    fixture.handler.handleAgentReply = async data => { projected.push(data); };
    try {
      await fixture.handler.handleProviderTurnStatus({
        agentId: 'agent-1', visitorId: 'agent-peer', senderUid: 'agent-peer',
        status: 'processing', turnId: 'agent-turn',
      });
      await fixture.handler.handleProviderTurnStatus({
        agentId: 'agent-1', visitorId: 'visitor-1', senderUid: 'visitor-1',
        status: 'timeout', turnId: 'visitor-turn',
      });
      assert.equal(projected.length, 1);
      assert.equal(projected[0].content, 'Agent 调用超时，请稍后重试');
    } finally {
      fixture.db.close();
    }
  });

  it('returns hidden receipts using the sender client message id and never persists them as chat', async () => {
    const fixture = createFixture({ dispatcher: { isAgentImUid: uid => uid === 'agent-peer' } });
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        fromUid: 'agent-peer', channelId: 'agent-peer', messageId: 'receiver-local-id',
        clientMsgNo: 'sender-message-id', _voko: { protocolVersion: 1, turnReceiptRequest: { version: 1 } },
      }), true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fixture.delivered.length, 1);
      assert.equal(fixture.delivered[0][2], '');
      assert.deepEqual(fixture.delivered[0][7]._voko.turnReceipt.sourceMessageIds, ['sender-message-id']);
      assert.equal(fixture.delivered[0][7]._voko.turnReceipt.state, 'SUBMITTED');
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE content='' AND is_me=1").get().count, 0);

      await fixture.handler.handleProviderTurnStatus({
        agentId: 'agent-1', visitorId: 'agent-peer', senderUid: 'agent-peer',
        status: 'timeout', turnId: 'turn-1', sourceMessageIds: ['receiver-local-id'],
      });
      assert.equal(fixture.delivered.length, 2);
      assert.deepEqual(fixture.delivered[1][7]._voko.turnReceipt.sourceMessageIds, ['sender-message-id']);
      assert.equal(fixture.delivered[1][7]._voko.turnReceipt.reasonCode, 'PROVIDER_TIMEOUT');
    } finally {
      fixture.db.close();
    }
  });

  it('intercepts malformed and out-of-scope hidden receipts before persistence', () => {
    const fixture = createFixture({ dispatcher: { isAgentImUid: uid => uid === 'agent-peer' } });
    try {
      fixture.handler.handleAgentMessage('agent-1', inbound({
        fromUid: 'agent-peer', channelId: 'agent-peer', messageId: 'malformed-receipt',
        _voko: { protocolVersion: 1, turnReceipt: { version: 1, sourceMessageIds: [] } },
      }));
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id='malformed-receipt'").get().count, 0);
      assert.equal(fixture.dispatched.length, 0);
    } finally {
      fixture.db.close();
    }
  });
});
