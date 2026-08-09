const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createToolHandlers } = require('../build/mcp/tools');
const { initDatabase } = require('../build/core/database');

function makeHandlers(currentBackendType) {
  const writes = [];
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, owner_email, publish_status, access_mode,
     backend_type, backend_instance_id, delivery_modes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', 'private', ?, ?, ?, ?, ?)`)
    .run('row-1', 'agent-1', 'im-1', 'token', 'wss://example.test', 'owner@example.com',
      currentBackendType, 'old-instance', JSON.stringify(['websocket', 'pull']), now, now);
  const cx = {
    db,
    query(sql, params = []) {
      if (sql.includes("type='user_access_token'")) {
        return [{ data: JSON.stringify({ 'owner@example.com': { user_access_token: 'ut_test' } }) }];
      }
      if (sql.includes('SELECT owner_email FROM agents')) return [{ owner_email: 'owner@example.com' }];
      try { return db.prepare(sql).all(...params); } catch (_) { return []; }
    },
    exec(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
    updateAgentProfile: async () => ({ success: true }),
    agentRegistration: { sendCode() {}, loginByCode() {} },
  };
  return { handlers: createToolHandlers(cx), writes, db };
}

describe('MCP update_agent_profile delivery safety', () => {
  it('returns the sole registered Agent as current without Provider identity evidence', async () => {
    const { handlers, db } = makeHandlers('codex');
    const result = await handlers.whoami({});

    assert.strictEqual(result.currentAgent.agentId, 'agent-1');
    assert.strictEqual(result.identity.status, 'resolved');
    assert.strictEqual(result.identity.method, 'sole_registered_agent');
    assert.strictEqual(result.agents, undefined);
    db.close();
  });

  it('lists owned Agents separately with pagination metadata', async () => {
    const { handlers, db } = makeHandlers('codex');
    const result = await handlers.list_agents({ keyword: 'agent-1', limit: 10, offset: 0 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.hasMore, false);
    assert.strictEqual(result.agents[0].agentId, 'agent-1');
    assert.deepStrictEqual(result.agents[0].deliveryModes, ['websocket', 'pull']);
    db.close();
  });

  it('clears an incompatible instance and resets delivery to pull when the provider changes', async () => {
    const { handlers, db } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'hermes' });

    assert.strictEqual(result.success, true);
    const row = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes FROM agents WHERE agent_id=?').get('agent-1');
    assert.strictEqual(row.backend_type, 'hermes');
    assert.strictEqual(row.backend_instance_id, null);
    assert.deepStrictEqual(JSON.parse(row.delivery_modes), ['pull']);
    db.close();
  });

  it('keeps the selected instance and delivery modes when the provider is unchanged', async () => {
    const { handlers, db } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'openclaw' });

    assert.strictEqual(result.success, true);
    const row = db.prepare('SELECT backend_instance_id, delivery_modes FROM agents WHERE agent_id=?').get('agent-1');
    assert.strictEqual(row.backend_instance_id, 'old-instance');
    assert.deepStrictEqual(JSON.parse(row.delivery_modes), ['websocket', 'pull']);
    db.close();
  });

  it('rejects an incompatible instance before changing the provider', async () => {
    const { handlers, writes, db } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({
      agentId: 'agent-1',
      backendType: 'others',
      backendInstanceId: 'old-profile',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /OpenClaw|Hermes|ZeroClaw/);
    assert.strictEqual(writes.length, 0);
    db.close();
  });
});
