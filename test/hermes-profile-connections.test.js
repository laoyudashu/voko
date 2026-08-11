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
  assert.equal((await client.chat('one', 'session-one', 'visitor', 'hello')).reply, 'first');
  assert.equal((await client.chat('two', 'session-two', 'visitor', 'hello')).reply, 'second');
});

test('Hermes API client keeps profile selection separate from the exact VOKO session', async (t) => {
  const sessions = [];
  const server = http.createServer((req, res) => {
    sessions.push(req.headers['x-hermes-session-id']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new HermesApiClient({
    profiles: { shared: { port: server.address().port, apiKey: 'key' } },
  });

  await client.chat('shared', 'hermes:agent-a:group:one', 'group:one', 'first');
  await client.chat('shared', 'hermes:agent-b:group:one', 'group:one', 'second');
  await client.steer('shared', 'hermes:agent-a:group:one', 'group:one', 'owner');

  assert.deepEqual(sessions, [
    'hermes:agent-a:group:one',
    'hermes:agent-b:group:one',
    'hermes:agent-a:group:one',
  ]);
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
    async chat(profileId, sessionId, visitorId) {
      attempts++;
      assert.equal(profileId, 'profile-a');
      assert.equal(sessionId, 'hermes:agent-a:visitor');
      assert.equal(visitorId, 'visitor');
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

test('Hermes HTTP steer keeps the active binding session separate from its profile', async () => {
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: () => ({ backend_instance_id: 'shared-profile' }) }),
  }, null, { profiles: { 'shared-profile': { port: 8642, apiKey: 'key' } } });
  const calls = [];
  provider.connected = true;
  provider._ensureGatewayRunning = async () => true;
  provider.client = {
    async steer(...args) {
      calls.push(args);
      return { accepted: true, output: '', sessionKey: args[1] };
    },
  };
  await provider.steer('agent-a', 'visitor-a', 'owner', {
    turnId: 'turn-a',
    providerBinding: {
      providerType: 'hermes',
      providerInstanceId: 'shared-profile',
      nativeSessionId: 'hermes:agent-a:visitor-a',
    },
  });
  assert.deepEqual(calls[0].slice(0, 3), [
    'shared-profile',
    'hermes:agent-a:visitor-a',
    'visitor-a',
  ]);
});

test('Hermes never treats a missing backend instance or Agent UUID as a profile', async () => {
  const agentId = 'f08d57a7-6af4-4b5f-a543-7d143e64dc53';
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: () => ({ backend_instance_id: null }) }),
  }, null, {
    apiKey: 'legacy-key',
    profiles: { [agentId]: { port: 8642, apiKey: 'legacy-key' } },
  });

  assert.equal(provider._profileForAgent(agentId), null);
  assert.equal(provider.isProfileReady(agentId), false);
  assert.equal(await provider._ensureGatewayRunning(agentId), false);
  await assert.rejects(
    provider.sendToSession(`hermes:${agentId}:visitor`, 'hello'),
    /Hermes HTTP unavailable: agent is not bound to a Hermes profile/,
  );
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

test('Hermes HTTP coalesces duplicate turns and reports delivery lifecycle states', async () => {
  const agentId = 'hermes-agent';
  const provider = new HermesHttpProvider({
    prepare(sql) {
      return {
        get() {
          if (sql.includes('backend_instance_id')) return { backend_instance_id: 'profile-a' };
          return null;
        },
      };
    },
  }, null, {
    profiles: { 'profile-a': { port: 8642, apiKey: 'valid-key' } },
  });
  provider.connected = true;
  provider.connectedAgents = new Set(['profile-a']);
  provider._authStates.set('profile-a', true);
  let chats = 0;
  provider.client = {
    connected: true,
    _agentPort() { return 8642; },
    destroy() {},
    async chat() {
      chats += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { reply: 'ok', runId: 'run-1' };
    },
  };
  const statuses = [];
  provider.on('delivery.status', (status) => statuses.push(status));

  const extra = { messageId: 'message-1', turnId: 'turn-1', channelId: 'visitor-1', channelType: 1 };
  const first = provider.sendToSession(`${'hermes'}:${agentId}:visitor-1`, 'hello', extra);
  const second = provider.sendToSession(`${'hermes'}:${agentId}:visitor-1`, 'hello', extra);
  await Promise.all([first, second]);

  assert.equal(chats, 1);
  assert.deepEqual(statuses.map((item) => item.status), ['processing', 'deduplicated', 'completed']);
  assert.equal(statuses[0].agentId, agentId);
  assert.equal(statuses[0].channelId, 'visitor-1');
  await provider.destroy();
});

