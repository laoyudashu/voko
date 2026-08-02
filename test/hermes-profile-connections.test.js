const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { HermesApiClient } = require('../build/core/adapters/hermes-api-client');
const HermesHttpProvider = require('../build/core/dispatcher/providers/hermes-http');

async function keyServer(expectedKey, reply) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid key' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: reply, choices: [{ message: { content: reply } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('Hermes API client selects an independent key and port for each profile', async (t) => {
  const first = await keyServer('key-one', 'first');
  const second = await keyServer('key-two', 'second');
  t.after(() => first.close());
  t.after(() => second.close());
  const client = new HermesApiClient({
    apiKey: 'legacy-key',
    profiles: {
      one: { port: first.address().port, apiKey: 'key-one' },
      two: { port: second.address().port, apiKey: 'key-two' },
    },
  });
  assert.equal((await client.chat('one', 'visitor', 'hello')).reply, 'first');
  assert.equal((await client.chat('two', 'visitor', 'hello')).reply, 'second');
});

test('Hermes HTTP provider refreshes the selected profile key after a 401', async () => {
  let refreshEnabled = false;
  let savedConfig = JSON.stringify({ apiKey: 'legacy-key', profiles: { 'profile-a': { port: 8643, apiKey: 'old-key' } } });
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('backend_instance_id')) return { backend_instance_id: 'profile-a' };
          if (sql.includes('FROM config')) return { data: savedConfig };
          return null;
        },
        run(_type, data) { savedConfig = data; },
      };
    },
  };
  const provider = new HermesHttpProvider(db, null, {
    apiKey: 'legacy-key',
    profiles: { 'profile-a': { port: 8643, apiKey: 'old-key' } },
    profileConfigLoader: () => refreshEnabled ? { port: 8643, apiKey: 'new-key' } : null,
  });
  refreshEnabled = true;
  let attempts = 0;
  provider.client = {
    connected: true,
    profiles: {},
    _agentPort() { return 8643; },
    async ping() { return true; },
    setProfile(profileId, profile) { this.profiles[profileId] = profile; },
    async authenticate(profileId) { return this.profiles[profileId].apiKey === 'new-key'; },
    async chat() {
      attempts++;
      if (attempts === 1) throw new Error('HTTP 401: invalid key');
      assert.equal(this.profiles['profile-a'].apiKey, 'new-key');
      return { reply: 'ok', runId: 'run-1' };
    },
  };
  await provider.sendToSession('hermes:agent-a:visitor', 'hello');
  assert.equal(attempts, 2);
  assert.equal(provider.isProfileReady('agent-a'), true);
  assert.equal(JSON.parse(savedConfig).profiles['profile-a'].apiKey, 'new-key');
});

test('Hermes HTTP readiness is isolated per profile', () => {
  const profiles = {
    online: { port: 8642, apiKey: 'online-key' },
    offline: { port: 8643, apiKey: 'offline-key' },
  };
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: (agentId) => ({ backend_instance_id: agentId }), run() {} }),
  }, null, {
    profiles,
    profileConfigLoader: (profileId) => profiles[profileId] || null,
  });
  provider.connectedAgents = new Set(['online']);
  assert.equal(provider.isProfileReady('online'), true);
  assert.equal(provider.isProfileReady('offline'), false);
});

test('Hermes HTTP provider selects the first candidate that passes authenticated readiness', async () => {
  let savedConfig = JSON.stringify({ profiles: {} });
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM config')) return { data: savedConfig };
          return null;
        },
        run(_type, data) { savedConfig = data; },
      };
    },
  };
  const provider = new HermesHttpProvider(db, null, {
    profiles: { psychologist: { port: 8642, apiKey: 'stale-key' } },
    profileConfigLoader: () => [
      { port: 8642, apiKey: 'wrong-key', configPath: 'legacy/config.yaml' },
      { port: 8642, apiKey: 'valid-key', configPath: 'current/config.yaml' },
    ],
  });
  provider.client = {
    profiles: {},
    setProfile(profileId, profile) { this.profiles[profileId] = profile; },
    async authenticate(profileId) { return this.profiles[profileId].apiKey === 'valid-key'; },
  };

  assert.equal(await provider._selectAuthenticatedProfileConnection('psychologist'), true);
  assert.equal(provider.client.profiles.psychologist.apiKey, 'valid-key');
  assert.equal(provider._selectedConfigPaths.get('psychologist'), 'current/config.yaml');
  assert.equal(JSON.parse(savedConfig).profiles.psychologist.configPath, 'current/config.yaml');
});

test('Hermes HTTP provider marks only the profile unavailable when every candidate fails authentication', async () => {
  const provider = new HermesHttpProvider(null, null, {
    profiles: { psychologist: { port: 8642, apiKey: 'old-key' } },
    profileConfigLoader: () => [{ port: 8642, apiKey: 'wrong-key' }],
  });
  provider.client = {
    profiles: {},
    setProfile(profileId, profile) { this.profiles[profileId] = profile; },
    async authenticate() { return false; },
  };

  assert.equal(await provider._selectAuthenticatedProfileConnection('psychologist'), false);
  assert.equal(provider.isProfileReady('psychologist'), false);
});

test('Hermes HTTP provider reuses an authenticated profile without probing before every message', async () => {
  const provider = new HermesHttpProvider(null, null, {
    profiles: { psychologist: { port: 8642, apiKey: 'valid-key' } },
    profileConfigLoader: () => ({ port: 8642, apiKey: 'valid-key' }),
  });
  let authentications = 0;
  provider.client = {
    connected: false,
    profiles: {},
    _agentPort() { return 8642; },
    setProfile(profileId, profile) { this.profiles[profileId] = profile; },
    async authenticate() { authentications++; return true; },
  };

  assert.equal(await provider._ensureGatewayRunning('psychologist'), true);
  assert.equal(await provider._ensureGatewayRunning('psychologist'), true);
  assert.equal(authentications, 1);
});
