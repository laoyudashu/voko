const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId = 'e2e-group') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, content, channel_id, channel_type, is_me, status, client_msg_no, message_seq
      FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC
    `).all('e2e-agent', channelId);
  } finally {
    db.close();
  }
}

async function setFault(request, mode, count = 1) {
  const response = await request.post(`${manifest().services.api}/__test__/fault`, {
    data: { target: 'voko-api', mode, count },
  });
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({ success: true, target: 'voko-api', mode });
}

async function clearApiFault(request) {
  const response = await request.delete(`${manifest().services.api}/__test__/fault?target=voko-api`);
  expect(response.ok()).toBeTruthy();
}

async function openHealthyGroup(page) {
  await page.goto('/agents/e2e-agent/g/e2e-group');
  await expect(page.locator('body')).toContainText('E2E Test Group');
  await expect(page.locator('#group-reply-input')).toBeVisible();
}

test('group page surfaces API 401, 500 and timeout, then recovers without mutating messages', async ({ page, request }) => {
  const before = readMessages();
  for (const mode of ['http-401', 'http-500', 'timeout']) {
    await setFault(request, mode);
    await page.goto('/agents/e2e-agent/g/e2e-group');

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(mode === 'timeout' ? /aborted|timeout|超时|失败/i : new RegExp(mode.slice(5)));
    await expect(page.locator('#group-reply-input')).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/agents\/e2e-agent\/g\/e2e-group/);
    expect(readMessages()).toEqual(before);

    await clearApiFault(request);
    await openHealthyGroup(page);
  }
});

test('API failure during @all authorization keeps the form and sends exactly once after recovery', async ({ page, request }) => {
  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } });
  await openHealthyGroup(page);
  expect(await page.evaluate(() => window.__IS_MANAGER__)).toBe(true);
  const content = `api authorization recovery ${Date.now()}`;

  await setFault(request, 'http-500');
  await page.locator('#group-reply-input').fill(`@所有人 ${content}`);
  await page.evaluate(() => {
    window.__GROUP_MENTION_STATE__ = [{ token: '@所有人', uid: '', all: true }];
  });
  await page.locator('#group-reply-form button[type="submit"]').click();

  await expect(page.locator('#reply-send-err')).toBeVisible();
  await expect(page.locator('#reply-send-err')).toContainText(/500|群|失败|不可达|error/i);
  await expect(page.locator('#group-reply-input')).toHaveValue(`@所有人 ${content}`);
  expect(readMessages().filter(row => row.content === content)).toHaveLength(0);

  await clearApiFault(request);
  await page.locator('#group-reply-form button[type="submit"]').click();
  await expect.poll(() => {
    const rows = readMessages().filter(row => row.content === content);
    return rows.length === 1 && rows[0].status === 'sent';
  }, { timeout: 10_000 }).toBe(true);

  const rows = readMessages().filter(row => row.content === content);
  expect(rows).toHaveLength(1);
  expect(rows[0].is_me).toBe(1);
  expect(rows[0].status).toBe('sent');
  expect(rows[0].client_msg_no).toBeTruthy();
  expect(rows[0].id).toBeTruthy();
});

test.afterEach(async ({ request }) => {
  await clearApiFault(request).catch(() => {});
  await request.post(`${manifest().services.api}/__test__/group-role`, { data: { role: 'owner' } }).catch(() => {});
});
