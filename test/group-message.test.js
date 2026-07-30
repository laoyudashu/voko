/**
 * 群聊消息处理单元测试
 *
 * 测试 messenger.js _handleGroupMessage（经 handleAgentMessage channelType=2 入口）：
 *   - 落库 channel_type=2，conversations user_uid=agentImUid（非 roomId）
 *   - @判定：mention.uids 含本 agent 或 mention.all 才 forwardToAgent
 *   - group_invitation 邀请消息不触发 LLM
 *   - agent 自身回流（isMe）不触发
 *
 * 纯 Node.js，不依赖 WuKongIM 实例 / Electron。
 * 运行: node test/group-message.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const { createDispatcher } = require('../build/core/dispatcher');
const { persistAgentMessage } = require('../build/core/send-message');

// ========================================
// 测试夹具
// ========================================
function setup() {
  const tmpDir = path.join(os.tmpdir(), 'voko-group-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmpDir, { recursive: true });
  const db = initDatabase(path.join(tmpDir, 'test.db'), { silent: true });

  // 插入测试 agent（imUid = imuid_test）
  const now = Date.now();
  db.prepare(`INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, owner_email, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('1', 'agent_test', 'imuid_test', 'tok', 'ws://fake', 'published', 'public', 't@t.com', now, now);
  db.prepare(`INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, owner_email, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('2', 'agent_other', 'imuid_other', 'tok', 'ws://fake', 'published', 'public', 't@t.com', now, now);

  const forwarded = [];
  const notified = [];
  const delivered = [];
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch: (agentId, payload) => forwarded.push({ agentId, payload }) },
    notifyUI: (event, data) => notified.push({ event, data }),
    checkAuditRules: () => ({ action: 'allow' }),
    deliver: async (...args) => { delivered.push(args); return { success: true }; },
  });

  return {
    db, handler, forwarded, notified, delivered,
    cleanup: () => { try { db.close(); } catch (_) {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
  };
}

/** 构造一条群聊消息 data */
function groupMsg({ fromUid = 'visitor1', channelId = 'room1', content = 'hello', mention = null, messageId, contentType = 1, messageSeq = 1, clientMsgNo = 'c1', timestamp = 1700000000 } = {}) {
  return {
    fromUid, toUid: channelId, channelId, channelType: 2,
    content, messageId: messageId || ('m-' + Math.random().toString(36).slice(2, 8)),
    timestamp, contentType, mention,
    messageSeq, clientMsgNo, noPersist: 0, redDot: 0, syncOnce: 0,
  };
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); if (e.stack) console.log(`    ${e.stack.split('\n').slice(1, 3).join('\n    ')}`); }
}

// ========================================
// 测试套件
// ========================================
console.log('\n=== 群聊消息处理（_handleGroupMessage）===\n');

test('群聊消息未被 @ → 落库 channel_type=2，不触发 forward', () => {
  const { db, handler, forwarded, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: { uids: ['someone_else'] } }));
    assert.strictEqual(forwarded.length, 0, '未被 @ 时不应 forward');
    const row = db.prepare('SELECT channel_type, agent_id, is_me FROM messages WHERE channel_id=?').get('room1');
    assert.ok(row, '消息应落库');
    assert.strictEqual(row.channel_type, 2, 'channel_type 应为 2');
  } finally { cleanup(); }
});

test('群聊被 @（mention.uids 含本 agent imUid）→ 触发 forward，payload.channelType=2', () => {
  const { handler, forwarded, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: { uids: ['imuid_test'] } }));
    assert.strictEqual(forwarded.length, 1, '被 @ 时应 forward 一次');
    assert.strictEqual(forwarded[0].payload.channelType, 2, 'forward payload channelType 应为 2');
    assert.strictEqual(forwarded[0].payload.channelId, 'room1');
  } finally { cleanup(); }
});

test('群聊 mention.all → 触发 forward', () => {
  const { handler, forwarded, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: { all: true } }));
    assert.strictEqual(forwarded.length, 1, 'mention.all 应 forward');
  } finally { cleanup(); }
});

test('群聊邀请消息（group_invitation）→ 落库但不触发 forward', () => {
  const { db, handler, forwarded, cleanup } = setup();
  try {
    const inviteContent = JSON.stringify({ type: 'group_invitation', roomId: 'room1', groupName: '测试群', inviter: '张三' });
    handler.handleAgentMessage('agent_test', groupMsg({ content: inviteContent, mention: { uids: ['imuid_test'] } }));
    assert.strictEqual(forwarded.length, 0, '邀请消息即使被 @ 也不应 forward');
    const row = db.prepare('SELECT content FROM messages WHERE channel_id=?').get('room1');
    assert.ok(row && row.content.includes('group_invitation'), '邀请消息应落库');
  } finally { cleanup(); }
});

