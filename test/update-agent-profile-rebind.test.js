const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-update-profile-rebind-'));
  const db = initDatabase(path.join(dir, 'lite.db'), { silent: true });
  // 插入一个测试 agent
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, backend_type, backend_instance_id, delivery_modes, access_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('r1', 'agent-1', 'u1', 't1', 'http://im', 'published', 'others', null, JSON.stringify(['pull']), 'private', now, now);
  return { dir, db };
}

function cleanup(dir, db) {
  try { if (db && db.open) db.close(); } catch (_) {}
  // Windows 上 db 句柄释放有延迟，延迟后重试一次
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }, 200);
}

// 构造最小 cx，驱动 update_agent_profile
function makeCx(db, { rebind, dispatcher } = {}) {
  return {
    db,
    query: (sql, params = []) => {
      try { return db.prepare(sql).all(...params); } catch (_) { return []; }
    },
    exec: (sql, params = []) => {
      try { db.prepare(sql).run(...params); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
    },
    updateAgentProfile: async () => ({ success: true }), // mock：不真的同步服务端
  };
}

describe('update_agent_profile 运行时重绑定（覆盖 MCP/CLI/Web 三入口共用 handler）', () => {
  let savedRebind, savedDispatcher;
  beforeEach(() => {
    savedRebind = global.__rebindAgentRuntime;
    savedDispatcher = global.__dispatcher;
  });
  afterEach(() => {
    global.__rebindAgentRuntime = savedRebind;
    global.__dispatcher = savedDispatcher;
  });

  it('backend_type 变更（others→hermes）：注册后类型锁定，不调用 rebind', async () => {
    const { dir, db } = makeFixture();
    try {
      const rebindCalls = [];
      global.__rebindAgentRuntime = async (input) => {
        rebindCalls.push(input);
        return { success: true, rebindStatus: 'rebound', provider: { action: 'loaded', type: 'hermes', instance: null }, bindings: { invalidated: 0 }, imWorker: { action: 'unchanged' } };
      };
      const handlers = createToolHandlers(makeCx(db, { rebind: true }));
      const r = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'hermes' });

      assert.equal(r.success, false);
      assert.match(r.error, /Agent 注册完成后不能更改类型/);
      assert.equal(rebindCalls.length, 0);
      assert.equal(db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get('agent-1').backend_type, 'others');
    } finally { cleanup(dir, db); }
  });

  it('实例变更但目标实例未在本机检测到：返回错误，不触发 rebind（校验先行）', async () => {
    const { dir, db } = makeFixture();
    try {
      db.prepare('UPDATE agents SET backend_type=?, backend_instance_id=? WHERE agent_id=?').run('hermes', 'profileA', 'agent-1');
      const rebindCalls = [];
      global.__rebindAgentRuntime = async (input) => { rebindCalls.push(input); return { success: true }; };
      const handlers = createToolHandlers(makeCx(db));
      const r = await handlers.update_agent_profile({ agentId: 'agent-1', backendInstanceId: 'profileB-not-exist' });

      assert.equal(r.success, false, '不存在的实例应被校验拦截');
      assert.ok(r.error, '应返回错误说明');
      assert.equal(rebindCalls.length, 0, '校验失败不应触发 rebind');
      // DB 未被改动
      assert.equal(db.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=?').get('agent-1').backend_instance_id, 'profileA');
    } finally { cleanup(dir, db); }
  });

  it('仅资料字段变更（name/description）：不调用 rebind', async () => {
    const { dir, db } = makeFixture();
    try {
      const rebindCalls = [];
      global.__rebindAgentRuntime = async (input) => { rebindCalls.push(input); return { success: true }; };
      const handlers = createToolHandlers(makeCx(db));
      await handlers.update_agent_profile({ agentId: 'agent-1', name: '新名字', description: '新描述' });

      assert.equal(rebindCalls.length, 0, '资料更新不应触发 rebind');
    } finally { cleanup(dir, db); }
  });

  it('缺失 rebind 时仍拒绝变更 backend_type，不触发 invalidateMeta', async () => {
    const { dir, db } = makeFixture();
    try {
      delete global.__rebindAgentRuntime;
      let invalidated = false;
      global.__dispatcher = { invalidateMeta: () => { invalidated = true; } };
      const handlers = createToolHandlers(makeCx(db));
      const r = await handlers.update_agent_profile({ agentId: 'agent-1', backendType: 'hermes' });

      assert.equal(r.success, false);
      assert.match(r.error, /Agent 注册完成后不能更改类型/);
      assert.equal(invalidated, false);
      assert.equal(r.runtimeRebind, undefined, '无 rebind 时不带 runtimeRebind 字段');
    } finally { cleanup(dir, db); }
  });
});
