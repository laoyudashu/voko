const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');

function fixture(t) {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  db.prepare("INSERT OR REPLACE INTO config(type,data,updated_at) VALUES('current_user_email',?,0)")
    .run(JSON.stringify('owner@example.test'));
  for (const [id, owner] of [['a', 'owner@example.test'], ['b', 'other@example.test']]) {
    db.prepare(`INSERT INTO agents(id,agent_id,imUid,imToken,im_server_url,owner_email,created_at,updated_at)
      VALUES(?,?,?,'synthetic','',?,0,0)`).run(id, id, 'uid-' + id, owner);
  }
  const queries = [];
  const handlers = createToolHandlers({ db,
    query(sql, params = []) { queries.push({ sql, params }); return db.prepare(sql).all(...params); },
    exec: (sql, params = []) => db.prepare(sql).run(...params),
  });
  const conversation = (id, timestamp = 1, channelType = 1, name = id, agentId = 'a') => {
    db.prepare(`INSERT INTO conversations(user_uid,channel_id,channel_type,name,last_message,last_timestamp,unread_count,agent_id)
      VALUES(?,?,?,?,?,?,7,?)`).run('uid-' + agentId, id, channelType, name, 'stored summary', timestamp, agentId);
  };
  let counter = 0;
  const message = (channel, { timestamp = 1, isMe = 0, type = 1, content = 'visible', agentId = 'a', id, channelType = 1 } = {}) => {
    db.prepare(`INSERT INTO messages(id,from_uid,to_uid,content,channel_id,channel_type,agent_id,timestamp,is_me,status,content_type)
      VALUES(?,?,?,?,?,?,?,?,?,'received',?)`).run(id || 'synthetic-' + ++counter, channel, 'uid-' + agentId, content, channel, channelType, agentId, timestamp, isMe, type);
  };
  return { db, handlers, queries, conversation, message };
}

test('unreplied filter applies before count and pagination when the first twenty conversations are replied', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) { f.conversation('replied-' + i, 100 - i); f.message('replied-' + i, { isMe: 1 }); }
  f.conversation('pending', 1); f.message('pending');
  const pending = await f.handlers.list_conversations({ agentId: 'a' });
  assert.equal(pending.total, 1);
  assert.deepEqual(pending.conversations.map(c => c.channelId), ['pending']);
  const beyond = await f.handlers.list_conversations({ agentId: 'a', offset: 1 });
  assert.equal(beyond.total, 1);
  assert.deepEqual(beyond.conversations, []);
  const all = await f.handlers.list_conversations({ agentId: 'a', filter: 'all' });
  assert.equal(all.total, 21);
  assert.equal(all.conversations.length, 20);
  assert.equal(all.conversations[0].channelId, 'replied-0');
});

test('keyword and channel filters share the same relation for count and items, without cross-owner results', async (t) => {
  const f = fixture(t);
  f.conversation('private', 3, 1, 'match direct'); f.message('private');
  f.conversation('group', 2, 2, 'match group'); f.message('group', { channelType: 2 });
  f.conversation('no-keyword', 1); f.message('no-keyword');
  f.conversation('private', 4, 1, 'match foreign', 'b'); f.message('private', { agentId: 'b', isMe: 1, timestamp: 10 });
  const direct = await f.handlers.list_conversations({ agentId: 'a', keyword: 'match', channelType: 'direct' });
  assert.equal(direct.total, 1); assert.equal(direct.conversations[0].name, 'match direct');
  assert.equal(direct.conversations[0].needsReply, true);
  const group = await f.handlers.list_conversations({ agentId: 'a', keyword: 'match', channelType: 'group', filter: 'all' });
  assert.equal(group.total, 1);
  assert.deepEqual(group.conversations, [{ channelId: 'group', name: 'match group', lastMessage: 'stored summary',
    lastTimestamp: 2, unreadCount: 7, needsReply: false, channelType: 2 }]);
  const groupPending = await f.handlers.list_conversations({ agentId: 'a', channelType: 'group' });
  assert.equal(groupPending.total, 0); assert.deepEqual(groupPending.conversations, []);
  const denied = await f.handlers.list_conversations({ agentId: 'b', filter: 'all' });
  assert.equal(denied.success, false);
});

test('latest visible summaries retain rowid ties, system exclusions, empty conversation and timestamp-only unread counts', async (t) => {
  const f = fixture(t);
  f.conversation('tie', 200); f.conversation('empty', 300);
  f.message('tie', { isMe: 1, timestamp: 10, content: 'reply' });
  f.message('tie', { timestamp: 10, content: 'same timestamp later row', type: null });
  f.message('tie', { timestamp: 20, type: 11, content: 'intercepted' });
  f.message('tie', { timestamp: 30, isMe: 2, type: 10, content: 'system' });
  f.message('tie', { timestamp: 40, isMe: 1, id: 'e2ee-status-synthetic', content: 'legacy status' });
  const pending = await f.handlers.list_conversations({ agentId: 'a' });
  assert.equal(pending.total, 1);
  assert.deepEqual(pending.conversations[0], { channelId: 'tie', name: 'tie', lastMessage: 'same timestamp later row',
    lastTimestamp: 10, unreadCount: 1, needsReply: true, lastContentType: 1, lastIsMe: 0, channelType: 1 });
  // Existing count is timestamp-only and includes intercepted visitor rows after
  // the reply; the same-timestamp visible visitor is intentionally not counted.
  const all = await f.handlers.list_conversations({ agentId: 'a', filter: 'all' });
  assert.equal(all.total, 2);
  const empty = all.conversations.find(c => c.channelId === 'empty');
  assert.equal(empty.lastMessage, ''); assert.equal(empty.lastTimestamp, 300);
  assert.equal(empty.unreadCount, 0); assert.equal(empty.needsReply, false);
  assert.equal(empty.lastIsMe, undefined);
  f.message('tie', { timestamp: 10, isMe: 1, content: 'final reply at same timestamp' });
  assert.equal((await f.handlers.list_conversations({ agentId: 'a' })).total, 0);
});

test('list query count stays constant for a full page of unreplied conversations', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) { f.conversation('pending-' + i, i + 1); f.message('pending-' + i); }
  const result = await f.handlers.list_conversations({ agentId: 'a', limit: 100 });
  assert.equal(result.total, 100); assert.equal(result.conversations.length, 100);
  assert.ok(f.queries.length <= 4, `expected owner lookup + active owner + count + page queries, got ${f.queries.length}`);
});
