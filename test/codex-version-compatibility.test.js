'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const command = require('../build/core/dispatcher/codex-command');
const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
const { CliAdapter } = require('../build/core/adapters/cli-adapter');
const { snapshotFromProvider } = require('../build/core/provider-capability');
const { applyProviderSecurityArgs } = require('../build/core/provider-security-policy');
const rootHelp = '--sandbox read-only workspace-write --ask-for-approval never --profile';
const execHelp = '--json --sandbox --skip-git-repo-check';
const resumeHelp = 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n--json --skip-git-repo-check';
const available = { available: true, executable: process.execPath, argvPrefix: [], pathEntries: [], resolvedAt: 0 };

function runner({ version = '0.153.4', legacy = false, failure = '', calls = [] } = {}) {
  return async (args, cwd, env) => {
    calls.push([...args]);
    assert.notEqual(env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
    assert.equal(path.dirname(env.CODEX_HOME), path.dirname(cwd));
    if (args[0] === '--version') return { code: 0, stdout: `codex-cli ${version}` };
    if (args.length === 1) return { code: 0, stdout: rootHelp };
    if (args.includes('resume')) return { code: failure === 'resume' ? 1 : 0, stdout: resumeHelp };
    if (args[0] === 'exec') return { code: 0, stdout: failure === 'json' ? '--sandbox' : execHelp };
    if (args.includes('--help')) return { code: 0, stdout: legacy ? 'Commands: macos linux windows' : 'Usage: codex sandbox [OPTIONS] [COMMAND]...' };
    if (failure === 'timeout') return { code: null, stdout: '' };
    const writable = args.some(arg => arg === 'sandbox_mode="workspace-write"');
    const nativeWindows = args.includes('voko-probe.cmd');
    const mode = writable ? 'workspace-write' : 'read-only';
    const [read, inside, outside] = nativeWindows
      ? [path.join(cwd, '..', 'outside', 'read-canary'), path.join(cwd, mode), path.join(cwd, '..', 'outside', mode)]
      : args.slice(-3);
    if (writable || failure === 'write-escape') fs.writeFileSync(inside, 'voko-canary');
    if (failure === 'outside-escape') fs.writeFileSync(outside, 'voko-canary');
    if (nativeWindows) return { code: 0, stdout: fs.readFileSync(read, 'utf8') };
    return { code: 0, stdout: JSON.stringify({ read: fs.readFileSync(read, 'utf8'),
      inside: writable || failure === 'write-escape' ? 'allowed' : 'EPERM',
      outside: failure === 'outside-escape' ? 'allowed' : 'EPERM' }) };
  };
}

for (const [version, legacy] of [['0.148.0', false], ['0.151.0-alpha.7.1', false], ['0.153.4', false], ['99.0.0', false]]) {
  test(`Codex ${version} uses observed contracts and sandbox evidence, not a version allowlist`, async () => {
    const calls = [];
    const result = await command.probeCodexCompatibility(available, runner({ version, legacy, calls }), 'darwin');
    assert.equal(result.runtimeVersion, version);
    assert.equal(result.callCompatibility, 'parameters_checked');
    assert.equal(result.sandboxVerified, true);
    assert.equal(calls.filter(args => args.includes('--')).length, 2);
    assert.equal(calls.some(args => args[0] === 'sandbox' && args[1] === 'macos'), legacy);
  });
}

test('Codex legacy platform-subcommand sandbox contract remains supported', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    const result = await command.probeCodexCompatibility(available, runner({ legacy: true, calls }), platform);
    assert.equal(result.sandboxVerified, true);
    assert.equal(calls.some(args => args[1] === ({ darwin: 'macos', linux: 'linux', win32: 'windows' })[platform]), true);
  }
});

test('captured real Codex releases satisfy the same first-turn and resume contract', () => {
  const fixture = require('./fixtures/codex-compatibility/runtime-probes.json');
  assert.deepEqual(fixture.probes.map(probe => probe.runtimeVersion).sort(), ['0.148.0', '0.151.0-alpha.7.1', '0.153.4']);
  for (const probe of fixture.probes) {
    const help = probe.calls.filter(call => call.args.includes('--help'));
    assert.equal(command.codexContractSupported(help[0].help, help[1].help, help[2].help), true);
    assert.equal(probe.sandboxVerified, true);
    assert.equal(probe.calls.every(call => call.code === 0), true);
  }
});

for (const failure of ['resume', 'json', 'timeout', 'write-escape', 'outside-escape']) {
  test(`Codex ${failure} leaves sandbox control unavailable`, async () => {
    const result = await command.probeCodexCompatibility(available, runner({ failure }));
    assert.equal(result.sandboxVerified, false);
    assert.notEqual(result.reason, 'CODEX_SANDBOX_CANARY_VERIFIED');
  });
}

