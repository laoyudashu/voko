'use strict';

const { existsSync } = require('node:fs');
const { chromium } = require('@playwright/test');

const MACOS_BROWSER_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]);

function localBrowserExecutable() {
  const configured = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '').trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${configured}`);
    return configured;
  }
  if (process.platform !== 'darwin') return null;
  return MACOS_BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) || null;
}

async function launchChromium(options = {}) {
  const executablePath = localBrowserExecutable();
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : {}) });
}

module.exports = { launchChromium, localBrowserExecutable };
