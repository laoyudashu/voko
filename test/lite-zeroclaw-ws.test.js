const test = require('node:test');
const assert = require('node:assert/strict');

const { AcpAdapter } = require('../build/core/adapters/acp-adapter');
const {
  ZeroClawWsProvider,
  configuredUrl,
} = require('../build/core/dispatcher/providers/zeroclaw-ws');

function aliasDb(alias = 'voko_test') {
  return {
    prepare(sql) {
      assert.match(sql, /backend_instance_id/);
      return { get: () => ({ backend_instance_id: alias }) };
    },
  };
}

test('ZeroClaw WebSocket provider requires a loopback URL, token and agent alias', () => {
  const previous = {
    url: process.env.ZEROCLAW_ACP_URL,
    token: process.env.ZEROCLAW_ACP_TOKEN,
  };
  try {
    process.env.ZEROCLAW_ACP_URL = 'ws://127.0.0.1:42617/acp';
    process.env.ZEROCLAW_ACP_TOKEN = 'paired-test-token';
    const provider = new ZeroClawWsProvider({ db: aliasDb() });
    assert.equal(provider.priority, 20);
    assert.equal(provider._adapterType, 'zeroclaw-ws');
    assert.equal(provider.isAvailable('agent-voko'), true);
    assert.deepEqual(provider.options.sessionRequest('agent-voko'), { agentAlias: 'voko_test' });

    process.env.ZEROCLAW_ACP_URL = 'ws://192.168.1.10:42617/acp';
    assert.equal(configuredUrl(), null);
    assert.equal(provider.isAvailable('agent-voko'), false);

    process.env.ZEROCLAW_ACP_URL = 'ws://127.0.0.1:42617/acp?token=leak';
    assert.equal(configuredUrl(), null);
  } finally {
    if (previous.url === undefined) delete process.env.ZEROCLAW_ACP_URL;
    else process.env.ZEROCLAW_ACP_URL = previous.url;
    if (previous.token === undefined) delete process.env.ZEROCLAW_ACP_TOKEN;
    else process.env.ZEROCLAW_ACP_TOKEN = previous.token;
  }
});

test('ZeroClaw WebSocket preflight reports missing configuration without probing the network', async () => {
  const previousToken = process.env.ZEROCLAW_ACP_TOKEN;
  try {
    delete process.env.ZEROCLAW_ACP_TOKEN;
    const provider = new ZeroClawWsProvider({ db: aliasDb() });
    const result = await provider.preflightDelivery('agent-voko');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'configuration_required');
    assert.deepEqual(result.missing, ['ZEROCLAW_ACP_TOKEN']);
    assert.equal(result.sideEffects, false);
  } finally {
    if (previousToken === undefined) delete process.env.ZEROCLAW_ACP_TOKEN;
    else process.env.ZEROCLAW_ACP_TOKEN = previousToken;
  }
});

test('ACP client denies tool permission requests by default', async () => {
  let permissionHandler;
  let initialization;
  const adapter = new AcpAdapter({
    streamFactory: async () => ({ stream: {} }),
    connectionKey: () => 'shared',
  });
  adapter._acpSdk = {
    PROTOCOL_VERSION: 1,
    methods: {
      agent: { initialize: 'initialize', session: { resume: 'session/resume' } },
      client: { session: { requestPermission: 'session/request_permission' } },
    },
    client() {
      return {
        onRequest(_method, handler) {
          permissionHandler = handler;
          return this;
        },
        async connectWith(_stream, callback) {
          await callback({ request: async (method, params) => {
            initialization = { method, params };
            return {};
          } });
        },
      };
    },
  };

  await adapter._ensureAgent('agent-a');
  assert.deepEqual(initialization, {
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  assert.deepEqual(
    permissionHandler({ params: { sessionId: 's1', options: [{ optionId: 'allow' }] } }),
    { outcome: { outcome: 'cancelled' } },
  );
  await adapter.stop();
});