test('Codex unavailable runtime never starts a probe', async () => {
  const result = await command.probeCodexCompatibility({ ...available, available: false }, () => assert.fail('spawn'));
  assert.equal(result.reason, 'CODEX_RUNTIME_UNAVAILABLE');
});

test('Codex fingerprint follows same-version executable and npm payload replacements', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'arm64', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.153.4' }));
  const shim = path.join(root, 'bin', 'codex.js');
  fs.writeFileSync(shim, 'launcher');
  const binary = path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'arm64', 'codex', 'codex');
  fs.writeFileSync(binary, 'native v1');
  const runtime = { ...available, canonicalPath: shim, argvPrefix: [shim], fingerprint: 'cached-resolver' };
  const first = command.inspectCodexRuntime(runtime).fingerprint;
  assert.equal(command.inspectCodexRuntime(runtime).fingerprint, first);
  fs.writeFileSync(binary, 'native replacement without version bump');
  assert.notEqual(command.inspectCodexRuntime(runtime).fingerprint, first);
});

test('Codex legacy version and delivery readiness cannot certify sandbox without a canary', () => {
  const provider = { _resolveRuntime: () => available,
    getSecurityControlEvidence: () => ({ runtimeVersion: '0.151.0-alpha.7.1', readiness: { verificationStatus: 'loopback_verified' } }) };
  assert.equal(snapshotFromProvider(provider, 'codex-cli', 'agent').supportedControls.sandboxMode, undefined);
  provider.getSecurityControlEvidence = () => ({ runtimeVersion: '99.0.0', callCompatibility: 'parameters_checked',
    controlEvidence: { sandboxMode: { testKind: 'isolated_sandbox_canary' } } });
  const snapshot = snapshotFromProvider(provider, 'codex-cli', 'agent');
  assert.equal(snapshot.supportedControls.sandboxMode.evidence, 'real_test');
  assert.equal(snapshot.supportedControls.network, undefined);
  assert.equal(snapshot.evidenceState, 'static_compatible');
});

test('Codex first turn and resume both apply the selected sandbox and never approval', () => {
  const provider = new CodexCliProvider();
  for (const session of [null, '00000000-0000-0000-0000-000000000001']) {
    for (const mode of ['read_only', 'workspace_write']) {
      const args = applyProviderSecurityArgs(provider._argsForSession(session), {
        providerSecurityPolicy: { transportId: 'codex-cli', config: { sandboxMode: mode } },
      });
      assert.equal(args[args.indexOf('--sandbox') + 1], mode.replace('_', '-'));
      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
      assert.equal(args.indexOf('--ask-for-approval') < args.indexOf('exec'), true);
      if (session) assert.equal(args.indexOf('--sandbox') < args.indexOf('resume'), true);
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    }
  }
});

test('Codex probe cache is invalidated on replacement and rejects an old policy before submitting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex'); fs.writeFileSync(bin, 'first');
  const provider = new CodexCliProvider();
  provider._runtimeResolver = { invalidate() {}, resolve: () => ({ ...available, executable: bin }) };
  let probes = 0, submits = 0;
  t.mock.method(command, 'probeCodexCompatibility', async () => {
    probes++; return { runtimeVersion: '0.153.4', callCompatibility: 'parameters_checked', sandboxVerified: true, reason: 'CODEX_SANDBOX_CANARY_VERIFIED' };
  });
  t.mock.method(CliAdapter.prototype, 'push', async () => { submits++; return {}; });
  await Promise.all([provider.refreshSecurityControlEvidence(), provider.refreshSecurityControlEvidence()]);
  assert.equal(probes, 1);
  const old = snapshotFromProvider(provider, 'codex-cli', 'agent');
  const payload = { agentId: 'agent', fromUid: 'visitor', messageId: 'm', content: 'test', providerSecurityPolicy: { runtimeFingerprint: old.runtimeFingerprint } };
  await provider.push(payload);
  assert.equal(probes, 1);
  assert.equal(submits, 1);
  fs.writeFileSync(bin, 'replacement');
  const changed = provider.getSecurityControlEvidence();
  assert.equal(changed.runtimeVersion, null);
  assert.deepEqual(changed.controlEvidence, {});
  await assert.rejects(provider.push(payload), { code: 'PROVIDER_CAPABILITY_CONFLICT', deliveryOutcome: 'not_delivered' });
  assert.equal(probes, 2);
  assert.equal(submits, 1);
});

