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
  sortProviderDisplay,
} = require('../build/core/registration-orchestrator');
const { runWithRegistrationCaller } = require('../build/core/registration-caller-context');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)').run(
    'agent_backend_types',
    JSON.stringify([
      { value: 'openclaw', label: 'OpenClaw' },
      { value: 'codex', label: 'Codex' },
      { value: 'workbuddy', label: 'WorkBuddy' },
      { value: 'hermes', label: 'Hermes' },
      { value: 'qwen-office', label: 'Qwen Office' },
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
  it('sorts detected providers by the shared display priority and stable unknown labels', () => {
    const providers = [
      { type: 'unknown-z', label: 'Beta' }, { type: 'codex', label: 'Codex' },
      { type: 'hermes', label: 'Hermes' }, { type: 'unknown-a', label: 'Alpha' },
      { type: 'openclaw', label: 'OpenClaw' }, { type: 'workbuddy', label: 'WorkBuddy' },
      { type: 'claude-code', label: 'Claude Code' }, { type: 'github-copilot', label: 'Copilot' },
      { type: 'qwen-office', label: '千问办公' }, { type: 'dumate', label: '百度搭子' },
      { type: 'doubao', label: '豆包办公' }, { type: 'deepseek-harness', label: 'DeepSeek Harness' },
    ];
    assert.deepEqual(sortProviderDisplay(providers).map((item) => item.type), [
      'workbuddy', 'qwen-office', 'dumate', 'doubao', 'openclaw', 'hermes', 'claude-code', 'codex',
      'deepseek-harness', 'github-copilot', 'unknown-a', 'unknown-z',
    ]);
    assert.deepEqual(sortProviderDisplay([
      { type: 'trae', label: 'Trae' }, { type: 'workbuddy', label: 'WorkBuddy' }, { type: 'cursor', label: 'Cursor' },
    ]).map((item) => item.type), ['workbuddy', 'cursor', 'trae']);
    assert.deepEqual(sortProviderDisplay([
      { type: 'unknown-b', label: 'Same' }, { type: 'unknown-a', label: 'Same' },
    ]).map((item) => item.type), ['unknown-a', 'unknown-b']);
  });

  it('configures Goose CLI Push and ACP-to-CLI fallback in delivery order', () => {
    const service = new RegistrationOrchestrator({ commandAvailable: (command) => command === 'goose' });
    assert.deepEqual(service.deliveryCapabilities('goose').map((item) => item.mode), ['cli', 'pull']);
    assert.deepEqual(service.deliveryCapabilities('acp-goose').map((item) => item.mode), ['acp', 'cli', 'pull']);
    assert.equal(service.deliveryCapabilities('goose')[0].status, 'ready');
  });

  it('uses the nearest recognized Agent in the process ancestry', () => {
    assert.strictEqual(currentAgentTypeFromProcessRows([
      'powershell.exe node build/index.js',
      'claude.exe claude -p prompt',
      'codex.exe app-server',
    ]), 'claude-code');
    assert.strictEqual(currentAgentTypeFromProcessRows(['WorkBuddy.exe --mcp']), 'workbuddy');
    assert.strictEqual(currentAgentTypeFromProcessRows(['D:\\Program Files\\WorkBuddy\\resources\\cli\\codebuddy --serve']), 'workbuddy');
    assert.strictEqual(currentAgentTypeFromProcessRows(['codebuddy.exe --acp']), 'codebuddy');
    assert.strictEqual(currentAgentTypeFromProcessRows(['Doubao.exe agent']), 'doubao');
    assert.strictEqual(currentAgentTypeFromProcessRows(['zcode.exe mcp']), 'zcode');
    assert.strictEqual(currentAgentTypeFromProcessRows(['QwenWorkCN.exe --background']), 'qwen-office');
    assert.strictEqual(currentAgentTypeFromProcessRows(['Trae.exe --extensions-dir C:\\tmp']), 'trae');
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
    assert.strictEqual(
      currentAgentTypeFromEnvironment({ VOKO_CALLER_PROVIDER: 'codex' }, '/tmp'),
      'codex',
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
      detectCurrentAgentType: () => null,
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

  it('detects ZeroClaw aliases and binds the selected instance during registration', () => {
    const service = new RegistrationOrchestrator({
      getLoggedEmail: () => 'owner@example.com',
      commandAvailable: (command) => command === 'zeroclaw',
      zeroclawInstances: () => [
        { id: 'voko_test', name: 'VOKO Linux test', isDefault: false },
        { id: 'research', name: 'Research', isDefault: false },
      ],
    });
    const environment = service.inspectEnvironment();
    const provider = environment.detected.find((item) => item.type === 'zeroclaw');
    assert.ok(provider);
    assert.deepStrictEqual(provider.instances.map((item) => item.id), ['voko_test', 'research']);
    assert.strictEqual(provider.supportsMultipleInstances, true);

    const selected = runWithRegistrationCaller(
      { source: 'web' },
      () => service.start({ email: 'owner@example.com' }),
    );
    return Promise.resolve(selected).then((started) => {
      const chosen = service.selectProvider(started.registrationId, {
        providerType: 'zeroclaw',
        instanceId: 'voko_test',
      });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'ZeroClaw test' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(chosen.provider.instanceId, 'voko_test');
      assert.strictEqual(chosen.provider.instanceName, 'VOKO Linux test');
    });
  });

  it('detects desktop Agents and exposes unavailable WorkBuddy HTTP before Pull', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: () => false,
      installedApplications: () => ['ZCode 3.5.3', 'WorkBuddy 5.2.6', '豆包 2.19.9'],
      // 隔离真实运行环境：明确声明当前进程不是任何已知 agent，验证 instances 为空的基线行为
      detectCurrentAgentType: () => null,
      workBuddyRuntime: () => ({ command: null }),
    });
    const environment = service.inspectEnvironment();
    for (const type of ['zcode', 'workbuddy', 'doubao']) {
      const provider = environment.detected.find((item) => item.type === type);
      assert.ok(provider, type + ' should be detected');
      assert.strictEqual(provider.supportsMultipleInstances, false);
      assert.deepStrictEqual(provider.instances, []);
      const expected = type === 'workbuddy' ? ['http', 'pull'] : ['pull'];
      assert.deepStrictEqual(provider.deliveryModes.map((mode) => mode.mode), expected);
      assert.strictEqual(provider.deliveryModes.at(-1).required, true);
      if (type === 'workbuddy') assert.strictEqual(provider.deliveryModes[0].status, 'unavailable');
    }
  });

  it('exposes WorkBuddy HTTP before Pull when the bundled CLI is available', () => {
    const service = new RegistrationOrchestrator({
      workBuddyRuntime: () => ({ command: 'codebuddy', source: 'registry' }),
    });
    const modes = service.deliveryCapabilities('workbuddy');
    assert.deepStrictEqual(modes.map((mode) => mode.mode), ['http', 'pull']);
    assert.strictEqual(modes[0].status, 'preflight_passed');
    assert.strictEqual(modes[0].selected, true);
    assert.strictEqual(modes[1].required, true);
  });

  it('detects Qwen Office and Trae desktop installs while keeping headless readiness separate', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: () => false,
      qwenOfficeRuntimeAvailable: () => false,
      qwenOfficeAgents: () => [],
      traeCliAvailable: () => false,
      installedApplications: () => ['千问办公 0.1.6', 'Trae (User) 3.5.81'],
      detectCurrentAgentType: () => null,
    });
    const environment = service.inspectEnvironment();
    for (const type of ['qwen-office', 'trae']) {
      const provider = environment.detected.find((item) => item.type === type);
      assert.ok(provider, `${type} should be detected from the installed-app inventory`);
      assert.deepEqual(provider.instances, []);
      assert.deepEqual(provider.deliveryModes.map((mode) => mode.mode), type === 'trae' ? ['acp', 'pull'] : ['cli', 'pull']);
      assert.equal(provider.deliveryModes.at(-1).selected, true);
      assert.equal(provider.deliveryModes[0].status, 'unavailable');
    }
    assert.deepEqual(service.deliveryCapabilities('trae').map((mode) => mode.mode), ['acp', 'pull']);
    assert.deepEqual(service.deliveryCapabilities('qwen-office').map((mode) => mode.mode), ['cli', 'pull']);
  });

  it('marks Qwen Office CLI and Trae ACP ready when their runtimes are available', () => {
    const service = new RegistrationOrchestrator({
      qwenOfficeRuntimeAvailable: () => true,
      qwenOfficeAgents: () => [],
      traeCliAvailable: () => true,
    });
    assert.deepEqual(service.deliveryCapabilities('qwen-office').map((mode) => mode.mode), ['cli', 'pull']);
    assert.deepEqual(service.deliveryCapabilities('trae').map((mode) => mode.mode), ['acp', 'pull']);
    assert.equal(service.deliveryCapabilities('qwen-office')[0].status, 'ready');
    assert.equal(service.deliveryCapabilities('trae')[0].status, 'ready');
  });

  it('discovers QwenWork expert kits and requires an exact selection when more than one is present', async () => {
    let agents = [
      { id: 'mt80hmwaywym3lje/health-rumor-crusher', name: '养生谣言粉碎机', description: '健康信息核查', available: true },
      { id: 'mt7zxd9zn555pwlu/tieban-shenshu', name: '铁板神数', description: '命理工具箱', available: true },
    ];
    const { db, service } = createService({
      qwenOfficeRuntimeAvailable: () => true,
      qwenOfficeAgents: () => agents,
    });
    try {
      const started = await service.start({ email: 'owner@example.com' });
      const detected = started.environment.detected.find((item) => item.type === 'qwen-office');
      assert.deepEqual(detected.instances.map((item) => item.id), agents.map((item) => item.id));
      assert.equal(detected.supportsMultipleInstances, true);
      assert.equal(service.selectProvider(started.registrationId, { providerType: 'qwen-office' }).success, false);
      const selected = service.selectProvider(started.registrationId, {
        providerType: 'qwen-office', instanceId: agents[1].id,
      });
      assert.equal(selected.provider.instanceId, agents[1].id);
      assert.equal(selected.suggestedBasicInfo.agentName, '铁板神数');
      service.setBasicInfo(started.registrationId, { agentName: '铁板神数' });
      agents = [];
      const stale = await service.complete(started.registrationId);
      assert.equal(stale.success, false);
      assert.match(stale.error, /已不存在.*清单无效.*不可用/);
    } finally {
      db.close();
    }
  });

  it('detects standalone CodeBuddy separately from WorkBuddy and exposes ACP before Pull', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: () => false,
      codeBuddyCliAvailable: () => true,
      workBuddyRuntime: () => ({ command: null }),
      installedApplications: () => ['WorkBuddy 5.3.11'],
      detectCurrentAgentType: () => null,
    });
    const environment = service.inspectEnvironment();
    assert.ok(environment.detected.some((item) => item.type === 'workbuddy'));
    assert.ok(environment.detected.some((item) => item.type === 'codebuddy'));
    assert.deepEqual(service.deliveryCapabilities('workbuddy').map((item) => item.mode), ['http', 'pull']);
    assert.deepEqual(service.deliveryCapabilities('codebuddy').map((item) => item.mode), ['acp', 'pull']);
    assert.equal(service.deliveryCapabilities('codebuddy')[0].status, 'ready');
  });

  it('injects a synthetic current instance when process_ancestry detects zcode (fixes instances:0 vs detected:true mismatch)', () => {
    const service = new RegistrationOrchestrator({
      commandAvailable: () => false,
      installedApplications: () => ['ZCode 3.5.3'],
      // 模拟在 zcode 内运行：process_ancestry 命中 zcode
      detectCurrentAgentType: () => 'zcode',
    });
    const environment = service.inspectEnvironment();
    const provider = environment.detected.find((item) => item.type === 'zcode');
    assert.ok(provider, 'zcode should be detected');
    assert.ok(provider.instances.length > 0, '应在命中当前 agent 时注入合成 instance，避免 instances:[] 与 detected:true 矛盾');
    assert.strictEqual(provider.instances[0].id, 'zcode');
    assert.strictEqual(provider.instances[0].source, 'process_ancestry');
    assert.strictEqual(provider.instances[0].isCurrent, true);
    assert.strictEqual(provider.detectedAsCurrent, true);
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
      assert.strictEqual(started.status, 'provider_selection_required');
      assert.strictEqual(started.nextAction.type, 'select_provider');

      const provider = service.selectProvider(started.registrationId, { providerType: 'others' });
      assert.strictEqual(provider.status, 'basic_info_required');

      const basic = service.setBasicInfo(started.registrationId, {
        agentName: 'Shared Agent',
        description: 'shared flow',
        category: 'general',
      });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.ok(basic.environment);
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
      qwenOfficeRuntimeAvailable: () => true,
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
      assert.strictEqual(verified.status, 'provider_selection_required');
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
        'provider_selection_required',
      );
      assert.strictEqual(
        clients[clients.length - 1].service.view(started[0].registrationId).status,
        'provider_selection_required',
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
        detected: [{ type: 'openclaw', label: 'OpenClaw', instances: [{ id: 'openclaw-test', name: 'OpenClaw Test' }], deliveryModes: [] }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 1 },
      });
      const started = await service.start({ registrationMode: 'agent' });
      assert.strictEqual(started.email, 'owner@example.com');
      assert.strictEqual(started.registrationMode, 'agent');

      const selected = service.selectProvider(started.registrationId, { providerType: 'openclaw', instanceId: 'openclaw-test' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Self Registering Agent' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'openclaw');
      assert.strictEqual(selected.success, true);
    } finally {
      db.close();
    }
  });

  it('keeps the current Agent type available in the unified provider-first flow', async () => {
    const { db, service } = createService({
      detectCurrentAgentType: () => 'codex',
      detectCurrentAgentInstance: () => null,
    });
    try {
      service.inspectEnvironment = () => ({
        detected: [{ type: 'codex', label: 'Codex', instances: [], deliveryModes: [] }],
        more: [],
        fallback: { type: 'others', label: 'Others', deliveryModes: [] },
        currentAgent: { type: 'codex', label: 'Codex', source: 'process_ancestry', confidence: 'high' },
        summary: { providerCount: 1, instanceCount: 1, deliveryModeCount: 0 },
      });
      const started = await service.start({ registrationMode: 'agent' });
      service.selectProvider(started.registrationId, { providerType: 'codex' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Current Codex' });
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
      service.selectProvider(started.registrationId, { providerType: 'openclaw', instanceId: 'main' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'Current OpenClaw' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'openclaw');
      assert.strictEqual(basic.provider.instanceId, 'main');
    } finally {
      db.close();
    }
  });

  it('lets WorkBuddy register when HTTP is unavailable and keeps Pull selected', async () => {
    const { db, service } = createService({
      detectCurrentAgentType: () => 'workbuddy',
      detectCurrentAgentInstance: () => null,
      workBuddyRuntime: () => ({ command: null }),
      workBuddyAgents: () => [],
    });
    try {
      const started = await service.start({ registrationMode: 'agent' });
      service.selectProvider(started.registrationId, { providerType: 'workbuddy' });
      const basic = service.setBasicInfo(started.registrationId, { agentName: 'WorkBuddy Agent' });
      assert.strictEqual(basic.status, 'delivery_selection_required');
      assert.strictEqual(basic.provider.type, 'workbuddy');
      assert.deepStrictEqual(basic.deliveryModes.map((mode) => mode.mode), ['http', 'pull']);
      assert.strictEqual(basic.deliveryModes[0].status, 'unavailable');
      assert.strictEqual(basic.deliveryModes[1].required, true);
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
      assert.strictEqual(status.status, 'provider_selection_required');
      assert.strictEqual(status.registrationMode, 'agent');
    } finally {
      db.close();
    }
  });

  it('rejects custom provider types and keeps Others as the explicit fallback', async () => {
    const { db, service } = createService();
    try {
      const started = await service.start({ email: 'owner@example.com' });
      const custom = service.selectProvider(started.registrationId, { providerType: 'work-buddy' });
      assert.strictEqual(custom.success, false);
      assert.match(custom.error, /Others/);
      const fallback = service.selectProvider(started.registrationId, { providerType: 'others' });
      assert.strictEqual(fallback.success, true);
    } finally {
      db.close();
    }
  });

  it('discovers WorkBuddy instances lazily and rejects stale instance bindings', async () => {
    let instances = [
      { id: 'english-vocab-coach', name: 'English Coach', description: 'Vocabulary', available: true },
      { id: 'tcm-consultant', name: 'TCM', description: 'Consultation', available: true },
    ];
    const { db, service } = createService({ workBuddyAgents: () => instances });
    try {
      db.prepare("UPDATE config SET data=? WHERE type='agent_backend_types'").run(JSON.stringify([
        { value: 'workbuddy', label: 'WorkBuddy' }, { value: 'others', label: 'Others' },
      ]));
      assert.deepEqual(service.discoverProviderInstances('workbuddy').instances, instances);
      const started = await service.start({ email: 'owner@example.com' });
      const invalid = service.selectProvider(started.registrationId, { providerType: 'workbuddy', instanceId: 'missing' });
      assert.strictEqual(invalid.success, false);
      const selected = service.selectProvider(started.registrationId, {
        providerType: 'workbuddy', instanceId: 'tcm-consultant',
      });
      assert.strictEqual(selected.provider.instanceId, 'tcm-consultant');
      service.setBasicInfo(started.registrationId, { agentName: 'Bound WorkBuddy' });
      instances = [];
      const stale = await service.complete(started.registrationId);
      assert.strictEqual(stale.success, false);
      assert.match(stale.error, /不存在或不可用/);
    } finally { db.close(); }
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
      asWeb(() => service.selectProvider(started.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' }));
      asWeb(() => service.setBasicInfo(started.registrationId, { agentName: 'OpenClaw Agent' }));

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
      asInteractiveCli(() => service.selectProvider(cliStarted.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' }));
      asInteractiveCli(() => service.setBasicInfo(cliStarted.registrationId, { agentName: 'Headless Agent' }));
      const cliPlan = asInteractiveCli(() => service.configureDelivery(cliStarted.registrationId, { mode: 'websocket' }));
      const cliApproved = asInteractiveCli(() => service.configureDelivery(cliStarted.registrationId, {
        mode: 'websocket', approved: true, approvalToken: cliPlan.approvalToken,
      }));
      assert.strictEqual(cliStarted.registrationMode, 'human');
      assert.strictEqual(cliApproved.taskId, 'task-approved');
      assert.strictEqual(setupCount, 2);

      const agentStarted = await service.start({ email: 'owner@example.com', registrationMode: 'agent' });
      service.selectProvider(agentStarted.registrationId, { providerType: 'openclaw', instanceId: 'instance-a' });
      service.setBasicInfo(agentStarted.registrationId, { agentName: 'Agent-managed' });
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
      service.selectProvider(started.registrationId, { providerType: 'others' });
      service.setBasicInfo(started.registrationId, { agentName: 'Pull Agent' });
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
    let received = null;
    const { db, service } = createService({
      qwenOfficeAgents: () => [],
      runLoopbackTest: async (request) => {
        calls++;
        received = request;
        return { success: true, challengeMatched: true, detail: request.challenge };
      },
    });
    try {
      const started = await service.start({ email: 'owner@example.com' });
      service.selectProvider(started.registrationId, { providerType: 'qwen-office' });
      service.setBasicInfo(started.registrationId, { agentName: 'Loopback Agent' });
      const denied = await service.loopbackTest(started.registrationId, { mode: 'cli', providerId: 'qwen-office-cli' });
      assert.strictEqual(denied.code, 'LOOPBACK_CONFIRMATION_REQUIRED');
      assert.strictEqual(calls, 0);
      const allowed = await service.loopbackTest(started.registrationId, { mode: 'cli', providerId: 'qwen-office-cli', acknowledgeCost: true });
      assert.strictEqual(allowed.status, 'loopback_verified');
      assert.strictEqual(calls, 1);
      assert.strictEqual(received.providerId, 'qwen-office-cli');
      assert.strictEqual(received.mode, 'cli');
    } finally {
      db.close();
    }
  });
});
