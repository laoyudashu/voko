const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const accessControl = require('../build/core/access-control-api');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-owner-trust-'));
  const db = initDatabase(path.join(dir, 'voko.db'), { silent: true });
  const now = Date.now();
  const addAgent = (id, uid, owner) => db.prepare(
    'INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, owner_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, id, uid, 'token', 'wss://wukongim.vokovoko.com', 'published', 'private', owner, now, now);
  addAgent('agent-a', 'uid-a', 'owner@example.com');
  addAgent('agent-b', 'uid-b', 'OWNER@example.com');
  addAgent('agent-c', 'uid-c', 'other@example.com');
  const handler = new MessageHandler(db, {
    ac: accessControl,
    dispatcher: { dispatch() {} },
    checkAuditRules: () => ({ action: 'allow' }),
  });
  return { db, handler, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function message(fromUid, id) {
  return { fromUid, toUid: 'uid-b', channelId: fromUid, channelType: 1, content: 'hello', messageId: id, timestamp: 1700000000, contentType: 1 };
}

test('same-owner Agents trust each other on their first direct message', (t) => {
  const { db, handler, cleanup } = setup();
  t.after(cleanup);
  handler.handleAgentMessage('agent-b', message('uid-a', 'same-owner-1'));
  assert.ok(accessControl.isWhitelisted(db, 'agent-b', 'uid-a'));
  assert.ok(accessControl.isWhitelisted(db, 'agent-a', 'uid-b'));
});

test('different-owner Agents are not auto-whitelisted', (t) => {
  const { db, handler, cleanup } = setup();
  t.after(cleanup);
  handler.handleAgentMessage('agent-b', message('uid-c', 'other-owner-1'));
  assert.equal(accessControl.isWhitelisted(db, 'agent-b', 'uid-c'), false);
  assert.equal(accessControl.isWhitelisted(db, 'agent-c', 'uid-b'), false);
});

test('an explicit blacklist prevents same-owner auto-trust', (t) => {
  const { db, handler, cleanup } = setup();
  t.after(cleanup);
  accessControl.addEntry(db, { agentId: 'agent-b', listType: 'blacklist', visitorId: 'uid-a', reason: 'blocked' });
  handler.handleAgentMessage('agent-b', message('uid-a', 'same-owner-blocked'));
  assert.equal(accessControl.isWhitelisted(db, 'agent-b', 'uid-a'), false);
  assert.equal(accessControl.isWhitelisted(db, 'agent-a', 'uid-b'), false);
});
