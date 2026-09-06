'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexProbeRunner, probeCodexCompatibility } = require('../build/core/dispatcher/codex-command');
const OpenClaw = require('../build/core/dispatcher/providers/openclaw-ws');

const runtime = { available: true, executable: process.execPath, argvPrefix: [], pathEntries: [] };

test('Codex native probe preserves bounded sanitized stderr and exit status', async () => {
  const result = await codexProbeRunner(runtime)(['-e',
    'process.stderr.write("bwrap: Operation not permitted; api_key=sk-testcredential123456789 /Users/private/config " + "x".repeat(2000));process.exit(1)'], os.tmpdir(), {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bwrap: Operation not permitted/);
  assert.doesNotMatch(result.stderr, /sk-testcredential|\/Users\/private/);
  assert.ok(result.stderr.length <= 400);
});

for (const [name, output, reason] of [
  ['initialization', { code: 1, stdout: '', stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }, 'CODEX_SANDBOX_INITIALIZATION_FAILED'],
  ['probe executable', { code: 3221225794, stdout: '', stderr: '' }, 'CODEX_PROBE_EXECUTION_FAILED'],
  ['timeout', { code: null, stdout: '', timedOut: true }, 'CODEX_PROBE_TIMEOUT'],
]) {
  test(`Codex distinguishes ${name} failure before any visitor task`, async () => {
    const result = await probeCodexCompatibility(runtime, async args => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.148.0' };
      if (args.length === 1) return { code: 0, stdout: '--sandbox read-only workspace-write --ask-for-approval never --profile' };
      if (args.includes('resume')) return { code: 0, stdout: '[SESSION_ID] --json --skip-git-repo-check' };
      if (args[0] === 'exec') return { code: 0, stdout: '--sandbox --json --skip-git-repo-check' };
      if (args.includes('--help')) return { code: 0, stdout: 'Usage: codex sandbox [OPTIONS] [COMMAND]...' };
      return output;
    }, 'linux');
    assert.equal(result.sandboxVerified, false);
    assert.equal(result.reason, reason);
    assert.equal(result.diagnostic.stage, 'sandbox:read-only');
    assert.equal(result.diagnostic.exitCode, output.code);
  });
}

function gateway(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-gateway-recovery-'));
  const marker = path.join(dir, 'attempt'), ready = path.join(dir, 'ready');
  const provider = new OpenClaw(null, null);
  provider.gatewayStartupTimeoutMs = 4000;
  provider.gatewayProbeIntervalMs = 10;
  const migration = 'OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.';
  const source = `const fs=require('fs');const marker=${JSON.stringify(marker)},ready=${JSON.stringify(ready)};const attempt=fs.existsSync(marker)?Number(fs.readFileSync(marker))+1:1;fs.writeFileSync(marker,String(attempt));if(${JSON.stringify(scenario)}==='recover'&&attempt===2){fs.writeFileSync(ready,'yes');setInterval(()=>{},1000)}else{process.stderr.write(${JSON.stringify(scenario === 'credential' ? 'Startup failed: required secrets are unavailable. api_key=sk-testcredential123456789' : migration)});process.exit(1)}`;
  provider._resolveOpenclawCmd = () => ({ cmd: process.execPath, args: ['-e', source], shell: false });
  provider._probeGateway = async () => fs.existsSync(ready);
  t.after(async () => { await provider.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { provider, attempts: () => Number(fs.readFileSync(marker)) };
}

test('Gateway restarts once after explicit migration exit, with concurrent callers sharing recovery', async t => {
  const { provider, attempts } = gateway(t, 'recover');
  const deadlines = [];
  const wait = provider._waitForGatewayReady.bind(provider);
  provider._waitForGatewayReady = deadline => { deadlines.push(deadline); return wait(deadline); };
  const results = await Promise.all([provider._ensureGatewayRunning(), provider._ensureGatewayRunning()]);
  assert.deepEqual(results, [true, true]);
  assert.equal(attempts(), 2);
  assert.equal(deadlines.length, 2);
  assert.ok(Number.isFinite(deadlines[0]));
  assert.equal(deadlines[0], deadlines[1]);
  assert.equal(provider.getStatus().startupFailure, null);
});

test('Gateway missing secrets fails promptly without restart and exposes sanitized cause', async t => {
  const { provider, attempts } = gateway(t, 'credential');
  const begin = Date.now();
  assert.equal(await provider._ensureGatewayRunning(), false);
  assert.ok(Date.now() - begin < 2500);
  assert.equal(attempts(), 1);
  assert.match(provider.getStatus().startupFailure.message, /required secrets/);
  assert.doesNotMatch(provider.getStatus().startupFailure.message, /sk-testcredential/);
});

test('Gateway migration restart is bounded to one retry', async t => {
  const { provider, attempts } = gateway(t, 'repeat');
  assert.equal(await provider._ensureGatewayRunning(), false);
  assert.equal(attempts(), 2);
});

test('Gateway stop during startup cancels migration recovery', async t => {
  const { provider, attempts } = gateway(t, 'repeat');
  const probe = provider._probeGateway;
  provider._probeGateway = async () => {
    try { if (attempts() === 1) await provider.stop(); } catch (_) {}
    return probe();
  };
  assert.equal(await provider._ensureGatewayRunning(), false);
  assert.equal(attempts(), 1);
});

test('Codex diagnostic reaches the capability snapshot without enabling controls', async t => {
  const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
  const { snapshotFromProvider } = require('../build/core/provider-capability');
  const command = require('../build/core/dispatcher/codex-command');
  const diagnostic = { stage: 'sandbox:workspace-write', exitCode: 0, message: 'Workspace write was not verified', timedOut: false };
  t.mock.method(command, 'probeCodexCompatibility', async () => ({ runtimeVersion: '0.148.0',
    callCompatibility: 'parameters_checked', sandboxVerified: false, reason: 'CODEX_SANDBOX_CANARY_FAILED', diagnostic }));
  const provider = new CodexCliProvider();
  t.mock.method(provider, '_resolveRuntime', () => ({ ...runtime, fingerprint: 'fixed' }));
  await provider.refreshSecurityControlEvidence();
  const snapshot = snapshotFromProvider(provider, 'codex-cli', 'agent');
  assert.deepEqual(snapshot.securityDiagnostic, diagnostic);
  assert.equal(snapshot.supportedControls.sandboxMode, undefined);
  await assert.rejects(provider.push({}), { code: 'CODEX_SANDBOX_CANARY_FAILED', deliveryOutcome: 'not_delivered' });
});


test('diagnostic text changes do not change the effective capability digest', () => {
  const { snapshotFromProvider } = require('../build/core/provider-capability');
  let message = 'first failure detail';
  const provider = { _resolveRuntime: () => ({ ...runtime, fingerprint: 'same' }),
    getSecurityControlEvidence: () => ({ runtimeVersion: '0.148.0', callCompatibility: 'parameters_checked',
      securityVerification: 'CODEX_SANDBOX_CANARY_FAILED', securityDiagnostic: { stage: 'sandbox:workspace-write',
        exitCode: 0, timedOut: false, message }, controlEvidence: {} }) };
  const first = snapshotFromProvider(provider, 'codex-cli', 'agent');
  message = 'new diagnostic with the same capability result';
  const second = snapshotFromProvider(provider, 'codex-cli', 'agent');
  assert.equal(first.capabilityDigest, second.capabilityDigest);
  assert.notEqual(first.securityDiagnostic.message, second.securityDiagnostic.message);
});
