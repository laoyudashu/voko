const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDispatcher } = require('../build/core/dispatcher');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');
const HermesCliProvider = require('../build/core/dispatcher/providers/hermes-cli');
const { MessageHandler } = require('../build/core/messenger');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const calls = [], statuses = [], replies = [];
  const provider = Object.assign(new EventEmitter(), { priority: 100, match: () => true, isAvailable: () => true,
    push: async payload => { calls.push(payload.messageId); }, stop() {}, ...overrides });
  const db = { prepare: () => ({ get: () => ({ backend_type: 'openclaw', backend_instance_id: 'synthetic',
    delivery_modes: '["websocket"]', imUid: 'agent_local' }), all: () => [], run: () => ({ changes: 1 }) }) };
  const dispatcher = createDispatcher({ db, providers: { 'openclaw-ws': provider },
    onTurnStatus: value => { statuses.push(value); }, onAgentReply: value => replies.push(value) });
  const payload = messageId => ({ agentId: 'agent', fromUid: 'visitor', channelId: 'visitor', channelType: 1, content: 'synthetic', messageId });
  return { dispatcher, provider, calls, statuses, replies, payload };
}

test('stop closes admission and distinguishes an active turn from its queued successor', async () => {
  const active = deferred();
  const f = fixture();
  f.provider.push = async payload => { f.calls.push(payload.messageId); await active.promise; };
  const ingress = { dispatcher: f.dispatcher, _notifyUI() {} };
  const returned = MessageHandler.prototype._dispatchInboundTurn.call(ingress, {
    turnId: 'active', items: [{ ...f.payload('active'), timestamp: Date.now() }],
    sourceMessageIds: ['active'], firstReceivedAt: Date.now(),
  });
  assert.equal(returned, undefined, 'production MessageHandler callback owns no Provider promise');
  f.dispatcher.dispatch('agent', f.payload('queued'));
  await tick();
  const stop = f.dispatcher.stop({ timeoutMs: 20 });
  f.dispatcher.dispatch('agent', f.payload('after-stop'));
  await stop;
  assert.deepEqual(f.calls, ['active']);
  assert.ok(f.statuses.some(value => value.turnId === 'active' && value.status === 'outcome_unknown'));
  assert.ok(f.statuses.some(value => value.turnId === 'queued' && value.status === 'failed' && value.code === 'DISPATCHER_STOPPED'));
  assert.ok(f.statuses.some(value => value.turnId === 'after-stop' && value.status === 'failed'));
  active.resolve();
  await tick();
  assert.deepEqual(f.calls, ['active']);
  f.provider.emit('agent.reply', { agentId: 'agent', visitorId: 'visitor', content: 'late synthetic reply', done: true, turnId: 'active' });
  assert.deepEqual(f.replies, []);
});

test('a stopped lifecycle cannot resume old queued work after dispatcher restart', async () => {
  const active = deferred(); const f = fixture();
  f.provider.push = async payload => { f.calls.push(payload.messageId); await active.promise; };
  f.dispatcher.dispatch('agent', f.payload('old-active'));
  f.dispatcher.dispatch('agent', f.payload('old-queued'));
  await tick(); await f.dispatcher.stop({ timeoutMs: 5 }); await f.dispatcher.start();
  active.resolve(); await tick();
  f.provider.emit('agent.reply', { agentId: 'agent', visitorId: 'visitor', content: 'old result', done: true, turnId: 'old-active' });
  assert.deepEqual(f.calls, ['old-active']);
  assert.deepEqual(f.replies, []);
});

test('stop settles an isolated caller even when its submitted Provider promise never settles', async () => {
  const active = deferred(); const f = fixture();
  f.provider.push = () => active.promise;
  const executing = f.dispatcher.executeE2ee({ agentId: 'agent', taskId: 'e2ee-task', contextId: 'e2ee-context',
    sessionScopeId: 'e2ee-scope', content: 'synthetic', timeoutMs: 10000 });
  const outcome = executing.then(() => 'completed', error => error.deliveryOutcome);
  await tick(); await f.dispatcher.stop({ timeoutMs: 5 });
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  active.resolve();
  assert.equal(result, 'outcome_unknown');
});

test('stop handles a synchronous status exception without unhandled rejection or a new submission', async () => {
  const f = fixture();
  const dispatcher = createDispatcher({ db: { prepare: () => ({ get: () => ({ backend_type: 'openclaw',
    delivery_modes: '["websocket"]' }), all: () => [] }) }, providers: { 'openclaw-ws': f.provider },
    onTurnStatus: () => { throw new Error('synthetic UI failure'); } });
  dispatcher.dispatch('agent', f.payload('queued'));
  await dispatcher.stop({ timeoutMs: 10 }); await tick();
  assert.deepEqual(f.calls, []);
});

test('stop waits for an in-flight route within its budget', async () => {
  const active = deferred(); const f = fixture({ push: () => active.promise });
  f.dispatcher.dispatch('agent', f.payload('active'));
  await tick();
  let stopped = false;
  const stopping = f.dispatcher.stop({ timeoutMs: 1000 }).then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  active.resolve(); await stopping;
  assert.equal(stopped, true);
});

