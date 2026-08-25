const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverProviderInstances,
  getProviderInstanceTerm,
  supportsProviderInstances,
  deepSeekHarnessInstances,
} = require('../build/core/dispatcher/provider-instances');

test('instance discovery is enabled only for providers with a routable selector', () => {
  for (const type of ['openclaw', 'hermes', 'zeroclaw', 'workbuddy', 'qwen-office', 'deepseek-harness', 'opencode', 'github-copilot', 'claude-code', 'codex', 'kiro']) {
    assert.equal(supportsProviderInstances(type), true, type);
  }
  for (const type of ['gemini', 'cursor', 'cline', 'goose', 'qwen-code', 'aider', 'others']) {
    assert.equal(supportsProviderInstances(type), false, type);
    assert.deepEqual(discoverProviderInstances(type), []);
  }
});

test('provider instance terminology follows each framework', () => {
  assert.equal(getProviderInstanceTerm('codex'), 'Profile');
  assert.equal(getProviderInstanceTerm('hermes'), 'Profile');
  assert.equal(getProviderInstanceTerm('goose'), 'Recipe');
  assert.equal(getProviderInstanceTerm('openclaw'), 'Agent');
  assert.equal(getProviderInstanceTerm('workbuddy'), 'Expert');
  assert.equal(getProviderInstanceTerm('qwen-office'), 'Expert Kit');
  assert.equal(getProviderInstanceTerm('deepseek-harness'), 'Agent Preset');
  assert.equal(getProviderInstanceTerm('others'), 'Instance');
});

test('local provider scans return unique non-empty identifiers', () => {
  for (const type of ['openclaw', 'hermes', 'zeroclaw', 'workbuddy', 'qwen-office', 'deepseek-harness', 'opencode', 'github-copilot', 'claude-code', 'codex', 'kiro']) {
    const instances = discoverProviderInstances(type);
    assert.equal(new Set(instances.map((item) => item.id)).size, instances.length, type);
    assert.ok(instances.every((item) => item.id && item.name), type);
  }
});

test('CLI providers map the selected instance to their documented selector', () => {
  const cases = [
    ['opencode-cli', "instanceArgs: (instanceId: string) => ({ args: ['--agent', instanceId] })"],
    ['claude-cli', "instanceArgs: (instanceId: string) => ({ args: ['--agent', instanceId] })"],
    ['github-copilot-cli', "instanceArgs: (instanceId: string) => ({ args: ['--agent', instanceId] })"],
    ['kiro-cli', "instanceArgs: (instanceId: string) => ({ args: ['--agent', instanceId] })"],
    ['codex-cli', "instanceArgs: (instanceId: string) => ({ args: ['--profile', instanceId], position: 'before' })"],
  ];
  for (const [name, expected] of cases) {
    const source = fs.readFileSync(require.resolve(`../src/core/dispatcher/providers/${name}.ts`), 'utf8');
    assert.ok(source.includes(expected), name);
  }
  const qwenSource = fs.readFileSync(require.resolve('../src/core/dispatcher/providers/qwen-office-cli.ts'), 'utf8');
  assert.ok(qwenSource.includes("['--cwd', target.workspaceRoot, '--plugin-dir', target.pluginRoot]"));
});

test('DeepSeek Harness discovery maps installed agent preset directories to stable instances', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dsh-presets-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const system = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard');
  const user = path.join(root, '.agent-presets', 'visitor-safe');
  fs.mkdirSync(system, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(system, 'agent.cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(user, 'agent.cordis.yml'), '[]\n');
  fs.mkdirSync(path.join(root, '.agent-presets', 'broken'), { recursive: true });
  assert.deepEqual(deepSeekHarnessInstances(root).map(item => item.id), ['standard', 'visitor-safe']);
});
