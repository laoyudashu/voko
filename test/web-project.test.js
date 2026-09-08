const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createProjectClient } = require('../build/core/project-client');
function db(owner = 'a@example.test') {
  return { prepare(sql) { return { get() { if(sql.includes('SELECT imUid'))return {imUid:'selected-agent'}; }, run() {}, all() {
    if (sql.includes('SELECT data')) return [{ data: JSON.stringify({ 'a@example.test': { user_access_token: 'a-secret' }, 'b@example.test': { user_access_token: 'b-secret' } }) }];
    if (sql.includes('owner_email')) return [{ owner_email: owner }];
    if (sql.includes('imUid')) return [{ imUid: 'selected-agent' }];
    return [];
  } }; } };
}
test('project proxy binds selected Agent, owner and route channel; credentials never returned', async () => {
  let calls = 0;
  const client = createProjectClient(db(), async (url, options) => {
    calls++; assert.equal(url, 'https://im.vokovoko.com/api/projects/v1/plans/create');
    assert.equal(options.headers.Authorization, 'Bearer a-secret');
    assert.equal(options.headers['X-Voko-Agent-Uid'], 'selected-agent');
    assert.equal(options.redirect, 'error'); assert.equal(JSON.parse(options.body).channel_id, 'route-channel');
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ success: true, data: { project: null } }) };
  });
  const result = await client('agent', 'route-channel', 'create', { channel_id: 'forged' });
  assert.equal(result.status, 200); assert.equal(result.body.data.viewer_uid, 'selected-agent');
  assert.ok(!JSON.stringify(result).includes('secret')); assert.equal(calls, 1);
  assert.equal((await client('agent', 'c', '../get')).status, 404); assert.equal(calls, 1);
});
test('missing owner does not fall back to another account', async () => {
  const client = createProjectClient(db('unknown'), () => { throw Error('must not fetch'); });
  assert.equal((await client('agent','c','get')).status, 401);
});
test('network failure is redacted and never retried; conflict status retained', async () => {
  let calls = 0;
  const client = createProjectClient(db(), async () => { calls++; throw new Error('secret'); });
  const result = await client('agent','c','create');
  assert.equal(calls, 1); assert.equal(result.status, 503); assert.ok(!JSON.stringify(result).includes('secret'));
  const conflict = createProjectClient(db(), async () => ({ ok: false, status: 409, json: async () => ({ code: 'PROJECT_CONFLICT', error: 'secret' }) }));
  assert.deepEqual(await conflict('a','c','edit'), { status: 409, body: { success: false, code: 'PROJECT_CONFLICT' } });
});
test('project writes retain the shared local session and CSRF boundary', async t => {
  const { createWebRouter } = require('../build/web');
  let session = null;
  const app = express();
  const fakeDb = { prepare() { return { get() {}, all() { return []; }, run() {} }; } };
  app.use(createWebRouter({}, fakeDb, { webSessions: { resolveRequest: () => session, verifyCsrf: () => false } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/agents/a/g/c/project/action/enable`;
  let response = await fetch(url,{method:'POST'});
  assert.equal(response.status,401); assert.equal((await response.json()).code,'WEB_AUTH_REQUIRED');
  session = { email: 'local@example.test' };
  response = await fetch(url,{method:'POST'});
  assert.equal(response.status,403); assert.equal((await response.json()).code,'WEB_AUTH_REQUIRED');
});
