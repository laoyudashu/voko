const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDispatcher } = require('../build/core/dispatcher');

function dbFor(deliveryModes, backendType = 'openclaw') {
  return {
    prepare() {
      return {
        get: () => ({
          backend_type: backendType,
          backend_instance_id: 'isolated-test',
          delivery_modes: JSON.stringify(deliveryModes),
          imUid: 'agent-uid',
        }),
        all: () => [],
        run: () => ({ changes: 1 }),
      };
    },
  };
}

function provider(name, priority, calls, failure = null) {
  return {
    priority,
    match: () => true,
    isAvailable: () => true,
    async push() {
      calls.push(name);
      if (failure) throw failure;
    },
  };
}

function eventProvider(name, priority, calls, available = true) {
  const value = new EventEmitter();
  value.priority = priority;
  value.available = available;
  value.match = () => true;
  value.isAvailable = () => value.available;
  value.push = async () => { calls.push(name); };
  return value;
}

function dispatchOnce(dispatcher) {
  dispatcher.dispatch('agent-1', {
    agentId: 'agent-1',
    fromUid: 'visitor-1',
    content: 'hello',
    channelId: 'visitor-1',
    messageId: 'message-1',
  });
}

test('dispatcher respects persisted delivery selection and explicit primary/backup order', async () => {
  const calls = [];
  const dispatcher = createDispatcher({
    db: dbFor(['cli', 'websocket', 'pull']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls),
      'openclaw-cli': provider('cli', 10, calls),
      'hermes-http': provider('unselected', 1000, calls),
    },
  });

  assert.equal(dispatcher.resolveProviders('agent-1').length, 2);
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['cli']);
});