test('a hanging provider stop is bounded and does not prevent stopping its peers', async () => {
  const active = deferred(); const f = fixture({ stop: () => active.promise });
  let peerStopped = false;
  await f.dispatcher.addProviders({ 'openclaw-cli': { stop() { peerStopped = true; } } });
  const result = await Promise.race([f.dispatcher.stop({ timeoutMs: 15 }).then(() => 'stopped'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 150))]);
  active.resolve();
  assert.equal(result, 'stopped');
  assert.equal(peerStopped, true);
});

test('stop cancels delayed A2A admission and retains an observable unsent status', async t => {
  // Use the production rate limiter with a deterministic clock, then stop before its timer.
  t.mock.method(Date, 'now', () => 1000000);
  const f = fixture();
  for (let i = 0; i < 8; i++) f.dispatcher.dispatch('agent', { ...f.payload(`a2a-${i}`),
    fromUid: 'agent_peer', senderUid: 'agent_peer', channelId: 'agent_peer', a2aDisposition: 'new_topic' });
  await tick();
  const before = f.calls.length;
  await f.dispatcher.stop({ timeoutMs: 10 });
  assert.ok(before < 8, 'fixture must reach the real A2A delay branch');
  assert.ok(f.statuses.some(value => value.code === 'DISPATCHER_STOPPED' && value.status === 'failed'));
});

test('stop rejects the E2EE A2A delay before any Provider accepts that task', async t => {
  t.mock.method(Date, 'now', () => 1000000);
  const f = fixture();
  for (let i = 0; i < 5; i++) f.dispatcher.dispatch('agent', { ...f.payload(`warm-${i}`),
    fromUid: 'agent_peer', senderUid: 'agent_peer', channelId: 'agent_peer', a2aDisposition: 'new_topic' });
  await tick();
  const executing = f.dispatcher.executeE2ee({ agentId: 'agent', taskId: 'delayed-e2ee', contextId: 'context',
    sessionScopeId: 'scope', content: 'synthetic', sourceType: 'agent_peer', peerUid: 'agent_peer', a2aDisposition: 'new_topic' });
  const rejected = assert.rejects(executing, error => error.code === 'DISPATCHER_STOPPED' && error.deliveryOutcome === 'not_delivered');
  await f.dispatcher.stop({ timeoutMs: 10 }); await rejected;
  assert.equal(f.calls.includes('delayed-e2ee'), false);
});

test('stopping WS releases waiting turns without allowing their send to start', async t => {
  t.mock.method(OpenClawWsProvider.prototype, 'loadConfig', () => true);
  t.mock.method(OpenClawWsProvider.prototype, 'startConfigWatcher', () => {});
  const p = new OpenClawWsProvider(null, null); p.connected = true;
  t.after(() => p.destroy());
  let sends = 0; p.sendToSession = async () => { sends++; };
  const payload = { agentId: 'a', fromUid: 'v', content: 'synthetic', messageId: 'first' };
  await p.push(payload);
  const queued = p.push({ ...payload, messageId: 'queued' });
  const rejected = assert.rejects(queued, error => error.deliveryOutcome === 'not_delivered');
  await tick(); await p.stop(); await rejected;
  assert.equal(sends, 1);
});

test('WS stop between acquiring the first turn and its send prevents submission', async t => {
  t.mock.method(OpenClawWsProvider.prototype, 'loadConfig', () => true);
  t.mock.method(OpenClawWsProvider.prototype, 'startConfigWatcher', () => {});
  const p = new OpenClawWsProvider(null, null); p.connected = true;
  t.after(() => p.destroy());
  let sends = 0; p.sendToSession = async () => { sends++; };
  const acquiring = p._acquireAgentTurn.bind(p);
  p._acquireAgentTurn = async (...args) => { const release = await acquiring(...args); await p.stop(); return release; };
  await assert.rejects(p.push({ agentId: 'a', fromUid: 'v', content: 'synthetic', messageId: 'first' }),
    error => error.deliveryOutcome === 'not_delivered');
  assert.equal(sends, 0);
});

test('Hermes stop prevents waiting profile work from starting after the active invocation finishes', async () => {
  const active = deferred(); let calls = 0;
  const p = new HermesCliProvider({ db: { prepare: () => ({ get: () => ({ backend_instance_id: 'synthetic-profile' }), all: () => [] }) },
    runCli: async () => { calls++; await active.promise; return { code: 0, stdout: 'synthetic reply', stderr: '' }; } });
  const payload = { agentId: 'a', fromUid: 'v', content: 'synthetic', messageId: 'first' };
  const first = p.push(payload);
  const second = p.push({ ...payload, messageId: 'queued' });
  const rejected = assert.rejects(second, error => error.deliveryOutcome === 'not_delivered');
  await tick(); p.stop(); active.resolve(); await first; await rejected;
  assert.equal(calls, 1);
});