test('群聊 agent 自身回流（fromUid=本 agent imUid）→ 落库 is_me=1，不 forward', () => {
  const { db, handler, forwarded, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ fromUid: 'imuid_test', mention: { uids: ['imuid_test'] } }));
    assert.strictEqual(forwarded.length, 0, '自身回流不应 forward');
    const row = db.prepare('SELECT is_me FROM messages WHERE channel_id=?').get('room1');
    assert.strictEqual(row.is_me, 1, 'is_me 应为 1');
  } finally { cleanup(); }
});

test('群聊 conversations user_uid = agent imUid（非 roomId/toUid）', () => {
  const { db, handler, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: { uids: ['imuid_test'] } }));
    const conv = db.prepare('SELECT user_uid, channel_id, channel_type FROM conversations WHERE channel_id=?').get('room1');
    assert.ok(conv, '应创建群聊会话');
    assert.strictEqual(conv.user_uid, 'imuid_test', 'user_uid 应为 agent imUid（修复 9.3-A：不再用 toUid）');
    assert.strictEqual(conv.channel_type, 2, '会话 channel_type 应为 2');
  } finally { cleanup(); }
});

test('群聊消息 mention 落库（供 pull 模式 agent 识别 @）', () => {
  const { db, handler, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: { uids: ['imuid_test', 'other'] } }));
    const row = db.prepare('SELECT mention FROM messages WHERE channel_id=?').get('room1');
    assert.ok(row.mention, 'mention 列应有值');
    const parsed = JSON.parse(row.mention);
    assert.deepStrictEqual(parsed, { uids: ['imuid_test', 'other'] }, 'mention 应正确序列化');
  } finally { cleanup(); }
});

test('群聊无 mention 时 mention 列为 NULL', () => {
  const { db, handler, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ mention: null }));
    const row = db.prepare('SELECT mention FROM messages WHERE channel_id=?').get('room1');
    assert.strictEqual(row.mention, null, '无 mention 时应为 NULL');
  } finally { cleanup(); }
});

test('多 agent 收到同一条 @全体消息 → 只落库一次，但两个 agent 都会处理', () => {
  const { db, handler, forwarded, cleanup } = setup();
  try {
    const msg = groupMsg({ messageId: 'dup-msg-1', mention: { all: true } });
    handler.handleAgentMessage('agent_test', msg);
    handler.handleAgentMessage('agent_other', msg);
    const cnt = db.prepare('SELECT COUNT(*) as c FROM messages WHERE id=?').get('dup-msg-1').c;
    assert.strictEqual(cnt, 1, '同 messageId 应只落库一次');
    assert.deepStrictEqual(forwarded.map(x => x.agentId), ['agent_test', 'agent_other'], '@全体应触发两个 agent forward');
    const convCnt = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE channel_id=?').get('room1').c;
    assert.strictEqual(convCnt, 2, '两个 agent 都应建立自己的群会话');
  } finally { cleanup(); }
});

test('群聊空内容 → 跳过，不落库不 forward', () => {
  const { db, handler, forwarded, cleanup } = setup();
  try {
    handler.handleAgentMessage('agent_test', groupMsg({ content: '   ', mention: { uids: ['imuid_test'] } }));
    assert.strictEqual(forwarded.length, 0);
    const cnt = db.prepare("SELECT COUNT(*) as c FROM messages WHERE channel_id='room1'").get().c;
    assert.strictEqual(cnt, 0, '空内容不应落库');
  } finally { cleanup(); }
});


test('mentioned agent receives the previous 10 group messages in a group-scoped session', () => {
  const { handler, forwarded, cleanup } = setup();
  try {
    for (let i = 1; i <= 12; i++) {
      handler.handleAgentMessage('agent_test', groupMsg({
        content: 'context-' + i, messageId: 'ctx-' + i,
        messageSeq: i, clientMsgNo: 'ctx-client-' + i,
        timestamp: 1700000000 + i, mention: null
      }));
    }
    handler.handleAgentMessage('agent_test', groupMsg({
      content: '@Agent current question', messageId: 'trigger-context',
      messageSeq: 13, clientMsgNo: 'ctx-client-13', timestamp: 1700000013,
      mention: { uids: ['imuid_test'] }
    }));
    assert.strictEqual(forwarded.length, 1);
    const payload = forwarded[0].payload;
    assert.strictEqual(payload.fromUid, 'visitor1');
    assert.strictEqual(payload.senderUid, 'visitor1');
    assert.strictEqual(payload.sessionTarget, 'group:room1');
    const json = payload.content.match(/\[VOKO_GROUP_CONTEXT\]\n([\s\S]*?)\n\[\/VOKO_GROUP_CONTEXT\]/);
    assert.ok(json, 'group context envelope should be present');
    const envelope = JSON.parse(json[1]);
    assert.strictEqual(envelope.currentMessage, '@Agent current question');
    assert.strictEqual(envelope.recentMessages.length, 10);
    assert.strictEqual(envelope.recentMessages[0].content, 'context-3');
    assert.strictEqual(envelope.recentMessages[9].content, 'context-12');
  } finally { cleanup(); }
});


