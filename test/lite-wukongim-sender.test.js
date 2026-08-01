const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createWukongimSender } = require('../build/core/wukongim-sender');
const {
  createSenderRuntime,
} = require('../build/workers/wukongim-sender-worker');

function createRuntimeFixture() {
  const sent = [];
  let active = 0;
  let maxActive = 0;
  const listeners = new Set();
  const sdk = {
    config: {},
    connectManager: {
      status: 0,
      addConnectStatusListener(listener) { listeners.add(listener); },
      removeConnectStatusListener(listener) { listeners.delete(listener); },
    },
    messageContentManager: { register() {} },
    connect() {
      sdk.connectManager.status = 1;
      for (const listener of [...listeners]) listener(1);
    },
    disconnect() { sdk.connectManager.status = 0; },
    chatManager: {
      async send(message, channel) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        sent.push({ message, channel });
        return {
          messageID: `message-${sent.length}`,
          clientMsgNo: `client-${sent.length}`,
          messageSeq: sent.length,
        };
      },
    },
  };
  class MessageText { constructor(content) { this.content = content; } }
  class MessageImage {}
  class MessageFile {}
  class Channel {
    constructor(channelId, channelType) {
      this.channelId = channelId;
      this.channelType = channelType;
    }
  }
  const runtime = createSenderRuntime({
    sdkModule: {
      WKSDK: { shared: () => sdk },
      MessageText,
      MessageImage,
      Channel,
      ChannelTypePerson: 1,
      ChannelTypeGroup: 2,
    },
    MessageFile,
    idleTimeoutMs: 0,
  });
  return { runtime, sdk, sent, getMaxActive: () => maxActive };
}

test('sender worker locks identity and serializes requests for one Agent', async () => {
  const fixture = createRuntimeFixture();
  assert.deepEqual(
    fixture.runtime.init('agent-a', {
      uid: 'uid-a',
      token: 'token-a',
      serverUrl: 'ws://im.test',
    }),
    { success: true },
  );
  assert.deepEqual(
    fixture.runtime.init('agent-b', {
      uid: 'uid-b',
      token: 'token-b',
      serverUrl: 'ws://im.test',
    }),
    { success: false, error: 'Sender identity is immutable' },
  );

  const results = await Promise.all([
    fixture.runtime.send({
      agentId: 'agent-a',
      uid: 'uid-a',
      channelId: 'visitor-1',
      content: 'first',
    }),
    fixture.runtime.send({
      agentId: 'agent-a',
      uid: 'uid-a',
      channelId: 'group-1',
      channelType: 2,
      content: 'second',
      mentions: { all: false, uids: ['visitor-2'] },
    }),
  ]);

  assert.equal(fixture.getMaxActive(), 1);
  assert.deepEqual(results.map((result) => result.messageId), ['message-1', 'message-2']);
  assert.equal(fixture.sent[0].message.content, 'first');
  assert.equal(fixture.sent[1].channel.channelType, 2);
  assert.deepEqual(fixture.sent[1].message.mention, {
    all: false,
    uids: ['visitor-2'],
  });
  assert.deepEqual(
    await fixture.runtime.send({
      agentId: 'agent-b',
      uid: 'uid-b',
      channelId: 'visitor-1',
      content: 'wrong identity',
    }),
    { success: false, error: 'Sender identity mismatch' },
  );
  await fixture.runtime.shutdown();
});

test('sender worker preserves image and file message payloads', async () => {
  const fixture = createRuntimeFixture();
  fixture.runtime.init('agent-a', {
    uid: 'uid-a',
    token: 'token-a',
    serverUrl: 'ws://im.test',
  });

  await fixture.runtime.send({
    agentId: 'agent-a',
    channelId: 'visitor-1',
    content: 'https://example.test/image.png',
    messageType: 'image',
  });
  await fixture.runtime.send({
    agentId: 'agent-a',
    channelId: 'visitor-1',
    content: JSON.stringify({
      url: 'https://example.test/file.txt',
      name: 'file.txt',
      size: 12,
      type: 'text/plain',
    }),
    messageType: 'file',
  });

  assert.equal(fixture.sent[0].message.url, 'https://example.test/image.png');
  assert.deepEqual(
    {
      url: fixture.sent[1].message.url,
      name: fixture.sent[1].message.name,
      size: fixture.sent[1].message.size,
      type: fixture.sent[1].message.type,
    },
    {
      url: 'https://example.test/file.txt',
      name: 'file.txt',
      size: 12,
      type: 'text/plain',
    },
  );
  await fixture.runtime.shutdown();
});

