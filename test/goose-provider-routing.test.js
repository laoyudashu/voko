const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase, SCHEMA_VERSION } = require('../build/core/database');
const GooseCliProvider = require('../build/core/dispatcher/providers/goose-cli');
const { GooseAcpProvider } = require('../build/core/dispatcher/providers/goose-acp');
const { ProviderConversationBindingStore } = require('../build/core/provider-conversation-bindings');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-goose-routing-'));
  const dbPath = path.join(dir, 'voko.db');
  const db = initDatabase(dbPath, { silent: true });
  t.after(() => {
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return { db, dbPath, dir };
}

function fakeGoose() {
  const sessions = [];
  const calls = [];
  let nextId = 1;
  const runCli = async ({ args }) => {
    calls.push([...args]);
    if (args[0] === 'session') return { stdout: JSON.stringify(sessions), stderr: '', code: 0, signal: null };
    const nameAt = args.indexOf('--name');
    const idAt = args.indexOf('--session-id');
    if (nameAt >= 0) sessions.unshift({ id: `20260806_${nextId++}`, name: args[nameAt + 1] });
    if (idAt >= 0 && !sessions.some((session) => session.id === args[idAt + 1])) {
      return { stdout: '', stderr: 'Session not found', code: 1, signal: null };
    }
    return {
      stdout: JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }),
      stderr: '', code: 0, signal: null,
    };
  };
  return { sessions, calls, runCli };
}

test('Goose CLI captures the native session id and resumes strictly by id', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  const provider = new GooseCliProvider({ db, runCli: fake.runCli, checkAvailable: () => true });
  const payload = { agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, content: 'hello', messageId: 'm1' };

  await provider.push(payload);
  const binding = db.prepare("SELECT * FROM provider_conversation_bindings WHERE status='active'").get();
  assert.equal(binding.native_session_id, '20260806_1');
  assert.equal(binding.provider_type, 'goose');
  assert.equal(binding.adapter_type, 'goose-cli');

  await provider.push({ ...payload, content: 'again', messageId: 'm2' });
  const runs = fake.calls.filter((args) => args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].slice(runs[1].indexOf('--session-id'), runs[1].indexOf('--session-id') + 3),
    ['--session-id', '20260806_1', '--resume']);
  assert.equal(runs[1].includes('--name'), false);
});

test('Goose session scope separates agents, direct messages, and groups', () => {
  const { conversationScope } = GooseCliProvider;
  const direct = conversationScope({ agentId: 'agent-a', fromUid: 'same', channelId: 'same', channelType: 1 });
  const group = conversationScope({ agentId: 'agent-a', fromUid: 'group:same', channelId: 'same', channelType: 2 });
  const otherAgent = conversationScope({ agentId: 'agent-b', fromUid: 'same', channelId: 'same', channelType: 1 });
  assert.notEqual(direct.logicalName, group.logicalName);
  assert.notEqual(direct.logicalName, otherAgent.logicalName);
  assert.match(direct.logicalName, /^voko-goose-[a-f0-9]{24}$/);
  assert.equal(direct.logicalName.includes('agent-a'), false);
});

test('Goose A2A scope separates principals that reuse the same protocol context', () => {
  const { conversationScope } = GooseCliProvider;
  const first = conversationScope({ agentId: 'agent-a', fromUid: 'a2a:same', channelId: 'same',
    channelType: 1, sessionScopeId: 'principal-scope-a' });
  const second = conversationScope({ agentId: 'agent-a', fromUid: 'a2a:same', channelId: 'same',
    channelType: 1, sessionScopeId: 'principal-scope-b' });
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.logicalName, second.logicalName);
});

test('Goose serializes concurrent first messages for one conversation', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  let active = 0;
  let maxActive = 0;
  const provider = new GooseCliProvider({
    db, checkAvailable: () => true,
    runCli: async (options) => {
      if (options.args[0] === 'run') {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const result = await fake.runCli(options);
        active -= 1;
        return result;
      }
      return fake.runCli(options);
    },
  });
  const base = { agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1 };
  await Promise.all([
    provider.push({ ...base, content: 'one', messageId: 'm1' }),
    provider.push({ ...base, content: 'two', messageId: 'm2' }),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(fake.sessions.length, 1);
});

test('Goose converts a uniquely named legacy binding to its native id', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  fake.sessions.push({ id: '20260806_legacy', name: 'goose:agent-a:visitor-a' });
  const store = new ProviderConversationBindingStore(db);
  store.saveManaged({
    agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
    providerType: 'goose', nativeSessionId: 'goose:agent-a:visitor-a',
    deliveryMode: 'cli', adapterType: 'goose-cli', expectedVersion: 0,
  });
  const provider = new GooseCliProvider({ db, runCli: fake.runCli, checkAvailable: () => true });
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, content: 'hello' });
  const binding = store.getActive('agent-a', 'visitor-a', 1);
  assert.equal(binding.nativeSessionId, '20260806_legacy');
  const run = fake.calls.find((args) => args[0] === 'run');
  assert.deepEqual(run.slice(run.indexOf('--session-id'), run.indexOf('--session-id') + 3),
    ['--session-id', '20260806_legacy', '--resume']);
});

test('Goose does not guess when a logical name has duplicate sessions', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  const scope = GooseCliProvider.conversationScope({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1 });
  fake.sessions.push({ id: 'old-1', name: scope.logicalName }, { id: 'old-2', name: scope.logicalName });
  const provider = new GooseCliProvider({ db, runCli: fake.runCli, checkAvailable: () => true });
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, content: 'hello' });
  const run = fake.calls.find((args) => args[0] === 'run');
  const createdName = run[run.indexOf('--name') + 1];
  assert.match(createdName, new RegExp(`^${scope.logicalName}-[a-f0-9]{10}$`));
  assert.equal(run.includes('--resume'), false);
});

