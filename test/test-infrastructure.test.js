const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createTestRuntime, FakeClock } = require('./support/runtime');
const { startFakeServices } = require('./support/fake-services');

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
