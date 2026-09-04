const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId, agentId = 'e2e-agent') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, content, is_me, status, client_msg_no
      FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC
    `).all(agentId, channelId);
  } finally {
    db.close();
  }
}

async function runtime(request, agentId = 'e2e-agent') {
  const response = await request.get(`/__test__/runtime?agentId=${encodeURIComponent(agentId)}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function inject(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/im/message`, { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function setProvider(request, input) {
  const response = await request.post('/__test__/provider', { data: input });
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

test('cached Provider push failure falls back to Pull and recovery restores Push', async ({ request }, testInfo) => {
  const repeatIndex = testInfo.repeatEachIndex || 0;
  const retryIndex = testInfo.retry || 0;
  const runOffset = repeatIndex * 100 + retryIndex * 10;
  const channelId = `e2e-provider-failure-${repeatIndex}-${retryIndex}`;
  const failedMessageId = String(1701 + runOffset);
  const recoveredMessageId = String(1703 + runOffset);
  const checkpointScope = `1:${channelId}`;
  const before = await runtime(request);
  const faultedBefore = Number(before.providerState?.stats?.faultedPushes || 0);
  await expect.poll(async () => (await runtime(request)).deliveryStatus.activeAutomaticMode, { timeout: 5_000 }).toBe('mock');

  const configured = await setProvider(request, {
    available: true,
    fault: { mode: 'not_delivered', count: 1, disable: true },
  });
  expect(configured).toMatchObject({ success: true, available: true, fault: { mode: 'not_delivered', remaining: 1 } });

  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId, channelType: 1,
    messageId: failedMessageId, messageSeq: 1701 + runOffset, content: 'provider failure e2e',
  });
  await expect.poll(async () => Number((await runtime(request)).providerState?.stats?.faultedPushes || 0), {
    timeout: 5_000,
  }).toBe(faultedBefore + 1);
  await expect.poll(() => readMessages(channelId).some(row => row.id === failedMessageId), { timeout: 5_000 }).toBe(true);
  await expect.poll(async () => (await runtime(request)).deliveryStatus.automaticDeliveryReady, { timeout: 5_000 }).toBe(false);
  const pullStatus = await runtime(request);
  expect(pullStatus.deliveryStatus.activeAutomaticMode).toBe(null);
  expect(pullStatus.deliveryStatus.pullReady).toBe(true);

  const failedRows = readMessages(channelId);
  expect(failedRows.filter(row => row.is_me === 0)).toHaveLength(1);
  expect(failedRows.some(row => row.content === 'Agent 正在处理…')).toBe(false);
  expect(failedRows.some(row => row.content === 'Agent 当前无法处理该消息')).toBe(false);
  expect(failedRows.some(row => row.content.includes('[echo]'))).toBe(false);

  const pulled = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 10,
  }, 1702 + runOffset);
  expect(pulled.success).toBe(true);
  expect(pulled.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: failedMessageId, content: 'provider failure e2e' }),
  ]));
  const afterPull = await runtime(request);
  expect(afterPull.checkpoints.some(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === checkpointScope)).toBe(true);

  const recovered = await setProvider(request, { available: true });
  expect(recovered).toMatchObject({ success: true, available: true, fault: null });
  await expect.poll(async () => (await runtime(request)).deliveryStatus.activeAutomaticMode, { timeout: 5_000 }).toBe('mock');

  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId, channelType: 1,
    messageId: recoveredMessageId, messageSeq: 1703 + runOffset, content: 'provider recovered e2e',
  });
  await expect.poll(() => readMessages(channelId).some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes('provider recovered e2e')), {
    timeout: 5_000,
  }).toBe(true);
  const finalRows = readMessages(channelId);
  expect(finalRows.filter(row => row.is_me === 0)).toHaveLength(2);
  expect(finalRows.filter(row => row.content.includes('[echo]'))).toHaveLength(1);
  expect(new Set(finalRows.map(row => row.id)).size).toBe(finalRows.length);
});

test('outcome-unknown Provider failure is not retried and later messages recover normally', async ({ request }, testInfo) => {
  const retryIndex = testInfo.retry || 0;
  const channelId = `e2e-provider-unknown-${retryIndex}`;
  const failedMessageId = String(1801 + retryIndex * 10);
  const recoveredMessageId = String(1803 + retryIndex * 10);
  const before = await runtime(request);
  const faultedBefore = Number(before.providerState?.stats?.faultedPushes || 0);
  const configured = await setProvider(request, {
    available: true,
    fault: { mode: 'outcome_unknown', count: 1, disable: false },
  });
  expect(configured).toMatchObject({ success: true, available: true, fault: { mode: 'outcome_unknown', remaining: 1 } });

  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId, channelType: 1,
    messageId: failedMessageId, messageSeq: Number(failedMessageId), content: 'provider unknown outcome e2e',
  });
  await expect.poll(async () => Number((await runtime(request)).providerState?.stats?.faultedPushes || 0), {
    timeout: 5_000,
  }).toBe(faultedBefore + 1);
  await expect.poll(() => readMessages(channelId).some(row => row.id === failedMessageId), { timeout: 5_000 }).toBe(true);
  expect(readMessages(channelId).some(row => row.content === '消息结果暂时无法确认')).toBe(false);

  const pulled = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 10,
  }, 1802);
  expect(pulled.success).toBe(true);
  expect(pulled.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: failedMessageId, content: 'provider unknown outcome e2e' }),
  ]));

  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId, channelType: 1,
    messageId: recoveredMessageId, messageSeq: Number(recoveredMessageId), content: 'provider unknown recovered e2e',
  });
  await expect.poll(() => readMessages(channelId).some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes('provider unknown recovered e2e')), {
    timeout: 5_000,
  }).toBe(true);
  const finalRows = readMessages(channelId);
  expect(finalRows.filter(row => row.content.includes('provider unknown outcome e2e'))).toHaveLength(1);
  expect(finalRows.filter(row => row.content.includes('[echo]'))).toHaveLength(1);
  expect(new Set(finalRows.map(row => row.id)).size).toBe(finalRows.length);
});

test.afterEach(async ({ request }) => {
  await setProvider(request, { available: true }).catch(() => {});
});
