/**
 * VOKO 发送 IM 消息共享逻辑
 *
 * 供桌面端主进程（src/main.js）的 IPC handler、HTTP API、MCP 工具共同调用。
 *
 * 统一投递入口：createDeliver —— 所有消息经共享 VokoIMSDK Hub 发送并等待 SENDACK。
 * 所有发送点（send_message、sendSystemMessage、agent 回复、支付通知）都应经 deliver，
 * 不再各自内联 worker.send 或自写兜底。
 */

const ac = require('./access-control-api');
const bus = require('./lite-bus');
import type { DatabaseLike } from '../types/database';

interface SendResult {
  success: boolean;
  via?: string;
  messageId?: string;
  serverMessageId?: string;
  clientMsgNo?: string;
  messageSeq?: number;
  error?: string;
  [key: string]: unknown;
}

interface TransportLike {
  deliver(
    agentId: string,
    channelId: string,
    content: string,
    messageType?: string,
    channelType?: number,
    mentions?: unknown,
    localMsgId?: string | null,
    metadata?: unknown,
  ): Promise<Partial<SendResult> | undefined>;
}

type Deliver = (
  agentId: string,
  channelId: string,
  content: string,
  messageType?: string,
  channelType?: number,
  mentions?: unknown,
  localMsgId?: string | null,
  metadata?: unknown,
) => Promise<SendResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创建统一投递函数 deliver(agentId, channelId, content, messageType)
 *
 * 这是全仓唯一的 IM 传输调用点。
 * @param {object} deps
 * @param {object} deps.transportManager - 共享 Hub 传输管理器
 * @returns {Function} async deliver → { success, via, messageId?, error?, ... }
 */
function createDeliver({ transportManager }: {
  transportManager: TransportLike;
}): Deliver {
  return async function deliver(agentId: string, channelId: string, content: string, messageType = 'text', channelType = 1, mentions: unknown = null, localMsgId: string | null = null, metadata: unknown = null) {
    const lmId = localMsgId || `msg-${agentId}-${channelId}-${Date.now()}`;
    console.log(
      `[IM 发送] agent=${agentId} channel=${channelId} channelType=${channelType}`
      + ` type=${messageType} messageId=${lmId} contentLength=${String(content ?? '').length}`,
    );
    try {
      const result = await transportManager.deliver(agentId, channelId, content, messageType, channelType, mentions, lmId, metadata);
      if (result?.success !== false) {
        console.log(
          `[IM SENDACK] agent=${agentId} channel=${channelId} messageId=${result?.messageId || lmId}`
          + ` seq=${result?.messageSeq ?? '-'} clientMsgNo=${result?.clientMsgNo || lmId}`,
        );
      } else {
        console.error(`[IM 发送失败] agent=${agentId} channel=${channelId} messageId=${lmId} error=${result?.error || 'unknown'}`);
      }
      return {
        ...(result || {}),
        success: result?.success !== false,
        via: 'hub',
        // messageId is the stable local identifier used by messages and
        // provider_message_routes. Keep the IM ACK id separately so callers
        // can immediately use messageId for precise replies.
        messageId: lmId,
        ...(result?.messageId && result.messageId !== lmId ? { serverMessageId: result.messageId } : {}),
      };
    } catch (e: unknown) {
      console.error(`[IM 发送失败] agent=${agentId} channel=${channelId} messageId=${lmId} error=${errorMessage(e)}`);
      return { success: false, via: 'hub', messageId: lmId, error: errorMessage(e) };
    }
  };
}

/**
 * 落库 agent 发出的消息（写 messages + 更新 conversations）。
 * 不含投递、白名单、UI 通知——这些由调用方按需叠加。
 *
 * 为什么独立出来：handleAgentReply 是"先落库→出站审核→（hard_deny 则不投递）→投递"，
 * 落库与投递必须解耦；故抽出共享落库点，供 createSendMessage（落库即投递）
 * 与 handleAgentReply（落库→审核→投递）共用。
 *
 * @param {object} db - better-sqlite3 实例
 * @returns {{msgId:string, timestamp:number, contentType:number}}
 */
