const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  initDatabase,
  createDatabaseAPI,
  getHermesConfig,
  getUserAccessToken,
  loadUserAccessTokenConfig,
  saveUserAccessToken,
  SCHEMA_VERSION,
} = require('../build/core/database');

function createTestDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-boundary-'));
  const db = initDatabase(path.join(dir, 'test.db'), { silent: true });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('database initialization creates a missing parent directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-parent-'));
  const dbPath = path.join(root, 'config', 'voko', 'voko.db');
  const db = initDatabase(dbPath, { silent: true });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(dbPath), true);
  const schema = db.prepare("SELECT data FROM config WHERE type='schema_version'").get();
  assert.equal(JSON.parse(schema.data), SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const policyColumns = new Set(db.prepare('PRAGMA table_info(provider_security_policies)').all().map(row => row.name));
  assert.equal(policyColumns.has('runtime_evidence_json'), true);
  assert.equal(policyColumns.has('capability_digest'), true);
  assert.equal(policyColumns.has('probe_retry_after'), true);
  const agentPolicyColumns = new Set(db.prepare('PRAGMA table_info(provider_agent_security_policies)').all().map(row => row.name));
  assert.equal(agentPolicyColumns.has('provider_subject_key'), true);
  assert.equal(agentPolicyColumns.has('native_policy_digest'), true);
  assert.equal(agentPolicyColumns.has('pending_config_json'), true);
  const preflightColumns = new Set(db.prepare('PRAGMA table_info(provider_security_preflights)').all().map(row => row.name));
  assert.equal(preflightColumns.has('expected_capability_digest'), true);
  assert.equal(preflightColumns.has('expected_agent_revision'), true);
  const turnColumns = new Set(db.prepare('PRAGMA table_info(provider_security_turns)').all().map(row => row.name));
  assert.equal(turnColumns.has('runtime_fingerprint'), true);
  assert.equal(turnColumns.has('fallback_mode'), true);
  assert.equal(turnColumns.has('agent_policy_digest'), true);
});

test('current Lite accepts the shared schema v9 marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-shared-v8-'));
  const dbPath = path.join(root, 'voko.db');
  const first = initDatabase(dbPath, { silent: true });
  first.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  first.prepare("UPDATE config SET data=? WHERE type='schema_version'").run(JSON.stringify(SCHEMA_VERSION));
  first.close();

  const reopened = initDatabase(dbPath, { silent: true });
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(JSON.parse(reopened.prepare("SELECT data FROM config WHERE type='schema_version'").get().data), SCHEMA_VERSION);
  reopened.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test('database initialization migrates duration pricing to the canonical timed model', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-pricing-model-'));
  const dbPath = path.join(root, 'voko.db');
  const first = initDatabase(dbPath, { silent: true });
  const now = Date.now();
  first.prepare(`INSERT INTO agent_pricing
    (id, agent_id, pricing_model, price, duration_minutes, trial_minutes, enabled, created_at, updated_at)
    VALUES (?, ?, 'duration', ?, ?, ?, 1, ?, ?)`)
    .run('pricing-1', 'agent-1', 1, 60, 3, now, now);
  first.close();

  const reopened = initDatabase(dbPath, { silent: true });
  assert.equal(
    reopened.prepare('SELECT pricing_model FROM agent_pricing WHERE agent_id=?').get('agent-1').pricing_model,
    'timed',
  );
  reopened.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test('older code refuses a database with a newer schema marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-newer-schema-'));
  const dbPath = path.join(root, 'voko.db');
  const first = initDatabase(dbPath, { silent: true });
  first.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  first.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => initDatabase(dbPath, { silent: true }), /newer than supported/);
});

test('legacy database is backed up and migrated only once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-legacy-'));
  const dbPath = path.join(root, 'voko.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY)');
  legacy.close();

  const migrated = initDatabase(dbPath, { silent: true });
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  migrated.close();
  const backupPath = `${dbPath}.pre-schema-v${SCHEMA_VERSION}.bak`;
  assert.equal(fs.existsSync(backupPath), true);
  const backupMtime = fs.statSync(backupPath).mtimeMs;

  const reopened = initDatabase(dbPath, { silent: true });
  reopened.close();
  assert.equal(fs.statSync(backupPath).mtimeMs, backupMtime);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test('invalid channel config shape falls back to the default channel', (t) => {
  const db = createTestDatabase(t);
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run('channel_config', JSON.stringify({ channels: [{ name: 123, enabled: 'yes' }] }), Date.now());

  const api = createDatabaseAPI(db);
  assert.deepEqual(api.getChannelConfig(), {
    channels: [{ name: 'voko-email', enabled: true }],
  });
});

