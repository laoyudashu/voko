const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const WebSocket = require('ws');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

async function setFault(request, input) {
  const m = manifest();
  const response = await request.post(`${m.services.api}/__test__/fault`, { data: input });
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({ success: true, target: input.target, mode: input.mode });
}

async function clearFaults(request) {
  const m = manifest();
  const response = await request.delete(`${m.services.api}/__test__/fault`);
  expect(response.ok()).toBeTruthy();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onError = (error) => { ws.removeAllListeners(); reject(error); };
    ws.once('open', () => { ws.removeListener('error', onError); resolve(ws); });
    ws.once('error', onError);
  });
}

function waitForClose(ws, timeout = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeout);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once('error', () => {});
  });
}

function collectMessages(ws, count, timeout = 1_000) {
  return new Promise((resolve) => {
    const messages = [];
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      resolve(messages);
    }, timeout);
    ws.on('message', (data) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        resolve(messages);
      }
    });
  });
}

test.afterEach(async ({ request }) => {
  await clearFaults(request);
});

test('HTTP faults are injected once and recover on the next request', async ({ request }) => {
  const m = manifest();
  for (const status of [401, 429, 500]) {
    await setFault(request, { target: 'voko-api', mode: `http-${status}`, count: 1 });
    expect((await request.post(`${m.services.api}/api/heartbeat`)).status()).toBe(status);
    expect((await request.post(`${m.services.api}/api/heartbeat`)).status()).toBe(200);
  }
  await setFault(request, { target: 'voko-api', mode: 'timeout', count: 1 });
  await expect(request.post(`${m.services.api}/api/heartbeat`, { timeout: 300 })).rejects.toThrow();
  expect((await request.post(`${m.services.api}/api/heartbeat`)).status()).toBe(200);
});

test('OSS and Provider faults expose failure then recovery', async ({ request }) => {
  const m = manifest();
  await setFault(request, { target: 'oss', mode: 'http-500', count: 1 });
  expect((await request.post(`${m.services.oss}/upload`, { data: 'file' })).status()).toBe(500);
  expect((await request.post(`${m.services.oss}/upload`, { data: 'file' })).status()).toBe(200);

  await setFault(request, { target: 'provider', mode: 'process-exit', count: 1 });
  expect((await request.post(`${m.services.provider}/chat`, { data: {} })).status()).toBe(503);
  expect((await request.post(`${m.services.provider}/chat`, { data: {} })).status()).toBe(200);
});

test('IM auth failure and 1006 close the connection', async ({ request }) => {
  const m = manifest();
  await setFault(request, { target: 'im', mode: 'auth-failure', count: 1 });
  const authSocket = new WebSocket(m.services.im);
  const authClosed = waitForClose(authSocket);
  await authClosed;

  await setFault(request, { target: 'im', mode: '1006', count: 1 });
  const socket = await openSocket(m.services.im);
  const closed = waitForClose(socket);
  socket.send('disconnect-me');
  const result = await closed;
  expect(result.code).toBe(1006);
});

test('IM SENDACK loss, duplicate and reorder faults are observable and bounded', async ({ request }) => {
  const m = manifest();
  await setFault(request, { target: 'im', mode: 'sendack-lost', count: 1 });
  const lostSocket = await openSocket(m.services.im);
  lostSocket.send('no-ack');
  expect(await collectMessages(lostSocket, 1, 150)).toEqual([]);
  lostSocket.terminate();

  await setFault(request, { target: 'im', mode: 'duplicate', count: 1 });
  const duplicateSocket = await openSocket(m.services.im);
  duplicateSocket.send('duplicate-me');
  expect(await collectMessages(duplicateSocket, 2)).toEqual(['duplicate-me', 'duplicate-me']);
  duplicateSocket.terminate();

  await setFault(request, { target: 'im', mode: 'reorder', count: 2 });
  const reorderSocket = await openSocket(m.services.im);
  const reordered = collectMessages(reorderSocket, 2);
  reorderSocket.send('first');
  reorderSocket.send('second');
  expect(await reordered).toEqual(['second', 'first']);
  reorderSocket.terminate();
});
