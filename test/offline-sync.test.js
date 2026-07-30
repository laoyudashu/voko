/**
 * 离线消息同步测试
 *
 * 测试 syncOfflineMessages 函数的 payload 解码、字段映射逻辑
 * 不依赖 voko 运行中，可独立执行
 *
 * 运行方式: node --test __tests__/offline-sync.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

// 模拟 syncOfflineMessages 中的 payload 解码逻辑
function decodePayload(payload) {
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return { content: decoded.content || '', contentType: decoded.type || 1 };
  } catch (e) {
    return { content: '', contentType: 1 };
  }
}

// 模拟 to_uid 推断逻辑
function inferToUid(fromUid, agentImUid, channelId) {
  return fromUid === agentImUid ? channelId : agentImUid;
}

// 模拟同步处理一条消息
function processSyncMessage(msg, agentImUid, channelId) {
  const msgId = msg.message_id || msg.messageID;
  let content = msg.content || '';
  let contentType = msg.content_type || 1;
  if (msg.payload && !content) {
    const decoded = decodePayload(msg.payload);
    content = decoded.content;
    contentType = decoded.contentType;
  }
  const toUid = inferToUid(msg.from_uid, agentImUid, channelId);

  return {
    msgId,
    channelId,
    fromUid: msg.from_uid || '',
    toUid,
    content,
    contentType,
    timestamp: msg.timestamp || 0,
    messageSeq: msg.message_seq,
    clientMsgNo: msg.client_msg_no,
    noPersist: msg.header?.no_persist ? 1 : 0,
    redDot: msg.header?.red_dot ? 1 : 0,
    syncOnce: msg.header?.sync_once ? 1 : 0,
    raw: msg
  };
}

// WukongIM API 返回的真实 payload (base64)
const PAYLOAD_VISITOR = Buffer.from(JSON.stringify({
  content: '刚刚为什么说问题有点多，我上一轮问了你哪些问题',
  type: 1
})).toString('base64');

const PAYLOAD_AGENT = Buffer.from(JSON.stringify({
  content: '好的，让我一个一个回答你！',
  type: 1
})).toString('base64');

const AGENT_IMUID = 'agent_ec7aa3361b07689a';
const CHANNEL_ID = 'user_03xzxgoz_mp1ill49';

describe('Payload 解码', () => {
  it('正确解析 base64 payload', () => {
    const { content, contentType } = decodePayload(PAYLOAD_VISITOR);
    assert.ok(content.includes('问题有点多'));
    assert.equal(contentType, 1);
  });

  it('空 payload 返回默认值', () => {
    const { content, contentType } = decodePayload('');
    assert.equal(content, '');
    assert.equal(contentType, 1);
  });

  it('无效 payload 不崩溃', () => {
    const { content } = decodePayload('!!!invalid!!!');
    assert.equal(content, '');
  });
});

describe('to_uid 推断', () => {
  it('访客→Agent: to_uid = agent.imUid', () => {
    const toUid = inferToUid('user_visitor', AGENT_IMUID, CHANNEL_ID);
    assert.equal(toUid, AGENT_IMUID);
  });

  it('Agent→访客: to_uid = conv.channel_id', () => {
    const toUid = inferToUid(AGENT_IMUID, AGENT_IMUID, CHANNEL_ID);
    assert.equal(toUid, CHANNEL_ID);
  });
});

describe('消息字段完整性', () => {
  it('访客消息：所有新字段正确填充', () => {
    const result = processSyncMessage({
      message_id: '2061912684021846016',
      message_seq: 125,
      from_uid: 'user_03xzxgoz_mp1ill49',
      client_msg_no: '2e4f9f1fcf93939494317aec3252e826_0_3',
      header: { no_persist: 0, red_dot: 0, sync_once: 0 },
      payload: PAYLOAD_VISITOR,
      timestamp: 1780433267
    }, AGENT_IMUID, CHANNEL_ID);

    assert.ok(result.msgId);
    assert.equal(result.messageSeq, 125);
    assert.equal(result.clientMsgNo, '2e4f9f1fcf93939494317aec3252e826_0_3');
    assert.equal(result.contentType, 1);
    assert.equal(result.noPersist, 0);
    assert.equal(result.redDot, 0);
    assert.equal(result.toUid, AGENT_IMUID);
    assert.ok(result.content.includes('问题有点多'));
  });

  it('Agent回复消息：所有新字段正确填充', () => {
    const result = processSyncMessage({
      message_id: '2061912806239670272',
      message_seq: 126,
      from_uid: AGENT_IMUID,
      client_msg_no: 'e4e753ae3857cd53248fdd32b6d5df95_0_3',
      header: { no_persist: 0, red_dot: 1, sync_once: 0 },
      payload: PAYLOAD_AGENT,
      timestamp: 1780433296
    }, AGENT_IMUID, CHANNEL_ID);

    assert.ok(result.msgId);
    assert.equal(result.messageSeq, 126);
    assert.equal(result.clientMsgNo, 'e4e753ae3857cd53248fdd32b6d5df95_0_3');
    assert.equal(result.contentType, 1);
    assert.equal(result.redDot, 1);
    assert.equal(result.toUid, CHANNEL_ID);
    assert.ok(result.content.includes('一个一个回答'));
  });

  it('header 缺字段不崩溃', () => {
    const result1 = processSyncMessage({
      message_id: 'test1',
      message_seq: 100,
      from_uid: 'user_test',
      payload: PAYLOAD_VISITOR
    }, AGENT_IMUID, CHANNEL_ID);
    assert.equal(result1.noPersist, 0);
    assert.equal(result1.redDot, 0);
    assert.equal(result1.syncOnce, 0);

    const result2 = processSyncMessage({
      message_id: 'test2',
      message_seq: 101,
      from_uid: 'user_test',
      header: {},
      payload: PAYLOAD_VISITOR
    }, AGENT_IMUID, CHANNEL_ID);
    assert.equal(result2.noPersist, 0);
    assert.equal(result2.redDot, 0);
    assert.equal(result2.syncOnce, 0);
  });
});

describe('端口映射', () => {
  it('WS:5200 → API:5001', () => {
    const url = 'ws://8.153.167.187:5200'
      .replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
      .replace(/:5200(?=\/|$)/, ':5001');
    assert.equal(url, 'http://8.153.167.187:5001');
  });

  it('自定义端口不变', () => {
    const url = 'ws://example.com:9999'
      .replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
      .replace(/:5200(?=\/|$)/, ':5001');
    assert.equal(url, 'http://example.com:9999');
  });
});
