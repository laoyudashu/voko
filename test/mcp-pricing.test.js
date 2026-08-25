const assert = require('node:assert/strict');
const test = require('node:test');

const { createToolHandlers } = require('../build/mcp/tools');

test('agent_pricing rejects the non-canonical duration model', async () => {
  const handlers = createToolHandlers({ db: {}, query: () => [] });
  const result = await handlers.agent_pricing({
    agentId: 'agent-1',
    pricingModel: 'duration',
  });

  assert.deepEqual(result, {
    success: false,
    error: 'pricingModel 必须为 free 或 timed',
  });
});
