const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createContext } = require('../build/context');
const { createToolHandlers } = require('../build/mcp/tools');

describe('Lite owner intervention context', () => {
  it('ask_human_for_help 读取启用渠道并将记录交给通知器', async () => {
    const inserted = [];
    const enqueued = [];
    const db = {
      prepare(sql) {
        return {
          all() {
            if (sql.includes('SELECT backend_type FROM agents')) {
              return [{ backend_type: 'openclaw' }];
            }
            return [];
          },
          run(...params) {
            if (sql.includes('INSERT INTO owner_interventions')) inserted.push(params);
            return { changes: 1 };
          },
        };
      },
    };
    const databaseAPI = {
      getEnabledChannel: () => ({ name: 'voko-email' }),
      getPaymentAuth: () => null,
      getAgentImUid: () => 'agent_gym',
      savePaymentOrder: () => null,
    };
    const context = createContext({
      db,
      databaseAPI,
      agentEmailApi: {},
      wukongimSender: {},
      deliver: async () => ({ success: true }),
      sendMessage: async () => ({ success: true }),
      enqueueOwnerIntervention: (record) => enqueued.push(record),
    });
    const handlers = createToolHandlers(context);

    const result = await handlers.ask_human_for_help({
      agentId: 'gym',
      visitorId: 'visitor',
      problem: '预约健身时间',
      suggestion: '请确认可用时段',
      channelId: 'group-1',
      channelType: 2,
      messageId: 'message-1',
    });

    assert.equal(result.success, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0][7], 'voko-email');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].id, result.interventionId);
    assert.equal(enqueued[0].targetChannelId, 'group-1');
    assert.equal(enqueued[0].targetChannelType, 2);
  });
});
