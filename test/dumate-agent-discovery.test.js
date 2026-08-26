const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverDuMateAgents, resolveDuMateAgentTarget } = require('../build/core/dispatcher/dumate-agents');
const { DuMateHttpProvider } = require('../build/core/dispatcher/providers/dumate-http');
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

test('DuMate catalog and provider preserve instance-affine Resume bindings', () => {
  assert.equal(catalog.getProviderFamily('dumate').requiresInstance, true);
  assert.equal(catalog.getProviderTransport('dumate-http').capabilities.sessionResume, true);
  const db = { prepare: () => ({ get: () => ({ backend_type: 'dumate', backend_instance_id: 'stock-assistant' }) }) };
  const provider = new DuMateHttpProvider({ db, binPath: process.execPath,
    resolveAgentTarget: (id) => id === 'stock-assistant' ? { instance: { id }, pluginRoot: os.tmpdir(), dataRoot: os.tmpdir() } : null });
  assert.equal(provider.acceptsBinding({ providerType: 'dumate', adapterType: 'dumate-http', deliveryMode: 'http',
    nativeSessionId: 'ses_1', providerInstanceId: 'stock-assistant' }, 'agent-1'), true);
  assert.equal(provider.acceptsBinding({ providerType: 'dumate', adapterType: 'dumate-http', deliveryMode: 'http',
    nativeSessionId: 'ses_1', providerInstanceId: 'other' }, 'agent-1'), false);
});
