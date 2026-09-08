'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDatabase } = require('../build/core/database');
const { listProviderTransports, instantiateProviderTransport } = require('../build/core/dispatcher/provider-catalog');
const { ProviderSecurityPolicyService, getProviderSecurityControls, isProviderSecurityTransport, applyProviderSecurityArgs,
  providerSecurityEnv } = require('../build/core/provider-security-policy');

const transports = listProviderTransports().filter(t => isProviderSecurityTransport(t.id));
for (const transport of transports) {
  test(`${transport.id}: every configurable value survives commit, reload and a new visitor turn`, () => {
    const db = initDatabase(':memory:', { silent: true });
    try {
      db.prepare(`INSERT INTO agents(id,agent_id,agent_name,imUid,imToken,im_server_url,backend_type,created_at,updated_at)
        VALUES('row','agent','Policy Test','uid','test','',?,1,1)`).run(transport.family);
      let service = new ProviderSecurityPolicyService(db);
      const original = service.effective('agent', transport.id);
      let turn = 0;
      for (const control of getProviderSecurityControls(transport.id).filter(c => c.editable)) {
        const values = control.kind === 'enum' ? control.values.map(v => v.value) : ['', control.id === 'permissionPreset' ? 'owner-test-preset' : 'Owner supplied instruction'];
        for (const value of values) {
          const preflight = service.preflight('agent', transport.id, { [control.id]: value });
          service.commit('agent', preflight.preflightToken, 'Policy Test');
          service = new ProviderSecurityPolicyService(db);
          const lease = service.acquireTurnLease({ agentId: 'agent', channelType: 1, messageId: `turn-${turn++}` }, transport.id);
          assert.equal(lease.config[control.id], value);
        }
      }
      // Preflight is a patch: explicitly clear optional fields absent from the initial policy.
      const restoredConfig = { ...original.config };
      for (const control of getProviderSecurityControls(transport.id).filter(c => c.editable && c.kind !== 'enum')) {
        if (!(control.id in restoredConfig)) restoredConfig[control.id] = '';
      }
      const restore = service.preflight('agent', transport.id, restoredConfig);
      service.commit('agent', restore.preflightToken, 'Policy Test');
      assert.deepEqual(service.effective('agent', transport.id).config, restoredConfig);
    } finally { db.close(); }
  });
}

// Execute the real CliAdapter with a harmless local process, retaining Provider
// argument construction while replacing only the model runtime and reply parser.
for (const transportId of ['qwen-cli', 'pi-cli', 'reasonix-cli', 'grok-cli', 'aider-cli', 'cline-cli',
  'cursor-cli', 'gemini-cli', 'kiro-cli', 'github-copilot-cli', 'opencode-cli']) {
  test(`${transportId}: native choice reaches spawned argv, environment and prompt`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-native-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const capture = path.join(root, 'capture.json');
    const executable = path.join(root, 'capture.cjs');
    fs.writeFileSync(executable, `const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input,env:Object.fromEntries(['QWEN_CODE_SAFE_MODE','CLINE_COMMAND_PERMISSIONS','GEMINI_SANDBOX','OPENCODE_CONFIG_CONTENT','OPENCODE_DISABLE_PROJECT_CONFIG'].map(k=>[k,process.env[k]||null]))}));console.log('captured');});process.stdin.resume();`);
    const definition = transports.find(x => x.id === transportId);
    const provider = instantiateProviderTransport(definition, { providerVersion: 'fixture', getProviderConfig: () => ({ cwd: root, sessionPersistence: 'dispatcher' }) });
    t.after(() => provider.stop());
    const template = [...provider._args];
    provider._cmd = process.execPath;
    provider._runtimeRequest = null;
    provider._args = [executable, ...template];
    provider._argsForSession = null;
    provider._parserName = 'raw';
    provider._timeout = 5000;
    provider._resolveSessionIdAfterRun = null;
    provider._createManagedSessionId = null;
    provider._instanceArgs = null;
    const config = { executionMode: 'native', pluginMode: 'default', approvalMode: 'required' };
    await provider.push({ agentId: 'agent', fromUid: 'visitor', channelType: 1, messageId: transportId, content: 'synthetic question',
      providerSecurityPolicy: { transportId, config } });
    const result = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.ok(result.args.some(x => x.includes('synthetic question')) || result.input.includes('synthetic question'));
    assert.doesNotMatch(result.input + result.args.join(' '), /不得调用工具|Never execute tools|只能回复文字/);
    for (const flag of ['--no-tools', '--max-tool-calls', '--deny', '--dry-run', '--plan', '--trust-tools=', '--deny-tool=read']) {
      assert.equal(result.args.includes(flag), false, flag);
    }
    const envKey = { 'qwen-cli': 'QWEN_CODE_SAFE_MODE', 'cline-cli': 'CLINE_COMMAND_PERMISSIONS',
      'gemini-cli': 'GEMINI_SANDBOX', 'opencode-cli': 'OPENCODE_CONFIG_CONTENT' }[transportId];
    if (envKey) assert.equal(result.env[envKey], process.env[envKey] || null);
    assert.deepEqual(template, provider._args.slice(1));
  });
}