test('Codex failed canary and expired submission cannot start a visitor task', async t => {
  const provider = new CodexCliProvider();
  t.mock.method(CliAdapter.prototype, 'push', async () => assert.fail('submitted'));
  t.mock.method(provider, 'getSecurityControlEvidence', () => ({ securityVerification: 'CODEX_SANDBOX_CANARY_FAILED', controlEvidence: {} }));
  await assert.rejects(provider.push({}), { code: 'CODEX_SANDBOX_CANARY_FAILED' });
  provider.getSecurityControlEvidence.mock.restore();
  t.mock.method(provider, 'getSecurityControlEvidence', () => ({ securityVerification: 'CODEX_SANDBOX_CANARY_VERIFIED', controlEvidence: { sandboxMode: true } }));
  await assert.rejects(provider.push({ assertSubmissionCurrent() { throw new Error('expired'); } }), /expired/);
});

test('a failed revalidation revokes earlier Codex controls even for the same executable', t => {
  const { DatabaseSync } = require('node:sqlite');
  const { ProviderSecurityPolicyService } = require('../build/core/provider-security-policy');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE agents(agent_id TEXT PRIMARY KEY,agent_name TEXT,backend_type TEXT); INSERT INTO agents VALUES('agent','Codex','codex');");
  const service = new ProviderSecurityPolicyService(db);
  const base = { runtimeFingerprint: 'same-file', capabilityDigest: 'old', observedAt: Date.now(), expiresAt: Date.now() + 10000 };
  service.storeCapability('agent', 'codex-cli', { ...base, evidenceState: 'static_compatible',
    securityVerification: 'CODEX_SANDBOX_CANARY_VERIFIED', supportedControls: { sandboxMode: {}, additionalPrompt: {} } });
  assert.equal(service.inspect('agent', 'codex-cli').controls.some(c => c.id === 'sandboxMode'), true);
  service.storeCapability('agent', 'codex-cli', { ...base, capabilityDigest: 'failed', evidenceState: 'failed',
    securityVerification: 'CODEX_SANDBOX_CANARY_FAILED', supportedControls: { additionalPrompt: {} } });
  assert.equal(service.capability('agent', 'codex-cli').verified, null);
  assert.equal(service.inspect('agent', 'codex-cli').controls.some(c => c.id === 'sandboxMode'), false);
});

test('Codex probe cannot publish evidence for a replaced runtime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-replaced-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex'); fs.writeFileSync(bin, 'before');
  const provider = new CodexCliProvider();
  provider._runtimeResolver = { invalidate() {}, resolve: () => ({ ...available, executable: bin }) };
  t.mock.method(command, 'probeCodexCompatibility', async () => {
    fs.writeFileSync(bin, 'replaced during probe');
    return { runtimeVersion: '0.153.4', callCompatibility: 'parameters_checked', sandboxVerified: true, reason: 'CODEX_SANDBOX_CANARY_VERIFIED' };
  });
  await provider.refreshSecurityControlEvidence();
  assert.equal(provider.getSecurityControlEvidence().runtimeVersion, null);
  assert.deepEqual(provider.getSecurityControlEvidence().controlEvidence, {});
});


test('Windows Codex canary uses a fixed cmd script and independently detects write escape', async () => {
  for (const failure of ['', 'write-escape', 'outside-escape']) {
    const calls = [];
    const result = await command.probeCodexCompatibility(available, runner({ failure, calls }), 'win32');
    assert.equal(result.sandboxVerified, !failure);
    const probes = calls.filter(args => args.includes('--'));
    assert.ok(probes.every(args => args.includes('voko-probe.cmd') && !args.includes('-e')));
  }
});

test('explicit native sandbox policy does not require the VOKO read-only canary to pass', async t => {
  const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
  const { CliAdapter } = require('../build/core/adapters/cli-adapter');
  const provider = new CodexCliProvider();
  t.mock.method(provider, 'getSecurityControlEvidence', () => ({ securityVerification: 'CODEX_SANDBOX_INITIALIZATION_FAILED', controlEvidence: {} }));
  let submitted = 0;
  t.mock.method(CliAdapter.prototype, 'push', async () => { submitted++; });
  await provider.push({ agentId: 'agent', messageId: 'native', providerSecurityPolicy: { config: { sandboxMode: 'native' } } });
  assert.equal(submitted, 1);
  await assert.rejects(provider.push({ agentId: 'agent', messageId: 'restricted', providerSecurityPolicy: { config: { sandboxMode: 'read_only' } } }), /CODEX_SANDBOX_INITIALIZATION_FAILED/);
  assert.equal(submitted, 1);
});
