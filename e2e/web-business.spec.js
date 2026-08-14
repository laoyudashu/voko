const { test, expect } = require('./fixtures');
const fs = require('node:fs');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readAgent(agentId = 'e2e-agent') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT agent_id, agent_name, description, short_description, ability, did, private_key
      FROM agents WHERE agent_id=? LIMIT 1
    `).get(agentId);
  } finally {
    db.close();
  }
}

test('Agent profile edit persists through the Web form and can be restored', async ({ page }) => {
  await page.goto('/agents/e2e-agent/edit');
  const name = page.locator('#name');
  const description = page.locator('#short_description');
  await expect(name).toHaveValue('E2E Test Agent');
  const originalDescription = await description.inputValue();
  const nextDescription = `updated by web e2e ${Date.now()}`;

  await name.fill('E2E Edited Agent');
  await description.fill(nextDescription);
  await page.locator('form[data-agent-action="agent.profile.update"] button[type="submit"]').click();
  await page.waitForURL(/\/agents\/e2e-agent\?ok=/);
  await expect(page.locator('[role="alert"]')).toContainText(/profile|updated|成功|更新/i);
  expect(readAgent()).toMatchObject({ agent_name: 'E2E Edited Agent', short_description: nextDescription });

  await page.goto('/agents/e2e-agent/edit');
  await name.fill('E2E Test Agent');
  await description.fill(originalDescription);
  await page.locator('form[data-agent-action="agent.profile.update"] button[type="submit"]').click();
  await page.waitForURL(/\/agents\/e2e-agent\?ok=/);
  expect(readAgent()).toMatchObject({ agent_name: 'E2E Test Agent', short_description: originalDescription });
});

test('capability editor adds a capability and returns home after declaration', async ({ page }) => {
  await page.goto('/agents/e2e-agent/caps');
  await expect(page.locator('#caps-add')).toBeVisible();
  await page.locator('#caps-add').click();
  await expect(page.locator('.cap-card')).toHaveCount(1);
  await page.locator('.cap-name').fill('预约能力');
  await page.locator('.cap-description').fill('Schedule an appointment');
  await page.locator('.cap-tags').fill('appointment, schedule');
  await page.locator('.cap-add-field').click();
  await page.locator('.cf-name').fill('手机号');
  await page.locator('#caps-form button[type="submit"]').click();

  await page.waitForURL(/\/\?ok=/);
  await expect(page.locator('[role="alert"]')).toContainText(/capabilit|能力|成功|声明/i);
  const agent = readAgent();
  expect(agent.did).toBeTruthy();
  expect(agent.private_key).toBeTruthy();
  const abilities = JSON.parse(agent.ability || '[]');
  expect(abilities).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: '预约能力', fields: expect.arrayContaining([expect.objectContaining({ name: '手机号' })]) }),
  ]));

  // Leave the isolated runtime clean for following specs.
  await page.goto('/agents/e2e-agent/caps');
  await page.locator('.cap-remove').click();
  await page.locator('#caps-form button[type="submit"]').click();
  await page.waitForURL(/\/\?ok=/);
  expect(JSON.parse(readAgent().ability || '[]')).toEqual([]);
});

test('guest bug report submits successfully and preserves the shared footer', async ({ page }) => {
  await page.goto('/bug-report');
  await page.locator('#br-title').fill(`E2E bug ${Date.now()}`);
  await page.locator('#br-description').fill('Guest-mode Web E2E report body');
  await page.locator('#br-severity').selectOption('low');
  await page.locator('form[action="/bug-report"] button[type="submit"]').click();

  await expect(page.locator('main')).toContainText(/submitted|success|成功|提交/i);
  await expect(page.locator('[data-voko-system-footer]')).toContainText(/V\d+\.\d+\.\d+/);
  await expect(page.locator('[data-voko-language-select]')).toBeVisible();
});

test('English Web pages keep translated labels and no server template placeholders', async ({ page }) => {
  await page.goto('/agents/e2e-agent/edit?lang=en');
  await expect(page.locator('body')).toContainText(/Agent type|Description|Save/i);
  await expect(page.locator('body')).not.toContainText(/\{\{[^}]+\}\}|undefined|NaN/);
  await page.goto('/bug-report?lang=en');
  await expect(page.locator('#br-title')).toBeVisible();
  await expect(page.locator('body')).toContainText(/Report a bug|Submit/i);
});
