/**
 * messenger.js — 消息处理核心
 *
 * 消息处理中枢：handleAgentMessage / handleAgentReply / forwardToAgent。
 * 纯 Node.js，无 Electron 依赖。通过 options 注入外部依赖。
 */

const EventEmitter = require('events');
const { notifyNewMessage } = require('./notifier');
const { persistAgentMessage } = require('./send-message');
const { logEvent } = require('./event-log');
const { isSystemMessageContent } = require('./i18n');
const { parseA2AState, stripStateBlock, extractA2AVisibleReply } = require('./dispatcher/parse-state');
const { MessageRouteStore, RoutingConversationStore, isRoutingFeatureEnabled, normalizeProviderFamily } = require('./provider-routing');
import type { DatabaseLike } from '../types/database';
import type {
  AgentReplyMessage,
  AuditAction,
  AuditDirection,
  AuditResult,
  BackendHandlerLike,
  ForwardPayload,
  InboundMessage,
  MessageHandlerOptions,
  MessageContext,
  Mention,
} from './messenger-types';

// messages.content_type 取值约定：1=text, 10=owner 干预, 11=隐藏系统 JSON（被 !=11 排除出历史）, 12=群系统消息 tip（可见，居中渲染）
const CONTENT_TYPE_GROUP_TIP = 12;

