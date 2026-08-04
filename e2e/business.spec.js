const { test, expect } = require('@playwright/test');
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

test('single chat sends and receives text through the real worker and Mock Provider', async ({ page, request }) => {
  await page.goto('/agents/e2e-agent/c/e2e-visitor');
  await expect(page.locator('#c')).toBeVisible();

  await expect(await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId: 'e2e-visitor',
    channelType: 1,
    messageId: '1101',
    messageSeq: 1,
    content: 'single inbound e2e',
  })).toMatchObject({ success: true, delivered: true, count: 1 });
  await waitForMessages('e2e-visitor', rows => rows.some(row => row.id === '1101') && rows.some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes('single inbound e2e')));

  await page.reload();
  await expect(page.locator('#msg-box')).toContainText('single inbound e2e');
  await expect(page.locator('#msg-box')).toContainText('[echo]');

  await page.locator('#c').fill('single outbound e2e');
  await page.locator('form[action="/messages/send"] button[type="submit"]').click();
  const rows = await waitForMessages('e2e-visitor', messages => messages.some(row => row.is_me === 1 && row.content === 'single outbound e2e'));
  await page.waitForURL(/\/agents\/e2e-agent\/c\/e2e-visitor(?:\?|$)/);
  await expect(page.locator('#msg-box')).toContainText('single outbound e2e');

  const uniqueIds = new Set(rows.map(row => row.id));
  expect(uniqueIds.size).toBe(rows.length);
  expect(rows.filter(row => row.is_me === 1).every(row => row.client_msg_no || row.content.includes('[echo]'))).toBeTruthy();
  expect(rows.every(row => row.channel_id === 'e2e-visitor' && row.channel_type === 1)).toBeTruthy();
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

  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } });
});

test('single-chat attachment upload sends note then file and returns to the conversation', async ({ page }) => {
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
});

test('provider failure leaves the message available for Pull and recovery restores push', async ({ page, request }) => {
  const response = await request.post('/__test__/provider', { data: { available: false } });
  expect(response.ok()).toBeTruthy();
  await page.goto('/agents/e2e-agent/c/e2e-pull');
  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId: 'e2e-pull',
    channelType: 1,
    messageId: '1401',
    messageSeq: 50,
    content: 'pull fallback e2e',
  });
  const pullRows = await waitForMessages('e2e-pull', rows => rows.some(row => row.id === '1401'));
  expect(pullRows.some(row => row.is_me === 1 && row.content.includes('[echo] pull fallback e2e'))).toBeFalsy();
  await expect(page.locator('#msg-box')).toContainText('pull fallback e2e');

  const recovery = await request.post('/__test__/provider', { data: { available: true } });
  expect(recovery.ok()).toBeTruthy();
  await inject(request, {
    toUid: 'e2e-im-uid',
    fromUid: 'e2e-visitor',
    channelId: 'e2e-pull',
    channelType: 1,
    messageId: '1402',
    messageSeq: 51,
    content: 'push recovered e2e',
  });
  await waitForMessages('e2e-pull', rows => rows.some(row => row.is_me === 1 && row.content.includes('[echo]') && row.content.includes('push recovered e2e')));
  await expect(page.locator('#msg-box')).toContainText('push recovered e2e');
});

test.afterEach(async ({ request }) => {
  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } }).catch(() => {});
  await request.post('/__test__/provider', { data: { available: true } }).catch(() => {});
});
