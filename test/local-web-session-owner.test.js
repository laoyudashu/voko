'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { initDatabase, saveUserAccessToken } = require('../build/core/database');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');
const { stagePendingOwnerSwitch, activatePendingOwnerSwitch } = require('../build/core/owner-switch');
const { createWebRouter } = require('../build/web');

function request(session) {
  return { headers: { cookie: `voko_session=${session.token}; voko_csrf=${session.csrfToken}`,
    'x-voko-csrf': session.csrfToken } };
}

test('old owner independent sessions are revoked without deleting the newly created owner cookie', t => {
  const db = initDatabase(':memory:', { silent: true }); t.after(() => db.close());
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  const sessions = createLocalWebSessionStore(db);
  const a = sessions.create(' A@example.test '), anotherA = sessions.create('a@example.test');
  const b = sessions.create('b@example.test');
  sessions.destroyRequest(request(a));
  assert.equal(sessions.resolveRequest(request(a)), null);
  assert.ok(sessions.resolveRequest(request(anotherA)));
  stagePendingOwnerSwitch(db, 'b@example.test', 'synthetic-b');
  activatePendingOwnerSwitch(db);
  assert.equal(sessions.resolveRequest(request(anotherA)), null);
  assert.equal(sessions.resolveRequest(request(b)).ownerEmail, 'b@example.test');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_web_sessions WHERE owner_email='a@example.test'").get().n, 0);
});

test('session identity fails closed before activation, on direct owner changes, and after expiry', t => {
  const db = initDatabase(':memory:', { silent: true }); t.after(() => db.close());
  let now = 1000;
  const sessions = createLocalWebSessionStore(db, { now: () => now, ttlMs: 100 });
  const a = sessions.create('a@example.test');
  assert.equal(sessions.resolveRequest(request(a)), null);
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  assert.equal(sessions.resolveRequest(request(a)).ownerEmail, 'a@example.test');
  saveUserAccessToken(db, 'b@example.test', 'synthetic-b');
  assert.equal(sessions.resolveRequest(request(a)), null);
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  assert.ok(sessions.resolveRequest(request(a)));
  now = 1101;
  assert.equal(sessions.resolveRequest(request(a)), null);
});

test('same owner credential refresh preserves that owner session', t => {
  const db = initDatabase(':memory:', { silent: true }); t.after(() => db.close());
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  const sessions = createLocalWebSessionStore(db), a = sessions.create('a@example.test');
  stagePendingOwnerSwitch(db, ' A@example.test ', 'synthetic-refreshed');
  activatePendingOwnerSwitch(db);
  assert.ok(sessions.resolveRequest(request(a)));
});

test('real Web cookie routes reject the other owner after switch, with no instance-token shortcut', async t => {
  const db = initDatabase(':memory:', { silent: true });
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  const sessions = createLocalWebSessionStore(db), a = sessions.create('a@example.test'), b = sessions.create('b@example.test');
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use(createWebRouter({ restart_agent_runtime: async () => ({ success: true, count: ++calls }) }, db,
    { webSessions: sessions, localAuthToken: 'synthetic-instance' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  stagePendingOwnerSwitch(db, 'b@example.test', 'synthetic-b'); activatePendingOwnerSwitch(db);
  for (const endpoint of ['/api/console?json=1', '/api/a2a/tasks']) {
    const response = await fetch(base + endpoint, { headers: { ...request(a).headers, accept: 'application/json' }, redirect: 'manual' });
    assert.equal(response.status, 401, endpoint);
  }
  const mutate = session => fetch(base + '/api/web/agents/restart', { method: 'POST',
    headers: { ...request(session).headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await mutate(a)).status, 401);
  assert.equal(calls, 0);
  assert.equal((await mutate(b)).status, 200);
  assert.equal(calls, 1);
});

test('explicit selected-owner mismatch cannot authorize a fallback token owner', t => {
  const db = initDatabase(':memory:', { silent: true }); t.after(() => db.close());
  saveUserAccessToken(db, 'a@example.test', 'synthetic-a');
  const sessions = createLocalWebSessionStore(db), a = sessions.create('a@example.test');
  db.prepare("UPDATE config SET data=? WHERE type='current_user_email'").run(JSON.stringify('b@example.test'));
  assert.equal(sessions.resolveRequest(request(a)), null);
  db.prepare("UPDATE config SET data=? WHERE type='current_user_email'").run('{malformed');
  assert.equal(sessions.resolveRequest(request(a)), null);
});
