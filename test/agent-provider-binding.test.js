const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { AgentProviderBindingService } = require('../build/core/agent-provider-binding');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, backend_type TEXT, backend_instance_id TEXT, updated_at INTEGER
  )`);
  return db;
}

test('registered backend type and non-empty instance are immutable, identical values are no-op', () => {
  const db = fixture();
  db.prepare('INSERT INTO agents VALUES (?,?,?,?)').run('a', 'openclaw', 'one', 0);
  const service = new AgentProviderBindingService(db);
  assert.deepStrictEqual(service.assertLockedUpdate('a', { backendType: 'openclaw', backendInstanceId: 'one' }), {
    backendType: 'openclaw', backendInstanceId: 'one',
  });
  assert.throws(() => service.assertLockedUpdate('a', { backendType: 'hermes' }), error => error.code === 'BACKEND_TYPE_LOCKED');
  assert.throws(() => service.assertLockedUpdate('a', { backendInstanceId: 'two' }), error => error.code === 'BACKEND_INSTANCE_LOCKED');
  db.close();
});

test('legacy unbound Agent binds once with an atomic conditional update', async () => {
  const db = fixture();
  db.prepare('INSERT INTO agents VALUES (?,?,NULL,?)').run('a', 'openclaw', 0);
  const service = new AgentProviderBindingService(db);
  const availableInstances = [{ id: 'one' }, { id: 'two' }];
  const first = await service.bindInstanceOnce('a', { backendInstanceId: 'one', availableInstances });
  assert.strictEqual(first.next.backendInstanceId, 'one');
  await assert.rejects(
    service.bindInstanceOnce('a', { backendInstanceId: 'two', availableInstances }),
    error => error.code === 'BACKEND_INSTANCE_LOCKED',
  );
  assert.strictEqual(db.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=?').get('a').backend_instance_id, 'one');
  db.close();
});

test('stale instance is rejected before the database write', async () => {
  const db = fixture();
  db.prepare('INSERT INTO agents VALUES (?,?,NULL,?)').run('a', 'openclaw', 0);
  await assert.rejects(
    new AgentProviderBindingService(db).bindInstanceOnce('a', {
      backendInstanceId: 'stale', availableInstances: [{ id: 'live' }],
    }),
    error => error.code === 'BACKEND_INSTANCE_UNAVAILABLE',
  );
  assert.strictEqual(db.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=?').get('a').backend_instance_id, null);
  db.close();
});
