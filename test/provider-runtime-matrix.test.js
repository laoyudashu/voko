const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const matrix = require('../scripts/provider-runtime-matrix');

test('provider runtime matrix parses resumable execution options', () => {
  assert.deepEqual(matrix.parseArgs(['--hosts=windows,linux', '--repeat', '5', '--resume', 'run-1',
    '--faults=probe-timeout,circuit-breaker', '--permissions=none', '--continue-on-user-action']), {
    hosts: ['windows', 'linux'], providers: 'installed-ready', transports: 'all-ready', repeat: 5,
    resume: 'run-1', faults: ['probe-timeout', 'circuit-breaker'], continueOnUserAction: true,
    retries: 2, resultTimeoutMs: 180000, driver: 'visitor', permissions: 'none', visitorBaseUrl: 'https://im.vokovoko.com',
    visitorProfile: path.join(path.dirname(__dirname), 'artifacts', 'real-tests', 'visitor-profile'), visitorHeaded: false, dryRun: false,
  });
});

test('provider runtime matrix discovers every ready transport and classifies pull-only Agents', () => {
  const inventories = { windows: { agents: [
    { agentId: 'a', agentName: 'TEST-A', imUid: 'uid-a', backendType: 'cline', runtime: {
      imConnected: true, automaticDeliveryReady: true, deliveryStatus: { methods: [
        { mode: 'acp', provider: 'cline-acp', configured: true, automaticReady: true },
        { mode: 'cli', provider: 'cline-cli', configured: true, automaticReady: true },
        { mode: 'pull', provider: null, configured: true, automaticReady: false },
      ] },
    } },
    { agentId: 'b', agentName: 'PULL', imUid: 'uid-b', backendType: 'openhands', runtime: {
      imConnected: true, automaticDeliveryReady: false, pullOnly: true, methods: [],
    } },
  ] } };
  const result = matrix.discoverCells(inventories, 'build-1');
  assert.deepEqual(result.cells.map(cell => cell.transport), ['cline-acp', 'cline-cli']);
  assert.equal(result.skipped[0].status, 'SKIPPED_NOT_READY');
  assert.equal(result.skipped[0].reason, 'pull_only');
});

test('provider runtime matrix includes installed verification-pending transports and reports unregistered apps', () => {
  const inventories = { macos: { agents: [{
    agentId: 'wb', agentName: 'WB', imUid: 'uid-wb', backendType: 'workbuddy', runtime: {
      imConnected: true, automaticDeliveryReady: false, deliveryStatus: { methods: [
        { mode: 'http', provider: 'workbuddy-http', configured: true, available: true,
          automaticReady: false, status: 'verification_required' },
      ] },
    },
  }], providerEnvironment: { detected: [
    { type: 'workbuddy', activityState: 'installed' },
    { type: 'dumate', activityState: 'installed', instances: [{ id: 'stock-assistant' }] },
  ] } } };
  const result = matrix.discoverCells(inventories, 'build-1');
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].transport, 'workbuddy-http');
  assert.equal(result.cells[0].needsVerification, true);
  assert.deepEqual(result.skipped.map(item => [item.provider, item.reason]), [
    ['dumate', 'installed_provider_not_registered'],
  ]);
});

test('dedicated TEST Agents can verify an installed but not yet configured transport', () => {
  const result = matrix.discoverCells({ windows: { agents: [{ agentId: 'q', agentName: 'TEST-QWEN',
    imUid: 'uid-q', backendType: 'qwen-office', runtime: { imConnected: true, pullOnly: true,
      deliveryStatus: { methods: [{ mode: 'cli', provider: 'qwen-office-cli', configured: false,
        available: true, automaticReady: false, status: 'verification_required' }] } } }] } }, 'build');
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].needsVerification, true);
});

