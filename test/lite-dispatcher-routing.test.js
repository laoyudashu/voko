const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../build/core/dispatcher');

function dbFor(deliveryModes) {
  return {
    prepare() {
      return {
        get: () => ({
          backend_type: 'openclaw',
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

test('dispatcher falls back to the next selected channel when primary push fails', async () => {
  const calls = [];
  const dispatcher = createDispatcher({
    db: dbFor(['websocket', 'cli', 'pull']),
    providers: {
      'openclaw-ws': provider('websocket', 100, calls, new Error('primary unavailable')),
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
    if (primaryFails) throw new Error('primary failed');
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
