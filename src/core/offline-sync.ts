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
} = require('./database');
const { advanceCheckpoint, getCheckpoint, setCheckpoint } = require('./checkpoint-store');
const ENDPOINTS = require('../endpoints.json');
import type { DatabaseLike } from '../types/database';
import type { ForwardPayload, InboundMessage } from './messenger-types';
import { normalizeTurnReceipt } from './outbound-message-result-store';

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
        ? (() => {
          const turnReceipt = normalizeTurnReceipt(metadata.turnReceipt);
          return {
            protocolVersion: 1,
            ...(typeof metadata.routeId === 'string' ? { routeId: metadata.routeId } : {}),
            ...(typeof metadata.replyToRouteId === 'string' ? { replyToRouteId: metadata.replyToRouteId } : {}),
            ...(typeof metadata.conversationKey === 'string' ? { conversationKey: metadata.conversationKey } : {}),
            ...(metadata.conversationStart === true ? { conversationStart: true } : {}),
            ...(['created', 'reused'].includes(String(metadata.conversationDisposition))
              ? { conversationDisposition: metadata.conversationDisposition as 'created' | 'reused' } : {}),
            ...(typeof metadata.canonicalConversationKey === 'string'
              ? { canonicalConversationKey: metadata.canonicalConversationKey } : {}),
            ...(['new_topic', 'automatic_reply', 'explicit_reply'].includes(String(metadata.a2aDisposition))
              ? { a2aDisposition: metadata.a2aDisposition as 'new_topic' | 'automatic_reply' | 'explicit_reply' } : {}),
            ...(metadata.turnReceiptRequest?.version === 1 ? { turnReceiptRequest: { version: 1 as const } } : {}),
            ...(turnReceipt ? { turnReceipt } : {}),
          };
        })()
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

interface OfflineSyncOptions {
  /** A bounded page budget per channel; the coordinator reschedules the rest. */
  maxPagesPerChannel?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  requestContinuation?: (agentId: string, ownerEmail: string) => void;
}

/**
 * 拉取离线消息并转发
 *
 * @param {object} db - better-sqlite3 实例
 * @param {object} messageHandler - MessageHandler 实例（需有 handleAgentMessage / forwardToAgent）
 * @param {string} [agentIdFilter] - 可选，仅同步指定 agent
 * @returns {Promise<number>} 同步的消息总数
 */
