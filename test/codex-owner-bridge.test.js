const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexAppServerProvider } = require('../build/core/dispatcher/providers/codex-app-server');

function fakeRuntime() {
  return { resolve: () => ({ available: true, executable: process.execPath, argvPrefix: ['fake-codex.js'],
    runtimeKind: 'node-script', canonicalPath: 'fake-codex.js', pathEntries: [], resolvedAt: Date.now() }), invalidate() {} };
}

function harness() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
  const requests = [];
  let threadStarts = 0;
  child.stdin.on('data', data => {
    for (const line of String(data).trim().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line); requests.push(msg);
      if (!msg.method || msg.id == null) continue;
      let result = {};
      if (msg.method === 'initialize') result = { serverInfo: { name: 'codex', version: '0.145.0' } };
      if (msg.method === 'thread/start') result = { thread: { id: `thread-${++threadStarts}`, turns: [], status: { type: 'idle' } },
        model: 'test', modelProvider: 'test', cwd: 'C:/agent', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
      if (msg.method === 'thread/resume') result = { thread: { id: msg.params.threadId, turns: [], status: { type: 'idle' } },
        model: 'test', modelProvider: 'test', cwd: 'C:/agent', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
      if (msg.method === 'turn/start') result = { turn: { id: `turn-${threadStarts}`, items: [], status: 'inProgress' } };
      setImmediate(() => child.stdout.write(`${JSON.stringify({ id: msg.id, result })}\n`));
    }
  });
  const provider = new CodexAppServerProvider({ runtimeResolver: fakeRuntime(), spawnProcess: () => child,
    resolveAgentConfig: () => ({ cwd: 'C:/agent', profile: 'default' }) });
  return { child, provider, requests };
}

const context = Object.freeze({ authority: 'verified_owner_conversation', executionScope: 'owner_chat' });
const payload = { agentId: 'agent-1', fromUid: 'owner-chat:c1', channelId: 'c1', channelType: 1,
  messageId: 'message-1', turnId: 'message-1', content: '原始主人输入\n不要修改', rawContent: '原始主人输入\n不要修改' };

test('Codex Owner Bridge passes input verbatim and does not override native permissions', async t => {
  const h = harness(); t.after(() => h.provider.stop());
  const receipt = await h.provider.pushOwner(payload, context);
  assert.equal(receipt.nativeSessionId, 'thread-1');
  const start = h.requests.find(item => item.method === 'thread/start');
  assert.deepEqual(start.params, { cwd: 'C:/agent', ephemeral: false });
  assert.equal('sandbox' in start.params, false);
  assert.equal('approvalPolicy' in start.params, false);
  assert.equal('baseInstructions' in start.params, false);
  const turn = h.requests.find(item => item.method === 'turn/start');
  assert.equal(turn.params.input[0].text, payload.content);
  assert.equal(JSON.stringify(turn.params).includes('VOKO SECURITY'), false);
});

test('Codex Owner Bridge refuses remote execution without an explicit work directory', async t => {
  const h = harness(); t.after(() => h.provider.stop());
  h.provider.resolveAgentConfig = () => ({ cwd: null, profile: null });
  await assert.rejects(h.provider.pushOwner(payload, context), error => {
    assert.equal(error.code, 'OWNER_CODEX_WORKDIR_REQUIRED');
    assert.equal(error.deliveryOutcome, 'rejected');
    return true;
  });
  assert.equal(h.requests.length, 0);
});

test('Codex Owner Bridge streams ordered events and restores the exact thread', async t => {
  const h = harness(); t.after(() => h.provider.stop());
  const events = []; let reply;
  h.provider.on('owner.io-event', event => events.push(event));
  h.provider.on('agent.reply', value => { reply = value; });
  const receipt = await h.provider.pushOwner(payload, context);
  h.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: 'turn-1', delta: '你好' } })}\n`);
  h.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: 'turn-1', delta: '主人' } })}\n`);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply.content, '你好主人');
  assert.equal(reply.turnId, payload.turnId);
  assert.equal(reply.replyId, 'turn-1');
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events.map(event => event.type), ['turn.started', 'message.delta', 'message.delta', 'turn.completed']);

  const second = { ...payload, messageId: 'message-2', turnId: 'message-2', providerBinding: {
    id: 'owner:c1', bindingVersion: 1, providerType: 'codex', providerInstanceId: null,
    deliveryMode: 'owner_io', adapterType: 'codex-app-server', nativeSessionId: receipt.nativeSessionId,
    sessionOrigin: 'voko_managed', channelId: 'c1', channelType: 1, sourceScope: 'trusted_owner', strictSessionRoute: true,
  } };
  await h.provider.pushOwner(second, context);
  const resume = h.requests.find(item => item.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'thread-1');
});

test('Codex approval remains pending until an explicit Owner decision', async t => {
  const h = harness(); t.after(() => h.provider.stop());
  const events = []; h.provider.on('owner.io-event', event => events.push(event));
  await h.provider.pushOwner(payload, context);
  h.child.stdout.write(`${JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'write file', cwd: 'C:/agent', reason: 'write', startedAtMs: 1,
  } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.some(item => item.id === 900 && item.result), false);
  assert.equal(events.at(-1).type, 'approval.required');
  assert.equal(h.provider.respondOwnerApproval('item-1', 'accept'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests.find(item => item.id === 900).result, { decision: 'accept' });
});

test('Owner Chat cannot enter the generic isolated Provider path', async () => {
  const { createDispatcher } = require('../build/core/dispatcher');
  const db = { prepare: () => ({ get: () => ({ backend_type: 'codex', delivery_modes: '["cli","pull"]' }) }) };
  const dispatcher = createDispatcher({ db, providers: {} });
  await assert.rejects(dispatcher.executeIsolated({ agentId: 'agent-1', content: 'x', taskId: 'm', contextId: 'c',
    sourceType: 'owner_chat', executionScope: 'owner_chat' }), /OWNER_CHAT_REQUIRES_NATIVE_IO_BRIDGE/);
});
