const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const lifecycle = require('../build/core/process-lifecycle');
const LITE_ENTRY = path.join(__dirname, '..', 'build', 'index.js');
const tempDirs = [];
const children = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-lifecycle-'));
  tempDirs.push(dir);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function spawnLite(dbPath, port) {
  const child = spawn(process.execPath, [
    LITE_ENTRY,
    'start',
    `--db=${dbPath}`,
    `--port=${port}`,
    '--no-auto-update',
    '--no-open',
  ], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      VOKO_LITE_SPAWNED_BY: 'lifecycle-test',
      VOKO_SMOKE_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  return child;
}

function waitExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `进程退出超时\nstdout=${child.stdoutText || ''}\nstderr=${child.stderrText || ''}`,
    )), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await new Promise((resolve, reject) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port,
          path: '/health',
          timeout: 500,
        }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
      });
      if (value?.status === 'ok') return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Lite 未在端口 ${port} 就绪`);
}

function runCli(args, timeoutMs = 20000) {
  const safeArgs = args[0] === 'start' && !args.includes('--no-open')
    ? [...args, '--no-open']
    : args;
  const child = spawn(process.execPath, [LITE_ENTRY, ...safeArgs], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, VOKO_LITE_SPAWNED_BY: 'lifecycle-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  return waitExit(child, timeoutMs).then(code => ({
    code,
    stdout: child.stdoutText,
    stderr: child.stderrText,
  }));
}

afterEach(async () => {
  for (const child of [...children]) {
    try { child.kill('SIGKILL'); } catch {}
    try { await waitExit(child, 3000); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('Lite process lifecycle identity', () => {
  it('校验 PID 创建时间、入口路径和 worker token', () => {
    const identity = lifecycle.inspectProcess(process.pid);
    assert.ok(identity);
    const instance = {
      version: 1,
      ...identity,
      instanceId: 'instance-1',
      dbPath: path.join(tempDir(), 'test.db'),
      entryPath: path.resolve(process.argv[1]),
      port: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    assert.equal(
      lifecycle.matchesInstanceProcess(instance, identity),
      true,
      JSON.stringify({ argv: process.argv, identity, entryPath: instance.entryPath }),
    );
    assert.equal(lifecycle.matchesInstanceProcess(
      { ...instance, creationId: `${identity.creationId}-reused` },
      identity,
    ), false);

    const workerPath = path.join(tempDir(), 'agent-worker.js');
    const worker = {
      version: 1,
      ...identity,
      instanceId: 'instance-1',
      workerToken: 'worker-token-1',
      agentId: 'agent-1',
      workerPath,
      parentCreationId: 'parent-created',
      createdAt: Date.now(),
    };
    const workerIdentity = {
      ...identity,
      commandLine: `${identity.executablePath} ${workerPath} --voko-worker-token=worker-token-1 --voko-instance-id=instance-1`,
    };
    assert.equal(lifecycle.matchesWorkerProcess(worker, workerIdentity), true);
    assert.equal(lifecycle.matchesWorkerProcess(
      { ...worker, workerToken: 'other-token' },
      workerIdentity,
    ), false);
  });

  it('批量登记多个 worker 时保留每个进程的精确身份', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'batch.db');
    const parentIdentity = lifecycle.inspectProcess(process.pid);
    assert.ok(parentIdentity);
    const instance = {
      version: 1,
      ...parentIdentity,
      instanceId: 'batch-instance',
      dbPath,
      entryPath: path.resolve(process.argv[1]),
      port: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const workerPath = path.join(dir, 'agent-worker.js');
    const registrations = [];
    for (let index = 0; index < 3; index++) {
      const token = `batch-token-${index}`;
      const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
        workerPath,
        `--voko-worker-token=${token}`,
        '--voko-instance-id=batch-instance',
      ], {
        stdio: 'ignore',
        windowsHide: true,
      });
      children.add(child);
      child.on('exit', () => children.delete(child));
      registrations.push({
        agentId: `agent-${index}`,
        workerPath,
        workerToken: token,
        worker: child,
      });
    }

    const registered = lifecycle.registerWorkers(dbPath, instance, registrations);
    assert.equal(registered.size, 3);
    for (const registration of registrations) {
      const metadata = registered.get(registration.workerToken);
      assert.ok(metadata);
      assert.equal(metadata.pid, registration.worker.pid);
      assert.equal(metadata.parentPid, process.pid);
      assert.equal(metadata.instanceId, 'batch-instance');
      assert.match(metadata.commandLine, new RegExp(registration.workerToken));
      assert.equal(
        lifecycle.matchesWorkerProcess(metadata, {
          pid: metadata.pid,
          parentPid: metadata.parentPid,
          creationId: metadata.creationId,
          executablePath: metadata.executablePath,
          commandLine: metadata.commandLine,
        }),
        true,
      );
    }
  });

  it('同一数据库原子互斥，不同数据库可分别持锁', async () => {
    const dir = tempDir();
    const entry = path.resolve(process.argv[1]);
    const dbA = path.join(dir, 'a.db');
    const dbB = path.join(dir, 'b.db');
    const first = await lifecycle.acquireInstanceLock(dbA, entry);
    assert.equal(first.acquired, true);
    const duplicate = await lifecycle.acquireInstanceLock(dbA, entry);
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.existing.instanceId, first.lock.metadata.instanceId);
    const other = await lifecycle.acquireInstanceLock(dbB, entry);
    assert.equal(other.acquired, true);
    other.lock.release();
    first.lock.release();
  });

  it('损坏的历史锁可被隔离并重新取得', async () => {
    const dbPath = path.join(tempDir(), 'stale.db');
    const paths = lifecycle._test.getRuntimePaths(dbPath);
    fs.mkdirSync(paths.lockDir, { recursive: true });
    fs.writeFileSync(paths.ownerFile, '{"pid":', 'utf8');
    const result = await lifecycle.acquireInstanceLock(dbPath, path.resolve(process.argv[1]));
    assert.equal(result.acquired, true);
    result.lock.release();
  });
});

describe('Lite process lifecycle integration', () => {
  it('父进程崩溃后只回收 registry 身份匹配的孤儿 worker', { timeout: 30000 }, async () => {
    const dbPath = path.join(tempDir(), 'orphan.db');
    const parent = spawn(process.execPath, [
      path.join(__dirname, 'fixtures', 'lifecycle-orphan-parent.js'),
      dbPath,
    ], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.add(parent);
    parent.on('exit', () => children.delete(parent));
    let output = '';
    let errors = '';
    parent.stdout.on('data', chunk => { output += chunk; });
    parent.stderr.on('data', chunk => { errors += chunk; });
    const parentCode = await waitExit(parent, 10000);
    assert.equal(parentCode, 0, errors);
    const workerPid = JSON.parse(output.trim()).pid;
    assert.ok(lifecycle.inspectProcess(workerPid), '孤儿 worker 应先保持存活');

    const result = lifecycle.cleanupOrphanedWorkers(dbPath);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.killed, [workerPid]);
    assert.equal(lifecycle.inspectProcess(workerPid), null);
  });

  it('同一数据库只运行一个实例，stop 精确关闭且不影响无关 Node 进程', { timeout: 60000 }, async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'lite.db');
    const port = await freePort();
    const first = spawnLite(dbPath, port);
    const health = await waitHealth(port);
    assert.ok(health.instanceId);

    const runningStatus = await runCli(['status', `--db=${dbPath}`]);
    assert.equal(runningStatus.code, 0, runningStatus.stderr);
    const running = JSON.parse(runningStatus.stdout);
    assert.equal(running.running, true);
    assert.equal(running.state, 'running');
    assert.equal(running.pid, first.pid);
    assert.equal(running.port, port);
    assert.equal(running.instanceId, health.instanceId);
    assert.ok(running.uptime >= 0);

    const duplicate = await runCli(['start', `--db=${dbPath}`, `--port=${port}`, '--no-auto-update']);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.match(duplicate.stderr, /already running|已在运行|実行中/i);

    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.add(sentinel);
    sentinel.on('exit', () => children.delete(sentinel));

    const stopped = await runCli(['stop', `--db=${dbPath}`], 30000);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(await waitExit(first, 10000), 0);
    assert.equal(sentinel.exitCode, null, '无关 Node 进程不应被终止');
    assert.equal(lifecycle.inspectProcess(first.pid), null);

    const stoppedStatus = await runCli(['status', `--db=${dbPath}`]);
    assert.equal(stoppedStatus.code, 0, stoppedStatus.stderr);
    const stoppedState = JSON.parse(stoppedStatus.stdout);
    assert.equal(stoppedState.running, false);
    assert.equal(stoppedState.state, 'stopped');
    assert.equal(stoppedState.pid, null);
    assert.equal(stoppedState.port, null);
    assert.equal(stoppedState.uptime, null);
    assert.deepEqual(stoppedState.agents, []);
    const stoppedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        stoppedDb.prepare("SELECT data FROM config WHERE type = 'runtime'").get(),
        undefined,
        '正常关闭应删除当前实例的 runtime 快照',
      );
    } finally {
      stoppedDb.close();
    }
  });

  it('Lite 崩溃后 status 忽略残留 runtime 和实例锁', { timeout: 50000 }, async () => {
    const dbPath = path.join(tempDir(), 'crashed-status.db');
    const port = await freePort();
    const lite = spawnLite(dbPath, port);
    await waitHealth(port);

    lite.kill('SIGKILL');
    await waitExit(lite, 10000);

    const statusResult = await runCli(['status', `--db=${dbPath}`]);
    assert.equal(statusResult.code, 0, statusResult.stderr);
    const status = JSON.parse(statusResult.stdout);
    assert.equal(status.running, false);
    assert.equal(status.state, 'stopped');
    assert.equal(status.pid, null);
    assert.equal(status.port, null);
    assert.equal(status.uptime, null);
    assert.ok(status.lastSeenAt, '保留最后快照时间用于诊断');
    assert.deepEqual(status.agents, []);
    const crashedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.ok(
        crashedDb.prepare("SELECT data FROM config WHERE type = 'runtime'").get(),
        '强杀后应保留 runtime 快照，以证明 status 没有依赖删除才正确',
      );
    } finally {
      crashedDb.close();
    }
  });

  it('端口被占时启动失败且不会递增端口', { timeout: 40000 }, async () => {
    const blocker = http.createServer();
    await new Promise((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', resolve);
      blocker.on('error', reject);
    });
    const port = blocker.address().port;
    const dbPath = path.join(tempDir(), 'occupied.db');
    try {
      const lite = spawnLite(dbPath, port);
      const code = await waitExit(lite, 20000);
      assert.notEqual(code, 0);
      assert.match(lite.stderrText, /EADDRINUSE|启动失败|failed to start/i);
      await assert.rejects(waitHealth(port + 1, 1000));
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});
