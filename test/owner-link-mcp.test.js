const assert = require('node:assert/strict');
const test = require('node:test');
const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');

test('voko_owner_command exposes one action interface without accepting trust fields', async () => {
  const db = initDatabase(':memory:', { silent: true }); const calls = [];
  try {
    const ownerPullService = {
      fetch(agentId) { calls.push(['fetch', agentId]); return { success: true, command: null }; },
      complete(...args) { calls.push(['complete', ...args]); return { success: true, status: 'completed' }; },
      fail(...args) { calls.push(['fail', ...args]); return { success: true, status: 'failed' }; },
    };
    const handlers = createToolHandlers({ db, ownerPullService, query: (sql, params = []) => db.prepare(sql).all(...params),
      exec: (sql, params = []) => db.prepare(sql).run(...params), agentRegistration: {} });
    assert.deepEqual(await handlers.owner_command({ action: 'fetch', agentId: 'agent-1', trust: 'forged' }),
      { success: true, command: null });
    assert.deepEqual(await handlers.owner_command({ action: 'complete', agentId: 'agent-1', messageId: 'message-1',
      claimId: 'claim-1', content: 'done' }), { success: true, status: 'completed' });
    assert.deepEqual(calls, [['fetch', 'agent-1'], ['complete', 'agent-1', 'message-1', 'claim-1', 'done']]);
  } finally { db.close(); }
});

test('voko_owner_command rejects missing claims and disabled Owner Link', async () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const base = { db, query: (sql, params = []) => db.prepare(sql).all(...params),
      exec: (sql, params = []) => db.prepare(sql).run(...params), agentRegistration: {} };
    assert.deepEqual(await createToolHandlers(base).owner_command({ action: 'fetch', agentId: 'agent-1' }),
      { success: false, code: 'OWNER_LINK_UNAVAILABLE' });
    const handlers = createToolHandlers({ ...base, ownerPullService: { fetch() {}, complete() {}, fail() {} } });
    assert.deepEqual(await handlers.owner_command({ action: 'complete', agentId: 'agent-1' }),
      { success: false, code: 'OWNER_PULL_CLAIM_REQUIRED' });
  } finally { db.close(); }
});
