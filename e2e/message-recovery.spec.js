const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

async function runtime(request, agentId = 'e2e-agent') {
  const response = await request.get(`/__test__/runtime?agentId=${encodeURIComponent(agentId)}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function setProvider(request, input) {
  const response = await request.post('/__test__/provider', { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function inject(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/im/message`, { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function callMcp(request, name, args, id = Date.now()) {
  const response = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.ok()).toBeTruthy();
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text);
}

test('MCP pull cursor pages messages, survives Web reload, and resumes exactly once', async ({ page, request }, testInfo) => {
  const base = 2100 + (testInfo.repeatEachIndex || 0) * 10;
  const channelId = `e2e-cursor-recovery-${testInfo.repeatEachIndex || 0}`;
  await setProvider(request, { available: false });
  await page.goto(`/agents/e2e-agent/c/${channelId}`);

  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId,
    channelType: 1,
    messages: [
      { messageId: String(base + 1), messageSeq: base + 1, content: 'cursor page one' },
      { messageId: String(base + 2), messageSeq: base + 2, content: 'cursor page two' },
      { messageId: String(base + 3), messageSeq: base + 3, content: 'cursor page three' },
    ],
  });

  const first = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 2,
  }, base + 4);
  expect(first.success).toBe(true);
  expect(first.messages.map(message => message.id)).toEqual([String(base + 1), String(base + 2)]);
  let state = await runtime(request);
  let checkpoint = state.checkpoints.find(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === channelId);
  expect(checkpoint).toBeTruthy();
  expect(Number(checkpoint.committed_value)).toBe(base + 2);

  const second = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 2,
  }, base + 5);
  expect(second.success).toBe(true);
  expect(second.messages.map(message => message.id)).toEqual([String(base + 3)]);
  state = await runtime(request);
  checkpoint = state.checkpoints.find(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === channelId);
  expect(Number(checkpoint.committed_value)).toBe(base + 3);

  // Reloading the Web layer must not reset the durable MCP checkpoint.
  const reloaded = await request.post('/api/reload-web');
  expect(reloaded.ok()).toBeTruthy();
  await expect.poll(async () => {
    const snapshot = await runtime(request);
    return Number(snapshot.checkpoints.find(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === channelId)?.committed_value || 0);
  }).toBe(base + 3);

  const empty = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 2,
  }, base + 6);
  expect(empty.success).toBe(true);
  expect(empty.messages).toEqual([]);

  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId,
    channelType: 1,
    messageId: String(base + 7),
    messageSeq: base + 7,
    content: 'cursor resumes after reload',
  });
  const resumed = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 2,
  }, base + 8);
  expect(resumed.success).toBe(true);
  expect(resumed.messages.map(message => message.id)).toEqual([String(base + 7)]);
  const finalState = await runtime(request);
  const finalCheckpoint = finalState.checkpoints.find(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === channelId);
  expect(Number(finalCheckpoint.committed_value)).toBe(base + 7);
  const stats = finalState.messageStats.find(row => row.channelId === channelId);
  expect(Number(stats.total)).toBe(4);
  expect(Number(stats.uniqueIds)).toBe(4);
});

test.afterEach(async ({ request }) => {
  await setProvider(request, { available: true }).catch(() => {});
});