test('OpenCode tool policy and plugin configuration are independent', () => {
  const env = { OPENCODE_CONFIG_CONTENT: 'deny', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', RETAIN: 'yes' };
  assert.deepEqual(providerSecurityEnv(env, 'opencode-acp', { executionMode: 'native', pluginMode: 'isolated' }),
    { OPENCODE_DISABLE_PROJECT_CONFIG: 'true', RETAIN: 'yes' });
  assert.deepEqual(providerSecurityEnv(env, 'opencode-acp', { executionMode: 'restricted', pluginMode: 'default' }),
    { OPENCODE_CONFIG_CONTENT: 'deny', RETAIN: 'yes' });
  assert.deepEqual(applyProviderSecurityArgs(['run', '--pure', '--auto'], { providerSecurityPolicy: {
    transportId: 'opencode-cli', config: { executionMode: 'native', pluginMode: 'default', approvalMode: 'required' },
  } }), ['run']);
});

test('sandbox diagnostics stop claiming the default restrictions after an explicit native choice', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    db.prepare(`INSERT INTO agents(id,agent_id,agent_name,imUid,imToken,im_server_url,backend_type,created_at,updated_at)
      VALUES('row','agent','Policy Test','uid','test','','qwen-code',1,1)`).run();
    const service = new ProviderSecurityPolicyService(db);
    const definition = transports.find(x => x.id === 'qwen-cli');
    const provider = instantiateProviderTransport(definition, { db, providerVersion: '0.21.13', providerVersionVerified: true });
    const before = provider.getSandboxStatus('agent');
    assert.equal(before.dimensions.commandExecution, 'disabled');
    const change = service.preflight('agent', 'qwen-cli', { executionMode: 'native' });
    service.commit('agent', change.preflightToken, 'Policy Test');
    const after = provider.getSandboxStatus('agent');
    assert.equal(after.effective, false);
    assert.equal(after.status, 'user_configured');
    assert.equal(after.dimensions.commandExecution, 'unknown');
    assert.equal(after.dimensions.filesystem, 'unknown');
  } finally { db.close(); }
});

test('DSH version, identity and invocation follow the resolved package, not Node', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dsh-version-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
    fs.rmSync(root, { recursive: true, force: true }); });
  const pkg = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
  const captured = path.join(root, 'argv.json');
  fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), `require('fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)));console.log('DSH synthetic reply');`);
  const provider = instantiateProviderTransport(transports.find(x => x.id === 'deepseek-harness-cli'), {});
  assert.equal(provider.getProviderVersion().version, '0.1.1-rc.2');
  assert.equal(provider.getProviderVersion().source, 'resolved_package_manifest');
  const { snapshotFromProvider } = require('../build/core/provider-capability');
  const first = snapshotFromProvider(provider, 'deepseek-harness-cli', 'agent');
  await provider.push({ agentId: 'agent', fromUid: 'visitor', messageId: 'dsh-turn', content: 'synthetic DSH request' });
  const args = JSON.parse(fs.readFileSync(captured, 'utf8'));
  assert.equal(args.filter(x => x === '--profile').length, 1);
  assert.equal(args.some(x => x.endsWith('bin.js')), false);
  assert.ok(args.some(x => x.includes('synthetic DSH request')));
  await provider.stop();
  fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '/* replaced synthetic runtime without a version bump */');
  const second = snapshotFromProvider(provider, 'deepseek-harness-cli', 'agent');
  assert.notEqual(first.runtimeFingerprint, second.runtimeFingerprint);
  assert.equal(second.runtimeVersion, '0.1.1-rc.2');
});

