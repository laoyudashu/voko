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
      SELECT id, from_uid, to_uid, content, channel_id, channel_type, timestamp,
             is_me, status, message_seq, client_msg_no, content_type, mention
      FROM messages WHERE agent_id=? AND channel_id=? ORDER BY timestamp ASC, rowid ASC
    `).all(agentId, channelId);
  } finally {
    db.close();
  }
}

async function waitForMessages(channelId, predicate, timeout = 10_000) {
  await expect.poll(() => predicate(readMessages(channelId)), { timeout }).toBe(true);
  return readMessages(channelId);
}

async function inject(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/im/message`, { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function runtime(request, agentId = 'e2e-agent') {
  const response = await request.get(`/__test__/runtime?agentId=${encodeURIComponent(agentId)}`);
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

test('single chat sends and receives text through the real worker and Mock Provider', async ({ page, request }, testInfo) => {
  const runOffset = (testInfo.repeatEachIndex || 0) * 100 + (testInfo.retry || 0) * 10;
  const channelId = `e2e-visitor-${testInfo.repeatEachIndex || 0}-${testInfo.retry || 0}`;
  const inboundId = String(1101 + runOffset);
  const inboundContent = `single inbound e2e ${runOffset}`;
  const outboundContent = `single outbound e2e ${runOffset}`;
  await page.goto(`/agents/e2e-agent/c/${channelId}`);
  await expect(page.locator('#c')).toBeVisible();

  await expect(await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: channelId,
    channelId,
    channelType: 1,
    messageId: inboundId,
    messageSeq: 1 + runOffset,
    content: inboundContent,
  })).toMatchObject({ success: true, delivered: true, count: 1 });
  await waitForMessages(channelId, rows => rows.some(row => row.id === inboundId) && rows.some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes(inboundContent)));

  await page.reload();
  await expect(page.locator('#msg-box')).toContainText(inboundContent);
  await expect(page.locator('#msg-box')).toContainText('[echo]');

  await page.locator('#c').fill(outboundContent);
  await page.locator('form[action="/messages/send"] button[type="submit"]').click();
  const rows = await waitForMessages(channelId, messages => messages.some(row => row.is_me === 1 && row.content === outboundContent));
  await page.waitForURL(new RegExp(`/agents/e2e-agent/c/${channelId}(?:\\?|$)`));
  await expect(page.locator('#msg-box')).toContainText(outboundContent);

  const uniqueIds = new Set(rows.map(row => row.id));
  expect(uniqueIds.size).toBe(rows.length);
  const echoReply = rows.find(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes(inboundContent));
  const directReply = rows.find(row => row.is_me === 1 && row.content === outboundContent);
  expect(echoReply).toBeTruthy();
  expect(directReply).toBeTruthy();
  expect(rows.every(row => row.channel_id === channelId && row.channel_type === 1)).toBeTruthy();
  const state = await runtime(request);
  const direct = state.messageStats.find(item => item.channelId === channelId);
  expect(rows.filter(row => row.is_me === 1 && row.content !== 'Agent 正在处理…')).toHaveLength(2);
  expect(Number(direct.replies)).toBe(3);
  expect(Number(direct.uniqueIds)).toBe(Number(direct.total));
  expect(Number(direct.uniqueTurns)).toBe(Number(direct.total));
  expect(state.deliveryStatus.activeAutomaticMode).toBe('mock');
});

