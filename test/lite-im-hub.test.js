'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { AgentWorkerManager } = require('../build/core/worker-manager');
const { VokoIMClient } = require('../build/im-sdk/client');

class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = 'idle';
    this.stats = { sent: 0, received: 0 };
  }
  async connect() { this.state = 'connected'; this.emit('connect', { state: this.state }); }
  disconnect() { this.state = 'disconnected'; this.emit('disconnect', { state: this.state }); }
  _sent(options = {}) {
    this.stats.sent += 1;
    const result = { reasonCode: 1, messageId: `remote-${this.stats.sent}`, messageSeq: this.stats.sent, clientMsgNo: options.clientMsgNo || `client-${this.stats.sent}` };
    this.emit('sent', result);
    return Promise.resolve(result);
  }
  sendText(_channelId, _channelType, _content, options) { return this._sent(options); }
  sendImage(_channelId, _channelType, _content, options) { return this._sent(options); }
  sendFile(_channelId, _channelType, _content, options) { return this._sent(options); }
}

function manager(capacity = 20) {
  return new AgentWorkerManager(null, {
    maxConnectionsPerHub: capacity,
    connectDelay: 0,
    clientFactory: (config) => new FakeClient(config),
  });
}

function config(uid) {
  return { uid, token: `token-${uid}`, serverUrl: 'wss://wukongim.vokovoko.com', ackMode: 'manual' };
}

test('shares Hubs and routes the 21st Agent to a second Hub', async () => {
  const transport = manager(20);
  await Promise.all(Array.from({ length: 21 }, (_, index) => transport.start(`agent-${index}`, config(`uid-${index}`))));
  const summary = transport.getHubSummary();
  assert.equal(summary.agentCount, 21);
  assert.equal(summary.hubCount, 2);
  assert.deepEqual(summary.hubs.map((hub) => hub.agentCount), [20, 1]);
  assert.equal(transport.getStatus('agent-20').hubIndex, 1);
  await transport.stopAll();
});

test('distributes 50 Agents across three production-capacity Hubs', async () => {
  const transport = manager(20);
  await transport.startMany(Array.from({ length: 50 }, (_, index) => ({
    agentId: `agent-${index}`,
    config: config(`uid-${index}`),
  })), { concurrency: 5, staggerMs: 0 });
  assert.deepEqual(transport.getHubSummary().hubs.map((hub) => hub.agentCount), [20, 20, 10]);
  await transport.stopAll();
});

test('stopping one Agent leaves other clients in the Hub connected', async () => {
  const transport = manager(20);
  await transport.start('agent-a', config('uid-a'));
  await transport.start('agent-b', config('uid-b'));
  await transport.stop('agent-a');
  assert.equal(transport.isRunning('agent-a'), false);
  assert.equal(transport.isRunning('agent-b'), true);
  assert.equal(transport.getHubSummary().agentCount, 1);
  await transport.stopAll();
});

test('delivery waits for SENDACK metadata and uses file contentType 8', async () => {
  const transport = manager();
  await transport.start('agent-a', config('uid-a'));
  const result = await transport.deliver(
    'agent-a', 'visitor-a', JSON.stringify({ url: 'https://files.example/a.pdf', name: 'a.pdf', size: 12, type: 'application/pdf' }),
    'file', 1, null, 'local-1',
  );
  assert.equal(result.success, true);
  assert.equal(result.clientMsgNo, 'local-1');
  assert.equal(result.messageSeq, 1);
  assert.equal(require('../build/im-sdk/messages').ContentType.File, 8);
  await transport.stopAll();
});

test('public compatibility methods start and stop only the selected Agent', async () => {
  const transport = manager();
  await transport.start('agent-a', config('uid-a'));
  await transport.start('agent-b', config('uid-b'));
  assert.equal(transport.workers.size, 2);
  await transport.stop('agent-a');
  assert.equal(transport.workers.has('agent-a'), false);
  assert.equal(transport.workers.has('agent-b'), true);
  await transport.stopAll();
});

test('waitForConnection reports the actual terminal connection state', async () => {
  const transport = manager();
  let state = 'connecting';
  transport.adapter.getStatus = () => ({ connected: state === 'connected', uid: 'uid-a', status: state });
  const pending = transport.waitForConnection('agent-a', 1000);
  setImmediate(() => { state = 'connected'; transport.adapter.emit('worker.status', { agentId: 'agent-a', status: 'connected' }); });
  const status = await pending;
  assert.equal(status.status, 'connected');
  assert.equal(status.connected, true);
  await transport.stopAll();
});

test('buffers manual-ACK messages until the VOKO persistence handler is attached', async () => {
  const transport = manager();
  await transport.start('agent-a', config('uid-a'));
  let acknowledged = 0;
  const client = transport.adapter.pool.get('agent-a');
  client.emit('message', {
    fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1,
    messageId: 'incoming-1', messageSeq: 1, clientMsgNo: 'client-1', timestamp: 1,
    contentType: 1, content: { type: 1, content: 'hello' },
    ack() { acknowledged += 1; },
    nack() {},
  });
  assert.equal(acknowledged, 0);
  const received = await new Promise((resolve) => transport.once('message', resolve));
  assert.equal(received.data.content, 'hello');
  assert.equal(typeof received.data.ack, 'function');
  received.data.ack();
  assert.equal(acknowledged, 1);
  await transport.stopAll();
});

test('inbound runtime logs metadata without leaking message content', async () => {
  const transport = manager();
  transport.on('message', () => {});
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    transport.adapter.emit('worker.message', {
      agentId: 'agent-a',
      data: {
        fromUid: 'visitor-a', channelId: 'visitor-a', channelType: 1,
        contentType: 1, messageSeq: 1, content: 'private-production-prompt',
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.some(line => line.includes('private-production-prompt')), false);
  assert.equal(lines.some(line => line.includes('contentLength=25')), true);
});

test('keeps the public start_worker and stop_worker tool names without duplicate start_im tools', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/mcp/server.ts'), 'utf8');
  assert.match(source, /'voko_start_worker'/);
  assert.match(source, /'voko_stop_worker'/);
  assert.doesNotMatch(source, /'voko_start_im'/);
  assert.doesNotMatch(source, /'voko_stop_im'/);
});

test('initial WebSocket code 1006 schedules reconnect instead of permanently failing authentication', async () => {
  const client = new VokoIMClient({
    uid: 'uid-a', token: 'token-a', serverUrl: 'wss://im.test',
    reconnectMinDelay: 1, reconnectMaxDelay: 1, reconnectJitter: 0,
    maxInitialConnectAttempts: 2,
  });
  let rejected = false;
  let opened = 0;
  client._connectReject = () => { rejected = true; };
  client._connectResolve = () => {};
  client.ws = {};
  client._open = () => { opened += 1; };

  client._onClose(1006, 'abnormal closure');
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(rejected, false);
  assert.equal(opened, 1);
  assert.equal(client.stats.reconnects, 1);
  client.disconnect();
});
