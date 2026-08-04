#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-e2e-'));
const dbPath = path.join(tempDir, 'e2e.db');
const logPath = path.join(tempDir, 'voko.log');
const port = Number(process.env.VOKO_E2E_PORT || 32199);
const output = fs.openSync(logPath, 'a');
const env = { ...process.env, VOKO_DB_PATH: dbPath, VOKO_SMOKE_TEST: '1' };
const { initDatabase, saveUserAccessToken } = require('../build/core/database');
const originalLog = console.log;
const originalError = console.error;
console.log = () => {};
console.error = () => {};
const db = initDatabase(dbPath);
const ownerEmail = 'e2e-owner@example.test';
saveUserAccessToken(db, ownerEmail, 'e2e-local-token');
db.prepare(`INSERT INTO agents (
  agent_id, imUid, imToken, im_server_url, owner_email, publish_status,
  created_at, updated_at, backend_type, agent_name, category, description, access_mode
) VALUES (?, ?, ?, ?, ?, 'unpublished', ?, ?, ?, ?, ?, ?, ?)`)
  .run('e2e-agent', 'e2e-im-uid', 'e2e-im-token', 'wss://wukongim.vokovoko.com', ownerEmail,
    Date.now(), Date.now(), 'others', 'E2E Test Agent', 'general', 'Playwright isolated Agent', 'private');
db.close();
console.log = originalLog;
console.error = originalError;
const child = spawn(process.execPath, [
  path.join(root, 'build', 'index.js'), 'start', `--db=${dbPath}`, `--port=${port}`,
  '--no-open', '--noAutoUpdate',
], { cwd: root, env, stdio: ['ignore', output, output], windowsHide: true });

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  spawnSync(process.execPath, [path.join(root, 'build', 'index.js'), 'stop', `--db=${dbPath}`], {
    cwd: root, env, stdio: 'ignore', timeout: 10_000, windowsHide: true,
  });
  if (child.exitCode === null) child.kill();
  fs.closeSync(output);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(code);
}

child.once('error', (error) => { console.error(error); stop(1); });
child.once('exit', (code) => { if (!stopping) stop(code || 1); });
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
console.log(`[e2e] VOKO pid=${child.pid} port=${port} data=${tempDir}`);