test('group chat renders text, supports @all, and enforces mention permission', async ({ page, request }) => {
  const groupUrl = '/agents/e2e-agent/g/e2e-group';
  await page.goto(groupUrl);
  await expect(page.locator('body')).toContainText('E2E Test Group');
  await expect(page.locator('#group-reply-input')).toBeVisible();

  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId: 'e2e-group',
    channelType: 2,
    messageId: '1201',
    messageSeq: 10,
    content: '@E2E Test Agent group inbound',
    mention: { uids: ['e2e-im-uid'] },
  });
  await waitForMessages('e2e-group', rows => rows.some(row => row.id === '1201'));
  await page.reload();
  await expect(page.locator('#msg-box')).toContainText('group inbound');

  await page.locator('#group-reply-input').fill('group outbound e2e');
  await page.locator('#group-reply-form button[type="submit"]').click();
  await waitForMessages('e2e-group', rows => rows.some(row => row.is_me === 1 && row.content === 'group outbound e2e'));

  await page.locator('#group-reply-input').fill('@');
  await expect(page.locator('.gm-ment-item').first()).toBeVisible();
  await page.locator('.gm-ment-item').first().click();
  await page.locator('#group-reply-input').press('End');
  await page.locator('#group-reply-input').type('mention all e2e');
  await page.locator('#group-reply-form button[type="submit"]').click();
  const mentionRows = await waitForMessages('e2e-group', rows => rows.some(row => row.is_me === 1 && row.content === 'mention all e2e' && JSON.parse(row.mention || '{}').all === true));
  expect(mentionRows.filter(row => row.content === 'mention all e2e')).toHaveLength(1);

  const roleResponse = await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'member' } });
  expect(roleResponse.ok()).toBeTruthy();
  await page.reload();
  await page.locator('#group-reply-input').fill('@所有人 permission denied e2e');
  await page.evaluate(() => { window.__GROUP_MENTION_STATE__ = [{ token: '@所有人', uid: '', all: true }]; });
  await page.locator('#group-reply-form button[type="submit"]').click();
  await expect(page.locator('#reply-send-err')).toContainText(/所有人|权限|owner|admin|管理员/i);
  const afterDenied = readMessages('e2e-group');
  expect(afterDenied.some(row => row.content === 'permission denied e2e')).toBeFalsy();
  await expect.poll(async () => {
    const current = await runtime(request);
    return Number(current.messageStats.find(item => item.channelId === 'e2e-group')?.total || 0);
  }).toBeGreaterThanOrEqual(4);
  const state = await runtime(request);
  const group = state.messageStats.find(item => item.channelId === 'e2e-group');
  expect(Number(group.uniqueIds)).toBe(Number(group.total));

  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } });
});

test('single-chat attachment upload sends note then file and returns to the conversation', async ({ page, request }) => {
  await page.goto('/agents/e2e-agent/upload?toUid=e2e-visitor&channelType=1');
  await page.locator('#upload-file').setInputFiles({
    name: 'e2e-attachment.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attachment body'),
  });
  await page.locator('#upload-message').fill('attachment note e2e');
  await page.locator('#upload-submit-btn').click();
  await page.waitForURL(/\/agents\/e2e-agent\/c\/e2e-visitor$/);

  const rows = await waitForMessages('e2e-visitor', messages => messages.some(row => row.content === 'attachment note e2e') && messages.some(row => row.content_type === 8 && row.content.includes('e2e-attachment.txt')));
  await expect(page.locator('#msg-box')).toContainText('attachment note e2e');
  await expect(page.locator('#msg-box')).toContainText('e2e-attachment.txt');
  await expect(page.locator('#msg-box')).not.toContainText('{"name":"e2e-attachment.txt"');
  const fileRows = rows.filter(row => row.content_type === 8 && row.content.includes('e2e-attachment.txt'));
  expect(fileRows).toHaveLength(1);
  expect(fileRows[0].status).toBe('sent');
  expect(fileRows[0].client_msg_no).toBeTruthy();
  const note = rows.find(row => row.content === 'attachment note e2e');
  expect(note.client_msg_no).toBeTruthy();
  expect(note.timestamp).toBeLessThanOrEqual(fileRows[0].timestamp);
  const state = await runtime(request);
  const direct = state.messageStats.find(item => item.channelId === 'e2e-visitor');
  expect(Number(direct.uniqueIds)).toBe(Number(direct.total));
});

