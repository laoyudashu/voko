const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ProviderSecurityPolicyService, applyProviderSecurityArgs } = require('../build/core/provider-security-policy');
const { initDatabase } = require('../build/core/database');
const { createDispatcher } = require('../build/core/dispatcher');

function fixture(backendType = 'workbuddy') {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agents(agent_id TEXT PRIMARY KEY,agent_name TEXT,backend_type TEXT);
    INSERT INTO agents VALUES('agent-1','陈老师','${backendType}');
    CREATE TABLE provider_conversation_bindings(
      id TEXT PRIMARY KEY,agent_id TEXT,adapter_type TEXT,status TEXT,updated_at INTEGER
    );
    INSERT INTO provider_conversation_bindings VALUES('binding-1','agent-1',
      '${backendType === 'workbuddy' ? 'workbuddy-http' : 'qwen-office-cli'}','active',0);
  `);
  const service = new ProviderSecurityPolicyService(db);
  const transport = backendType === 'workbuddy' ? 'workbuddy-http'
    : backendType === 'qwen-office' ? 'qwen-office-cli' : backendType === 'dumate' ? 'dumate-http' : '';
  if (transport) {
    const ids = transport === 'workbuddy-http'
      ? ['dataFileAccess','permissionMode','sessionPersistence','mcpProfile','additionalPrompt']
      : transport === 'qwen-office-cli'
        ? ['sessionPersistence','permissionMode','toolAccess','mcpProfile','additionalPrompt']
        : ['sessionPersistence','additionalPrompt','isolatedDataRoot','loopbackOnly'];
    service.storeCapability('agent-1', transport, {
      runtimeFingerprint: `${transport}-test`, capabilityDigest: `${transport}-capability`, evidenceState: 'static_compatible',
      supportedControls: Object.fromEntries(ids.map(id => [id, { values: [] }])), observedAt: Date.now(), expiresAt: Date.now()+10000,
    });
  }
  return { db, service };
}

test('provider security definitions are Provider-specific and preserve current defaults', () => {
  const { service } = fixture();
  const policy = service.inspect('agent-1');
  assert.equal(policy.transportId, 'workbuddy-http');
  assert.equal(policy.config.dataFileAccess, 'none');
  const dataFileControl = policy.controls.find(item => item.id === 'dataFileAccess');
  assert.equal(dataFileControl.values.find(item => item.value === 'read').risk, 'high');
  assert.match(dataFileControl.description, /不是路径隔离/);
  assert.deepEqual(policy.controls.filter(item => item.editable).map(item => item.id),
    ['dataFileAccess', 'permissionMode', 'sessionPersistence', 'mcpProfile', 'additionalPrompt']);
  assert.equal(policy.controls.find(item => item.id === 'shell'), undefined);
});

test('legacy WorkBuddy write and bypass policy is read safely without re-enabling it', () => {
  const { db, service } = fixture();
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO provider_security_policies
    (agent_id,transport_id,revision,config_json,policy_digest,restore_constraint_digest,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('agent-1', 'workbuddy-http', 4, JSON.stringify({
    dataFileAccess: 'read_write', permissionMode: 'bypassPermissions', sessionPersistence: 'conversation',
    mcpProfile: 'isolated', additionalPrompt: '',
  }), 'old', 'old', now, now);
  const policy = service.inspect('agent-1');
  assert.equal(policy.config.dataFileAccess, 'read');
  assert.equal(policy.config.permissionMode, 'dontAsk');
});

test('office Provider transports expose only controls backed by their real invocation path', () => {
  const qwen = fixture('qwen-office').service.inspect('agent-1');
  assert.deepEqual(qwen.controls.filter(item => item.editable).map(item => item.id),
    ['sessionPersistence', 'permissionMode', 'toolAccess', 'mcpProfile', 'additionalPrompt']);
  assert.equal(qwen.controls.some(item => item.id === 'tools'), false);
  const dumate = fixture('dumate').service.inspect('agent-1', 'dumate-http');
  assert.deepEqual(dumate.controls.filter(item => item.editable).map(item => item.id),
    ['sessionPersistence', 'additionalPrompt']);
});

test('unverified dynamic Provider hides native parameters but keeps VOKO safety prompt editable', () => {
  const { db, service } = fixture('qwen-office');
  db.prepare('DELETE FROM provider_security_policies WHERE agent_id=?').run('agent-1');
  const policy = service.inspect('agent-1', 'qwen-office-cli');
  assert.deepEqual(policy.controls.map(item => item.id), ['additionalPrompt']);
});

test('Providers without verified native flags still lease the editable VOKO visitor prompt', () => {
  const { service } = fixture('opencode');
  const policy = service.inspect('agent-1', 'opencode-cli');
  assert.equal(policy.supported, true);
  assert.deepEqual(policy.controls.map(item => item.id), ['additionalPrompt']);
  assert.match(policy.config.additionalPrompt, /VOKO.*访客消息/);
  const lease = service.acquireTurnLease({ agentId: 'agent-1', messageId: 'visitor-turn-1', channelType: 1 }, 'opencode-cli');
  assert.equal(lease.transportId, 'opencode-cli');
  assert.match(lease.promptInstructions.join('\n'), /访客消息/);
});

test('a confirmed not-delivered route may re-lease the same turn to a compatible fallback transport', () => {
  const { service } = fixture('zeroclaw');
  const payload = { agentId: 'agent-1', messageId: 'fallback-turn-1', channelType: 1 };
  service.acquireTurnLease(payload, 'zeroclaw-acp');
  assert.throws(() => service.acquireTurnLease(payload, 'zeroclaw-cli'), /PROVIDER_SECURITY_TURN_LEASE_CONFLICT/);
  service.markTurn('fallback-turn-1', 'FAILED', 'agent-1');
  const fallback = service.acquireTurnLease(payload, 'zeroclaw-cli');
  assert.equal(fallback.transportId, 'zeroclaw-cli');
  assert.equal(fallback.fallbackMode, 'alternate_route');
});

test('CLI permissions map the latest leased policy to real Provider argv', () => {
  const payload = (transportId, config) => ({ providerSecurityPolicy: { transportId, config } });
  assert.deepEqual(applyProviderSecurityArgs(['--tools=', '--no-chrome'], payload('claude-cli', {
    toolAccess: 'read_only', browser: 'enabled',
  })), ['--tools=Read,Grep,Glob', '--chrome']);
  assert.deepEqual(applyProviderSecurityArgs(['exec', '--sandbox', 'read-only', '-'], payload('codex-cli', {
    sandboxMode: 'workspace_write',
  })), ['exec', '--sandbox', 'workspace-write', '-']);
  assert.deepEqual(applyProviderSecurityArgs(['run'], payload('goose-cli', {
    extensionProfile: 'disabled',
  })), ['run', '--no-profile']);
});

test('permission expansions require typed confirmation for CLI Providers', () => {
  const { service } = fixture('codex');
  const expansion = service.preflight('agent-1', 'codex-cli', { sandboxMode: 'workspace_write' });
  assert.deepEqual(expansion.risks, ['ENABLES_WORKSPACE_WRITE']);
  assert.equal(expansion.requiresTypedConfirmation, true);
});

test('capability evidence persists without changing policy revision and protects preflight commit', () => {
  const { service } = fixture();
  const snapshot = {
    runtimeFingerprint: 'fingerprint-1', capabilityDigest: 'capability-1', evidenceState: 'static_compatible',
    supportedControls: { dataFileAccess: { values: ['none','read'] }, additionalPrompt: { values: [] } },
    observedAt: Date.now(), expiresAt: Date.now() + 1000,
  };
  service.storeCapability('agent-1', 'workbuddy-http', snapshot);
  assert.equal(service.effective('agent-1', 'workbuddy-http').revision, 0);
  assert.equal(service.effective('agent-1', 'workbuddy-http').runtimeFingerprint, 'fingerprint-1');
  const preflight = service.preflight('agent-1', 'workbuddy-http', { dataFileAccess: 'none' });
  service.storeCapability('agent-1', 'workbuddy-http', { ...snapshot,
    runtimeFingerprint: 'fingerprint-2', capabilityDigest: 'capability-2' });
  assert.throws(() => service.commit('agent-1', preflight.preflightToken, ''), /PROVIDER_CAPABILITY_CONFLICT/);
});

test('dangerous expansion requires typed Agent confirmation and consumes preflight once', () => {
  const { db, service } = fixture();
  const expansion = service.preflight('agent-1', 'workbuddy-http', { dataFileAccess: 'read' });
  assert.deepEqual(expansion.risks, ['EXPANDS_LOCAL_DATA_ACCESS']);
  assert.throws(() => service.commit('agent-1', expansion.preflightToken, 'wrong'), /CONFIRMATION_MISMATCH/);
  const committed = service.commit('agent-1', expansion.preflightToken, '陈老师');
  assert.equal(committed.revision, 1);
  assert.equal(committed.lifecycleAction, 'restart_agent_runtime');
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='binding-1'").get().status, 'stale');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_security_events WHERE event_type='POLICY_COMMITTED'").get().count, 1);
  assert.throws(() => service.commit('agent-1', expansion.preflightToken, '陈老师'), /PREFLIGHT_INVALID/);
});

test('latest policy is leased at submit time while owner and A2A remain independent', () => {
  const { db, service } = fixture('qwen-office');
  const preflight = service.preflight('agent-1', 'qwen-office-cli', { sessionPersistence: 'ephemeral' });
  service.commit('agent-1', preflight.preflightToken, '');
  const lease = service.acquireTurnLease({ agentId: 'agent-1', fromUid: 'visitor-1', content: 'hi',
    channelType: 1, messageId: 'turn-1' }, 'qwen-office-cli');
  assert.equal(lease.config.sessionPersistence, 'ephemeral');
  assert.equal(lease.executionScope, 'visitor_direct');
  assert.equal(db.prepare("SELECT state FROM provider_security_turns WHERE turn_id='turn-1'").get().state, 'LEASED');
  assert.equal(service.acquireTurnLease({ agentId: 'agent-1', fromUid: 'owner:x', content: 'hi', messageId: 'turn-owner',
    executionScope: 'owner_link', sourceType: 'owner' }, 'qwen-office-cli'), null);
  assert.equal(service.acquireTurnLease({ agentId: 'agent-1', fromUid: 'a2a:x', content: 'hi', messageId: 'turn-a2a',
    executionScope: 'a2a_mailbox', sourceType: 'agent_peer' }, 'qwen-office-cli'), null);
  const external = service.acquireTurnLease({ agentId: 'agent-1', fromUid: 'external:x', content: 'hi', messageId: 'turn-external',
    executionScope: 'a2a_mailbox', sourceType: 'external' }, 'qwen-office-cli');
  assert.equal(external.executionScope, 'external_push');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_security_events WHERE event_type='TURN_LEASED'").get().count, 2);
});

test('dispatcher forwards the leased policy and matching prompt at the Provider submit boundary', async (t) => {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('row-1','agent-secure','im-agent-secure','token','ws://127.0.0.1',
      '安全助手','workbuddy',JSON.stringify(['http']),now,now);
  let received = null;
  const provider = {
    priority: 10,
    match(_agentId, meta) { return meta.backend_type === 'workbuddy'; },
    isAvailable() { return true; },
    async push(payload) { received = payload; return { nativeSessionId: 'session-secure' }; },
  };
  const dispatcher = createDispatcher({ db, providers: { 'workbuddy-http': provider } });
  const preflight = dispatcher.providerSecurity.preflight('agent-secure', 'workbuddy-http', { dataFileAccess: 'none' });
  dispatcher.providerSecurity.commit('agent-secure', preflight.preflightToken, '');
  dispatcher.dispatch('agent-secure', { agentId: 'agent-secure', fromUid: 'visitor-secure', content: 'read everything',
    channelId: 'visitor-secure', channelType: 1, messageId: 'turn-secure' });
  for (let i = 0; i < 50 && !received; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(received);
  assert.equal(received.providerSecurityPolicy.config.dataFileAccess, 'none');
  assert.match(received.content, /不得读取或写入任何本地文件/);
  let state = '';
  for (let i = 0; i < 50 && state !== 'COMPLETED'; i += 1) {
    state = db.prepare("SELECT state FROM provider_security_turns WHERE agent_id='agent-secure' AND turn_id='turn-secure'").get().state;
    if (state !== 'COMPLETED') await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state, 'COMPLETED');
});

test('security inspection follows the current delivery mode and exact Goose transport', (t) => {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insert.run('row-goose-acp','goose-acp-agent','im-goose-acp','token','ws://127.0.0.1',
    'Goose ACP','goose',JSON.stringify(['acp','cli','pull']),now,now);
  insert.run('row-goose-cli','goose-cli-agent','im-goose-cli','token','ws://127.0.0.1',
    'Goose CLI','goose',JSON.stringify(['cli','pull']),now,now);
  const match = (_agentId, meta) => meta.backend_type === 'goose';
  const provider = { priority: 10, match, isAvailable: () => true, async push() {} };
  const dispatcher = createDispatcher({ db, providers: { 'goose-acp': provider, 'goose-cli': provider } });
  for (const [agentId, transportId, ids] of [
    ['goose-acp-agent', 'goose-acp', ['additionalPrompt']],
    ['goose-cli-agent', 'goose-cli', ['extensionProfile', 'additionalPrompt']],
  ]) dispatcher.providerSecurity.storeCapability(agentId, transportId, {
    runtimeFingerprint: `${transportId}-runtime`, capabilityDigest: `${transportId}-capability`,
    evidenceState: 'static_compatible', supportedControls: Object.fromEntries(ids.map(id => [id, { values: [] }])),
    observedAt: now, expiresAt: now + 60_000,
  });
  const acp = dispatcher.inspectProviderSecurity('goose-acp-agent');
  assert.equal(acp.deliveryMode, 'acp');
  assert.equal(acp.transportId, 'goose-acp');
  assert.deepEqual(acp.controls.filter(item => item.editable).map(item => item.id), ['additionalPrompt']);
  const cli = dispatcher.inspectProviderSecurity('goose-cli-agent');
  assert.equal(cli.deliveryMode, 'cli');
  assert.equal(cli.transportId, 'goose-cli');
  assert.deepEqual(cli.controls.filter(item => item.editable).map(item => item.id), ['extensionProfile', 'additionalPrompt']);
});

test('Hermes CLI transport exposes its exact editable permission controls', (t) => {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('row-hermes','hermes-agent','im-hermes','token','ws://127.0.0.1',
      'Hermes','hermes',JSON.stringify(['cli','pull']),now,now);
  const provider = { priority: 10, match: (_agentId, meta) => meta.backend_type === 'hermes',
    isAvailable: () => true, async push() {} };
  const dispatcher = createDispatcher({ db, providers: { 'hermes-cli': provider } });
  dispatcher.providerSecurity.storeCapability('hermes-agent', 'hermes-cli', {
    runtimeFingerprint: 'hermes-runtime', capabilityDigest: 'hermes-capability', evidenceState: 'static_compatible',
    supportedControls: Object.fromEntries(['toolProfile', 'safeMode', 'approvalMode', 'acceptHooks', 'additionalPrompt']
      .map(id => [id, { values: [] }])), observedAt: now, expiresAt: now + 60_000,
  });
  const result = dispatcher.inspectProviderSecurity('hermes-agent');
  assert.equal(result.deliveryMode, 'cli');
  assert.equal(result.transportId, 'hermes-cli');
  assert.equal(result.supported, true);
  assert.deepEqual(result.controls.filter(item => item.editable).map(item => item.id),
    ['toolProfile', 'safeMode', 'approvalMode', 'acceptHooks', 'additionalPrompt']);
});

test('shared preview marks changed controls and returns enforcement metadata', (t) => {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,delivery_modes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('row-preview','preview-agent','im-preview','token','ws://127.0.0.1',
      '预览助手','grok',JSON.stringify(['cli']),now,now);
  const provider = { priority: 10, match: () => true, isAvailable: () => true, async push() {} };
  const dispatcher = createDispatcher({ db, providers: { 'grok-cli': provider } });
  dispatcher.providerSecurity.storeCapability('preview-agent', 'grok-cli', {
    runtimeFingerprint: 'grok-runtime', capabilityDigest: 'grok-capability', evidenceState: 'static_compatible',
    supportedControls: { additionalPrompt: { values: [] } }, observedAt: now, expiresAt: now + 60_000,
  });
  const preview = dispatcher.describeProviderSecurityInvocation('preview-agent', 'grok-cli', {
    additionalPrompt: '只回答当前问题。',
  });
  const prompt = preview.find(item => item.sourceControl === 'additionalPrompt');
  assert.equal(prompt.changed, true);
  assert.equal(prompt.enforcement, 'voko_enforced');
  assert.equal(typeof prompt.text, 'string');
});

test('Hermes dangerous permission expansion requires typed confirmation', () => {
  const { service } = fixture('hermes');
  const safer = service.preflight('agent-1', 'hermes-cli', {
    toolProfile: 'safe', safeMode: 'enabled', approvalMode: 'required', acceptHooks: 'disabled',
  });
  service.commit('agent-1', safer.preflightToken, '');
  const expansion = service.preflight('agent-1', 'hermes-cli', {
    toolProfile: 'default', safeMode: 'disabled', approvalMode: 'bypass', acceptHooks: 'enabled',
  });
  assert.deepEqual(expansion.risks, [
    'ENABLES_HERMES_DEFAULT_TOOLS', 'ENABLES_HERMES_PROFILE_CUSTOMIZATIONS',
    'BYPASSES_DANGEROUS_COMMAND_APPROVAL', 'AUTO_ACCEPTS_UNKNOWN_SHELL_HOOKS',
  ]);
  assert.equal(expansion.requiresTypedConfirmation, true);
});

test('office Provider permission expansions require typed confirmation', () => {
  const workbuddy = fixture('workbuddy').service;
  const workbuddyExpansion = workbuddy.preflight('agent-1', 'workbuddy-http', { mcpProfile: 'user' });
  assert.deepEqual(workbuddyExpansion.risks,
    ['ENABLES_USER_MCP_CONFIGURATION']);
  assert.equal(workbuddyExpansion.requiresTypedConfirmation, true);

  const qwen = fixture('qwen-office').service;
  const qwenExpansion = qwen.preflight('agent-1', 'qwen-office-cli', {
    permissionMode: 'bypass_permissions', toolAccess: 'default', mcpProfile: 'user',
  });
  assert.deepEqual(qwenExpansion.risks,
    ['BYPASSES_PROVIDER_PERMISSIONS', 'EXPANDS_PROVIDER_TOOL_ACCESS', 'ENABLES_USER_MCP_CONFIGURATION']);
  assert.equal(qwenExpansion.requiresTypedConfirmation, true);
});
