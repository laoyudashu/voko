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

interface DecodedOfflinePayload {
  content?: string;
  type?: number;
  _voko?: InboundMessage['_voko'];
}

function decodeOfflinePayload(payload?: string): DecodedOfflinePayload {
  if (!payload) return {};
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString()) as DecodedOfflinePayload;
    const metadata = decoded?._voko;
    let content=typeof decoded?.content === 'string' ? decoded.content : undefined;
    if(!content&&decoded?.type===13&&(decoded as any)?.version==='voko.e2ee/2'){
      const {type: _type,_voko: _metadata,...envelope}=decoded as any;
      content=JSON.stringify(envelope);
    }
    return {
      content,
      type: typeof decoded?.type === 'number' ? decoded.type : undefined,
      _voko: metadata?.protocolVersion === 1
        ? {
            protocolVersion: 1,
            ...(typeof metadata.routeId === 'string' ? { routeId: metadata.routeId } : {}),
            ...(typeof metadata.replyToRouteId === 'string' ? { replyToRouteId: metadata.replyToRouteId } : {}),
            ...(typeof metadata.conversationKey === 'string' ? { conversationKey: metadata.conversationKey } : {}),
            ...(metadata.conversationStart === true ? { conversationStart: true } : {}),
            ...(['created', 'reused'].includes(String(metadata.conversationDisposition))
              ? { conversationDisposition: metadata.conversationDisposition as 'created' | 'reused' } : {}),
            ...(typeof metadata.canonicalConversationKey === 'string'
              ? { canonicalConversationKey: metadata.canonicalConversationKey } : {}),
          }
        : null,
    };
  } catch (_) {
    return {};
  }
}