test('dispatcher preserves attachment metadata without exposing its local path in every prompt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dispatch-attachment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'report.json');
  const bytes = Buffer.from('{"name":"transport-test"}');
  fs.writeFileSync(filePath, bytes);
  let received;
  const target = provider('websocket', 100, []);
  target.push = async payload => { received = payload; };
  const dispatcher = createDispatcher({ db: dbFor(['websocket'], 'openclaw'), providers: { 'openclaw-ws': target } });
  dispatcher.dispatch('agent-1', { agentId: 'agent-1', fromUid: 'visitor-1', content: 'inspect',
    channelId: 'visitor-1', messageId: 'attachment-message', attachments: [{ path: filePath, name: 'report.json',
      mediaType: 'application/json', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.attachments.length, 1);
  assert.doesNotMatch(received.content, /Voko attachment boundary/);
  assert.doesNotMatch(received.content, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('temporary delivery selection overrides persisted order without changing the database policy', async () => {
  const calls = [];
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli', 'pull']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls),
      'openclaw-cli': provider('cli', 10, calls),
    },
  });

  const selected = dispatcher.selectTemporaryDeliveryChannel('agent-1', 'cli', 'openclaw-cli');
  assert.equal(selected.temporaryPreferredMode, 'cli');
  assert.equal(selected.temporaryPreferredProvider, 'openclaw-cli');
  assert.deepEqual(selected.configuredModes, ['websocket', 'cli', 'pull']);
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['cli']);
});

test('temporary pull selection leaves new messages for on-demand pickup until restart', async () => {
  const calls = [];
  const dispatcher = createDispatcher({
    db: dbFor(['cli', 'pull'], 'codex'),
    providers: { 'codex-cli': provider('cli', 10, calls) },
  });

  const selected = dispatcher.selectTemporaryDeliveryChannel('agent-1', 'pull', null);
  assert.equal(selected.temporaryPreferredMode, 'pull');
  assert.equal(dispatcher.resolveProvider('agent-1'), null);
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test('explicit channel refresh detects a recovered CLI and makes it selectable', async () => {
  const calls = [];
  let available = false;
  let checks = 0;
  const cli = eventProvider('cli', 10, calls, false);
  cli.isAvailable = () => available;
  cli.healthCheck = () => { checks++; available = true; cli.available = true; };
  const dispatcher = createDispatcher({
    db: dbFor(['cli', 'pull'], 'codex'),
    providers: { 'codex-cli': cli },
  });

  assert.equal(dispatcher.getAgentDeliveryStatus('agent-1').activeAutomaticMode, null);
  const refreshed = await dispatcher.refreshAgentDeliveryChannels('agent-1');
  assert.equal(checks, 1);
  assert.equal(refreshed.activeAutomaticMode, 'cli');
  assert.equal(refreshed.methods.find(method => method.provider === 'codex-cli').available, true);
});

test('pull-only WorkBuddy still exposes its HTTP setup path and refreshes a newly installed runtime', async () => {
  let available = false;
  let runtimeRefreshes = 0;
  const http = eventProvider('http', 10, [], false);
  http.isAvailable = () => available;
  http.refreshRuntime = () => { runtimeRefreshes++; available = true; http.available = true; };
  http.healthCheck = () => ({ ok: true });
  http.runLoopbackTest = async () => ({ ok: true, challengeMatched: true, loopbackSessionId: 'workbuddy-test-session' });
  http.cleanupLoopbackSession = async () => ({ ok: true, cleaned: true });
  const dispatcher = createDispatcher({
    db: dbFor(['pull'], 'workbuddy'),
    providers: { 'workbuddy-http': http },
  });

  const initial = dispatcher.getAgentDeliveryStatus('agent-1');
  const method = initial.methods.find(item => item.provider === 'workbuddy-http');
  assert.equal(method.configured, false);
  assert.equal(method.available, false);
  assert.equal(initial.activeAutomaticMode, null);

  const refreshed = await dispatcher.refreshAgentDeliveryChannels('agent-1');
  const recovered = refreshed.methods.find(item => item.provider === 'workbuddy-http');
  assert.equal(runtimeRefreshes, 1);
  assert.equal(recovered.configured, false);
  assert.equal(recovered.available, true);
  assert.equal(refreshed.activeAutomaticMode, null);
  const verified = await dispatcher.verifyAgentDeliveryChannel('agent-1', 'workbuddy-http');
  assert.equal(verified.result.challengeMatched, true);
  const selected = dispatcher.selectTemporaryDeliveryChannel('agent-1', 'http', 'workbuddy-http');
  assert.equal(selected.temporaryPreferredMode, 'http');
  assert.equal(selected.temporaryPreferredProvider, 'workbuddy-http');
  assert.equal(selected.activeAutomaticMode, 'http');
});

test('explicit transport resolution never substitutes another mode', () => {
  const http = provider('http', 100, []);
  const cli = provider('cli', 10, []);
  const dispatcher = createDispatcher({
    db: dbFor(['http', 'cli', 'pull'], 'hermes'),
    providers: { 'hermes-http': http, 'hermes-cli': cli },
  });
  assert.equal(dispatcher.resolveProviderTransport('agent-1', 'hermes-http', 'http'), http);
  assert.equal(dispatcher.resolveProviderTransport('agent-1', 'hermes-http', 'cli'), null);
  assert.equal(dispatcher.resolveProviderTransport('agent-1', 'hermes-cli', 'http'), null);
  assert.equal(dispatcher.resolveProviderTransport('agent-1', 'openclaw-ws', 'websocket'), null);
});

test('delivery policy changes take effect on the next message after scoped invalidation', async () => {
  const calls = [];
  let modes = ['websocket', 'cli', 'pull'];
  const db = {
    prepare() {
      return {
        get: () => ({ backend_type: 'openclaw', backend_instance_id: 'isolated-test', delivery_modes: JSON.stringify(modes), imUid: 'agent-uid' }),
        all: () => [], run: () => ({ changes: 1 }),
      };
    },
  };
  const dispatcher = createDispatcher({
    db,
    providers: {
      'openclaw-ws': provider('websocket', 100, calls),
      'openclaw-cli': provider('cli', 10, calls),
    },
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  modes = ['cli', 'websocket', 'pull'];
  dispatcher.invalidateMeta('agent-1');
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['websocket', 'cli']);
  assert.equal(dispatcher.getAgentDeliveryStatus('agent-1').lastDeliveredMode, 'cli');
});

test('delivery diagnostics reports HTTP failure and CLI fallback without invoking delivery', () => {
  const dispatcher = createDispatcher({
    db: dbFor(['http', 'cli', 'pull']),
    providers: {
      'hermes-http': { ...provider('http', 100, []), isAvailable: () => false },
      'hermes-cli': provider('cli', 1, []),
    },
  });

  const status = dispatcher.getAgentDeliveryStatus('agent-1');
  assert.equal(status.automaticDeliveryReady, true);
  assert.equal(status.activeAutomaticMode, 'cli');
  assert.deepEqual(status.automaticReadyModes, ['cli']);
  assert.equal(status.pullReady, true);
  assert.equal(status.methods.find(method => method.mode === 'http').status, 'unavailable');
  assert.equal(status.methods.find(method => method.mode === 'pull').status, 'on-demand');
});

test('delivery diagnostics treats configured pull as an available on-demand receiver', () => {
  const dispatcher = createDispatcher({ db: dbFor(['pull']), providers: {} });
  const status = dispatcher.getAgentDeliveryStatus('agent-1');

  assert.equal(status.automaticDeliveryReady, false);
  assert.equal(status.activeAutomaticMode, null);
  assert.deepEqual(status.automaticReadyModes, []);
  assert.equal(status.pullReady, true);
  assert.equal(status.pullOnly, true);
  assert.equal(status.methods[0].status, 'on-demand');
  assert.equal(status.methods[0].family, 'openclaw');
  assert.equal(status.methods[0].reason, 'configured-on-demand');
});

test('delivery diagnostics preserves pull fallback for legacy rows without delivery modes', () => {
  const dispatcher = createDispatcher({ db: dbFor(null), providers: {} });
  const status = dispatcher.getAgentDeliveryStatus('agent-1');

  assert.equal(status.automaticDeliveryReady, false);
  assert.equal(status.activeAutomaticMode, null);
  assert.equal(status.pullReady, true);
  assert.equal(status.pullOnly, false);
  assert.equal(status.methods[0].configured, false);
  assert.equal(status.methods[0].status, 'fallback');
  assert.equal(status.methods[0].family, 'openclaw');
  assert.equal(status.methods[0].reason, 'legacy-fallback');
});

test('delivery diagnostics identifies a pull-only Provider family without probing a Push transport', () => {
  const dispatcher = createDispatcher({ db: dbFor(null, 'openhands'), providers: {} });
  const status = dispatcher.getAgentDeliveryStatus('agent-1');

  assert.equal(status.automaticDeliveryReady, false);
  assert.equal(status.pullReady, true);
  assert.equal(status.pullOnly, true);
  assert.deepEqual(status.configuredModes, ['pull']);
  assert.deepEqual(status.methods, [{
    mode: 'pull', provider: null, family: 'openhands', configured: false,
    available: true, status: 'fallback', reason: 'provider-pull-only',
  }]);
});

test('delivery diagnostics isolates provider probe failures and unknown configured modes', () => {
  const throwing = provider('http', 100, []);
  throwing.isAvailable = () => { throw new Error('probe failed'); };
  const dispatcher = createDispatcher({
    db: dbFor(['http', 'future-mode']),
    providers: { 'hermes-http': throwing },
  });
  const status = dispatcher.getAgentDeliveryStatus('agent-1');

  assert.equal(status.automaticDeliveryReady, false);
  assert.equal(status.activeAutomaticMode, null);
  assert.equal(status.methods.find(method => method.mode === 'http').status, 'unknown');
  assert.equal(status.methods.find(method => method.mode === 'future-mode').status, 'unknown');
});

test('dispatcher falls back to the next selected channel when primary push fails', async () => {
  const calls = [];
  const unavailable = new Error('primary unavailable');
  unavailable.deliveryOutcome = 'not_delivered';
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli', 'pull']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls, unavailable),
      'openclaw-cli': provider('cli', 10, calls),
    },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['websocket', 'cli']);
});

test('dispatcher remembers the successful provider and only redetects after it fails', async () => {
  const calls = [];
  const matches = { primary: 0, fallback: 0 };
  let primaryFails = false;
  const primary = provider('primary', 100, calls);
  primary.match = () => { matches.primary++; return true; };
  primary.push = async () => {
    calls.push('primary');
    if (primaryFails) {
      const error = new Error('primary failed');
      error.deliveryOutcome = 'not_delivered';
      throw error;
    }
  };
  const fallback = provider('fallback', 10, calls);
  fallback.match = () => { matches.fallback++; return true; };
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: { 'openclaw-ws': primary, 'openclaw-cli': fallback },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  const matchesAfterFirstDelivery = { ...matches };
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(matches, matchesAfterFirstDelivery);

  primaryFails = true;
  dispatchOnce(dispatcher);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['primary', 'primary', 'primary', 'fallback']);
  assert.ok(matches.primary > matchesAfterFirstDelivery.primary);
  assert.ok(matches.fallback > matchesAfterFirstDelivery.fallback);
});

test('dispatcher start selects the highest-priority available provider for each agent', async () => {
  const calls = [];
  let primaryReady = false;
  let primaryMatches = 0;
  const db = dbFor(['websocket', 'cli']);
  const originalPrepare = db.prepare;
  db.prepare = function prepare(sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql === 'SELECT agent_id FROM agents') statement.all = () => [{ agent_id: 'agent-1' }];
    return statement;
  };
  const primary = provider('primary', 100, calls);
  primary.start = async () => { primaryReady = true; };
  primary.isAvailable = () => primaryReady;
  primary.match = () => { primaryMatches++; return true; };
  const fallback = provider('fallback', 10, calls);
  const dispatcher = createDispatcher({
    db,
    providers: { 'openclaw-cli': fallback, 'openclaw-ws': primary },
  });

  await dispatcher.start();
  const matchesAfterStart = primaryMatches;
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['primary']);
  assert.equal(primaryMatches, matchesAfterStart);
});

