const { defineConfig } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function freePort() {
  const script = "const n=require('net'),s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
}

const port = Number(process.env.VOKO_E2E_PORT || freePort());
process.env.VOKO_E2E_PORT = String(port);
process.env.VOKO_E2E_SERVICES_FILE = process.env.VOKO_E2E_SERVICES_FILE
  || path.join(os.tmpdir(), `voko-e2e-services-${process.pid}.json`);

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/start-e2e-voko.js',
    url: `http://127.0.0.1:${port}/health`,
    timeout: 45_000,
    reuseExistingServer: false,
    env: { VOKO_E2E_PORT: String(port) },
  },
  projects: [{
    name: process.env.VOKO_E2E_BROWSER || 'chromium',
    use: {
      browserName: process.env.VOKO_E2E_BROWSER || 'chromium',
      baseURL: `http://127.0.0.1:${port}`,
    },
  }],
});
