const test = require('node:test');
const assert = require('node:assert/strict');

const { initDatabase } = require('../build/core/database');
const { getCheckpoint } = require('../build/core/checkpoint-store');
const { setCheckpoint } = require('../build/core/checkpoint-store');
const { createToolHandlers } = require('../build/mcp/tools');

function setup() {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,owner_email,publish_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, ?,?)`)
    .run('row-a', 'agent-a', 'im-a', 'token-a', 'ws://localhost', 'owner@example.com', 'published', now, now);
  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('current_user_email', JSON.stringify('owner@example.com'), now);
  const cx = {
    db,
    query(sql, params = []) { return db.prepare(sql).all(...params); },
    exec(sql, params = []) { return db.prepare(sql).run(...params); },
  };
  return { db, handlers: createToolHandlers(cx) };
}

test('check_human_replies composite cursor does not skip rows sharing a timestamp', async () => {
  const { db, handlers } = setup();
  try {
    for (const id of ['event-a', 'event-b', 'event-c']) {
      db.prepare(`INSERT INTO owner_interventions
        (id,visitor_id,session_key,problem,ask_time,status,created_at,updated_at,agent_id)
        VALUES (?,?,?,?,?,'pending',?,?,?)`)
        .run(id, 'visitor-a', 'session-a', id, 1000, 1000, 1000, 'agent-a');
    }
    const first = await handlers.check_human_replies({ agentId: 'agent-a', limit: 2 });
    const second = await handlers.check_human_replies({ agentId: 'agent-a', limit: 2 });
    assert.deepEqual(first.interventions.map((row) => row.id), ['event-a', 'event-b']);
    assert.deepEqual(second.interventions.map((row) => row.id), ['event-c']);
    const checkpoint = getCheckpoint(db, 'mcp.check_human_replies', 'agent-a');
    assert.equal(checkpoint.cursorKind, 'timestamp_id');
    assert.deepEqual(JSON.parse(checkpoint.committedValue), { timestamp: 1000, id: 'event-c' });
  } finally {
    db.close();
  }
});

test('check_payments composite cursor does not skip rows sharing a timestamp', async () => {
  const { db, handlers } = setup();
  try {
    for (const id of ['payment-a', 'payment-b', 'payment-c']) {
      db.prepare(`INSERT INTO payment_orders
        (id,agent_id,visitor_id,amount,status,created_at,updated_at)
        VALUES (?,?,?,?,'paid',?,?)`)
        .run(id, 'agent-a', 'visitor-a', 1, 2000, 2000);
    }
    const first = await handlers.check_payments({ agentId: 'agent-a', limit: 2 });
    const second = await handlers.check_payments({ agentId: 'agent-a', limit: 2 });
    assert.deepEqual(first.orders.map((row) => row.orderId), ['payment-a', 'payment-b']);
    assert.deepEqual(second.orders.map((row) => row.orderId), ['payment-c']);
    const checkpoint = getCheckpoint(db, 'mcp.check_payments', 'agent-a');
    assert.equal(checkpoint.cursorKind, 'timestamp_id');
    assert.deepEqual(JSON.parse(checkpoint.committedValue), { timestamp: 2000, id: 'payment-c' });
  } finally {
    db.close();
  }
});

test('numeric timestamp checkpoints migrate in place without replaying older rows', async () => {
  const { db, handlers } = setup();
  try {
    setCheckpoint(db, 'mcp.check_human_replies', 'agent-a', 'sequence', 3000);
    for (const [id, timestamp] of [['event-old', 2000], ['event-new', 4000]]) {
      db.prepare(`INSERT INTO owner_interventions
        (id,visitor_id,session_key,problem,ask_time,status,created_at,updated_at,agent_id)
        VALUES (?,?,?,?,?,'pending',?,?,?)`)
        .run(id, 'visitor-a', 'session-a', id, timestamp, timestamp, timestamp, 'agent-a');
    }
    const result = await handlers.check_human_replies({ agentId: 'agent-a', limit: 10 });
    assert.deepEqual(result.interventions.map((row) => row.id), ['event-new']);
    const checkpoint = getCheckpoint(db, 'mcp.check_human_replies', 'agent-a');
    assert.equal(checkpoint.cursorKind, 'timestamp_id');
    assert.deepEqual(JSON.parse(checkpoint.committedValue), { timestamp: 4000, id: 'event-new' });
  } finally {
    db.close();
  }
});
