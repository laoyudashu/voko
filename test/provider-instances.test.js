const test = require('node:test');
const assert = require('node:assert/strict');

const {
  discoverProviderInstances,
  getProviderInstanceTerm,
  supportsProviderInstances,
} = require('../build/core/dispatcher/provider-instances');

test('instance discovery is enabled only for providers with a routable selector', () => {
  for (const type of ['openclaw', 'hermes', 'zeroclaw', 'workbuddy', 'opencode', 'github-copilot', 'claude-code', 'codex', 'kiro']) {
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
  assert.equal(getProviderInstanceTerm('others'), 'Instance');
});

test('local provider scans return unique non-empty identifiers', () => {
  for (const type of ['openclaw', 'hermes', 'zeroclaw', 'workbuddy', 'opencode', 'github-copilot', 'claude-code', 'codex', 'kiro']) {
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
  const fs = require('node:fs');
  for (const [name, expected] of cases) {
    const source = fs.readFileSync(require.resolve(`../src/core/dispatcher/providers/${name}.ts`), 'utf8');
    assert.ok(source.includes(expected), name);
  }
});
