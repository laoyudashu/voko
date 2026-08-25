const test = require('node:test');
const assert = require('node:assert/strict');

const { createResumeOwnerIntervention } = require('../build');
const {
  registerActiveOwnerInterventionContext,
  resolveActiveOwnerInterventionContext,
} = require('../build/core/owner-intervention-active-context');

test('active E2EE intervention context resolves uniquely and rejects ambiguity', () => {
  const releaseA = registerActiveOwnerInterventionContext({
    agentId: 'gym', channelId: 'actor-a', protocolConversationId: 'protocol-a',
    sessionScopeId: 'scope-a', sourceMessageId: 'source-a',
  });
  assert.equal(resolveActiveOwnerInterventionContext('gym').context.channelId, 'actor-a');
  const releaseB = registerActiveOwnerInterventionContext({
    agentId: 'gym', channelId: 'actor-b', protocolConversationId: 'protocol-b',
    sessionScopeId: 'scope-b', sourceMessageId: 'source-b',
  });
  assert.equal(resolveActiveOwnerInterventionContext('gym').status, 'ambiguous');
  assert.equal(resolveActiveOwnerInterventionContext('gym', 'source-b').context.channelId, 'actor-b');
  releaseB();
  releaseA();
  assert.equal(resolveActiveOwnerInterventionContext('gym').status, 'unavailable');
});

test('E2EE owner intervention captures Agent reply and sends it through the original encrypted route', async () => {
  const updates = [];
  const db = { prepare(sql) { return {
    get() { return undefined; },
    run(...args) { updates.push([sql, args]); return { changes: 1 }; },
  }; } };
  const dispatcher = {
    async executeOwnerIntervention(_agentId, _visitorId, _content, context) {
      assert.equal(context.interventionId, 'oi-e2ee');
      return { reply: { content: '主人确认 10:30', done: true }, receipt: { accepted: true } };
    },
  };
  const persisted = [];
  const delivered = [];
  const messageHandler = {
    persistE2eeAgentReply(agentId, channelId, content, messageId, sourceMessageId) {
      persisted.push({ agentId, channelId, content, messageId, sourceMessageId });
      return { routeMetadata: { _voko: { canonicalConversationKey: 'protocol-original' } } };
    },
    markE2eeAgentReplyDelivered(agentId, messageId) { delivered.push([agentId, messageId]); },
  };
  const secureOutboundRouter = {
    async deliver(agentId, channelId, content, _type, _channelType, _mentions, messageId, _metadata, internal) {
      assert.equal(agentId, 'gym');
      assert.equal(channelId, 'actor-original');
      assert.equal(content, '主人确认 10:30');
      assert.equal(internal.protocolConversationId, 'protocol-original');
      assert.equal(internal.sourceReceiptMessageId, 'source-original');
      return { success: true, securityMode: 'e2ee', deliveryState: 'delivered', messageId };
    },
  };
  const resume = createResumeOwnerIntervention(dispatcher, db, secureOutboundRouter, messageHandler);
  const result = await resume({
    id: 'oi-e2ee', agentId: 'gym', visitorId: 'logical-visitor',
    targetChannelId: 'actor-original', targetChannelType: 1,
    sourceMessageId: 'source-original', routeSecurityMode: 'e2ee_v2',
    e2eeProtocolConversationId: 'protocol-original',
  }, 'owner prompt');
  assert.equal(result.deliveryOutcome, 'delivered');
  assert.equal(result.delivery.securityMode, 'e2ee');
  assert.equal(persisted[0].channelId, 'actor-original');
  assert.equal(delivered.length, 1);
  assert.ok(updates.some(([sql]) => sql.includes('delivery_message_id')));
});

test('E2EE owner intervention fails closed when its trusted route is incomplete', async () => {
  let plaintextSteers = 0;
  const resume = createResumeOwnerIntervention({
    async steer() { plaintextSteers += 1; },
    async executeOwnerIntervention() { throw new Error('must not execute'); },
  }, null, null, null);
  const result = await resume({
    id: 'oi-missing', agentId: 'gym', visitorId: 'logical-visitor',
    targetChannelId: 'actor-original', routeSecurityMode: 'e2ee_v2',
  }, 'owner prompt');
  assert.equal(result.code, 'OWNER_REPLY_E2EE_ROUTE_UNAVAILABLE');
  assert.equal(result.deliveryOutcome, 'not_delivered');
  assert.equal(plaintextSteers, 0);
});