test('duplicate and reordered inbound frames remain idempotent in SQLite', async ({ page, request }) => {
  await page.goto('/agents/e2e-agent/c/e2e-dedupe');
  await inject(request, {
    toUid: 'e2e-im-uid',
    channelId: 'e2e-dedupe',
    channelType: 1,
    duplicate: true,
    messages: [{
      fromUid: 'e2e-visitor', messageId: '1301', messageSeq: 30,
      timestamp: 2000, content: 'duplicate inbound e2e',
    }],
  });
  await inject(request, {
    toUid: 'e2e-im-uid',
    channelId: 'e2e-dedupe',
    channelType: 1,
    reorder: true,
    messages: [
      { fromUid: 'e2e-visitor', messageId: '1302', messageSeq: 31, timestamp: 1000, content: 'ordered first e2e' },
      { fromUid: 'e2e-visitor', messageId: '1303', messageSeq: 32, timestamp: 3000, content: 'ordered second e2e' },
    ],
  });
  const rows = await waitForMessages('e2e-dedupe', messages => messages.filter(row => ['1301', '1302', '1303'].includes(row.id)).length >= 3);
  const duplicateRows = rows.filter(row => row.id === '1301');
  expect(duplicateRows).toHaveLength(1);
  expect(new Set(rows.filter(row => ['1302', '1303'].includes(row.id)).map(row => row.id)).size).toBe(2);
  expect(rows.filter(row => ['1302', '1303'].includes(row.id)).map(row => row.id)).toEqual(expect.arrayContaining(['1302', '1303']));
  await page.reload();
  await expect(page.locator('#msg-box')).toContainText('duplicate inbound e2e');
  await expect(page.locator('#msg-box')).toContainText('ordered first e2e');
  await expect(page.locator('#msg-box')).toContainText('ordered second e2e');
  await waitForMessages('e2e-dedupe', messages => messages.some(row => row.is_me === 1 && row.content.includes('[echo]')));
  const state = await runtime(request);
  const dedupe = state.messageStats.find(item => item.channelId === 'e2e-dedupe');
  expect(Number(dedupe.total)).toBe(5);
  expect(Number(dedupe.replies)).toBe(2);
  expect(Number(dedupe.uniqueIds)).toBe(5);
  expect(Number(dedupe.uniqueTurns)).toBe(5);
});

test('provider failure leaves the message available for Pull and recovery restores push', async ({ page, request }, testInfo) => {
  const repeatIndex = testInfo.repeatEachIndex || 0;
  const retryIndex = testInfo.retry || 0;
  const runOffset = repeatIndex * 100 + retryIndex * 10;
  const channelId = `e2e-pull-${repeatIndex}-${retryIndex}`;
  const firstMessageId = String(1401 + runOffset);
  const recoveredMessageId = String(1402 + runOffset);
  const firstMessageSeq = 50 + runOffset;
  const response = await request.post('/__test__/provider', { data: { available: false } });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/agents/e2e-agent/c/${channelId}`);
  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId,
    channelType: 1,
    messageId: firstMessageId,
    messageSeq: firstMessageSeq,
    content: 'pull fallback e2e',
  });
  const pullRows = await waitForMessages(channelId, rows => rows.some(row => row.id === firstMessageId));
  expect(pullRows.some(row => row.is_me === 1 && row.content.includes('[echo] pull fallback e2e'))).toBeFalsy();
  await expect(page.locator('#msg-box')).toContainText('pull fallback e2e');
  await expect.poll(async () => (await runtime(request)).deliveryStatus.automaticDeliveryReady).toBe(false);
  const beforePull = await runtime(request);
  expect(beforePull.deliveryStatus.activeAutomaticMode).toBe(null);
  expect(beforePull.deliveryStatus.pullReady).toBe(true);
  expect(beforePull.checkpoints.some(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === `1:${channelId}`)).toBeFalsy();

  const pulled = await callMcp(request, 'voko_fetch_new_messages', {
    agentId: 'e2e-agent', visitorId: channelId, onlyReplies: true, limit: 10,
  });
  expect(pulled.success).toBe(true);
  expect(pulled.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: firstMessageId, content: 'pull fallback e2e' }),
  ]));
  const afterPull = await runtime(request);
  const cursor = afterPull.checkpoints.find(row => row.namespace === 'mcp.e2e-agent' && row.scope_key === `1:${channelId}`);
  expect(cursor).toBeTruthy();
  expect(Number(cursor.committed_value)).toBe(firstMessageSeq);

  const recovery = await request.post('/__test__/provider', { data: { available: true } });
  expect(recovery.ok()).toBeTruthy();
  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId,
    channelType: 1,
    messageId: recoveredMessageId,
    messageSeq: firstMessageSeq + 1,
    content: 'push recovered e2e',
  });
  await waitForMessages(channelId, rows => rows.some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes('push recovered e2e')));
  await expect(page.locator('#msg-box')).toContainText('push recovered e2e');
  const recovered = await runtime(request);
  expect(recovered.deliveryStatus.activeAutomaticMode).toBe('mock');
  const pullStats = recovered.messageStats.find(item => item.channelId === channelId);
  expect(readMessages(channelId).filter(row => row.is_me === 1 && row.content !== 'Agent 正在处理…')).toHaveLength(1);
  expect(Number(pullStats.replies)).toBe(2);
  expect(Number(pullStats.uniqueIds)).toBe(Number(pullStats.total));
});

test.afterEach(async ({ request }) => {
  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } }).catch(() => {});
  await request.post('/__test__/provider', { data: { available: true } }).catch(() => {});
});