test('Goose replaces a missing native session once without cross-channel retry', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  const store = new ProviderConversationBindingStore(db);
  store.saveManaged({
    agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
    providerType: 'goose', nativeSessionId: 'missing-id',
    deliveryMode: 'acp', adapterType: 'goose-acp', expectedVersion: 0,
  });
  const provider = new GooseCliProvider({ db, runCli: fake.runCli, checkAvailable: () => true });
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, content: 'hello' });
  const runs = fake.calls.filter((args) => args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].includes('missing-id'), true);
  assert.equal(runs[1].includes('--name'), true);
  assert.notEqual(store.getActive('agent-a', 'visitor-a', 1).nativeSessionId, 'missing-id');
});

test('Goose leaves an indeterminate delivery un-retried', async (t) => {
  const { db } = fixture(t);
  let runCount = 0;
  const provider = new GooseCliProvider({
    db, checkAvailable: () => true,
    runCli: async ({ args }) => {
      if (args[0] === 'session') return { stdout: '[]', stderr: '', code: 0, signal: null };
      runCount += 1;
      throw new Error('request timed out after write');
    },
  });
  await assert.rejects(provider.push({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1, content: 'hello' }),
    /timed out after write/);
  assert.equal(runCount, 1);
});

test('Goose suppresses a reply completed after provider stop or restart', async (t) => {
  const { db } = fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const provider = new GooseCliProvider({
    db, checkAvailable: () => true,
    runCli: async ({ args }) => {
      if (args[0] === 'session') return { stdout: '[]', stderr: '', code: 0, signal: null };
      await pending;
      return { stdout: JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stale' }] }] }),
        stderr: '', code: 0, signal: null };
    },
  });
  const replies = [];
  provider.on('agent.reply', (reply) => replies.push(reply));
  const push = provider.push({ agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a',
    channelType: 1, content: 'hello', messageId: 'm-stale' });
  await new Promise((resolve) => setImmediate(resolve));
  provider.stop();
  provider.start();
  finish();
  await push;
  assert.deepEqual(replies, []);
});

test('Goose coalesces an in-flight turn and does not execute a completed turn again', async (t) => {
  const { db } = fixture(t);
  const fake = fakeGoose();
  let runCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = new GooseCliProvider({ db, checkAvailable: () => true, runCli: async (options) => {
    if (options.args[0] === 'run') { runCount += 1; await gate; }
    return fake.runCli(options);
  } });
  const payload = { agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1,
    content: 'owner reply', messageId: 'owner-turn-1', turnId: 'owner-turn-1' };
  const first = provider.push(payload);
  const duplicate = provider.push(payload);
  release();
  await Promise.all([first, duplicate]);
  await provider.push(payload);
  assert.equal(runCount, 1);
});

test('Goose ACP and CLI accept the same native binding family', () => {
  const acp = new GooseAcpProvider({ binPath: 'goose' });
  const binding = { providerType: 'goose', providerInstanceId: null, adapterType: 'goose-cli', nativeSessionId: '20260806_1' };
  assert.equal(acp._bindingProviderType, 'goose');
  assert.equal(acp.acceptsBinding(binding), true);
});

test('Goose ACP load updates the active adapter while retaining the native id', async (t) => {
  const { db } = fixture(t);
  const store = new ProviderConversationBindingStore(db);
  const binding = store.saveManaged({
    agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
    providerType: 'goose', nativeSessionId: '20260806_1',
    deliveryMode: 'cli', adapterType: 'goose-cli', expectedVersion: 0,
  });
  const acp = new GooseAcpProvider({ db, binPath: 'goose' });
  acp._resumeSession = async () => ({ sessionId: '20260806_1', dispose() {} });
  await acp._ensureSession({ sessions: new Map(), agentCtx: {} }, 'agent-a', 'visitor-a', {
    agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1,
    content: '', providerBinding: binding,
  });
  const switched = store.getActive('agent-a', 'visitor-a', 1);
  assert.equal(switched.nativeSessionId, '20260806_1');
  assert.equal(switched.adapterType, 'goose-acp');
  assert.equal(switched.deliveryMode, 'acp');
});

test('schema migration enables Goose Push once and preserves later explicit pull-only choice', (t) => {
  const { db, dbPath, dir } = fixture(t);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('g1', 'goose-1', 'u1', 't1', 'http://im', 'published', 'goose', '["pull"]', 'private', now, now);
  insert.run('g2', 'goose-2', 'u2', 't2', 'http://im', 'published', 'acp-goose', '[ "pull" ]', 'private', now, now);
  // Goose Push was introduced by schema 7; exercise that historical boundary
  // independently from newer additive migrations.
  db.exec('PRAGMA user_version = 6');
  db.close();

  const migrated = initDatabase(dbPath, { silent: true });
  assert.equal(migrated.prepare('SELECT delivery_modes FROM agents WHERE agent_id=?').get('goose-1').delivery_modes, '["cli","pull"]');
  assert.equal(migrated.prepare('SELECT delivery_modes FROM agents WHERE agent_id=?').get('goose-2').delivery_modes, '["acp","cli","pull"]');
  migrated.prepare('UPDATE agents SET delivery_modes=? WHERE agent_id=?').run('["pull"]', 'goose-1');
  migrated.close();

  const reopened = initDatabase(dbPath, { silent: true });
  assert.equal(reopened.prepare('SELECT delivery_modes FROM agents WHERE agent_id=?').get('goose-1').delivery_modes, '["pull"]');
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
