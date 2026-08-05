const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createToolHandlers } = require('../build/mcp/tools');

function makeHandlers(currentBackendType) {
  const writes = [];
  const cx = {
    db: {},
    query(sql) {
      if (sql.includes("type='user_access_token'")) {
        return [{ data: JSON.stringify({ 'owner@example.com': { user_access_token: 'ut_test' } }) }];
      }
      if (sql.includes('SELECT owner_email FROM agents')) return [{ owner_email: 'owner@example.com' }];
      if (sql.includes('SELECT backend_type FROM agents')) return [{ backend_type: currentBackendType }];
      return [];
    },
    exec(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
    updateAgentProfile: async () => ({ success: true }),
    agentRegistration: { sendCode() {}, loginByCode() {} },
  };
  return { handlers: createToolHandlers(cx), writes };
}

describe('MCP update_agent_profile delivery safety', () => {
  it('clears an incompatible instance and resets delivery to pull when the provider changes', async () => {
    const { handlers, writes } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'hermes' });

    assert.strictEqual(result.success, true);
    assert.match(writes[0].sql, /backend_instance_id=NULL, delivery_modes=/);
    assert.deepStrictEqual(writes[0].params.slice(0, 2), ['hermes', JSON.stringify(['pull'])]);
  });

  it('keeps the selected instance and delivery modes when the provider is unchanged', async () => {
    const { handlers, writes } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'openclaw' });

    assert.strictEqual(result.success, true);
    assert.doesNotMatch(writes[0].sql, /backend_instance_id|delivery_modes/);
  });

  it('rejects an incompatible instance before changing the provider', async () => {
    const { handlers, writes } = makeHandlers('openclaw');
    const result = await handlers.update_agent_profile({
      agentId: 'agent-1',
      backendType: 'others',
      backendInstanceId: 'old-profile',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /OpenClaw|Hermes|ZeroClaw/);
    assert.strictEqual(writes.length, 0);
  });
});
