const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  RegistrationOrchestrator,
  detectCurrentAgentInstance,
  detectCurrentAgentType,
  currentAgentTypeFromEnvironment,
  currentAgentTypeFromProcessRows,
} = require('../build/core/registration-orchestrator');
const { runWithRegistrationCaller } = require('../build/core/registration-caller-context');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)').run(
    'agent_backend_types',
    JSON.stringify([
      { value: 'openclaw', label: 'OpenClaw' },
      { value: 'hermes', label: 'Hermes' },
      { value: 'others', label: 'Others' },
    ]),
    Date.now(),
  );
  return db;
}

function createService(overrides = {}) {
  const db = createDb();
  let createCount = 0;
  const service = new RegistrationOrchestrator({
    db,
    getLoggedEmail: () => 'owner@example.com',
    sendCode: async () => ({ success: true }),
    loginByCode: async () => ({ success: true }),
    completeAgent: async (params) => {
      createCount++;
      return { success: true, agentId: 'agent-created', agentName: params.agentName };
    },
    gatewaySetup: {
      checkGateway: (backend) => ({ backend, ready: false, detail: 'not configured' }),
      startSetup: () => ({ taskId: 'task-1' }),
      getTask: () => ({ logs: [], done: true, ok: true, error: null }),
    },
    detectCurrentAgentType: () => null,
    ...overrides,
  });
  return { db, service, getCreateCount: () => createCount };
}