test('availability recovery invalidates the fallback route and upgrades on the next message', async () => {
  const calls = [];
  const websocket = eventProvider('websocket', 100, calls, false);
  const cli = eventProvider('cli', 10, calls, true);
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: { 'openclaw-ws': websocket, 'openclaw-cli': cli },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  websocket.available = true;
  websocket.emit('availability', {
    providerId: 'openclaw-ws', agentId: 'agent-1', operations: ['push'], available: true, generation: 1,
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ['cli', 'websocket']);
});

test('provider recovery cannot override explicit delivery_modes order', async () => {
  const calls = [];
  const websocket = eventProvider('websocket', 100, calls, false);
  const cli = eventProvider('cli', 10, calls, true);
  const dispatcher = createDispatcher({
    db: dbFor(['cli', 'websocket']),
    providers: { 'openclaw-ws': websocket, 'openclaw-cli': cli },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  websocket.available = true;
  websocket.emit('availability', {
    providerId: 'openclaw-ws', agentId: 'agent-1', operations: ['push'], available: true, generation: 1,
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ['cli', 'cli']);
});

test('outcome_unknown is not retried through another provider', async () => {
  const calls = [];
  const unknown = new Error('request timed out after write');
  unknown.deliveryOutcome = 'outcome_unknown';
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls, unknown),
      'openclaw-cli': provider('cli', 10, calls),
    },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['websocket']);
});

test('rejected delivery is not retried even when the provider marks the channel unavailable', async () => {
  const calls = [];
  const rejected = new Error('provider rejected request');
  rejected.deliveryOutcome = 'rejected';
  rejected.channelUnavailable = true;
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls, rejected),
      'openclaw-cli': provider('cli', 10, calls),
    },
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['websocket']);
});

