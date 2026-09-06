'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { snapshotFromProvider } = require('../build/core/provider-capability');
const { ProviderSecurityPolicyService } = require('../build/core/provider-security-policy');

function load(relative, overrides = {}, globals = {}) {
  const file = path.resolve(__dirname, '../build', relative);
  const realRequire = createRequire(file);
  const sandbox = { module: { exports: {} }, exports: {}, require: id => overrides[id] || realRequire(id),
    console: { log() {}, debug() {}, error() {}, warn() {} }, process, Buffer, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
function cliFixture(run, extra = {}) {
  const realSpawner = require('../build/core/adapters/cli-spawner');
  const command = require('../build/core/dispatcher/openclaw-command');
  const Cli = load('core/dispatcher/providers/openclaw-cli.js', {
    '../../adapters/cli-spawner': { ...realSpawner, runCli: run },
    '../openclaw-command': { ...command, resolveOpenClawRuntime: () => ({ available: true, executable: '/fixture/openclaw', argvPrefix: [], pathEntries: [] }) },
  });
  const provider = new Cli(extra);
  provider._ensureLocalContract = async () => {}; // These tests isolate execution and queue behavior.
  return provider;
}
function wsFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-ws-'));
  const Ws = load('core/dispatcher/providers/openclaw-ws.js', { os: { ...os, homedir: () => root } });
  const p = new Ws(null, null);
  t.after(() => { p.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
  return p;
}

test('unchanged OpenClaw capability refresh does not invalidate a preflight', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE agents(agent_id TEXT PRIMARY KEY,agent_name TEXT,backend_type TEXT); INSERT INTO agents VALUES('a','Audit','openclaw'); CREATE TABLE provider_conversation_bindings(id TEXT,agent_id TEXT,adapter_type TEXT,status TEXT,updated_at INTEGER)");
  const service = new ProviderSecurityPolicyService(db);
  const realNow = Date.now;
  try {
    const now = realNow(); Date.now = () => now;
    const one = snapshotFromProvider({ isAvailable: () => true }, 'openclaw-cli', 'a');
    service.storeCapability('a', 'openclaw-cli', one);
    const preflight = service.preflight('a', 'openclaw-cli', { additionalPrompt: 'test' });
    Date.now = () => now + 10;
    const two = snapshotFromProvider({ isAvailable: () => true }, 'openclaw-cli', 'a');
    assert.equal(one.capabilityDigest, two.capabilityDigest);
    service.storeCapability('a', 'openclaw-cli', two);
    assert.doesNotThrow(() => service.commit('a', preflight.preflightToken, ''));
  } finally { Date.now = realNow; db.close(); }
});

test('OpenClaw package update changes the observed identity without a model call', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-runtime-'));
  const entry = path.join(root, 'openclaw.mjs');
  fs.writeFileSync(entry, '#!/usr/bin/env node\n'); fs.chmodSync(entry, 0o755);
  const manifest = path.join(root, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'openclaw', version: '2026.7.1-2' }));
  const old = process.env.VOKO_OPENCLAW_BIN; process.env.VOKO_OPENCLAW_BIN = entry;
  t.after(() => { if (old === undefined) delete process.env.VOKO_OPENCLAW_BIN; else process.env.VOKO_OPENCLAW_BIN = old;
    fs.rmSync(root, { recursive: true, force: true }); });
  const Cli = require('../build/core/dispatcher/providers/openclaw-cli'); const p = new Cli();
  const one = snapshotFromProvider(p, 'openclaw-cli', 'a');
  assert.equal(one.frameworkVersion, '2026.7.1-2');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  const two = snapshotFromProvider(p, 'openclaw-cli', 'a');
  assert.equal(two.frameworkVersion, '2026.9.2');
  assert.notEqual(one.runtimeFingerprint, two.runtimeFingerprint);
  assert.deepEqual(Object.keys(two.supportedControls), ['additionalPrompt']);
});

