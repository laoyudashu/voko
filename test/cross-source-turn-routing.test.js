const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cross-source-'));
  const db = initDatabase(path.join(directory, 'messages.db'), { silent: true });
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,owner_email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('1', 'receiver', 'agent-receiver-im', 'token', 'ws://fake', 'published', 'public', 'owner@example.com', now, now);
  insert.run('2', 'sender', 'agent-sender-im', 'token', 'ws://fake', 'published', 'public', 'owner@example.com', now, now);
  const dispatched = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch(agentId, payload) { dispatched.push({ agentId, payload }); } },
    notifyUI() {}, checkAuditRules: () => ({ action: 'allow' }),
  });
  return { db, handler, dispatched, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function direct(messageId, content) {
  return { fromUid: 'agent-sender-im', toUid: 'agent-receiver-im', channelId: 'agent-sender-im',
    channelType: 1, contentType: 1, content, messageId, clientMsgNo: messageId,
    timestamp: Math.floor(Date.now() / 1000), messageSeq: Number(messageId.slice(-1)) || 1 };
}

test('ordinary Agent IM messages share the conversational Turn coalescer', async () => {
  const f = fixture();
  try {
    f.handler.handleAgentMessage('receiver', direct('agent-message-1', 'first'));
    f.handler.handleAgentMessage('receiver', direct('agent-message-2', 'second'));
    await f.handler.flushInboundTurns();
    assert.equal(f.dispatched.length, 1);
    assert.deepEqual(f.dispatched[0].payload.sourceMessageIds, ['agent-message-1', 'agent-message-2']);
    assert.match(f.dispatched[0].payload.content, /^2 consecutive messages were received\./);
    assert.doesNotMatch(f.dispatched[0].payload.content, /visitor/i);
  } finally { f.close(); }
});

test('known group system controls are persisted but never enter a Provider Turn', async () => {
  const f = fixture();
  try {
    f.handler.handleAgentMessage('receiver', { ...direct('system-tip-1', JSON.stringify({ type: 1001, content: 'member joined' })),
      fromUid: 'system', channelId: 'group-1', toUid: 'group-1', channelType: 2,
      mention: { uids: ['agent-receiver-im'] } });
    await f.handler.flushInboundTurns();
    assert.equal(f.dispatched.length, 0);
    const stored = f.db.prepare('SELECT content_type FROM messages WHERE id=?').get('system-tip-1');
    assert.equal(stored.content_type, 12);
  } finally { f.close(); }
});
