const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

test('worker credentials are passed over IPC and never appear in fork argv', async (t) => {
  const workerManagerPath = require.resolve('../build/core/worker-manager');
  const fixturePath = path.resolve(__dirname, 'fixtures', 'worker-ipc-capture.js');
  const realFork = childProcess.fork;
  let forkArgs = null;

  childProcess.fork = (_workerPath, args, options) => {
    forkArgs = [...args];
    return realFork(fixturePath, args, options);
  };
  delete require.cache[workerManagerPath];
  const { AgentWorkerManager } = require('../build/core/worker-manager');

  t.after(() => {
    childProcess.fork = realFork;
    delete require.cache[workerManagerPath];
  });

  const manager = new AgentWorkerManager(null);
  manager.start('agent-ipc', {
    uid: 'uid-ipc',
    token: 'test-token-must-not-appear-in-argv',
    serverUrl: 'wss://wukongim.vokovoko.com',
  });

  const entry = manager.workers.get('agent-ipc');
  assert.ok(entry, 'worker should start');
  await new Promise((resolve) => entry.worker.once('message', resolve));

  const argv = forkArgs.join('\u0000');
  assert.doesNotMatch(argv, /test-token-must-not-appear-in-argv/);
  assert.doesNotMatch(argv, /uid-ipc/);
  assert.match(argv, /--voko-worker-token=/);
  assert.match(argv, /--voko-instance-id=/);

  await manager.stop('agent-ipc');
});
