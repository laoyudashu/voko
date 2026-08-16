'use strict';

const http = require('node:http');
const { readFileSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve } = require('node:path');
const { chromium } = require('@playwright/test');

const root = resolve(__dirname, '..', 'e2ee', 'target', 'web-poc');
const fixtureRoot = resolve(__dirname, '..', 'e2ee', 'browser-poc');
const pageFile = join(fixtureRoot, 'index.html');

for (const file of ['voko_e2ee_wasm.js', 'voko_e2ee_wasm_bg.wasm']) {
  statSync(join(root, file));
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(pageFile));
    return;
  }
  if (pathname === '/single-writer.html' || pathname === '/single-writer.js') {
    const fixture = normalize(join(fixtureRoot, pathname.slice(1)));
    if (!fixture.startsWith(fixtureRoot)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader(
      'content-type',
      extname(fixture) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    );
    response.end(readFileSync(fixture));
    return;
  }
  const file = normalize(join(root, pathname.slice(1)));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.setHeader(
      'content-type',
      extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript; charset=utf-8',
    );
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});

(async () => {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => document.body.dataset.status !== 'loading');
    const status = await page.getAttribute('body', 'data-status');
    const text = await page.textContent('body');
    if (status !== 'passed') throw new Error(`browser PoC ${status}: ${text}`);

    const lockContext = await browser.newContext();
    const first = await lockContext.newPage();
    const second = await lockContext.newPage();
    await first.goto(`http://127.0.0.1:${address.port}/single-writer.html`);
    await first.waitForFunction(() => document.body.dataset.status !== 'waiting');
    await second.goto(`http://127.0.0.1:${address.port}/single-writer.html`);
    await second.waitForFunction(() => document.body.dataset.status !== 'waiting');
    if (await first.getAttribute('body', 'data-status') !== 'acquired') {
      throw new Error('first tab did not acquire the group writer lock');
    }
    if (await second.getAttribute('body', 'data-status') !== 'blocked') {
      throw new Error('second tab advanced past the group writer lock');
    }
    await first.evaluate(() => window.releaseGroupLock());
    await first.close();
    await second.reload();
    await second.waitForFunction(() => document.body.dataset.status !== 'waiting');
    if (await second.getAttribute('body', 'data-status') !== 'acquired') {
      throw new Error('group writer lock was not recoverable after the leader closed');
    }
    await lockContext.close();
    console.log('E2EE browser WASM round trip passed.');
    console.log('E2EE browser single-writer lock passed.');
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
