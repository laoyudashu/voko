'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.resolve(__dirname, '../build/server/hermes-discovery.js');
  const originalRequire = createRequire(file);
  let calls = 0;
  const context = {
    module: { exports: {} }, exports: {}, process: { env }, console: { warn() {} },
    require(id) {
      if (id === '../core/hermes-paths') return { getHermesDir: () => root, getHermesProfilesDir: () => path.join(root, 'profiles') };
      if (id === '../core/dispatcher/hermes-command') return { resolveHermesCommand: () => 'fixture-hermes' };
      if (id === 'child_process') return { spawnSync() {
        calls++; return { status: 0, stdout: 'Profile Model\n──────────\n◆ remote  fixture-model\n' };
      } };
      return originalRequire(id);
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const write = (relative, text) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
  return { root, write, env, calls: () => calls, api: context.module.exports,
    discover: () => JSON.parse(JSON.stringify(context.module.exports.discoverHermes())) };
}

test('Hermes discovery reads root and named profile models without launching native processes', t => {
  const f = fixture(t);
  f.write('config.yaml', 'model:\n  default: root-model\n');
  f.write('profiles/coder/config.yaml', 'model: coder-model\n');
  f.write('profiles/research/config.yaml', 'model:\n  model: research-model\n');
  f.write('profiles/default/config.yaml', 'model: must-not-duplicate-root\n');
  f.write('profiles/.hidden/config.yaml', 'model: hidden\n');
  f.write('profiles/invalid name/config.yaml', 'model: invalid\n');
  f.write('profiles/not-a-directory', 'fixture');
  f.write('active_profile', 'coder\n');
  assert.deepEqual(f.discover(), [
    { name: 'default', model: 'root-model', isDefault: false },
    { name: 'coder', model: 'coder-model', isDefault: true },
    { name: 'research', model: 'research-model', isDefault: false },
  ]);
  assert.equal(f.calls(), 0);
  assert.equal(f.api.getLastHermesDiscoveryStatus().source, 'profiles_directory');
});

test('Hermes discovery refreshes filesystem changes and respects a selected profile home', t => {
  const f = fixture(t);
  f.write('profiles/coder/config.yaml', 'model: old-model\n');
  f.write('active_profile', 'coder');
  assert.equal(f.discover().find(p => p.isDefault).name, 'coder');
  f.write('profiles/research/config.yaml', 'model: research-model\n');
  f.write('profiles/coder/config.yaml', 'model: new-model\n');
  f.env.HERMES_HOME = path.join(f.root, 'profiles', 'research');
  const profiles = f.discover();
  assert.equal(profiles.find(p => p.isDefault).name, 'research');
  assert.equal(profiles.find(p => p.name === 'coder').model, 'new-model');
  assert.equal(f.calls(), 0);
});

test('Hermes discovery retains native profiles with absent or malformed model configuration', t => {
  const f = fixture(t);
  f.write('profiles/broken/config.yaml', 'model: [unfinished');
  f.write('active_profile', 'missing-profile');
  assert.deepEqual(f.discover(), [
    { name: 'default', model: 'unknown', isDefault: true },
    { name: 'broken', model: 'unknown', isDefault: false },
  ]);
  assert.equal(f.calls(), 0);
});

test('Hermes discovery still uses the CLI for an unavailable local root', t => {
  const f = fixture(t);
  fs.rmSync(f.root, { recursive: true });
  assert.deepEqual(f.discover(), [{ name: 'remote', model: 'fixture-model', isDefault: true }]);
  assert.equal(f.calls(), 1);
  assert.equal(f.api.getLastHermesDiscoveryStatus().source, 'cli');
});
