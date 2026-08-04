const { test, expect } = require('@playwright/test');

test('isolated runtime exposes health without browser errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.request.get('/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ status: 'ok' });
  expect(errors).toEqual([]);
});

test('guest bug report page includes the shared footer and language controls', async ({ page }) => {
  await page.goto('/bug-report');
  await expect(page.locator('body')).toContainText(/错误上报|Report a bug/i);
  await expect(page.locator('body')).toContainText(/V\d+\.\d+\.\d+/);
  await expect(page.locator('a[href*="lang=zh"]')).toBeVisible();
});

test('English landing flow renders without leaking server-side templates', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.locator('body')).not.toContainText(/\{\{[^}]+\}\}/);
  await expect(page.locator('body')).toContainText('E2E Test Agent');
});

test('Agent edit, capability and attachment pages use the isolated seeded Agent', async ({ page }) => {
  await page.goto('/agents/e2e-agent');
  await expect(page.locator('body')).toContainText('E2E Test Agent');

  await page.goto('/agents/e2e-agent/caps');
  await expect(page.locator('body')).toContainText(/能力声明|capabilit/i);

  await page.goto('/agents/e2e-agent/upload?toUid=e2e-visitor&channelType=1');
  await expect(page.locator('body')).toContainText(/添加附件|attachment/i);
  const fileInput = page.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles('package.json');
  expect(await fileInput.evaluate((input) => input.files.length)).toBe(1);
});
