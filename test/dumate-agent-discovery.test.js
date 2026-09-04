const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverDuMateAgents, resolveDuMateAgentTarget } = require('../build/core/dispatcher/dumate-agents');
const { DuMateHttpProvider, ephemeralRouteId, writeEphemeralDuMatePlugin } = require('../build/core/dispatcher/providers/dumate-http');
const catalog = require('../build/core/dispatcher/provider-catalog');
const dumateCommand = require('../build/core/dispatcher/dumate-command');

function writePlugin(dataRoot, id, manifest = {}) {
  const root = path.join(dataRoot, 'plugins', 'user', id);
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', `${id}.md`), `# ${id}\n`);
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: id, displayName: '股票小助手', description: '股票行情专家', keywords: ['stock', 'market'],
    agents: [{ name: id, prompt: `./agents/${id}.md` }], ...manifest,
  }));
  return root;
}

test('DuMate discovers validated user Plugin Packs and resolves an exact target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dumate-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = writePlugin(root, 'stock-assistant');
  assert.deepEqual(discoverDuMateAgents({ dataRoots: [root] }), [{
    id: 'stock-assistant', name: '股票小助手', description: '股票行情专家',
    source: 'dumate-plugin/stock-assistant', available: true, tags: ['stock', 'market'],
  }]);
  assert.equal(resolveDuMateAgentTarget('stock-assistant', { dataRoots: [root] }).pluginRoot, pluginRoot);
});

test('DuMate discovery fails closed for a mismatched or escaping Agent prompt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dumate-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePlugin(root, 'stock-assistant', { agents: [{ name: 'other', prompt: '../outside.md' }] });
  assert.deepEqual(discoverDuMateAgents({ dataRoots: [root] }), []);
});

test('DuMate resolver discovers the macOS app runtime and fails closed on unsupported Linux', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dumate-mac-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.join(home, 'Applications', 'DuMate.app', 'Contents', 'Resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'test');
  assert.equal(dumateCommand.resolveDuMateCommand({ HOME: home }, 'darwin'), cli);
  assert.equal(dumateCommand.resolveDuMateCommand({}, 'linux'), '');
  assert.deepEqual(dumateCommand.dumateRuntimeRequest({}, 'linux').candidates, []);
});

test('DuMate resolver discovers the active macOS desktop backend port', () => {
  const spawnSync = () => ({ stdout: [
    '/Applications/DuMate.app/Contents/MacOS/DuMate',
    '/Applications/DuMate.app/Contents/Resources/dumate-main-server --port=4567',
  ].join('\n') });
  assert.equal(dumateCommand.resolveDuMateBackendPort({}, 'darwin', { spawnSync }), '4567');
  assert.equal(dumateCommand.resolveDuMateBackendPort({}, 'darwin', { spawnSync: () => ({ stdout: 'DuMate.app' }) }), '');
});

test('DuMate preflight fails closed until backend and authentication are verified', async () => {
  const db = { prepare: () => ({ get: () => ({ backend_type: 'dumate', backend_instance_id: 'stock-assistant' }) }) };
  const target = () => ({ instance: { id: 'stock-assistant' }, pluginRoot: os.tmpdir(), dataRoot: os.tmpdir() });
  const withoutBackend = new DuMateHttpProvider({ db, binPath: process.execPath,
    resolveAgentTarget: target, resolveBackendPort: () => '' });
  assert.deepEqual(await withoutBackend.preflightDelivery('agent-1'), {
    ok: false, status: 'configuration_required', sideEffects: false,
    code: 'DUMATE_BACKEND_UNAVAILABLE', providerInstanceId: 'stock-assistant',
  });
  assert.equal(withoutBackend.getDeliveryReadiness('agent-1').reason, 'backend_not_running');
  assert.match(withoutBackend.getDeliveryReadiness('agent-1').detail, /Open DuMate/);

  const unverifiedAuth = new DuMateHttpProvider({ db, binPath: process.execPath,
    resolveAgentTarget: target, resolveBackendPort: () => '4567' });
  assert.deepEqual(await unverifiedAuth.preflightDelivery('agent-1'), {
    ok: false, status: 'configuration_required', sideEffects: false,
    code: 'DUMATE_AUTH_TEST_REQUIRED', providerInstanceId: 'stock-assistant', routing: 'plugin_part',
  });
});

test('DuMate creates a private ephemeral route when no existing Agent is bound', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dumate-ephemeral-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routeId = ephemeralRouteId('agent_without_binding');
  const pluginRoot = writeEphemeralDuMatePlugin(root, routeId, {
    agentName: '临时客服助手', description: '回答访客的产品问题',
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match(routeId, /^voko-[a-f0-9]{24}$/);
  assert.equal(manifest.name, routeId);
  assert.equal(manifest.displayName, '临时客服助手');
  assert.equal(manifest.agents[0].prompt, `./agents/${routeId}.md`);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'agents', `${routeId}.md`)), true);

  const db = { prepare: (sql) => ({ get: () => sql.includes('backend_type')
    ? { backend_type: 'dumate', backend_instance_id: '' }
    : { agent_name: '临时客服助手', description: '回答访客的产品问题' } }) };
  const provider = new DuMateHttpProvider({ db, binPath: process.execPath,
    resolveAgentTarget: () => null, resolveBackendPort: () => '4567' });
  assert.equal(provider.isAvailable('agent_without_binding'), true);
  assert.deepEqual(await provider.preflightDelivery('agent_without_binding'), {
    ok: false, status: 'configuration_required', sideEffects: false,
    code: 'DUMATE_AUTH_TEST_REQUIRED', providerInstanceId: routeId, routing: 'ephemeral_plugin_part',
  });
  assert.equal(provider.acceptsBinding({ providerType: 'dumate', adapterType: 'dumate-http', deliveryMode: 'http',
    nativeSessionId: 'ses_1', providerInstanceId: routeId }, 'agent_without_binding'), true);
});

test('DuMate catalog and provider preserve instance-affine Resume bindings', () => {
  assert.equal(catalog.getProviderFamily('dumate').requiresInstance, false);
  assert.equal(catalog.getProviderTransport('dumate-http').capabilities.sessionResume, true);
  const db = { prepare: () => ({ get: () => ({ backend_type: 'dumate', backend_instance_id: 'stock-assistant' }) }) };
  const provider = new DuMateHttpProvider({ db, binPath: process.execPath,
    resolveAgentTarget: (id) => id === 'stock-assistant' ? { instance: { id }, pluginRoot: os.tmpdir(), dataRoot: os.tmpdir() } : null });
  assert.equal(provider.acceptsBinding({ providerType: 'dumate', adapterType: 'dumate-http', deliveryMode: 'http',
    nativeSessionId: 'ses_1', providerInstanceId: 'stock-assistant' }, 'agent-1'), true);
  assert.equal(provider.acceptsBinding({ providerType: 'dumate', adapterType: 'dumate-http', deliveryMode: 'http',
    nativeSessionId: 'ses_1', providerInstanceId: 'other' }, 'agent-1'), false);
});
