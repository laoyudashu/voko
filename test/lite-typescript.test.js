const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

require('./lite-opencode-provider.test');
const express = require('express');
const { spawnSync } = require('node:child_process');

const { pluralRule } = require('../build/core/i18n/plurals');
const frame = require('../build/core/ipc/frame');
const { ErrorCode, VokoError, vokoError } = require('../build/core/ipc/error-codes');
const transcript = require('../build/core/transcript-types');
const backendTypes = require('../build/core/agent-backend-types');
const skills = require('../build/core/skills/skill-def');
const { SkillRegistry } = require('../build/core/skills/registry');
const skillSystem = require('../build/core/skills');
const auditLog = require('../build/core/audit-log');
const { RuntimeState } = require('../build/core/runtime-state');
const liteEvents = require('../build/core/lite-events');
const smoke = require('../build/testing/smoke-all');
const { createWebRouter } = require('../build/web');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');
const { requiresLocalToken, isAllowedBridgeConfigType } = require('../build/core/local-http-security');
const { updateLite } = require('../build/cli');
const { version: packageVersion } = require('../package.json');

test('pluralRule keeps the existing locale behavior', () => {
  assert.equal(pluralRule('en', 1), 'one');
  assert.equal(pluralRule('en', 0), 'other');
  assert.equal(pluralRule('en', '1'), 'one');
  assert.equal(pluralRule('zh', 1), 'other');
  assert.equal(pluralRule('ja', 1), 'other');
});

test('IPC frame keeps new and legacy wire formats compatible', () => {
  const request = frame.req('worker.send', { channelId: 'visitor-1' }, 'req-1');
  assert.equal(request.type, 'req');
  assert.equal(request.id, 'req-1');
  assert.deepEqual(request.params, { channelId: 'visitor-1' });

  const response = frame.res(request, true, { sent: true });
  assert.deepEqual(
    { type: response.type, id: response.id, ok: response.ok, payload: response.payload },
    { type: 'res', id: 'req-1', ok: true, payload: { sent: true } },
  );

  const legacy = frame.normalize({
    type: 'status',
    agentId: 'agent-1',
    status: 'connected',
    statusCode: 1,
  });
  assert.equal(legacy.type, 'event');
  assert.equal(legacy.event, 'worker.status');
  assert.deepEqual(legacy.payload, {
    agentId: 'agent-1',
    status: 'connected',
    statusCode: 1,
  });
});

test('VokoError keeps explicit, localized and passthrough behavior', () => {
  assert.deepEqual(VokoError.spawnFailed('missing cli', { provider: 'codex' }), {
    code: ErrorCode.SPAWN_FAILED,
    message: 'missing cli',
    meta: { provider: 'codex' },
  });
  assert.equal(vokoError(ErrorCode.TIMEOUT, null, undefined, 'en').code, 'timeout');
  assert.match(vokoError(ErrorCode.TIMEOUT, null, undefined, 'en').message, /timed out/i);

  const existing = { code: ErrorCode.CANCELLED, message: 'cancelled by caller' };
  assert.equal(VokoError.from(existing), existing);
  assert.deepEqual(VokoError.from(new Error('boom')), {
    code: ErrorCode.UNKNOWN,
    message: 'boom',
  });
});

test('transcript factories keep streaming entry shapes stable', () => {
  const text = transcript.VokoTranscriptEntry.text('hello', {
    agentId: 'agent-1',
    visitorId: 'visitor-1',
    seq: 2,
    timestamp: 123,
  });
  assert.deepEqual(text, {
    type: transcript.EntryType.TEXT,
    agentId: 'agent-1',
    visitorId: 'visitor-1',
    sessionKey: '',
    seq: 2,
    timestamp: 123,
    done: false,
    text: 'hello',
  });
  assert.equal(transcript.isTerminal(text), false);

  const complete = transcript.fromAgentReply({
    done: true,
    content: 'done',
    agentId: 'agent-1',
    visitorId: 'visitor-1',
  });
  assert.equal(complete.type, transcript.EntryType.COMPLETE);
  assert.equal(complete.done, true);
  assert.equal(transcript.isTerminal(complete), true);
  assert.deepEqual(complete.usage, { inputTokens: 0, outputTokens: 0 });
});

