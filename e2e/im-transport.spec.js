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
      SELECT id, content, is_me, status, client_msg_no, message_seq
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

async function imState(request) {
  const response = await request.get(`${manifest().services.api}/__test__/im/state`);
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
    timeout: 25_000,
    data: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.ok()).toBeTruthy();
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text);
}

test('real IM 1006 disconnect reconnects one Agent without disturbing a shared Hub', async ({ page, request }) => {
  await page.goto('/agents/e2e-agent/c/e2e-reconnect');

  await expect.poll(async () => {
    const first = await runtime(request, 'e2e-agent');
    const second = await runtime(request, 'e2e-agent-2');
    return first.imStatus?.connected === true
      && second.imStatus?.connected === true
      && first.hubSummary?.hubCount === 1
      && first.hubSummary?.agentCount === 2
      && first.imStatus?.hubIndex === second.imStatus?.hubIndex;
  }, { timeout: 10_000 }).toBe(true);

  const initial = await runtime(request, 'e2e-agent');
  expect(initial.hubSummary.hubs).toEqual([
    expect.objectContaining({ agentCount: 2, agents: expect.arrayContaining(['e2e-agent', 'e2e-agent-2']) }),
  ]);
  const beforeReconnects = Number(initial.imStatus?.stats?.reconnects || 0);
  const beforeFake = await imState(request);
  expect(beforeFake.connections.map(connection => connection.uid)).toEqual(expect.arrayContaining(['e2e-im-uid', 'e2e-im-uid-2']));

  const disconnect = await request.post(`${manifest().services.api}/__test__/im/control`, {
    data: { action: 'disconnect', uid: 'e2e-im-uid' },
  });
  expect(disconnect.ok()).toBeTruthy();
  expect(await disconnect.json()).toMatchObject({ success: true, closed: 1, code: 1006 });

  await expect.poll(async () => Number((await runtime(request, 'e2e-agent')).imStatus?.stats?.reconnects || 0), {
    timeout: 10_000,
  }).toBeGreaterThan(beforeReconnects);
  await expect.poll(async () => {
    const first = await runtime(request, 'e2e-agent');
    const second = await runtime(request, 'e2e-agent-2');
    const fake = await imState(request);
    return first.imStatus?.connected === true
      && second.imStatus?.connected === true
      && fake.connections.some(connection => connection.uid === 'e2e-im-uid')
      && fake.connections.some(connection => connection.uid === 'e2e-im-uid-2');
  }, { timeout: 10_000 }).toBe(true);

  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId: 'e2e-reconnect', channelType: 1,
    messageId: '1501', messageSeq: 1501, content: 'after reconnect e2e',
  });
  await expect.poll(() => readMessages('e2e-reconnect').some(row => row.id === '1501'), { timeout: 5_000 }).toBe(true);

  await inject(request, {
    toUid: 'e2e-im-uid-2', fromUid: 'e2e-visitor-2', channelId: 'e2e-shared-hub', channelType: 1,
    messageId: '1502', messageSeq: 1502, content: 'second Agent shared Hub e2e',
  });
  await expect.poll(() => readMessages('e2e-shared-hub', 'e2e-agent-2').some(row => row.id === '1502'), { timeout: 5_000 }).toBe(true);
  const finalState = await runtime(request, 'e2e-agent');
  expect(finalState.hubSummary.hubCount).toBe(1);
  expect(finalState.hubSummary.agentCount).toBe(2);
  expect(finalState.imStatus.connected).toBe(true);
});

test('real SENDACK loss fails exactly one outbound message and the next send recovers', async ({ request }) => {
  test.setTimeout(35_000);
  const channelId = 'e2e-sendack-loss';
  const fault = await request.post(`${manifest().services.api}/__test__/fault`, {
    data: { target: 'im', mode: 'sendack-lost', count: 1 },
  });
  expect(fault.ok()).toBeTruthy();

  const lost = await callMcp(request, 'voko_send_message', {
    agentId: 'e2e-agent', toUid: channelId, content: 'sendack lost e2e',
  }, 1503);
  expect(lost.success).toBe(false);
  await expect.poll(() => readMessages(channelId).filter(row => row.content === 'sendack lost e2e'), { timeout: 5_000 }).toHaveLength(1);
  const failed = readMessages(channelId).find(row => row.content === 'sendack lost e2e');
  expect(failed.status).toBe('failed');

  const afterLoss = await imState(request);
  expect(afterLoss.stats.sendAckLost).toBe(1);
  expect(afterLoss.stats.sends).toBeGreaterThanOrEqual(1);

  const recovered = await callMcp(request, 'voko_send_message', {
    agentId: 'e2e-agent', toUid: channelId, content: 'sendack recovered e2e',
  }, 1504);
  expect(recovered.success).toBe(true);
  await expect.poll(() => readMessages(channelId).filter(row => row.content === 'sendack recovered e2e'), { timeout: 5_000 }).toHaveLength(1);
  const sent = readMessages(channelId).find(row => row.content === 'sendack recovered e2e');
  expect(sent.status).toBe('sent');
  expect(sent.client_msg_no).toBeTruthy();
  expect(sent.message_seq).toBeGreaterThan(0);

  const finalFake = await imState(request);
  expect(finalFake.stats.sendAckLost).toBe(1);
  expect(finalFake.stats.sendAcks).toBeGreaterThanOrEqual(1);
  expect(readMessages(channelId).filter(row => row.content.includes('sendack '))).toHaveLength(2);
});
