'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const wasmRoot = path.join(root, 'e2ee', 'target', 'web-poc');
const fixtureRoot = path.join(root, 'e2ee', 'browser-poc');
const sdkRoot = process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const adb = process.env.ADB || path.join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const csp = ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'",
  "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

function adbRun(...args) {
  return execFileSync(adb, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function serveFile(response, file) {
  response.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm'
    : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
  response.end(fs.readFileSync(file));
}

function createServer() {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('content-security-policy', csp);
    response.setHeader('x-content-type-options', 'nosniff');
    if (pathname === '/asset-manifest.json') {
      const wasm = fs.readFileSync(path.join(wasmRoot, 'voko_e2ee_wasm_bg.wasm'));
      response.setHeader('content-type', 'application/json; charset=utf-8');
      return response.end(JSON.stringify({ version: 1, wasmSha256: createHash('sha256').update(wasm).digest('hex') }));
    }
    const fixtures = new Map([
      ['/', 'index.html'], ['/index.html', 'index.html'], ['/main.js', 'main.js'],
      ['/indexeddb.html', 'indexeddb.html'], ['/indexeddb.js', 'indexeddb.js'],
    ]);
    const fixture = fixtures.get(pathname);
    if (fixture) return serveFile(response, path.join(fixtureRoot, fixture));
    const asset = path.normalize(path.join(wasmRoot, pathname.slice(1)));
    if (!asset.startsWith(wasmRoot) || !fs.existsSync(asset)) return response.writeHead(404).end();
    return serveFile(response, asset);
  });
}

async function waitForJson(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(`Android Chrome DevTools did not become available: ${url}`);
}

function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Android Chrome DevTools WebSocket failed'));
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function waitForStatus(client, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({status:document.body?.dataset?.status||null,text:document.body?.innerText||"",ua:navigator.userAgent})',
      returnByValue: true,
    });
    const value = JSON.parse(result.result.value);
    if (value.status === expected) return value;
    if (value.status && !['loading', 'waiting'].includes(value.status)) {
      throw new Error(`Android browser PoC ${value.status}: ${value.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  throw new Error(`Android browser did not reach ${expected}`);
}

(async () => {
  if (!fs.existsSync(adb)) throw new Error(`adb not found: ${adb}`);
  for (const file of ['voko_e2ee_wasm.js', 'voko_e2ee_wasm_bg.wasm']) {
    if (!fs.existsSync(path.join(wasmRoot, file))) throw new Error(`WASM browser asset missing: ${file}`);
  }
  if (!adbRun('devices').split(/\r?\n/).some((line) => /\tdevice$/.test(line))) {
    throw new Error('No booted Android emulator is connected');
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  try {
    adbRun('root');
    adbRun('wait-for-device');
    adbRun('shell', "echo 'chrome --remote-debugging-port=9222 --no-first-run --disable-fre --disable-default-apps' > /data/local/tmp/chrome-command-line");
    adbRun('shell', 'chmod', '644', '/data/local/tmp/chrome-command-line');
    adbRun('reverse', `tcp:${port}`, `tcp:${port}`);
    adbRun('shell', 'am', 'force-stop', 'com.android.chrome');
    adbRun('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `http://127.0.0.1:${port}/`, 'com.android.chrome');
    adbRun('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');
    const pages = await waitForJson('http://127.0.0.1:9222/json');
    const page = pages.find((item) => item.type === 'page' && item.url.includes(`127.0.0.1:${port}`));
    if (!page?.webSocketDebuggerUrl) throw new Error('Android Chrome did not expose the E2EE page');
    const client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    const main = await waitForStatus(client, 'passed');
    if (!/Android/i.test(main.ua)) throw new Error(`Expected Android Chrome, got: ${main.ua}`);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/indexeddb.html` });
    await waitForStatus(client, 'prepared');
    await client.send('Page.reload', { ignoreCache: false });
    await waitForStatus(client, 'restored');
    client.close();
    console.log(`E2EE Android emulator gate passed (${adbRun('shell', 'getprop', 'ro.build.version.release')}; ${os.arch()}).`);
  } finally {
    try { adbRun('forward', '--remove', 'tcp:9222'); } catch {}
    try { adbRun('reverse', '--remove', `tcp:${port}`); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
