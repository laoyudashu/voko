const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  PENDING_OWNER_SWITCH_CONFIG,
  OWNER_SWITCH_RESTART_NOTICE_CONFIG,
  stagePendingOwnerSwitch,
  readPendingOwnerSwitch,
  activatePendingOwnerSwitch,
  buildReplacementArgs,
  spawnReplacementProcess,
} = require('../build/core/owner-switch');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config (
    type TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

function readConfig(db, type) {
  const row = db.prepare('SELECT data FROM config WHERE type=?').get(type);
  return row ? JSON.parse(row.data) : null;
}

test('owner switch stages credentials without changing the active owner', () => {
  const db = createDb();
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('current_user_email', JSON.stringify('old@example.com'), 1);
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('user_access_token', JSON.stringify({ 'old@example.com': { user_access_token: 'ut_old' } }), 1);

  stagePendingOwnerSwitch(db, ' New@Example.com ', 'ut_new');

  assert.equal(readConfig(db, 'current_user_email'), 'old@example.com');
  assert.equal(readConfig(db, 'user_access_token')['old@example.com'].user_access_token, 'ut_old');
  assert.deepEqual(readPendingOwnerSwitch(db), {
    email: 'new@example.com',
    user_access_token: 'ut_new',
    updated_at: readConfig(db, PENDING_OWNER_SWITCH_CONFIG).updated_at,
  });
  db.close();
});

test('owner switch activates pending credentials atomically and leaves a startup notice', () => {
  const db = createDb();
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('current_user_email', JSON.stringify('old@example.com'), 1);
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('user_access_token', JSON.stringify({ 'old@example.com': { user_access_token: 'ut_old' } }), 1);
  stagePendingOwnerSwitch(db, 'new@example.com', 'ut_new');

  assert.deepEqual(activatePendingOwnerSwitch(db), {
    activated: true,
    ownerChanged: true,
    tokenChanged: true,
  });
  assert.equal(readConfig(db, 'current_user_email'), 'new@example.com');
  assert.equal(readConfig(db, 'user_access_token')['new@example.com'].user_access_token, 'ut_new');
  assert.equal(readConfig(db, PENDING_OWNER_SWITCH_CONFIG), null);
  assert.ok(readConfig(db, OWNER_SWITCH_RESTART_NOTICE_CONFIG).created_at > 0);
  db.close();
});

test('same owner and token consume pending credentials without requesting restart', () => {
  const db = createDb();
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('current_user_email', JSON.stringify('owner@example.com'), 1);
  db.prepare('INSERT INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('user_access_token', JSON.stringify({ 'owner@example.com': { user_access_token: 'ut_same' } }), 1);
  stagePendingOwnerSwitch(db, 'owner@example.com', 'ut_same');

  assert.deepEqual(activatePendingOwnerSwitch(db), {
    activated: true,
    ownerChanged: false,
    tokenChanged: false,
  });
  assert.equal(readConfig(db, OWNER_SWITCH_RESTART_NOTICE_CONFIG), null);
  db.close();
});

test('a concurrent switch cannot replace a different pending owner', () => {
  const db = createDb();
  stagePendingOwnerSwitch(db, 'first@example.com', 'ut_first');

  assert.throws(
    () => stagePendingOwnerSwitch(db, 'second@example.com', 'ut_second'),
    (error) => error.code === 'OWNER_SWITCH_IN_PROGRESS' && error.status === 409,
  );
  assert.equal(readPendingOwnerSwitch(db).email, 'first@example.com');
  db.close();
});

test('replacement process preserves arguments and enforces headless startup', () => {
  assert.deepEqual(
    buildReplacementArgs(['node', 'index.js', 'start', '--port', '3110', '--open']),
    ['start', '--port', '3110', '--no-open', '--no-interactive'],
  );

  let observed;
  let unrefCalled = false;
  const result = spawnReplacementProcess({
    argv: ['node', 'index.js', 'start', '--port', '3110'],
    execPath: 'C:\\runtime\\node.exe',
    entryPath: 'C:\\app\\build\\index.js',
    cwd: 'C:\\app',
    env: { TEST_ONLY: '1' },
    spawnImpl(command, args, options) {
      observed = { command, args, options };
      return { pid: 4321, unref() { unrefCalled = true; } };
    },
  });

  assert.equal(result.pid, 4321);
  assert.equal(unrefCalled, true);
  assert.equal(observed.command, 'C:\\runtime\\node.exe');
  assert.deepEqual(observed.args, [
    'C:\\app\\build\\index.js', 'start', '--port', '3110', '--no-open', '--no-interactive',
  ]);
  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.stdio, 'ignore');
});
