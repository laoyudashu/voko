const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

/**
 * CLI 端 Agent 注册测试（voko CLI 命令）。
 *
 * voko CLI 通过 runToolCommand() 桥接 MCP tool handler：
 *   kebab-case CLI 参数（--backend-type）→ camelCase handler 参数（backendType）
 *
 * 验证三端一致：CLI 入口同样接收并传递 backendType(required)/category(default general)/description(optional)。
 */

const { runToolCommand } = require('../build/cli');

/** mock core：spy 记录 handler 收到的参数 */
function createMockCore() {
  const calls = {};
  const agentRegistration = {
    sendCode: async (p) => { calls.sendCode = p; return { success: true }; },
    loginByCode: async (p) => { calls.loginByCode = p; return { success: true }; },
    verifyCodePreview: async (p) => { calls.verifyCodePreview = p; return { success: true, agents: [], userExists: false }; },
    verifyCode: async (p) => { calls.verifyCode = p; return { success: true, data: { agentId: 'cli-1', agents: [{ agentId: 'cli-1' }], imUid: 'u', imToken: 't', did: 'd', publicKey: 'pk', privateKey: 'sk' } }; },
    createAgentByToken: async (p) => { calls.createAgentByToken = p; return { success: true, data: { agentId: 'cli-1', imUid: 'u', imToken: 't', did: 'd', publicKey: 'pk', privateKey: 'sk' } }; },
    registerAgentInDb: async (p) => { calls.registerAgentInDb = p; return { success: true }; },
    updateAgentBinding: async (p) => { calls.updateAgentBinding = p; return { success: true }; },
  };
  const db = {
    prepare: (sql) => ({
      all: () => sql.includes("type='current_user_email'")
        ? [{ data: JSON.stringify('a@b.com') }]
        : (sql.includes("type='user_access_token'")
          ? [{ data: JSON.stringify({ 'a@b.com': { user_access_token: 'token', updated_at: 1 } }) }]
          : []),
      get: () => undefined,
      run: () => ({}),
    }),
  };
  const agentManager = { workers: new Map(), start: () => {}, stop: () => {}, getStatus: () => ({}) };
  const updateAgentProfile = async (p) => { calls.updateAgentProfile = p; return { success: true }; };
  return { db, databaseAPI: {}, agentRegistration, agentManager, updateAgentProfile, _calls: calls };
}

/** 捕获 runToolCommand 的 console.log 输出（结果 JSON） */
async function runCli(toolName, rawParams) {
  const core = createMockCore();
  const origLog = console.log;
  let captured = null;
  console.log = (s) => { captured = s; };
  try {
    const ret = await runToolCommand(toolName, rawParams, core);
    return { ret, out: captured, core };
  } finally {
    console.log = origLog;
  }
}

describe('CLI verify_agent_email 参数桥接', () => {
  it('旧入口仅返回迁移提示且不调用注册后端', async () => {
    const { out, core } = await runCli('verify_agent_email', { email: 'a@b.com', code: '123456' });
    const result = JSON.parse(out);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'REGISTRATION_API_REMOVED');
    assert.ok(!core._calls.verifyCode);
  });
});

describe('CLI identity commands do not require a preselected Agent', () => {
  it('allows whoami and list_agents without --agent', async () => {
    const who = await runCli('whoami', {});
    const list = await runCli('list_agents', {});
    assert.notEqual(JSON.parse(who.out).error, '缺少 agent 身份');
    assert.notEqual(JSON.parse(list.out).error, '缺少 agent 身份');
  });
});

describe('CLI manage_agent_registration state flow', () => {
  it('accepts the shared action and returns nextAction JSON', async () => {
    const { out, core } = await runCli('manage_agent_registration', {
      action: 'start',
      email: 'agent@example.com',
    });
    const result = JSON.parse(out);
    assert.strictEqual(result.success, true);
    assert.match(result.registrationId, /^reg_/);
    assert.strictEqual(result.nextAction.type, 'submit_email_code');
    assert.strictEqual(core._calls.sendCode.email, 'agent@example.com');
  });

  it('accepts a PowerShell-normalized delivery mode array', async () => {
    const { convertParam } = require('../build/cli');
    assert.deepStrictEqual(convertParam('[cli,pull]', 'json'), ['cli', 'pull']);
    assert.deepStrictEqual(convertParam('["cli","pull"]', 'json'), ['cli', 'pull']);
  });

  it('keeps extended profile and one-time binding parameters in the CLI bridge', () => {
    const source = require('node:fs').readFileSync(require.resolve('../build/cli'), 'utf8');
    assert.match(source, /manage_agent_registration:\s*\{[^\n]*tags: 'json'[^\n]*iconUrl: 'string'[^\n]*contactPhone: 'string'[^\n]*address: 'string'/);
    assert.match(source, /bind_agent_instance_once:\s*\{ agentId: 'string', backendInstanceId: 'string' \}/);
  });
});

describe('CLI create_agent_by_token 参数桥接', () => {
  it('完整字段经 CLI 写入本地并同步到服务端资料', async () => {
    const { out, core } = await runCli('create_agent_by_token', {
      email: 'a@b.com', agentName: 'Y',
      backendType: 'pi', category: 'service', description: '只读助手',
      tags: ['只读', 'CLI'], iconUrl: 'https://example.com/icon.png',
      contact_phone: '+86 13800000000', address: '中国·上海',
    });
    assert.strictEqual(JSON.parse(out).success, true);
    const reg = core._calls.registerAgentInDb;
    assert.ok(reg);
    assert.strictEqual(reg.backendType, 'pi');
    assert.strictEqual(reg.category, 'service');
    assert.strictEqual(reg.description, '只读助手');
    assert.deepStrictEqual(core._calls.updateAgentProfile, {
      agentId: 'cli-1', name: 'Y', description: '只读助手', category: 'service',
      tags: ['只读', 'CLI'], icon_url: 'https://example.com/icon.png',
      contact_phone: '+86 13800000000', address: '中国·上海', backendType: 'pi',
    });
  });

  it('缺 category → 默认 general', async () => {
    const { out, core } = await runCli('create_agent_by_token', {
      email: 'a@b.com', agentName: 'Y', backendType: 'codex',
    });
    const result = JSON.parse(out);
    assert.strictEqual(result.success, true);
    assert.strictEqual(core._calls.registerAgentInDb.category, 'general');
  });
});