describe('shared registration orchestrator', () => {
  it('uses the nearest recognized Agent in the process ancestry', () => {
    assert.strictEqual(currentAgentTypeFromProcessRows([
      'powershell.exe node build/index.js',
      'claude.exe claude -p prompt',
      'codex.exe app-server',
    ]), 'claude-code');
    assert.strictEqual(currentAgentTypeFromProcessRows(['WorkBuddy.exe --mcp']), 'workbuddy');
    assert.strictEqual(currentAgentTypeFromProcessRows(['Doubao.exe agent']), 'doubao');
    assert.strictEqual(currentAgentTypeFromProcessRows(['zcode.exe mcp']), 'zcode');
  });

  it('recognizes gateway-based Agents from safe execution markers', () => {
    assert.strictEqual(
      currentAgentTypeFromEnvironment({ OPENCLAW_CLI: '1' }, 'C:\\work'),
      'openclaw',
    );
    assert.strictEqual(
      currentAgentTypeFromEnvironment({}, 'C:\\Users\\owner\\.openclaw\\workspace-voko'),
      'openclaw',
    );
    assert.strictEqual(
      currentAgentTypeFromEnvironment({ HERMES_SESSION_ID: 'session-1' }, 'C:\\work'),
      'hermes',
    );
  });

  it('keeps forwarded MCP caller identities isolated across concurrent requests', async () => {
    const [openclaw, hermes] = await Promise.all([
      runWithRegistrationCaller(
        { providerType: 'openclaw', instanceId: 'voko' },
        async () => {
          await Promise.resolve();
          return [detectCurrentAgentType(), detectCurrentAgentInstance('openclaw')];
        },
      ),
      runWithRegistrationCaller(
        { providerType: 'hermes', instanceId: 'psychologist' },
        async () => {
          await Promise.resolve();
          return [detectCurrentAgentType(), detectCurrentAgentInstance('hermes')];
        },
      ),
    ]);
    assert.deepStrictEqual(openclaw, ['openclaw', 'voko']);
    assert.deepStrictEqual(hermes, ['hermes', 'psychologist']);
  });

  it('detects installed CLI providers without treating their sessions as selectable instances', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: (command) => ['goose', 'claude', 'codex'].includes(command),
    });
    const environment = service.inspectEnvironment();
    for (const type of ['goose', 'claude-code', 'codex']) {
      const provider = environment.detected.find((item) => item.type === type);
      assert.ok(provider, type + ' should be detected');
      assert.strictEqual(provider.supportsMultipleInstances, false);
      assert.deepStrictEqual(provider.instances, []);
      assert.ok(['active', 'recent', 'installed'].includes(provider.activityState));
    }
  });

  it('detects installed desktop-only Agents and exposes pull delivery only', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: () => false,
      installedApplications: () => ['ZCode 3.5.3', 'WorkBuddy 5.2.6', '豆包 2.19.9'],
    });
    const environment = service.inspectEnvironment();
    for (const type of ['zcode', 'workbuddy', 'doubao']) {
      const provider = environment.detected.find((item) => item.type === type);
      assert.ok(provider, type + ' should be detected');
      assert.strictEqual(provider.supportsMultipleInstances, false);
      assert.deepStrictEqual(provider.instances, []);
      assert.deepStrictEqual(provider.deliveryModes.map((mode) => mode.mode), ['pull']);
      assert.strictEqual(provider.deliveryModes[0].required, true);
    }
  });

  it('exposes OpenCode delivery in ACP, attach, CLI, pull order', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: (command) => command === 'opencode',
    });
    const modes = service.deliveryCapabilities('opencode');
    assert.deepStrictEqual(modes.map((mode) => mode.mode), ['acp', 'attach', 'cli', 'pull']);
    assert.deepStrictEqual(modes.map((mode) => mode.role), ['primary', 'fallback', 'fallback', 'final_fallback']);
    assert.ok(modes.slice(0, 3).every((mode) => mode.status === 'ready' && mode.selected));
    assert.strictEqual(modes[3].required, true);
  });

  it('exposes GitHub Copilot delivery in ACP, CLI, pull order', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: (command) => command === 'copilot',
    });
    const modes = service.deliveryCapabilities('github-copilot');
    assert.deepStrictEqual(modes.map((mode) => mode.mode), ['acp', 'cli', 'pull']);
    assert.deepStrictEqual(modes.map((mode) => mode.role), ['primary', 'fallback', 'final_fallback']);
    assert.ok(modes.slice(0, 2).every((mode) => mode.status === 'ready' && mode.selected));
    assert.strictEqual(modes[2].required, true);
  });

  it('logged-in Web/API flow and repeated completion are idempotent', async () => {
    const { db, service, getCreateCount } = createService();
    try {
      const started = await service.start({ email: 'owner@example.com' });
      assert.strictEqual(started.status, 'basic_info_required');
      assert.strictEqual(started.nextAction.type, 'submit_basic_info');

      const basic = service.setBasicInfo(started.registrationId, {
        agentName: 'Shared Agent',
        description: 'shared flow',
        category: 'general',
      });
      assert.strictEqual(basic.status, 'provider_selection_required');
      assert.ok(basic.environment);

      const provider = service.selectProvider(started.registrationId, { providerType: 'others' });
      assert.strictEqual(provider.status, 'delivery_selection_required');
      assert.deepStrictEqual(provider.deliveryModes.map((mode) => mode.mode), ['pull']);

      const delivery = service.selectDelivery(started.registrationId, { deliveryModes: [] });
      assert.strictEqual(delivery.status, 'ready_to_create');
      assert.strictEqual(delivery.deliveryModes[0].selected, true, 'pull must always remain selected');

      const completed = await service.complete(started.registrationId);
      assert.strictEqual(completed.status, 'created');
      assert.strictEqual(completed.result.accessMode, 'private');
      assert.strictEqual(completed.result.ownerEmail, 'owner@example.com');
      assert.strictEqual(completed.result.deliveryOrder[0].role, 'only');
      assert.match(completed.warnings[0].message, /提示词攻击/);

      const repeated = await service.complete(started.registrationId);
      assert.strictEqual(repeated.result.agentId, 'agent-created');
      assert.strictEqual(getCreateCount(), 1, 'complete must not create the Agent twice');
    } finally {
      db.close();
    }
  });

  it('Agent flow returns nextAction and verifies email before basic info', async () => {
    let sendCount = 0;
    let verifyCount = 0;
    const { db, service } = createService({
      getLoggedEmail: () => '',
      sendCode: async () => { sendCount++; return { success: true }; },
      loginByCode: async ({ code }) => {
        verifyCount++;
        return { success: code === '123456', error: 'bad code' };
      },
    });
    try {
      const started = await service.manage({ action: 'start', email: 'new@example.com' });
      assert.strictEqual(started.status, 'email_verification_required');
      assert.strictEqual(started.nextAction.type, 'submit_email_code');
      assert.strictEqual(sendCount, 1);

      const failed = await service.manage({
        action: 'verify_email', registrationId: started.registrationId, code: '000000',
      });
      assert.strictEqual(failed.success, false);

      const verified = await service.manage({
        action: 'verify_email', registrationId: started.registrationId, code: '123456',
      });
      assert.strictEqual(verified.status, 'basic_info_required');
      assert.strictEqual(verifyCount, 2);
    } finally {
      db.close();
    }
  });

  it('pauses safely instead of letting an Agent invent an email', async () => {
    const { db, service } = createService({ getLoggedEmail: () => '' });
    try {
      const result = await service.start({ registrationMode: 'agent' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'LOGIN_REQUIRED');
      assert.strictEqual(result.nextAction.type, 'request_owner_email');
      assert.strictEqual(result.nextAction.requiresUserInput, true);
      assert.strictEqual(result.nextAction.mustPause, true);
      assert.match(result.nextAction.instruction, /不得猜测、编造邮箱/);
    } finally {
      db.close();
    }
  });

  it('merges sessions created concurrently by independent database connections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-registration-'));
    const dbPath = path.join(dir, 'voko.db');
    const primaryDb = new DatabaseSync(dbPath);
    primaryDb.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)');
    const clients = Array.from({ length: 16 }, () => {
      const db = new DatabaseSync(dbPath);
      return {
        db,
        service: new RegistrationOrchestrator({ db, getLoggedEmail: () => 'owner@example.com' }),
      };
    });
    try {
      const started = await Promise.all(
        clients.map(({ service }) => service.start({ registrationMode: 'agent' })),
      );
      assert.strictEqual(new Set(started.map((item) => item.registrationId)).size, clients.length);

      const row = primaryDb.prepare('SELECT data FROM config WHERE type=?')
        .get('agent_registration_sessions');
      const stored = JSON.parse(row.data);
      for (const item of started) assert.ok(stored[item.registrationId]);
      assert.strictEqual(Object.keys(stored).length, clients.length);

      assert.strictEqual(
        clients[0].service.view(started[started.length - 1].registrationId).status,
        'basic_info_required',
      );
      assert.strictEqual(
        clients[clients.length - 1].service.view(started[0].registrationId).status,
        'basic_info_required',
      );
    } finally {
      for (const { db } of clients) db.close();
      primaryDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Agent mode reuses the logged-in email and locks a single detected provider', async () => {
    const { db, service } = createService();
    try {
      service.inspectEnvironment = () => ({
        detected: [{ type: 'openclaw', label: 'OpenClaw', instances: [], deliveryModes: [] }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 1 },
      });
      const started = await service.start({ registrationMode: 'agent' });
      assert.strictEqual(started.email, 'owner@example.com');
      assert.strictEqual(started.registrationMode, 'agent');

      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Self Registering Agent' });
      assert.deepStrictEqual(basic.providerLock, {
        type: 'openclaw',
        label: 'OpenClaw',
        source: 'local_environment',
        confidence: 'high',
      });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'openclaw');

      const mismatch = service.selectProvider(started.registrationId, { providerType: 'others' });
      assert.strictEqual(mismatch.success, false);
      assert.strictEqual(mismatch.providerLock.type, 'openclaw');
      const selected = service.selectProvider(started.registrationId, { providerType: 'openclaw' });
      assert.strictEqual(selected.success, true);
    } finally {
      db.close();
    }
  });

  it('prefers the current Agent type without running full-machine discovery', async () => {
    const { db, service } = createService({
      detectCurrentAgentType: () => 'codex',
      detectCurrentAgentInstance: () => null,
    });
    try {
      service.inspectEnvironment = () => { throw new Error('full discovery must not run'); };
      service.inspectCurrentAgent = (type) => ({
        detected: [{ type, label: 'Codex', instances: [], deliveryModes: [] }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        currentAgent: { type, label: 'Codex', source: 'process_ancestry', confidence: 'high' },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 0 },
      });
      const started = await service.start({ registrationMode: 'agent' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Current Codex' });
      assert.strictEqual(basic.providerLock.type, 'codex');
      assert.strictEqual(basic.providerLock.source, 'current_agent');
      assert.strictEqual(basic.environment.currentAgent.type, 'codex');
      assert.strictEqual(basic.status, 'delivery_selection_required');
    } finally {
      db.close();
    }
  });

  it('uses the detected current Provider instance without asking the Agent to choose again', async () => {
    const { db, service } = createService({
      detectCurrentAgentType: () => 'openclaw',
      detectCurrentAgentInstance: () => 'main',
    });
    try {
      service.inspectCurrentAgent = (type, instanceId) => ({
        detected: [{
          type,
          label: 'OpenClaw',
          instances: [{ id: instanceId, name: instanceId }],
          deliveryModes: [],
        }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        currentAgent: { type, instanceId },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 0 },
      });
      const started = await service.start({ registrationMode: 'agent' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Current OpenClaw' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'openclaw');
      assert.strictEqual(basic.provider.instanceId, 'main');
      assert.strictEqual(basic.providerLock.type, 'openclaw');
    } finally {
      db.close();
    }
  });

  it('lets a desktop-only Agent register through MCP with pull delivery', async () => {
    const { db, service } = createService({
      detectCurrentAgentType: () => 'workbuddy',
      detectCurrentAgentInstance: () => null,
    });
    try {
      const started = await service.start({ registrationMode: 'agent' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'WorkBuddy Agent' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'workbuddy');
      assert.deepStrictEqual(basic.deliveryModes.map((mode) => mode.mode), ['pull']);
      assert.strictEqual(basic.deliveryModes[0].required, true);
    } finally {
      db.close();
    }
  });

  it('restores an unfinished registration session from the database', async () => {
    const { db, service } = createService();
    try {
      const started = await service.start({ registrationMode: 'agent' });
      const restored = new RegistrationOrchestrator({
        db,
        getLoggedEmail: () => 'owner@example.com',
        detectCurrentAgentType: () => null,
      });
      const status = restored.view(started.registrationId);
      assert.strictEqual(status.status, 'basic_info_required');
      assert.strictEqual(status.registrationMode, 'agent');
    } finally {
      db.close();
    }
  });

  it('rejects custom provider types and keeps Others as the explicit fallback', async () => {
    const { db, service } = createService();
    try {
      const started = await service.start({ email: 'owner@example.com' });
      service.setBasicInfo(started.registrationId, { agentName: 'A' });
      const custom = service.selectProvider(started.registrationId, { providerType: 'work-buddy' });
      assert.strictEqual(custom.success, false);
      assert.match(custom.error, /Others/);
      const fallback = service.selectProvider(started.registrationId, { providerType: 'others' });
      assert.strictEqual(fallback.success, true);
    } finally {
      db.close();
    }
  });

  it('requires explicit approval before changing provider configuration', async () => {
    let setupCount = 0;
    const { db, service } = createService({
      gatewaySetup: {
        checkGateway: (backend) => ({ backend, ready: false, detail: 'not configured' }),
        startSetup: () => { setupCount++; return { taskId: 'task-approved' }; },
        getTask: () => ({ logs: [], done: true, ok: true, error: null }),
      },
    });
    try {
      const asWeb = (callback) => runWithRegistrationCaller({ source: 'web' }, callback);
      service.inspectEnvironment = () => ({
        detected: [{ type: 'openclaw', label: 'OpenClaw', instances: [
          { id: 'instance-a', name: 'A' }, { id: 'instance-b', name: 'B' },
        ], deliveryModes: [] }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 1 },
      });
      const started = await asWeb(() => service.start({ email: 'owner@example.com' }));
      asWeb(() => service.setBasicInfo(started.registrationId, { agentName: 'OpenClaw Agent' }));
      asWeb(() => service.selectProvider(started.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' }));

      const plan = asWeb(() => service.configureDelivery(started.registrationId, { mode: 'websocket' }));
      assert.strictEqual(plan.status, 'approval_required');
      assert.strictEqual(plan.changePlan.backup, true);
      assert.ok(plan.approvalToken);
      assert.strictEqual(setupCount, 0);

      const rejected = asWeb(() => service.configureDelivery(started.registrationId, {
        mode: 'websocket', approved: true, approvalToken: 'wrong-token',
      }));
      assert.strictEqual(rejected.success, false);
      assert.strictEqual(setupCount, 0);

      asWeb(() => service.selectProvider(started.registrationId, { providerType: 'openclaw', instanceId: 'instance-b' }));
      const switched = asWeb(() => service.configureDelivery(started.registrationId, {
        mode: 'websocket', approved: true, approvalToken: plan.approvalToken,
      }));
      assert.strictEqual(switched.success, false);
      assert.strictEqual(setupCount, 0);

      const currentPlan = asWeb(() => service.configureDelivery(started.registrationId, { mode: 'websocket' }));

      const remoteApproval = await runWithRegistrationCaller(
        { source: 'mcp', providerType: 'openclaw' },
        () => service.configureDelivery(started.registrationId, {
          mode: 'websocket', approved: true, approvalToken: currentPlan.approvalToken,
        }),
      );
      assert.strictEqual(remoteApproval.code, 'HUMAN_CONFIGURATION_REQUIRED');
      assert.strictEqual(setupCount, 0);

      const approved = asWeb(() => service.configureDelivery(started.registrationId, {
        mode: 'websocket',
        approved: true,
        approvalToken: currentPlan.approvalToken,
      }));
      assert.strictEqual(approved.taskId, 'task-approved');
      assert.strictEqual(setupCount, 1);

      const asInteractiveCli = (callback) => runWithRegistrationCaller({ source: 'cli_interactive' }, callback);
      const cliStarted = await asInteractiveCli(() => service.start({ email: 'owner@example.com' }));
      asInteractiveCli(() => service.setBasicInfo(cliStarted.registrationId, { agentName: 'Headless Agent' }));
      asInteractiveCli(() => service.selectProvider(cliStarted.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' }));
      const cliPlan = asInteractiveCli(() => service.configureDelivery(cliStarted.registrationId, { mode: 'websocket' }));
      const cliApproved = asInteractiveCli(() => service.configureDelivery(cliStarted.registrationId, {
        mode: 'websocket', approved: true, approvalToken: cliPlan.approvalToken,
      }));
      assert.strictEqual(cliStarted.registrationMode, 'human');
      assert.strictEqual(cliApproved.taskId, 'task-approved');
      assert.strictEqual(setupCount, 2);

      const agentStarted = await service.start({ email: 'owner@example.com', registrationMode: 'agent' });
      service.setBasicInfo(agentStarted.registrationId, { agentName: 'Agent-managed' });
      service.selectProvider(agentStarted.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' });
      const agentPlan = service.configureDelivery(agentStarted.registrationId, { mode: 'websocket' });
      const agentApproved = service.configureDelivery(agentStarted.registrationId, {
        mode: 'websocket', approved: true, approvalToken: agentPlan.approvalToken,
      });
      assert.strictEqual(agentApproved.code, 'HUMAN_CONFIGURATION_REQUIRED');
      assert.strictEqual(setupCount, 2);

      const spoofed = await runWithRegistrationCaller(
        { source: 'mcp', providerType: 'openclaw' },
        () => service.start({ email: 'owner@example.com', registrationMode: 'human' }),
      );
      assert.strictEqual(spoofed.registrationMode, 'agent');
    } finally {
      db.close();
    }
  });

  it('rejects attacker-controlled registration identifiers before session mutation', () => {
    const { db, service } = createService();
    try {
      for (const id of ['__proto__', 'constructor', 'reg_invalid', '']) {
        assert.throws(
          () => service.setBasicInfo(id, { agentName: 'Injected' }),
          (error) => error.code === 'REGISTRATION_SESSION_NOT_FOUND',
        );
      }
      assert.strictEqual(Object.prototype.agentName, undefined);
      assert.strictEqual(Object.prototype.status, undefined);
    } finally {
      db.close();
    }
  });

  it('keeps preflight side-effect free and reports Pull as the creation fallback', async () => {
    const { db, service } = createService();
    try {
      const started = await service.start({ email: 'owner@example.com' });
      service.setBasicInfo(started.registrationId, { agentName: 'Pull Agent' });
      service.selectProvider(started.registrationId, { providerType: 'others' });
      const preflight = service.preflightDelivery(started.registrationId, { mode: 'pull' });
      assert.strictEqual(preflight.success, true);
      assert.strictEqual(preflight.status, 'ready');
      assert.strictEqual(preflight.sideEffects, false);
      service.selectDelivery(started.registrationId, { deliveryModes: ['pull'] });
      const completed = await service.complete(started.registrationId, { accessMode: 'private' });
      assert.strictEqual(completed.result.creationStatus, 'created');
      assert.deepStrictEqual(completed.result.deliveryOrder.map((item) => item.mode), ['pull']);
      assert.deepStrictEqual(completed.result.deliveryReadiness.map((item) => item.status), ['ready']);
    } finally {
      db.close();
    }
  });

  it('never runs a model-backed loopback without explicit cost acknowledgement', async () => {
    let calls = 0;
    const { db, service } = createService({
      runLoopbackTest: async ({ challenge }) => {
        calls++;
        return { success: true, challengeMatched: true, detail: challenge };
      },
    });
    try {
      const started = await service.start({ email: 'owner@example.com' });
      service.setBasicInfo(started.registrationId, { agentName: 'Loopback Agent' });
      service.selectProvider(started.registrationId, { providerType: 'others' });
      const denied = await service.loopbackTest(started.registrationId, { mode: 'pull' });
      assert.strictEqual(denied.code, 'LOOPBACK_CONFIRMATION_REQUIRED');
      assert.strictEqual(calls, 0);
      const allowed = await service.loopbackTest(started.registrationId, { mode: 'pull', acknowledgeCost: true });
      assert.strictEqual(allowed.status, 'loopback_verified');
      assert.strictEqual(calls, 1);
    } finally {
      db.close();
    }
  });
});
