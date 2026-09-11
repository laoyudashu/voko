'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
function load(relative, overrides = {}, globals = {}) {
  const file = path.join(root, 'build', relative), req = createRequire(file);
  const sandbox = { module: { exports: {} }, require: id => overrides[id] || req(id),
    console: quiet, process, Buffer, AbortController, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
function wsFixture(t, globals = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-gateway-test-'));
  const commands = require('../build/core/dispatcher/openclaw-command');
  const P = load('core/dispatcher/providers/openclaw-ws.js', {
    '../openclaw-command': { ...commands, openClawPaths: () => ({ stateDir: home, configPath: path.join(home, 'openclaw.json') }) },
  }, globals);
  const p = new P(null, null);
  t.after(() => { p.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const config = auth => { fs.writeFileSync(p.configPath, JSON.stringify({ gateway: { mode: 'local', auth } })); p.loadConfig(); };
  return { p, config };
}
test('OpenClaw refuses missing credentials at both start and heartbeat entry points', async t => {
  const { p, config } = wsFixture(t);
  config({ mode: 'token' });
  let launches = 0;
  p._startGatewayAndWait = async () => { launches++; return true; };
  assert.equal(await p.start(), false);
  assert.equal(p.getStatus().configurationError, 'OPENCLAW_TOKEN_MISSING');
  assert.equal(await p._ensureGatewayRunning(), false);
  assert.equal(launches, 0);
});
test('OpenClaw status never serializes the authentication credential', t => {
  const { p, config } = wsFixture(t);
  config({ mode: 'token', token: 'fixture-secret' });
  const status = p.getStatus();
  assert.equal(status.hasToken, true);
  assert.equal(Object.hasOwn(status, 'authToken'), false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-secret/);
});
test('OpenClaw repairs a blocked start by reconnecting when valid configuration is loaded', async t => {
  const { p, config } = wsFixture(t);
  config({ mode: 'none' });
  await p.start();
  p._probeGateway = async () => true;
  let connects = 0;
  p.connect = async () => { connects++; p.connected = true; };
  config({ mode: 'token', token: 'fixture' });
  for (let i = 0; i < 10 && !p.connected; i++) await new Promise(setImmediate);
  assert.equal(p.connected, true);
  assert.equal(p.enabled, true);
  assert.equal(connects, 1);
});
test('OpenClaw configuration repair respects an explicitly stopped provider', async t => {
  const { p, config } = wsFixture(t);
  await p.stop();
  let launches = 0;
  p._startGatewayAndWait = async () => { launches++; return true; };
  config({ mode: 'token', token: 'fixture' });
  assert.equal(await p._ensureGatewayRunning(), false);
  assert.equal(launches, 0);
});
test('OpenClaw retains enablement after startup failure and retries authentication on recovery', async t => {
  const { p, config } = wsFixture(t);
  config({ mode: 'token', token: 'fixture' });
  p._startGatewayAndWait = async () => false;
  assert.equal(await p.start(), false);
  assert.equal(p.enabled, true);
  p._startGatewayAndWait = async () => true;
  p.connect = async () => { p.connected = true; };
  assert.equal(await p.start(), true);
});
for (const platform of ['win32', 'linux', 'darwin']) {
  test(`OpenClaw gateway uses the shared runtime entry, arguments and environment on ${platform}`, () => {
    const fakeProcess = Object.create(process);
    Object.defineProperty(fakeProcess, 'platform', { value: platform });
    const selected = platform === 'win32' ? 'C:/selected/node.exe' : '/selected/node';
    const env = { PATH: '/selected/runtime' };
    const runtime = { available: true, executable: selected };
    const P = load('core/dispatcher/providers/openclaw-ws.js', { '../openclaw-command': {
      resolveOpenClawRuntime: mode => { assert.equal(mode, 'cli'); return runtime; },
      runtimeSpawnOptions: value => { assert.equal(value, runtime); return { cmd: selected, prefixArgs: ['selected/openclaw.mjs'], env }; },
    } }, { process: fakeProcess });
    const invocation = P.prototype._resolveOpenclawCmd.call({});
    assert.equal(invocation.cmd, selected);
    assert.deepEqual([...invocation.args], ['selected/openclaw.mjs', 'gateway', 'run']);
    assert.equal(invocation.env, env);
    assert.equal(invocation.shell, false);
  });
}
test('OpenClaw gateway honors a real explicit executable and rejects a missing override', t => {
  const previous = process.env.VOKO_OPENCLAW_BIN;
  t.after(() => { if (previous === undefined) delete process.env.VOKO_OPENCLAW_BIN; else process.env.VOKO_OPENCLAW_BIN = previous; });
  const P = require('../build/core/dispatcher/providers/openclaw-ws');
  process.env.VOKO_OPENCLAW_BIN = process.execPath;
  assert.equal(fs.realpathSync(P.prototype._resolveOpenclawCmd.call({}).cmd), fs.realpathSync(process.execPath));
  process.env.VOKO_OPENCLAW_BIN = path.join(os.tmpdir(), 'voko-missing-runtime', 'openclaw');
  assert.throws(() => P.prototype._resolveOpenclawCmd.call({}), /OPENCLAW_RUNTIME_UNAVAILABLE/);
});
function hermes() {
  const P = load('core/dispatcher/providers/hermes-http.js', {}, { setTimeout: fn => setImmediate(fn) });
  const p = new P(null, null, { profiles: { one: { apiKey: 'fixture' } }, profileConfigLoader: () => null });
  p.client = { _agentPort: () => 8642, destroy() {} };
  return p;
}
async function setupFixture(t, { authenticated = false, yaml, saveError = false, profile = 'one' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-hermes-setup-'));
  const profiles = path.join(home, 'profiles');
  const file = profile === 'default' ? path.join(home, 'config.yaml') : path.join(profiles, profile, 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml || 'platforms:\n  api_server:\n    enabled: true\n    extra:\n      port: 8642\n      key: fixture-key\n');
  const h = hermes();
  await h._initClient();
  let launches = 0, probes = 0, saved;
  h.client._request = async (_method, endpoint) => { probes++; assert.equal(endpoint, '/v1/models'); if (!authenticated) throw Object.assign(new Error('HTTP 401'), { statusCode: 401 }); return {}; };
  h._launchGateway = () => { launches++; return { failure: () => null }; };
  const setup = load('core/gateway-setup.js', {
    './hermes-paths': { getHermesProfilePath: (id, f) => path.join(profiles, id, f),
      getHermesProfilesDir: () => profiles, getHermesConfigPath: () => path.join(home, 'config.yaml') },
    child_process: { spawn() { throw new Error('Setup must delegate process ownership'); } },
  }, { global: { __hermesHandler: h } });
  t.after(async () => { await h.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const db = { getConfigFromDb: () => ({}), saveConfigToDb: cfg => { if (saveError) throw new Error('fixture db failure'); saved = cfg; } };
  const wait = async taskId => { while (!setup.getTask(taskId).done) await new Promise(setImmediate); return setup.getTask(taskId); };
  const run = () => wait(setup.startSetup('hermes', profile, db).taskId);
  return { run, wait, setup, db, h, file, saved: () => saved, launches: () => launches, probes: () => probes };
}
test('Hermes setup fails on authentication timeout and cannot promote health to authenticated readiness', async t => {
  const f = await setupFixture(t);
  f.h.client.ping = async () => true;
  const task = await f.run();
  assert.equal(task.ok, false);
  assert.match(task.error, /HERMES_GATEWAY_NOT_READY/);
  assert.equal(f.setup.checkGateway('hermes', null, 'one').ready, false);
  assert.equal(f.launches(), 1);
});
test('Hermes setup reuses authenticated provider readiness without replacing a running gateway', async t => {
  const f = await setupFixture(t, { authenticated: true });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.setup.checkGateway('hermes', null, 'one').ready, true);
  assert.ok(f.probes() > 0);
  assert.equal(f.launches(), 0);
});
test('Hermes independent profile keys and readiness remain isolated through the setup checker', async () => {
  const h = hermes();
  h.options.profiles.two = { apiKey: 'fixture-two' };
  h.connectedAgents = new Set(['one']); h._authStates.set('one', true);
  const setup = load('core/gateway-setup.js', {}, { global: { __hermesHandler: h } });
  assert.equal(setup.checkGateway('hermes', null, 'one').ready, true);
  assert.equal(setup.checkGateway('hermes', null, 'two').ready, false);
  assert.equal(setup.checkGateway('hermes').ready, false);
  h.options.apiKey = 'legacy-root';
  assert.equal(setup.checkGateway('hermes', null, 'two').ready, false);
  await h.destroy();
});
test('Hermes verifies a legacy shared key before attempting to replace the gateway', async () => {
  const p = hermes();
  p.options.apiKey = 'legacy-fixture'; p.options.profiles.one = { port: 8642 };
  p.client.setProfile = (_id, profile) => { assert.equal(profile.apiKey, 'legacy-fixture'); };
  p.client.authenticate = async () => true;
  p._launchGateway = () => { throw new Error('A running authenticated gateway must be reused'); };
  assert.equal(await p._ensureGatewayRunning('one'), true);
  assert.equal(p.getProfileStatus('one').ready, true);
  await p.destroy();
});
test('Hermes YAML edits preserve custom options, comments, CRLF and an exact backup', async t => {
  const original = '# keep comment\r\nplatforms:\r\n  api_server:\r\n    enabled: false\r\n    extra:\r\n      port: 8642\r\n      host: 127.0.0.1\r\n      custom_option: restricted\r\n';
  const f = await setupFixture(t, { authenticated: true, yaml: original });
  assert.equal((await f.run()).ok, true);
  const written = fs.readFileSync(f.file, 'utf8');
  assert.match(written, /# keep comment/);
  assert.match(written, /host: 127.0.0.1/);
  assert.match(written, /custom_option: restricted/);
  assert.match(written, /enabled: true/);
  assert.doesNotMatch(written, /(?<!\r)\n/);
  const backups = fs.readdirSync(path.dirname(f.file)).filter(name => name.includes('.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.file), backups[0]), 'utf8'), original);
});
test('Hermes malformed YAML is rejected before writing configuration or starting a process', async t => {
  const original = 'platforms: [broken';
  const f = await setupFixture(t, { yaml: original });
  assert.equal((await f.run()).ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.equal(f.saved(), undefined);
  assert.equal(f.launches(), 0);
});
test('Hermes setup can add API settings to an empty platforms mapping', async t => {
  const f = await setupFixture(t, { authenticated: true, yaml: '# keep\nplatforms: {}\n' });
  assert.equal((await f.run()).ok, true);
  const value = require('yaml').parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(value.platforms.api_server.enabled, true);
  assert.equal(typeof value.platforms.api_server.extra.key, 'string');
});
test('Hermes database write failure cannot complete setup or start a process', async t => {
  const f = await setupFixture(t, { authenticated: true, saveError: true });
  const task = await f.run();
  assert.equal(task.ok, false);
  assert.match(task.error, /fixture db failure/);
  assert.equal(f.launches(), 0);
  assert.equal(f.probes(), 0);
});
test('Hermes setup accepts a root default profile without named profile directories', async t => {
  const f = await setupFixture(t, { authenticated: true, profile: 'default' });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.setup.checkGateway('hermes', null, 'default').ready, true);
});
test('Hermes startup and forced recovery share one per-profile operation', async () => {
  const p = hermes();
  let probes = 0, launches = 0;
  p._selectAuthenticatedProfileConnection = async () => ++probes > 1;
  p._launchGateway = () => { launches++; return { failure: () => null }; };
  assert.deepEqual(await Promise.all([p._ensureGatewayRunning('one'), p._ensureGatewayRunning('one'), p._restartGateway('one')]), [true, true, true]);
  assert.equal(launches, 1);
  await p.destroy();
});
test('Hermes stop cancels startup waiting on authentication before any process launch', async () => {
  const p = hermes();
  let completeProbe, launches = 0;
  p._selectAuthenticatedProfileConnection = () => new Promise(resolve => { completeProbe = resolve; });
  p._launchGateway = () => { launches++; return { failure: () => 'unexpected' }; };
  const pending = p._ensureGatewayRunning('one');
  await p.stop(); completeProbe(false);
  assert.equal(await pending, false);
  assert.equal(launches, 0);
  assert.equal(p.getProfileStatus('one').ready, false);
});
test('Hermes stop cannot be undone by a late successful health check', async () => {
  const p = hermes();
  let finish;
  p.client.setProfile = () => {};
  p.client.authenticate = () => new Promise(resolve => { finish = resolve; });
  const health = p.healthCheck();
  await p.stop(); finish(true); await health;
  assert.equal(p.connected, false);
  assert.equal(p.getProfileStatus('one').ready, false);
});

test('Hermes configuration tasks serialize writers and deduplicate the same profile', async t => {
  const f = await setupFixture(t, { authenticated: true });
  let finish;
  const ensure = f.h._ensureGatewayRunning.bind(f.h);
  f.h._ensureGatewayRunning = id => new Promise(resolve => { finish = () => ensure(id).then(resolve); });
  const first = f.setup.startSetup('hermes', 'one', f.db);
  assert.equal(f.setup.startSetup('hermes', 'one', f.db).taskId, first.taskId);
  assert.throws(() => f.setup.startSetup('hermes', 'two', f.db), /GATEWAY_SETUP_IN_PROGRESS/);
  await finish();
  assert.equal((await f.wait(first.taskId)).ok, true);
});

test('Hermes YAML backup failures leave the source file unchanged', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-hermes-backup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.yaml');
  const source = '# original\nplatforms: {}\n';
  fs.writeFileSync(file, source);
  const config = load('core/hermes-gateway-config.js', { fs: { ...fs, writeFileSync(target, ...args) {
    if (target.includes('.bak.')) throw new Error('fixture backup failure');
    return fs.writeFileSync(target, ...args);
  } } });
  assert.throws(() => config.writeHermesGatewayConfig(config.readHermesGatewayConfig(file), 'fixture', 8642), /backup failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

// Execute the production route callbacks with fixture providers, without starting Lite.
async function invokeHermesRoute(route, handler, body = {}) {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  const pattern = new RegExp("app.post\\('" + route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "', async \\(req\\?: any, res\\?: any\\) => \\{([\\s\\S]*?)\\n  \\}\\);");
  const found = source.match(pattern); assert.ok(found);
  const code = found[1].replace(/\(global as any\)/g, 'global').replace(/catch \(e: any\)/g, 'catch (e)');
  let response;
  const fn = vm.runInNewContext('(async (req, res) => {' + code + '})', { global: { __hermesHandler: handler } });
  await fn({ body }, { json: value => { response = value; return value; } });
  return response;
}
test('Hermes reconnect maps Agent to profile and reports startup failure truthfully', async () => {
  let target;
  const response = await invokeHermesRoute('/api/hermes/reconnect', {
    _profileForAgent: id => id === 'agent-one' ? 'one' : null,
    async reconnectProfile(id) { target = id; return false; },
  }, { agentId: 'agent-one' });
  assert.equal(target, 'one');
  assert.equal(response.success, false);
});
test('Hermes tests use the authenticated boolean and do not report a failed check as success', async () => {
  let ready = true;
  const h = { options: { profiles: { one: { apiKey: 'fixture' } } }, client: {},
    _profileForAgent: () => 'one',
    async healthCheck() {}, getProfileStatus: () => ({ ready }) };
  const passed = await invokeHermesRoute('/api/hermes/test-agent', h, { agentId: 'agent-one' });
  assert.equal(passed.alive, true);
  assert.equal(passed.success, true);
  ready = false;
  const failed = await invokeHermesRoute('/api/hermes/test-agent', h, { agentId: 'agent-one' });
  assert.equal(failed.success, false);
  assert.equal(failed.alive, false);
  assert.equal((await invokeHermesRoute('/api/hermes/test-connection', h)).success, false);
});
test('Hermes diagnostic routes accept an existing legacy profile id but never guess an unknown one', async () => {
  const h = { options: { profiles: { one: { apiKey: 'fixture' } } }, client: {},
    _profileForAgent: () => null, async healthCheck() {}, getProfileStatus: () => ({ ready: true }),
    async reconnectProfile(id) { assert.equal(id, 'one'); return true; } };
  assert.equal((await invokeHermesRoute('/api/hermes/test-agent', h, { agentId: 'one' })).alive, true);
  assert.equal((await invokeHermesRoute('/api/hermes/reconnect', h, { agentId: 'one' })).success, true);
  assert.equal((await invokeHermesRoute('/api/hermes/reconnect', h, { agentId: 'missing' })).success, false);
});
test('Registration rechecks the selected profile instead of trusting a completed setup task', () => {
  const { RegistrationOrchestrator } = require('../build/core/registration-orchestrator');
  const checked = [];
  let ready = false;
  const service = new RegistrationOrchestrator({ gatewaySetup: {
    getTask: () => ({ done: true, ok: true, logs: [] }),
    checkGateway: (backend, _db, profile) => { checked.push([backend, profile]); return { ready }; },
  } });
  const session = { id: 'fixture', provider: { type: 'hermes', instanceId: 'one' }, configurationTaskId: 'task',
    deliveryModes: [{ mode: 'http', status: 'configuration_required', selected: false }] };
  service._get = () => session; service._save = () => {};
  service.configurationStatus('fixture', 'task');
  assert.equal(session.deliveryModes[0].selected, false);
  assert.equal(session.deliveryModes[0].status, 'configuration_required');
  assert.equal(service.preflightDelivery('fixture', { mode: 'http' }).ready, false);
  ready = true;
  service.configurationStatus('fixture', 'task');
  assert.equal(session.deliveryModes[0].selected, true);
  assert.equal(session.deliveryModes[0].status, 'ready');
  assert.ok(checked.length >= 3);
  assert.ok(checked.every(([backend, profile]) => backend === 'hermes' && profile === 'one'));
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function bounded(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function socketServer(t, onConnection) {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', onConnection);
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
for (const behavior of ['close', 'silent']) {
  test(`OpenClaw ${behavior} socket cannot strand start beyond its authentication budget`, async t => {
    const server = await socketServer(t, socket => { if (behavior === 'close') socket.close(1008, 'authentication rejected'); });
    const { p, config } = wsFixture(t); config({ mode: 'token', token: 'fixture' });
    p.gatewayUrl = `ws://127.0.0.1:${server.address().port}`;
    p.gatewayStartupTimeoutMs = 80; p.gatewayProbeIntervalMs = 5;
    p._probeGateway = async () => true;
    assert.equal(await bounded(p.start()), false);
    assert.equal(p.connected, false);
  });
}
for (const action of ['disconnect', 'stop']) {
  test(`OpenClaw ${action} settles a connection awaiting authentication`, async t => {
    const accepted = deferred();
    const server = await socketServer(t, () => accepted.resolve());
    const { p, config } = wsFixture(t); config({ mode: 'token', token: 'fixture' });
    p.gatewayUrl = `ws://127.0.0.1:${server.address().port}`;
    const connection = p.connect(); await bounded(accepted.promise);
    await p[action](); await bounded(connection);
    assert.equal(p.connecting, false);
    assert.equal(p._finishConnection, null);
  });
}
test('OpenClaw watcher invalidates deletion and reads restored older JSON5 configuration', t => {
  let poll;
  const { p, config } = wsFixture(t, { setInterval: fn => { poll = fn; return fn; }, clearInterval() {} });
  config({ mode: 'token', token: 'fixture' }); p.connected = true;
  fs.unlinkSync(p.configPath); poll();
  assert.equal(p.getStatus().configurationError, 'OPENCLAW_CONFIG_NOT_FOUND');
  assert.equal(p.getStatus().hasToken, false);
  assert.equal(p.connected, false);
  fs.writeFileSync(p.configPath, '{ // native JSON5\n gateway: { mode: "local", auth: {mode: "token", token: "restored"}, }, }');
  fs.utimesSync(p.configPath, new Date(0), new Date(0)); poll();
  assert.equal(p.getStatus().configurationError, null);
  assert.equal(p.authToken, 'restored');
});
test('OpenClaw setup reads a valid JSON5 configuration without rewriting it', async t => {
  const { p } = wsFixture(t);
  const original = '{ // keep this comment\n gateway: {mode: "local", auth: {mode: "token", token: "fixture"}}, }';
  fs.writeFileSync(p.configPath, original);
  const setup = load('core/gateway-setup.js', { './dispatcher/openclaw-command': {
    openClawPaths: () => ({ configPath: p.configPath }),
  } }, { global: { __openclawHandler: { loadConfig() {}, async start() {}, getStatus: () => ({ hasToken: true, connected: true }) } } });
  const { taskId } = setup.startSetup('openclaw');
  while (!setup.getTask(taskId).done) await new Promise(setImmediate);
  assert.equal(setup.getTask(taskId).ok, true);
  assert.equal(fs.readFileSync(p.configPath, 'utf8'), original);
});
test('Hermes reserves unregistered profile ports during single-profile setup', async t => {
  const f = await setupFixture(t, { authenticated: true, yaml: 'platforms: {}\n' });
  const other = path.join(path.dirname(path.dirname(f.file)), 'two'); fs.mkdirSync(other);
  const otherFile = path.join(other, 'config.yaml');
  const original = 'platforms:\n  api_server:\n    enabled: true\n    extra:\n      port: 8642\n      key: other-key\n';
  fs.writeFileSync(otherFile, original);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.saved().profiles.one.port, 8643);
  assert.equal(fs.readFileSync(otherFile, 'utf8'), original);
});
for (const source of ['profile_env', 'yaml']) {
  test(`Hermes authenticates the actual ${source} connection instead of assuming environment precedence`, async t => {
    const f = await setupFixture(t);
    const api = require('../build/core/hermes-gateway-config');
    const expectedKey = source === 'profile_env' ? 'env-key' : 'fixture-key';
    const server = require('node:http').createServer((req, res) => {
      res.writeHead(req.headers.authorization === `Bearer ${expectedKey}` ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
    fs.writeFileSync(f.file, `platforms:\n  api_server:\n    enabled: true\n    extra:\n      port: ${server.address().port}\n      key: fixture-key\n`);
    fs.writeFileSync(path.join(path.dirname(f.file), '.env'), 'API_SERVER_KEY=env-key\n');
    f.h.options.profileConfigLoader = () => api.hermesGatewayConnections(api.readHermesGatewayConfig(f.file), api.readHermesGatewayEnvironment(f.file, {}));
    f.h.options.profiles.one = { port: server.address().port, apiKey: 'initial-stale-key' };
    const { HermesApiClient } = require('../build/core/adapters/hermes-api-client');
    f.h.client = new HermesApiClient({ profiles: f.h.options.profiles });
    assert.equal(await f.h._selectAuthenticatedProfileConnection('one'), true);
    assert.equal(f.h.options.profiles.one.apiKey, expectedKey);
    assert.equal(f.h.options.profiles.one.connectionSource, source);
    assert.equal(JSON.stringify(f.h.getStatus()).includes(expectedKey), false);
  });
}
test('Hermes environment candidates preserve empty overrides and never send unresolved expressions', async t => {
  const f = await setupFixture(t);
  const api = require('../build/core/hermes-gateway-config');
  const envFile = path.join(path.dirname(f.file), '.env');
  fs.writeFileSync(envFile, 'API_SERVER_KEY=\nAPI_SERVER_PORT=8866\n');
  const environment = api.readHermesGatewayEnvironment(f.file, { API_SERVER_KEY: 'shell-fixture' });
  assert.equal(environment.apiKey, ''); assert.equal(environment.port, 8866);
  const candidates = api.hermesGatewayConnections(api.readHermesGatewayConfig(f.file), environment);
  assert.ok(candidates.some(c => c.port === 8642 && c.apiKey === 'fixture-key'));
  fs.writeFileSync(envFile, 'API_SERVER_KEY=${FIXTURE_REFERENCE}\n');
  assert.throws(() => api.readHermesGatewayEnvironment(f.file, {}), /HERMES_ENV_REFERENCE_UNSUPPORTED/);
});
test('Hermes API environment literals match native dotenv comments, quotes and escapes', async t => {
  const f = await setupFixture(t);
  const api = require('../build/core/hermes-gateway-config');
  const envFile = path.join(path.dirname(f.file), '.env');
  const cases = [
    ['API_SERVER_KEY=literal-0123456789#suffix', 'literal-0123456789#suffix'],
    ['API_SERVER_KEY=literal-0123456789 # comment', 'literal-0123456789'],
    ['API_SERVER_KEY= #literal', '#literal'],
    ["export 'API_SERVER_KEY' = 'literal#with space' # comment", 'literal#with space'],
    ["API_SERVER_KEY='literal\\'quote\\\\slash'", "literal'quote\\slash"],
    ['API_SERVER_KEY="literal\\"quote\\\\slash\\tend"', 'literal"quote\\slash\tend'],
    ['API_SERVER_KEY="literal\\q"', 'literal\\q'],
    ['API_SERVER_KEY=actual\nOTHER="line one\nAPI_SERVER_KEY=not-a-binding\nline three"', 'actual'],
    ['API_SERVER_KEY=first\nAPI_SERVER_KEY=last', 'last'],
    ['API_SERVER_KEY', 'shell-fixture'],
  ];
  for (const [source, expected] of cases) {
    fs.writeFileSync(envFile, source + '\nAPI_SERVER_PORT=8866 # comment\n');
    const actual = api.readHermesGatewayEnvironment(f.file, { API_SERVER_KEY: 'shell-fixture' });
    assert.equal(actual.apiKey, expected); assert.equal(actual.port, 8866);
  }
  fs.writeFileSync(envFile, 'API_SERVER_KEY="unclosed\n');
  assert.throws(() => api.readHermesGatewayEnvironment(f.file, {}), /HERMES_ENV_INVALID/);
});
test('Hermes failed candidate probes preserve live routing and the implicit default port', async () => {
  const p = hermes(); await p._initClient();
  p.options.profileConfigLoader = () => [{ apiKey: 'fallback', port: 8643 }];
  const ports = [];
  p.client.authenticate = async (_id, connection) => { ports.push(connection.port); return false; };
  assert.equal(await p._selectAuthenticatedProfileConnection('one'), false);
  assert.equal(p.client._agentPort('one'), 8642);
  assert.equal(await p._selectAuthenticatedProfileConnection('one'), false);
  assert.deepEqual(ports, [8642, 8643, 8642, 8643]); await p.destroy();
});
test('Hermes commits a candidate connection only after successful authentication', async () => {
  const p = hermes(); await p._initClient();
  p.options.profileConfigLoader = () => [{ apiKey: 'new', port: 8643 }];
  const entered = deferred(), response = deferred();
  p.client.authenticate = async (_id, connection) => {
    if (connection.apiKey !== 'new') return false;
    entered.resolve(); return response.promise;
  };
  const selection = p._selectAuthenticatedProfileConnection('one'); await entered.promise;
  assert.equal(p.client._agentPort('one'), 8642); assert.equal(p.options.profiles.one.port, undefined);
  response.resolve(true); assert.equal(await selection, true);
  assert.equal(p.client._agentPort('one'), 8643); await p.destroy();
});
test('Hermes explicit reconnect detects a dead gateway despite a previous authenticated cache', async () => {
  const p = hermes(); await p._initClient();
  p.connected = p.client.connected = true; p.connectedAgents = new Set(['one']); p._authStates.set('one', true);
  let probes = 0;
  p.client.authenticate = async () => { probes++; return false; };
  p._launchGateway = () => ({ failure: () => 'fixture startup failed' });
  assert.equal(await p._ensureGatewayRunning('one'), true); assert.equal(probes, 0);
  assert.equal(await p.reconnectProfile('one'), false); assert.ok(probes > 0);
  assert.equal(p.getProfileStatus('one').ready, false); assert.equal(p.connected, false); await p.destroy();
});
test('Hermes a stale health response cannot overwrite a newer successful startup', async () => {
  const p = hermes(); await p._initClient();
  const first = deferred(); let probes = 0;
  p.client.authenticate = () => ++probes === 1 ? first.promise : Promise.resolve(true);
  const health = p.healthCheck();
  assert.equal(await p._ensureGatewayRunning('one'), true);
  first.resolve(false); await health;
  assert.equal(p.getProfileStatus('one').ready, true); await p.destroy();
});
test('Hermes owned child exit invalidates only its profile and ignores replaced children', async () => {
  const { EventEmitter } = require('node:events');
  const children = [];
  const P = load('core/dispatcher/providers/hermes-http.js', {
    child_process: { spawn() { const child = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}; children.push(child); return child; } },
    '../hermes-command': { resolveHermesCommand: () => 'fixture' },
  });
  const p = new P(null, null, { profiles: { one: { apiKey: 'one' }, two: { apiKey: 'two' } }, profileConfigLoader: () => null });
  await p._initClient(); p.connected = true; p.connectedAgents = new Set(['one', 'two']);
  p._authStates.set('one', true); p._authStates.set('two', true);
  p._launchGateway('one'); p._launchGateway('one');
  children[0].emit('close', 1); assert.equal(p.getProfileStatus('one').ready, true);
  children[1].emit('close', 1); assert.equal(p.getProfileStatus('one').ready, false);
  assert.equal(p.getProfileStatus('two').ready, true); await p.destroy();
});
test('Hermes registry restart preserves reply and availability subscriptions', async () => {
  const p = hermes();
  const { ProviderRuntimeRegistry } = require('../build/core/dispatcher/provider-runtime-registry');
  const registry = new ProviderRuntimeRegistry({ 'hermes-http': p }); let replies = 0, changes = 0;
  p.on('agent.reply', () => { replies++; }); registry.on('availability', () => { changes++; });
  await registry.startAll(); await registry.restart('hermes-http');
  const previous = changes; p.emit('agent.reply', {}); p.notifyAvailability({ available: true });
  assert.equal(replies, 1); assert.equal(changes, previous + 1); await registry.stopAll(); await p.destroy();
});
for (const route of ['initial', 'key-refresh', 'restart']) {
  test(`Hermes ${route} submission cannot cross a provider stop/start boundary`, async () => {
    const p = hermes(); await p._initClient(); p.connected = true; p._profileForAgent = () => 'one';
    p._ensureGatewayRunning = async () => true;
    p._selectAuthenticatedProfileConnection = async () => route === 'key-refresh'; p._restartGateway = async () => true;
    let oldCalls = 0, newCalls = 0, validations = 0;
    p.client.chat = async () => { oldCalls++; throw Object.assign(new Error('HTTP 401'), { statusCode: 401 }); };
    const entered = deferred(), validation = deferred();
    const send = p._sendToSession('hermes:agent:visitor', 'fixture', { assertSubmissionCurrent: () => {
      if (++validations === (route === 'initial' ? 1 : 2)) { entered.resolve(); return validation.promise; }
    } });
    const rejected = assert.rejects(send, error => error.deliveryOutcome === 'not_delivered');
    await entered.promise; await p.stop(); await p.start();
    p.client.chat = async () => { newCalls++; return { reply: 'fixture' }; };
    validation.resolve(); await rejected;
    assert.equal(newCalls, 0); assert.equal(oldCalls, route === 'initial' ? 0 : 1); await p.destroy();
  });
}

for (const method of ['chat', 'steer']) {
  for (const route of ['initial', 'key-refresh', 'restart']) {
    for (const restart of [false, true]) {
      test(`Hermes ${method} ${route} late response after ${restart ? 'restart' : 'stop'} is unknown, never completed or replayed`, async t => {
        const p = hermes(); await p._initClient();
        t.after(() => p.destroy());
        p.connected = true; p._profileForAgent = () => 'one';
        p._ensureGatewayRunning = async () => true;
        p._selectAuthenticatedProfileConnection = async () => route === 'key-refresh';
        p._restartGateway = async () => true;
        const entered = deferred(), response = deferred();
        let submissions = 0, replies = 0, fallbackCalls = 0;
        const statuses = [];
        p.on('agent.reply', () => replies++);
        p.on('delivery.status', event => statuses.push(event.status));
        p.client[method] = async () => {
          submissions++;
          if (route !== 'initial' && submissions === 1) throw Object.assign(new Error('HTTP 401'), { statusCode: 401 });
          entered.resolve(); return response.promise;
        };
        const { DeliveryExecutor } = require('../build/core/dispatcher/delivery-executor');
        const executor = new DeliveryExecutor();
        const result = executor.execute({
          next: excluded => ({ providerId: excluded.size ? 'fallback' : 'hermes-http',
            providerType: 'hermes', deliveryMode: 'http', target: excluded.size ? 'fallback' : 'hermes' }),
          invoke: candidate => {
            if (candidate.target === 'fallback') { fallbackCalls++; return; }
            return method === 'chat'
              ? p.sendToSession('hermes:agent:visitor', 'fixture', { turnId: 'late-turn' })
              : p.steer('agent', 'visitor', 'fixture');
          },
          classify: error => error.deliveryOutcome || 'outcome_unknown',
        });
        await entered.promise; await p.stop();
        if (restart) await p.start();
        response.resolve({ reply: 'late reply', output: 'late reply' });
        const outcome = await result;
        assert.equal(outcome.outcome, 'outcome_unknown');
        assert.equal(outcome.errorCode, 'HERMES_RESPONSE_LIFECYCLE_CHANGED');
        assert.equal(submissions, route === 'initial' ? 1 : 2);
        assert.equal(fallbackCalls, 0);
        assert.equal(replies, 0);
        assert.deepEqual(statuses, method === 'chat' ? ['processing', 'pending'] : []);
      });
    }
  }
}

async function httpServer(t, handler) {
  const server = require('node:http').createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
test('Hermes settles a truncated HTTP response and continues checking other profiles', async t => {
  const server = await httpServer(t, (req, res) => {
    if (req.headers.authorization === 'Bearer truncated') {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('{"partial":', () => res.destroy());
    } else res.end('{}');
  });
  const P = load('core/dispatcher/providers/hermes-http.js');
  const p = new P(null, null, { profiles: {
    one: { port: server.address().port, apiKey: 'truncated' },
    two: { port: server.address().port, apiKey: 'complete' },
  }, profileConfigLoader: () => null });
  t.after(() => p.destroy()); await p._initClient();
  // Exercise response abortion, not a race with an 80ms request timeout on a busy VM.
  await assert.rejects(bounded(p.client._request('GET', '/v1/models', null, 0, {}, { port: server.address().port, apiKey: 'truncated' }), 5000),
    error => error.code === 'ECONNRESET');
  await bounded(p.healthCheck(), 5000);
  assert.equal(p.getProfileStatus('one').ready, false);
  assert.equal(p.getProfileStatus('two').ready, true);
});
for (const method of ['chat', 'steer']) {
  test('Hermes does not retry HTTP 500 containing HTTP 401 during ' + method, async t => {
    let submissions = 0, authentications = 0;
    const server = await httpServer(t, (req, res) => {
      if (req.url === '/v1/models') { authentications++; res.end('{}'); return; }
      submissions++; res.writeHead(500);
      res.end('{"error":{"message":"Internal server error: HTTP 401 Unauthorized"}}');
    });
    const p = hermes(); p.options.profiles.one = { port: server.address().port, apiKey: 'fixture' };
    await p._initClient(); t.after(() => p.destroy());
    p._profileForAgent = () => 'one'; p.connected = true;
    p.connectedAgents = new Set(['one']); p._authStates.set('one', true);
    const call = method === 'chat' ? p.sendToSession('hermes:agent:visitor', 'fixture') : p.steer('agent', 'visitor', 'fixture');
    await assert.rejects(call, error => error.statusCode === 500 && error.deliveryOutcome !== 'not_delivered');
    assert.equal(submissions, 1); assert.equal(authentications, 0);
  });
}
for (const [action, checkpoint] of [['disconnect', 2], ['stop-start', 2], ['stop-start', 1]]) {
  test('OpenClaw rejects an unsubmitted push across ' + action + ' at check ' + checkpoint, async t => {
    let received = 0;
    const server = await socketServer(t, socket => {
      socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture', ts: Date.now() } }));
      socket.on('message', bytes => {
        const msg = JSON.parse(bytes.toString());
        if (msg.method === 'connect') socket.send(JSON.stringify({ type: 'res', id: msg.id, ok: true,
          payload: { type: 'hello-ok', protocol: msg.params.maxProtocol, features: { methods: ['chat.send'], events: ['chat'] } } }));
        if (msg.method === 'chat.send') received++;
      });
    });
    const { p, config } = wsFixture(t); config({ token: 'fixture' });
    p.gatewayUrl = 'ws://127.0.0.1:' + server.address().port;
    p.enabled = true; p._probeGateway = async () => true; p.gatewayProbeIntervalMs = 5;
    await bounded(p.connect(500)); assert.equal(p.connected, true);
    const entered = deferred(), validation = deferred(); let checks = 0;
    const sending = p.push({ agentId: 'agent', fromUid: 'visitor', content: 'fixture', messageId: 'message',
      assertSubmissionCurrent: () => { if (++checks === checkpoint) { entered.resolve(); return validation.promise; } } });
    const rejected = assert.rejects(sending, error => error.deliveryOutcome === 'not_delivered');
    await bounded(entered.promise);
    if (action === 'disconnect') {
      const closed = deferred(); p.on('availability', event => { if (!event.available) closed.resolve(); });
      for (const socket of server.clients) socket.close(); await bounded(closed.promise);
    } else { await p.stop(); assert.equal(await bounded(p.start()), true); }
    validation.resolve(); await bounded(rejected);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(received, 0); assert.equal(p._chatRequests.size, 0);
  });
}
test('Hermes excludes ambiguous profile candidates while retaining independent alternatives', async t => {
  let sharedProbes = 0, ownProbes = 0, launches = 0;
  const shared = await httpServer(t, (_req, res) => { sharedProbes++; res.end('{}'); });
  const own = await httpServer(t, (_req, res) => { ownProbes++; res.end('{}'); });
  const P = load('core/dispatcher/providers/hermes-http.js');
  const sharedConnection = { port: shared.address().port, apiKey: 'shared' };
  const p = new P(null, null, { profiles: { one: sharedConnection, two: sharedConnection },
    profileConfigLoader: id => id === 'two' ? [sharedConnection, { port: own.address().port, apiKey: 'own' }] : [sharedConnection] });
  await p._initClient(); t.after(() => p.destroy());
  p._launchGateway = () => { launches++; throw new Error('Ambiguous endpoints must not start or replace gateways'); };
  await p.healthCheck();
  assert.equal(p.getProfileStatus('one').ready, false); assert.equal(p.getProfileStatus('two').ready, false);
  assert.equal(await p._ensureGatewayRunning('two'), true);
  assert.equal(p.client._agentPort('two'), own.address().port);
  assert.equal(await p._ensureGatewayRunning('one'), false);
  assert.equal(sharedProbes, 0); assert.ok(ownProbes > 0); assert.equal(launches, 0);
  assert.ok(p.logs.some(line => line.includes('HERMES_PROFILE_ROUTE_AMBIGUOUS')));
});
test('Hermes allows multiple Agents to use one profile and independent keys on one endpoint', async t => {
  const requests = [];
  const server = await httpServer(t, (req, res) => { requests.push(req.headers['x-hermes-session-id']);
    res.end('{"choices":[{"message":{"content":"fixture"}}]}'); });
  const P = load('core/dispatcher/providers/hermes-http.js');
  const p = new P({ prepare: () => ({ get: () => ({ backend_instance_id: 'shared' }) }) }, null, {
    profiles: { shared: { port: server.address().port, apiKey: 'one-key' }, independent: { port: server.address().port, apiKey: 'two-key' } },
    profileConfigLoader: () => null,
  });
  await p._initClient(); t.after(() => p.destroy()); await p.healthCheck();
  await p.sendToSession('hermes:agent-a:visitor', 'fixture');
  await p.sendToSession('hermes:agent-b:visitor', 'fixture');
  assert.ok(requests.includes('hermes:agent-a:visitor')); assert.ok(requests.includes('hermes:agent-b:visitor'));
  assert.equal(p.getProfileStatus('independent').ready, true);
});
test('Hermes does not launch a conflicting native endpoint when an independent alternative is unavailable', async t => {
  const p = hermes(); t.after(() => p.destroy()); await p._initClient();
  const shared = { port: 18866, apiKey: 'shared-fixture-key', connectionSource: 'process_env' };
  const independent = { port: 18867, apiKey: 'independent-fixture-key', connectionSource: 'yaml' };
  p.options.profiles = { one: shared, two: independent };
  p.options.profileConfigLoader = id => id === 'two' ? [shared, independent] : [shared];
  const probes = [];
  p.client.authenticate = async (_id, connection) => { probes.push(connection.port); return false; };
  let launches = 0; p._launchGateway = () => { launches++; return { failure: () => 'fixture' }; };
  assert.equal(await p._ensureGatewayRunning('two'), false);
  assert.deepEqual(probes, [18867]); assert.equal(launches, 0);
  assert.equal(p.getProfileStatus('two').ready, false);
  assert.ok(p.logs.some(line => line.includes('HERMES_PROFILE_ROUTE_AMBIGUOUS')));
});
test('Hermes reads merged YAML without rotating valid settings or losing inherited fields', async t => {
  const yaml = 'defaults: &api\n  enabled: true\n  extra:\n    port: 18866\n    key: fixture-key\n    custom_option: preserve-me\nplatforms:\n  api_server:\n    <<: *api\n';
  const f = await setupFixture(t, { authenticated: true, yaml });
  const api = require('../build/core/hermes-gateway-config'), YAML = require('yaml');
  const config = api.readHermesGatewayConfig(f.file);
  assert.equal(config.apiKey, 'fixture-key'); assert.equal(config.port, 18866); assert.equal(config.enabled, true);
  assert.equal((await f.run()).ok, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), yaml);
  api.writeHermesGatewayConfig(api.readHermesGatewayConfig(f.file), 'changed-key', 18867);
  const updated = YAML.parse(fs.readFileSync(f.file, 'utf8'), { version: '1.1' });
  assert.equal(updated.platforms.api_server.extra.custom_option, 'preserve-me');
  assert.equal(updated.platforms.api_server.extra.key, 'changed-key');
  assert.equal(updated.defaults.extra.key, 'fixture-key'); assert.equal(updated.defaults.extra.port, 18866);
});
test('Hermes reserves other profile ports without interpreting their Key expressions', async t => {
  const f = await setupFixture(t, { authenticated: true, yaml: 'platforms: {}\n' });
  const other = path.join(path.dirname(path.dirname(f.file)), 'two'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'config.yaml'), 'platforms:\n  api_server:\n    extra:\n      port: 8642\n');
  const environment = 'API_SERVER_KEY=$' + '{FIXTURE_REFERENCE}\nAPI_SERVER_PORT=8643\n';
  fs.writeFileSync(path.join(other, '.env'), environment);
  assert.equal((await f.run()).ok, true); assert.equal(f.saved().profiles.one.port, 8644);
  assert.equal(fs.readFileSync(path.join(other, '.env'), 'utf8'), environment);
  fs.writeFileSync(path.join(other, '.env'), 'API_SERVER_PORT=$' + '{FIXTURE_PORT}\n');
  const before = fs.readFileSync(f.file, 'utf8');
  assert.match((await f.run()).error, /HERMES_ENV_REFERENCE_UNSUPPORTED/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

for (const method of ['chat', 'steer']) {
  test('Hermes refreshes credentials only after a real HTTP 401 during ' + method, async t => {
    const submissions = [];
    const server = await httpServer(t, (req, res) => {
      const key = req.headers.authorization;
      if (req.method === 'POST') submissions.push(key);
      if (key !== 'Bearer fresh') { res.writeHead(401); res.end('{}'); return; }
      res.end('{"choices":[{"message":{"content":"fixture"}}]}');
    });
    const P = load('core/dispatcher/providers/hermes-http.js');
    const port = server.address().port;
    const p = new P(null, null, { profiles: { one: { port, apiKey: 'stale' } },
      profileConfigLoader: () => null });
    await p._initClient(); t.after(() => p.destroy());
    p.options.profileConfigLoader = () => [{ port, apiKey: 'fresh' }];
    p._profileForAgent = () => 'one'; p.connected = true;
    p.connectedAgents = new Set(['one']); p._authStates.set('one', true);
    p._launchGateway = () => { throw new Error('Credential refresh must reuse the gateway'); };
    if (method === 'chat') await p.sendToSession('hermes:agent:visitor', 'fixture');
    else await p.steer('agent', 'visitor', 'fixture');
    assert.deepEqual(submissions, ['Bearer stale', 'Bearer fresh']);
    assert.equal(p.getProfileStatus('one').ready, true);
  });
}

test('Hermes keeps a truncated chat outcome pending without resubmitting', async t => {
  let submissions = 0;
  const server = await httpServer(t, (_req, res) => {
    submissions++; res.writeHead(200, { 'Content-Length': 100 }); res.write('{"partial":');
    setTimeout(() => res.destroy(), 10);
  });
  const p = hermes(); p.options.profiles.one = { port: server.address().port, apiKey: 'fixture' };
  await p._initClient(); t.after(() => p.destroy());
  p._profileForAgent = () => 'one'; p.connected = true;
  p.connectedAgents = new Set(['one']); p._authStates.set('one', true);
  const statuses = []; p._emitDeliveryStatus = event => statuses.push(event.status);
  await assert.rejects(bounded(p.sendToSession('hermes:agent:visitor', 'fixture'), 500),
    error => error.code === 'ECONNRESET' && error.deliveryOutcome !== 'not_delivered');
  assert.equal(statuses.at(-1), 'pending'); assert.equal(submissions, 1);
});

test('Hermes rejects a cached route that becomes ambiguous during the submission check', async t => {
  const p = hermes(); t.after(() => p.destroy());
  let sends = 0; p.client.chat = async () => { sends++; return { reply: 'fixture' }; };
  p._profileForAgent = () => 'one'; p.connected = true;
  p.connectedAgents = new Set(['one']); p._authStates.set('one', true);
  assert.equal(p.getProfileStatus('one').ready, true);
  await assert.rejects(p.sendToSession('hermes:agent:visitor', 'fixture', { assertSubmissionCurrent: async () => {
    p.options.profiles.two = { ...p.options.profiles.one };
  } }), error => error.deliveryOutcome === 'not_delivered' && /HERMES_PROFILE_ROUTE_AMBIGUOUS/.test(error.message));
  assert.equal(sends, 0); assert.equal(p.getProfileStatus('one').ready, false);
});

test('Hermes refuses YAML writes that would change another consumer of a shared anchor', async t => {
  const yaml = 'platforms:\n  api_server: &api\n    enabled: true\n    extra:\n      key: fixture\n      port: 18866\nother_consumer: *api\n';
  const f = await setupFixture(t, { yaml });
  const api = require('../build/core/hermes-gateway-config');
  // An explicit update must not mutate the unrelated alias through its shared anchor.
  assert.throws(() => api.writeHermesGatewayConfig(api.readHermesGatewayConfig(f.file), 'new-key', 18867),
    /HERMES_CONFIG_WRITE_UNSUPPORTED/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), yaml);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.yaml']);
});