test('not-ready reports preserve the Provider-specific blocking reason', () => {
  const result = matrix.discoverCells({ windows: { agents: [{ agentId: 'd', agentName: 'TEST-DUMATE',
    imUid: 'uid-d', backendType: 'dumate', runtime: { imConnected: true, pullOnly: true,
      deliveryStatus: { methods: [{ mode: 'http', provider: 'dumate-http', configured: false,
        available: false, automaticReady: false, status: 'configuration_required', reason: 'backend_not_running' }] } } }] } }, 'build');
  assert.equal(result.cells.length, 0);
  assert.equal(result.skipped[0].reason, 'provider_not_ready:backend_not_running');
});

test('visitor access preparation covers every TEST Agent and ignores production Agents', () => {
  const calls = [];
  const host = { json(args) {
    calls.push(args);
    if (args[0] === 'list_access_lists') return { success: true, data: [{ visitor_id: 'visitor-1' }] };
    return { success: true };
  } };
  const result = matrix.prepareVisitorAccess(host, { agents: [
    { agentId: 'test-a', agentName: 'TEST-HERMES' },
    { agentId: 'test-b', agentName: 'TEST-OPENCODE' },
    { agentId: 'prod', agentName: 'Production' },
  ] }, 'visitor-1');
  assert.deepEqual(result.map(item => [item.agentId, item.ok]), [['test-a', true], ['test-b', true]]);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(0, 3).map(args => args[0]),
    ['manage_blacklist', 'manage_whitelist', 'list_access_lists']);
  assert.equal(calls.some(args => args.includes('prod')), false);
});

test('provider and transport selectors filter discovered ready cells', () => {
  const cells = [
    { provider: 'opencode-cli', transport: 'opencode-cli', mode: 'cli', method: { family: 'opencode' } },
    { provider: 'hermes-cli', transport: 'hermes-cli', mode: 'cli', method: { family: 'hermes' } },
  ];
  assert.deepEqual(matrix.filterCells(cells, { providers: 'hermes', transports: 'all-ready' }), [cells[1]]);
  assert.deepEqual(matrix.filterCells(cells, { providers: 'installed-ready', transports: 'opencode-cli' }), [cells[0]]);
});

test('formal matrix evidence uses the running process build instead of replaced files', () => {
  assert.deepEqual(matrix.runtimeBuildEvidence({ buildDigest: 'disk', runtimeBuildDigest: 'running', buildState: 'stale' }),
    { digest: 'running', state: 'stale', usable: false });
  assert.deepEqual(matrix.runtimeBuildEvidence({ buildDigest: 'same', runtimeBuildDigest: 'same', buildState: 'current' }),
    { digest: 'same', state: 'current', usable: true });
  assert.deepEqual(matrix.runtimeBuildEvidence({ buildDigest: 'legacy' }),
    { digest: 'legacy', state: 'legacy', usable: true });
});

test('matrix sender is passive and cannot create an automatic Agent reply loop', () => {
  const inventory = { agents: [
    { agentId: 'target', imUid: 'target-uid', runtime: { automaticDeliveryReady: true } },
    { agentId: 'auto-peer', imUid: 'auto-uid', runtime: { automaticDeliveryReady: true } },
    { agentId: 'passive-peer', imUid: 'passive-uid', runtime: { automaticDeliveryReady: false, pullOnly: true } },
  ] };
  assert.equal(matrix.chooseSender(inventory, { agentId: 'target' }).agentId, 'passive-peer');
});

test('provider runtime matrix classifies authentication without retrying as a generic failure', () => {
  assert.equal(matrix.classifyResult({ execution: { state: 'AUTH_REQUIRED' }, reply: { state: 'FAILED' } }), 'NEEDS_USER_ACTION');
  assert.equal(matrix.classifyResult({ execution: { state: 'COMPLETED' }, reply: { state: 'DELIVERED' } }), 'PASS');
  assert.equal(matrix.classifyResult({ execution: { state: 'FAILED', reasonCode: 'PROVIDER_TIMEOUT' } }), 'FAIL');
});

test('provider runtime matrix retries only turns proven not submitted', () => {
  assert.equal(matrix.mayRetryAttempt({ outcome: 'not_submitted' }), true);
  assert.equal(matrix.mayRetryAttempt({ outcome: 'submitted_result_unknown_no_retry' }), false);
  assert.equal(matrix.mayRetryAttempt({ messageId: 'msg-1', status: 'FAIL' }), false);
});

