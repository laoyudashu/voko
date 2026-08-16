'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PROVIDER_CATALOG, validateProviderCatalog } = require('../build/core/dispatcher/provider-catalog');
const {
  evaluateProviderSandbox,
  getProviderSandboxPolicy,
  getProviderSandboxRollout,
  listProviderSandboxPolicies,
  probeProviderVersion,
  findProviderSandboxVerification,
  recordProviderSandboxVerification,
  SANDBOX_POLICY_REVISION,
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

test('Qwen Office policy reflects its no-tools unattended invocation', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const policy = getProviderSandboxPolicy('qwen-office-restricted', platform);
    assert.ok(policy);
    assert.equal(policy.failurePolicy, 'best_effort');
    assert.equal(policy.dimensions.filesystem, 'blocked');
    assert.equal(policy.dimensions.commandExecution, 'disabled');
    assert.equal(policy.dimensions.humanApproval, 'denied');
    assert.equal(policy.dimensions.workingDirectory, 'isolated_temp');
    assert.equal(policy.dimensions.network, 'unknown');
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
    policyId: 'codex-readonly', platform: 'linux', providerVersion: '1.2.3', providerVersionVerified: true, env: {} });
  assert.equal(matched.rolloutMode, 'observe');
  assert.equal(matched.rolloutSelected, true);
  assert.equal(matched.status, 'verified_and_enforced');
  const unmatched = evaluateProviderSandbox({ db, providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'win32', providerVersion: '1.2.3', providerVersionVerified: true, env: {} });
  assert.equal(unmatched.rolloutMode, 'observe');
  assert.equal(unmatched.rolloutSelected, false);
  assert.equal(unmatched.status, 'verified_and_enforced');
});

test('version probe is bounded, shell-free, and returns only normalized metadata', () => {
  const known = probeProviderVersion(process.execPath, { args: ['--version'] });
  assert.equal(known.result, 'known');
  assert.match(known.version, /^\d+\.\d+/);
  assert.equal(known.source, 'command');
  assert.equal(Object.prototype.hasOwnProperty.call(known, 'output'), false);

  const missing = probeProviderVersion('voko-provider-that-is-not-installed', { timeoutMs: 250 });
  assert.equal(missing.result, 'unknown');
  assert.ok(['not_found', 'failed'].includes(missing.errorCode));
});

test('sandbox status binds the policy to the observed Provider version', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'linux', providerVersion: '1.2.3',
    providerVersionSource: 'command', providerVersionObservedAt: '2026-08-11T00:00:00.000Z',
    providerVersionProbe: { result: 'known' }, providerVersionVerified: true, env: {} });
  assert.equal(result.versionState, 'verified');
  assert.deepEqual(result.safetyProfile, {
    id: 'codex-readonly', revision: SANDBOX_POLICY_REVISION, providerVersion: '1.2.3',
    versionSource: 'command', observedAt: '2026-08-11T00:00:00.000Z', versionVerified: true,
    probe: { result: 'known' }, verification: null,
  });
});

test('unknown Provider version remains visible as unbound verification', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'goose', transportId: 'goose-acp',
    policyId: 'acp-deny-permission', platform: 'linux', providerVersionProbe: { result: 'unknown', errorCode: 'not_found' }, env: {} });
  assert.equal(result.versionState, 'unknown');
  assert.equal(result.safetyProfile.providerVersion, null);
  assert.equal(result.safetyProfile.probe.errorCode, 'not_found');
});

test('enforced flags without a known Provider version are not reported as verified', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'linux', env: {} });
  assert.equal(result.effective, true);
  assert.equal(result.status, 'provider_version_unverified');
  assert.equal(result.degradedReason, 'PROVIDER_VERSION_UNKNOWN');
});

test('a known but unverified Provider version is not reported as verified', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'codex', transportId: 'codex-cli',
    policyId: 'codex-readonly', platform: 'linux', providerVersion: '99.0.0', env: {} });
  assert.equal(result.versionState, 'known_unverified');
  assert.equal(result.status, 'provider_version_unverified');
  assert.equal(result.degradedReason, 'PROVIDER_VERSION_NOT_VERIFIED');
});

test('exact-version verification records are isolated by Provider, transport, OS, and policy revision', () => {
  const record = {
    providerFamily: 'codex', transportId: 'codex-cli', platform: 'linux', providerVersion: '1.2.3',
    policyRevision: SANDBOX_POLICY_REVISION, verifiedAt: '2026-08-11T00:00:00.000Z', source: 'real_test',
  };
  const result = evaluateProviderSandbox({ db: dbWith({ records: [record] }), providerFamily: 'codex',
    transportId: 'codex-cli', policyId: 'codex-readonly', platform: 'linux', providerVersion: '1.2.3', env: {} });
  assert.equal(result.versionState, 'verified');
  assert.equal(result.safetyProfile.verification.source, 'real_test');
  assert.equal(findProviderSandboxVerification(dbWith({ records: [record] }), {
    providerFamily: 'codex', transportId: 'codex-cli', platform: 'win32', providerVersion: '1.2.3',
  }), null);
});

test('verification registration writes only the sanitized exact-version record', () => {
  let stored = null;
  const db = { prepare() { return {
    get() { return stored ? { data: JSON.stringify(stored) } : undefined; },
    run(_type, data) { stored = JSON.parse(data); },
  }; } };
  const record = recordProviderSandboxVerification(db, {
    providerFamily: 'codex/unsafe', transportId: 'codex-cli', platform: 'linux', providerVersion: 'v1.2.3-extra',
    policyRevision: SANDBOX_POLICY_REVISION, verifiedAt: '2026-08-11T00:00:00.000Z', source: 'manual',
  });
  assert.equal(record.providerFamily, 'codexunsafe');
  assert.equal(record.providerVersion, '1.2.3-extra');
  assert.equal(stored.records.length, 1);
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
  const provider = catalog.instantiateProviderTransport(definition, { db: null, contextWindow: 5,
    providerVersion: '1.2.3', providerVersionSource: 'config', providerVersionObservedAt: '2026-08-11T00:00:00.000Z',
    providerVersionVerified: true });
  assert.equal(provider.sandboxPolicyId, 'codex-readonly');
  const status = provider.getSandboxStatus('agent-test');
  assert.equal(status.provider, 'codex');
  assert.equal(status.transport, 'codex-cli');
  assert.equal(status.providerVersion, '1.2.3');
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
  const provider = catalog.instantiateProviderTransport(definition, { db: null,
    providerVersion: '1.2.3', providerVersionSource: 'config', providerVersionObservedAt: '2026-08-11T00:00:00.000Z',
    providerVersionVerified: true });
  provider.preflightDelivery = async () => ({ ok: true, status: 'preflight_passed', sideEffects: false });
  const result = await definition.preflight(provider, 'agent-test');
  assert.equal(result.status, 'preflight_passed');
  assert.equal(result.sandbox.policyId, 'codex-readonly');
  assert.equal(result.sandbox.dimensions.filesystem, 'read_only');
});

test('ACP permission denial is reported as partial rather than full process isolation', () => {
  const result = evaluateProviderSandbox({ db: dbWith(null), providerFamily: 'goose',
    transportId: 'goose-acp', policyId: 'acp-deny-permission', platform: 'linux', env: {} });
  assert.equal(result.effective, true);
  assert.equal(result.status, 'partially_enforced');
  assert.equal(result.coverage, 'partial');
  assert.equal(result.dimensions.humanApproval, 'denied');
  assert.equal(result.dimensions.filesystem, 'unknown');
});
