const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Agent 注册字段统一测试：
 *   1. registerAgentInDb 写入 description（含 ON CONFLICT 更新）
 *   2. MCP verify_agent_email / create_agent_by_token 的 backendType/category 必填校验
 *      （含预览模式不校验）
 *
 * 底层统一：所有注册路径汇入 registerAgentInDb()。
 */

// ── 内存 SQLite，手动建 agents 表（只建本次涉及的列）──
function createDb() {
  const dbPath = path.join(os.tmpdir(), `voko-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(dbPath);
  // 用完即删
  db._tmpPath = dbPath;
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      imUid TEXT NOT NULL,
      imToken TEXT NOT NULL,
      im_server_url TEXT NOT NULL,
      owner_email TEXT,
      agent_name TEXT,
      category TEXT,
      category_label TEXT,
      description TEXT,
      did TEXT,
      public_key TEXT,
      private_key TEXT,
      login_token TEXT,
      payment_fee_rate REAL,
      agent_usage_fee_rate REAL,
      publish_status TEXT NOT NULL DEFAULT 'unpublished',
      access_mode TEXT NOT NULL DEFAULT 'private',
      backend_type TEXT,
      backend_instance_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

function cleanupDb(db) {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(db._tmpPath); } catch (_) {}
}

const { registerAgentInDbOnDb } = require('../build/core/agent-registration');

// ════════════════════════════════════════════════════════════
//  registerAgentInDb：description 写入
// ════════════════════════════════════════════════════════════
describe('registerAgentInDb description 写入', () => {
  it('注册时传入 description，正确写入 agents 表', () => {
    const db = createDb();
    try {
      const r = registerAgentInDbOnDb(db, {
        agentId: 'agent-desc',
        uid: 'uid-1', token: 'tok-1', serverUrl: 'wss://im',
        ownerEmail: 'owner@test.com',
        backendType: 'codex',
        instanceId: 'codex_profile_test',
        agentName: '我的Codex助手',
        category: 'technology',
        description: '一个只读的代码分析助手',
        accessMode: 'public',
        did: 'did:web:x', publicKey: 'pk', privateKey: 'sk',
      });
      assert.strictEqual(r.success, true);

      const row = db.prepare('SELECT description, category, backend_type, backend_instance_id, agent_name, access_mode FROM agents WHERE agent_id=?').get('agent-desc');
      assert.strictEqual(row.description, '一个只读的代码分析助手');
      assert.strictEqual(row.category, 'technology');
      assert.strictEqual(row.backend_type, 'codex');
      assert.strictEqual(row.backend_instance_id, 'codex_profile_test');
      assert.strictEqual(row.agent_name, '我的Codex助手');
      assert.strictEqual(row.access_mode, 'public');
    } finally { cleanupDb(db); }
  });

  it('description 为空时写入 NULL（不报错）', () => {
    const db = createDb();
    try {
      const r = registerAgentInDbOnDb(db, {
        agentId: 'agent-nodesc',
        uid: 'uid-2', token: 'tok-2', serverUrl: 'wss://im',
        backendType: 'gemini', category: 'education',
      });
      assert.strictEqual(r.success, true);
      const row = db.prepare('SELECT description, access_mode FROM agents WHERE agent_id=?').get('agent-nodesc');
      assert.strictEqual(row.description, null);
      assert.strictEqual(row.access_mode, 'private');
    } finally { cleanupDb(db); }
  });

  it('注册时规范化 backendType，同时保留自定义类型', () => {
    const db = createDb();
    try {
      registerAgentInDbOnDb(db, {
        agentId: 'agent-normalized', uid: 'u1', token: 't1', serverUrl: 'wss://im',
        backendType: ' Claude_Code ',
      });
      registerAgentInDbOnDb(db, {
        agentId: 'agent-custom', uid: 'u2', token: 't2', serverUrl: 'wss://im',
        backendType: 'Work Buddy',
      });
      assert.strictEqual(db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get('agent-normalized').backend_type, 'claude-code');
      assert.strictEqual(db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get('agent-custom').backend_type, 'work-buddy');
    } finally { cleanupDb(db); }
  });

  it('重复注册同一 agent：ON CONFLICT 更新 description', () => {
    const db = createDb();
    try {
      // 首次：有 description
      registerAgentInDbOnDb(db, {
        agentId: 'agent-up', uid: 'u', token: 't', serverUrl: 'wss://im',
        backendType: 'codex', category: 'technology', description: '旧描述',
      });
      // 二次：换 description + backendType
      registerAgentInDbOnDb(db, {
        agentId: 'agent-up', uid: 'u2', token: 't2', serverUrl: 'wss://im',
        backendType: 'gemini', category: 'education', description: '新描述',
      });
      const row = db.prepare('SELECT description, backend_type, category, imUid FROM agents WHERE agent_id=?').get('agent-up');
      assert.strictEqual(row.description, '新描述', 'description 应被更新');
      assert.strictEqual(row.backend_type, 'gemini', 'backend_type 应被更新');
      assert.strictEqual(row.category, 'education', 'category 应被更新');
      assert.strictEqual(row.imUid, 'u2', 'imUid 应被更新');
    } finally { cleanupDb(db); }
  });
});

// ════════════════════════════════════════════════════════════
//  MCP handlers：必填校验
// ════════════════════════════════════════════════════════════
const { createToolHandlers } = require('../build/mcp/tools');

/** 构造 mock cx：spy 记录被调用的方法，断言校验是否在前置触发 */
function createMockCx() {
  const calls = { sendCode: 0, loginByCode: 0, verifyCode: 0, verifyCodePreview: 0, createAgentByToken: 0, registerAgentInDb: 0, updateAgentBinding: 0, startAgentWorker: 0 };
  return {
    _calls: calls,
    agentRegistration: {
      sendCode: async () => { calls.sendCode++; return { success: true }; },
      loginByCode: async () => { calls.loginByCode++; return { success: true }; },
      verifyCodePreview: async () => { calls.verifyCodePreview++; return { success: true, agents: [], userExists: false }; },
      verifyCode: async () => { calls.verifyCode++; return { success: true, data: { agentId: 'new-1', agents: [{ agentId: 'new-1' }], imUid: 'u', imToken: 't', did: 'd', publicKey: 'pk', privateKey: 'sk' } }; },
      createAgentByToken: async () => { calls.createAgentByToken++; return { success: true, data: { agentId: 'new-1', imUid: 'u', imToken: 't', did: 'd', publicKey: 'pk', privateKey: 'sk' } }; },
      registerAgentInDb: async () => { calls.registerAgentInDb++; return { success: true }; },
      updateAgentBinding: async () => { calls.updateAgentBinding++; return { success: true }; },
    },
    startAgentWorker: () => { calls.startAgentWorker++; },
  };
}

describe('manage_agent_registration shared flow', () => {
  it('returns registrationId and nextAction for Agent-driven registration', async () => {
    const cx = createMockCx();
    const handlers = createToolHandlers(cx);
    const started = await handlers.manage_agent_registration({
      action: 'start',
      email: 'agent@example.com',
    });
    assert.strictEqual(started.success, true);
    assert.match(started.registrationId, /^reg_/);
    assert.strictEqual(started.status, 'email_verification_required');
    assert.strictEqual(started.nextAction.type, 'submit_email_code');
    assert.strictEqual(cx._calls.sendCode, 1);

    const verified = await handlers.manage_agent_registration({
      action: 'verify_email',
      registrationId: started.registrationId,
      code: '123456',
    });
    assert.strictEqual(verified.status, 'basic_info_required');
    assert.strictEqual(verified.nextAction.type, 'submit_basic_info');
  });
});

describe('verify_agent_email 必填校验', () => {
  it('完整注册缺 backendType → 报错且不调用后端', async () => {
    const cx = createMockCx();
    const h = createToolHandlers(cx);
    const r = await h.verify_agent_email({ email: 'a@b.com', code: '123456', agentName: 'X', category: 'technology' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /backendType/);
    assert.strictEqual(cx._calls.verifyCode, 0, '缺字段时不应调用后端 verifyCode');
  });

  it('完整注册缺 category → 默认 general', async () => {
    const cx = createMockCx();
    let captured = null;
    cx.agentRegistration.registerAgentInDb = async (p) => { captured = p; cx._calls.registerAgentInDb++; return { success: true }; };
    const h = createToolHandlers(cx);
    const r = await h.verify_agent_email({ email: 'a@b.com', code: '123456', agentName: 'X', backendType: 'codex' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(captured.category, 'general');
  });

  it('完整注册字段齐全 → 成功，registerAgentInDb 收到 category/description', async () => {
    const cx = createMockCx();
    let captured = null;
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args);
    cx.agentRegistration.registerAgentInDb = async (p) => { captured = p; cx._calls.registerAgentInDb++; return { success: true }; };
    try {
      const h = createToolHandlers(cx);
      const r = await h.verify_agent_email({ email: 'a@b.com', code: '123456', agentName: 'X', backendType: 'codex', category: 'technology', description: '测试' });
      assert.strictEqual(r.success, true, '应注册成功');
      assert.strictEqual(captured.category, 'technology');
      assert.strictEqual(captured.description, '测试');
      assert.strictEqual(captured.backendType, 'codex');
      assert.doesNotMatch(JSON.stringify(logs), /"imToken":"t"|"privateKey":"sk"|privateKey.*sk|imToken.*t/);
    } finally {
      console.error = originalError;
    }
  });

  it('预览模式（无 agentId/agentName）不校验 backendType/category', async () => {
    const cx = createMockCx();
    const h = createToolHandlers(cx);
    // 只传 email+code，不传 agentName/agentId/backendType/category
    const r = await h.verify_agent_email({ email: 'a@b.com', code: '123456' });
    assert.strictEqual(r.success, true, '预览模式不应因缺 backendType/category 失败');
    assert.strictEqual(cx._calls.verifyCodePreview, 1, '应走预览分支');
    assert.strictEqual(cx._calls.registerAgentInDb, 0, '预览模式不应写库');
  });

  it('服务端明确返回选中的第二个 Agent 时，不再错误使用 agents[0]', async () => {
    const cx = createMockCx();
    let captured = null;
    cx.agentRegistration.verifyCode = async () => ({
      success: true,
      data: {
        agentId: 'selected-2',
        agents: [{ agentId: 'first-1' }, { agentId: 'selected-2' }],
        imUid: 'uid-2',
        imToken: 'token-2',
        did: 'did:selected-2',
        publicKey: 'pk-2',
        privateKey: 'sk-2',
      },
    });
    cx.agentRegistration.registerAgentInDb = async (params) => {
      captured = params;
      cx._calls.registerAgentInDb++;
      return { success: true };
    };
    const result = await createToolHandlers(cx).verify_agent_email({
      email: 'a@b.com',
      code: '123456',
      agentName: 'Selected',
      backendType: 'codex',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(captured.agentId, 'selected-2');
    assert.strictEqual(captured.uid, 'uid-2');
  });

  it('多 Agent 响应未标识选中身份时停止写库和 Worker', async () => {
    const cx = createMockCx();
    cx.agentRegistration.verifyCode = async () => ({
      success: true,
      data: {
        agents: [{ agentId: 'first-1' }, { agentId: 'second-2' }],
        imUid: 'uid-x',
        imToken: 'token-x',
        did: 'did:x',
        publicKey: 'pk-x',
        privateKey: 'sk-x',
      },
    });
    const result = await createToolHandlers(cx).verify_agent_email({
      email: 'a@b.com',
      code: '123456',
      agentName: 'Unknown',
      backendType: 'codex',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(cx._calls.registerAgentInDb, 0);
    assert.strictEqual(cx._calls.startAgentWorker, 0);
  });
});

describe('create_agent_by_token 必填校验', () => {
  it('缺 backendType → 报错', async () => {
    const cx = createMockCx();
    const h = createToolHandlers(cx);
    const r = await h.create_agent_by_token({ email: 'a@b.com', agentName: 'X', category: 'technology' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(cx._calls.createAgentByToken, 0, '缺字段时不应调后端');
  });

  it('缺 category → 默认 general', async () => {
    const cx = createMockCx();
    let captured = null;
    cx.agentRegistration.registerAgentInDb = async (p) => { captured = p; cx._calls.registerAgentInDb++; return { success: true }; };
    const h = createToolHandlers(cx);
    const r = await h.create_agent_by_token({ email: 'a@b.com', agentName: 'X', backendType: 'codex' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(captured.category, 'general');
  });

  it('缺 email（未登录）→ 报错 noToken', async () => {
    const cx = createMockCx();
    const h = createToolHandlers(cx);
    const r = await h.create_agent_by_token({ backendType: 'codex', category: 'technology' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.noToken, true);
  });

  it('字段齐全 → 成功，registerAgentInDb 收到 category/description', async () => {
    const cx = createMockCx();
    let captured = null;
    cx.agentRegistration.registerAgentInDb = async (p) => { captured = p; cx._calls.registerAgentInDb++; return { success: true }; };
    const h = createToolHandlers(cx);
    const r = await h.create_agent_by_token({ email: 'a@b.com', agentName: 'X', backendType: 'codex', category: 'technology', description: '描述' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(captured.category, 'technology');
    assert.strictEqual(captured.description, '描述');
    assert.strictEqual(captured.backendType, 'codex');
  });

  it('云端缺少 DID 私钥时不写库、不启动 Worker', async () => {
    const cx = createMockCx();
    cx.agentRegistration.createAgentByToken = async () => ({
      success: true,
      data: { agentId: 'unsafe-1', imUid: 'u', imToken: 't', did: 'did:unsafe', publicKey: 'pk' },
    });
    const result = await createToolHandlers(cx).create_agent_by_token({
      email: 'a@b.com',
      agentName: 'Unsafe',
      backendType: 'codex',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(cx._calls.registerAgentInDb, 0);
    assert.strictEqual(cx._calls.startAgentWorker, 0);
  });
});
