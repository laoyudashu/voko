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
  return { db, service: new ProviderSecurityPolicyService(db) };
}

test('provider security definitions are Provider-specific and preserve current defaults', () => {
  const { service } = fixture();
  const policy = service.inspect('agent-1');
  assert.equal(policy.transportId, 'workbuddy-http');
  assert.equal(policy.config.dataFileAccess, 'read_write');
  assert.deepEqual(policy.controls.filter(item => item.editable).map(item => item.id), ['dataFileAccess']);
  assert.equal(policy.controls.find(item => item.id === 'shell').enforcement, 'unsupported');
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

test('dangerous expansion requires typed Agent confirmation and consumes preflight once', () => {
  const { db, service } = fixture();
  const restrictive = service.preflight('agent-1', 'workbuddy-http', { dataFileAccess: 'none' });
  service.commit('agent-1', restrictive.preflightToken, '');
  const expansion = service.preflight('agent-1', 'workbuddy-http', { dataFileAccess: 'read' });
  assert.deepEqual(expansion.risks, ['EXPANDS_LOCAL_DATA_ACCESS']);
  assert.throws(() => service.commit('agent-1', expansion.preflightToken, 'wrong'), /CONFIRMATION_MISMATCH/);
  const committed = service.commit('agent-1', expansion.preflightToken, '陈老师');
  assert.equal(committed.revision, 2);
  assert.equal(committed.lifecycleAction, 'restart_agent_runtime');
  assert.equal(db.prepare("SELECT status FROM provider_conversation_bindings WHERE id='binding-1'").get().status, 'stale');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provider_security_events WHERE event_type='POLICY_COMMITTED'").get().count, 2);
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
  const acp = dispatcher.inspectProviderSecurity('goose-acp-agent');
  assert.equal(acp.deliveryMode, 'acp');
  assert.equal(acp.transportId, 'goose-acp');
  assert.equal(acp.controls.some(item => item.editable), false);
  const cli = dispatcher.inspectProviderSecurity('goose-cli-agent');
  assert.equal(cli.deliveryMode, 'cli');
  assert.equal(cli.transportId, 'goose-cli');
  assert.deepEqual(cli.controls.filter(item => item.editable).map(item => item.id), ['extensionProfile']);
});
