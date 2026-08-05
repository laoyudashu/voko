#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { startFakeServices } = require('../test/support/fake-services');

const root = path.join(__dirname, '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-e2e-'));
  const dbPath = path.join(tempDir, 'e2e.db');
  const logPath = path.join(tempDir, 'voko.log');
  const manifestPath = path.resolve(
    process.env.VOKO_E2E_SERVICES_FILE
      || path.join(os.tmpdir(), `voko-e2e-services-${process.ppid}.json`),
  );
  const port = Number(process.env.VOKO_E2E_PORT) || await findFreePort();
  const output = fs.openSync(logPath, 'a');
  const services = await startFakeServices({ separate: true });
  const seedAgents = [
    {
      agentId: 'e2e-agent',
      imUid: 'e2e-im-uid',
      name: 'E2E Test Agent',
      description: 'Playwright isolated Agent',
    },
    {
      agentId: 'e2e-agent-2',
      imUid: 'e2e-im-uid-2',
      name: 'E2E Shared Hub Agent',
      description: 'Second Agent sharing the E2E Hub',
    },
  ];
  const env = {
    ...process.env,
    VOKO_DB_PATH: dbPath,
    VOKO_SMOKE_TEST: '1',
    VOKO_E2E: '1',
    VOKO_E2E_SERVICES_FILE: manifestPath,
    VOKO_E2E_API_BASE_URL: services.apiBaseUrl,
    VOKO_GROUP_API_BASE: services.apiBaseUrl,
    VOKO_E2E_IM_WS_URL: services.imWsUrl,
    VOKO_E2E_OSS_BASE_URL: services.ossBaseUrl,
    VOKO_OSS_UPLOAD_TIMEOUT_MS: '500',
    VOKO_E2E_PROVIDER_BASE_URL: services.providerBaseUrl,
    // The isolated browser uses the instance token so mutation routes do not
    // open the production owner re-auth dialog during deterministic tests.
    VOKO_MCP_TOKEN: 'e2e-test-local-auth',
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    runId: path.basename(tempDir),
    pid: process.pid,
    tempDir,
    dbPath,
    logPath,
    vokoPort: port,
    services: services.services,
    agents: seedAgents.map(({ agentId, imUid }) => ({ agentId, imUid })),
  }, null, 2));

  const { initDatabase, saveUserAccessToken } = require('../build/core/database');
  const originalLog = console.log;
  const originalError = console.error;
  const ownerEmail = 'e2e-owner@example.test';
  try {
    console.log = () => {};
    console.error = () => {};
    const db = initDatabase(dbPath);
    saveUserAccessToken(db, ownerEmail, 'e2e-local-token');
    const insertAgent = db.prepare(`INSERT INTO agents (
      agent_id, imUid, imToken, im_server_url, owner_email, publish_status,
      created_at, updated_at, backend_type, agent_name, category, description, access_mode, delivery_modes
    ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const agent of seedAgents) {
      insertAgent.run(agent.agentId, agent.imUid, 'e2e-im-token', services.imWsUrl, ownerEmail,
        Date.now(), Date.now(), 'mock', agent.name, 'general', agent.description, 'public', null);
    }
    db.close();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const child = spawn(process.execPath, [
    path.join(root, 'build', 'index.js'), 'start', `--db=${dbPath}`, `--port=${port}`,
    '--no-open', '--noAutoUpdate',
  ], { cwd: root, env, stdio: ['ignore', output, output], windowsHide: true });

  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    try {
      spawnSync(process.execPath, [path.join(root, 'build', 'index.js'), 'stop', `--db=${dbPath}`], {
        cwd: root, env, stdio: 'ignore', timeout: 10_000, windowsHide: true,
      });
    } catch {}
    if (child.exitCode === null) {
      try { child.kill(); } catch {}
    }
    try { await services.close(); } catch {}
    try { fs.closeSync(output); } catch {}
    if (code === 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });
    } else {
      console.error(`[e2e] 保留失败现场: ${tempDir}`);
      console.error(`[e2e] Fake 服务清单: ${manifestPath}`);
    }
    process.exit(code);
  }

  child.once('error', (error) => {
    console.error(`[e2e] VOKO 启动失败: ${error.message}`);
    void stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) void stop(code || 1);
  });
  process.once('SIGINT', () => void stop(0));
  process.once('SIGTERM', () => void stop(0));
  console.log(`[e2e] VOKO pid=${child.pid} port=${port} data=${tempDir}`);
  console.log(`[e2e] Fake services=${manifestPath}`);
}

main().catch((error) => {
  console.error(`[e2e] 启动脚本失败: ${error.stack || error.message || error}`);
  process.exit(1);
});
