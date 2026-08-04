const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createTestRuntime, FakeClock } = require('./support/runtime');
const { startFakeServices } = require('./support/fake-services');
const { VokoIMClient } = require('../src/im-sdk/client');

test('isolated runtime owns data and releases registered resources', async () => {
  const runtime = createTestRuntime();
  const service = runtime.use(await startFakeServices());
  assert.match(runtime.dbPath, /^.+voko-test-.+voko\.db$/);
  assert.equal((await fetch(`${service.baseUrl}/api/heartbeat`, { method: 'POST' })).status, 200);
  await runtime.cleanup();
});

test('fault controller injects bounded HTTP failures and recovery', async (t) => {
  const service = await startFakeServices();
  t.after(() => service.close());
  service.faults.set({ target: 'provider', mode: 'http-401', count: 1 });
  assert.equal((await fetch(`${service.baseUrl}/provider/chat`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${service.baseUrl}/provider/chat`, { method: 'POST' })).status, 200);
});

test('fake IM can duplicate a frame and then return to normal', async (t) => {
  const service = await startFakeServices();
  t.after(() => service.close());
  service.faults.set({ target: 'im', mode: 'duplicate', count: 1 });
  const ws = new WebSocket(service.wsUrl);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const received = [];
  ws.on('message', (data) => received.push(data.toString()));
  ws.send('message-1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(received, ['message-1', 'message-1']);
});

test('separate fake API, IM, OSS and Provider services expose isolated endpoints', async (t) => {
  const service = await startFakeServices({ separate: true });
  t.after(() => service.close());

  assert.notEqual(service.apiBaseUrl, service.ossBaseUrl);
  assert.notEqual(service.apiBaseUrl, service.providerBaseUrl);
  assert.match(service.imWsUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${service.apiBaseUrl}/api/heartbeat`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${service.ossBaseUrl}/upload`, { method: 'POST', body: 'file' })).status, 200);
  assert.equal((await fetch(`${service.providerBaseUrl}/chat`, { method: 'POST', body: '{}' })).status, 200);
});

test('separate Fake IM completes the encrypted SDK handshake and inbound injection', async (t) => {
  const service = await startFakeServices({ separate: true });
  t.after(() => service.close());
  const client = new VokoIMClient({
    uid: 'e2e-sdk-agent',
    token: 'e2e-sdk-token',
    serverUrl: service.imWsUrl,
    autoReconnect: false,
    heartbeatInterval: 60_000,
  });
  t.after(() => client.disconnect());
  await client.connect();
  const sent = await client.sendText('e2e-visitor', 1, 'hello from sdk');
  assert.equal(sent.reasonCode, 1);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fake IM inbound message timeout')), 1_000);
    client.once('message', (message) => { clearTimeout(timer); resolve(message); });
  });
  assert.deepEqual(service.injectIncoming({
    toUid: 'e2e-sdk-agent',
    fromUid: 'e2e-visitor',
    channelId: 'e2e-visitor',
    channelType: 1,
    content: 'hello back',
  }), { delivered: true, count: 1, uid: 'e2e-sdk-agent' });
  const message = await received;
  assert.equal(message.content.content, 'hello back');
  assert.equal(message.fromUid, 'e2e-visitor');
});

test('fake clock releases only elapsed waits', async () => {
  const clock = new FakeClock(100);
  let done = false;
  clock.delay(20).then(() => { done = true; });
  clock.tick(19);
  await Promise.resolve();
  assert.equal(done, false);
  clock.tick(1);
  await Promise.resolve();
  assert.equal(done, true);
});
