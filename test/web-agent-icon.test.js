const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWebRouter } = require('../build/web');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');

function multipart(boundary, data, filename = 'icon.png', contentType = 'image/png') {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test('agent edit page renders the server icon and uploads a validated replacement', async (t) => {
  let uploaded;
  let updated;
  const handlers = {
    get_agent_profile: async () => ({ success: true, data: { agentId: 'gym', agentName: 'Gym', iconUrl: 'https://files.example/old.png' } }),
    update_agent_profile: async (params) => { updated = params; return { success: true }; },
  };
  const db = { prepare: () => ({ get: () => null, all: () => [] }) };
  const app = express();
  app.use(express.raw({ type: 'multipart/form-data', limit: '6mb' }));
  app.use((req, _res, next) => { if (Buffer.isBuffer(req.body)) req.rawBody = req.body; next(); });
  app.use(createWebRouter(handlers, db, {
    localAuthToken: 'instance-secret',
    uploadAgentIcon: async (data, objectName, mimeType) => {
      uploaded = { data, objectName, mimeType };
      return 'https://files.example/new.png';
    },
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return previousFetch(url, options);
    return { json: async () => ({ success: false }) };
  };
  t.after(() => { global.fetch = previousFetch; });

  const page = await previousFetch(`${base}/agents/gym/edit`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="agent-icon-preview" src="https:\/\/files\.example\/old\.png"/);
  assert.match(html, /this\.src='\/favicon\.png'/);
  assert.match(html, /id="agent-icon-file"[^>]+accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.match(html, /type="hidden" id="iconUrl" name="iconUrl" value="https:\/\/files\.example\/old\.png"/);
  assert.doesNotMatch(html, /type="text" id="iconUrl"/);
  assert.match(html, /"Accept":"application\/json"/);
  assert.match(html, /<dialog id="voko-auth-dialog"/);
  assert.match(html, /form\.getAttribute\("action"\)\|\|location\.href/);
  assert.match(html, /id="voko-auth-email"/);
  assert.doesNotMatch(html, /window\.open\("\/reauth"/);
  assert.match(html, /dlg\.showModal\(\);code\.focus\(\)/);
  assert.match(html, /file\.size>500\*1024/);
  assert.match(html, /id="bt-instance-field"/);
  assert.match(html, /id="bt-instance"/);
  assert.match(html, /INITIAL_TYPE=/);
  assert.match(html, /ivalue\.value="";bt\.value=opt\.getAttribute/);
  const backendScript = html.match(/<script>\(function\(\)\{var w=document\.getElementById\("bt-wrapper"\)[\s\S]*?<\/script>/)?.[0]
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.ok(backendScript);
  assert.doesNotThrow(() => new Function(backendScript));

  const boundary = '----voko-icon-test';
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('test-image')]);
  const response = await previousFetch(`${base}/api/agents/gym/icon`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Voko-Token': 'instance-secret' },
    body: multipart(boundary, png),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, iconUrl: 'https://files.example/new.png' });
  assert.equal(uploaded.mimeType, 'image/png');
  assert.match(uploaded.objectName, /^agent-icons\/[0-9a-f-]+\.png$/);
  assert.deepEqual(uploaded.data, png);
  assert.deepEqual(updated, { agentId: 'gym', iconUrl: 'https://files.example/new.png' });
});

test('agent edit page escapes remote category values before rendering HTML', async (t) => {
  const handlers = {
    get_agent_profile: async () => ({ success: true, data: { agentId: 'gym', agentName: 'Gym' } }),
  };
  const db = { prepare: () => ({ get: () => null, all: () => [] }) };
  const app = express();
  app.use(createWebRouter(handlers, db));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(`http://127.0.0.1:${server.address().port}`)) return previousFetch(url, options);
    if (String(url).endsWith('/api/agent-categories')) {
      return { json: async () => ({ success: true, data: [{ code: 'general" onfocus="alert(1)', label: 'General' }] }) };
    }
    return { json: async () => ({ success: false }) };
  };
  t.after(() => { global.fetch = previousFetch; });

  const response = await previousFetch(`http://127.0.0.1:${server.address().port}/agents/gym/edit`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /value="general&quot; onfocus=&quot;alert\(1\)"/);
  assert.doesNotMatch(html, /value="general" onfocus="alert\(1\)"/);
});

test('agent icon upload rejects content that is not a supported image', async (t) => {
  let uploaded = false;
  const app = express();
  app.use(express.raw({ type: 'multipart/form-data', limit: '6mb' }));
  app.use((req, _res, next) => { if (Buffer.isBuffer(req.body)) req.rawBody = req.body; next(); });
  app.use(createWebRouter({ update_agent_profile: async () => ({ success: true }) }, { prepare: () => ({ get: () => null }) }, {
    localAuthToken: 'instance-secret',
    uploadAgentIcon: async () => { uploaded = true; },
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const boundary = '----voko-bad-icon';
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/gym/icon`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Voko-Token': 'instance-secret' },
    body: multipart(boundary, Buffer.from('<svg><script>alert(1)</script></svg>'), 'icon.svg', 'image/svg+xml'),
  });
  assert.equal(response.status, 400);
  assert.equal(uploaded, false);
});

test('agent edit page falls back to the default icon when no icon was uploaded', async (t) => {
  const app = express();
  app.use(createWebRouter({
    get_agent_profile: async () => ({ success: true, data: { agentId: 'gym', agentName: 'Gym' } }),
  }, { prepare: () => ({ get: () => null, all: () => [] }) }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ success: false }) });
  t.after(() => { global.fetch = previousFetch; });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await previousFetch(`http://127.0.0.1:${server.address().port}/agents/gym/edit`);
  assert.match(await response.text(), /id="agent-icon-preview" src="\/favicon\.png"/);
});

test('browser session can restart Agent runtime without exposing the instance token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-web-restart-'));
  const db = new DatabaseSync(path.join(dir, 'voko.db'));
  db.exec('CREATE TABLE agents (agent_id TEXT, owner_email TEXT)');
  const sessions = createLocalWebSessionStore(db);
  const session = sessions.create('owner@example.com');
  let restarted = 0;
  const app = express();
  app.use(express.json());
  app.use(createWebRouter({ restart_agent_runtime: async () => ({ success: true, count: ++restarted }) }, db, { webSessions: sessions }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/web/agents/restart`, {
    method: 'POST',
    headers: {
      Cookie: `voko_session=${session.token}; voko_csrf=${session.csrfToken}`,
      'X-VOKO-CSRF': session.csrfToken,
      Accept: 'application/json',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, count: 1 });
  assert.equal(restarted, 1);

  const unauthenticated = await fetch(`http://127.0.0.1:${server.address().port}/api/web/agents/restart`, {
    method: 'POST', headers: { Accept: 'application/json' },
  });
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedBody = await unauthenticated.json();
  assert.equal(unauthenticatedBody.success, false);
  assert.equal(unauthenticatedBody.code, 'WEB_AUTH_REQUIRED');
  assert.equal(typeof unauthenticatedBody.error, 'string');

  const missingCsrf = await fetch(`http://127.0.0.1:${server.address().port}/api/web/agents/restart`, {
    method: 'POST', headers: { Cookie: `voko_session=${session.token}`, Accept: 'application/json' },
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).code, 'WEB_AUTH_REQUIRED');
  assert.equal(restarted, 1);
});

test('reauthorization modal prefills the latest token email and creates a Web session', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-reauth-'));
  const db = new DatabaseSync(path.join(dir, 'voko.db'));
  db.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT, updated_at INTEGER); CREATE TABLE agents (agent_id TEXT, owner_email TEXT)');
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)').run('user_access_token', JSON.stringify({
    'old@example.com': { user_access_token: 'old', updated_at: 1 },
    'latest@example.com': { user_access_token: 'latest', updated_at: 2 },
  }), Date.now());
  const sessions = createLocalWebSessionStore(db);
  const handlers = {
    request_login_code: async () => ({ success: true }),
    login_by_code: async ({ email, code }) => ({ success: email === 'latest@example.com' && code === '123456' }),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createWebRouter(handlers, db, { webSessions: sessions }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/agents/gym/edit`);
  const html = await page.text();
  assert.match(html, /id="voko-auth-email" value="latest@example\.com"/);
  const commonScript = html.match(/<script>\(function\(\)\{var nativeFetch=[\s\S]*?<\/script>/)?.[0]
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.ok(commonScript);
  assert.doesNotThrow(() => new Function(commonScript));
  assert.doesNotMatch(html, /window\.open\("\/reauth"/);
  const verified = await fetch(`${base}/reauth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'verify', email: 'latest@example.com', code: '123456' }),
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { success: true });
  assert.match(verified.headers.get('set-cookie') || '', /voko_session=/);
});