test('submitted nonterminal and delivery-unknown turns are never automatically retried', () => {
  assert.equal(matrix.submittedOutcomeUnknown([{ messageId: 'm1', execution: { state: 'WORKING' } }]), true);
  assert.equal(matrix.submittedOutcomeUnknown([{ messageId: 'm2', execution: { state: 'DELIVERY_UNKNOWN' } }]), true);
  assert.equal(matrix.submittedOutcomeUnknown([{ messageId: 'm3', execution: { state: 'FAILED' } }]), false);
});

test('runtime control retries transient runtime startup without retrying other failures', () => {
  let calls = 0;
  const host = { json() { calls += 1; if (calls < 2) throw new Error('RUNTIME_STARTING'); return { success: true }; } };
  assert.equal(matrix.callRuntimeControl(host, ['status'], 10, 1).ok, true);
  assert.equal(calls, 2);
  calls = 0;
  const permanent = { json() { calls += 1; throw new Error('AUTH_REQUIRED'); } };
  assert.equal(matrix.callRuntimeControl(permanent, ['status'], 10, 3).ok, false);
  assert.equal(calls, 1);
});

test('visitor turn evidence waits for one uniquely persisted Provider Turn', async () => {
  let calls = 0;
  const host = { json() {
    calls += 1;
    if (calls === 1) return { success: true, data: { turn: null, matchCount: 0 } };
    return { success: true, data: { turn: { turn_id: 'turn-1', transport_id: 'cline-acp' }, matchCount: 1 } };
  } };
  const evidence = await matrix.captureTurnEvidence(host, { agentId: 'agent-1', transport: 'cline-acp' },
    { since: 100 }, null, { timeoutMs: 50, intervalMs: 1 });
  assert.equal(calls, 2);
  assert.equal(evidence.data.turn.turn_id, 'turn-1');
});

test('visitor turn evidence does not accept an ambiguous time-window match', async () => {
  const host = { json() { return { success: true, data: {
    turn: { turn_id: 'latest', transport_id: 'cline-acp' }, matchCount: 2,
  } }; } };
  const evidence = await matrix.captureTurnEvidence(host, { agentId: 'agent-1', transport: 'cline-acp' },
    { since: 100 }, null, { timeoutMs: 0, intervalMs: 1 });
  assert.equal(evidence.data.matchCount, 2);
  assert.equal(evidence.data.turn, null);
  assert.equal(evidence.ambiguous, true);
});

test('provider runtime matrix redacts secrets and local paths', () => {
  const output = matrix.redact({ key: 'cell-id', apiKey: 'secret', commandPath: 'C:\\Users\\laoyu\\tool.exe', nested: { token: '' } });
  assert.equal(output.key, 'cell-id');
  assert.equal(output.apiKey.present, true);
  assert.equal(output.apiKey.digest.length, 16);
  assert.equal(output.commandPath, '[LOCAL_PATH]');
  assert.deepEqual(output.nested.token, { present: false });
});

test('fault injection is restricted to dedicated TEST Agents and explicit adapters', () => {
  assert.equal(matrix.faultEligibility({ agentName: 'PRODUCTION' }, 'probe-timeout').reason, 'faults_require_TEST_agent');
  assert.match(matrix.faultEligibility({ agentName: 'TEST-CODEX', transport: 'codex-cli' }, 'probe-timeout').reason,
    /not_applicable/);
  assert.deepEqual(matrix.faultEligibility({ agentName: 'TEST-WORKBUDDY', transport: 'workbuddy-http' }, 'probe-timeout'),
    { ok: true, injector: 'dispatcher-delay' });
  assert.deepEqual(matrix.faultEligibility({ agentName: 'TEST-OPENCODE', transport: 'opencode-acp' }, 'fingerprint-change'),
    { ok: true, injector: 'capability-snapshot' });
  assert.deepEqual(matrix.faultEligibility({ agentName: 'TEST-ZEROCLAW', transport: 'zeroclaw-ws' }, 'circuit-breaker'),
    { ok: true, injector: 'policy-store' });
});

