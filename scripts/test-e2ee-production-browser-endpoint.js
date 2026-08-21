'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { extname, join, resolve } = require('node:path');
const { launchChromium } = require('./playwright-browser');

const root = resolve(__dirname, '..');
const webRoot = join(root, 'e2ee', 'target', 'web-release');
const executable = join(root, 'e2ee', 'target', 'debug', process.platform === 'win32'
  ? 'voko-e2ee-canary-endpoint.exe' : 'voko-e2ee-canary-endpoint');
let scope = {
  principal: 'production-browser-principal', browserDevice: 'production-browser-device',
  recipientDevice: 'production-recipient-device', agent: 'did:voko:production-browser-test',
  group: 'production-browser-group', conversation: 'production-browser-conversation',
  ownerScope: `production-browser-test-${process.pid}`,
};
let productionPending = null;
if (process.env.VOKO_E2EE_TEST_PERSISTED_KEY_PACKAGE === '1') {
  const database = new DatabaseSync(join(process.env.APPDATA, 'voko', 'voko-e2ee.db'), { readOnly: true });
  try {
    const row = database.prepare(`SELECT target_agent_did,owner_device_key_id,owner_scope,key_package,encrypted_pending_state
      FROM e2ee_production_key_packages WHERE local_agent_id='gym'`).get();
    if (!row) throw new Error('persisted gym KeyPackage was not found');
    scope = { ...scope, recipientDevice: row.owner_device_key_id, agent: row.target_agent_did,
      ownerScope: row.owner_scope };
    productionPending = { keyPackage: row.key_package, sealedSnapshot: Buffer.from(row.encrypted_pending_state).toString('base64url') };
  } finally { database.close(); }
}

function recipient(group = 'pending-1', conversation = 'pending-1') {
  const child = spawn(executable, ['--role=recipient', `--principal=${conversation}`,
    `--device=${scope.recipientDevice}`, `--agent=${scope.agent}`, `--group=${group}`,
    `--conversation=${conversation}`, `--owner-scope=${scope.ownerScope}`],
  { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', line => {
    const waiter = pending.shift();
    if (!waiter) return;
    try {
      const result = JSON.parse(line);
      result.success ? waiter.resolve(result) : waiter.reject(new Error(result.error || 'endpoint failed'));
    } catch (error) { waiter.reject(error); }
  });
  child.once('exit', code => {
    while (pending.length) pending.shift().reject(new Error(`endpoint exited ${code}`));
  });
  const read = () => new Promise((resolveRequest, reject) => pending.push({ resolve: resolveRequest, reject }));
  const ready = read();
  const request = command => { const result = read(); child.stdin.write(`${JSON.stringify(command)}\n`); return result; };
  return { ready, request, close() { child.stdin.end(); lines.close(); } };
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><body>production browser endpoint test</body>');
    return;
  }
  const file = join(webRoot, pathname.slice(1));
  response.setHeader('content-type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript; charset=utf-8');
  response.end(readFileSync(file));
});

(async () => {
  let lite = recipient();
  const liteReady = await lite.ready;
  if (productionPending) await lite.request({ op: 'restore_pending', sealed_snapshot: productionPending.sealedSnapshot });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await launchChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const prepared = await page.evaluate(async input => {
      const runtime = await import('/voko_e2ee_wasm.js');
      await runtime.default();
      globalThis.endpoint = new runtime.WasmBrowserEndpoint(input.principal, input.browserDevice, 1,
        input.agent, input.group, input.conversation);
      return JSON.parse(globalThis.endpoint.prepare_add(input.keyPackage));
    }, { ...scope, keyPackage: productionPending?.keyPackage || liteReady.keyPackage });
    await lite.request({ op: 'bind_route', group_id: scope.group, conversation: scope.conversation });
    await lite.request({ op: 'join', welcome: prepared.welcome });
    await page.evaluate(() => globalThis.endpoint.accept_add());
    const ack = await lite.request({ op: 'encrypt', message_id: 'production-browser-ack', text: 'GROUP_ESTABLISHED' });
    const ackText = await page.evaluate(envelope => globalThis.endpoint.decrypt_message(JSON.stringify(envelope)), ack.envelope);
    if (ackText !== 'GROUP_ESTABLISHED') throw new Error('establishment ACK mismatch');
    const requestEnvelope = await page.evaluate(() => JSON.parse(globalThis.endpoint.encrypt_message(
      'production-browser-request', 'browser request')));
    const opened = await lite.request({ op: 'decrypt', envelope: requestEnvelope });
    if (opened.text !== 'browser request') throw new Error('Lite request mismatch');
    const sealed = await lite.request({ op: 'seal_snapshot' });
    lite.close();
    lite = recipient(scope.group, scope.conversation);
    await lite.ready;
    await lite.request({ op: 'restore_sealed', sealed_snapshot: sealed.sealedSnapshot });
    await page.evaluate(input => {
      const snapshot = globalThis.endpoint.snapshot();
      const replacement = new globalThis.endpoint.constructor(input.principal, input.browserDevice, 1,
        input.agent, input.group, input.conversation);
      replacement.restore(snapshot);
      globalThis.endpoint = replacement;
    }, scope);
    const reply = await lite.request({ op: 'encrypt', message_id: 'production-browser-reply', text: 'Lite reply' });
    const replyText = await page.evaluate(envelope => globalThis.endpoint.decrypt_message(JSON.stringify(envelope)), reply.envelope);
    if (replyText !== 'Lite reply') throw new Error('browser reply mismatch');
    console.log('Production WasmBrowserEndpoint and sealed Lite endpoint round trip passed.');
  } finally {
    lite.close();
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
