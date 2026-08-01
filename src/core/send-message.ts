/**
 * VOKO 发送 IM 消息共享逻辑
 *
 * 供桌面端主进程（src/main.js）的 IPC handler、HTTP API、MCP 工具共同调用。
 *
 * 统一投递入口：createDeliver —— 唯一决定"走 Worker 还是 wukongIM 直连"的地方。
 *   - Worker 入口存在（已发布 agent 的常驻连接）→ Worker IPC（fire-and-forget）
 *   - 否则 → wukongimSender 直连（CLI 模式 / 未发布 / worker 异常时的兜底）
 * 所有发送点（send_message、sendSystemMessage、agent 回复、支付通知）都应经 deliver，
 * 不再各自内联 worker.send 或自写兜底。
 */

const ac = require('./access-control-api');
const bus = require('./lite-bus');
import type { DatabaseLike } from '../types/database';

interface WorkerEntry {
  worker: { send(message: Record<string, unknown>): void };
}

interface SendResult {
  success: boolean;
  via?: string;
  messageId?: string;
  clientMsgNo?: string;
  messageSeq?: number;
  error?: string;
  [key: string]: unknown;
}

interface SenderLike {
  send(...args: unknown[]): Promise<Partial<SendResult> | undefined>;
}

type Deliver = (
  agentId: string,
  channelId: string,
  content: string,
  messageType?: string,
  channelType?: number,
  mentions?: unknown,
  localMsgId?: string | null,
) => Promise<SendResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创建统一投递函数 deliver(agentId, channelId, content, messageType)
 *
 * 这是全仓唯一的"worker 优先 → wukongIM 直连兜底"判定点。
 * @param {object} deps
 * @param {Map} deps.agentWorkers - agentId → { worker, config } Worker 进程 Map
 * @param {object} deps.wukongimSender - { send(agentId, channelId, content, messageType) } 直连发送器
 * @returns {Function} async deliver → { success, via, messageId?, error?, ... }
 */
function createDeliver({ agentWorkers, wukongimSender }: {
  agentWorkers?: Map<string, WorkerEntry>;
  wukongimSender?: SenderLike;
}): Deliver {
  return async function deliver(agentId: string, channelId: string, content: string, messageType = 'text', channelType = 1, mentions: unknown = null, localMsgId: string | null = null) {
    // 优先走 Worker（已发布 agent 的常驻 IM 连接）
    const workerEntry = agentWorkers?.get(agentId);
    if (workerEntry) {
      // 优先用调用方传入的 localMsgId（= persistAgentMessage 落库的 msgId），
      // 使 sent 事件回填 UPDATE 能按 id 命中、补上 client_msg_no/message_seq
      const lmId = localMsgId || `msg-${agentId}-${channelId}-${Date.now()}`;
      workerEntry.worker.send({ type: 'send', channelId, content, messageType, localMsgId: lmId, channelType, mentions });
      return { success: true, via: 'worker', messageId: lmId };
    }

    // 兜底：wukongIM 直连（CLI 模式 / 未发布 / worker 异常）
    if (!wukongimSender) {
      return { success: false, via: 'none', error: 'wukongIM 发送器未初始化' };
    }
    try {
      const r = await wukongimSender.send(agentId, channelId, content, messageType, channelType, mentions);
      return { success: r?.success !== false, via: 'wukongim', ...(r || {}) };
    } catch (e: unknown) {
      return { success: false, via: 'wukongim', error: errorMessage(e) };
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
) {
  const now = Date.now();
  const msgId = `msg-${agentId}-${channelId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = Math.floor(now / 1000);
  const uid = fromUid || 'voko';

  // content_type: 1=文字, 2=图片, 3=文件
  let contentType = 1;
  if (messageType === 'image') contentType = 2;
  else if (messageType === 'file') contentType = 3;

  try {
    db.prepare(`
      INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, mention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, uid, channelId, content, channelId, channelType || 1, agentId, timestamp, 1, 'sent', null, null, 0, 0, 0, contentType, mentions ? JSON.stringify(mentions) : null);
  } catch (e: unknown) {
    const message = errorMessage(e);
    if (!message.includes('UNIQUE constraint')) {
      console.error('[sendMessage] 写入消息失败:', message);
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
  agentWorkers?: Map<string, WorkerEntry>;
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
    const { msgId, timestamp, contentType } = persistAgentMessage(db, agentId, channelId, content, fromUid, messageType, channelType, mentions);

    // 3. 统一投递（worker 优先 → wukongIM 直连兜底）
    const sendResult = await deliver(agentId, channelId, content, messageType || 'text', channelType || 1, mentions || null, msgId);

    // 4. 通知渲染进程（通过事件总线）
    bus.emit('agent-wukongim:message', {
      agentId, fromUid: fromUid || 'voko', toUid: channelId, channelId, content,
      channelType: channelType || 1, mention: mentions || null,
      messageId: sendResult.messageId || msgId, messageSeq: sendResult.messageSeq ?? null, timestamp, isMe: true, contentType
    });

    if (!sendResult.success) {
      return { success: false, error: sendResult.error, messageId: sendResult.messageId || msgId };
    }

    return { success: true, messageId: sendResult.messageId || msgId, clientMsgNo: sendResult.clientMsgNo, messageSeq: sendResult.messageSeq };
  };
}

module.exports = { createDeliver, createSendMessage, persistAgentMessage };