test('OpenClaw manifest identity and contents use the same opened file during replacement', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-manifest-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'openclaw.mjs');
  const manifest = path.join(root, 'package.json');
  fs.writeFileSync(entry, '');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'openclaw', version: '2026.7.1-2' }));
  let replaced = false;
  let manifestFd;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.unlinkSync(manifest);
    fs.writeFileSync(manifest, JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  };
  const command = load('core/dispatcher/openclaw-command.js', { fs: { ...fs,
    openSync(file, ...args) {
      const fd = fs.openSync(file, ...args);
      if (file === manifest) manifestFd = fd;
      return fd;
    },
    statSync(file, ...args) {
      const stat = fs.statSync(file, ...args);
      if (file === manifest) replace();
      return stat;
    },
    fstatSync(fd, ...args) {
      const stat = fs.fstatSync(fd, ...args);
      if (fd === manifestFd) replace();
      return stat;
    },
  } });
  const first = command.inspectOpenClawRuntime({ executable: entry });
  assert.equal(replaced, true);
  assert.equal(first.frameworkVersion, '2026.7.1-2');
  const next = command.inspectOpenClawRuntime({ executable: entry });
  assert.equal(next.frameworkVersion, '2026.9.2');
  assert.notEqual(first.fingerprint, next.fingerprint);
});

for (const stdout of ['', JSON.stringify({ payloads: [{ text: 'error output' }] })]) {
  test('failed OpenClaw steer never emits a successful reply: ' + !!stdout, async () => {
    const p = cliFixture(async () => ({ code: 1, stdout, stderr: '' }));
    const replies = []; p.on('agent.reply', r => replies.push(r));
    await assert.rejects(p.steer('a', 'visitor', 'test'), /exited with code 1/);
    assert.equal(replies.length, 0);
  });
}

test('local turns sharing a state directory serialize across Agents', async () => {
  let calls = 0; let release;
  const p = cliFixture(async () => { calls++; if (calls === 1) await new Promise(r => { release = r; });
    return { code: 0, stdout: JSON.stringify({ payloads: [{ text: 'ok' }] }), stderr: '' }; });
  const first = p.steer('a', 'v', 'first');
  await new Promise(r => setImmediate(r));
  const second = p.steer('b', 'v', 'second');
  await new Promise(r => setImmediate(r));
  const before = calls; release(); await Promise.all([first, second]);
  assert.equal(before, 1); assert.equal(calls, 2);
});

test('stopping OpenClaw cancels a queued turn before it can execute', async () => {
  let calls = 0; let release;
  const p = cliFixture(async () => { calls++; await new Promise(r => { release = r; });
    return { code: 0, stdout: JSON.stringify({ payloads: [{ text: 'ok' }] }), stderr: '' }; });
  const first = p.steer('a', 'v', 'one');
  await new Promise(r => setImmediate(r));
  const second = p.steer('b', 'v', 'two');
  const rejected = assert.rejects(second, e => e.deliveryOutcome === 'not_delivered');
  p.stop(); release(); await first; await rejected; assert.equal(calls, 1);
});

test('WS ignores unrelated success and uses challenge timestamp for authentication', async t => {
  const p = wsFixture(t); let sent;
  p.send = m => { sent = m; };
  p.createDeviceIdentity = async () => ({ deviceId: 'device', publicKey: 'key', privateKey: 'private' });
  p.signPayload = async () => 'signature';
  const timer = setTimeout(() => {}, 2000); t.after(() => clearTimeout(timer));
  await p.handleMessage({ type: 'res', id: 'stranger', ok: true, payload: {} }, () => {}, timer);
  assert.equal(p.connected, false);
  const ts = Date.now() - 1000;
  await p.handleMessage({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts } }, () => {}, timer);
  assert.equal(sent.params.device.signedAt, ts);
  const id = sent.id;
  await p.handleMessage({ type: 'res', id, ok: true, payload: { type: 'hello-ok', protocol: 4,
    server: { version: '2026.9.2' }, features: { methods: ['chat.send'], events: ['chat'] } } }, () => {}, timer);
  assert.equal(p.connected, true);
  const evidence = snapshotFromProvider(p, 'openclaw-ws', 'a');
  assert.equal(evidence.frameworkVersion, '2026.9.2'); assert.equal(evidence.protocolVersion, '4');
});

test('WS does not sign a malformed challenge timestamp', async t => {
  for (const ts of ['invalid', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const p = wsFixture(t); let sent = 0; let signed = 0; let closed = 0;
    p.ws = { close() { closed++; } };
    p.send = () => sent++; p.createDeviceIdentity = async () => ({});
    p.signPayload = async () => { signed++; return 'signature'; };
    await p.handleMessage({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts } }, () => {}, null);
    assert.equal(sent, 0); assert.equal(signed, 0); assert.equal(closed, 1);
    assert.equal(p.connected, false);
    p.ws = null;
  }
});