test('Hermes HTTP marks a timed-out turn pending without retrying it', async () => {
  const provider = new HermesHttpProvider({
    prepare(sql) {
      return {
        get() {
          if (sql.includes('backend_instance_id')) return { backend_instance_id: 'profile-a' };
          return null;
        },
      };
    },
  }, null, { profiles: { 'profile-a': { port: 8642, apiKey: 'valid-key' } } });
  provider.connected = true;
  provider.connectedAgents = new Set(['profile-a']);
  provider._authStates.set('profile-a', true);
  let chats = 0;
  provider.client = {
    connected: true,
    _agentPort() { return 8642; },
    destroy() {},
    async chat() {
      chats += 1;
      throw new Error('request timed out');
    },
  };
  const statuses = [];
  provider.on('delivery.status', (status) => statuses.push(status));

  await assert.rejects(
    provider.sendToSession('hermes:hermes-agent:visitor-1', 'hello', { messageId: 'message-timeout' }),
    /timed out/,
  );
  assert.equal(chats, 1);
  assert.equal(statuses.at(-1).status, 'pending');
  await provider.destroy();
});

test('Hermes HTTP does not reuse a binding from a different profile', async () => {
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: () => ({ backend_instance_id: 'profile-new' }) }),
  }, null, { profiles: { 'profile-new': { port: 8642, apiKey: 'key' } } });
  let sessionKey = '';
  provider.sendToSession = async (key) => { sessionKey = key; };
  const receipt = await provider.push({
    agentId: 'agent-a', fromUid: 'visitor-a', content: 'hello', messageId: 'message-a',
    providerBinding: {
      id: 'binding-old', bindingVersion: 1, providerType: 'hermes', providerInstanceId: 'profile-old',
      deliveryMode: 'http', adapterType: 'hermes-http', nativeSessionId: 'hermes:other-agent:visitor-a',
      sessionOrigin: 'voko_managed', channelId: 'visitor-a', channelType: 1,
    },
  });
  assert.equal(sessionKey, 'hermes:agent-a:visitor-a');
  assert.equal(receipt.providerInstanceId, 'profile-new');
  await provider.destroy();
});

test('Hermes HTTP does not retry an uncertain failure after a refreshed key', async () => {
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: () => ({ backend_instance_id: 'profile-a' }) }),
  }, null, { profiles: { 'profile-a': { port: 8642, apiKey: 'key' } } });
  provider.connected = true;
  provider._ensureGatewayRunning = async () => true;
  provider._selectAuthenticatedProfileConnection = async () => true;
  let restarts = 0;
  provider._restartGateway = async () => { restarts++; return true; };
  let chats = 0;
  provider.client = {
    destroy() {},
    async chat() {
      chats++;
      if (chats === 1) throw new Error('HTTP 401: stale key');
      throw new Error('request timed out');
    },
  };
  await assert.rejects(
    provider._sendToSession('hermes:agent-a:visitor-a', 'hello'),
    error => /timed out/.test(error.message) && error.deliveryOutcome === undefined,
  );
  assert.equal(chats, 2);
  assert.equal(restarts, 0);
  await provider.destroy();
});

test('Hermes HTTP marks a pre-delivery unavailable gateway as safe to fallback', async () => {
  const provider = new HermesHttpProvider({
    prepare: () => ({ get: () => ({ backend_instance_id: 'profile-a' }) }),
  }, null, { profiles: { 'profile-a': { port: 8642, apiKey: 'key' } } });
  provider.client = { destroy() {} };
  provider._ensureGatewayRunning = async () => false;
  await assert.rejects(
    provider._sendToSession('hermes:agent-a:visitor-a', 'hello'),
    error => error.deliveryOutcome === 'not_delivered',
  );
  await provider.destroy();
});
