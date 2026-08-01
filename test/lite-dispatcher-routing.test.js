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
