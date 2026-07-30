const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LITE_ENTRY = path.join(__dirname, '..', 'build', 'index.js');
const tempDirs = [];
const children = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-fatal-'));
  tempDirs.push(dir);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
    server.on('error', reject);
  });
}

function waitExit(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `fatal test process timeout\nstdout=${child.stdoutText}\nstderr=${child.stderrText}`,
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

async function runFatal(mode) {
  const dbPath = path.join(tempDir(), `${mode}.db`);
  const port = await freePort();
  const child = spawn(process.execPath, [
    LITE_ENTRY,
    'start',
    `--db=${dbPath}`,
    `--port=${port}`,
    '--no-auto-update',
  ], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      VOKO_LITE_SPAWNED_BY: 'fatal-test',
      VOKO_SMOKE_TEST: '1',
      VOKO_TEST_FATAL_MODE: mode,
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

  const code = await waitExit(child);
  assert.equal(code, 1, child.stderrText);
  assert.match(child.stderrText, new RegExp(`\\[Lite\\]\\[${mode}\\]`));

  const lifecycle = require('../build/core/process-lifecycle');
  const metadata = lifecycle.readInstanceMetadata(dbPath);
  assert.equal(Boolean(metadata && lifecycle.isInstanceAlive(metadata)), false);
}

afterEach(async () => {
  for (const child of [...children]) {
    try { child.kill('SIGKILL'); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('Lite fatal process lifecycle', () => {
  it('uncaught exception performs bounded cleanup and exits non-zero', { timeout: 30000 }, async () => {
    await runFatal('uncaughtException');
  });

  it('unhandled rejection performs bounded cleanup and exits non-zero', { timeout: 30000 }, async () => {
    await runFatal('unhandledRejection');
  });
});
