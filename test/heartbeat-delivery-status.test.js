const test = require('node:test');
const assert = require('node:assert/strict');

const { startHeartbeat } = require('../build/index');

function fakeDb() {
  const runtimeWrites = [];
  return {
    runtimeWrites,
    prepare(sql) {
      return {
        get() {
          if (/current_user_email|user_access_token/.test(sql)) return undefined;
          if (/type = 'runtime'/.test(sql)) return undefined;
          return undefined;
        },
        all() {
          if (/FROM agents/.test(sql)) return [{
            agent_id: 'hermes-agent', agent_name: 'Hermes Agent', imUid: 'im-hermes',
            backend_type: 'hermes', owner_email: '',
          }];
          return [];
        },
        run(data) {
          if (/type, data/.test(sql)) runtimeWrites.push(data);
          return { changes: 1 };
        },
      };
    },
  };
}

test('heartbeat posts for an IM-connected agent even when no backend delivery method is available', async () => {
  const db = fakeDb();
  let statusHandler;
  const agentManager = {
    connectedAgents: new Set(['hermes-agent']),
    getStatus: () => ({ connected: true, status: 'connected' }),
    getHubSummary: () => ({ hubCount: 1 }),
    on(event, handler) { if (event === 'status') statusHandler = handler; },
    off() {},
  };
  const dispatcher = {
    getAgentDeliveryStatus: () => ({
      backendType: 'hermes', configuredModes: ['http'], availableModes: [],
      activeMode: null, methods: [{ mode: 'http', provider: 'hermes-http', configured: true, available: false, status: 'unavailable' }],
      backendAvailable: false,
    }),
  };
  const previousFetch = global.fetch;
  let posts = 0;
  global.fetch = async () => { posts++; return { ok: true }; };
  const stop = startHeartbeat(db, agentManager, null, null, { dispatcher, agentCount: 1 });
  try {
    statusHandler({ status: 'connected' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(posts, 1);
    const runtime = JSON.parse(db.runtimeWrites.at(-1));
    assert.equal(runtime.agents[0].imConnected, true);
    assert.equal(runtime.agents[0].backendConnected, false);
    assert.deepEqual(runtime.agents[0].availableModes, []);
  } finally {
    stop();
    global.fetch = previousFetch;
  }
});
