const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function createTestRuntime(prefix = 'voko-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const resources = [];
  return {
    root,
    dbPath: path.join(root, 'voko.db'),
    logPath: path.join(root, 'voko.log'),
    env(extra = {}) {
      return { ...process.env, VOKO_DB_PATH: this.dbPath, VOKO_LOG_DIR: path.join(root, 'logs'),
        VOKO_SMOKE_TEST: '1', ...extra };
    },
    use(resource, close) {
      resources.push(async () => {
        if (close) return close(resource);
        if (typeof resource?.close === 'function') return resource.close();
        if (typeof resource?.stop === 'function') return resource.stop();
        if (typeof resource?.kill === 'function' && resource.exitCode === null) resource.kill();
      });
      return resource;
    },
    async cleanup() {
      const errors = [];
      for (const close of resources.reverse()) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    },
  };
}

class FakeClock {
  constructor(now = 0) { this.now = now; this.waiters = []; }
  delay(ms) {
    return new Promise((resolve) => this.waiters.push({ at: this.now + ms, resolve }));
  }
  tick(ms) {
    this.now += ms;
    const ready = this.waiters.filter((item) => item.at <= this.now);
    this.waiters = this.waiters.filter((item) => item.at > this.now);
    ready.forEach((item) => item.resolve());
  }
}

module.exports = { createTestRuntime, getFreePort, FakeClock };
