'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const lifecycle = require('../build/core/process-lifecycle');
const { probeRuntimeIdentity } = require('../build/core/runtime-probe');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-runtime-route-'));
  return { dir, dbPath: path.join(dir, 'voko.db') };
}

test('CLI registration requires the running Lite runtime and does not create a database', () => {
  const fixture = tempDbPath();
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'build', 'index.js'),
      'manage_agent_registration', '--action', 'start', '--registration-mode', 'agent', '--db', fixture.dbPath,
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.code, 'RUNTIME_REQUIRED');
    assert.equal(fs.existsSync(fixture.dbPath), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('setup advertises the canonical browser-free runtime commands', () => {
  const fixture = tempDbPath();
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'build', 'index.js'), 'setup', '--db', fixture.dbPath,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.browserOpened, false);
    assert.deepEqual(output.stableCommands.mcp, {
      command: process.execPath,
      args: [path.join(__dirname, '..', 'build', 'index.js'), 'mcp'],
    });
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('CLI registration proxies to the identity-validated Lite runtime', async (t) => {
  const fixture = tempDbPath();
  const app = express();
  app.use(express.json());
  let identity = null;
  app.get('/health', (_req, res) => res.json({ status: 'ok', ...identity }));
  app.post('/mcp', (req, res) => res.json({
    jsonrpc: '2.0',
    id: req.body.id,
    result: { content: [{ type: 'text', text: JSON.stringify({ success: true, action: req.body.params?.arguments?.action || null }) }] },
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (_) {}
  });

  const acquired = await lifecycle.acquireInstanceLock(fixture.dbPath, path.resolve(process.argv[1]));
  assert.equal(acquired.acquired, true);
  const port = server.address().port;
  acquired.lock.updatePort(port);
  identity = {
    instanceId: acquired.lock.metadata.instanceId,
    pid: process.pid,
    port,
    version: '0.4.3',
    edition: 'lite',
  };
  try {
    const child = spawn(process.execPath, [
      path.join(__dirname, '..', 'build', 'index.js'),
      'manage_agent_registration', '--action', 'status', '--registrationId', 'reg-test', '--db', fixture.dbPath,
    ], { encoding: 'utf8', windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });
    assert.equal(status, 0, `${stderr}\n${stdout}`);
    const output = JSON.parse(stdout);
    assert.equal(output.success, true);
    assert.equal(output.action, 'status');
  } finally {
    acquired.lock.release();
  }
});

test('runtime probe rejects a different Lite identity', async () => {
  const result = await probeRuntimeIdentity({
    port: 3210,
    instance: { instanceId: 'expected', pid: 12, port: 3210, mcpToken: 'test-token' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      status: 'ok', instanceId: 'other', pid: 12, port: 3210, edition: 'lite',
    }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNTIME_MISMATCH');
});