for (const transportId of ['github-copilot-acp', 'codebuddy-acp', 'traecli-acp', 'opencode-acp']) {
  test(`${transportId}: saved native policy takes effect when the Agent process restarts`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-acp-policy-'));
    const capture = path.join(root, 'capture.ndjson');
    const executable = path.join(root, 'capture.cjs');
    fs.writeFileSync(executable, `require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),config:process.env.OPENCODE_CONFIG_CONTENT||null})+'\\n');setInterval(()=>{},1000);`);
    const db = initDatabase(':memory:', { silent: true });
    const definition = transports.find(x => x.id === transportId);
    db.prepare(`INSERT INTO agents(id,agent_id,agent_name,imUid,imToken,im_server_url,backend_type,created_at,updated_at)
      VALUES('row','agent','Policy Test','uid','test','',?,1,1)`).run(definition.family);
    const service = new ProviderSecurityPolicyService(db);
    // Windows discovery requires an installed loader; use a fixture instead of
    // inheriting whichever Copilot installation exists on the developer host.
    const previousAppData = process.env.APPDATA;
    let provider;
    try {
      if (transportId === 'github-copilot-acp' && process.platform === 'win32') {
        const appData = path.join(root, 'Roaming');
        const loader = path.join(appData, 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js');
        fs.mkdirSync(path.dirname(loader), { recursive: true });
        fs.writeFileSync(loader, '/* synthetic Copilot discovery fixture */');
        process.env.APPDATA = appData;
      }
      provider = instantiateProviderTransport(definition, { db, providerVersion: 'fixture', getProviderConfig: () => ({ cwd: root }) });
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
    }
    t.after(async () => { await provider.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const argsForAgent = provider.options.argsForAgent;
    const template = [...provider._cliArgs];
    provider._runtimeRequest = null;
    provider._cliPath = process.execPath;
    provider.options.argsForAgent = agentId => [executable, ...(argsForAgent ? argsForAgent(agentId) : template)];
    provider._acpSdk = { ndJsonStream: () => ({}), client: () => ({ onRequest: () => ({ connectWith: (_stream, callback) => callback({}) }) }),
      methods: { agent: {}, client: { session: { requestPermission: 'permission' } } } };
    const rows = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
    const waitRows = async count => { const deadline = Date.now() + 5000;
      while (rows().length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.equal(rows().length, count); return rows()[count - 1]; };
    await provider._ensureAgent('agent');
    const restricted = await waitRows(1);
    const change = service.preflight('agent', transportId, { executionMode: 'native', ...(transportId === 'opencode-acp' ? { pluginMode: 'default' } : {}) });
    const committed = service.commit('agent', change.preflightToken, 'Policy Test');
    assert.equal(committed.lifecycleAction, 'restart_agent_runtime');
    assert.equal(provider.restartAgentRuntime('agent'), true);
    await provider._ensureAgent('agent');
    const native = await waitRows(2);
    assert.notDeepEqual(native, restricted);
    for (const flag of ['--deny-tool=read', '--permission-mode', '--tools', '--disallowed-tool', '--pure']) {
      assert.equal(native.args.includes(flag), false, flag);
    }
    if (transportId === 'opencode-acp') assert.equal(native.config, process.env.OPENCODE_CONFIG_CONTENT || null);
  });
}

// Legacy Node launchers must retain their entry script during version probes.
test('Copilot version probe retains the launcher prefix instead of reporting Node', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-copilot-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'cli.cjs');
  fs.writeFileSync(entry, "console.log('1.0.80');");
  const provider = instantiateProviderTransport(transports.find(x => x.id === 'github-copilot-cli'), {});
  provider._runtime = { command: process.execPath, prefixArgs: [entry] };
  provider._resolveRuntime = () => null;
  assert.equal(provider.getProviderVersion().version, '1.0.80');
});