function sanitizeOwnerInterventionReply(content: string): string {
  const paragraphs = String(content || '').trim().split(/\r?\n\s*\r?\n/);
  const processNarration = /(?:主人(?:已经|已)?(?:回复|答复)|关闭(?:本次)?介入|介入(?:请求|流程)|回复(?:原)?群(?:聊)?|owner(?:'s)? (?:reply|response)|clos(?:e|ing).*intervention|reply(?:ing)? (?:to )?(?:the )?group)/i;
  while (paragraphs.length > 1 && processNarration.test(paragraphs[0])) paragraphs.shift();
  return paragraphs.join('\n\n')
    .replace(/^(?:@[^\s，,：:]+(?:[\s，,：:]+|$))+/u, '')
    .trim();
}
const GROUP_CONTEXT_LIMIT = 10;
const CAPABILITY_REQUEST_TYPE = 'voko.capability.request';
const CAPABILITY_RESPONSE_TYPE = 'voko.capability.response';

interface AgentImUidRow { imUid: string }
interface AgentStatusRow {
  publish_status: string | null;
  owner_email: string | null;
  access_mode: string | null;
}
interface AgentTrustRow {
  agent_id: string;
  imUid: string | null;
  owner_email: string | null;
}
interface BackendRow { backend_type: string | null; backend_instance_id?: string | null }
interface ConversationUserRow { user_uid: string }
interface ConversationSessionRow {
  session_status: string | null;
  session_expire_at: number | null;
}
interface ConversationModeRow { mode: string | null }
interface PricingRow {
  pricing_model: string;
  trial_minutes: number;
  price: number;
  duration_minutes: number;
  [key: string]: unknown;
}
interface CountRow { c: number }
interface StoredMessageAgentRow { agent_id: string }
interface GroupNameRow { name: string | null }
interface GroupContextRow {
  id: string;
  from_uid: string;
  content: string;
  timestamp: number;
  content_type: number;
  message_seq: number | null;
  client_msg_no: string | null;
}
interface UserNameRow { nickname: string | null }
interface AgentNameRow { agent_name: string | null }
interface CapabilityInboundRow {
  message_rowid: number;
  content: string;
}
interface MessageContentRow { content: string }
interface AgentReplyRow {
  agent_id: string;
  imUid: string;
}
interface CapabilityRequest extends Record<string, unknown> {
  type: typeof CAPABILITY_REQUEST_TYPE;
  requestId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function serializeCapabilityResponse(content: unknown, requestId: string): string {
  const parsed = parseJsonObject(content);
  if (parsed?.type === CAPABILITY_RESPONSE_TYPE) {
    return JSON.stringify({ ...parsed, type: CAPABILITY_RESPONSE_TYPE, requestId });
  }

  let responseContent = String(content ?? '');
  if (/^\s*\{\s*"type"\s*:\s*"voko\.capability\.response"/i.test(responseContent)) {
    const contentKey = responseContent.match(/"content"\s*:\s*"/i);
    if (contentKey?.index != null) {
      responseContent = responseContent
        .slice(contentKey.index + contentKey[0].length)
        .replace(/"\s*}\s*$/, '');
    }
  }

  return JSON.stringify({
    type: CAPABILITY_RESPONSE_TYPE,
    requestId,
    content: responseContent
  });
}

class MessageHandler extends EventEmitter {
  private readonly db: DatabaseLike;

  /**
   * @param {object} db - better-sqlite3 实例
   * @param {object} options
   * @param {object}   options.databaseAPI - DB 查询封装
   * @param {object}   options.agentWorkers - AgentWorkerManager.workers Map
   * @param {object}   [options.hermesHandler] - Hermes 处理器（可选，Lite 不传）
   * @param {object}   [options.openclawHandler] - OpenClaw 处理器（可选，Lite 不传）
   * @param {object}   [options.ac] - access-control 模块（可选）
   * @param {Function} [options.sendSystemMessage] - 发送系统消息函数
   * @param {Function} [options.checkAuditRules] - 审核规则检查函数
   * @param {Function} [options.substitutePromptVariables] - 提示词变量替换函数
   * @param {Function} [options.notifyUI] - UI 通知回调 (eventName, data)
   * @param {Function} [options.notifyTray] - 托盘通知回调
   * @param {Function} [options.enqueueIntervention] - 主人介入入队回调
   * @param {Function} [options.createPendingPayment] - 创建支付订单回调
   * @param {Function} [options.onOwnerInterventionNew] - 有新介入时回调
   */
  constructor(db: DatabaseLike, options: MessageHandlerOptions = {}) {
    super();
    this.db = db;
    this.databaseAPI = options.databaseAPI;
    this.agentWorkers = options.agentWorkers;
    this.hermesHandler = options.hermesHandler || null;
    this.openclawHandler = options.openclawHandler || null;
    this.dispatcher = options.dispatcher || null;
    this.ac = options.ac || null;
    this._sendSystemMessage = options.sendSystemMessage || (() => {});
    this._deliver = options.deliver || null;  // 统一 VokoIMSDK Hub 投递器
    this._checkAuditRules = options.checkAuditRules || (() => ({ action: 'allow' }));
    this._substitutePromptVariables = options.substitutePromptVariables || ((prompt: string) => prompt);
    this._notifyUI = options.notifyUI || (() => {});
    this._enqueueIntervention = options.enqueueIntervention || (() => {});
    this._createPendingPayment = options.createPendingPayment || (() => {});
    this._onOwnerInterventionNew = options.onOwnerInterventionNew || (() => {});
    this._messageRoutes = new MessageRouteStore(db);
    this._routingConversations = new RoutingConversationStore(db);

    // 预填充大小写映射（OpenClaw WS）
    this._caseMap = new Map<string, string>();
  }

  /** 设置 Hermes 处理器（延迟初始化） */
  setHermesHandler(handler: BackendHandlerLike) { this.hermesHandler = handler; }
  /** 设置 OpenClaw 处理器（延迟初始化） */
  setOpenclawHandler(handler: BackendHandlerLike) { this.openclawHandler = handler; }
  /** 设置消息分发决策层（push/pull） */
  setDispatcher(dispatcher: NonNullable<MessageHandlerOptions['dispatcher']>) { this.dispatcher = dispatcher; }

  /** 同一主人名下的本地 Agent 首次单聊时，互相设为可信联系人。 */
  private _autoTrustSameOwnerAgent(agentId: string, fromUid: string): void {
    if (!this.ac || !agentId || !fromUid) return;
    try {
      const receiver = this.db.prepare(
        'SELECT agent_id, imUid, owner_email FROM agents WHERE agent_id=? LIMIT 1',
      ).get<AgentTrustRow>(agentId);
      const sender = this.db.prepare(
        'SELECT agent_id, imUid, owner_email FROM agents WHERE imUid=? LIMIT 1',
      ).get<AgentTrustRow>(fromUid);
      const receiverOwner = String(receiver?.owner_email || '').trim().toLowerCase();
      const senderOwner = String(sender?.owner_email || '').trim().toLowerCase();
      if (!receiver || !sender || sender.agent_id === receiver.agent_id || !receiverOwner || receiverOwner !== senderOwner || !receiver.imUid) return;
      if (this.ac.isBlacklisted(this.db, receiver.agent_id, fromUid)
        || this.ac.isBlacklisted(this.db, sender.agent_id, receiver.imUid)) return;
      if (this.ac.isAutoTrustDisabled?.(this.db, receiver.agent_id, fromUid)
        || this.ac.isAutoTrustDisabled?.(this.db, sender.agent_id, receiver.imUid)) return;
      if (!this.ac.isWhitelisted(this.db, receiver.agent_id, fromUid)) {
        this.ac.addEntry(this.db, { agentId: receiver.agent_id, listType: 'whitelist', visitorId: fromUid, reason: '同主人 Agent 默认信任', source: 'same_owner_default' });
      }
      if (!this.ac.isWhitelisted(this.db, sender.agent_id, receiver.imUid)) {
        this.ac.addEntry(this.db, { agentId: sender.agent_id, listType: 'whitelist', visitorId: receiver.imUid, reason: '同主人 Agent 默认信任', source: 'same_owner_default' });
      }
    } catch (_) {}
  }

  // ==========================================
  // 审计：插入被拦截消息
  // ==========================================
  insertBlockedMessage(
    agentId: string,
    visitorId: string,
    content: string,
    keyword: string | null | undefined,
    action: AuditAction,
    direction: AuditDirection,
    fromUid: string,
    ts: number,
    originalMsgId?: string | null,
    context: MessageContext = {},
  ): void {
    if (!ts) ts = Math.floor(Date.now() / 1000);
    const msgId = originalMsgId || ('blk-' + agentId + '-' + visitorId + '-' + ts + '-' + Math.random().toString(36).substr(2, 4));
    const targetChannelType = Number(context.channelType) === 2 ? 2 : 1;
    const targetChannelId = context.channelId || visitorId;
    const title = direction === 'inbound' ? '触发入站消息审核' : '触发出站消息审核';
    const isMe = direction === 'inbound' ? 0 : 1;
    const actionLabel = direction === 'inbound'
      ? (action === 'hard_deny' ? '已拒绝，已回复提示语给访客' : '已放行，已转发给 Agent')
      : (action === 'hard_deny' ? '已拒绝，未发送给访客' : '已放行，已发送给访客');
    const jsonContent = JSON.stringify({
      text: content,
      audit: '⚠️ ' + title + '\n命中敏感词: ' + keyword + '\n' + actionLabel,
      direction,
      keyword: keyword,
      action: action
    });

    try {
      if (originalMsgId) {
        this.db.prepare('UPDATE messages SET content_type=11, content=? WHERE id=?').run(jsonContent, originalMsgId);
      } else {
        this.db.prepare('INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(msgId, fromUid, targetChannelId, jsonContent, targetChannelId, targetChannelType, agentId, ts, isMe, 'sent', 11);
      }
    } catch (error: unknown) {
      console.error('[Audit] 写入拦截消息失败:', errorMessage(error));
    }

    try {
      const displayText = '⛔ 消息被拦截';
      const existConv = this.db.prepare('SELECT user_uid FROM conversations WHERE channel_id = ? AND agent_id = ?').get<ConversationUserRow>(targetChannelId, agentId);
      if (existConv) {
        this.db.prepare('UPDATE conversations SET last_message = ?, last_timestamp = ? WHERE user_uid = ? AND channel_id = ?')
          .run(displayText, ts, existConv.user_uid, targetChannelId);
      } else {
        this.db.prepare('INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(fromUid, targetChannelId, targetChannelType, targetChannelId, displayText, ts, 1, agentId);
      }
    } catch (error: unknown) {
      console.error('[Audit] 会话更新失败:', errorMessage(error));
    }

    this._notifyUI('agent-wukongim:message', {
      agentId, fromUid, toUid: targetChannelId, channelId: targetChannelId, channelType: targetChannelType,
      content: jsonContent, messageId: msgId, timestamp: ts, isMe, contentType: 11
    });
  }

  // ==========================================
  // 消息处理中枢
  // ==========================================
  handleAgentMessage(agentId: string, data: InboundMessage, skipForward = false): ForwardPayload | undefined {
    const { fromUid, toUid, channelId, content, messageId, timestamp, channelType, contentType,
      messageSeq, clientMsgNo, noPersist, redDot, syncOnce, mention } = data;

    // 群聊消息走精简路径（@触发，跳过单聊特有的黑白名单/计费/会话模式）
    // WKSDK 有时对群消息报 channelType=1，兜底按 channelId 前缀判断
    const isGroupByChannelType = (channelType || 1) === 2;
    const isGroupByPrefix = channelId && channelId.startsWith('group_');
    if (isGroupByChannelType || isGroupByPrefix) {
      console.log(`[消息路由] →群聊路径 agentId=${agentId} channelId=${channelId} channelType=${channelType||1} 原因:${isGroupByChannelType?'channelType=2':'channelId前缀group_'}`);
      return this._handleGroupMessage(agentId, data, skipForward);
    }

    if (channelId && typeof this.openclawHandler?.setCaseMapEntry === 'function') {
      this.openclawHandler.setCaseMapEntry(agentId, channelId);
    }

    if (!content || (typeof content === 'string' && content.trim() === '')) {
      console.log(`[消息跳过] agentId=${agentId} content 为空`);
      return;
    }

    const systemMsg = ['NO_REPLY', 'HEARTBEAT_OK', 'ANNOUNCE_SKIP'];
    if (typeof content === 'string' && systemMsg.includes(content.trim())) {
      console.log(`[消息跳过] agentId=${agentId} 系统消息: ${content.trim()}`);
      return;
    }

    // 系统通知消息 echo 识别（locale-independent）：前缀按 locale 本地化
    //（zh「【系统消息】」/ en「[System]」），识别层匹配所有前缀变体。
    // 这类消息由 sendSystemMessage 直接落库（is_me=2）并通过 deliver 发给访客，
    // 走到这里说明是 WuKongIM echo 回显 → 跳过避免重复，同时豁免审核/转发
    //（否则提示语会被对方 agent 再次当访客消息审核，形成 gym ⇄ 心语 式死循环风暴）。
    if (isSystemMessageContent(content)) {
      // console.log(`[消息跳过] agentId=${agentId} 系统通知消息 echo，不重复落库/不审核/不转发`);
      return;
    }

    // 保存到数据库
    // 判断消息方向：若 fromUid 是 agent 自己的 IM UID，则这条消息是 agent 发出的回复回流
    //（离线同步/IM 回执会将 agent 的发送也视为频道消息），应标记为 is_me=1
    let isMe = 0;
    if (fromUid) {
      try {
        const agentRow = this.db.prepare(`SELECT imUid FROM agents WHERE agent_id = ?`).get<AgentImUidRow>(agentId);
        if (agentRow && agentRow.imUid === fromUid) isMe = 1;
      } catch {}
    }

    // 单聊自身回复的 IM echo 回流保底去重：单聊频道里 fromUid===agent.imUid 必为 agent 自己发的消息回流，
    // 发送侧 persistAgentMessage 已落 sent(is_me=1)，这里直接跳过落库，不依赖 sent 事件回填 client_msg_no
    //（sent 事件到达率非 100%，仅靠 client_msg_no 去重会漏；此保底确保单聊 echo 一定不双写）
    if (isMe === 1) {
      // console.log(`[消息跳过-echo] agentId=${agentId} fromUid=${fromUid} channelId=${channelId} channelType=${channelType} content="${String(content||"".substring(0,60))}" isMe=1 → 丢弃（单聊echo保底）`);
      return;
    }

    // 同 agent 幂等去重：同一 agent 收到相同 clientMsgNo（WK 重复投递）则跳过。
    // 必须带 agent_id 维度——两个本地 agent 共用一个 messages 表时，一条 A2A 消息
    // 的发送方记录与接收方记录共享 clientMsgNo；仅按 client_msg_no 去重会把接收方
    // 视角误判为发送方的重复而丢弃，导致接收方收不到（gym↔老于 即此例）。
    if (clientMsgNo) {
      const dup = this.db.prepare(`SELECT 1 FROM messages WHERE client_msg_no = ? AND agent_id = ? LIMIT 1`).get<Record<string, unknown>>(clientMsgNo, agentId);
      if (dup) {
        console.log(`[消息跳过] clientMsgNo=${clientMsgNo} agentId=${agentId} 已存在，跳过`);
        return;
      }
    }
    try {

      const stmt = this.db.prepare(`
        INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, mention)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(messageId, fromUid, toUid, typeof content === 'string' ? content : String(content), channelId, channelType || 1, agentId, timestamp, isMe, 'received', messageSeq ?? null, clientMsgNo ?? null, noPersist ?? 0, redDot ?? 0, syncOnce ?? 0, data.contentType || 1, data.mention ? JSON.stringify(data.mention) : null);
    } catch (error: unknown) {
      if (errorMessage(error).includes("UNIQUE constraint")) {
        return;
      }
      console.error(`[消息存储] 失败:`, errorMessage(error));
      throw error;
    }

    // 更新会话（未读计数 +1）
    try {
      const exist = this.db.prepare(`SELECT user_uid FROM conversations WHERE user_uid = ? AND channel_id = ?`).get<ConversationUserRow>(toUid, channelId);
      if (exist) {
        this.db.prepare(`UPDATE conversations SET last_message = ?, last_timestamp = ?, unread_count = unread_count + 1, agent_id = COALESCE(?, agent_id) WHERE user_uid = ? AND channel_id = ?`)
          .run(typeof content === 'string' ? content : String(content), timestamp, agentId, toUid, channelId);
      } else {
        this.db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(toUid, channelId, channelType || 1, fromUid, typeof content === 'string' ? content : String(content), timestamp, 1, agentId);
      }
    } catch (error: unknown) {
      console.error(`[会话存储] 失败:`, errorMessage(error));
    }

    // 通知 UI + 系统通知（含提示音）
    if (!isMe) { console.debug('[通知] 收到访客消息, agent=' + agentId + ' contentLength=' + String(content || '').length); }
    logEvent('message.received', { agentId, visitorId: fromUid, id: messageId, messageId });
    this._notifyUI('agent-wukongim:message', {
      agentId, fromUid, toUid, channelId,
      content: typeof content === 'string' ? content : String(content),
      contentType: data.contentType || 1, messageId, messageSeq: messageSeq ?? null, timestamp, isMe
    });
    // 系统通知 + 提示音（lite-bus → desktop _showNotif；isMe=1 是 agent 自身回流, 不通知）
    if (!isMe) {
      try { notifyNewMessage(agentId, fromUid, content, timestamp); } catch {}
    }

    // 检查发布状态
    const agentStatusRow = this.db.prepare(`SELECT publish_status, owner_email, access_mode FROM agents WHERE agent_id = ?`).get<AgentStatusRow>(agentId);
    if (agentStatusRow && agentStatusRow.publish_status !== 'published' && agentStatusRow.publish_status !== 'private') {
      const ownerEmail = agentStatusRow.owner_email || '管理员';
      this._sendSystemMessage(agentId, fromUid, 'agent_unpublished', { ownerEmail }, timestamp);
      return;
    }

    this._autoTrustSameOwnerAgent(agentId, fromUid);

    // 黑白名单检查
    if (agentStatusRow && this.ac) {
      if (this.ac.isBlacklisted(this.db, agentId, fromUid)) {
        this._sendSystemMessage(agentId, fromUid, 'blacklisted', {}, timestamp);
        return;
      }
      if (agentStatusRow.access_mode === 'private') {
        const whitelisted = this.ac.isWhitelisted(this.db, agentId, fromUid);
        if (!whitelisted) {
          if (!this.ac.isWhitelisted(this.db, agentId, fromUid)) {
            this._sendSystemMessage(agentId, fromUid, 'friend_request_received', {}, timestamp);
            this._triggerFriendRequestIntervention(agentId, fromUid, typeof content === 'string' ? content : String(content), timestamp);
            return;
          }
        }
      }
    }

    // 计费检查
    const pricingRow = this.db.prepare('SELECT * FROM agent_pricing WHERE agent_id = ? AND enabled = 1').get<PricingRow>(agentId);
    if (pricingRow && pricingRow.pricing_model === 'timed') {
      const conv = this.db.prepare('SELECT session_status, session_expire_at FROM conversations WHERE user_uid = ? AND channel_id = ?').get<ConversationSessionRow>(toUid, channelId);
      const isBuyCmd = typeof content === 'string' && content.trim() === '购买';

      if (!conv || !conv.session_status) {
        if (pricingRow.trial_minutes > 0 && !isBuyCmd) {
          const paidCount = this.db.prepare('SELECT COUNT(*) as c FROM payment_orders WHERE agent_id = ? AND visitor_id = ? AND status = ?').get<CountRow>(agentId, fromUid, 'paid');
          if ((paidCount?.c ?? 0) === 0) {
            const expireAt = Date.now() + pricingRow.trial_minutes * 60 * 1000;
            this.db.prepare('UPDATE conversations SET session_status=?, session_expire_at=? WHERE user_uid=? AND channel_id=?').run('active', expireAt, toUid, channelId);
            this._sendSystemMessage(agentId, fromUid, 'trial_welcome', { trialMinutes: pricingRow.trial_minutes, price: pricingRow.price, durationMinutes: pricingRow.duration_minutes }, timestamp);
          } else {
            this._sendSystemMessage(agentId, fromUid, 'paid_welcome_back', { price: pricingRow.price, durationMinutes: pricingRow.duration_minutes }, timestamp);
            return;
          }
        } else {
          if (isBuyCmd) {
            this._createPendingPayment(agentId, fromUid, toUid, pricingRow, timestamp);
          } else {
            const paidSysCode = pricingRow.trial_minutes > 0 ? 'trial_welcome' : 'paid_required';
            this._sendSystemMessage(agentId, fromUid, paidSysCode, { trialMinutes: pricingRow.trial_minutes, price: pricingRow.price, durationMinutes: pricingRow.duration_minutes }, timestamp);
          }
          return;
        }
      } else if (conv.session_status === 'active') {
        if (conv.session_expire_at && conv.session_expire_at > Date.now()) {
          if (conv.session_expire_at - Date.now() < 60000) {
            this._sendSystemMessage(agentId, fromUid, 'expiring_soon', {}, timestamp);
          }
        } else {
          this.db.prepare('UPDATE conversations SET session_status=? WHERE user_uid=? AND channel_id=?').run('expired', toUid, channelId);
          if (isBuyCmd) {
            this._createPendingPayment(agentId, fromUid, toUid, pricingRow, timestamp);
          } else {
            this._sendSystemMessage(agentId, fromUid, 'session_expired', {}, timestamp);
          }
          return;
        }
      } else if (conv.session_status === 'expired') {
        if (isBuyCmd) {
          this._createPendingPayment(agentId, fromUid, toUid, pricingRow, timestamp);
        } else {
          this._sendSystemMessage(agentId, fromUid, 'session_expired', {}, timestamp);
        }
        return;
      }
    }

    // 入站消息审核
    if (this._checkAuditRules) {
      const auditResult = this._checkAuditRules(typeof content === 'string' ? content : String(content), 'inbound');
      if (auditResult.action === 'hard_deny') {
        const matchedRule = auditResult.matchedRule || {};
        if (matchedRule.prompt_key) {
          this._sendSystemMessage(agentId, fromUid, matchedRule.prompt_key, { keyword: auditResult.matchedKeyword }, timestamp);
        } else if (matchedRule.prompt) {
          // 用户自定义规则（裸 prompt）
          const prompt = this._substitutePromptVariables(matchedRule.prompt, { keyword: auditResult.matchedKeyword, visitorId: fromUid, agentId });
          if (prompt) this._sendSystemMessage(agentId, fromUid, 'audit_custom', { prompt }, timestamp);
        }
        logEvent('audit.hit', { level: 'warn', agentId, visitorId: fromUid, messageId, data: { ruleId: auditResult.matchedKeyword, direction: 'inbound', action: auditResult.action } });
        this._triggerAuditIntervention(agentId, fromUid, typeof content === 'string' ? content : String(content), auditResult, timestamp, messageId);
        return;
      }
      if (auditResult.action === 'soft_deny') {
        logEvent('audit.hit', { level: 'warn', agentId, visitorId: fromUid, messageId, data: { ruleId: auditResult.matchedKeyword, direction: 'inbound', action: auditResult.action } });
        this._triggerAuditIntervention(agentId, fromUid, typeof content === 'string' ? content : String(content), auditResult, timestamp, messageId);
      }
    }

    // 检查会话模式：MANUAL 时不转发
    if (channelId) {
      const convMode = this.db.prepare(`SELECT mode FROM conversations WHERE channel_id = ? AND agent_id = ?`).get<ConversationModeRow>(channelId, agentId);
      if (convMode && convMode.mode === 'MANUAL') return;
    }

    // 消息是 agent 自己的回复回流，不再次转发
    if (isMe === 1) return;

    // skipForward 模式：不直接转发，返回转发载荷供调用方（离线同步）收集后合并转发。
    // 被审核/黑名单/计费等拦截的消息已在上方各 return 点退出（返回 undefined）。
    if (skipForward) {
      return { agentId, fromUid, content, channelId, channelType: channelType || 1, contentType: data.contentType || 1, messageId, timestamp };
    }
    this.forwardToAgent(agentId, fromUid, content, channelId, channelType, data.contentType, messageId, timestamp, null, data._voko);
  }

  // ==========================================
  // 群聊消息处理（channelType=2）
  // - 跳过单聊特有的黑白名单/计费/会话模式
  // - user_uid 用本 agent imUid（而非 toUid，群聊 toUid 是 roomId）
  // - 仅 @本agent（mention.uids 含本 agent imUid 或 mention.all）才 forwardToAgent
  // - group_invitation 邀请消息不触发 LLM
  // ==========================================
  _handleGroupMessage(agentId: string, data: InboundMessage, skipForward = false): ForwardPayload | undefined {
    const { fromUid, toUid, channelId, content, messageId, timestamp, mention } = data;

    if (!content || (typeof content === 'string' && content.trim() === '')) {
      console.log(`[群聊跳过] agentId=${agentId} content 为空`);
      return;
    }

    // 本 agent 的 imUid（用于 user_uid 和 @判定）
    let selfImUid = '';
    try {
      const row = this.db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get<AgentImUidRow>(agentId);
      selfImUid = row?.imUid || '';
    } catch {}

    // is_me：群聊里 agent 自己发的消息回流（fromUid === 本 agent imUid）
    const isMe = (fromUid && selfImUid && fromUid === selfImUid) ? 1 : 0;

    // 识别特殊消息：旧版 group_invitation 邀请 / 服务端系统消息 tip（content JSON 的 type∈[1001,2000]，如建/加/踢/转/退）→ 不触发 LLM
    let isInvitation = false;
    let isTip = false;
    let tipText = ''; // 提取的纯文本（落库用）
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        // 兼容 WK 嵌套格式：{contentObj:{type:1001,...}, content:{type:1001,...}}
        const inner = parsed.contentObj || parsed.content || parsed;
        if (inner && inner.type === 'group_invitation') {
          isInvitation = true;
          tipText = inner.content || '';
          console.log(`[群聊Tip] invite agentId=${agentId} channelId=${channelId} type=group_invitation`);
        } else if (inner && typeof inner.type === 'number' && inner.type >= 1001 && inner.type <= 2000) {
          isTip = true;
          tipText = inner.content || '';
          console.log(`[群聊Tip] 系统消息 agentId=${agentId} channelId=${channelId} type=${inner.type} textLength=${tipText.length}`);
        }
      } catch { console.log(`[群聊Tip] 非JSON agentId=${agentId} channelId=${channelId} contentLength=${String(content || '').length}`); }
    }
    // 落库用纯文本
    const dbContent = tipText || (typeof content === 'string' ? content : String(content));

    // 落库 messages（channel_type=2；多 agent 收到同一消息时 UNIQUE 跳过）
    try {
      this.db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, mention) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(messageId, fromUid, toUid, dbContent, channelId, 2, agentId, timestamp, isMe, 'received', data.messageSeq ?? null, data.clientMsgNo ?? null, data.noPersist ?? 0, data.redDot ?? 0, data.syncOnce ?? 0, isTip ? CONTENT_TYPE_GROUP_TIP : (data.contentType || 1), mention ? JSON.stringify(mention) : null);
      console.log(`[群聊存储] ✅ agentId=${agentId} channelId=${channelId} isMe=${isMe} isTip=${isTip} contentType=${isTip?CONTENT_TYPE_GROUP_TIP:(data.contentType||1)}`);
    } catch (error: unknown) {
      if (errorMessage(error).includes('UNIQUE constraint')) {
        const stored = this.db.prepare('SELECT agent_id FROM messages WHERE id=?').get<StoredMessageAgentRow>(messageId);
        console.log(`[群聊存储] ⏭️ UNIQUE跳过落库 agentId=${agentId} channelId=${channelId} messageId=${messageId}`);
        // 同一 worker 的重复投递应整体跳过；不同 agent worker 仍需各自更新会话并处理 @。
        if (!stored || stored.agent_id === agentId) return;
      } else {
        console.error('[群聊消息存储] 失败:', errorMessage(error));
        throw error;
      }
    }

    // 落库 conversations（user_uid = 本 agent imUid，channel_id = roomId，channel_type=2）
    // 系统 tip 消息不增加未读数
    if (!isTip) {
      try {
        const userUid = selfImUid || agentId;
        const exist = this.db.prepare('SELECT user_uid FROM conversations WHERE user_uid=? AND channel_id=?').get<ConversationUserRow>(userUid, channelId);
        if (exist) {
          this.db.prepare('UPDATE conversations SET last_message=?, last_timestamp=?, unread_count=unread_count+1, agent_id=COALESCE(?, agent_id) WHERE user_uid=? AND channel_id=?')
            .run(dbContent, timestamp, agentId, userUid, channelId);
        } else {
          this.db.prepare('INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?,?,?,?,?,?,?,?)')
            .run(userUid, channelId, 2, channelId, dbContent, timestamp, 1, agentId);
        }
    } catch (error: unknown) {
      console.error('[群聊会话存储] 失败:', errorMessage(error));
    }
    }

    // UI 通知（带 mention，供渲染进程识别邀请/高亮 @）
    console.log('[群聊通知] agent=' + agentId + ' roomId=' + channelId + ' textLength=' + dbContent.length);
    const mentioned = !!(mention?.all || (mention?.uids && selfImUid && mention.uids.includes(selfImUid)));

    this._notifyUI('agent-wukongim:message', {
      agentId, fromUid, toUid, channelId, channelType: 2,
      content: dbContent,
      contentType: isTip ? CONTENT_TYPE_GROUP_TIP : (data.contentType || 1), messageId, timestamp, isMe: isMe === 1,
      mention: mention || null
    });
    if (!isMe && !isTip && mentioned) {
      try { notifyNewMessage(agentId, fromUid, content, timestamp); } catch {}
    }

    // 邀请消息 / 系统 tip / 自己的回流：不触发 LLM
    if (isInvitation || isTip || isMe === 1) return;

    // @判定：mention.all 或 mention.uids 含本 agent imUid

    if (!mentioned) return; // 未被 @：仅落库，不触发

    // 入站审核（群聊保留敏感词检查）
    if (this._checkAuditRules) {
      const auditResult = this._checkAuditRules(typeof content === 'string' ? content : String(content), 'inbound');
      if (auditResult.action === 'hard_deny' || auditResult.action === 'soft_deny') {
        this._triggerAuditIntervention(agentId, fromUid, typeof content === 'string' ? content : String(content), auditResult, timestamp, messageId, {
          channelId, channelType: 2, senderUid: fromUid,
        });
      }
      if (auditResult.action === 'hard_deny') return;
    }

    if (skipForward) {
      return { agentId, fromUid, content, channelId, channelType: 2, contentType: data.contentType || 1, messageId, timestamp, mention };
    }
    this.forwardToAgent(agentId, fromUid, content, channelId, 2, data.contentType, messageId, timestamp, mention, data._voko);
  }

  // ==========================================
  // 好友申请介入
  // ==========================================
  _triggerFriendRequestIntervention(agentId: string, visitorId: string, content: string, timestamp: number): void {
    if (!this.ac || !this.databaseAPI) return;
    const now = Date.now();
    const oiId = `private_req_${now}_${Math.random().toString(36).substr(2, 6)}`;
    const backendRow = this.db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get<BackendRow>(agentId);
    const prefix = backendRow?.backend_type === 'hermes' ? 'hermes' : 'agent';
    const visitorName = visitorId;
    this.databaseAPI.saveOwnerIntervention({
      id: oiId, visitorId, sessionKey: `${prefix}:${agentId}:${visitorId}`,
      problem: `访客 "${visitorName}"(${visitorId}) 申请添加好友\n消息内容: "${content}"`,
      agentSuggestion: '如同意请回复 "同意"，主人回复后将自动添加该访客到白名单并通知访客。',
      askTime: now, expireTime: null, status: 'pending',
      ownerReply: null, replyTime: null, parentMessageId: null,
      channelType: 'voko', resolvedAt: null, createdAt: now, updatedAt: now, agentId
    });
    this._enqueueIntervention({
      id: oiId, visitorId, agentId, sessionKey: `${prefix}:${agentId}:${visitorId}`,
      problem: `访客 "${visitorName}"(${visitorId}) 申请添加好友\n消息内容: "${content}"`,
      agentSuggestion: '如同意请回复 "同意"，主人回复后将自动添加该访客到白名单并通知访客。',
      askTime: now, skipReply: 0,
    });
    this._onOwnerInterventionNew();
  }

  // ==========================================
  // 审核介入
  // ==========================================
  _triggerAuditIntervention(
    agentId: string,
    visitorId: string,
    content: string,
    auditResult: AuditResult,
    timestamp: number,
    messageId: string,
    context: MessageContext = {},
  ): void {
    const now = Date.now();
    const oiId = `audit_${now}_${Math.random().toString(36).substr(2, 6)}`;
    const backendRow = this.db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get<BackendRow>(agentId);
    const prefix = backendRow?.backend_type === 'hermes' ? 'hermes' : 'agent';
    const targetChannelType = Number(context.channelType) === 2 ? 2 : 1;
    const targetChannelId = context.channelId || visitorId;
    const sourceSenderUid = context.senderUid || visitorId;
    const sessionTarget = targetChannelType === 2 ? `group:${targetChannelId}` : targetChannelId;
    const actionLabel = auditResult.action === 'hard_deny' ? '系统已拒绝，自动回复提示语。' : '已转发给 Agent，请关注。';
    if (this.databaseAPI) {
      this.databaseAPI.saveOwnerIntervention({
        id: oiId, visitorId, sessionKey: `${prefix}:${agentId}:${sessionTarget}`,
        problem: `访客消息: "${content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n${actionLabel}`,
        agentSuggestion: '出站/入站关键词拦截提醒，无需回复',
        askTime: now, expireTime: null, status: 'pending',
        ownerReply: null, replyTime: null, parentMessageId: null,
        channelType: 'voko', resolvedAt: null, createdAt: now, updatedAt: now, agentId,
        sourceSenderUid, targetChannelId, targetChannelType,
        sourceMessageId: messageId || null
      });
    }
    this.db.prepare('UPDATE owner_interventions SET skip_reply = 1 WHERE id = ?').run(oiId);
    this._enqueueIntervention({
      id: oiId, visitorId, agentId, sessionKey: `${prefix}:${agentId}:${sessionTarget}`,
      problem: `访客消息: "${content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n${actionLabel}`,
      agentSuggestion: '出站/入站关键词拦截提醒，无需回复',
      askTime: now, skipReply: 1, messageId,
      sourceSenderUid, targetChannelId, targetChannelType,
      sourceMessageId: messageId || null,
    });
    this.insertBlockedMessage(agentId, visitorId, content, auditResult.matchedKeyword, auditResult.action, 'inbound', visitorId, timestamp, messageId, context);
    this._onOwnerInterventionNew();
  }

  _triggerOutboundAuditIntervention(
    agentId: string,
    visitorId: string,
    content: string,
    auditResult: AuditResult,
    messageId: string,
    context: MessageContext = {},
  ): void {
    const now = Date.now();
    const oiId = `audit_out_${now}_${Math.random().toString(36).substr(2, 6)}`;
    const backendRow = this.db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get<BackendRow>(agentId);
    const prefix = backendRow?.backend_type === 'hermes' ? 'hermes' : 'agent';
    const isHardDeny = auditResult.action === 'hard_deny';
    const targetChannelType = Number(context.channelType) === 2 ? 2 : 1;
    const targetChannelId = context.channelId || visitorId;
    const sourceSenderUid = context.senderUid || visitorId;
    const sessionTarget = targetChannelType === 2 ? `group:${targetChannelId}` : targetChannelId;
    const problem = isHardDeny
      ? `Agent 回复被拦截: "${content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n系统已拦截，未发送给访客。`
      : `Agent 回复命中软规则: "${content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n已放行发送，请关注。`;
    if (this.databaseAPI) {
      this.databaseAPI.saveOwnerIntervention({
        id: oiId, visitorId,
        sessionKey: `${prefix}:${agentId}:${sessionTarget}`,
        problem,
        agentSuggestion: '出站关键词拦截提醒，无需回复',
        askTime: now, expireTime: null, status: 'pending',
        ownerReply: null, replyTime: null, parentMessageId: null,
        channelType: 'voko', resolvedAt: null, createdAt: now, updatedAt: now, agentId,
        sourceSenderUid, targetChannelId, targetChannelType,
        sourceMessageId: messageId || null
      });
    }
    this.db.prepare('UPDATE owner_interventions SET skip_reply = 1 WHERE id = ?').run(oiId);
    this._enqueueIntervention({
      id: oiId, visitorId, agentId,
      sessionKey: `${prefix}:${agentId}:${sessionTarget}`,
      problem,
      agentSuggestion: '出站关键词拦截提醒，无需回复',
      askTime: now, skipReply: 1, messageId,
      sourceSenderUid, targetChannelId, targetChannelType,
      sourceMessageId: messageId || null,
    });
    this._onOwnerInterventionNew();
  }

  // ==========================================
  // 好友申请自动审批
  // ==========================================
  autoApproveWhitelistIfFriendRequest(intervention: Record<string, unknown>, ownerReply: string): unknown {
    if (!this.ac) return;
    return this.ac.autoApproveIfFriendRequest(this.db, this._sendSystemMessage, intervention, ownerReply);
  }

  // ==========================================
  // 转发到 Agent 后端
  // ==========================================
  forwardToAgent(
    agentId: string,
    fromUid: string,
    content: string,
    channelId: string,
    channelType: number | undefined,
    contentType: number | undefined,
    messageId: string,
    timestamp: number,
    mention: Mention | null = null,
    routeMetadata: InboundMessage['_voko'] = null,
  ): void {
    if (!this.dispatcher) {
      console.error(`[转发] dispatcher 未初始化，agent=${agentId} 消息留库等 pull`);
      return;
    }
    // 统一交 dispatcher 决策：连接就绪则 push，否则留库等 agent 通过 voko_fetch_new_messages pull
    const isGroup = channelType === 2;
    const agentContent = isGroup
      ? this._buildGroupMentionPrompt(channelId, fromUid, content, messageId, timestamp)
      : content;
    let replyRouteContext: {
      conversationId: string;
      providerFamily: string;
      providerInstanceKey: string;
      nativeSessionId: string;
      strictSessionRoute: true;
    } | null = null;
    const replyToRouteId = routeMetadata?.protocolVersion === 1 && typeof routeMetadata.replyToRouteId === 'string'
      ? routeMetadata.replyToRouteId : null;
    const remoteRouteId = routeMetadata?.protocolVersion === 1 && typeof routeMetadata.routeId === 'string'
      ? routeMetadata.routeId : null;
    if (remoteRouteId && isRoutingFeatureEnabled(this.db, 'routing_conversation_shadow_v1', true)) {
      try { this._messageRoutes.recordInbound({ messageId, remoteRouteId, agentId, peerUid: fromUid,
        channelId, channelType: channelType || 1 }); } catch (_) {}
    }
    if (replyToRouteId && isRoutingFeatureEnabled(this.db, 'routing_conversation_shadow_v1', true)) {
      try {
        const resolved = this._messageRoutes.resolveReply({ replyToRouteId, agentId, peerUid: fromUid,
          channelId, channelType: channelType || 1 });
        if (resolved) {
          if (remoteRouteId) this._messageRoutes.recordInbound({ messageId, remoteRouteId,
            conversationId: resolved.conversation.id, agentId, peerUid: fromUid, channelId,
            channelType: channelType || 1 });
          replyRouteContext = { conversationId: resolved.conversation.id,
            providerFamily: resolved.conversation.providerFamily,
            providerInstanceKey: resolved.conversation.providerInstanceKey,
            nativeSessionId: resolved.conversation.nativeSessionId, strictSessionRoute: true };
        }
      } catch (_) { /* invalid route remains on legacy/Pull path */ }
    }
    this.dispatcher.dispatch(agentId, {
      agentId, fromUid, senderUid: fromUid, content: agentContent, rawContent: content, channelId,
      sessionTarget: isGroup ? 'group:' + channelId : fromUid,
      channelType: channelType || 1, contentType: contentType || 1,
      messageId, timestamp, mention: isGroup ? mention : null, replyRouteContext,
      remoteRouteId,
    });
  }
  // ==========================================
  // Agent 回复处理
  // ==========================================

  _buildGroupMentionPrompt(
    channelId: string,
    senderUid: string,
    content: string,
    messageId: string,
    timestamp: number,
  ): string {
    let groupName = channelId;
    try {
      const conv = this.db.prepare(
        'SELECT name FROM conversations WHERE channel_id=? AND channel_type=2 AND name IS NOT NULL AND name!=? LIMIT 1'
      ).get<GroupNameRow>(channelId, channelId);
      if (conv?.name) groupName = conv.name;
    } catch {}
    const rows: GroupContextRow[] = [];
    try {
      const raw = this.db.prepare(
        'SELECT id, from_uid, content, timestamp, content_type, message_seq, client_msg_no ' +
        'FROM messages WHERE channel_id=? AND channel_type=2 AND id!=? AND content_type NOT IN (11,12) ' +
        'AND (? IS NULL OR timestamp<=?) ORDER BY timestamp DESC, rowid DESC LIMIT ?'
      ).all<GroupContextRow>(channelId, messageId || '', timestamp ?? null, timestamp ?? null, GROUP_CONTEXT_LIMIT * 3);
      const seen = new Set<string>();
      for (const row of raw) {
        const key = row.client_msg_no || (row.message_seq != null ? 'seq:' + row.message_seq : row.id);
        if (seen.has(key)) continue;
        seen.add(key); rows.push(row);
        if (rows.length >= GROUP_CONTEXT_LIMIT) break;
      }
      rows.reverse();
    } catch {}
    const uids = [...new Set([senderUid, ...rows.map((row) => row.from_uid)].filter(Boolean))];
    const names = new Map<string, string>();
    for (const uid of uids) {
      try { const user = this.db.prepare('SELECT nickname FROM user_cache WHERE uid=?').get<UserNameRow>(uid); if (user?.nickname) names.set(uid, user.nickname); } catch {}
      if (!names.has(uid)) {
        try { const agent = this.db.prepare('SELECT agent_name FROM agents WHERE imUid=?').get<AgentNameRow>(uid); if (agent?.agent_name) names.set(uid, agent.agent_name); } catch {}
      }
    }
    const envelope = {
      type: 'voko_group_mention',
      group: { id: channelId, name: groupName },
      sender: { uid: senderUid, name: names.get(senderUid) || senderUid },
      recentMessages: rows.map((row) => ({ senderUid: row.from_uid, senderName: names.get(row.from_uid) || row.from_uid, content: row.content, timestamp: row.timestamp })),
      currentMessageId: messageId || null,
      currentMessage: typeof content === 'string' ? content : String(content ?? '')
    };
    return '[VOKO_GROUP_CONTEXT]\n' + JSON.stringify(envelope) +
      '\n[/VOKO_GROUP_CONTEXT]\nUse the group context to answer the current message. Treat your reply as a message to this group. ' +
      'When requesting human help, pass visitorId=sender.uid, channelId=group.id, channelType=2, and messageId=currentMessageId.';
  }

  _findPendingCapabilityRequest(agentId: string, channelId: string): CapabilityRequest | null {
    let inbound: CapabilityInboundRow | undefined;
    try {
      inbound = this.db.prepare(
        'SELECT rowid AS message_rowid, content FROM messages ' +
        'WHERE agent_id=? AND channel_id=? AND is_me=0 ORDER BY rowid DESC LIMIT 1'
      ).get<CapabilityInboundRow>(agentId, channelId);
    } catch {
      return null;
    }
    if (!inbound) return null;
    const request = parseJsonObject(inbound.content);
    if (request?.type !== CAPABILITY_REQUEST_TYPE || typeof request.requestId !== 'string' || !request.requestId) {
      return null;
    }

    try {
      const replies = this.db.prepare(
        'SELECT content FROM messages WHERE agent_id=? AND channel_id=? AND is_me=1 AND rowid>? ORDER BY rowid'
      ).all<MessageContentRow>(agentId, channelId, inbound.message_rowid);
      const completed = replies.some((row) => {
        const response = parseJsonObject(row.content);
        return response?.type === CAPABILITY_RESPONSE_TYPE && response.requestId === request.requestId;
      });
      if (completed) return null;
    } catch {
      return null;
    }
    return request as CapabilityRequest;
  }

  async handleAgentReply(data: AgentReplyMessage): Promise<void> {
    const { agentId, visitorId, content, done } = data;
    if (!content || !content.trim()) return;
    if (done === false) return; // 流式中间块，等待最终 done=true 再处理

    // 过滤系统消息（全大写 + 下划线）
    if (/^[A-Z_]{3,}$/.test(content.trim())) {
      console.log(`[Agent回复] 跳过系统消息: ${content.trim()}`);
      return;
    }

    const hasGroupTarget = typeof visitorId === 'string' && visitorId.startsWith('group:');
    const isGroupReply = data.channelType === 2 || hasGroupTarget;
    const replyChannelId = hasGroupTarget ? visitorId.slice('group:'.length) : (data.channelId || visitorId);
    const replyChannelType = isGroupReply ? 2 : 1;
    const agentRow = this.db.prepare('SELECT agent_id, imUid FROM agents WHERE agent_id = ?').get<AgentReplyRow>(agentId);
    if (!agentRow) return;

    // 解析 A2A STATE（四级容错：strict → loose → regex → none）。
    // 只有 agenda 为空且 converged=true 才接受收敛声明；
    // 群聊是否继续真实 @回上一位 Agent 也由该 STATE 决定。
    const { state: a2aState, method: a2aParseMethod } = parseA2AState(content);
    const a2aPeerUid = data.a2aPeerUid || (replyChannelType === 1 ? replyChannelId : null);
    const a2aScope = data.a2aScope || (replyChannelType === 2 ? `group:${replyChannelId}` : 'direct');
    const expectsA2AReply = a2aState?.expects_reply === true;
    const validConvergence = !!(
      a2aState?.converged === true &&
      !expectsA2AReply &&
      Array.isArray(a2aState.agenda) &&
      a2aState.agenda.length === 0
    );
    if (!data.interventionResume && validConvergence && a2aPeerUid && this.dispatcher?.markConverged) {
      this.dispatcher.markConverged(agentRow.imUid, a2aPeerUid, a2aScope);
      console.log(`[Agent回复] A2A 标记收敛 agent=${agentId} 对方=${a2aPeerUid} scope=${a2aScope}`);
    }
    // 容错解析埋点：非 strict（loose/regex）说明 LLM 输出畸形但被救回；none 说明完全解析失败。
    // 监控此指标可反哺 dispatcher 的 STATE prompt 调优。
    if (a2aParseMethod === 'loose' || a2aParseMethod === 'regex') {
      console.log(`[Agent回复] A2A STATE 容错解析 method=${a2aParseMethod} agent=${agentId}`);
    }
    // 剥离 agent 误带回的元数据块 [Conversation info ...] + A2A 收敛协议的 [STATE]...[/STATE] 块
    //（STATE 块由 dispatcher 注入的 prompt 产生，含协商状态 JSON，不得落库/发给访客）。
    // stripStateBlock 容忍 markdown 围栏、缺结束标签、多块复读，保证访客侧零协议噪音。
    const cleanContent = data.a2aManaged
      ? extractA2AVisibleReply(content)
      : stripStateBlock(content);

    let trimmedContent = cleanContent.replace(/^[\n\r\s]+/, '').trim();
    if (data.interventionResume) {
      trimmedContent = sanitizeOwnerInterventionReply(trimmedContent);
    }
    const capabilityRequest = replyChannelType === 1
      ? this._findPendingCapabilityRequest(agentId, replyChannelId)
      : null;
    if (capabilityRequest) {
      trimmedContent = serializeCapabilityResponse(trimmedContent, String(capabilityRequest.requestId));
    }
    const fromUid = agentRow.imUid;
    let replyMentions: Mention | null = null;
    // 群内 A2A 收敛与私聊统一：始终 @ 回上一位 Agent，由入站闸门（_consumeConverged）+ 轮次熔断负责收敛。
    // 唯一刹车：当 STATE 彻底解析失败（none）时不 @，避免两个 agent 持续输出畸形 STATE 导致乒乓到熔断。
    // Human senders are always mentioned; Agent senders always mention back unless STATE parse totally failed.
    let mentionTargetUid: string | null = null;
    if (replyChannelType === 2 && data.senderUid) {
      const senderIsAgent = data.a2aManaged || this.dispatcher?.isAgentImUid?.(data.senderUid) === true;
      if (data.interventionResume) mentionTargetUid = data.senderUid;
      else if (!senderIsAgent) mentionTargetUid = data.senderUid;
      else if (data.a2aManaged && a2aParseMethod !== 'none') mentionTargetUid = a2aPeerUid;
    }
    if (mentionTargetUid) {
      replyMentions = { all: false, uids: [mentionTargetUid] };
    }
    if (!trimmedContent) return;

    // 落库（共享：messages + conversations）。投递延后到出站审核之后（hard_deny 不投递）。
    const { msgId, timestamp } = persistAgentMessage(this.db, agentId, replyChannelId, trimmedContent, fromUid, 'text', replyChannelType, replyMentions);
    console.log(`[Agent回复] 已存入DB id=${msgId} agent=${agentId} visitor=${visitorId} 字数=${trimmedContent.length}`);

    // 出站审核
    if (this._checkAuditRules) {
      const auditResult = this._checkAuditRules(trimmedContent, 'outbound');
      if (auditResult.action === 'hard_deny') {
        console.log(`[审核-出站] hard_deny agentId=${agentId} keyword="${auditResult.matchedKeyword}"`);
        logEvent('audit.hit', { level: 'warn', agentId, visitorId: replyChannelId, messageId: msgId, data: { ruleId: auditResult.matchedKeyword, direction: 'outbound', action: 'hard_deny' } });
        this.insertBlockedMessage(agentId, replyChannelId, trimmedContent, auditResult.matchedKeyword, 'hard_deny', 'outbound', fromUid, timestamp, msgId, { channelId: replyChannelId, channelType: replyChannelType });
        this._triggerOutboundAuditIntervention(agentId, replyChannelId, trimmedContent, auditResult, msgId, { channelId: replyChannelId, channelType: replyChannelType, senderUid: data.senderUid });
        // 通知访客：回复因敏感信息未发送，避免访客以为没响应
        if (replyChannelType === 1) this._sendSystemMessage(agentId, replyChannelId, 'reply_sensitive', {}, timestamp);
        return;
      }
      if (auditResult.action === 'soft_deny') {
        logEvent('audit.hit', { level: 'warn', agentId, visitorId: replyChannelId, messageId: msgId, data: { ruleId: auditResult.matchedKeyword, direction: 'outbound', action: 'soft_deny' } });
        this.insertBlockedMessage(agentId, replyChannelId, trimmedContent, auditResult.matchedKeyword, 'soft_deny', 'outbound', fromUid, timestamp, msgId, { channelId: replyChannelId, channelType: replyChannelType });
        this._triggerOutboundAuditIntervention(agentId, replyChannelId, trimmedContent, auditResult, msgId, { channelId: replyChannelId, channelType: replyChannelType, senderUid: data.senderUid });
      }
    }

    // 发送给访客（统一通过 VokoIMSDK Hub）
    if (!this._deliver) {
      this.db.prepare(`UPDATE messages SET status='failed' WHERE id=?`).run(msgId);
      console.error(`[Agent回复] IM Hub 投递器未初始化: ${agentId}`);
      return;
    }

    // 保持本地会话即时可见；最终 sent/failed 状态由下面的 SENDACK 结果更新。
    logEvent('message.replied', { agentId, visitorId: replyChannelId, id: msgId, messageId: msgId, data: { replyLength: trimmedContent.length, channelType: replyChannelType } });
    this._notifyUI('agent-wukongim:message', {
      agentId, fromUid, toUid: replyChannelId, channelId: replyChannelId, channelType: replyChannelType,
      content: trimmedContent, contentType: 1, messageId: msgId, timestamp, isMe: true, mention: replyMentions
    });

    let outboundRouteId: string | null = null;
    const replyToRouteId = typeof data.remoteRouteId === 'string' ? data.remoteRouteId : null;
    try {
      if (!isRoutingFeatureEnabled(this.db, 'routing_conversation_shadow_v1', true)) throw new Error('routing shadow disabled');
      let conversation = data.replyRouteContext?.conversationId
        ? this._routingConversations.getForScope(data.replyRouteContext.conversationId, agentId, replyChannelId, replyChannelType)
        : null;
      if (!conversation && data.sessionKey) {
        const backend = this.db.prepare('SELECT backend_type,backend_instance_id FROM agents WHERE agent_id=? LIMIT 1')
          .get<BackendRow>(agentId);
        const family = normalizeProviderFamily(backend?.backend_type || '');
        if (family) conversation = this._routingConversations.resolveOrCreate({ agentId, providerFamily: family,
          providerInstanceKey: backend?.backend_instance_id || '', nativeSessionId: data.sessionKey,
          channelId: replyChannelId, channelType: replyChannelType, origin: 'voko_managed' });
      }
      if (conversation) outboundRouteId = this._messageRoutes.createPending({ messageId: msgId,
        conversationId: conversation.id, replyToRouteId, agentId, peerUid: replyChannelId,
        channelId: replyChannelId, channelType: replyChannelType, direction: 'outbound' });
    } catch (_) {}
    const routeMetadata = outboundRouteId ? { _voko: { protocolVersion: 1, routeId: outboundRouteId,
      ...(replyToRouteId ? { replyToRouteId } : {}) } } : null;
    const delivery = await this._deliver(agentId, replyChannelId, trimmedContent, 'text', replyChannelType, replyMentions, msgId, routeMetadata);
    if ((delivery as { success?: boolean })?.success === false) {
      if (outboundRouteId && !(delivery as { outcomeUnknown?: boolean })?.outcomeUnknown) {
        try { this._messageRoutes.setStatus(outboundRouteId, 'failed'); } catch (_) {}
      }
      this.db.prepare(`UPDATE messages SET status='failed' WHERE id=?`).run(msgId);
      console.error('[Agent回复] 投递失败:', (delivery as { error?: string })?.error || 'unknown error');
      return;
    }
    if (outboundRouteId) {
      try { this._messageRoutes.setStatus(outboundRouteId, 'active'); } catch (_) {}
    }

    // Persist the successful Hub acknowledgement so local status checks and
    // runtime probes do not leave a delivered reply in the pending state.
    try {
      const messageSeq = Number.isFinite(Number((delivery as { messageSeq?: unknown })?.messageSeq))
        ? Number((delivery as { messageSeq?: unknown })?.messageSeq)
        : null;
      const clientMsgNo = (delivery as { clientMsgNo?: unknown })?.clientMsgNo
        ? String((delivery as { clientMsgNo?: unknown })?.clientMsgNo)
        : null;
      this.db.prepare(`
        UPDATE messages
        SET status='sent',
            message_seq=COALESCE(?, message_seq),
            client_msg_no=COALESCE(?, client_msg_no)
        WHERE id=?
      `).run(messageSeq, clientMsgNo, msgId);
    } catch (_) {}

  }
}

module.exports = { MessageHandler };