test('backend type helpers preserve DB fallback and seed behavior', () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.startsWith('SELECT data')) {
            return { data: JSON.stringify([{ value: 'custom', label: 'Custom' }]) };
          }
          return undefined;
        },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };

  assert.deepEqual(backendTypes.getBackendTypes(db), [{ value: 'custom', label: 'Custom' }]);
  assert.deepEqual(backendTypes.getBackendTypeValues(db), ['custom']);
  assert.equal(backendTypes.isKnownBackendType(db, 'custom'), true);
  assert.equal(backendTypes.isKnownBackendType(db, ''), false);
  assert.equal(backendTypes.normalizeBackendType(' Claude_Code '), 'claude-code');
  assert.equal(backendTypes.normalizeBackendType('OPEN-CLAW'), 'openclaw');
  assert.equal(backendTypes.normalizeBackendType('goose_acp'), 'acp-goose');
  assert.equal(backendTypes.normalizeBackendType('Codex CLI'), 'codex');
  assert.equal(backendTypes.normalizeBackendType('Work Buddy'), 'work-buddy');
  assert.equal(backendTypes.normalizeBackendType(null), 'others');
  backendTypes.seedBackendTypes(db);
  assert.equal(writes.length, 1);
});

test('skill definition keeps defaults, validation and aliases stable', () => {
  const skill = skills.defineSkill({
    name: 'lookup',
    description: 'Lookup',
    prompt: 'Use the lookup tool.',
  });
  assert.deepEqual(skill, {
    name: 'lookup',
    version: '1.0.0',
    description: 'Lookup',
    category: skills.SkillCategory.TOOL,
    command: '/lookup',
    prompt: 'Use the lookup tool.',
    mcpTools: [],
    examples: [],
  });
  assert.equal(skills.isValidSkill(skill), true);
  assert.equal(skills.isValidSkill(null), null);
  assert.deepEqual(skills.getSkillCommands(skill), ['/lookup']);
});

test('TypeScript skill registry keeps builtins and command matching stable', () => {
  const registry = new SkillRegistry();
  registry.init();
  assert.equal(registry.size, 5);
  assert.equal(registry.matchCommand('/query-order').name, 'query-order');
  assert.equal(registry.matchCommand(' /CHAT ').name, 'chat');
  assert.equal(registry.matchCommand('/missing'), null);
});

