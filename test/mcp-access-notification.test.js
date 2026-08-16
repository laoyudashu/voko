const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');
const { createContext } = require('../build/context');
const { RoutingConversationStore } = require('../build/core/provider-routing');

function fixture(sendSystemMessage) {
  const db = initDatabase(':memory:', { silent: true });
  const handlers = createToolHandlers({
    db,
    query(sql, params = []) { return db.prepare(sql).all(...params); },
    exec(sql, params = []) { return db.prepare(sql).run(...params); },
    sendSystemMessage,
  });
  return { db, handlers };
}

test('whitelist mutation succeeds while unavailable notification is reported as skipped', async () => {
  const { db, handlers } = fixture(async () => ({
    notificationStatus: 'skipped', notificationReason: 'agent_worker_unavailable',
  }));
  try {
    const result = await handlers.manage_whitelist({ action: 'add', agentId: 'agent-1', visitorId: 'visitor-1' });
    assert.equal(result.success, true);
    assert.equal(result.notificationStatus, 'skipped');
    assert.equal(result.notificationReason, 'agent_worker_unavailable');
    assert.ok(db.prepare("SELECT 1 FROM agent_access_lists WHERE agent_id='agent-1' AND visitor_id='visitor-1'").get());
  } finally { db.close(); }
});

test('whitelist and blacklist removal expose successful runtime notification', async () => {
  const { db, handlers } = fixture(async () => ({ notificationStatus: 'sent' }));
  try {
    await handlers.manage_whitelist({ action: 'add', agentId: 'agent-1', visitorId: 'visitor-1' });
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,manual_managed,server_managed,source,auto_trust_disabled,created_at,updated_at)
      VALUES ('blocked','agent-1','blacklist','visitor-1',1,0,'manual',0,1,1)`).run();
    const result = await handlers.manage_blacklist({ action: 'remove', agentId: 'agent-1', visitorId: 'visitor-1' });
    assert.equal(result.success, true);
    assert.equal(result.notificationStatus, 'sent');
  } finally { db.close(); }
});

test('short-lived context skips notification before calling a missing Agent worker', async () => {
  const db = initDatabase(':memory:', { silent: true });
  let calls = 0;
  const context = createContext({ db, databaseAPI: {
    getPaymentAuth() {}, getAgentImUid() { return ''; }, savePaymentOrder() {},
  }, agentManager: {
    workers: new Map(),
    start() {}, stop() {}, getStatus() { return { connected: false, status: 'stopped', uid: '' }; },
    sendSystemMessage() { calls++; },
  } });
  try {
    const result = await context.sendSystemMessage('agent-1', 'visitor-1', 'whitelist_enabled');
    assert.deepEqual(result, { notificationStatus: 'skipped', notificationReason: 'agent_worker_unavailable' });
    assert.equal(calls, 0);
  } finally { db.close(); }
});

test('access status notification keeps an explicitly selected Conversation', async () => {
  const calls = [];
  const { db, handlers } = fixture(async (...args) => {
    calls.push(args);
    return { notificationStatus: 'sent' };
  });
  try {
    const conversation = new RoutingConversationStore(db).createPending({
      agentId: 'agent-1', channelId: 'visitor-1', channelType: 1, origin: 'web_system',
    });
    const result = await handlers.manage_whitelist({
      action: 'add', agentId: 'agent-1', visitorId: 'visitor-1', conversationId: conversation.id,
    });
    assert.equal(result.notificationStatus, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][5].conversationId, conversation.id);
  } finally { db.close(); }
});
