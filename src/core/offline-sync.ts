/**
 * offline-sync.js — 离线消息同步
 *
 * 从 WuKongIM 服务端拉取遗漏的离线消息，逐条入库后按组分批转发给 agent。
 * 纯 Node.js，无 Electron 依赖。
 *
 * @module
 */

const {
  enqueueDbWrite,
  getCurrentUserEmail,
  getUserAccessToken,
  waitForDbQueue,
} = require('./database');
const { t, getLocale } = require('./i18n');
const { advanceCheckpoint, getCheckpoint, setCheckpoint } = require('./checkpoint-store');
const ENDPOINTS = require('../endpoints.json');
import type { DatabaseLike } from '../types/database';
import type { ForwardPayload, InboundMessage } from './messenger-types';

interface AgentRow {
  agent_id: string;
  imUid: string;
  imToken: string;
  im_server_url: string;
  owner_email?: string | null;
}

interface ConversationRow { channel_id: string }
interface MaxSeqRow { m?: number | null }
interface CursorRow { data?: string | null }

interface SyncMessage {
  message_id?: string;
  messageID?: string;
  content?: string;
  content_type?: number;
  payload?: string;
  from_uid?: string;
  timestamp?: number;
  message_seq?: number;
  client_msg_no?: string;
  header?: { no_persist?: boolean; red_dot?: boolean; sync_once?: boolean };
}

interface MessageHandlerLike {
  handleAgentMessage(agentId: string, data: InboundMessage, skipForward: boolean): ForwardPayload | undefined;
  forwardToAgent(...args: unknown[]): unknown;
}

const OFFLINE_SYNC_CURSOR_CONFIG_TYPE = 'offline_sync_cursors';
const CHECKPOINT_NAMESPACE = 'offline_messages';

function cursorKey(agentId: string, channelId: string): string {
  return JSON.stringify([agentId, channelId]);
}

