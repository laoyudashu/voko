const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const {
  advanceCheckpoint,
  commitCheckpoint,
  getCheckpoint,
  migrateLegacyCheckpoints,
  setCheckpoint,
  stageCheckpoint,
} = require('../build/core/checkpoint-store');

test('checkpoint store stages and commits an opaque cursor', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    setCheckpoint(db, 'access_sync', 'agent-a', 'opaque', 'cursor-1');
    stageCheckpoint(db, 'access_sync', 'agent-a', 'opaque', 'cursor-2', { eventIds: ['event-2'] });
    let checkpoint = getCheckpoint(db, 'access_sync', 'agent-a');
    assert.equal(checkpoint.committedValue, 'cursor-1');
    assert.equal(checkpoint.pendingValue, 'cursor-2');
    assert.deepEqual(JSON.parse(checkpoint.pendingMeta), { eventIds: ['event-2'] });
    commitCheckpoint(db, 'access_sync', 'agent-a');
    checkpoint = getCheckpoint(db, 'access_sync', 'agent-a');
    assert.equal(checkpoint.committedValue, 'cursor-2');
    assert.equal(checkpoint.pendingValue, null);
  } finally {
    db.close();
  }
});

test('sequence checkpoints never move backwards', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    assert.equal(advanceCheckpoint(db, 'offline_messages', '["agent-a","room-a"]', 12), 12);
    assert.equal(advanceCheckpoint(db, 'offline_messages', '["agent-a","room-a"]', 8), 12);
    assert.equal(getCheckpoint(db, 'offline_messages', '["agent-a","room-a"]').committedValue, '12');
  } finally {
    db.close();
  }
});

test('legacy config cursors migrate idempotently without overwriting the new table', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run('agent_access_sync_cursors', JSON.stringify({ 'agent-a': 'legacy-cursor' }), Date.now());
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run('offline_sync_cursors', JSON.stringify({ '["agent-a","room-a"]': 18 }), Date.now());
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run('cursor:check_payments:agent-a', JSON.stringify(100), Date.now());
    setCheckpoint(db, 'access_sync', 'agent-a', 'opaque', 'new-cursor');

    assert.equal(migrateLegacyCheckpoints(db).migrated, 2);
    assert.equal(migrateLegacyCheckpoints(db).migrated, 0);
    assert.equal(getCheckpoint(db, 'access_sync', 'agent-a').committedValue, 'new-cursor');
    assert.equal(getCheckpoint(db, 'offline_messages', '["agent-a","room-a"]').committedValue, '18');
    const paymentCursor = getCheckpoint(db, 'mcp.check_payments', 'agent-a');
    assert.equal(paymentCursor.cursorKind, 'timestamp_id');
    assert.deepEqual(JSON.parse(paymentCursor.committedValue), { timestamp: 100, id: '' });
    assert.ok(db.prepare("SELECT data FROM config WHERE type='offline_sync_cursors'").get());
  } finally {
    db.close();
  }
});

test('schema v6 startup repairs a missing checkpoint table and migrates legacy config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-checkpoints-'));
  const dbPath = path.join(dir, 'voko.db');
  let db = initDatabase(dbPath, { silent: true });
  try {
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run('offline_sync_cursors', JSON.stringify({ '["agent-a","room-a"]': 21 }), Date.now());
    db.exec('DROP TABLE sync_checkpoints');
  } finally {
    db.close();
  }

  db = initDatabase(dbPath, { silent: true });
  try {
    assert.equal(getCheckpoint(db, 'offline_messages', '["agent-a","room-a"]').committedValue, '21');
    assert.ok(db.prepare("SELECT data FROM config WHERE type='offline_sync_cursors'").get());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