class FakeSenderChild extends EventEmitter {
  constructor(pid, behavior = {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = true;
    this.messages = [];
    this.behavior = behavior;
  }

  send(message) {
    this.messages.push(message);
    if (message.type === 'init') {
      queueMicrotask(() => this.emit('message', {
        type: 'ready',
        success: true,
        agentId: message.agentId,
        uid: message.config.uid,
      }));
    } else if (message.type === 'send' && !this.behavior.hang) {
      queueMicrotask(() => this.emit('message', {
        type: 'result',
        requestId: message.requestId,
        result: {
          success: true,
          messageId: `${message.agentId}:${message.channelId}`,
        },
      }));
    } else if (message.type === 'shutdown') {
      queueMicrotask(() => this.finish(0, null));
    }
  }

  kill(signal) {
    this.finish(null, signal);
    return true;
  }

  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

function createManagerFixture({ hang = false, requestTimeoutMs = 100, serverUrl = 'wss://wukongim.vokovoko.com' } = {}) {
  const rows = {
    'agent-a': { imUid: 'uid-a', imToken: 'token-a', im_server_url: serverUrl },
    'agent-b': { imUid: 'uid-b', imToken: 'token-b', im_server_url: serverUrl },
  };
  const children = [];
  const registered = [];
  const unregistered = [];
  const db = {
    prepare() {
      return { get(agentId) { return rows[agentId]; } };
    },
  };
  const sender = createWukongimSender(db, {
    dbPath: 'D:\\temp\\sender-test.db',
    instance: {
      instanceId: 'instance-1',
      pid: process.pid,
      createdAt: Date.now(),
      processCreatedAt: Date.now(),
      dbPath: 'D:\\temp\\sender-test.db',
      entryPath: __filename,
      execPath: process.execPath,
      port: null,
      updatedAt: Date.now(),
    },
    requestTimeoutMs,
    shutdownTimeoutMs: 50,
    workerPath: 'D:\\fake\\wukongim-sender-worker.js',
    forkProcess(workerPath, args) {
      const child = new FakeSenderChild(10_000 + children.length, { hang });
      child.workerPath = workerPath;
      child.args = args;
      children.push(child);
      return child;
    },
    registerChild(...args) { registered.push(args); },
    unregisterChild(...args) { unregistered.push(args); },
  });
  return { sender, children, registered, unregistered };
}

test('sender manager isolates Agents while sharing concurrent startup per Agent', async () => {
  const fixture = createManagerFixture();
  const [a1, a2, b1] = await Promise.all([
    fixture.sender.send('agent-a', 'visitor-1', 'one'),
    fixture.sender.send('agent-a', 'visitor-2', 'two'),
    fixture.sender.send('agent-b', 'visitor-3', 'three'),
  ]);

  assert.equal(fixture.children.length, 2);
  assert.deepEqual([a1.messageId, a2.messageId, b1.messageId], [
    'agent-a:visitor-1',
    'agent-a:visitor-2',
    'agent-b:visitor-3',
  ]);
  const initializations = fixture.children.map((child) => (
    child.messages.find((message) => message.type === 'init')
  ));
  assert.deepEqual(
    initializations.map((message) => [message.agentId, message.config.uid]),
    [['agent-a', 'uid-a'], ['agent-b', 'uid-b']],
  );
  assert.equal(fixture.registered.length, 2);
  for (const child of fixture.children) {
    assert.ok(child.args.some((arg) => arg.startsWith('--voko-worker-token=')));
    assert.ok(child.args.includes('--voko-instance-id=instance-1'));
  }

  fixture.sender.disconnect('agent-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(fixture.children[0].exitCode, null);
  assert.equal(fixture.children[1].exitCode, null);
  assert.deepEqual(
    await fixture.sender.send('agent-b', 'visitor-4', 'still alive'),
    { success: true, messageId: 'agent-b:visitor-4' },
  );
  await fixture.sender.disconnectAll();
  assert.equal(fixture.unregistered.length, 2);
});

test('sender manager returns bounded failures for timeout and child crash', async () => {
  const timeoutFixture = createManagerFixture({ hang: true, requestTimeoutMs: 10 });
  assert.deepEqual(
    await timeoutFixture.sender.send('agent-a', 'visitor-1', 'timeout'),
    { success: false, error: 'WuKongIM sender request timeout' },
  );
  await timeoutFixture.sender.disconnectAll();

  const crashFixture = createManagerFixture({ hang: true });
  const pending = crashFixture.sender.send('agent-a', 'visitor-1', 'crash');
  await new Promise((resolve) => setImmediate(resolve));
  crashFixture.children[0].finish(1, null);
  assert.deepEqual(await pending, {
    success: false,
    error: 'WuKongIM sender exited with code 1',
  });
  await crashFixture.sender.disconnectAll();
});

test('sender manager rejects a persisted non-official IM endpoint before spawning', async () => {
  const fixture = createManagerFixture({ serverUrl: 'wss://attacker.example' });
  const result = await fixture.sender.send('agent-a', 'visitor-1', 'blocked');
  assert.equal(result.success, false);
  assert.equal(fixture.children.length, 0);
});

test('sender worker exits when its parent IPC channel disappears', async () => {
  const workerPath = path.join(
    __dirname,
    '../build/workers/wukongim-sender-worker.js',
  );
  const harness = [
    "const { fork } = require('node:child_process');",
    `const child = fork(${JSON.stringify(workerPath)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
    "child.on('message', (message) => {",
    "  if (message.type === 'ready') { console.log(child.pid); process.exit(0); }",
    "});",
    "child.send({ type: 'init', agentId: 'agent-a', config: {",
    "  uid: 'uid-a', token: 'token-a', serverUrl: 'ws://127.0.0.1:9'",
    "} });",
  ].join('\n');
  const parent = spawnSync(process.execPath, ['-e', harness], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(parent.status, 0, parent.stderr);
  const childPid = Number(parent.stdout.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);

  const deadline = Date.now() + 5_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `sender worker ${childPid} survived parent exit`);
});

test('Lite parent sender module never loads the singleton SDK', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/core/wukongim-sender.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /wukongimjssdk|WKSDK\.shared/);
});
