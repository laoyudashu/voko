const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const lifecycle = require('../../build/core/process-lifecycle');
const dbPath = process.argv[2];
const workerPath = path.join(__dirname, 'lifecycle-orphan-worker.js');
const identity = lifecycle.inspectProcess(process.pid);
if (!identity) process.exit(2);

const instanceId = crypto.randomUUID();
const workerToken = crypto.randomUUID();
const instance = {
  version: 1,
  ...identity,
  instanceId,
  dbPath,
  entryPath: __filename,
  port: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const worker = spawn(process.execPath, [
  workerPath,
  `--voko-worker-token=${workerToken}`,
  `--voko-instance-id=${instanceId}`,
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
worker.unref();

const metadata = lifecycle.registerWorker(
  dbPath,
  instance,
  'orphan-test-agent',
  workerPath,
  workerToken,
  worker,
);
if (!metadata) process.exit(3);
process.stdout.write(JSON.stringify({ pid: worker.pid }) + '\n');
