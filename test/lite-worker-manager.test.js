const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { AgentWorkerManager } = require('../build/core/worker-manager');

function fakeWorker() {
  const worker = new EventEmitter();
  worker.killed = false;
  worker.send = (message) => {
    worker.lastMessage = message;
    if (message.type === 'disconnect') {
      setImmediate(() => worker.emit('exit', 0));
    }
  };
  worker.kill = () => { worker.killed = true; };
  return worker;
}

describe('Lite worker manager IPC', () => {
  it('旧帧和新 event 帧产生相同 message 事件', () => {
    const manager = new AgentWorkerManager(null);
    const worker = fakeWorker();
    const received = [];
    manager.on('message', (message) => received.push(message));

    manager._handleWorkerMessage({
      type: 'message',
      agentId: 'agent-1',
      data: { content: 'old' },
    }, worker);
    manager._handleWorkerMessage({
      type: 'event',
      event: 'worker.message',
      payload: {
        agentId: 'agent-1',
        data: { content: 'new' },
      },
      seq: 1,
      ts: Date.now(),
    }, worker);

    assert.deepEqual(received, [
      { type: 'message', agentId: 'agent-1', data: { content: 'old' } },
      { type: 'message', agentId: 'agent-1', data: { content: 'new' } },
    ]);
  });

  it('新 worker.status 帧更新连接状态并发出 agent-connected', () => {
    const manager = new AgentWorkerManager(null);
    const worker = fakeWorker();
    manager.workers.set('agent-1', {
      worker,
      config: { uid: 'uid-1', token: 'token', serverUrl: 'ws://example' },
    });
    const connected = [];
    manager.on('agent-connected', (agentId) => connected.push(agentId));

    manager._handleWorkerMessage({
      type: 'event',
      event: 'worker.status',
      payload: { agentId: 'agent-1', status: 'connected', statusCode: 1 },
      seq: 1,
      ts: Date.now(),
    }, worker);

    assert.equal(manager.getStatus('agent-1').connected, true);
    assert.deepEqual(connected, ['agent-1']);
  });

  it('stop 等待 worker 退出并清理运行状态', async () => {
    const manager = new AgentWorkerManager(null);
    const worker = fakeWorker();
    manager.workers.set('agent-1', {
      worker,
      config: { uid: 'uid-1', token: 'token', serverUrl: 'ws://example' },
    });

    await manager.stop('agent-1');

    assert.equal(manager.isRunning('agent-1'), false);
    assert.deepEqual(worker.lastMessage, { type: 'disconnect' });
    assert.equal(worker.killed, false);
  });
});