test('skill assignment and prompt building keep DB behavior stable', () => {
  const writes = [];
  const rows = [
    { skill_name: 'chat', config: '{"tone":"brief"}' },
    { skill_name: 'missing', config: null },
  ];
  const db = {
    prepare(sql) {
      return {
        all() { return sql.startsWith('SELECT') ? rows : []; },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
  const registry = new SkillRegistry();
  const built = skillSystem.buildAgentPrompt(db, 'agent-1', registry);
  assert.equal(built.skills.length, 1);
  assert.deepEqual(built.skills[0].config, { tone: 'brief' });
  assert.match(built.prompt, /智能客服助手/);

  skillSystem.assignSkills(db, 'agent-1', ['chat', 'refund'], { chat: { tone: 'brief' } });
  assert.equal(writes.length, 3);
  assert.match(writes[0].sql, /^DELETE FROM agent_skills/);
  assert.equal(writes[1].args[3], '{"tone":"brief"}');
  assert.equal(writes[2].args[3], null);
  assert.deepEqual(skillSystem.getAgentSkills(db, 'agent-1'), rows);
});

test('audit log keeps filtering, pagination and defaults stable', () => {
  auditLog.clear();
  const first = auditLog.audit('agent.started', { agentId: 'agent-1' });
  auditLog.audit('agent.stopped', { actor: auditLog.ActorType.OWNER, agentId: 'agent-1' });
  auditLog.audit('agent.started', { actor: auditLog.ActorType.AGENT, agentId: 'agent-2' });

  assert.equal(first.actor, auditLog.ActorType.SYSTEM);
  assert.equal(auditLog.query().total, 3);
  assert.deepEqual(
    auditLog.query({ action: 'agent.started' }).entries.map((entry) => entry.agentId),
    ['agent-2', 'agent-1'],
  );
  assert.equal(auditLog.query({ agentId: 'agent-1', limit: 1, offset: 1 }).entries[0].action, 'agent.started');
  auditLog.clear();
});

test('RuntimeState keeps snapshots, summaries and subscriptions stable', () => {
  const state = new RuntimeState();
  const snapshots = [];
  const unsubscribe = state.subscribe((snapshot) => snapshots.push(snapshot));

  state.updateAgent('agent-1', { status: 'connected', connected: true });
  state.updateAgent('agent-2', { status: 'kicked', connected: false });

  assert.equal(snapshots.length, 2);
  assert.equal(state.getAll().length, 2);
  assert.equal(state.get('agent-1').status, 'connected');
  assert.deepEqual(
    (({ total, connected, disconnected, online }) => ({ total, connected, disconnected, online }))(state.summary()),
    { total: 2, connected: 1, disconnected: 1, online: 1 },
  );

  assert.equal(unsubscribe(), true);
  state.removeAgent('agent-2');
  assert.equal(snapshots.length, 2);
  assert.equal(state.get('agent-2'), null);
});

test('lite events keep envelopes, history filters and legacy bus delivery stable', () => {
  liteEvents.clearHistory();
  const received = [];
  const listener = (event) => received.push(event);
  liteEvents.bus.on('agent.message:agent-1', listener);

  const emitted = liteEvents.Events.agentMessage('agent-1', { text: 'hello' });
  liteEvents.Events.agentStatus('agent-2', 'connected');

  liteEvents.bus.off('agent.message:agent-1', listener);
  assert.match(emitted.eventId, /^evt_/);
  assert.equal(emitted.entityType, 'agent');
  assert.deepEqual(emitted.payload, { text: 'hello' });
  assert.equal(received.length, 1);
  assert.equal(liteEvents.getHistory().length, 2);
  assert.deepEqual(liteEvents.getHistory('agent.message', 'agent-1'), [emitted]);
  liteEvents.clearHistory();
});

test('smoke registry and page are part of the Lite build artifact', () => {
  assert.ok(smoke.REGISTRY.length > 50);
  assert.equal(typeof smoke.runRegistry, 'function');
  assert.equal(typeof smoke.main, 'function');
  const messageLoop = smoke.REGISTRY.find((item) => item.id === 'A1');
  assert.equal(messageLoop.mode, 'core');
  assert.equal(typeof messageLoop.verify, 'function');
  assert.equal(smoke.requiresRunning(['--require-running']), true);
  assert.equal(smoke.requiresRunning(['--full']), false);
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'build', 'testing', 'smoke-test.html')),
    true,
  );
});

