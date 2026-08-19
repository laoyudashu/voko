'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { extname, join, normalize, resolve } = require('node:path');
const { launchChromium } = require('./playwright-browser');

const repo = resolve(__dirname, '..');
const wasmRoot = join(repo, 'e2ee', 'target', 'web-poc');
const fixtureRoot = join(repo, 'e2ee', 'browser-poc');
const cargo = process.env.CARGO || (process.platform === 'win32'
  ? join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe') : 'cargo');
const lite = spawn(cargo, ['run', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
  '-p', 'voko-e2ee-core', '--bin', 'voko-e2ee-lite-endpoint'], {
  cwd: repo, stdio: ['pipe', 'pipe', 'inherit'], shell: false,
});
const lines = createInterface({ input: lite.stdout });
const waiting = [];
lines.on('line', (line) => waiting.shift()?.(JSON.parse(line)));
function liteRequest(command) {
  return new Promise((resolveRequest, reject) => {
    waiting.push((result) => result.success ? resolveRequest(result) : reject(new Error(result.error)));
    lite.stdin.write(`${JSON.stringify(command)}\n`);
  });
}
const ready = new Promise((resolveReady, reject) => {
  waiting.push((result) => result.success ? resolveReady(result) : reject(new Error(result.error)));
});
const relayRecords = [];

function body(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('request too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

let keyPackage;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/canary/key-package') return send(response, { keyPackage });
    if (pathname === '/canary/establish') {
      const record = await body(request);
      relayRecords.push(JSON.stringify(record));
      await liteRequest({ op: 'join', welcome: record.welcome });
      return send(response, { state: 'commit_accepted' });
    }
    if (pathname === '/canary/ack') {
      const ack = await liteRequest({ op: 'ack' });
      relayRecords.push(ack.ciphertext);
      return send(response, { ciphertext: ack.ciphertext });
    }
    if (pathname === '/canary/message') {
      const record = await body(request);
      relayRecords.push(record.ciphertext);
      return send(response, await liteRequest({ op: 'decrypt', ciphertext: record.ciphertext }));
    }
    const relative = pathname === '/' ? 'cross-process.html' : pathname.slice(1);
    const root = relative.startsWith('voko_e2ee_') ? wasmRoot : fixtureRoot;
    const file = normalize(join(root, relative));
    if (!file.startsWith(root)) return response.writeHead(403).end();
    response.setHeader('content-type', extname(file) === '.wasm' ? 'application/wasm'
      : extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(readFileSync(file));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
});

function send(response, value) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

(async () => {
  ({ keyPackage } = await ready);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await launchChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.body.dataset.status !== 'loading');
    const status = await page.getAttribute('body', 'data-status');
    if (status !== 'passed') throw new Error(await page.textContent('body'));
    const observed = relayRecords.join('\n');
    if (observed.includes('E2EE_CROSS_PROCESS_SERVER_MUST_NOT_SEE')) throw new Error('relay observed plaintext');
    console.log('E2EE Browser/WASM → ciphertext relay → Lite process canary passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  lite.stdin.end(); lines.close();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
});
