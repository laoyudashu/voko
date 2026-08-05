const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, content, content_type, is_me, status, client_msg_no
      FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC
    `).all('e2e-agent', channelId);
  } finally {
    db.close();
  }
}

async function setFault(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/fault`, { data: input });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ success: true, target: input.target, mode: input.mode });
}

async function clearFault(request, target = 'oss') {
  const response = await request.delete(`${manifest().services.api}/__test__/fault?target=${encodeURIComponent(target)}`);
  expect(response.ok()).toBeTruthy();
}

async function chooseFile(page, message, name = 'e2e-oss-recovery.txt') {
  await page.locator('#upload-file').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('OSS recovery attachment body'),
  });
  await page.locator('#upload-message').fill(message);
}

async function assertFailedUploadKeepsForm(page, channelId, message, name) {
  const error = page.locator('#upload-result .error');
  await expect(error).toBeVisible();
  await expect(error).not.toHaveText('');
  await expect(page).toHaveURL(new RegExp(`/agents/e2e-agent/upload\\?toUid=${channelId}&channelType=1`));
  await expect(page.locator('#upload-message')).toHaveValue(message);
  expect(await page.locator('#upload-file').evaluate(input => input.files?.[0]?.name || '')).toBe(name);
  await expect(page.locator('#upload-submit-btn')).not.toBeDisabled();
}

async function assertSuccessfulAttachment(channelId, note, fileName) {
  await expect.poll(() => readMessages(channelId), { timeout: 5_000 }).toHaveLength(2);
  const rows = readMessages(channelId);
  expect(rows.filter(row => row.content === note)).toHaveLength(1);
  const fileRows = rows.filter(row => row.content_type === 8 && row.content.includes(fileName));
  expect(fileRows).toHaveLength(1);
  expect(rows.every(row => row.is_me === 1 && row.status === 'sent' && row.client_msg_no)).toBe(true);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
}

test('OSS 500 shows an error without half-sent messages, then retry sends one attachment', async ({ page, request }) => {
  const channelId = 'e2e-oss-500';
  const note = 'OSS 500 retry note';
  const fileName = 'e2e-oss-500.txt';
  await setFault(request, { target: 'oss', mode: 'http-500', count: 1 });
  await page.goto(`/agents/e2e-agent/upload?toUid=${channelId}&channelType=1`);
  await chooseFile(page, note, fileName);
  await page.locator('#upload-submit-btn').click();
  await assertFailedUploadKeepsForm(page, channelId, note, fileName);
  await expect(page.locator('#upload-result .error')).toContainText('OSS');
  expect(readMessages(channelId)).toHaveLength(0);

  await clearFault(request);
  await page.locator('#upload-submit-btn').click();
  await page.waitForURL(new RegExp(`/agents/e2e-agent/c/${channelId}$`));
  await assertSuccessfulAttachment(channelId, note, fileName);
});

test('OSS timeout shows an error without half-sent messages, then retry succeeds once OSS recovers', async ({ page, request }) => {
  const channelId = 'e2e-oss-timeout';
  const note = 'OSS timeout retry note';
  const fileName = 'e2e-oss-timeout.txt';
  await setFault(request, { target: 'oss', mode: 'timeout', count: 1 });
  await page.goto(`/agents/e2e-agent/upload?toUid=${channelId}&channelType=1`);
  await chooseFile(page, note, fileName);
  await page.locator('#upload-submit-btn').click();
  await assertFailedUploadKeepsForm(page, channelId, note, fileName);
  await expect(page.locator('#upload-result .error')).toContainText(/OSS|aborted|超时|失败/i);
  expect(readMessages(channelId)).toHaveLength(0);

  await clearFault(request);
  await page.locator('#upload-submit-btn').click();
  await page.waitForURL(new RegExp(`/agents/e2e-agent/c/${channelId}$`));
  await assertSuccessfulAttachment(channelId, note, fileName);
});

test.afterEach(async ({ request }) => {
  await clearFault(request).catch(() => {});
});
