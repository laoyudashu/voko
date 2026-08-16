'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseAPI, initDatabase } = require('../build/core/database');
const { MessageRouteStore, RoutingConversationStore } = require('../build/core/provider-routing');
const { resolveOwnerInterventionConversation } = require('../build/core/owner-intervention-routing');

test('owner intervention resolution follows turn, source, explicit, unique priority', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const conversations = new RoutingConversationStore(db);
    const routes = new MessageRouteStore(db);
    const turn = conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
      providerInstanceKey: 'instance-a', nativeSessionId: 'session-turn', channelId: 'visitor-a', channelType: 1 });
    const source = conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
      providerInstanceKey: 'instance-a', nativeSessionId: 'session-source', channelId: 'visitor-a', channelType: 1 });
    const sourceRoute = routes.createPending({ messageId: 'message-source', conversationId: source.id,
      agentId: 'agent-a', peerUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, direction: 'inbound' });
    routes.setStatus(sourceRoute, 'active');
    const input = { agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
      caller: { providerType: 'codex', providerInstanceId: 'instance-a', nativeSessionId: 'session-turn', evidence: 'provider_env' },
      sourceMessageId: 'message-source', conversationId: source.id };
    assert.deepEqual(resolveOwnerInterventionConversation(db, input),
      { status: 'resolved', conversationId: turn.id, method: 'current_turn' });
    assert.deepEqual(resolveOwnerInterventionConversation(db, { ...input, caller: null }),
      { status: 'resolved', conversationId: source.id, method: 'source_message' });
    assert.deepEqual(resolveOwnerInterventionConversation(db, { ...input, caller: null, sourceMessageId: null }),
      { status: 'resolved', conversationId: source.id, method: 'explicit' });
  } finally { db.close(); }
});

test('owner intervention requires an explicit selection when the scope has multiple conversations', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const conversations = new RoutingConversationStore(db);
    const first = conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
      nativeSessionId: 'session-1', channelId: 'visitor-a', channelType: 1 });
    const second = conversations.resolveOrCreate({ agentId: 'agent-a', providerFamily: 'codex',
      nativeSessionId: 'session-2', channelId: 'visitor-a', channelType: 1 });
    const result = resolveOwnerInterventionConversation(db, { agentId: 'agent-a', channelId: 'visitor-a' });
    assert.equal(result.status, 'selection_required');
    assert.deepEqual(new Set(result.candidateConversationIds), new Set([first.id, second.id]));
    const saved = createDatabaseAPI(db).saveOwnerIntervention({ id: 'intervention-a', agentId: 'agent-a',
      visitorId: 'visitor-a', targetChannelId: 'visitor-a', targetChannelType: 1,
      sessionKey: 'agent:agent-a:visitor-a', problem: 'choose', askTime: Date.now(),
      createdAt: Date.now(), updatedAt: Date.now() });
    assert.equal(saved.success, false);
    assert.equal(saved.code, 'CONVERSATION_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM owner_interventions WHERE id=?')
      .get('intervention-a').count, 0);
  } finally { db.close(); }
});
