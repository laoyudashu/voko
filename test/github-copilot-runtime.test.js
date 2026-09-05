const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t, installedAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-copilot-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') };
  const executable = path.join(root, 'Custom Node', 'node.exe');
  const roots = { roaming: path.join(env.APPDATA, 'npm'), node: path.dirname(executable),
    local: path.join(env.LOCALAPPDATA, 'Programs', 'nodejs') };
  const loaders = {};
  for (const name of installedAt) {
    const loader = path.join(roots[name], 'node_modules', '@github', 'copilot', 'npm-loader.js');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, '// fixture');
    loaders[name] = loader;
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../build/core/dispatcher/providers/github-copilot-runtime'), 'utf8'), {
    module, exports: module.exports, require, process: { platform: 'win32', env, execPath: executable },
  });
  return { runtime: module.exports.resolveGitHubCopilotRuntime(), executable, loaders };
}

test('Windows Copilot finds a package beside the active Node executable', t => {
  const f = fixture(t, ['node']);
  assert.ok(f.runtime);
  assert.equal(f.runtime.command, f.executable);
  assert.equal(f.runtime.prefixArgs[0], f.loaders.node);
});

test('Windows Copilot finds the standard local Node install from another runtime', t => {
  const f = fixture(t, ['local']);
  assert.ok(f.runtime);
  assert.equal(f.runtime.command, f.executable);
  assert.equal(f.runtime.prefixArgs[0], f.loaders.local);
});

test('Windows Copilot preserves an existing roaming-prefix installation', t => {
  const f = fixture(t, ['roaming', 'node', 'local']);
  assert.equal(f.runtime.prefixArgs[0], f.loaders.roaming);
});

test('Windows Copilot stays unavailable when no loader exists', t => {
  assert.equal(fixture(t, []).runtime, null);
});
