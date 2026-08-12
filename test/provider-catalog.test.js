const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDER_CATALOG, getProviderFamily, getProviderTransport, validateProviderCatalog } = require('../build/core/dispatcher/provider-catalog');
const { DeliveryExecutor } = require('../build/core/dispatcher/delivery-executor');

test('Provider Catalog has valid explicit transports and instance requirements', () => {
  assert.deepEqual(validateProviderCatalog(), []);
  assert.equal(getProviderFamily('openclaw').requiresInstance, true);
  assert.equal(getProviderFamily('hermes').requiresInstance, true);
  assert.equal(getProviderFamily('zeroclaw').requiresInstance, true);
  assert.equal(getProviderTransport('zeroclaw-ws').mode, 'acp_ws');
  assert.equal(getProviderTransport('github-copilot-cli').mode, 'cli');
  assert.ok(PROVIDER_CATALOG.every(family => family.defaultDeliveryModes.includes('pull')));
});

test('Qwen Office and Trae expose headless Push transports with Pull fallback', () => {
  for (const [type, label] of [['qwen-office', '千问办公 (QwenWork)'], ['trae', 'Trae']]) {
    const family = getProviderFamily(type);
    assert.ok(family, `${type} should be registered in the catalog`);
    assert.equal(family.label, label);
    assert.ok(family.defaultDeliveryModes.includes('pull'));
    assert.ok(family.transports.length > 0);
  }
  assert.equal(getProviderTransport('qwen-office-cli').mode, 'cli');
  assert.equal(getProviderTransport('traecli-acp').mode, 'acp');
  assert.equal(getProviderFamily('qwenwork').type, 'qwen-office');
  assert.equal(getProviderFamily('trae-ide').type, 'trae');
});

test('loopback capability is explicit and special transports stay preflight-only', () => {
  for (const id of ['claude-cli', 'codex-cli', 'cline-acp', 'traecli-acp', 'hermes-cli', 'hermes-http', 'openclaw-ws', 'zeroclaw-ws', 'qwen-office-cli']) {
    assert.equal(getProviderTransport(id).supportsLoopback, true, `${id} should expose a real loopback`);
  }
  for (const id of ['openclaw-cli', 'opencode-attach', 'goose-cli']) {
    assert.equal(getProviderTransport(id).supportsLoopback, false, `${id} must remain preflight-only`);
  }
});

test('DeliveryExecutor retries at most one backup only for confirmed not_delivered', async () => {
  const calls = [];
  const targets = [{ id: 'primary' }, { id: 'backup' }, { id: 'third' }];
  const executor = new DeliveryExecutor();
  const result = await executor.execute({
    next(excluded) {
      const target = targets.find(item => !excluded.has(item));
      return target ? { providerId: target.id, providerType: 'test', deliveryMode: 'cli', target } : null;
    },
    async invoke(candidate) { calls.push(candidate.providerId); throw Object.assign(new Error('down'), { deliveryOutcome: 'not_delivered' }); },
    classify: error => error.deliveryOutcome,
  });
  assert.equal(result.outcome, 'not_delivered');
  assert.deepEqual(calls, ['primary', 'backup']);
});

test('DeliveryExecutor never retries outcome_unknown or rejected', async () => {
  for (const outcome of ['outcome_unknown', 'rejected']) {
    const calls = [];
    const executor = new DeliveryExecutor();
    const result = await executor.execute({
      next: excluded => excluded.size ? { providerId: 'backup', providerType: 'test', deliveryMode: 'cli', target: 'backup' } : { providerId: 'primary', providerType: 'test', deliveryMode: 'acp', target: 'primary' },
      async invoke(candidate) { calls.push(candidate.providerId); throw Object.assign(new Error(outcome), { deliveryOutcome: outcome }); },
      classify: error => error.deliveryOutcome,
    });
    assert.equal(result.outcome, outcome);
    assert.deepEqual(calls, ['primary']);
  }
});
