const base = require('@playwright/test');
const fs = require('node:fs');

const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const events = [];
    const append = (line) => events.push(`${new Date().toISOString()} ${line}`);
    page.on('console', message => append(`[console:${message.type()}] ${message.text()}`));
    page.on('pageerror', error => append(`[pageerror] ${error.stack || error.message}`));
    page.on('requestfailed', request => append(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
    await use(page);
    const outputPath = testInfo.outputPath('browser-console.log');
    fs.writeFileSync(outputPath, `${events.join('\n')}${events.length ? '\n' : ''}`, 'utf8');
    await testInfo.attach('browser-console', { path: outputPath, contentType: 'text/plain' });
  },
});

module.exports = { test, expect: base.expect };
