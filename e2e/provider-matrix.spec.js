const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId, agentId = 'e2e-agent') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, content, is_me FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC')
      .all(agentId, channelId);
  } finally {
    db.close();
  }
}

async function runtime(request, agentId) {
  const response = await request.get(`/__test__/runtime?agentId=${encodeURIComponent(agentId)}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function setProvider(request, input) {
  const response = await request.post('/__test__/provider', { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function setModes(request, agentId, modes) {
  const response = await request.post('/__test__/delivery-modes', { data: { agentId, modes } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function inject(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/im/message`, { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('delivery_modes order controls Pull versus Push and recovers without bypassing order', async ({ request }, testInfo) => {
  const suffix = testInfo.repeatEachIndex || 0;
  const pullChannel = `e2e-provider-order-pull-${suffix}`;
  const pushChannel = `e2e-provider-order-push-${suffix}`;
  await setProvider(request, { available: true });

  await setModes(request, 'e2e-agent', ['pull', 'mock']);
  await expect.poll(async () => (await runtime(request, 'e2e-agent')).deliveryStatus.configuredModes, { timeout: 5_000 }).toEqual(['pull', 'mock']);
  expect((await runtime(request, 'e2e-agent')).deliveryStatus.activeAutomaticMode).toBe('mock');
  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId: pullChannel, channelType: 1,
    messageId: `220${suffix}1`, messageSeq: 22001 + suffix, content: 'delivery order pull',
  });
  await expect.poll(() => readMessages(pullChannel).length).toBe(1);
  expect(readMessages(pullChannel).some(row => row.is_me === 1)).toBe(false);

  await setModes(request, 'e2e-agent', ['mock', 'pull']);
  await expect.poll(async () => (await runtime(request, 'e2e-agent')).deliveryStatus.activeAutomaticMode).toBe('mock');
  await inject(request, {
    toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId: pushChannel, channelType: 1,
    messageId: `220${suffix}2`, messageSeq: 22002 + suffix, content: 'delivery order push',
  });
  await expect.poll(() => readMessages(pushChannel).some(row => row.is_me === 1)).toBe(true);
  expect(readMessages(pushChannel).filter(row => row.is_me === 1 && row.content !== 'Agent 正在处理…')).toHaveLength(1);

  await setModes(request, 'e2e-agent', []);
  await expect.poll(async () => (await runtime(request, 'e2e-agent')).deliveryStatus.automaticDeliveryReady).toBe(false);
  expect((await runtime(request, 'e2e-agent')).deliveryStatus.activeAutomaticMode).toBe(null);
  expect((await runtime(request, 'e2e-agent')).deliveryStatus.pullReady).toBe(true);
});

test('provider availability is isolated per Agent and restores the affected route only', async ({ request }, testInfo) => {
  const suffix = testInfo.repeatEachIndex || 0;
  const firstChannel = `e2e-provider-isolation-first-${suffix}`;
  const secondChannel = `e2e-provider-isolation-second-${suffix}`;
  await setModes(request, 'e2e-agent', null);
  await setModes(request, 'e2e-agent-2', null);
  await setProvider(request, { available: true });
  await setProvider(request, { agentId: 'e2e-agent-2', available: false });

  await expect.poll(async () => (await runtime(request, 'e2e-agent')).deliveryStatus.activeAutomaticMode).toBe('mock');
  await expect.poll(async () => (await runtime(request, 'e2e-agent-2')).deliveryStatus.automaticDeliveryReady).toBe(false);
  expect((await runtime(request, 'e2e-agent-2')).deliveryStatus.activeAutomaticMode).toBe(null);
  expect((await runtime(request, 'e2e-agent-2')).deliveryStatus.pullReady).toBe(true);

  await Promise.all([
    inject(request, {
      toUid: 'e2e-im-uid', fromUid: 'e2e-visitor', channelId: firstChannel, channelType: 1,
      messageId: `221${suffix}1`, messageSeq: 22101 + suffix, content: 'first agent remains online',
    }),
    inject(request, {
      toUid: 'e2e-im-uid-2', fromUid: 'e2e-visitor', channelId: secondChannel, channelType: 1,
      messageId: `221${suffix}2`, messageSeq: 22102 + suffix, content: 'second agent is Pull-only',
    }),
  ]);
  await expect.poll(() => readMessages(firstChannel).some(row => row.is_me === 1)).toBe(true);
  await expect.poll(() => readMessages(secondChannel, 'e2e-agent-2').length).toBe(1);
  expect(readMessages(secondChannel, 'e2e-agent-2').some(row => row.is_me === 1)).toBe(false);

  await setProvider(request, { agentId: 'e2e-agent-2', available: true });
  await expect.poll(async () => (await runtime(request, 'e2e-agent-2')).deliveryStatus.activeAutomaticMode).toBe('mock');
  await inject(request, {
    toUid: 'e2e-im-uid-2', fromUid: 'e2e-visitor', channelId: secondChannel, channelType: 1,
    messageId: `221${suffix}3`, messageSeq: 22103 + suffix, content: 'second agent recovered',
  });
  await expect.poll(() => readMessages(secondChannel, 'e2e-agent-2')
    .filter(row => row.is_me === 1 && row.content !== 'Agent 正在处理…').length).toBe(1);
});

test.afterEach(async ({ request }) => {
  await setModes(request, 'e2e-agent', null).catch(() => {});
  await setModes(request, 'e2e-agent-2', null).catch(() => {});
  await setProvider(request, { agentId: 'e2e-agent-2', available: true }).catch(() => {});
  await setProvider(request, { available: true }).catch(() => {});
});