test('local Gateway setup adds local mode while preserving an existing token', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.openclaw'); fs.mkdirSync(dir);
  const file = path.join(dir, 'openclaw.json');
  fs.writeFileSync(file, JSON.stringify({ gateway: { auth: { token: 'fixture-token' } }, agents: { list: [] } }));
  const handler = { getStatus: () => ({ hasToken: true, connected: true }), start: async () => {} };
  const setup = load('core/gateway-setup.js', { os: { ...os, homedir: () => root } }, {
    global: { __openclawHandler: handler }, setTimeout: fn => { queueMicrotask(fn); return 0; },
  });
  const { taskId } = setup.startSetup('openclaw');
  for (let i = 0; i < 30 && !setup.getTask(taskId).done; i++) await new Promise(r => setImmediate(r));
  assert.equal(setup.getTask(taskId).ok, true);
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.gateway.mode, 'local'); assert.equal(config.gateway.auth.token, 'fixture-token');
});

test('WS send receipt is not a completed security turn; only final completes it', async t => {
  const { initDatabase } = require('../build/core/database');
  const { createDispatcher } = require('../build/core/dispatcher');
  const db = initDatabase(':memory:', { silent: true });
  const p = wsFixture(t); p.connected = true;
  p._waitForAuthenticatedConnection = async () => {};
  let sent;
  p.sendToSession = async (sessionKey, content, extra) => { sent = { sessionKey, extra }; };
  const now = Date.now();
  db.prepare(`INSERT INTO agents(id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('row','agent-a','im-a','fixture','ws://127.0.0.1','Audit','openclaw',JSON.stringify(['websocket']),now,now);
  const dispatcher = createDispatcher({ db, providers: { 'openclaw-ws': p }, onAgentReply: () => {} });
  t.after(async () => { await dispatcher.stop(); db.close(); });
  dispatcher.dispatch('agent-a', { agentId: 'agent-a', fromUid: 'v', content: 'hello', channelId: 'v', channelType: 1, messageId: 'turn-a' });
  for (let i = 0; i < 50 && !sent; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setImmediate(r));
  assert.ok(sent);
  const state = () => db.prepare("SELECT state FROM provider_security_turns WHERE agent_id='agent-a' AND turn_id='turn-a'").get()?.state;
  assert.equal(state(), 'SUBMITTING');
  p._emitAgentReplyFromSession(sent.sessionKey, 'final', { turnId: 'turn-a', replyId: 'final-a', correlated: true });
  assert.equal(state(), 'COMPLETED');
});

test('a symlink retarget invalidates the CLI resolver cache', { skip: process.platform === 'win32' ? 'POSIX executable symlink; Windows shim resolution has separate coverage' : false }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-link-'));
  const old = process.env.VOKO_OPENCLAW_BIN;
  t.after(() => { if (old === undefined) delete process.env.VOKO_OPENCLAW_BIN; else process.env.VOKO_OPENCLAW_BIN = old; fs.rmSync(root, { recursive: true, force: true }); });
  for (const version of ['2026.6.1', '2026.9.2']) {
    const dir = path.join(root, version); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'openclaw'), '#!/usr/bin/env node\n'); fs.chmodSync(path.join(dir, 'openclaw'), 0o755);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'openclaw', version }));
  }
  const link = path.join(root, 'current'); fs.symlinkSync(path.join(root, '2026.6.1', 'openclaw'), link);
  process.env.VOKO_OPENCLAW_BIN = link;
  const Cli = require('../build/core/dispatcher/providers/openclaw-cli'); const p = new Cli();
  const before = snapshotFromProvider(p, 'openclaw-cli', 'a');
  fs.unlinkSync(link); fs.symlinkSync(path.join(root, '2026.9.2', 'openclaw'), link);
  const after = snapshotFromProvider(p, 'openclaw-cli', 'a');
  assert.equal(after.frameworkVersion, '2026.9.2'); assert.notEqual(before.runtimeFingerprint, after.runtimeFingerprint);
});

test('a timed-out local waiter cannot release the preceding active turn', async t => {
  const { acquireOpenClawState } = require('../build/core/dispatcher/openclaw-command');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-queue-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const release = await acquireOpenClawState(state, signal);
  await assert.rejects(acquireOpenClawState(state, signal, 5), e => e.code === 'OPENCLAW_LOCAL_QUEUE_TIMEOUT' && e.deliveryOutcome === 'not_delivered');
  let acquired = false;
  const third = acquireOpenClawState(state, signal).then(done => { acquired = true; done(); });
  await new Promise(r => setImmediate(r)); assert.equal(acquired, false); release(); await third;
});

for (const output of ['--agent --session-key --message --local --json', '--message']) {
  test('unknown CLI version uses a task-free contract probe: ' + output, async () => {
    const calls = [];
    const p = cliFixture(async args => { calls.push(args); return { code: 0, stdout: output, stderr: '' }; });
    delete p._ensureLocalContract;
    const runtime = { available: true, executable: '/fixture/unknown', argvPrefix: [], pathEntries: [] };
    const paths = { stateDir: '/fixture/state', configPath: '/fixture/config' };
    if (output.includes('--json')) {
      await p._ensureLocalContract(runtime, paths); await p._ensureLocalContract(runtime, paths);
      assert.equal(calls.length, 1);
    } else await assert.rejects(p._ensureLocalContract(runtime, paths), e => e.deliveryOutcome === 'not_delivered');
    assert.deepEqual(Array.from(calls[0].args), ['agent', '--help']);
  });
}

for (const gateway of [{ mode: 'remote', auth: { token: 'fixture' } }, { auth: { mode: 'password', password: 'fixture' } }, { auth: { token: { source: 'env', id: 'FIXTURE' } } }]) {
  test('Gateway setup preserves unsupported authentication/configuration: ' + JSON.stringify(gateway), async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-setup-denied-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, '.openclaw'); fs.mkdirSync(dir);
    const file = path.join(dir, 'openclaw.json'); const original = JSON.stringify({ gateway }); fs.writeFileSync(file, original);
    let starts = 0;
    const setup = load('core/gateway-setup.js', { os: { ...os, homedir: () => root } }, { global: { __openclawHandler: { start: () => starts++ } } });
    const { taskId } = setup.startSetup('openclaw');
    await new Promise(r => setImmediate(r));
    assert.equal(setup.getTask(taskId).ok, false); assert.match(setup.getTask(taskId).error, /UNSUPPORTED/);
    assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(starts, 0);
  });
}

test('WS correlates chat acknowledgements, rejects foreign finals and deduplicates final execution', async t => {
  const p = wsFixture(t); p.connected = true; p._gatewayMethods = ['chat.send'];
  let sent; p.send = m => { sent = m; };
  const events = [], replies = [];
  p.on('provider.event', e => events.push(e)); p.on('agent.reply', e => replies.push(e));
  const receipt = await p.push({ agentId: 'a', fromUid: 'v', content: 'hello', turnId: 'turn' });
  assert.equal(receipt.executionState, 'pending'); assert.equal(events.length, 0);
  const sessionKey = receipt.nativeSessionId;
  await p.handleMessage({ type: 'res', id: 'foreign', ok: true, payload: { runId: 'wrong' } });
  assert.equal(events.length, 0);
  await p.handleMessage({ type: 'res', id: sent.id, ok: true, payload: { runId: 'native-run', status: 'started' } });
  assert.equal(events[0].type, 'accepted');
  const final = runId => ({ type: 'event', event: 'chat', payload: { sessionKey, runId, state: 'final', message: { id: 'reply', role: 'assistant', content: 'ok' } } });
  await p.handleMessage(final('foreign')); assert.equal(replies.length, 0);
  await p.handleMessage(final('native-run')); await p.handleMessage(final('native-run'));
  assert.equal(replies.length, 1); assert.deepEqual(events.map(e => e.type), ['accepted', 'completed']);
});

for (const state of ['error', 'aborted']) {
  test('correlated chat ' + state + ' closes only its active execution', async t => {
    const p = wsFixture(t); p.connected = true; p._gatewayMethods = ['chat.send']; p.send = () => {};
    const events = []; p.on('provider.event', e => events.push(e));
    const receipt = await p.push({ agentId: 'a', fromUid: 'v', content: 'hello', turnId: 'turn' });
    await p.handleMessage({ type: 'event', event: 'chat', payload: { sessionKey: receipt.nativeSessionId, turnId: 'turn', state } });
    assert.equal(events[0].type, 'failed'); assert.equal(p._activeAgentTurns.size, 0);
  });
}

test('disconnect records unknown execution and does not send the task again', async t => {
  const p = wsFixture(t); p.connected = true; p._gatewayMethods = ['chat.send']; let sends = 0; p.send = () => sends++;
  const events = []; p.on('provider.event', e => events.push(e));
  await p.push({ agentId: 'a', fromUid: 'v', content: 'hello', turnId: 'turn' });
  p.disconnect();
  assert.equal(events[0].payload.state, 'outcome_unknown'); assert.equal(sends, 1); assert.equal(p.messageQueue.length, 0);
  assert.equal(snapshotFromProvider(p, 'openclaw-ws', 'a').frameworkVersion, null);
});

const contracts = require('./fixtures/openclaw-compatibility/contracts.json');
for (const fixture of contracts.versions) {
  test('fixed-package protocol contract ' + fixture.version, async t => {
    const p = wsFixture(t); let sent;
    p.send = message => { sent = message; };
    p.createDeviceIdentity = async () => ({ deviceId: 'fixture', publicKey: 'fixture', privateKey: 'fixture' });
    p.signPayload = async () => 'fixture-signature';
    await p.handleMessage(fixture.challenge);
    assert.equal(sent.params.device.signedAt, fixture.challenge.payload.ts);
    await p.handleMessage({ ...fixture.hello, id: sent.id });
    assert.equal(p.connected, true);
    assert.equal(snapshotFromProvider(p, 'openclaw-ws', 'a').frameworkVersion, fixture.version);
    const replies = []; p.on('agent.reply', e => replies.push(e));
    await p._acquireAgentTurn('a', 'turn-fixture');
    const key = fixture.chatFinal.payload.sessionKey;
    p._vokoAgentBySession.set(key.toLowerCase(), 'a');
    p.sendChatSend(key, 'test', { turnId: 'turn-fixture' });
    await p.handleMessage({ ...fixture.chatAccepted, id: sent.id });
    await p.handleMessage(fixture.chatFinal);
    assert.equal(replies.length, 1); assert.equal(replies[0].turnId, 'turn-fixture');
    assert.equal(p._activeAgentTurns.size, 0);
  });
}

for (const hello of [{ type: 'hello-ok', protocol: 3 }, { protocol: 4 }, { type: 'hello-ok', protocol: 4, features: { methods: 'chat.send' } }]) {
  test('invalid correlated hello cannot authenticate: ' + JSON.stringify(hello), async t => {
    const p = wsFixture(t); p._connectRequestId = 'expected';
    await p.handleMessage({ type: 'res', id: 'expected', ok: true, payload: hello });
    assert.equal(p.connected, false);
  });
}

test('unknown Gateway release keeps protocol compatibility without inheriting native permission evidence', async t => {
  const p = wsFixture(t); p._connectRequestId = 'expected';
  await p.handleMessage({ type: 'res', id: 'expected', ok: true, payload: { type: 'hello-ok', protocol: 4, server: { version: '2099.1.1-beta.1' }, features: { methods: ['chat.send'], events: ['chat'] } } });
  const snapshot = snapshotFromProvider(p, 'openclaw-ws', 'a');
  assert.equal(snapshot.callCompatibility, 'protocol_compatible');
  assert.deepEqual(Object.keys(snapshot.supportedControls), ['additionalPrompt']);
  assert.equal(snapshot.matchedRuleId, null);
});

test('removing Gateway config invalidates previously loaded authentication', t => {
  const p = wsFixture(t);
  p.authToken = 'fixture-token'; p.connected = true;
  assert.equal(p.loadConfig(), false);
  assert.equal(p.authToken, null); assert.equal(p.connected, false);
  assert.equal(p.getStatus().configurationError, 'OPENCLAW_CONFIG_NOT_FOUND');
});

test('state/config selectors preserve legacy locations and explicit overrides', t => {
  const { openClawPaths } = require('../build/core/dispatcher/openclaw-command');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-paths-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(home, '.clawdbot'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'clawdbot.json'), '{}');
  assert.deepEqual(openClawPaths({}, home), { stateDir: legacy, configPath: path.join(legacy, 'clawdbot.json') });
  assert.deepEqual(openClawPaths({ OPENCLAW_STATE_DIR: '~/isolated', OPENCLAW_CONFIG_PATH: '~/custom.json' }, home), { stateDir: path.join(home, 'isolated'), configPath: path.join(home, 'custom.json') });
});

test('a named VOKO_OPENCLAW_BIN override is not replaced with a different global package', t => {
  const { resolveOpenClawRuntime } = require('../build/core/dispatcher/openclaw-command');
  const old = process.env.VOKO_OPENCLAW_BIN; process.env.VOKO_OPENCLAW_BIN = 'custom-openclaw';
  t.after(() => { if (old === undefined) delete process.env.VOKO_OPENCLAW_BIN; else process.env.VOKO_OPENCLAW_BIN = old; });
  let request;
  resolveOpenClawRuntime('cli', { resolve: input => { request = input; return { available: false, argvPrefix: [], pathEntries: [] }; } });
  assert.deepEqual(request.candidates, [{ kind: 'native', command: 'custom-openclaw' }]);
});

test('a global CLI symlink follows a package-directory swap without changing the bin directory', { skip: process.platform === 'win32' ? 'POSIX executable symlink; Windows shim resolution has separate coverage' : false }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-oc-global-link-'));
  const oldPath = process.env.PATH, oldBin = process.env.VOKO_OPENCLAW_BIN, oldHome = process.env.HOME;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; process.env.PATH = oldPath; if (oldBin === undefined) delete process.env.VOKO_OPENCLAW_BIN; else process.env.VOKO_OPENCLAW_BIN = oldBin; fs.rmSync(root, { recursive: true, force: true }); });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const version of ['2026.6.1', '2026.9.2']) {
    const dir = path.join(root, version); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'openclaw'), '#!/usr/bin/env node\n'); fs.chmodSync(path.join(dir, 'openclaw'), 0o755);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'openclaw', version }));
  }
  const current = path.join(root, 'current'); fs.symlinkSync(path.join(root, '2026.6.1'), current, 'junction');
  fs.symlinkSync(path.join(current, 'openclaw'), path.join(bin, 'openclaw'));
  process.env.HOME = root; delete process.env.VOKO_OPENCLAW_BIN; process.env.PATH = bin + path.delimiter + oldPath;
  const Cli = require('../build/core/dispatcher/providers/openclaw-cli'); const p = new Cli();
  assert.equal(snapshotFromProvider(p, 'openclaw-cli', 'a').frameworkVersion, '2026.6.1');
  fs.unlinkSync(current); fs.symlinkSync(path.join(root, '2026.9.2'), current, 'junction');
  assert.equal(snapshotFromProvider(p, 'openclaw-cli', 'a').frameworkVersion, '2026.9.2');
});

test('an isolated turn that expires in the local queue never starts later', async t => {
  const { initDatabase } = require('../build/core/database');
  const { createDispatcher } = require('../build/core/dispatcher');
  const db = initDatabase(':memory:', { silent: true });
  let calls = 0, release;
  const p = cliFixture(async () => { calls++; if (calls === 1) await new Promise(r => { release = r; });
    return { code: 0, stdout: JSON.stringify({ payloads: [{ text: 'ok' }] }), stderr: '' }; });
  p._available = true;
  const now = Date.now();
  db.prepare(`INSERT INTO agents(id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('row','agent-a','im-a','fixture','ws://127.0.0.1','Audit','openclaw',JSON.stringify(['cli']),now,now);
  const dispatcher = createDispatcher({ db, providers: { 'openclaw-cli': p }, onAgentReply() {} });
  const keepAlive = setInterval(() => {}, 1000);
  const first = p.steer('b', 'v', 'hold');
  t.after(async () => { release?.(); await first; clearInterval(keepAlive); await dispatcher.stop(); db.close(); });
  await new Promise(r => setImmediate(r));
  await assert.rejects(dispatcher.executeIsolated({ agentId: 'agent-a', taskId: 'queued-task', contextId: 'ctx', content: 'must expire', executionScope: 'a2a_mailbox', sourceType: 'external',
    principalScope: 'fixture-principal', sessionScopeId: 'fixture-session', protocolContextId: 'ctx', bindingGeneration: 1, timeoutMs: 20 }), /timed out/);
  const state = db.prepare("SELECT state FROM provider_security_turns WHERE agent_id='agent-a'").get()?.state;
  release(); await first; await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(state, 'OUTCOME_UNKNOWN');
});
