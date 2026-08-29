/**
 * 群聊 MCP 工具单元测试
 *
 * 测试 tools.js 群聊相关 handler 的本地逻辑（不依赖 WuKongIM 实例）：
 *   - get_chat_history 群聊按 channel_id 查全量 / 单聊按 agent_id
 *   - list_conversations 返回 channelType + 群聊 needsReply=false
 *   - get_group_context 消息部分（成员查询 mock fetch）
 *   - create_group / accept_invitation（mock fetch subscriber_add）
 *
 * 运行: node test/group-mcp-tools.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('../build/core/database');
const { createToolHandlers } = require('../build/mcp/tools');
const { createDispatcher } = require('../build/core/dispatcher');
const { MessageRouteStore, RoutingConversationStore } = require('../build/core/provider-routing');
const { runWithProviderCaller } = require('../build/core/registration-caller-context');
const { registerActiveOwnerInterventionContext } = require('../build/core/owner-intervention-active-context');
const { OutboundMessageResultStore } = require('../build/core/outbound-message-result-store');

// ========================================
// 夹具：建库 + 插数据 + mock fetch + mock sendMessage
// ========================================
function setup(options = {}) {
  const groupStatus = options.groupStatus || 'active';
  const tmpDir = path.join(os.tmpdir(), 'voko-group-mcp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmpDir, { recursive: true });
  const db = initDatabase(path.join(tmpDir, 'test.db'), { silent: true });

  const now = Date.now();
  // 两个 agent
  db.prepare(`INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, owner_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('1', 'agentA', 'imuidA', 'tok', 'ws://fake', 'published', 'public', 'a@a.com', now, now);
  db.prepare(`INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, publish_status, access_mode, owner_email, agent_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('2', 'agentB', 'imuidB', 'tok', 'ws://fake', 'published', 'public', 'b@b.com', 'AgentB', now, now);
  const tokenMap = options.activeOwner === 'b@b.com'
    ? { 'b@b.com': { user_access_token: 'test-token-b' }, 'a@a.com': { user_access_token: 'test-token-a' } }
    : { 'a@a.com': { user_access_token: 'test-token-a' }, 'b@b.com': { user_access_token: 'test-token-b' } };
  db.prepare('INSERT INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run('user_access_token', JSON.stringify(tokenMap), now);

  // 访客 + 群聊消息
  db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, mention) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('m1', 'visitor1', 'imuidA', '单聊消息', 'visitor1', 1, 'agentA', now, 0, 'received', 1, null);
  db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, mention) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('m2', 'visitor1', 'room1', '群聊@消息', 'room1', 2, 'agentA', now + 1, 0, 'received', 1, JSON.stringify({ uids: ['imuidA'] }));

  // 群聊会话（agentA 参与）
  db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run('imuidA', 'room1', 2, 'room1', '群聊@消息', now + 1, 1, 'agentA');

  // 记录 fetch 调用
  const fetchCalls = [];
  const fakeFetch = async (url, opts = {}) => {
    fetchCalls.push({ url, opts });
    let data = {};
    if (url.includes('/api/group/v1/create')) {
      data = { channel_id: 'room-created', name: '测试群', owner_uid: 'imuidA', members: [] };
    } else if (url.includes('/api/group/v1/search')) {
      data = { groups: options.searchGroups || [], total: (options.searchGroups || []).length };
    } else if (url.includes('/api/group/v1/info')) {
      data = { channel_id: 'room1', name: '测试群', status: groupStatus, dissolved_at: groupStatus === 'dissolved' ? '2026-07-26T12:00:00.000Z' : null, members: [
        { uid: 'imuidA', role: 'owner' },
        { uid: 'imuidB', role: 'member' },
        { uid: 'visitor1', role: 'member' },
      ] };
    } else if (url.includes('/api/group/v1/dissolve')) {
      data = { dissolved: true, channel_id: 'room1' };
    } else if (url.includes('/api/group/v1/quit')) {
      data = { quit: true, channel_id: 'room1' };
    }
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  global.fetch = fakeFetch;

  const interventions = [];
  const sentMessages = [];
  const cx = {
    db,
    query: (sql, params = []) => { try { return db.prepare(sql).all(...params); } catch (_) { return []; } },
    exec: (sql, params = []) => { try { db.prepare(sql).run(...params); } catch (_) {} },
    sendMessage: async (agentId, toUid, content, fromUid, messageType, channelType, mentions) => {
      sentMessages.push({ agentId, toUid, content, fromUid, messageType, channelType, mentions });
      return { success: true };
    },
    uploadFileToOSS: options.uploadFileToOSS || (async (_filePath, objectName) => `https://oss.example/${objectName}`),
    ...(options.secureOutboundRouter ? { secureOutboundRouter: options.secureOutboundRouter } : {}),
    enqueueOwnerIntervention: record => interventions.push(record),
    wukongim: {
      getCurrentUid: options.getCurrentUid
        || (agentId => db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId)?.imUid || ''),
    },
    outboundMessageResults: new OutboundMessageResultStore(),
  };
  const handlers = createToolHandlers(cx);

  return {
    db, handlers, fetchCalls, sentMessages, interventions,
    cleanup: () => { try { db.close(); } catch (_) {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} delete global.fetch; }
  };
}

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); });
}

// ========================================
async function main() {
console.log('\n=== 群聊 MCP 工具（tools.js handler）===\n');

await test('send_message 透传群聊 @全体和成员 UID', async () => {
  const { handlers, sentMessages, cleanup } = setup();
  try {
    const mentions = { all: true, uids: [] };
    const r = await handlers.send_message({ agentId: 'agentA', toUid: 'room1', content: '@全体成员 hello', channelType: 2, mentions });
    assert.strictEqual(r.success, true);
    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0].mentions, mentions);
    const memberMentions = { all: false, uids: ['imuidB'] };
    await handlers.send_message({ agentId: 'agentA', toUid: 'room1', content: '@AgentB hello', channelType: 2, mentions: memberMentions });
    assert.deepStrictEqual(sentMessages[1].mentions, memberMentions);
  } finally { cleanup(); }
});
await test('send_message 省略 channelType 时按群频道 ID 自动识别', async () => {
  const { handlers, sentMessages, cleanup } = setup();
  try {
    const r = await handlers.send_message({ agentId: 'agentA', toUid: 'room1', content: '省略类型的群消息' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(sentMessages[0].channelType, 2);
  } finally { cleanup(); }
});
await test('send_message returns a stable code when the runtime database has no Agent IM identity', async () => {
  const { handlers, sentMessages, cleanup } = setup({ getCurrentUid: () => '' });
  try {
    const r = await handlers.send_message({ agentId: 'agentA', toUid: 'imuidB', content: 'identity check', channelType: 1 });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'AGENT_IM_IDENTITY_MISSING');
    assert.strictEqual(sentMessages.length, 0);
  } finally { cleanup(); }
});
await test('send_message requests an in-memory result receipt and exposes it through get_message_result', async () => {
  const { db, handlers, sentMessages, cleanup } = setup();
  try {
    const result = await handlers.send_message({ agentId: 'agentA', toUid: 'imuidB', content: 'track me', channelType: 1 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.resultTracking.tool, 'get_message_result');
    assert.deepStrictEqual(sentMessages[0].mentions, null);
    db.prepare(`INSERT INTO messages (id,from_uid,to_uid,content,channel_id,channel_type,agent_id,timestamp,is_me,status,content_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(result.resultTracking.messageId, 'imuidA', 'imuidB', 'track me', 'imuidB', 1, 'agentA', Date.now(), 1, 'sent', 1);
    const status = await handlers.get_message_result({ agentId: 'agentA', messageId: result.resultTracking.messageId });
    assert.strictEqual(status.transport.state, 'DELIVERED');
    assert.strictEqual(status.execution.state, 'UNCONFIRMED');
    assert.strictEqual(status.execution.reasonCode, 'NO_RECEIPT_RECEIVED');
  } finally { cleanup(); }
});
await test('get_message_result validates input and does not disclose another Agent message', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    const missing = await handlers.get_message_result({ agentId: 'agentA' });
    assert.strictEqual(missing.success, false);
    assert.strictEqual(missing.code, 'MESSAGE_RESULT_INPUT_REQUIRED');

    db.prepare(`INSERT INTO messages (id,from_uid,to_uid,content,channel_id,channel_type,agent_id,timestamp,is_me,status,content_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('other-agent-message', 'other-agent', 'imuidB', 'private', 'imuidB', 1, 'agentB', Date.now(), 1, 'sent', 1);
    const hidden = await handlers.get_message_result({ agentId: 'agentA', messageId: 'other-agent-message' });
    assert.strictEqual(hidden.success, false);
    assert.strictEqual(hidden.code, 'MESSAGE_RESULT_NOT_FOUND');
    assert.deepStrictEqual(Object.keys(hidden).sort(), ['code', 'error', 'success']);
  } finally { cleanup(); }
});
await test('Web 新对话只在首条发送时创建，并保留来源 Conversation', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    const conversations = new RoutingConversationStore(db);
    const parent = conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'web-parent-session', channelId: 'visitor1', channelType: 1, origin: 'caller' });
    assert.equal(conversations.listForScope('agentA', 'visitor1', 1).length, 1);

    const result = await handlers.send_message({ agentId: 'agentA', toUid: 'visitor1', content: 'first draft message',
      channelType: 1, webRequest: true, webConversationStart: true, parentConversationId: parent.id });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.conversationDisposition, 'created');
    assert.notStrictEqual(result.conversationId, parent.id);
    const created = db.prepare(`SELECT parent_conversation_id,status FROM provider_routing_conversations
      WHERE id=?`).get(result.conversationId);
    assert.strictEqual(created.parent_conversation_id, parent.id);
    assert.strictEqual(created.status, 'active');
    assert.strictEqual(db.prepare(`SELECT conversation_id FROM provider_message_routes
      WHERE direction='outbound' ORDER BY created_at DESC LIMIT 1`).get().conversation_id, result.conversationId);
  } finally { cleanup(); }
});
await test('send_message 拒绝普通成员 @全体', async () => {
  const { handlers, sentMessages, cleanup } = setup({ activeOwner: 'b@b.com' });
  try {
    const r = await handlers.send_message({
      agentId: 'agentB',
      toUid: 'room1',
      content: '@全体成员 hello',
      channelType: 2,
      mentions: { all: true, uids: [] },
    });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'MENTION_ALL_FORBIDDEN');
    assert.strictEqual(sentMessages.length, 0);
  } finally { cleanup(); }
});
await test('dissolved 群在发送函数内部拒绝所有消息类型', async () => {
  const { handlers, sentMessages, cleanup } = setup({ groupStatus: 'dissolved' });
  try {
    for (const contentType of [1, 2, 3, 'voice']) {
      const r = await handlers.send_message({ agentId: 'agentA', toUid: 'room1', content: 'blocked', channelType: 2, contentType });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.code, 'GROUP_DISSOLVED');
    }
    assert.strictEqual(sentMessages.length, 0);
  } finally { cleanup(); }
});

await test('upload_and_send_file 先发送文字，再发送标准附件消息', async () => {
  const { handlers, sentMessages, cleanup } = setup();
  const tmpFile = path.join(os.tmpdir(), 'voko-attachment-' + Date.now() + '.txt');
  fs.writeFileSync(tmpFile, 'attachment');
  try {
    const r = await handlers.upload_and_send_file({
      agentId: 'agentA', toUid: 'visitor1', filePath: tmpFile, message: '说明文字', channelType: 1,
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[0].content, '说明文字');
    assert.strictEqual(sentMessages[0].messageType, 'text');
    assert.strictEqual(sentMessages[1].messageType, 'file');
    assert.deepStrictEqual(JSON.parse(sentMessages[1].content), {
      url: r.url, name: path.basename(tmpFile), size: 10, type: 'text/plain',
    });
  } finally { try { fs.unlinkSync(tmpFile); } catch (_) {} cleanup(); }
});

await test('upload_and_send_file 将图片发送为图片消息', async () => {
  const { handlers, sentMessages, cleanup } = setup();
  const tmpFile = path.join(os.tmpdir(), 'voko-image-' + Date.now() + '.png');
  fs.writeFileSync(tmpFile, 'png');
  try {
    const r = await handlers.upload_and_send_file({ agentId: 'agentA', toUid: 'visitor1', filePath: tmpFile });
    assert.strictEqual(r.success, true);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].messageType, 'image');
    assert.strictEqual(sentMessages[0].content, r.url);
  } finally { try { fs.unlinkSync(tmpFile); } catch (_) {} cleanup(); }
});

await test('upload_and_send_file 在 E2EE 模式只传本地源给安全路由且不暴露本地路径', async () => {
  let ordinaryUploads = 0;
  const secureOutboundRouter = { prepare: async (_agentId, _channelId, _channelType, _metadata, purpose) => {
    assert.strictEqual(purpose, 'attachment');
    return { success: true, securityMode: 'e2ee', securityReason: 'recipient_supported', encryptedDeviceCount: 2 };
  } };
  const { handlers, sentMessages, cleanup } = setup({ secureOutboundRouter,
    uploadFileToOSS: async () => { ordinaryUploads++; return 'https://must-not-upload.example/plain'; } });
  const tmpFile = path.join(os.tmpdir(), 'voko-secure-attachment-' + Date.now() + '.txt');
  fs.writeFileSync(tmpFile, 'classified');
  try {
    const r = await handlers.upload_and_send_file({ agentId: 'agentA', toUid: 'visitor1', filePath: tmpFile });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.securityMode, undefined, 'mock transport does not claim encryption');
    assert.strictEqual(ordinaryUploads, 0, 'plaintext upload must not happen before secure router');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].messageType, 'file');
    assert.match(sentMessages[0].content, /^\{"url":"\/api\/e2ee-v2\/attachments\//);
    assert.strictEqual(Object.hasOwn(r, 'filePath'), false);
    assert.strictEqual(Object.hasOwn(r, 'ext'), false);
  } finally { try { fs.unlinkSync(tmpFile); } catch (_) {} cleanup(); }
});

await test('get_chat_history 群聊（channelType=2）按 channel_id 查全量，含其他 agent 的消息', async () => {
  const { handlers, cleanup } = setup();
  try {
    const r = await handlers.get_chat_history({ channelId: 'room1', channelType: 2, agentId: 'agentA' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.messages.length, 1, '应查到群聊消息');
    assert.strictEqual(r.messages[0].channelType, 2, 'fmtMsg 应带 channelType=2');
    assert.deepStrictEqual(r.messages[0].mention, { uids: ['imuidA'] }, 'fmtMsg 应解析 mention');
  } finally { cleanup(); }
});

await test('get_chat_history 单聊（channelType=1）排除群聊消息，按 agent_id 过滤', async () => {
  const { handlers, cleanup } = setup();
  try {
    const r = await handlers.get_chat_history({ channelId: 'visitor1', channelType: 1, agentId: 'agentA' });
    assert.strictEqual(r.messages.length, 1, '只查单聊消息');
    assert.strictEqual(r.messages[0].channelType, 1);
  } finally { cleanup(); }
});
await test('get_chat_history 缺少 channelId 返回可操作错误', async () => {
  const { handlers, cleanup } = setup();
  try {
    const r = await handlers.get_chat_history({ agentId: 'agentA' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'CHANNEL_ID_REQUIRED');
    assert.match(r.error, /channelId/);
  } finally { cleanup(); }
});

await test('get_chat_history keeps channel compatibility and optionally filters by routing conversation', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    const conversations = new RoutingConversationStore(db);
    const routes = new MessageRouteStore(db);
    const conversation = conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'history-thread', channelId: 'visitor1', channelType: 1, origin: 'caller' });
    const routeId = routes.createPending({ messageId: 'm1', conversationId: conversation.id,
      agentId: 'agentA', peerUid: 'visitor1', channelId: 'visitor1', channelType: 1, direction: 'inbound' });
    routes.setStatus(routeId, 'active');
    const legacy = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'visitor1' });
    assert.strictEqual(legacy.messages[0].conversationId, conversation.id);
    assert.strictEqual(legacy.conversationId, null);
    const precise = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'visitor1',
      conversationId: conversation.id });
    assert.strictEqual(precise.conversationId, conversation.id);
    assert.deepStrictEqual(precise.messages.map(message => message.id), ['m1']);
    const invalid = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'other',
      conversationId: conversation.id });
    assert.strictEqual(invalid.code, 'ROUTING_CONVERSATION_INVALID');
  } finally { cleanup(); }
});

await test('list_routing_conversations returns safe identifiers without native sessions', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    const conversation = new RoutingConversationStore(db).resolveOrCreate({ agentId: 'agentA',
      providerFamily: 'codex', nativeSessionId: 'secret-native-thread', channelId: 'visitor1',
      channelType: 1, origin: 'caller' });
    const result = await handlers.list_routing_conversations({ agentId: 'agentA', channelId: 'visitor1' });
    assert.strictEqual(result.conversations[0].conversationId, conversation.id);
    assert.strictEqual('nativeSessionId' in result.conversations[0], false);
    assert.strictEqual(JSON.stringify(result).includes('secret-native-thread'), false);
  } finally { cleanup(); }
});

await test('fetch_new_messages messageSeq=0 按指定群隔离消息', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    global.__dispatcher = createDispatcher({ db, providers: {} });
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(4, 'm1');
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(1, 'm2');
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq, mention) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-fetch-room1', 'imuidB', 'room1', '同群另一 Agent 消息', 'room1', 2, 'agentB', Date.now() + 2, 0, 'received', 1, 2, JSON.stringify({ uids: ['imuidA'] }));
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-fetch-room2', 'imuidB', 'room2', '其他群消息', 'room2', 2, 'agentB', Date.now() + 3, 0, 'received', 1, 3);

    const params = {
      agentId: 'agentA',
      channelId: 'room1',
      channelType: 2,
      messageSeq: 0,
      onlyReplies: false,
      limit: 50,
    };
    const r = await handlers.fetch_new_messages(params);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.messages.length, 2, '只应返回指定群的两条消息');
    assert.ok(r.messages.every(m => m.channelId === 'room1' && m.channelType === 2), '不能混入其他群或单聊');
    assert.deepStrictEqual(new Set(r.messages.map(m => m.agentId)), new Set(['agentA', 'agentB']), '同群消息可包含多个 agent');
    assert.strictEqual(r.securityContext.policyId, 'voko-external-message-v1');
    assert.strictEqual(r.securityContext.defaultTrustLevel, 'untrusted');
    assert.strictEqual(r.securityContext.ownerCommandsOnlyVia, 'verified_owner_intervention');
    assert.ok(Array.isArray(r.securityContext.instructions) && r.securityContext.instructions.length > 0);
    const visitorMessage = r.messages.find(m => m.id === 'm2');
    assert.strictEqual(visitorMessage.content, '群聊@消息', 'Pull 安全上下文不能污染原始 content');
    assert.strictEqual(visitorMessage.sourceType, 'visitor');
    assert.strictEqual(visitorMessage.trustLevel, 'untrusted');
    const peerMessage = r.messages.find(m => m.id === 'm-fetch-room1');
    assert.strictEqual(peerMessage.sourceType, 'agent_peer');
    assert.strictEqual(peerMessage.trustLevel, 'untrusted_peer');
    // A2A 控制信息通过结构化字段传递，不应污染 Pull 返回的原始正文。
    assert.strictEqual(peerMessage.content, '同群另一 Agent 消息', 'agent_peer 消息应剥离 A2A 控制块，只留正文');
    assert.strictEqual(peerMessage.hasControlBlock, false);
    assert.strictEqual(peerMessage.contentStripped, false);

    const blocked = await handlers.fetch_new_messages({ ...params, blockTimeout: 1 });
    assert.strictEqual(blocked.messages.length, 2, '阻塞轮询也应按指定群过滤');
    assert.ok(blocked.messages.every(m => m.channelId === 'room1' && m.channelType === 2), '阻塞轮询不能混入其他频道');
    assert.strictEqual(blocked.securityContext.policyId, 'voko-external-message-v1');
  } finally { delete global.__dispatcher; cleanup(); }
});
await test('单聊与群聊同名频道不会共享游标或串入消息', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    db.prepare(`UPDATE messages SET message_seq=? WHERE id=?`).run(1, 'm2');
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-direct-collision', 'visitor1', 'room1', '同名单聊消息', 'room1', 1, 'agentA', Date.now() + 4, 0, 'received', 1, 1);
    const group = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'room1', channelType: 2, onlyReplies: false });
    assert.ok(group.messages.every(m => m.channelType === 2), '群聊不应读到同名单聊');
    const direct = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'room1', channelType: 1, onlyReplies: false });
    assert.deepStrictEqual(direct.messages.map(m => m.id), ['m-direct-collision'], '单聊应使用独立游标并过滤群聊');
  } finally { delete global.__dispatcher; cleanup(); }
});

await test('同一频道的新阻塞轮询会安全取消旧轮询', async () => {
  const { handlers, cleanup } = setup();
  try {
    const params = {
      agentId: 'agentA',
      channelId: 'empty-room',
      channelType: 2,
      messageSeq: 0,
      onlyReplies: false,
      limit: 10,
    };
    const first = handlers.fetch_new_messages({ ...params, blockTimeout: 3 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = handlers.fetch_new_messages({ ...params, blockTimeout: 1 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(firstResult.success, true);
    assert.strictEqual(secondResult.success, true);
    assert.deepStrictEqual(firstResult.messages, []);
    assert.deepStrictEqual(secondResult.messages, []);
  } finally { cleanup(); }
});

await test('list_conversations 返回 channelType，群聊 needsReply=false', async () => {
  const { handlers, cleanup } = setup();
  try {
    const r = await handlers.list_conversations({ agentId: 'agentA', filter: 'all' });
    const group = r.conversations.find(c => c.channelType === 2);
    assert.ok(group, '应有群聊会话');
    assert.strictEqual(group.needsReply, false, '群聊 needsReply 应为 false');
  } finally { cleanup(); }
});

await test('list_conversations channelType=group 过滤只返回群聊', async () => {
  const { handlers, cleanup } = setup();
  try {
    const r = await handlers.list_conversations({ agentId: 'agentA', channelType: 'group', filter: 'all' });
    assert.ok(r.conversations.every(c => c.channelType === 2), '应全部是群聊');
  } finally { cleanup(); }
});

await test('create_group 调用群服务并返回 channelId', async () => {
  const { handlers, fetchCalls, cleanup } = setup();
  try {
    const r = await handlers.create_group({ agentId: 'agentA', name: '测试群' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.channelId, 'room-created');
    const call = fetchCalls.find(c => c.url.includes('/api/group/v1/create'));
    assert.ok(call, '应调用群创建接口');
    const body = JSON.parse(call.opts.body);
    assert.strictEqual(body.owner_uid, 'imuidA');
    assert.strictEqual(body.acting_agent_uid, 'imuidA');
    assert.strictEqual(body.name, '测试群');
  } finally { cleanup(); }
});

await test('accept_invitation 通过群信息接口校验成员身份', async () => {
  const { handlers, fetchCalls, cleanup } = setup({ activeOwner: 'b@b.com' });
  try {
    const r = await handlers.accept_invitation({ agentId: 'agentB', channelId: 'room1' });
    assert.strictEqual(r.success, true);
    const call = fetchCalls.find(c => c.url.includes('/api/group/v1/info'));
    assert.ok(call, '应调用群信息接口');
    const body = JSON.parse(call.opts.body);
    assert.strictEqual(body.channel_id, 'room1');
    assert.strictEqual(body.uid, 'imuidB');
  } finally { cleanup(); }
});

await test('invite_to_group 通过群服务邀请成员', async () => {
  const { handlers, fetchCalls, cleanup } = setup({ activeOwner: 'b@b.com' });
  try {
    const r = await handlers.invite_to_group({ agentId: 'agentB', channelId: 'room1', members: ['visitor1'] });
    assert.strictEqual(r.success, true);
    const call = fetchCalls.find(c => c.url.includes('/api/group/v1/invite'));
    assert.ok(call, '应调用群邀请接口');
    const body = JSON.parse(call.opts.body);
    assert.strictEqual(body.channel_id, 'room1');
    assert.strictEqual(body.operator_uid, 'imuidB');
    assert.deepStrictEqual(body.members, ['visitor1']);
  } finally { cleanup(); }
});
await test('invite_to_group 缺少 members 时不请求服务端并返回明确错误', async () => {
  const { handlers, fetchCalls, cleanup } = setup();
  try {
    const r = await handlers.invite_to_group({ agentId: 'agentA', channelId: 'room1' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'MEMBERS_REQUIRED');
    assert.strictEqual(fetchCalls.length, 0);
  } finally { cleanup(); }
});

await test('get_group_context 返回成员 + 最近群聊消息', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m3', 'imuidB', 'room1', '第二条无序列号消息', 'room1', 2, 'agentB', Date.now() + 2, 0, 'received', 1);
    const r = await handlers.get_group_context({ agentId: 'agentA', channelId: 'room1', limit: 20 });
    assert.strictEqual(r.success, true);
    assert.ok(r.members.length >= 1, '应有成员');
    assert.strictEqual(r.messages.length, 2, '没有 client_msg_no/message_seq 的消息也不能被合并');
    const mentionedMessage = r.messages.find(m => m.fromUid === 'visitor1');
    assert.deepStrictEqual(mentionedMessage.mention, { uids: ['imuidA'] }, 'group context should expose mention metadata');
    // 成员 isAgent 标记
    const agentMember = r.members.find(m => m.uid === 'imuidB');
    assert.strictEqual(agentMember.isAgent, true, 'imuidB 应标记为 agent');
  } finally { cleanup(); }
});

await test('get_group_context 对历史消息去重后分页', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-page', 'imuidB', 'room1', '较新的历史', 'room1', 2, 'agentB', Date.now() + 100, 0, 'received', 1);
    const first = await handlers.get_group_context({ agentId: 'agentA', channelId: 'room1', limit: 1, offset: 0 });
    const second = await handlers.get_group_context({ agentId: 'agentA', channelId: 'room1', limit: 1, offset: 1 });
    assert.strictEqual(first.messages.length, 1);
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(first.offset, 0);
    assert.strictEqual(second.messages.length, 1);
    assert.notStrictEqual(first.messages[0].content, second.messages[0].content);
  } finally { cleanup(); }
});

await test('get_group_context 透传 dissolved 状态和时间', async () => {
  const { handlers, cleanup } = setup({ groupStatus: 'dissolved' });
  try {
    const r = await handlers.get_group_context({ agentId: 'agentA', channelId: 'room1', limit: 20 });
    assert.strictEqual(r.status, 'dissolved');
    assert.strictEqual(r.dissolvedAt, '2026-07-26T12:00:00.000Z');
  } finally { cleanup(); }
});

await test('dissolve_group sends the authenticated user owned Agent identity', async () => {
  const { handlers, fetchCalls, cleanup } = setup();
  try {
    const r = await handlers.dissolve_group({ agentId: 'agentA', channelId: 'room1' });
    assert.strictEqual(r.success, true);
    const call = fetchCalls.find(c => c.url.includes('/api/group/v1/dissolve'));
    const body = JSON.parse(call.opts.body);
    assert.deepStrictEqual(body, { channel_id: 'room1', acting_agent_uid: 'imuidA' });
  } finally { cleanup(); }
});

await test('quit_group sends the authenticated user owned Agent identity and clears local conversation', async () => {
  const { db, handlers, fetchCalls, cleanup } = setup({ groupStatus: 'dissolved' });
  try {
    const r = await handlers.quit_group({ agentId: 'agentA', channelId: 'room1' });
    assert.strictEqual(r.success, true);
    const call = fetchCalls.find(c => c.url.includes('/api/group/v1/quit'));
    assert.deepStrictEqual(JSON.parse(call.opts.body), { channel_id: 'room1', acting_agent_uid: 'imuidA' });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_uid=? AND channel_id=? AND channel_type=2').get('imuidA', 'room1').n, 0);
  } finally { cleanup(); }
});

await test('search_groups 防御性过滤 dissolved 群', async () => {
  const { handlers, cleanup } = setup({ searchGroups: [
    { channel_id: 'room-active', status: 'active' },
    { channel_id: 'room-dissolved', status: 'dissolved' },
  ] });
  try {
    const r = await handlers.search_groups({ agentId: 'agentA', keyword: 'room' });
    assert.deepStrictEqual(r.groups.map(g => g.channel_id), ['room-active']);
  } finally { cleanup(); }
});

await test('search_groups 拒绝服务端返回的非数组群列表', async () => {
  const { handlers, cleanup } = setup({ searchGroups: { malformed: true } });
  try {
    const r = await handlers.search_groups({ agentId: 'agentA', keyword: 'room' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /群搜索服务返回的数据结构无效|invalid response/i);
  } finally { cleanup(); }
});

await test('decline_invitation 不调 subscriber_add，仅记录', async () => {
  const { handlers, fetchCalls, cleanup } = setup();
  try {
    const r = await handlers.decline_invitation({ agentId: 'agentA', channelId: 'room1' });
    assert.strictEqual(r.success, true);
    assert.ok(!fetchCalls.some(c => c.url.includes('/channel/subscriber_add')), '拒绝不应调 subscriber_add');
  } finally { cleanup(); }
});

await test('ask_human_for_help persists and emits the original group context', async () => {
  const { db, handlers, interventions, cleanup } = setup();
  try {
    const result = await handlers.ask_human_for_help({
      agentId: 'agentA', visitorId: 'visitor1', channelId: 'room1', channelType: 2,
      messageId: 'm2', problem: 'need owner decision', suggestion: 'approve'
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.conversationId, null, 'legacy intervention without a route remains compatible');
    const row = db.prepare('SELECT * FROM owner_interventions WHERE id=?').get(result.interventionId);
    assert.strictEqual(row.visitor_id, 'visitor1');
    assert.strictEqual(row.source_sender_uid, 'visitor1');
    assert.strictEqual(row.target_channel_id, 'room1');
    assert.strictEqual(row.target_channel_type, 2);
    assert.strictEqual(row.source_message_id, 'm2');
    assert.strictEqual(row.session_key, 'agent:agentA:group:room1');
    assert.strictEqual(interventions[0].targetChannelType, 2);
    assert.strictEqual(interventions[0].targetChannelId, 'room1');

    db.prepare("UPDATE owner_interventions SET status='unknown', owner_reply=? WHERE id=?")
      .run('approve', result.interventionId);
    const checked = await handlers.check_human_replies({ agentId: 'agentA', id: result.interventionId });
    assert.strictEqual(checked.interventions[0].status, 'unknown');
    assert.strictEqual(checked.interventions[0].ownerReply, 'approve');
    assert.strictEqual(checked.interventions[0].channelType, 2);
    assert.strictEqual(checked.interventions[0].channelId, 'room1');
    assert.strictEqual(checked.interventions[0].sourceSenderUid, 'visitor1');
  } finally { cleanup(); }
});

await test('ask_human_for_help binds a private intervention to the active E2EE route', async () => {
  const { db, handlers, interventions, cleanup } = setup();
  const release = registerActiveOwnerInterventionContext({
    agentId: 'agentA', channelId: 'actor-private', protocolConversationId: 'protocol-private',
    sessionScopeId: 'scope-private', sourceMessageId: 'source-private', visitorId: 'verified-visitor',
  });
  try {
    const result = await handlers.ask_human_for_help({
      agentId: 'agentA', visitorId: 'logical-visitor', problem: 'need owner decision',
    });
    assert.strictEqual(result.success, true);
    const row = db.prepare('SELECT * FROM owner_interventions WHERE id=?').get(result.interventionId);
    assert.strictEqual(row.visitor_id, 'verified-visitor');
    assert.strictEqual(row.source_sender_uid, 'verified-visitor');
    assert.strictEqual(row.target_channel_id, 'actor-private');
    assert.strictEqual(row.source_message_id, 'source-private');
    assert.strictEqual(row.route_security_mode, 'e2ee_v2');
    assert.strictEqual(row.e2ee_protocol_conversation_id, 'protocol-private');
    assert.strictEqual(row.e2ee_session_scope_id, 'scope-private');
    assert.strictEqual(interventions[0].targetChannelId, 'actor-private');
    assert.strictEqual(interventions[0].routeSecurityMode, 'e2ee_v2');
  } finally {
    release();
    cleanup();
  }
});

await test('ask_human_for_help prefers the verified source message over an explicit conversation', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    const conversations = new RoutingConversationStore(db);
    const routes = new MessageRouteStore(db);
    const sourceConversation = conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'group-source', channelId: 'room1', channelType: 2, origin: 'caller' });
    const otherConversation = conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'group-other', channelId: 'room1', channelType: 2, origin: 'caller' });
    routes.claimInbound({ messageId: 'm2', conversationId: sourceConversation.id, agentId: 'agentA',
      peerUid: 'visitor1', channelId: 'room1', channelType: 2 });
    const result = await handlers.ask_human_for_help({ agentId: 'agentA', visitorId: 'visitor1',
      channelId: 'room1', channelType: 2, replyToMessageId: 'm2', conversationId: otherConversation.id,
      problem: 'preserve exact source' });
    assert.strictEqual(result.conversationId, sourceConversation.id);
  } finally { cleanup(); }
});

await test('fetch_new_messages onlyNew:true 首次只锚定不回吐历史，后续返回新消息', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    // 给单聊消息补 message_seq，模拟 IM 已投递
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(5, 'm1');
    // 首次拉取（自动游标 0）+ onlyNew:true → 只锚定，返回空 + cursor
    const first = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', onlyNew: true });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.messages.length, 0, 'onlyNew 首次不应回吐历史');
    assert.strictEqual(first.anchored, true);
    assert.ok(first.cursor >= 5, '应把游标锚定到当前 maxSeq');
    // 此时插入一条新消息
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-new', 'visitor1', 'imuidA', '新消息', 'visitor1', 1, 'agentA', Date.now(), 0, 'received', 1, 9);
    // 再次拉取 → 只返回锚点之后的新消息
    const second = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', onlyNew: true });
    assert.deepStrictEqual(second.messages.map(m => m.id), ['m-new'], '后续只返回新消息，历史不被重复回吐');
  } finally { cleanup(); }
});

await test('fetch_new_messages clientId 隔离：两个客户端各自独立游标不互抢', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(5, 'm1');
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-extra', 'visitor1', 'imuidA', '第二条', 'visitor1', 1, 'agentA', Date.now(), 0, 'received', 1, 8);
    // 客户端 A 拉取（推进共享/自己的游标）
    const a = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', clientId: 'zcode', onlyReplies: false });
    assert.ok(a.messages.length > 0, '客户端 A 应拿到消息');
    assert.strictEqual(a.clientId, 'zcode');
    // 客户端 B 用不同 clientId 拉取 → 应独立拿到同样的消息（不被 A 抢走）
    const b = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', clientId: 'codex', onlyReplies: false });
    assert.deepStrictEqual(b.messages.map(m => m.id).sort(), ['m1', 'm-extra'].sort(), '不同 clientId 游标隔离，B 也能拿到消息');
    assert.strictEqual(b.clientId, 'codex');
    // 客户端 A 再次拉取 → 应为空（A 的游标已推进）
    const a2 = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', clientId: 'zcode', onlyReplies: false });
    assert.strictEqual(a2.messages.length, 0, 'A 的游标已推进，再次拉取为空');
  } finally { cleanup(); }
});

await test('fetch_new_messages onlyReplies 解耦：游标按全量 maxSeq 推进，不漏自己发的消息', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    // m1 是访客消息(seq=3)，再插一条 agent 自己发的消息(seq=7)
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(3, 'm1');
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-self', 'imuidA', 'visitor1', '我的回复', 'visitor1', 1, 'agentA', Date.now(), 1, 'sent', 1, 7);
    // 用 messageSeq=0 从头拉，onlyReplies=true（只返回访客消息）
    const r = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', messageSeq: 0, onlyReplies: true });
    assert.deepStrictEqual(r.messages.map(m => m.id), ['m1'], 'onlyReplies 只返回访客消息');
    assert.ok(r.cursor >= 7, '游标应按全量 maxSeq(7) 推进，而不是只到回复的 3');
    // 再次拉取（无新消息）应为空，且不会因游标只到 3 而漏掉 seq 4-7 的消息
    const r2 = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'visitor1', onlyReplies: true });
    assert.strictEqual(r2.messages.length, 0, '游标已按全量推进，无新消息');
  } finally { cleanup(); }
});

await test('get_chat_history order=asc 按时间正序返回', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    // m1(now) 之后插一条更早的消息，验证 asc 排序
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-early', 'visitor1', 'imuidA', '最早的消息', 'visitor1', 1, 'agentA', 1000, 0, 'received', 1);
    const asc = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'visitor1', order: 'asc' });
    assert.ok(asc.messages.length >= 2);
    // asc：最早在前，时间戳递增
    for (let i = 1; i < asc.messages.length; i++) {
      assert.ok(asc.messages[i - 1].timestamp <= asc.messages[i].timestamp, 'asc 应按时间正序');
    }
    const desc = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'visitor1' });
    // desc（默认）：最新在前
    assert.ok(desc.messages[0].timestamp >= desc.messages[desc.messages.length - 1].timestamp, '默认 desc 应最新在前');
  } finally { cleanup(); }
});

await test('fmtMsg 时间戳规范化：秒级 timestamp 转毫秒 timestampMs', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    // 插一条秒级时间戳的消息（模拟旧数据/某些落库路径用秒）
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-sec', 'visitor1', 'imuidA', '秒级时间戳', 'visitor1', 1, 'agentA', 1700000000, 0, 'received', 1);
    const r = await handlers.get_chat_history({ agentId: 'agentA', channelId: 'visitor1', order: 'asc' });
    const msg = r.messages.find(m => m.id === 'm-sec');
    assert.ok(msg, '应找到秒级时间戳消息');
    assert.strictEqual(msg.timestamp, 1700000000, '保留原始秒级 timestamp');
    assert.strictEqual(msg.timestampMs, 1700000000000, 'timestampMs 应规范化为毫秒');
  } finally { cleanup(); }
});

await test('fetch_new_messages 剥离 agent_peer 入站 A2A 控制块，visitor 原样', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    global.__dispatcher = createDispatcher({ db, providers: {} });
    // m2 是 visitor 群聊消息；再插一条 agent_peer 群聊消息。
    db.prepare('UPDATE messages SET message_seq=? WHERE id=?').run(1, 'm2');
    db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type, message_seq, mention) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('m-peer', 'imuidB', 'room1', '对端 Agent 正文', 'room1', 2, 'agentB', Date.now() + 2, 0, 'received', 1, 2, JSON.stringify({ uids: ['imuidA'] }));
    const r = await handlers.fetch_new_messages({ agentId: 'agentA', channelId: 'room1', channelType: 2, messageSeq: 0, onlyReplies: false });
    const peer = r.messages.find(m => m.id === 'm-peer');
    assert.ok(peer, '应有 agent_peer 消息');
    assert.strictEqual(peer.sourceType, 'agent_peer');
    assert.strictEqual(peer.content, '对端 Agent 正文');
    assert.strictEqual(peer.hasControlBlock, false);
    assert.strictEqual(peer.contentStripped, false);
    // visitor 消息原样，不带控制块标记
    const visitor = r.messages.find(m => m.id === 'm2');
    assert.strictEqual(visitor.content, '群聊@消息');
    assert.strictEqual(visitor.hasControlBlock, false);
    assert.strictEqual(visitor.contentStripped, false);
  } finally { delete global.__dispatcher; cleanup(); }
});

await test('session-scoped MCP Pull atomically claims an unthreaded group mention', async () => {
  const { db, handlers, cleanup } = setup();
  try {
    db.prepare("UPDATE agents SET backend_type='codex' WHERE agent_id='agentA'").run();
    db.prepare('UPDATE messages SET message_seq=1 WHERE id=?').run('m2');
    db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)').run(
      'feature:session_scoped_pull_v1',
      JSON.stringify({ enabled: true, providerFamilies: ['codex'], channelTypes: [2], contentTypes: [1] }),
      Date.now(),
    );
    const conversations = new RoutingConversationStore(db);
    const a = conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'thread-a', channelId: 'room1', channelType: 2, origin: 'caller' });
    conversations.resolveOrCreate({ agentId: 'agentA', providerFamily: 'codex',
      nativeSessionId: 'thread-b', channelId: 'room1', channelType: 2, origin: 'caller' });
    const params = { agentId: 'agentA', channelId: 'room1', channelType: 2,
      messageSeq: 0, onlyReplies: false, limit: 50 };
    const first = await runWithProviderCaller({ source: 'mcp', providerType: 'codex',
      nativeSessionId: 'thread-a', evidence: 'trusted-test' }, () => handlers.fetch_new_messages(params));
    assert.deepStrictEqual(first.messages.map(message => message.id), ['m2']);
    assert.strictEqual(first.messages[0].conversationId, a.id);
    assert.strictEqual(db.prepare(`SELECT conversation_id FROM provider_message_routes
      WHERE message_id='m2' AND agent_id='agentA' AND direction='inbound'`).get().conversation_id, a.id);
    const second = await runWithProviderCaller({ source: 'mcp', providerType: 'codex',
      nativeSessionId: 'thread-b', evidence: 'trusted-test' }, () => handlers.fetch_new_messages(params));
    assert.deepStrictEqual(second.messages, []);
  } finally { cleanup(); }
});

// ========================================
console.log('\n========================================');
console.log(`群聊 MCP 工具测试: ${pass} 通过, ${fail} 失败`);
console.log('========================================\n');
process.exit(fail > 0 ? 1 : 0);
}

main();