test('Web smoke page and registry work from the packaged Lite layout', async () => {
  const app = express();
  app.use(express.json());
  app.use(createWebRouter({}, { prepare() { throw new Error('DB should not be used'); } }));

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const page = await fetch(`${baseUrl}/smoke-test`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /VOKO.*冒烟测试/i);

    const registry = await fetch(`${baseUrl}/api/smoke/registry`);
    assert.equal(registry.status, 200);
    const items = await registry.json();
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 50);
    assert.deepEqual(
      items.filter((item) => !item.id || !item.name || !item.mode),
      [],
    );

    const switchAccount = await fetch(`${baseUrl}/api/logout`, { redirect: 'manual' });
    assert.equal(switchAccount.status, 302);
    assert.equal(switchAccount.headers.get('location'), '/login?mode=switch');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('privileged local bridge APIs require the instance token and accept only safe config types', () => {
  assert.equal(requiresLocalToken('/mcp'), true);
  assert.equal(requiresLocalToken('/api/llm/config'), true);
  assert.equal(requiresLocalToken('/api/config/save'), true);
  assert.equal(requiresLocalToken('/api/config/delete'), true);
  assert.equal(requiresLocalToken('/api/agent/register-in-db'), true);
  assert.equal(requiresLocalToken('/api/message/send'), true);
  assert.equal(requiresLocalToken('/api/simulate-message'), true);
  assert.equal(requiresLocalToken('/api/agent/files'), true);
  assert.equal(requiresLocalToken('/api/agent/file'), true);
  assert.equal(requiresLocalToken('/api/oss-signature'), true);
  assert.equal(isAllowedBridgeConfigType('channel_config'), true);
  assert.equal(isAllowedBridgeConfigType('llm_config'), true);
  assert.equal(isAllowedBridgeConfigType('user_access_token'), false);
  assert.equal(isAllowedBridgeConfigType('runtime'), false);
});

test('sensitive Web endpoints accept instance tokens or HttpOnly local sessions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-web-session-'));
  const db = new DatabaseSync(path.join(dir, 'voko.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE agents (agent_id TEXT, owner_email TEXT)');
  const sessions = createLocalWebSessionStore(db);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createWebRouter({}, db, { webSessions: sessions, localAuthToken: 'instance-secret' }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const denied = await fetch(`${base}/api/console?json=1`, { headers: { Accept: 'application/json' } });
  assert.equal(denied.status, 401);
  const agent = await fetch(`${base}/api/console`, {
    headers: { 'X-VOKO-Token': 'instance-secret' }, redirect: 'manual',
  });
  assert.equal(agent.status, 200);

  const created = sessions.create('owner@example.com');
  const browser = await fetch(`${base}/api/console`, {
    headers: { Cookie: `voko_session=${created.token}` }, redirect: 'manual',
  });
  assert.equal(browser.status, 200);
  assert.equal(db.prepare('SELECT owner_email FROM local_web_sessions').get().owner_email, 'owner@example.com');

  const deniedCsrf = await fetch(`${base}/api/console?json=1`, {
    method: 'POST', headers: { Cookie: `voko_session=${created.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: '{}' }),
  });
  assert.equal(deniedCsrf.status, 403);
  const allowedCsrf = await fetch(`${base}/api/console?json=1`, {
    method: 'POST',
    headers: {
      Cookie: `voko_session=${created.token}; voko_csrf=${created.csrfToken}`,
      'X-VOKO-CSRF': created.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ json: '{}' }),
  });
  assert.equal(allowedCsrf.status, 422);
});

test('guest mode exposes the bug-report page and JSON API without login', async (t) => {
  let submitted;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.locale = 'en';
    req.t = (key) => key;
    next();
  });
  app.use(createWebRouter({
    bug_report: async (params) => {
      submitted = params;
      if (params.action === 'query') return { success: true, reports: [{ title: 'Previous issue', description: 'History item', status: 'in_progress' }] };
      return { success: true, reportId: 'BR-GUEST', queryToken: 'private-token' };
    },
    oauth_providers: async () => ({ success: true, data: { providers: [] } }),
  }, { prepare() { throw new Error('guest bug report must not require database access'); } }));

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/login`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /href="\/bug-report"/);

  const page = await fetch(`${base}/bug-report`, { redirect: 'manual' });
  assert.equal(page.status, 200);

  const history = await fetch(`${base}/bug-report?view=query`);
  const historyHtml = await history.text();
  assert.match(historyHtml, /Previous issue/);
  assert.doesNotMatch(historyHtml, /name="reportId"|name="queryToken"/);

  const response = await fetch(`${base}/api/bug-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', title: 'Guest issue', description: 'Something failed', ownerEmail: 'guest@example.com' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reportId, 'BR-GUEST');
  assert.equal(submitted.source, 'guest-api');
  assert.equal(submitted.title, 'Guest issue');
  assert.equal(submitted.ownerEmail, 'guest@example.com');
});

test('short-link creation uses the owner token and never accepts a client target URL', async (t) => {
  const originalFetch = global.fetch;
  const upstreamRequests = [];
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT imUid, owner_email FROM agents')) {
            return { imUid: 'agent_uid_1', owner_email: 'owner@example.com' };
          }
          if (sql.includes('FROM config WHERE type = ?')) {
            return {
              data: JSON.stringify({
                'owner@example.com': { user_access_token: 'ut_owner_token' },
              }),
            };
          }
          return null;
        },
        run() {},
        all() { return []; },
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createWebRouter({}, db));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    upstreamRequests.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { shortUrl: 'https://www.vokovoko.com/s/agent-1' },
      }),
    };
  };

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/short-link/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'agent-1',
      targetUrl: 'https://attacker.example/redirect',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(upstreamRequests.length, 1);
  assert.match(upstreamRequests[0].url, /\/api\/external\/v1\/short-link\/create$/);
  assert.equal(upstreamRequests[0].options.headers.Authorization, 'Bearer ut_owner_token');
  assert.equal(upstreamRequests[0].options.headers['X-API-Key'], undefined);
  assert.deepEqual(JSON.parse(upstreamRequests[0].options.body), {
    agentId: 'agent-1',
    imUid: 'agent_uid_1',
    title: 'agent-1',
  });
});

test('payments page scopes SQL queries to the current owner', async (t) => {
  const queries = [];
  const db = {
    prepare(sql) {
      return {
        get(...args) {
          queries.push({ sql, args });
          if (sql.includes("type='user_access_token'")) {
            return { data: JSON.stringify({ 'owner@example.com': { user_access_token: 'ut_owner' } }) };
          }
          if (sql.includes('COUNT(*) as c')) return { c: 0, s: 0 };
          return null;
        },
        all(...args) {
          queries.push({ sql, args });
          return [];
        },
      };
    },
  };
  const app = express();
  app.use(createWebRouter({ whoami: async () => ({ agents: [] }) }, db));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/payments`);
  assert.equal(response.status, 200);
  const paymentQuery = queries.find((entry) => entry.sql.includes('COUNT(*) as c'));
  assert.match(paymentQuery.sql, /payment_orders po JOIN agents a ON a\.agent_id=po\.agent_id/);
  assert.match(paymentQuery.sql, /LOWER\(TRIM\(a\.owner_email\)\)=\?/);
  assert.equal(paymentQuery.args[0], 'owner@example.com');
});

test('agent actions return to the same agent subpage and conversation controls use native POST forms', async (t) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.locale = 'zh';
    req.t = (key) => key;
    next();
  });
  const handlers = {
    manage_whitelist: async () => ({ success: true }),
    manage_blacklist: async () => ({ success: true }),
  };
  app.use(createWebRouter(handlers, {
    prepare(sql) {
      return {
        get() {
          if (/owner_email FROM agents/i.test(sql)) return { owner_email: 'owner@example.com' };
          if (/user_access_token/i.test(sql)) return { data: JSON.stringify({ 'owner@example.com': 'ut_test' }) };
          throw new Error('unexpected database access');
        },
      };
    },
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const faviconResponse = await fetch(`${base}/favicon.png`);
  assert.equal(faviconResponse.status, 200);
  assert.equal(faviconResponse.headers.get('content-type'), 'image/png');
  assert.ok((await faviconResponse.arrayBuffer()).byteLength > 0);

  for (const item of [
    {
      referer: `${base}/agents/agent-1/whitelist?page=2&keyword=friend`,
      expected: '/agents/agent-1/whitelist?page=2&keyword=friend&ok=',
      action: 'add_whitelist',
    },
    {
      referer: '',
      returnTo: '/agents/agent-1/c/visitor-1',
      expected: '/agents/agent-1/c/visitor-1?ok=',
      action: 'remove_blacklist',
    },
  ]) {
    const response = await fetch(`${base}/agents/agent-1`, {
      method: 'POST',
      headers: item.referer ? { Referer: item.referer } : {},
      body: new URLSearchParams({ _action: item.action, visitorId: 'visitor-1', returnTo: item.returnTo || '' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.ok((response.headers.get('location') || '').startsWith(item.expected));
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /actionBtn\(isWl\?'remove_whitelist':'add_whitelist'/);
  assert.match(source, /actionBtn\(isBl\?'remove_blacklist':'add_blacklist'/);
  assert.match(source, /<form method="POST" action="\/agents\//);
  assert.match(source, /name="returnTo" value="/);
  assert.match(source, /isMe=m\.isMe===true\|\|m\.isMe===1/);
  assert.doesNotMatch(source, /isMe=m\.isMe===1,/);
  assert.doesNotMatch(source, /confirm\(I\.gen_security_tip\)/);
  assert.match(source, /id="dlg-short-link-security"/);
  assert.match(source, /data-role="confirm-gen-link"/);
  assert.doesNotMatch(source, /web\.agent\.edit\.section_runtime/);
  assert.doesNotMatch(source, /web\.agent\.edit\.section_access/);
  assert.doesNotMatch(source, /data-value="__custom__"/);
  assert.doesNotMatch(source, /'\\\\u2715'/);
  assert.match(source, /web\.conversation\.pay\.card_required_title/);
  assert.match(source, /JOIN payment_auth p ON p\.id=a\.payment_auth_id/);
  assert.doesNotMatch(source, /role="note"[^>]*short_link\.security_tip/);
});

test('compiled Lite entry handles the CLI version command', () => {
  const entry = path.join(__dirname, '..', 'build', 'index.js');
  const result = spawnSync(process.execPath, [entry, '--version'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`voko ${packageVersion}`));
  assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test('Lite runtime tests do not bypass the compiled entrypoint', () => {
  const sourceEntrypointPattern =
    /require\(\s*['"]\.\.\/src\/(?:index|context)(?:\.js)?['"]\s*\)/;
  const violations = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .filter((entry) => sourceEntrypointPattern.test(
      fs.readFileSync(path.join(__dirname, entry.name), 'utf8'),
    ))
    .map((entry) => entry.name);

  assert.deepEqual(
    violations,
    [],
    `Lite runtime tests must load build instead of src: ${violations.join(', ')}`,
  );
});

test('i18n checker scans both JavaScript and TypeScript sources', () => {
  const liteDir = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(liteDir, 'scripts', 'i18n-check.js')], {
    cwd: liteDir,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const scanned = Number(result.stdout.match(/scanned files:\s*(\d+)/)?.[1]);
  let expected = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'i18n') continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) expected++;
    }
  };
  walk(path.join(liteDir, 'src'));
  assert.equal(scanned, expected);
  assert.ok(scanned > 90);
});

test('smoke-test Lite instances never open a browser window', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(entrySource, /process\.env\.VOKO_SMOKE_TEST\s*!==\s*'1'/);
});

test('runtime has no automatic update scheduler or staged-update apply path', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.doesNotMatch(entrySource, /startAutoUpdater|applyPendingUpgrade|autoUpdateEnabled/);
  assert.doesNotMatch(entrySource, /自动升级：启动服务前应用已暂存的升级/);
});

test('version checks only notify while voko update uses the official npm registry', () => {
  const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const webSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(cliSource, /return \{ currentVersion: pkg\.version, latestVersion, updateAvailable \}/);
  assert.match(cliSource, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(cliSource, /'view', '@voko\/lite', 'version'/);
  assert.match(cliSource, /`@voko\/lite@\$\{latestVersion\}`/);
  assert.match(cliSource, /--ignore-scripts/);
  assert.match(entrySource, /function checkVersionAndPersist/);
  assert.match(entrySource, /'update_status'/);
  assert.match(webSource, /common\.footer\.update_available/);
});

test('voko update installs only from npm registry in a published installation', async () => {
  const calls = [];
  let exitCode;
  const nextVersion = packageVersion.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
  await updateLite({
    installDir: path.join('C:', 'npm', 'node_modules', '@voko', 'lite', 'build'),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return calls.length === 1 ? { status: 0, stdout: `${nextVersion}\n` } : { status: 0 };
    },
    exit(code) { exitCode = code; },
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  assert.deepEqual(calls[0].args, [
    'view', '@voko/lite', 'version', '--registry=https://registry.npmjs.org/',
  ]);
  assert.deepEqual(calls[1].args, [
    'install', '-g', '--ignore-scripts', '--registry=https://registry.npmjs.org/', `@voko/lite@${nextVersion}`,
  ]);
});

test('voko update never downgrades when npm registry is behind the installed version', async () => {
  const calls = [];
  let exitCode;
  await updateLite({
    installDir: path.join('C:', 'npm', 'node_modules', '@voko', 'lite', 'build'),
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '0.3.8\n' };
    },
    exit(code) { exitCode = code; },
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
});

test('account switching waits for old IM clients to stop before starting the shared Hub clients', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const restartRoute = entrySource.slice(
    entrySource.indexOf("app.post('/api/agents/restart'"),
    entrySource.indexOf("app.post('/api/payment/write-auth'"),
  );
  const restartHandler = entrySource.slice(
    entrySource.indexOf('handlers.restart_agent_runtime = async'),
    entrySource.indexOf('const mcpServer = createMcpServer', entrySource.indexOf('handlers.restart_agent_runtime = async')),
  );
  const implementation = /await handlers\.restart_agent_runtime\(\)/.test(restartRoute)
    ? restartHandler
    : restartRoute;
  assert.match(implementation, /await agentManager\.stopAll\(\)/);
  assert.ok(
    implementation.indexOf('await agentManager.stopAll()')
      < implementation.indexOf('await agentManager.startMany('),
  );
});

test('default lifecycle logs stay concise and stop hides the database path', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const notifierSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'notifier.js'), 'utf8');
  const databaseSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'database.ts'), 'utf8');
  assert.match(entrySource, /subcommand === 'stop'[\s\S]*?resolveDbPath\(args, \{ silent: true \}\)/);
  assert.doesNotMatch(notifierSource, /模块初始化, mainWindow=/);
  assert.doesNotMatch(databaseSource, /created\/verified|opened successfully/);
  assert.doesNotMatch(databaseSource, /数据库初始化完成/);
  assert.match(entrySource, /function printReadyBanner/);
  assert.match(entrySource, /Status:\s+READY/);
  assert.match(entrySource, /IM:\s+.*connected,.*Hub\(s\)/);
  const startupSource = entrySource.slice(entrySource.indexOf('async function startMcpServer'));
  assert.ok(
    startupSource.indexOf('await agentManager.startMany(')
      < startupSource.indexOf('await startTransport('),
  );
});

test('development mode skips fresh builds and compiles changes incrementally', () => {
  const devSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev.js'), 'utf8');
  assert.match(devSource, /buildIsCurrent\(\)/);
  assert.match(devSource, /skipping initial build/);
  assert.match(devSource, /'--incremental'/);
  assert.match(devSource, /'\.dev\.tsbuildinfo'/);
  assert.match(devSource, /syncAsset\(relative\)/);
  assert.match(devSource, /Existing VOKO instance remains active/);
  assert.doesNotMatch(devSource, /await fullBuild\(\);[\s\S]*?rebuildAndRestart/);
});

test('shared Hub runtime logs inbound, outbound, SENDACK and heartbeat summaries', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker-manager.ts'), 'utf8');
  const sendSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'send-message.ts'), 'utf8');
  assert.match(managerSource, /\[IM 接收\]/);
  assert.match(sendSource, /\[IM 发送\]/);
  assert.match(sendSource, /\[IM SENDACK\]/);
  assert.match(entrySource, /\[\$\{ts\}\]\[IM 心跳\]/);
});

test('normal startup omits routine OSS and legacy worker registry noise', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const ossSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'oss.ts'), 'utf8');
  const channelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'channels', 'registry.ts'), 'utf8');
  assert.doesNotMatch(entrySource, /历史 worker 身份无法确认/);
  assert.doesNotMatch(ossSource, /从 SQLite 加载配置/);
  assert.match(channelSource, /name !== 'voko-email'.*初始化中/);
  assert.match(channelSource, /name !== 'voko-email'[\s\S]*?处理器已启动/);
});