function persistAgentMessage(
  db: DatabaseLike,
  agentId: string,
  channelId: string,
  content: string,
  fromUid?: string,
  messageType = 'text',
  channelType = 1,
  mentions: unknown = null,
  requestedMessageId?: string,
) {
  const now = Date.now();
  const msgId = requestedMessageId || `msg-${agentId}-${channelId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = Math.floor(now / 1000);
  const uid = fromUid || 'voko';

  // content_type: 1=文字, 2=图片, 8=文件（WuKongIM 官方应用层约定）
  let contentType = 1;
  if (messageType === 'image') contentType = 2;
  else if (messageType === 'file') contentType = 8;

  try {
    db.prepare(`
      INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, mention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, uid, channelId, content, channelId, channelType || 1, agentId, timestamp, 1, 'pending', null, null, 0, 0, 0, contentType, mentions ? JSON.stringify(mentions) : null);
  } catch (e: unknown) {
    const message = errorMessage(e);
    if (!message.includes('UNIQUE constraint')) {
      console.error('[sendMessage] 写入消息失败:', message);
      throw e;
    }
  }

  try {
    const agentRow = db.prepare(`SELECT imUid FROM agents WHERE agent_id = ?`).get<{ imUid?: string }>(agentId);
    const convUserUid = agentRow?.imUid || uid;
    // 用 (user_uid, channel_id) 查找（匹配表主键），存在则更新否则插入
    const exist = db.prepare(`SELECT user_uid FROM conversations WHERE user_uid = ? AND channel_id = ?`).get(convUserUid, channelId);
    if (exist) {
      db.prepare(`UPDATE conversations SET last_message = ?, last_timestamp = ? WHERE user_uid = ? AND channel_id = ?`)
        .run(content, timestamp, convUserUid, channelId);
    } else {
      db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(convUserUid, channelId, channelType || 1, channelId, content, timestamp, 0, agentId);
    }
  } catch (_) {} // 并发写可能触发 UNIQUE，不影响功能

  return { msgId, timestamp, contentType };
}

/**
 * 创建 sendMessage —— agent 主动发出的消息（自动加白名单 + 落库 + 投递 + UI 通知）。
 * 落库走共享 persistAgentMessage，投递走共享 deliver。
 *
 * @param {object} deps
 * @param {object} deps.db - better-sqlite3 数据库实例
 * @param {Function} deps.deliver - createDeliver 返回的统一投递函数
 * @param {Map} [deps.agentWorkers] - 仅保留给老调用方/签名兼容，投递已由 deliver 内部判断
 * @param {BrowserWindow|null} deps.mainWindow - Electron 主窗口实例
 * @returns {Function} sendMessage(agentId, channelId, content, fromUid, messageType)
 */
function createSendMessage({ db, deliver }: {
  db: DatabaseLike;
  deliver: Deliver;
  agentWorkers?: Map<string, unknown>;
  mainWindow?: unknown;
}) {
  return async function sendMessage(
    agentId: string,
    channelId: string,
    content: string,
    fromUid?: string,
    messageType = 'text',
    channelType = 1,
    mentions?: unknown,
    requestedMessageId?: string,
    metadata?: unknown,
  ) {
    // 归一化换行：客户端可能将 \n 作为字面字符发送
    content = content.replace(/\\n/g, '\n');

    // 1. 自动将接收方加入白名单（主动发消息 = 信任访客，避免对方回复被私密模式拦截）
    //    群聊（channelType=2）的 channelId 是 roomId，不是访客，跳过白名单
    if (channelType !== 2) {
      try {
        if (!ac.isWhitelisted(db, agentId, channelId)) {
          ac.addEntry(db, { agentId, listType: 'whitelist', visitorId: channelId, source: 'outbound_contact' });
        }
      } catch (_) { /* 静默失败不影响消息发送 */ }
    }

    // 2. 落库（共享：messages + conversations）
    const { msgId, timestamp, contentType } = persistAgentMessage(
      db, agentId, channelId, content, fromUid, messageType, channelType, mentions, requestedMessageId,
    );

    // 3. 统一通过共享 Hub 投递并等待 SENDACK
    const sendResult = await deliver(agentId, channelId, content, messageType || 'text', channelType || 1, mentions || null, msgId, metadata);

    // 4. 通知渲染进程（通过事件总线）
    bus.emit('agent-wukongim:message', {
      agentId, fromUid: fromUid || 'voko', toUid: channelId, channelId, content,
      channelType: channelType || 1, mention: mentions || null,
      messageId: msgId, messageSeq: sendResult.messageSeq ?? null, timestamp, isMe: true, contentType
    });

    if (!sendResult.success) {
      try { db.prepare(`UPDATE messages SET status='failed' WHERE id=?`).run(msgId); } catch (_) {}
      return { success: false, error: sendResult.error, messageId: msgId, serverMessageId: sendResult.serverMessageId };
    }

    try {
      const messageSeq = Number.isFinite(Number(sendResult.messageSeq)) ? Number(sendResult.messageSeq) : null;
      const clientMsgNo = sendResult.clientMsgNo ? String(sendResult.clientMsgNo) : null;
      db.prepare(`
        UPDATE messages
        SET status='sent',
            message_seq=COALESCE(?, message_seq),
            client_msg_no=COALESCE(?, client_msg_no)
        WHERE id=?
      `).run(messageSeq, clientMsgNo, msgId);
    } catch (_) {}

    return {
      success: true,
      messageId: msgId,
      serverMessageId: sendResult.serverMessageId,
      clientMsgNo: sendResult.clientMsgNo,
      messageSeq: sendResult.messageSeq,
    };
  };
}

module.exports = { createDeliver, createSendMessage, persistAgentMessage };