interface MessageHandlerLike {
  handleAgentMessage(agentId: string, data: InboundMessage, skipForward: boolean): ForwardPayload | undefined;
  handleEncryptedMessage?(agentId: string, data: InboundMessage): Promise<{ handled: boolean; accepted: boolean; code?: string }>;
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

const PERMANENT_E2EE_REJECTIONS = new Set([
  'E2EE_V2_ENVELOPE_INVALID',
  'E2EE_V2_ROUTE_MISMATCH',
  'E2EE_V2_SENDER_KEY_MISMATCH',
  'E2EE_V2_MESSAGE_ID_CONFLICT',
]);

function isPermanentE2eeRejection(code: unknown): boolean {
  return PERMANENT_E2EE_REJECTIONS.has(String(code || ''));
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
    console.debug('[离线同步] 跳过：messageHandler 未初始化（Lite 独立模式下无需同步）');
    return 0;
  }
  try {
    // 离线同步必须绑定当前登录用户。没有当前用户时，不能按 agents 表的
    // “最近 owner”或全表回退，否则会把其他用户/其他电脑的 Agent 消息拉到本机。
    const currentOwnerEmail = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
    if (!currentOwnerEmail) return 0;
    // A single sync run must keep the owner identity it started with. Account
    // switching updates the active token before shutdown completes; re-reading
    // it inside the loop would send the new owner's token for old-owner Agents.
    const ownerAccessToken = getUserAccessToken(db, currentOwnerEmail);
    const ownerStillActive = () => String(getCurrentUserEmail(db) || '').trim().toLowerCase() === currentOwnerEmail;
    const agents = db.prepare(`
      SELECT agent_id, imUid, imToken, im_server_url, owner_email
      FROM agents
      WHERE publish_status = 'published' AND LOWER(TRIM(owner_email)) = ?
    `).all<AgentRow>(currentOwnerEmail);
    const cursorMap = loadCursorMap(db);
    const pendingMessages: Array<{ agentId: string; data?: InboundMessage; cursorKey: string;
      messageSeq?: number; agentAuthored?: boolean }> = [];

    for (const agent of agents) {
      if (!ownerStillActive()) {
        console.log('[离线同步] 主人已切换，停止旧主人同步');
        return 0;
      }
      if (agentIdFilter && agent.agent_id !== agentIdFilter) {
        continue;
      }
      const httpBase = String(ENDPOINTS.im.apiBaseUrl || '').replace(/\/$/, '');
      const convs = db.prepare(`SELECT DISTINCT channel_id FROM conversations WHERE agent_id = ?`).all<ConversationRow>(agent.agent_id);

      for (const conv of convs) {
        if (!ownerStillActive()) {
          console.log('[离线同步] 主人已切换，停止旧主人同步');
          return 0;
        }
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
              ...(ownerAccessToken ? {
                Authorization: `Bearer ${ownerAccessToken}`,
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
          if (!ownerStillActive()) {
            console.log('[离线同步] 主人已切换，停止旧主人同步');
            return 0;
          }
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
            const decoded = decodeOfflinePayload(msg.payload);
            if (!content) content = decoded.content || '';
            if (!msg.content_type && decoded.type) contentType = decoded.type;
            const toUid = msg.from_uid === agent.imUid ? conv.channel_id : agent.imUid;
            pendingMessages.push({
              agentId: agent.agent_id,
              cursorKey: key,
              messageSeq,
              agentAuthored: msg.from_uid === agent.imUid,
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
                syncOnce: msg.header?.sync_once ? 1 : 0,
                _voko: decoded._voko,
              }
            });
          }
        } catch (e: unknown) {
          console.error(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} 请求失败:`, errorMessage(e));
        }
      }
    }

    if (!ownerStillActive()) {
      console.log('[离线同步] 主人已切换，停止旧主人同步');
      return 0;
    }
    console.debug(`[离线同步] 共收集 ${pendingMessages.length} 条离线消息${pendingMessages.length ? '，开始处理...' : ''}`);

    // E2EE messages are claimed before the ordinary persistence/forwarding
    // path. A disabled or rejected Canary is still handled fail-closed and is
    // never reinterpreted as visitor plaintext.
    const blockedE2eeAt = new Map<string, number>();
    for (const pending of pendingMessages) {
      if (Number(pending.data?.contentType) !== 13) continue;
      // The channel history also contains the Agent's encrypted replies. They
      // have already advanced the local sender ratchet and must never be fed
      // back into the inbound E2EE runtime.
      if (pending.agentAuthored) {
        pending.data = undefined;
        continue;
      }
      if (typeof messageHandler.handleEncryptedMessage === 'function') {
        const result = await messageHandler.handleEncryptedMessage(pending.agentId,pending.data!);
        if (!result?.accepted) {
          const code = String(result?.code || 'E2EE_REJECTED');
          if (isPermanentE2eeRejection(code)) {
            console.warn(`[离线同步][E2EE] agent=${pending.agentId} 永久拒绝，隔离密文并推进游标 code=${code}`);
          } else {
            const sequence = pending.messageSeq || 0;
            const previous = blockedE2eeAt.get(pending.cursorKey);
            blockedE2eeAt.set(pending.cursorKey, previous === undefined ? sequence : Math.min(previous,sequence));
            console.warn(`[离线同步][E2EE] agent=${pending.agentId} 暂未接受，保留当前密文等待重试 code=${code}`);
          }
        }
      } else {
        const sequence = pending.messageSeq || 0;
        const previous = blockedE2eeAt.get(pending.cursorKey);
        blockedE2eeAt.set(pending.cursorKey, previous === undefined ? sequence : Math.min(previous,sequence));
        console.warn(`[离线同步][E2EE] agent=${pending.agentId} 处理器不可用，保留游标等待重试`);
      }
      pending.data = undefined;
    }

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
            const blockedAt = blockedE2eeAt.get(p.cursorKey);
            if (p.messageSeq !== undefined && (blockedAt === undefined || (blockedAt > 0 && p.messageSeq < blockedAt))) {
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
        last.channelType, last.contentType, last.messageId, last.timestamp, last.mention || null, last._voko);
      forwarded++;
    }

    console.log(`[离线同步] 完成：收集 ${pendingMessages.length} 条，入库通过 ${collected.length} 条，合并转发 ${forwarded} 次`);
    return pendingMessages.length;
  } catch (e: unknown) {
    console.error('[离线同步] 失败:', errorMessage(e));
    return 0;
  }
}

interface CoordinatorOptions {
  /** coalesce 窗口（ms），默认 500 */
  windowMs?: number;
  /** 兜底定时器（ms），默认 30000 */
  fallbackMs?: number;
  /** 注入的同步函数，默认 syncOfflineMessages */
  syncFn?: (db: any, handler: any, agentIdFilter?: string) => Promise<number>;
  /** 注入 setTimeout（测试用），默认全局 setTimeout */
  setTimeout?: (fn: () => void, ms: number) => any;
  /** 注入 clearTimeout（测试用），默认全局 clearTimeout */
  clearTimeout?: (id: any) => void;
}

interface Coordinator {
  onAgentConnected(agentId: string): void;
  onAllReady(): void;
  start(): void;
  stop(): void;
}

/**
 * 创建离线同步协调器：把突发的 per-agent 同步触发合并为一次全量同步。
 *
 * 行为：
 * - onAgentConnected：把 agentId 加入待同步集合，启动 windowMs 合并窗口；
 *   窗口内多个 connected 事件合并，到期执行一次全量同步。
 * - onAllReady：首次全部就绪时触发一次全量同步（有守卫，只触发一次）。
 * - start：注册 fallbackMs 兜底定时器（到期再试一次全量）。
 * - stop：清理所有定时器。
 *
 * 幂等：syncFn 内部按 agentIdFilter + checkpoint(MAX) + UNIQUE 去重，
 *       全量调用不会重复处理已拉过的消息。
 */
function createOfflineSyncCoordinator(db: any, messageHandler: any, options: CoordinatorOptions = {}): Coordinator {
  const windowMs = Math.max(0, options.windowMs ?? 500);
  const fallbackMs = Math.max(0, options.fallbackMs ?? 30000);
  const syncFn = options.syncFn || ((d: any, h: any, f?: string) => syncOfflineMessages(d, h, f));
  const _setTimeout = options.setTimeout || setTimeout;
  const _clearTimeout = options.clearTimeout || clearTimeout;

  let _firstFullSyncDone = false;
  const _pendingAgents = new Set<string>();
  let _coalesceTimer: any = null;
  let _fallbackTimer: any = null;

  const _runFullSync = (tag: string) => {
    syncFn(db, messageHandler).catch((e: unknown) => console.error(`[离线同步] ${tag} 失败:`, errorMessage(e)));
  };
  const _flush = () => {
    _coalesceTimer = null;
    if (_pendingAgents.size === 0) return;
    _pendingAgents.clear();
    _runFullSync('合并');
  };

  return {
    onAgentConnected(agentId: string) {
      if (!agentId || !messageHandler) return;
      _pendingAgents.add(agentId);
      if (_coalesceTimer) return;
      _coalesceTimer = _setTimeout(_flush, windowMs);
      // unref 仅在 Node 原生 setTimeout 上存在
      if (typeof (_coalesceTimer as any)?.unref === 'function') (_coalesceTimer as any).unref();
    },
    onAllReady() {
      if (_firstFullSyncDone) return;
      _firstFullSyncDone = true;
      console.log('[Lite] 开始离线同步');
      _runFullSync('首次');
    },
    start() {
      if (_fallbackTimer) return;
      _fallbackTimer = _setTimeout(() => { this.onAllReady(); }, fallbackMs);
      if (typeof (_fallbackTimer as any)?.unref === 'function') (_fallbackTimer as any).unref();
    },
    stop() {
      if (_coalesceTimer) { _clearTimeout(_coalesceTimer); _coalesceTimer = null; }
      if (_fallbackTimer) { _clearTimeout(_fallbackTimer); _fallbackTimer = null; }
    },
  };
}

module.exports = { syncOfflineMessages, createOfflineSyncCoordinator, decodeOfflinePayload, isPermanentE2eeRejection };
