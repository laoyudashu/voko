const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { AgentDeliveryPolicyStore, normalizeDeliveryModes } = require('../build/core/agent-delivery-policy');

function createAgent(db) {
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode,
     backend_type, backend_instance_id, delivery_modes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'published', 'private', ?, ?, ?, ?, ?)`)
    .run('row-policy', 'agent-policy', 'im-policy', 'token', 'wss://example.test',
      'hermes', 'profile-a', JSON.stringify(['http', 'pull']), now, now);
}

test('delivery policy normalizes modes and always keeps Pull', () => {
  assert.deepEqual(normalizeDeliveryModes(['cli', 'cli']), ['cli', 'pull']);
  assert.throws(() => normalizeDeliveryModes(['http;rm']), /invalid delivery mode/);
});

test('delivery modes update while provider type and bound instance stay locked', () => {
  const db = initDatabase(':memory:', { silent: true });
  createAgent(db);
  const store = new AgentDeliveryPolicyStore(db);
  const result = store.update('agent-policy', {
    backendType: 'hermes', backendInstanceId: 'profile-a', deliveryModes: ['cli', 'websocket'],
  });
  assert.deepEqual(result.previous.deliveryModes, ['http', 'pull']);
  assert.equal(result.next.backendType, 'hermes');
  assert.equal(result.next.backendInstanceId, 'profile-a');
  assert.deepEqual(result.next.deliveryModes, ['cli', 'websocket', 'pull']);
  db.close();
});

test('bound provider instance cannot change after registration', () => {
  const db = initDatabase(':memory:', { silent: true });
  createAgent(db);
  const store = new AgentDeliveryPolicyStore(db);
  assert.throws(() => store.update('agent-policy', {
    backendType: 'hermes', backendInstanceId: 'instance-b', deliveryModes: ['http'],
  }), /Agent 已绑定的实例不能更改/);
  db.close();
});

test('provider type cannot change after registration', () => {
  const db = initDatabase(':memory:', { silent: true });
  createAgent(db);
  const store = new AgentDeliveryPolicyStore(db);
  assert.throws(() => store.update('agent-policy', {
    backendType: 'openclaw', backendInstanceId: 'instance-b', deliveryModes: ['cli'],
  }), /Agent 注册完成后不能更改类型/);
  const current = store.get('agent-policy');
  assert.equal(current.backendType, 'hermes');
  assert.equal(current.backendInstanceId, 'profile-a');
  assert.deepEqual(current.deliveryModes, ['http', 'pull']);
  db.close();
});

test('invalid policy input leaves all route fields unchanged', () => {
  const db = initDatabase(':memory:', { silent: true });
  createAgent(db);
  const store = new AgentDeliveryPolicyStore(db);
  assert.throws(() => store.update('agent-policy', {
    backendType: 'hermes', backendInstanceId: 'profile-a', deliveryModes: ['bad mode'],
  }), /invalid delivery mode/);
  const current = store.get('agent-policy');
  assert.equal(current.backendType, 'hermes');
  assert.equal(current.backendInstanceId, 'profile-a');
  assert.deepEqual(current.deliveryModes, ['http', 'pull']);
  db.close();
});