test('policy mutation selects only a strictly safer enum value', () => {
  const change = matrix.saferPolicyChange({
    config: { safeMode: 'disabled' },
    controls: [{ id: 'safeMode', kind: 'enum', editable: true, values: [
      { value: 'enabled', risk: 'medium' }, { value: 'disabled', risk: 'high' },
    ] }],
  });
  assert.deepEqual(change, { controlId: 'safeMode', from: 'disabled', to: 'enabled', config: { safeMode: 'enabled' } });
  assert.equal(matrix.saferPolicyChange({ config: { safeMode: 'enabled' }, controls: [{
    id: 'safeMode', kind: 'enum', editable: true, values: [{ value: 'enabled', risk: 'medium' }, { value: 'disabled', risk: 'high' }],
  }] }), null);
});

test('permission canaries isolate transport and Agent-scoped controls and reserve risk expansion for TEST Agents', () => {
  const security = { config: { shell: 'off', prompt: 'base' }, controls: [
    { id: 'shell', kind: 'enum', editable: true, values: [{ value: 'off', risk: 'low' }, { value: 'on', risk: 'high' }] },
    { id: 'prompt', kind: 'text', editable: true, maxLength: 200 },
    { id: 'fixed', kind: 'status', editable: false },
  ], instancePolicy: { config: { workspace: 'on' }, controls: [
    { id: 'workspace', kind: 'enum', editable: true, values: [{ value: 'on', risk: 'low' }, { value: 'off', risk: 'high' }] },
  ] } };
  assert.deepEqual(matrix.policyCanaries(security, 'PRODUCTION').map(item => item.controlId), ['prompt']);
  const testCanaries = matrix.policyCanaries(security, 'TEST-HERMES');
  assert.deepEqual(testCanaries.map(item => item.controlId), ['workspace', 'shell', 'prompt']);
  assert.deepEqual(testCanaries.map(item => item.scope), ['agent', 'transport', 'transport']);
  assert.equal(testCanaries[0].config.instanceConfig.workspace, 'off');
  assert.equal(testCanaries[0].config.transportConfig.prompt, 'base');
  assert.equal(testCanaries[1].config.instanceConfig.workspace, 'on');
  assert.equal(testCanaries[2].config.transportConfig.shell, 'off');
});

test('policy commit omits an empty optional confirmation argument', () => {
  const calls = [];
  const host = { json(args) {
    calls.push(args);
    return args[0] === 'preflight_provider_security'
      ? { success: true, data: { preflightToken: 'token-1' } }
      : { success: true, data: { revision: 1 } };
  } };
  assert.equal(matrix.commitPolicy(host, { agentId: 'agent-1', transport: 'hermes-cli' }, { safeMode: 'enabled' }).ok, true);
  assert.equal(calls[1].includes('--confirmation'), false);
});

test('atomic checkpoint writes valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-matrix-'));
  try {
    const file = path.join(dir, 'checkpoint.json');
    matrix.atomicJson(file, { status: 'RUNNING' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { status: 'RUNNING' });
    assert.deepEqual(fs.readdirSync(dir), ['checkpoint.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('matrix process lock rejects a concurrent runner and is released by its owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-matrix-lock-'));
  const lock = path.join(dir, 'matrix.lock');
  try {
    const release = matrix.acquireMatrixLock(lock);
    assert.throws(() => matrix.acquireMatrixLock(lock), /already running/);
    release();
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resume rejects changes to matrix identity options', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-matrix-resume-'));
  const runId = path.basename(dir);
  // checkpointFor accepts an explicit root in tests so no workspace artifact is touched.
  const first = matrix.checkpointFor(runId, {
    hosts: ['macos'], providers: 'installed-ready', transports: 'all-ready', repeat: 3, faults: [],
  }, path.dirname(dir));
  assert.equal(first.data.options.repeat, 3);
  assert.throws(() => matrix.checkpointFor(runId, {
    hosts: ['macos'], providers: 'installed-ready', transports: 'all-ready', repeat: 1, faults: [],
  }, path.dirname(dir)), /resume options differ.*repeat/);
});
