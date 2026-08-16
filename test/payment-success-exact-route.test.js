const test = require('node:test');
const assert = require('node:assert/strict');
const { startPaymentPolling } = require('../build/core/payment');

test('payment success resumes the exact Provider conversation', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalFetch = global.fetch;
  const scheduled = [];
  const resumed = [];
  global.setTimeout = (fn, delay) => {
    const token = { fn, delay };
    scheduled.push(token);
    return token;
  };
  global.clearTimeout = () => {};
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, data: { status: 1, transactionNo: 'tx-1' } }),
  });
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.fetch = originalFetch;
  });
  const order = {
    id: 'paid-1', agent_id: 'agent-1', visitor_id: 'visitor-1', from_uid: 'agent-im-1',
    order_no: 'remote-1', amount: 2, status: 'created', type: 'service',
    routing_conversation_id: 'conversation-1',
  };
  const stop = startPaymentPolling({
    db: {
      exec() {},
      prepare(sql) {
        return {
          get: () => sql.includes('query_token') ? { query_token: 'q1' } : { backend_type: 'codex' },
          all: () => [],
          run: () => ({ changes: 1 }),
        };
      },
    },
    databaseAPI: {
      getAgentDid: () => null,
      updatePaymentOrder() {},
      getPaymentOrdersByStatus: (status) => status === 'created' ? [order] : [],
      saveOwnerIntervention: () => ({ success: true }),
    },
    endpoints: { payment: { baseUrl: 'https://pay.test' } },
    sendSystemMessage: async () => ({ notificationStatus: 'sent' }),
    resumeProviderConversation: async (...args) => { resumed.push(args); return { success: true }; },
  });

  await scheduled[0].fn();
  stop();
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0].slice(0, 3), ['conversation-1', 'agent-1', 'visitor-1']);
  assert.match(resumed[0][3], /visitor-1/);
});
