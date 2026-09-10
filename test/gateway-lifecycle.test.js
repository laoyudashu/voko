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
    console: quiet, process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
function wsFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-gateway-test-'));
  const commands = require('../build/core/dispatcher/openclaw-command');
  const P = load('core/dispatcher/providers/openclaw-ws.js', {
    '../openclaw-command': { ...commands, openClawPaths: () => ({ stateDir: home, configPath: path.join(home, 'openclaw.json') }) },
  });
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
  h.client._request = async (_method, endpoint) => { probes++; assert.equal(endpoint, '/v1/models'); if (!authenticated) throw new Error('HTTP 401'); return {}; };
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
    async _ensureGatewayRunning(id) { target = id; return false; },
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
    async _ensureGatewayRunning(id) { assert.equal(id, 'one'); return true; } };
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
