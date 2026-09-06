'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { initDatabase, saveUserAccessToken } = require('../build/core/database');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');
const { createLiveEventsWs, createMessageEventsWs } = require('../build/web/live-events-ws');

async function fixture(t, endpoint = '/voko/events/ws') {
  const db = initDatabase(':memory:', { silent: true });
  saveUserAccessToken(db, 'owner@example.test', 'synthetic-owner');
  let now = 1000;
  const sessions = createLocalWebSessionStore(db, { now: () => now, ttlMs: 100 });
  const server = http.createServer((req, res) => res.end('healthy'));
  const wss = new WebSocket.Server({ server });
  const auth = { authToken: 'synthetic-instance', webSessions: sessions };
  const stream = endpoint === '/ws' ? createMessageEventsWs(wss, auth) : createLiveEventsWs(wss, null, null, auth);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { stream.close(); for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  async function connect(headers = {}, query = '') {
    const ws = new WebSocket(`ws://${base}${endpoint}${query}`, { headers });
    const closed = once(ws, 'close'); await once(ws, 'open');
    t.after(() => ws.terminate());
    return { ws, closed };
  }
  return { db, sessions, stream, base, connect, expire: () => { now = 1101; } };
}

test('native clients need credentials, and tokens in URLs cannot authorize console events', async t => {
  const f = await fixture(t);
  for (const query of ['', '?token=synthetic-instance']) {
    const { ws, closed } = await f.connect({}, query);
    assert.equal(f.stream.clients.size, 0, 'unauthenticated connections cannot subscribe');
    f.stream.broadcast({ type: 'private-event', data: 'synthetic' });
    const [code] = await closed;
    assert.equal(code, 4001); assert.equal(f.stream.clients.has(ws), false);
  }
});

test('valid instance credentials retain Host and Origin checks', async t => {
  const f = await fixture(t);
  const bad = await f.connect({ 'x-voko-token': 'synthetic-instance', origin: 'https://evil.example' });
  assert.equal((await bad.closed)[0], 4001);
  const good = await f.connect({ 'x-voko-token': 'synthetic-instance', origin: `http://${f.base}` });
  const message = once(good.ws, 'message'); f.stream.broadcast({ type: 'verified' });
  assert.equal(JSON.parse((await message)[0]).type, 'verified');
});

test('cookie sessions are revalidated before sending after logout, expiry and owner change', async t => {
  const f = await fixture(t);
  for (const reason of ['logout', 'owner', 'expiry']) {
    saveUserAccessToken(f.db, 'owner@example.test', 'synthetic-owner');
    const session = f.sessions.create('owner@example.test');
    const req = { headers: { cookie: `voko_session=${session.token}` } };
    const client = await f.connect({ ...req.headers, origin: `http://${f.base}` });
    const received = []; client.ws.on('message', data => received.push(JSON.parse(data)));
    if (reason === 'logout') f.sessions.destroyRequest(req);
    else if (reason === 'owner') saveUserAccessToken(f.db, 'other@example.test', 'synthetic-other');
    else f.expire();
    const outcome = Promise.race([client.closed.then(([code]) => ({ code })),
      once(client.ws, 'message').then(() => ({ leaked: true }))]);
    f.stream.broadcast({ type: 'must-not-leak' });
    assert.deepEqual(await outcome, { code: 4001 });
    assert.equal(received.length, 0);
  }
});

for (const endpoint of ['/ws', '/voko/events/ws']) {
  test(`${endpoint} enforces Host, current-owner cookie and Bearer credentials`, async t => {
    const f = await fixture(t, endpoint);
    const anonymous = await f.connect();
    assert.equal((await anonymous.closed)[0], 4001);
    const badHost = await f.connect({ host: 'evil.example', authorization: 'Bearer synthetic-instance' });
    assert.equal((await badHost.closed)[0], 4001);
    const bearer = await f.connect({ authorization: 'Bearer synthetic-instance' });
    const receipt = once(bearer.ws, 'message'); f.stream.broadcast({ type: 'authorized' });
    assert.equal(JSON.parse((await receipt)[0]).type, 'authorized');
    const session = f.sessions.create('owner@example.test');
    const req = { headers: { cookie: `voko_session=${session.token}` } };
    const client = await f.connect(req.headers);
    const initial = once(client.ws, 'message'); f.stream.broadcast({ event: 'before-logout' });
    assert.equal(JSON.parse((await initial)[0]).event, 'before-logout');
    f.sessions.destroyRequest(req);
    f.stream.broadcast({ event: 'after-logout' });
    assert.equal((await client.closed)[0], 4001);
  });
}

test('intervention page reconnects after transport loss and stops after authorization failure', async t => {
  const express = require('express');
  const vm = require('node:vm');
  const { createWebRouter } = require('../build/web');
  const db = initDatabase(':memory:', { silent: true });
  const app = express(); app.use(createWebRouter({}, db));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/interventions`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(value => value.includes('owner-intervention:email-reply') && value.includes('new WebSocket'));
  assert.ok(script);
  const sockets = [], timers = [];
  vm.runInNewContext(script, {
    WebSocket: class { constructor() { sockets.push(this); } },
    location: { host: '127.0.0.1', reload() {} },
    setTimeout: callback => timers.push(callback),
  });
  assert.equal(sockets.length, 1);
  sockets[0].onclose({ code: 1006 }); assert.equal(timers.length, 1);
  timers.shift()(); assert.equal(sockets.length, 2);
  sockets[1].onclose({ code: 4001 }); assert.equal(timers.length, 0);
});
