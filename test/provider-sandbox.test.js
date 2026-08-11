'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PROVIDER_CATALOG, validateProviderCatalog } = require('../build/core/dispatcher/provider-catalog');
const {
  evaluateProviderSandbox,
  getProviderSandboxPolicy,
  getProviderSandboxRollout,
  listProviderSandboxPolicies,
} = require('../build/core/provider-sandbox');

function dbWith(value) {
  return {
    prepare() {
      return { get() { return value == null ? undefined : { data: JSON.stringify(value) }; } };
    },
  };
}

test('every Provider transport declares a sandbox policy available on every supported OS', () => {
  assert.deepEqual(validateProviderCatalog(), []);
  for (const family of PROVIDER_CATALOG) {
    for (const transport of family.transports) {
      for (const platform of ['win32', 'linux', 'darwin']) {
        assert.ok(getProviderSandboxPolicy(transport.sandboxPolicyId, platform),
          `${family.type}/${transport.id}/${platform} has no sandbox policy`);
      }
    }
  }
});

test('sandbox policies model all five dimensions without leaking paths', () => {
  for (const policy of listProviderSandboxPolicies()) {
    assert.ok(policy.dimensions.filesystem);
    assert.ok(policy.dimensions.network);
    assert.ok(policy.dimensions.commandExecution);
    assert.ok(policy.dimensions.workingDirectory);
    assert.ok(policy.dimensions.humanApproval);
    assert.doesNotMatch(JSON.stringify(policy), /[A-Z]:\\|\/home\/|\/Users\//);
  }
});

test('rollout is disabled by default and environment kill switch wins', () => {
  assert.deepEqual(getProviderSandboxRollout(dbWith(null), {}), {
    enabled: false, mode: 'observe', providerFamilies: [], transportIds: [], platforms: [], killedByEnvironment: false,
  });
  const killed = getProviderSandboxRollout(dbWith({ enabled: true, mode: 'enforce' }), { VOKO_PROVIDER_SANDBOX: 'off' });
  assert.equal(killed.enabled, false);
  assert.equal(killed.killedByEnvironment, true);
});

test('allowlist requires Provider, transport, and OS match', () => {
  const db = dbWith({ enabled: true, mode: 'observe', providerFamilies: ['codex'],
    transportIds: ['codex-cli'], platforms: ['linux'] });
  const matched = evaluateProviderSandbox({ db, providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'linux', env: {} });
  assert.equal(matched.rolloutMode, 'observe');
  assert.equal(matched.rolloutSelected, true);
  assert.equal(matched.status, 'verified_and_enforced');
  const unmatched = evaluateProviderSandbox({ db, providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'win32', env: {} });
  assert.equal(unmatched.rolloutMode, 'observe');
  assert.equal(unmatched.rolloutSelected, false);
  assert.equal(unmatched.status, 'verified_and_enforced');
});

test('required sandbox reports unavailable runtime without claiming enforcement', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'gemini', transportId: 'gemini-cli',
    policyId: 'gemini-container', platform: 'linux', runtimeAvailable: false, env: {} });
  assert.equal(result.effective, false);
  assert.equal(result.status, 'sandbox_runtime_missing');
  assert.equal(result.failurePolicy, 'required');
  assert.equal(result.degradedReason, 'SANDBOX_RUNTIME_UNAVAILABLE');
});

test('unverified transports stay unchanged and are never presented as sandboxed', () => {
  const result = evaluateProviderSandbox({ db: dbWith({ enabled: true, mode: 'enforce', providerFamilies: ['kiro'] }),
    providerFamily: 'kiro', transportId: 'kiro-cli', policyId: 'cli-unverified', platform: 'linux', env: {} });
  assert.equal(result.effective, false);
  assert.equal(result.status, 'legacy_unchanged');
  assert.equal(result.degradedReason, 'UNVERIFIED_CAPABILITY');
});

test('instantiated transports expose the Catalog sandbox policy without changing routing metadata', () => {
  const catalog = require('../build/core/dispatcher/provider-catalog');
  const definition = catalog.getProviderTransport('codex-cli');
  const provider = catalog.instantiateProviderTransport(definition, { db: null, contextWindow: 5 });
  assert.equal(provider.sandboxPolicyId, 'codex-readonly');
  const status = provider.getSandboxStatus('agent-test');
  assert.equal(status.provider, 'codex');
  assert.equal(status.transport, 'codex-cli');
  assert.equal(provider.priority, 1);
});

test('Gemini strict approval is Provider-whitelisted and default invocation remains compatible', () => {
  const { GeminiCliProvider } = require('../build/core/dispatcher/providers/gemini-cli');
  const compatible = new GeminiCliProvider({ db: dbWith(null) });
  assert.deepEqual(compatible._args.slice(compatible._args.indexOf('--approval-mode'),
    compatible._args.indexOf('--approval-mode') + 2), ['--approval-mode', 'yolo']);

  const enforced = new GeminiCliProvider({ db: dbWith({ enabled: true, mode: 'enforce',
    providerFamilies: ['gemini'], transportIds: ['gemini-cli'], platforms: [process.platform] }) });
  assert.deepEqual(enforced._args.slice(enforced._args.indexOf('--approval-mode'),
    enforced._args.indexOf('--approval-mode') + 2), ['--approval-mode', 'plan']);

  const otherTransport = new GeminiCliProvider({ db: dbWith({ enabled: true, mode: 'enforce',
    providerFamilies: ['gemini'], transportIds: ['codex-cli'], platforms: [process.platform] }) });
  assert.deepEqual(otherTransport._args.slice(otherTransport._args.indexOf('--approval-mode'),
    otherTransport._args.indexOf('--approval-mode') + 2), ['--approval-mode', 'yolo']);
});

test('Provider preflight reports the effective sandbox profile as additive diagnostics', async () => {
  const catalog = require('../build/core/dispatcher/provider-catalog');
  const definition = catalog.getProviderTransport('codex-cli');
  const provider = catalog.instantiateProviderTransport(definition, { db: null });
  provider.preflightDelivery = async () => ({ ok: true, status: 'preflight_passed', sideEffects: false });
  const result = await definition.preflight(provider, 'agent-test');
  assert.equal(result.status, 'preflight_passed');
  assert.equal(result.sandbox.policyId, 'codex-readonly');
  assert.equal(result.sandbox.dimensions.filesystem, 'read_only');
});