async function syncOfflineMessages(db: DatabaseLike, messageHandler?: MessageHandlerLike, agentIdFilter?: string, options: OfflineSyncOptions = {}): Promise<number> {
  if (!messageHandler) {
    console.debug('[离线同步] 跳过：messageHandler 未初始化（Lite 独立模式下无需同步）');
    return 0;
  }
  try {
    const currentOwnerEmail = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
    if (!currentOwnerEmail) return 0;
    // Capture the credential with the owner; never send a new owner's token
    // for Agents selected by an earlier run.
    const ownerAccessToken = getUserAccessToken(db, currentOwnerEmail);
    const ownerStillActive = () => !options.signal?.aborted
      && String(getCurrentUserEmail(db) || '').trim().toLowerCase() === currentOwnerEmail;
    const maxPages = Math.max(1, Math.min(100, Math.floor(options.maxPagesPerChannel || 5)));
    const requestTimeoutMs = Math.max(1, Math.min(60000, Math.floor(options.requestTimeoutMs || 10000)));
    const agents = db.prepare(`
      SELECT agent_id, imUid, imToken, im_server_url, owner_email
      FROM agents
      WHERE publish_status = 'published' AND LOWER(TRIM(owner_email)) = ?
    `).all<AgentRow>(currentOwnerEmail);
    const cursorMap = loadCursorMap(db);
    let processed = 0;
    let forwarded = 0;

    for (const agent of agents) {
      if (!ownerStillActive()) return 0;
      if (agentIdFilter && agent.agent_id !== agentIdFilter) continue;
      const httpBase = String(ENDPOINTS.im.apiBaseUrl || '').replace(/\/$/, '');
      const convs = db.prepare(`SELECT DISTINCT channel_id FROM conversations WHERE agent_id = ?`).all<ConversationRow>(agent.agent_id);
      for (const conv of convs) {
        if (!ownerStillActive()) return 0;
        const key = cursorKey(agent.agent_id, conv.channel_id);
        let checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, key);
        if (!checkpoint) {
          // Legacy/bootstrap only: avoid replaying historical tasks. Once a
          // checkpoint exists it is the scan boundary, even if live messages
          // have already raised MAX beyond a temporarily rejected ciphertext.
          const maxRow = db.prepare(`SELECT MAX(message_seq) as m FROM messages WHERE channel_id = ? AND agent_id = ?`)
            .get<MaxSeqRow>(conv.channel_id, agent.agent_id);
          const initial = cursorMap[key] !== undefined ? Number(cursorMap[key]) || 0 : maxRow?.m || 0;
          setCheckpoint(db, CHECKPOINT_NAMESPACE, key, 'sequence', initial);
          checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, key);
        }
        let scanned = Number(checkpoint?.committedValue) || 0;
        for (let page = 0; page < maxPages; page++) {
          if (!ownerStillActive()) return 0;
          const pageStart = scanned;
          let msgs: SyncMessage[];
          try {
            const resp = await fetch(`${httpBase}/channel/messagesync`, {
              method: 'POST',
              signal: AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(options.signal ? [options.signal] : [])]),
              headers: {
                'Content-Type': 'application/json',
                ...(ownerAccessToken ? {
                  Authorization: `Bearer ${ownerAccessToken}`,
                  'X-Voko-Agent-Uid': agent.imUid,
                } : {}),
              },
              body: JSON.stringify({
                login_uid: agent.imUid, channel_id: conv.channel_id, channel_type: 1,
                start_message_seq: scanned + 1, end_message_seq: 0, limit: 100, pull_mode: 1,
              }),
            });
            if (!ownerStillActive()) return 0;
            if (!resp.ok) {
              console.warn(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} HTTP ${resp.status}`);
              break;
            }
            const data = await resp.json() as { messages?: SyncMessage[] };
            if (!ownerStillActive()) return 0;
            msgs = data.messages || [];
          } catch (error) {
            console.error(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} 请求失败:`, errorMessage(error));
            break;
          }
          // A sequence is an opaque increasing scan position, not a demand that
          // every integer exists. Without valid positions this page cannot be
          // ordered or checkpointed safely.
          if (!Array.isArray(msgs) || msgs.some(msg => !Number.isSafeInteger(Number(msg.message_seq)) || Number(msg.message_seq) <= 0)) {
            console.warn(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} 无效消息序号，停止该频道`);
            break;
          }
          msgs.sort((left, right) => Number(left.message_seq) - Number(right.message_seq));
          const ordinary: Array<{ sequence: number; data?: InboundMessage }> = [];
          const flushOrdinary = async (): Promise<void> => {
            if (!ordinary.length || !ownerStillActive()) return;
            const collected: ForwardPayload[] = [];
            const lastSequence = ordinary[ordinary.length - 1].sequence;
            let committed = false;
            await enqueueDbWrite(() => {
              if (!ownerStillActive()) return;
              const supportsTransactions = typeof (db as any).exec === 'function';
              if (supportsTransactions) (db as any).exec('BEGIN IMMEDIATE');
              try {
                for (const pending of ordinary) {
                  if (!pending.data) continue;
                  const payload = messageHandler.handleAgentMessage(agent.agent_id, pending.data, true);
                  if (payload) collected.push(payload);
                }
                saveCursorMap(db, new Map([[key, lastSequence]]));
                if (supportsTransactions) (db as any).exec('COMMIT');
                committed = true;
              } catch (error) {
                if (supportsTransactions) {
                  try { (db as any).exec('ROLLBACK'); } catch (_) {}
                }
                throw error;
              }
            });
            if (!committed) return;
            scanned = lastSequence;
            processed += ordinary.length;
            ordinary.length = 0;
            // skipForward only defers Provider forwarding. UI/system/E2EE
            // effects in the handler are not made transactional by this queue.
            for (const message of collected) {
              if (!ownerStillActive()) return;
              messageHandler.forwardToAgent(message.agentId, message.fromUid, message.content, message.channelId,
                message.channelType, message.contentType, message.messageId, message.timestamp,
                message.mention || null, message._voko);
              forwarded++;
            }
          };
          let blocked = false;
          let seenSequence = scanned;
          for (const msg of msgs) {
            if (!ownerStillActive()) return 0;
            const sequence = Number(msg.message_seq);
            if (sequence <= seenSequence) continue;
            seenSequence = sequence;
            const msgId = msg.message_id || msg.messageID;
            if (!msgId) { ordinary.push({ sequence }); continue; }
            const decoded = decodeOfflinePayload(msg.payload);
            const contentType = msg.content_type || decoded.type || 1;
            const data: InboundMessage = {
              fromUid: msg.from_uid || '',
              toUid: msg.from_uid === agent.imUid ? conv.channel_id : agent.imUid,
              channelId: conv.channel_id, channelType: 1,
              content: msg.content || decoded.content || '', contentType,
              messageId: msgId, timestamp: msg.timestamp || 0, messageSeq: sequence,
              clientMsgNo: msg.client_msg_no, noPersist: msg.header?.no_persist ? 1 : 0,
              redDot: msg.header?.red_dot ? 1 : 0, syncOnce: msg.header?.sync_once ? 1 : 0,
              _voko: decoded._voko,
            };
            if (contentType !== 13) { ordinary.push({ sequence, data }); continue; }
            // Agent-authored ciphertext is a sender echo, never inbound ratchet
            // input. Other ciphertext must be processed in sequence, not in a
            // separate whole-page pass ahead of ordinary messages.
            if (msg.from_uid === agent.imUid) { ordinary.push({ sequence }); continue; }
            await flushOrdinary();
            if (!ownerStillActive()) return 0;
            let result;
            try {
              result = await messageHandler.handleEncryptedMessage?.(agent.agent_id, data);
            } catch (_) {
              result = { accepted: false, code: 'E2EE_HANDLER_FAILED' };
            }
            if (!ownerStillActive()) return 0;
            if (!result?.accepted) {
              const code = String(result?.code || 'E2EE_HANDLER_UNAVAILABLE');
              if (!isPermanentE2eeRejection(code)) {
                console.warn(`[离线同步][E2EE] agent=${agent.agent_id} 暂未接受，停止该频道等待重试 code=${code}`);
                blocked = true;
                break;
              }
              console.warn(`[离线同步][E2EE] agent=${agent.agent_id} 永久拒绝，隔离密文并推进游标 code=${code}`);
            }
            ordinary.push({ sequence });
            await flushOrdinary();
          }
          await flushOrdinary();
          if (!ownerStillActive()) return 0;
          if (blocked || !msgs.length) break;
          if (scanned <= pageStart) {
            console.warn(`[离线同步] agent=${agent.agent_id} channel=${conv.channel_id} 游标未前进，停止该频道`);
            break;
          }
          if (msgs.length < 100) break;
          if (page + 1 === maxPages) options.requestContinuation?.(agent.agent_id, currentOwnerEmail);
        }
      }
    }
    if (processed) console.log(`[离线同步] 完成：扫描 ${processed} 条，加入 Turn 合并器 ${forwarded} 条`);
    return processed;
  } catch (error) {
    console.error('[离线同步] 失败:', errorMessage(error));
    return 0;
  }
}

interface CoordinatorOptions {
  /** 重连尾部防抖窗口（ms），默认 2000 */
  windowMs?: number;
  /** 一轮同步完成后的最短冷却时间（ms），默认 30000 */
  cooldownMs?: number;
  /** 兜底定时器（ms），默认 30000 */
  fallbackMs?: number;
  /** 注入的同步函数，默认 syncOfflineMessages */
  syncFn?: (db: any, handler: any, agentIdFilter?: string, options?: OfflineSyncOptions) => Promise<number>;
  syncOptions?: Pick<OfflineSyncOptions, 'maxPagesPerChannel' | 'requestTimeoutMs'>;
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
 * - 首次就绪前只收集 connected 事件，由 onAllReady/fallback 执行一次全量同步；
 * - 首次同步后，重连事件使用尾部防抖，并只同步发生重连的 Agent；
 * - 同步全局单飞，完成后进入冷却期，冷却期间的新事件留到下一批。
 * - onAllReady：首次全部就绪时触发一次全量同步（有守卫，只触发一次）。
 * - start：注册 fallbackMs 兜底定时器（到期再试一次全量）。
 * - stop：清理所有定时器。
 *
 * 幂等：syncFn 内部按 agentIdFilter + committed checkpoint + UNIQUE 去重，
 *       全量调用不会重复处理已拉过的消息。
 */
function createOfflineSyncCoordinator(db: any, messageHandler: any, options: CoordinatorOptions = {}): Coordinator {
  const windowMs = Math.max(0, options.windowMs ?? 2000);
  const cooldownMs = Math.max(0, options.cooldownMs ?? 30000);
  const fallbackMs = Math.max(0, options.fallbackMs ?? 30000);
  const syncFn = options.syncFn || syncOfflineMessages;
  const _setTimeout = options.setTimeout || setTimeout;
  const _clearTimeout = options.clearTimeout || clearTimeout;

  let _firstFullSyncDone = false;
  // undefined denotes a fresh connection event; continuation entries retain
  // the owner which requested them so a later account cannot inherit a batch.
  const _pendingAgents = new Map<string, string | undefined>();
  const _stopController = new AbortController();
  const _syncOptions: OfflineSyncOptions = {
    ...options.syncOptions,
    signal: _stopController.signal,
    requestContinuation(agentId, ownerEmail) {
      if (_stopped || String(getCurrentUserEmail(db) || '').trim().toLowerCase() !== ownerEmail) return;
      if (!_pendingAgents.has(agentId)) _pendingAgents.set(agentId, ownerEmail);
    },
  };
  let _coalesceTimer: any = null;
  let _cooldownTimer: any = null;
  let _fallbackTimer: any = null;
  let _running = false;
  let _stopped = false;

  const _schedulePending = () => {
    if (_stopped || !_firstFullSyncDone || _running || _cooldownTimer || _pendingAgents.size === 0) return;
    if (_coalesceTimer) _clearTimeout(_coalesceTimer);
    _coalesceTimer = _setTimeout(_flush, windowMs);
    if (typeof (_coalesceTimer as any)?.unref === 'function') (_coalesceTimer as any).unref();
  };
  const _enterCooldown = () => {
    if (_stopped) return;
    if (!cooldownMs) { _schedulePending(); return; }
    _cooldownTimer = _setTimeout(() => {
      _cooldownTimer = null;
      _schedulePending();
    }, cooldownMs);
    if (typeof (_cooldownTimer as any)?.unref === 'function') (_cooldownTimer as any).unref();
  };
  const _run = (tag: string, task: () => Promise<unknown>) => {
    if (_stopped || _running) return;
    _running = true;
    let result: Promise<unknown>;
    try { result = Promise.resolve(task()); }
    catch (error) { result = Promise.reject(error); }
    result
      .catch((e: unknown) => console.error(`[离线同步] ${tag} 失败:`, errorMessage(e)))
      .finally(() => { _running = false; _enterCooldown(); });
  };
  const _flush = () => {
    _coalesceTimer = null;
    if (_running || _cooldownTimer || _pendingAgents.size === 0) return;
    const agents = [..._pendingAgents];
    _pendingAgents.clear();
    _run('重连', async () => {
      for (const [agentId, continuationOwner] of agents) {
        if (_stopped) break;
        if (continuationOwner && String(getCurrentUserEmail(db) || '').trim().toLowerCase() !== continuationOwner) continue;
        await syncFn(db, messageHandler, agentId, _syncOptions);
      }
    });
  };

  return {
    onAgentConnected(agentId: string) {
      if (!agentId || !messageHandler) return;
      if (_stopped) return;
      _pendingAgents.set(agentId, undefined);
      _schedulePending();
    },
    onAllReady() {
      if (_firstFullSyncDone) return;
      _firstFullSyncDone = true;
      _pendingAgents.clear();
      if (_coalesceTimer) { _clearTimeout(_coalesceTimer); _coalesceTimer = null; }
      console.log('[Lite] 开始离线同步');
      _run('首次', () => syncFn(db, messageHandler, undefined, _syncOptions));
    },
    start() {
      if (_fallbackTimer) return;
      _fallbackTimer = _setTimeout(() => { this.onAllReady(); }, fallbackMs);
      if (typeof (_fallbackTimer as any)?.unref === 'function') (_fallbackTimer as any).unref();
    },
    stop() {
      _stopped = true;
      _stopController.abort();
      if (_coalesceTimer) { _clearTimeout(_coalesceTimer); _coalesceTimer = null; }
      if (_cooldownTimer) { _clearTimeout(_cooldownTimer); _cooldownTimer = null; }
      if (_fallbackTimer) { _clearTimeout(_fallbackTimer); _fallbackTimer = null; }
      _pendingAgents.clear();
    },
  };
}

module.exports = { syncOfflineMessages, createOfflineSyncCoordinator, decodeOfflinePayload, isPermanentE2eeRejection };
