#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'build', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`health check timed out: ${lastError?.message || 'unknown error'}`);
}

function listTools(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, 'mcp'], {
      cwd: ROOT,
      env: { ...process.env, VOKO_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP tools/list timed out: ${stderr}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MCP proxy exited ${code}: ${stderr}`));
      try {
        const response = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean)[0]);
        if (!Array.isArray(response.result?.tools) || response.result.tools.length === 0) {
          throw new Error('MCP returned no tools');
        }
        resolve(response.result.tools);
      } catch (error) {
        reject(new Error(`invalid MCP response: ${error.message}; stdout=${stdout}`));
      }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }) + '\n');
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-smoke-'));
  const dbPath = path.join(tempDir, 'smoke.db');
  const port = await freePort();
  const env = { ...process.env, VOKO_DB_PATH: dbPath };
  const server = spawn(process.execPath, [
    ENTRY,
    'start',
    `--db=${dbPath}`,
    `--port=${port}`,
    '--no-open',
    '--noAutoUpdate',
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const health = await waitForHealth(port);
    const tools = await listTools(dbPath);
    if (!tools.some((tool) => tool.name === 'voko_get_status')) {
      throw new Error('expected voko_get_status in MCP tools/list');
    }
    console.log(JSON.stringify({
      ok: true,
      health,
      mcpToolCount: tools.length,
      checkedTool: 'voko_get_status',
    }, null, 2));
  } catch (error) {
    throw new Error(`${error.message}\nLite stderr:\n${stderr}`);
  } finally {
    spawnSync(process.execPath, [ENTRY, 'stop', `--db=${dbPath}`], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    if (server.exitCode === null) server.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[smoke:standalone]', error.message);
  process.exit(1);
});