function loadCursorMap(db: DatabaseLike): Record<string, number> {
  try {
    const row = db.prepare('SELECT data FROM config WHERE type=?')
      .get<CursorRow>(OFFLINE_SYNC_CURSOR_CONFIG_TYPE);
    const parsed = row?.data ? JSON.parse(row.data) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveCursorMap(db: DatabaseLike, advances: Map<string, number>): void {
  if (!advances.size) return;
  const cursors = loadCursorMap(db);
  for (const [key, seq] of advances) {
    cursors[key] = advanceCheckpoint(db, CHECKPOINT_NAMESPACE, key, seq);
  }
  db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
    .run(OFFLINE_SYNC_CURSOR_CONFIG_TYPE, JSON.stringify(cursors), Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 拉取离线消息并转发
 *
 * @param {object} db - better-sqlite3 实例
 * @param {object} messageHandler - MessageHandler 实例（需有 handleAgentMessage / forwardToAgent）
 * @param {string} [agentIdFilter] - 可选，仅同步指定 agent
 * @returns {Promise<number>} 同步的消息总数
 */
async function syncOfflineMessages(db: DatabaseLike, messageHandler?: MessageHandlerLike, agentIdFilter?: string): Promise<number> {
  if (!messageHandler) {
    console.log('[离线同步] 跳过：messageHandler 未初始化（Lite 独立模式下无需同步）');
    return 0;
  }
  try {
    // 离线同步必须绑定当前登录用户。没有当前用户时，不能按 agents 表的
    // “最近 owner”或全表回退，否则会把其他用户/其他电脑的 Agent 消息拉到本机。
    const currentOwnerEmail = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
    if (!currentOwnerEmail) return 0;
    const agents = db.prepare(`
      SELECT agent_id, imUid, imToken, im_server_url, owner_email
      FROM agents
      WHERE publish_status = 'published' AND LOWER(TRIM(owner_email)) = ?
    `).all<AgentRow>(currentOwnerEmail);
    const cursorMap = loadCursorMap(db);
    const pendingMessages: Array<{ agentId: string; data?: InboundMessage; cursorKey: string; messageSeq?: number }> = [];

    for (const agent of agents) {
      if (agentIdFilter && agent.agent_id !== agentIdFilter) {
        continue;
      }
      const ownerEmail = String(agent.owner_email || '').trim().toLowerCase();
      const userAccessToken = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
      const httpBase = String(ENDPOINTS.im.apiBaseUrl || '').replace(/\/$/, '');
      const convs = db.prepare(`SELECT DISTINCT channel_id FROM conversations WHERE agent_id = ?`).all<ConversationRow>(agent.agent_id);

      for (const conv of convs) {
        const maxRow = db.prepare(`SELECT MAX(message_seq) as m FROM messages WHERE channel_id = ? AND agent_id = ?`).get<MaxSeqRow>(conv.channel_id, agent.agent_id);
        const key = cursorKey(agent.agent_id, conv.channel_id);
        let checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, key);
        if (!checkpoint && cursorMap[key] !== undefined) {
          setCheckpoint(db, CHECKPOINT_NAMESPACE, key, 'sequence', cursorMap[key]);
          checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, key);
        }
        const startSeq = Math.max(maxRow?.m || 0, Number(checkpoint?.committedValue) || 0, Number(cursorMap[key]) || 0) + 1;

        try {
          const resp = await fetch(`${httpBase}/channel/messagesync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(userAccessToken ? {
                Authorization: `Bearer ${userAccessToken}`,
                'X-Voko-Agent-Uid': agent.imUid,
              } : {}),
            },
            body: JSON.stringify({
              login_uid: agent.imUid,
              channel_id: conv.channel_id,
              channel_type: 1,
              start_message_seq: startSeq,
              end_message_seq: 0,
              limit: 100,
              pull_mode: 1
            })
          });
          if (!resp.ok) {
            console.warn(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} HTTP ${resp.status}`);
            continue;
          }
          const data = await resp.json() as { messages?: SyncMessage[] };
          const msgs = data.messages || [];

          for (const msg of msgs) {
            const msgId = msg.message_id || msg.messageID;
            const messageSeq = Number.isSafeInteger(Number(msg.message_seq)) && Number(msg.message_seq) > 0
              ? Number(msg.message_seq)
              : undefined;
            if (!msgId) {
              pendingMessages.push({ agentId: agent.agent_id, cursorKey: key, messageSeq });
              continue;
            }
            let content = msg.content || '';
            let contentType = msg.content_type || 1;
            if (msg.payload && !content) {
              try {
                const decoded = JSON.parse(Buffer.from(msg.payload, 'base64').toString());
                content = decoded.content || '';
                contentType = decoded.type || 1;
              } catch (_) {}
            }
            const toUid = msg.from_uid === agent.imUid ? conv.channel_id : agent.imUid;
            pendingMessages.push({
              agentId: agent.agent_id,
              cursorKey: key,
              messageSeq,
              data: {
                fromUid: msg.from_uid || '',
                toUid,
                channelId: conv.channel_id,
                channelType: 1,
                content,
                contentType,
                messageId: msgId,
                timestamp: msg.timestamp || 0,
                messageSeq,
                clientMsgNo: msg.client_msg_no,
                noPersist: msg.header?.no_persist ? 1 : 0,
                redDot: msg.header?.red_dot ? 1 : 0,
                syncOnce: msg.header?.sync_once ? 1 : 0
              }
            });
          }
        } catch (e: unknown) {
          console.error(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} 请求失败:`, errorMessage(e));
        }
      }
    }

    console.log(`[离线同步] 共收集 ${pendingMessages.length} 条离线消息${pendingMessages.length ? '，开始处理...' : ''}`);

    // 逐条审核落库（skipForward=true），收集“通过审核、待转发”的载荷。
    // handleAgentMessage 是同步函数，enqueueDbWrite 回调内 push 到闭包外数组可正常收集
    // （enqueueDbWrite 的 .then(fn,fn) 会吞掉返回值，必须用闭包外数组，不能从其取回）。
    // UNIQUE constraint 时返回 undefined 跳过已存在的消息，所以无论 WebSocket 是否已处理过，
    // 都不会重复通知 UI。
    const collected: ForwardPayload[] = [];
    await new Promise<void>(resolve => {
      enqueueDbWrite(() => {
        const supportsTransactions = typeof (db as any).exec === 'function';
        if (supportsTransactions) (db as any).exec('BEGIN IMMEDIATE');
        try {
          const advances = new Map<string, number>();
          for (const p of pendingMessages) {
            if (p.data) {
              const payload = messageHandler.handleAgentMessage(p.agentId, p.data, true);
              if (payload) collected.push(payload);
            }
            if (p.messageSeq !== undefined) {
              advances.set(p.cursorKey, Math.max(advances.get(p.cursorKey) || 0, p.messageSeq));
            }
          }
          saveCursorMap(db, advances);
          if (supportsTransactions) (db as any).exec('COMMIT');
        } catch (error) {
          if (supportsTransactions) {
            try { (db as any).exec('ROLLBACK'); } catch (_) {}
          }
          throw error;
        }
      });
      waitForDbQueue().then(() => setImmediate(resolve));
    });

    // 按 (agentId, channelId) 分组，同一会话的连续离线消息合并为一条 prompt 转发，
    // 避免 forwardToAgent 的 fire-and-forget 逐条投递导致 agent thinking 中被打断。
    // 单条消息不包装，直接转发原文。
    const groups = new Map<string, ForwardPayload[]>();
    for (const p of collected) {
      const key = `${p.agentId}|${p.channelId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }

    let forwarded = 0;
    for (const [, msgs] of groups) {
      const last = msgs[msgs.length - 1];
      const merged = msgs.length === 1
        ? last.content
        : t('errors.offline.merged', { count: msgs.length }, getLocale()) + '\n'
          + msgs.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
      messageHandler.forwardToAgent(last.agentId, last.fromUid, merged, last.channelId,
        last.channelType, last.contentType, last.messageId, last.timestamp, last.mention || null);
      forwarded++;
    }

    // console.log(`[离线同步] 完成，${pendingMessages.length} 条入库，通过审核 ${collected.length} 条，合并为 ${forwarded} 次转发`);
    return pendingMessages.length;
  } catch (e: unknown) {
    console.error('[离线同步] 失败:', errorMessage(e));
    return 0;
  }
}

module.exports = { syncOfflineMessages };
