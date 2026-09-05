'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');
const access = require('../build/core/access-control-api');

function fixture(t) {
  const db = initDatabase(':memory:', { silent: true });
  t.after(() => db.close());
  db.prepare("INSERT OR REPLACE INTO config(type,data,updated_at) VALUES('current_user_email',?,1)")
    .run(JSON.stringify('owner@example.invalid'));
  for (const [id, owner] of [['a', ' Owner@Example.Invalid '], ['a2', 'owner@example.invalid'], ['b', 'other@example.invalid']]) {
    db.prepare(`INSERT INTO agents(id,agent_id,owner_email,imUid,imToken,im_server_url,created_at,updated_at)
      VALUES(?,?,?,?,'synthetic','',1,1)`).run(id, id, owner, 'uid-' + id);
  }
  const handlers = createToolHandlers({ db,
    query: (sql, params = []) => db.prepare(sql).all(...params),
    exec: (sql, params = []) => db.prepare(sql).run(...params),
  });
  const entry = (id, agentId = 'a', listType = 'whitelist', source = 'manual', serverManaged = 0) => {
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,source,manual_managed,server_managed,auto_trust_disabled,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,0,1,1)`).run(id, agentId, listType, 'visitor-' + id, source, serverManaged);
  };
  return { db, handlers, entry };
}

for (const reply of ['不同意', '不通过', '不OK', '“同意”', '他说同意，我不同意', '好的，但不要批准', 'token']) {
  test(`friend request does not grant access for ambiguous or negative reply: ${reply}`, t => {
    const { db } = fixture(t); let notices = 0;
    access.autoApproveIfFriendRequest(db, () => notices++, { id: 'private_req_synthetic', agentId: 'a', visitorId: 'visitor' }, reply);
    assert.equal(access.isWhitelisted(db, 'a', 'visitor'), false);
    assert.equal(notices, 0);
  });
}

test('explicit friend approval is idempotent and ordinary interventions never grant', t => {
  const { db } = fixture(t); let notices = 0;
  const intervention = { id: 'private_req_synthetic', agentId: 'a', visitorId: 'visitor' };
  assert.equal(access.autoApproveIfFriendRequest(db, () => notices++, intervention, ' 同意 '), true);
  assert.equal(access.autoApproveIfFriendRequest(db, () => notices++, intervention, 'OK'), true);
  assert.equal(notices, 1);
  assert.equal(access.isWhitelisted(db, 'a', 'visitor'), true);
  access.autoApproveIfFriendRequest(db, () => notices++, { ...intervention, id: 'ordinary', visitorId: 'other' }, '通过');
  assert.equal(access.isWhitelisted(db, 'a', 'other'), false);
});

for (const agentId of ['a', undefined]) {
  test(`ACL id removal verifies actual owner with ${agentId ? 'unrelated owned Agent' : 'legacy id-only request'}`, async t => {
    const { db, handlers, entry } = fixture(t); entry('foreign', 'b');
    const result = await handlers.manage_whitelist({ action: 'remove', id: 'foreign', ...(agentId ? { agentId } : {}) });
    assert.equal(result.success, false);
    assert.equal(result.code, 'AGENT_OWNER_MISMATCH');
    assert.ok(db.prepare("SELECT id FROM agent_access_lists WHERE id='foreign'").get());
  });
}

test('ACL id cannot replace requested Agent or list type', async t => {
  const { db, handlers, entry } = fixture(t); entry('other-agent', 'a2'); entry('blocked', 'a', 'blacklist');
  for (const params of [{ id: 'other-agent', agentId: 'a' }, { id: 'blocked' }]) {
    const result = await handlers.manage_whitelist({ action: 'remove', ...params });
    assert.equal(result.success, false);
    assert.ok(db.prepare('SELECT id FROM agent_access_lists WHERE id=?').get(params.id));
  }
});

test('ACL legacy id removal supports every owned Agent and missing ids remain idempotent', async t => {
  const { db, handlers, entry } = fixture(t); entry('owned', 'a2'); entry('blocked', 'a', 'blacklist');
  assert.equal((await handlers.manage_whitelist({ action: 'remove', id: 'owned' })).success, true);
  assert.equal((await handlers.manage_blacklist({ action: 'remove', id: 'blocked' })).success, true);
  assert.equal((await handlers.manage_whitelist({ action: 'remove', id: 'missing' })).success, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_access_lists').get().n, 0);
});

test('ACL id removal preserves server authority and disables same-owner automatic trust', async t => {
  const { db, handlers, entry } = fixture(t);
  entry('server', 'a', 'whitelist', 'manual', 1);
  entry('automatic', 'a', 'whitelist', 'same_owner_default');
  for (const id of ['server', 'automatic']) assert.equal((await handlers.manage_whitelist({ action: 'remove', id })).success, true);
  const server = db.prepare("SELECT * FROM agent_access_lists WHERE id='server'").get();
  assert.equal(server.server_managed, 1); assert.equal(server.manual_managed, 0);
  const automatic = db.prepare("SELECT * FROM agent_access_lists WHERE id='automatic'").get();
  assert.ok(automatic); assert.equal(automatic.auto_trust_disabled, 1); assert.equal(automatic.manual_managed, 0);
  assert.equal(access.isWhitelisted(db, 'a', 'visitor-automatic'), false);
});

test('low-level ACL removal cannot mutate an id outside its supplied scope', t => {
  const { db, entry } = fixture(t); entry('foreign', 'b'); entry('blocked', 'a', 'blacklist');
  access.removeEntry(db, 'foreign', { agentId: 'a', listType: 'whitelist' });
  access.removeEntry(db, 'blocked', { agentId: 'a', listType: 'whitelist' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_access_lists').get().n, 2);
});
