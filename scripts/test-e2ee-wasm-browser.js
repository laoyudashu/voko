'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve } = require('node:path');
const { devices } = require('@playwright/test');
const { launchChromium } = require('./playwright-browser');

const root = resolve(__dirname, '..', 'e2ee', 'target', 'web-poc');
const fixtureRoot = resolve(__dirname, '..', 'e2ee', 'browser-poc');
const pageFile = join(fixtureRoot, 'index.html');
const wasmFile = join(root, 'voko_e2ee_wasm_bg.wasm');
const wasmSha256 = createHash('sha256').update(readFileSync(wasmFile)).digest('hex');
const csp = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

for (const file of ['voko_e2ee_wasm.js', 'voko_e2ee_wasm_bg.wasm']) {
  statSync(join(root, file));
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('content-security-policy', csp);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  if (pathname === '/asset-manifest.json') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ version: 1, wasmSha256 }));
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(pageFile));
    return;
  }
  if (['/main.js', '/single-writer.html', '/single-writer.js', '/indexeddb.html', '/indexeddb.js'].includes(pathname)) {
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
  const browser = await launchChromium({ headless: true });
  try {
    const page = await browser.newPage();
    const cspViolations = [];
    await page.exposeFunction('recordCspViolation', (directive) => cspViolations.push(directive));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        window.recordCspViolation(event.effectiveDirective);
      });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => document.body.dataset.status !== 'loading');
    const status = await page.getAttribute('body', 'data-status');
    const text = await page.textContent('body');
    if (status !== 'passed') throw new Error(`browser PoC ${status}: ${text}`);
    if (cspViolations.length > 0) throw new Error(`browser CSP violations: ${cspViolations.join(', ')}`);

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

    const persistenceContext = await browser.newContext();
    const persistence = await persistenceContext.newPage();
    await persistence.goto(`http://127.0.0.1:${address.port}/indexeddb.html`);
    await persistence.waitForFunction(() => document.body.dataset.status !== 'loading');
    if (await persistence.getAttribute('body', 'data-status') !== 'prepared') {
      throw new Error('browser did not atomically prepare WASM state and outbox');
    }
    await persistence.reload();
    await persistence.waitForFunction(() => document.body.dataset.status !== 'loading');
    if (await persistence.getAttribute('body', 'data-status') !== 'restored') {
      throw new Error('browser did not restore the encrypted WASM state and fixed ciphertext');
    }
    await persistenceContext.close();

    const mobileBrowser = await launchChromium({ headless: true, args: ['--js-flags=--max-old-space-size=128'] });
    try {
      const mobileContext = await mobileBrowser.newContext({ ...devices['Pixel 5'] });
      const mobile = await mobileContext.newPage();
      const startedAt = Date.now();
      await mobile.goto(`http://127.0.0.1:${address.port}/`);
      await mobile.waitForFunction(() => document.body.dataset.status !== 'loading');
      if (await mobile.getAttribute('body', 'data-status') !== 'passed') {
        throw new Error(`mobile emulation failed: ${await mobile.textContent('body')}`);
      }
      const elapsedMs = Date.now() - startedAt;
      const heapBytes = await mobile.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
      if (elapsedMs > 10_000) throw new Error(`mobile WASM initialization exceeded 10s: ${elapsedMs}ms`);
      if (heapBytes != null && heapBytes > 64 * 1024 * 1024) throw new Error(`mobile JS heap exceeded 64MiB: ${heapBytes}`);
      await mobileContext.close();
    } finally { await mobileBrowser.close(); }
    console.log('E2EE browser WASM round trip passed.');
    console.log('E2EE browser single-writer lock passed.');
    console.log('E2EE browser IndexedDB atomic recovery passed.');
    console.log('E2EE browser CSP and WASM digest gate passed.');
    console.log('E2EE constrained Pixel 5 emulation gate passed.');
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
