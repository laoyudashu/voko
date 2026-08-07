const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

/**
 * 动态端口测试：
 *   1. getRuntimePort：读 DB runtime 实际端口
 *   2. voko mcp stdio 桥接：转发 JSON-RPC 到 Lite /mcp（端口透明）
 */

const { getRuntimePort, getActiveRuntimePort } = require('../build/core/runtime-port');
const lifecycle = require('../build/core/process-lifecycle');

function tmpDb() {
  const p = path.join(os.tmpdir(), `voko-port-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(p);
  db._tmpPath = p;
  db.exec('CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT)');
  return db;
}
function cleanup(db) { try { db.close(); } catch (_) {} try { fs.unlinkSync(db._tmpPath); } catch (_) {} }

// ════════════════════════════════════════════════════════════
//  getRuntimePort
// ════════════════════════════════════════════════════════════
describe('getRuntimePort', () => {
  it('有 runtime 记录返回端口', () => {
    const db = tmpDb();
    try {
      db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)").run(JSON.stringify({ pid: 12345, port: 3101 }));
      assert.strictEqual(getRuntimePort(db._tmpPath), 3101);
    } finally { cleanup(db); }
  });

  it('端口被占换端口后返回实际端口（非默认 3100）', () => {
    const db = tmpDb();
    try {
      db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)").run(JSON.stringify({ pid: 1, port: 3103 }));
      assert.strictEqual(getRuntimePort(db._tmpPath), 3103);
    } finally { cleanup(db); }
  });

  it('无 runtime 记录返回 null', () => {
    const db = tmpDb();
    try { assert.strictEqual(getRuntimePort(db._tmpPath), null); }
    finally { cleanup(db); }
  });

  it('runtime 无 port 字段返回 null', () => {
    const db = tmpDb();
    try {
      db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)").run(JSON.stringify({ pid: 1 }));
      assert.strictEqual(getRuntimePort(db._tmpPath), null);
    } finally { cleanup(db); }
  });

  it('db 文件不存在返回 null（不抛错）', () => {
    assert.strictEqual(getRuntimePort(path.join(os.tmpdir(), 'nonexistent-' + Date.now() + '.db')), null);
  });
});

describe('getActiveRuntimePort', () => {
  it('只接受通过实例身份验证的锁端口', () => {
    const db = tmpDb();
    try {
      const metadata = { instanceId: 'live-1', pid: 123, port: 3201 };
      assert.strictEqual(getActiveRuntimePort(db._tmpPath, {
        readInstanceMetadata: () => metadata,
        isInstanceAlive: () => true,
      }), 3201);
      assert.strictEqual(getActiveRuntimePort(db._tmpPath, {
        readInstanceMetadata: () => metadata,
        isInstanceAlive: () => false,
      }), null);
    } finally { cleanup(db); }
  });

  it('锁尚未写端口时仅接受同一 instanceId 的 runtime 快照', () => {
    const db = tmpDb();
    try {
      const metadata = { instanceId: 'live-2', pid: 456, port: null };
      db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)")
        .run(JSON.stringify({ instanceId: 'other', pid: 456, port: 3202 }));
      const deps = {
        readInstanceMetadata: () => metadata,
        isInstanceAlive: () => true,
      };
      assert.strictEqual(getActiveRuntimePort(db._tmpPath, deps), null);
      db.prepare("UPDATE config SET data=? WHERE type='runtime'")
        .run(JSON.stringify({ instanceId: 'live-2', pid: 456, port: 3202 }));
      assert.strictEqual(getActiveRuntimePort(db._tmpPath, deps), 3202);
    } finally { cleanup(db); }
  });
});

// ════════════════════════════════════════════════════════════
//  voko mcp stdio 桥接（集成测试：spawn 子进程 + 临时 HTTP server）
// ════════════════════════════════════════════════════════════
describe('voko mcp stdio 桥接', () => {
  it('读 runtime 端口，转发 JSON-RPC 到 /mcp，响应写 stdout', async () => {
    // 1. 临时 HTTP server 模拟 Lite /mcp
    const app = express();
    app.use(express.json());
    let healthIdentity = { instanceId: null, pid: process.pid, port: null, version: '0.4.3', edition: 'lite' };
    app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: 1, ...healthIdentity }));
    app.post('/mcp', (req, res) => {
      res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: [{ name: 'voko_get_status' }] } });
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const litePort = server.address().port;

    // 2. 建立可验证的实例锁并写入同身份 runtime（指向临时 server 端口）
    const db = tmpDb();
    const acquired = await lifecycle.acquireInstanceLock(db._tmpPath, path.resolve(process.argv[1]));
    assert.equal(acquired.acquired, true);
    acquired.lock.updatePort(litePort);
    healthIdentity = { ...healthIdentity, instanceId: acquired.lock.metadata.instanceId, port: litePort };
    db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)").run(JSON.stringify({
      instanceId: acquired.lock.metadata.instanceId,
      pid: process.pid,
      port: litePort,
    }));

    try {
      // 3. spawn `voko mcp`（直接跑 index.js mcp 子命令）
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), 'mcp'], {
        env: { ...process.env, VOKO_DB_PATH: db._tmpPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      // 4. 发一个 tools/list 请求
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }) + '\n');
      child.stdin.end();

      // 等待响应（进程会在 stdin EOF 后退出）
      await new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
        setTimeout(() => { child.kill(); reject(new Error('超时，stderr: ' + stderr)); }, 15000);
      });

      // 5. 断言 stdout 第一行是 tools/list 响应
      const lines = stdout.trim().split('\n').filter(Boolean);
      assert.ok(lines.length >= 1, '应有响应输出，stderr=' + stderr);
      const resp = JSON.parse(lines[0]);
      assert.strictEqual(resp.id, 1);
      assert.ok(resp.result?.tools?.some(t => t.name === 'voko_get_status'), '应返回工具列表');
    } finally {
      await new Promise((r) => server.close(r));
      acquired.lock.release();
      cleanup(db);
    }
  });

  it('无 runtime 端口时退出码非 0（提示先启动）', async () => {
    const db = tmpDb(); // 空 DB，无 runtime
    try {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), 'mcp'], {
        env: { ...process.env, VOKO_DB_PATH: db._tmpPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const code = await new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
        setTimeout(() => { child.kill(); reject(new Error('超时')); }, 10000);
      });
      assert.notStrictEqual(code, 0, '无端口应非 0 退出');
      assert.match(stderr, /未检测到运行中的 Lite|voko start/i);
    } finally { cleanup(db); }
  });

  it('只有过期 runtime 快照、没有活实例锁时拒绝转发', async () => {
    const db = tmpDb();
    db.prepare("INSERT INTO config (type,data) VALUES ('runtime',?)")
      .run(JSON.stringify({ instanceId: 'stale', pid: 999999, port: 3100 }));
    try {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), 'mcp'], {
        env: { ...process.env, VOKO_DB_PATH: db._tmpPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      const code = await new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
        setTimeout(() => { child.kill(); reject(new Error('超时')); }, 10000);
      });
      assert.notStrictEqual(code, 0);
      assert.match(stderr, /未检测到|No identity-validated|voko start/i);
    } finally { cleanup(db); }
  });
});