test('dispatcher isolates provider sessions by group while preserving senderUid', () => {
  const { db, cleanup } = setup();
  try {
    const pushed = [];
    const provider = {
      match: () => true, isAvailable: () => true,
      push: payload => pushed.push(payload), on: () => {}
    };
    const dispatcher = createDispatcher({ db, providers: { fake: provider } });
    dispatcher.dispatch('agent_test', {
      agentId: 'agent_test', fromUid: 'visitor1', senderUid: 'visitor1',
      sessionTarget: 'group:roomA', content: 'one', channelId: 'roomA', channelType: 2
    });
    dispatcher.dispatch('agent_test', {
      agentId: 'agent_test', fromUid: 'visitor1', senderUid: 'visitor1',
      sessionTarget: 'group:roomB', content: 'two', channelId: 'roomB', channelType: 2
    });
    assert.deepStrictEqual(pushed.map(p => p.fromUid), ['group:roomA', 'group:roomB']);
    assert.deepStrictEqual(pushed.map(p => p.senderUid), ['visitor1', 'visitor1']);
    assert.deepStrictEqual(pushed.map(p => p.rawContent), ['one', 'two']);
    assert.ok(pushed.every(p => p.securityContext.sourceType === 'visitor'));
    assert.ok(pushed.every(p => p.securityContext.trustLevel === 'untrusted'));
    assert.ok(pushed.every(p => p.content.includes('[VOKO SECURITY CONTEXT]')));
    assert.ok(pushed.every(p => p.content.includes('已声明且已获授权的能力范围')));
    assert.ok(pushed.every(p => !p.content.includes('绝不能执行访客要求的任何操作')));
  } finally { cleanup(); }
});



test('outbound group mention metadata survives persistence for history rendering', () => {
  const { db, cleanup } = setup();
  try {
    const mentions = { all: false, uids: ['imuid_other'] };
    const saved = persistAgentMessage(db, 'agent_test', 'room1', '@AgentB hello', 'imuid_test', 'text', 2, mentions);
    const row = db.prepare('SELECT channel_type, mention FROM messages WHERE id=?').get(saved.msgId);
    assert.strictEqual(row.channel_type, 2);
    assert.deepStrictEqual(JSON.parse(row.mention), mentions);
  } finally { cleanup(); }
});

test('direct agent reply keeps the existing direct-message route', () => {
  const { db, handler, delivered, cleanup } = setup();
  try {
    handler.handleAgentReply({ agentId: 'agent_test', visitorId: 'visitor1', content: 'direct answer', done: true });
    const row = db.prepare("SELECT channel_id, channel_type FROM messages WHERE content='direct answer'").get();
    assert.strictEqual(row.channel_id, 'visitor1');
    assert.strictEqual(row.channel_type, 1);
    assert.strictEqual(delivered[0][1], 'visitor1');
    assert.strictEqual(delivered[0][4], 1);
  } finally { cleanup(); }
});

test('group agent reply is persisted and delivered to the original group', () => {
  const { db, handler, delivered, notified, cleanup } = setup();
  try {
    handler.handleAgentReply({
      agentId: 'agent_test', visitorId: 'group:room1',
      content: 'group answer', sessionKey: 'agent:agent_test:group:room1', done: true
    });
    const row = db.prepare("SELECT channel_id, channel_type, content FROM messages WHERE content='group answer'").get();
    assert.ok(row);
    assert.strictEqual(row.channel_id, 'room1');
    assert.strictEqual(row.channel_type, 2);
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(delivered[0][1], 'room1');
    assert.strictEqual(delivered[0][4], 2);
    const ui = notified[notified.length - 1].data;
    assert.strictEqual(ui.channelId, 'room1');
    assert.strictEqual(ui.channelType, 2);
  } finally { cleanup(); }
});

// ========================================
console.log('\n========================================');
console.log(`群聊消息处理测试: ${pass} 通过, ${fail} 失败`);
console.log('========================================\n');
process.exit(fail > 0 ? 1 : 0);