test('confirmed failure uses at most one fallback provider', async () => {
  const calls = [];
  const unavailable = () => {
    const error = new Error('channel unavailable');
    error.deliveryOutcome = 'not_delivered';
    return error;
  };
  const dispatcher = createDispatcher({
    db: dbFor(null),
    providers: {
      'openclaw-ws': provider('first', 30, calls, unavailable()),
      'openclaw-cli': provider('second', 20, calls, unavailable()),
      'hermes-http': provider('third', 10, calls),
    },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['first', 'second']);
});

test('stop and restart restores exactly one availability listener', async () => {
  const calls = [];
  const websocket = eventProvider('websocket', 100, calls, true);
  const dispatcher = createDispatcher({
    db: dbFor(['websocket']),
    providers: { 'openclaw-ws': websocket },
  });

  assert.equal(websocket.listenerCount('availability'), 1);
  await dispatcher.stop();
  assert.equal(websocket.listenerCount('availability'), 0);
  await dispatcher.start();
  await dispatcher.start();
  assert.equal(websocket.listenerCount('availability'), 1);
});

test('an older availability generation cannot revive a stale route', async () => {
  const calls = [];
  const websocket = eventProvider('websocket', 100, calls, true);
  const cli = eventProvider('cli', 10, calls, true);
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: { 'openclaw-ws': websocket, 'openclaw-cli': cli },
  });

  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  websocket.available = false;
  websocket.emit('availability', {
    agentId: 'agent-1', operations: ['push'], available: false, generation: 2,
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));
  websocket.available = true;
  websocket.emit('availability', {
    agentId: 'agent-1', operations: ['push'], available: true, generation: 1,
  });
  dispatchOnce(dispatcher);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ['websocket', 'cli', 'cli']);
});

test('availability invalidation keeps push and steer caches independent', async () => {
  const calls = [];
  const websocket = eventProvider('websocket-push', 100, calls, false);
  websocket.steer = async () => { calls.push('websocket-steer'); };
  const cli = eventProvider('cli-push', 10, calls, true);
  cli.steer = async () => { calls.push('cli-steer'); };
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli']),
    providers: { 'openclaw-ws': websocket, 'openclaw-cli': cli },
  });

  dispatchOnce(dispatcher);
  const steerResult = await dispatcher.steer('agent-1', 'visitor-1', 'owner message');
  assert.deepEqual(steerResult, { success: true, deliveryOutcome: 'delivered' });
  await new Promise(resolve => setImmediate(resolve));
  websocket.available = true;
  websocket.emit('availability', {
    agentId: 'agent-1', operations: ['push'], available: true, generation: 1,
  });
  dispatchOnce(dispatcher);
  await dispatcher.steer('agent-1', 'visitor-1', 'owner message 2');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ['cli-push', 'cli-steer', 'websocket-push', 'cli-steer']);
});

test('empty and pull-only delivery modes never select a push provider', async () => {
  for (const modes of [[], ['pull']]) {
    const calls = [];
    const dispatcher = createDispatcher({
      db: dbFor(modes),
      providers: { 'openclaw-ws': provider('websocket', 100, calls) },
    });
    dispatchOnce(dispatcher);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, []);
  }
});