test('message row mapping preserves the public database API shape', (t) => {
  const db = createTestDatabase(t);
  const api = createDatabaseAPI(db);
  const saved = api.saveMessage({
    id: 'message-1',
    channelId: 'visitor-1',
    channelType: 1,
    fromUid: 'visitor-1',
    toUid: 'agent-1',
    content: ' hello ',
    timestamp: 1234,
    isMe: false,
    status: 'received',
    messageSeq: 7,
    clientMsgNo: 'client-1',
    contentType: 1,
    agentId: 'agent-1',
  });
  assert.equal(saved.success, true);

  assert.deepEqual(api.getMessages('visitor-1'), [{
    id: 'message-1',
    channelId: 'visitor-1',
    channelType: 1,
    fromUid: 'visitor-1',
    toUid: 'agent-1',
    content: 'hello',
    timestamp: 1234,
    isMe: false,
    status: 'received',
    agentId: 'agent-1',
    messageSeq: 7,
    clientMsgNo: 'client-1',
    noPersist: 0,
    redDot: 0,
    syncOnce: 0,
    contentType: 1,
  }]);
});

test('user access token config normalizes legacy strings and rejects malformed entries', (t) => {
  const db = createTestDatabase(t);
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run('user_access_token', JSON.stringify({
      'legacy@example.com': 'legacy-token',
      'valid@example.com': { user_access_token: 'valid-token', updated_at: 123 },
      'missing@example.com': { updated_at: 456 },
      'invalid@example.com': 42,
    }), Date.now());

  assert.deepEqual(loadUserAccessTokenConfig(db), {
    'legacy@example.com': { user_access_token: 'legacy-token' },
    'valid@example.com': { user_access_token: 'valid-token', updated_at: 123 },
  });
  assert.equal(getUserAccessToken(db, ' LEGACY@EXAMPLE.COM '), 'legacy-token');
  assert.equal(getUserAccessToken(db, 'missing@example.com'), null);

  saveUserAccessToken(db, ' New@Example.com ', 'new-token');
  const savedConfig = loadUserAccessTokenConfig(db);
  assert.deepEqual(Object.keys(savedConfig), ['new@example.com']);
  assert.equal(savedConfig['new@example.com'].user_access_token, 'new-token');
  assert.equal(typeof savedConfig['new@example.com'].updated_at, 'number');
});

test('Hermes config flattens the legacy nested config and persists the canonical shape', (t) => {
  const db = createTestDatabase(t);
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run('hermes_config', JSON.stringify({
      hermes_config: {
        apiKey: 'hermes-key',
        profiles: [{ id: 'profile-1' }],
      },
    }), Date.now());

  assert.deepEqual(getHermesConfig(db), {
    apiKey: 'hermes-key',
    profiles: [{ id: 'profile-1' }],
  });
  const saved = db.prepare('SELECT data FROM config WHERE type = ?').get('hermes_config');
  assert.deepEqual(JSON.parse(saved.data), {
    apiKey: 'hermes-key',
    profiles: [{ id: 'profile-1' }],
  });
});

test('standalone default database is named voko.db on every platform', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const smokeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'testing', 'smoke-all.js'), 'utf8');
  const proxySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'stdio-proxy.ts'), 'utf8');
  const combined = [entrySource, smokeSource, proxySource].join('\n');

  assert.doesNotMatch(combined, /wukongim\.db/i);
  assert.equal((entrySource.match(/voko\.db/g) || []).length, 3);
  assert.match(smokeSource, /voko\.db/);
  assert.match(proxySource, /voko\.db/);
});

test('legacy session handles migrate to channel-scoped uniqueness', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-session-migration-'));
  const dbPath = path.join(dir, 'voko.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE agent_session_handles (
      agent_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_handle TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, visitor_id)
    )
  `);
  legacy.prepare(`
    INSERT INTO agent_session_handles
      (agent_id, visitor_id, adapter_type, session_handle, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('agent-a', 'visitor-a', 'legacy-acp', 'session-a', 1);
  legacy.close();

  const db = initDatabase(dbPath, { silent: true });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.prepare(`
    INSERT INTO agent_session_handles
      (agent_id, visitor_id, adapter_type, session_handle, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('agent-a', 'visitor-a', 'opencode-attach', 'session-b', 2);

  const rows = db.prepare(`
    SELECT adapter_type, session_handle
    FROM agent_session_handles
    WHERE agent_id=? AND visitor_id=?
    ORDER BY adapter_type
  `).all('agent-a', 'visitor-a');
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { adapter_type: 'legacy-acp', session_handle: 'session-a' },
    { adapter_type: 'opencode-attach', session_handle: 'session-b' },
  ]);
});
