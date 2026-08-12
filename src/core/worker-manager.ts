/**
 * Agent IM connection manager.
 *
 * The public class name is retained for API compatibility, but the old
 * one-process-per-Agent worker implementation has been replaced by the
 * in-process VokoIMSDK Hub pool.
 */

const EventEmitter = require('events');
const { VokoWorkerAdapter } = require('../im-sdk');
const { normalizeOfficialImServerUrl } = require('./url-security');
import type { DatabaseLike } from '../types/database';
import { MessageRouteStore, RoutingConversationStore } from './provider-routing';

interface AgentWorkerConfig {
  agentId?: string;
  uid: string;
  token: string;
  serverUrl: string;
  [key: string]: unknown;
}

type Deliver = (
  agentId: string,
  visitorId: string,
  content: string,
  messageType?: string,
  channelType?: number,
  mentions?: unknown,
  localMsgId?: string | null,
  metadata?: unknown,
) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentWorkerManager extends EventEmitter {
  [key: string]: any;
  db: DatabaseLike | null;
  adapter: any;
  workers: Map<string, { worker: { send(message: Record<string, unknown>): void }; config: AgentWorkerConfig }>;
  connectionStatus: Map<string, string>;
  connectedAgents: Set<string>;
  publishedAgentIds: Set<string>;
  _allWorkers: Map<string, never>;
  _deliver: Deliver | null;
  _pendingMessages: any[];

  constructor(
    db: DatabaseLike | null,
    options: { maxConnectionsPerHub?: number; connectDelay?: number; clientFactory?: (config: AgentWorkerConfig) => unknown } = {},
  ) {
    super();
    this.db = db;
    this.workers = new Map();
    this.connectionStatus = new Map();
    this.connectedAgents = new Set();
    this.publishedAgentIds = new Set();
    // Kept empty so old shutdown guards remain harmless during the migration.
    this._allWorkers = new Map<string, never>();
    this._deliver = null;
    this._pendingMessages = [];
    this.adapter = new VokoWorkerAdapter({
      maxConnectionsPerHub: options.maxConnectionsPerHub || 20,
      connectDelay: options.connectDelay ?? 100,
      clientFactory: options.clientFactory,
    });

    this.adapter.on('worker.message', (msg: any) => {
      const data = msg?.data || {};
      console.log(
        `[IM 接收] agent=${msg.agentId} channel=${data.channelId || '-'} channelType=${data.channelType || 1}`
        + ` from=${data.fromUid || '-'} type=${data.contentType || 1} seq=${data.messageSeq ?? '-'}`
        + ` contentLength=${String(data.content ?? '').length}`,
      );
      if (this.listenerCount('message') > 0) {
        this.emit('message', msg);
        return;
      }
      if (this._pendingMessages.length >= 1000) {
        msg?.data?.nack?.(new Error('Agent IM startup message buffer is full'));
        return;
      }
      this._pendingMessages.push(msg);
    });
    this.on('newListener', (eventName: string) => {
      if (eventName !== 'message' || this._pendingMessages.length === 0) return;
      queueMicrotask(() => {
        if (this.listenerCount('message') === 0) return;
        for (const pending of this._pendingMessages.splice(0)) this.emit('message', pending);
      });
    });
    this.adapter.on('worker.sent', (msg: any) => this.emit('sent', msg));
    this.adapter.on('worker.status', (msg: any) => {
      this.connectionStatus.set(msg.agentId, msg.status);
      if (msg.status === 'connected') {
        this.connectedAgents.add(msg.agentId);
        this.emit('agent-connected', msg.agentId);
      } else {
        this.connectedAgents.delete(msg.agentId);
      }
      this.emit('status', msg);
    });
    this.adapter.on('worker.pong', (msg: any) => this.emit('pong', msg));
    this.adapter.on('worker.error', (msg: any) => this.emit('worker-error', msg));
    this.adapter.on('worker.event', (msg: any) => this.emit('event', msg));
    this.adapter.on('worker.ackTimeout', (msg: any) => this.emit('ack-timeout', msg));
    this.adapter.on('worker.quarantined', (msg: any) => this.emit('quarantined', msg));
  }

  async start(
    agentId: string,
    config: AgentWorkerConfig,
    _appPaths?: unknown,
    _deferRegistry = false,
  ): Promise<{ connected: boolean; uid: string | null; status: string; error?: string }> {
    if (!agentId || !config?.uid || !config?.token || !config?.serverUrl) {
      return { connected: false, uid: config?.uid || null, status: 'connect_fail', error: 'Agent IM credentials are incomplete' };
    }
    if (this.adapter.isRunning(agentId)) {
      const current = this.getStatus(agentId);
      if (current.status === 'connected' || current.status === 'connecting') return current;
      this.adapter.stop(agentId);
      this.workers.delete(agentId);
    }

    const normalized = {
      ...config,
      serverUrl: normalizeOfficialImServerUrl(config.serverUrl),
      ackMode: 'manual',
    };
    const entry = {
      config: normalized,
      worker: {
        send: (message: Record<string, unknown>) => {
          if (message.type === 'disconnect') {
            void this.stop(agentId);
            return;
          }
          if (message.type === 'send') {
            void this.adapter.send(agentId, message).then((result: any) => {
              if (result?.success) this.emit('sent', { agentId, localMsgId: message.localMsgId, ...result });
              else this.emit('send-error', { agentId, localMsgId: message.localMsgId, ...result });
            });
          }
        },
      },
    };
    this.workers.set(agentId, entry);
    this.connectionStatus.set(agentId, 'connecting');
    try {
      await this.adapter.start(agentId, normalized);
      return this.getStatus(agentId);
    } catch (error: unknown) {
      this.workers.delete(agentId);
      this.connectedAgents.delete(agentId);
      const message = errorMessage(error);
      console.error(`[Agent IM] ${agentId} connection failed: ${message}`);
      return { connected: false, uid: config.uid, status: 'connect_fail', error: message };
    }
  }

  async restart(agentId: string, config?: AgentWorkerConfig): Promise<unknown> {
    const next = config || this.workers.get(agentId)?.config;
    if (!next) throw new Error(`Unknown Agent: ${agentId}`);
    await this.stop(agentId);
    return this.start(agentId, next);
  }

  async startMany(
    entries: Array<{ agentId: string; config: AgentWorkerConfig }>,
    options: { concurrency?: number; staggerMs?: number } = {},
  ): Promise<Array<{ agentId: string; connected: boolean; error?: string }>> {
    const concurrency = Math.max(1, options.concurrency || 5);
    const staggerMs = Math.max(0, options.staggerMs ?? 100);
    const results: Array<{ agentId: string; connected: boolean; error?: string }> = [];
    for (let index = 0; index < entries.length; index += concurrency) {
      const batch = entries.slice(index, index + concurrency);
      const settled = await Promise.all(batch.map(async ({ agentId, config }) => {
        const status = await this.start(agentId, config);
        return { agentId, connected: status.connected, ...(status.error ? { error: status.error } : {}) };
      }));
      results.push(...settled);
      if (index + concurrency < entries.length && staggerMs) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }
    }
    return results;
  }

  async stop(agentId: string): Promise<void> {
    this.adapter.stop(agentId);
    this.workers.delete(agentId);
    this.connectionStatus.delete(agentId);
    this.connectedAgents.delete(agentId);
  }

  disconnect(agentId: string): { success: true } {
    void this.stop(agentId);
    return { success: true };
  }

  async stopAll(): Promise<void> {
    this.adapter.disconnectAll();
    this.workers.clear();
    this.connectionStatus.clear();
    this.connectedAgents.clear();
  }

  killAll(): void {
    this.adapter.disconnectAll();
    this.workers.clear();
    this.connectionStatus.clear();
    this.connectedAgents.clear();
  }

  flushWorkerRegistry(): void {
    // No-op: VokoIMSDK clients live in the main process and need no PID registry.
  }

  isRunning(agentId: string): boolean { return this.adapter.isRunning(agentId); }

  getWorker(agentId: string) { return this.workers.get(agentId); }

  getFirstAgentId(): string | null { return this.workers.keys().next().value || null; }

  getStatus(agentId: string): {
    connected: boolean;
    uid: string | null;
    status: string;
    transport: 'hub';
    hubIndex?: number;
    stats?: Record<string, number>;
  } {
    const base = this.adapter.getStatus(agentId);
    const detail = this.adapter.pool.status(agentId);
    return {
      connected: base.connected,
      uid: base.uid,
      status: base.status,
      transport: 'hub',
      ...(detail ? { hubIndex: detail.hubIndex, stats: detail.stats } : {}),
    };
  }

  waitForConnection(agentId: string, timeoutMs = 5000): Promise<ReturnType<AgentWorkerManager['getStatus']>> {
    const current = this.getStatus(agentId);
    if (current.status !== 'connecting') return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve(this.getStatus(agentId));
      };
      const onStatus = (event: { agentId?: string; status?: string }) => {
        if (event.agentId === agentId && event.status !== 'connecting') finish();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      timer.unref?.();
      this.on('status', onStatus);
    });
  }

  getHubSummary() { return this.adapter.pool.summary(); }

  deliver(
    agentId: string,
    channelId: string,
    content: string,
    messageType = 'text',
    channelType = 1,
    mentions: unknown = null,
    localMsgId: string | null = null,
    metadata: unknown = null,
  ) {
    return this.adapter.deliver(agentId, channelId, content, messageType, channelType, mentions, localMsgId || undefined, metadata);
  }

  send(
    agentId: string,
    channelId: string,
    content: string,
    messageType = 'text',
    channelType = 1,
    mentions: unknown = null,
  ) {
    return this.deliver(agentId, channelId, content, messageType, channelType, mentions);
  }

  disconnectAll(): void { this.killAll(); }

  setDeliver(fn: Deliver): void { this._deliver = fn; }

  async sendSystemMessage(
    agentId: string,
    visitorId: string,
    sysCodeOrContent: string,
    p1?: Record<string, unknown> | number | null,
    p2?: number,
    route?: { conversationId?: string | null },
  ): Promise<{ notificationStatus: 'sent' | 'skipped' | 'failed'; notificationReason?: string }> {
    if (!agentId || !visitorId || !sysCodeOrContent || !this.db) {
      return { notificationStatus: 'skipped', notificationReason: 'invalid_notification' };
    }
    if (!this.workers.has(agentId)) {
      return { notificationStatus: 'skipped', notificationReason: 'agent_worker_unavailable' };
    }
    const { t, systemMessagePrefix } = require('./i18n');
    const locale = this._visitorLocale(visitorId);
    const isNewMode = p1 === undefined || p1 === null || typeof p1 === 'object';
    const sysParams = isNewMode ? (p1 || {}) : {};
    const serverTimestamp = isNewMode ? p2 : p1;

    let rendered = t(`visitor.${sysCodeOrContent}`, sysParams, locale);
    let isSysCode = rendered !== `visitor.${sysCodeOrContent}`;
    if (!isSysCode) {
      const fallback = t(sysCodeOrContent, sysParams, locale);
      if (fallback !== sysCodeOrContent) { rendered = fallback; isSysCode = true; }
    }
    const content = isSysCode ? systemMessagePrefix(locale) + rendered : sysCodeOrContent;
    const sysCode = isSysCode ? sysCodeOrContent : null;
    const sysParamsJson = isSysCode && Object.keys(sysParams as object).length ? JSON.stringify(sysParams) : null;
    const agentRow = this.db.prepare('SELECT imUid FROM agents WHERE agent_id = ?').get<{ imUid?: string }>(agentId);
    if (!agentRow?.imUid) return { notificationStatus: 'failed', notificationReason: 'agent_identity_unavailable' };

    const timestamp = typeof serverTimestamp === 'number' ? serverTimestamp + 1 : Math.floor(Date.now() / 1000);
    const msgId = `sys-${agentId}-${visitorId}-${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
    let routeId: string | null = null;
    let routeMetadata: Record<string, unknown> | null = null;
    if (route?.conversationId) {
      try {
        const conversations = new RoutingConversationStore(this.db);
        const routes = new MessageRouteStore(this.db);
        const conversation = conversations.getForScope(route.conversationId, agentId, visitorId, 1);
        if (conversation) {
          const latestInbound = routes.latestInboundForConversation(conversation.id);
          routeId = routes.createPending({ messageId: msgId, conversationId: conversation.id,
            replyToRouteId: latestInbound?.route_id || null, agentId, peerUid: visitorId,
            channelId: visitorId, channelType: 1, direction: 'outbound' });
          routeMetadata = { _voko: { protocolVersion: 1, routeId,
            ...(latestInbound?.route_id ? { replyToRouteId: latestInbound.route_id } : {}),
            ...(conversation.wireConversationKey ? { conversationKey: conversation.wireConversationKey } : {}) } };
        } else return { notificationStatus: 'failed', notificationReason: 'routing_conversation_unavailable' };
      } catch (_) {
        try { if (routeId) new MessageRouteStore(this.db).setStatus(routeId, 'failed'); } catch (_) {}
        return { notificationStatus: 'failed', notificationReason: 'routing_conversation_unavailable' };
      }
    }
    try {
      this.db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, sys_code, sys_params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        msgId, agentRow.imUid, visitorId, content, visitorId, 1, agentId, timestamp,
        2, 'pending', null, null, 0, 0, 0, 1, sysCode, sysParamsJson,
      );
    } catch (error: unknown) {
      try { if (routeId) new MessageRouteStore(this.db).setStatus(routeId, 'failed'); } catch (_) {}
      console.error('[sendSystemMessage] message persistence failed:', errorMessage(error));
      return { notificationStatus: 'failed', notificationReason: 'persistence_failed' };
    }

    try {
      const existing = this.db.prepare('SELECT user_uid FROM conversations WHERE user_uid=? AND channel_id=?')
        .get(agentRow.imUid, visitorId);
      if (existing) {
        this.db.prepare('UPDATE conversations SET last_message=?, last_timestamp=? WHERE user_uid=? AND channel_id=?')
          .run(content, timestamp, agentRow.imUid, visitorId);
      } else {
        this.db.prepare('INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(agentRow.imUid, visitorId, 1, visitorId, content, timestamp, 0, agentId);
      }
    } catch (error: unknown) {
      console.error('[sendSystemMessage] conversation update failed:', errorMessage(error));
    }

    if (!this._deliver) {
      try { if (routeId) new MessageRouteStore(this.db).setStatus(routeId, 'failed'); } catch (_) {}
      return { notificationStatus: 'skipped', notificationReason: 'delivery_unavailable' };
    }
    try {
      const result: any = await this._deliver(agentId, visitorId, content, 'text', 1, null, msgId, routeMetadata);
      const delivered = result?.success !== false;
      if (routeId) new MessageRouteStore(this.db).setStatus(routeId, delivered ? 'active' : 'failed');
      try {
        this.db?.prepare(`UPDATE messages SET status=?, message_seq=COALESCE(?, message_seq), client_msg_no=COALESCE(?, client_msg_no) WHERE id=?`)
          .run(delivered ? 'sent' : 'failed', result?.messageSeq ?? null, result?.clientMsgNo ?? null, msgId);
      } catch (error: unknown) {
        console.error('[sendSystemMessage] status update failed:', errorMessage(error));
      }
      if (!delivered) return { notificationStatus: 'failed', notificationReason: 'delivery_failed' };
    } catch (error: unknown) {
      try { this.db?.prepare(`UPDATE messages SET status='failed' WHERE id=?`).run(msgId); } catch (_) {}
      try { if (routeId && this.db) new MessageRouteStore(this.db).setStatus(routeId, 'failed'); } catch (_) {}
      console.error('[sendSystemMessage] delivery failed:', errorMessage(error));
      return { notificationStatus: 'failed', notificationReason: 'delivery_failed' };
    }
    this.emit('system-message', { agentId, fromUid: agentRow.imUid, visitorId, content, msgId, timestamp, sysCode, locale });
    return { notificationStatus: 'sent' };
  }

  _visitorLocale(visitorId: string): string {
    if (!this.db) return 'zh';
    try {
      const row = this.db.prepare('SELECT locale FROM user_cache WHERE uid = ?').get<{ locale?: string }>(visitorId);
      return row?.locale || 'zh';
    } catch (_) { return 'zh'; }
  }
}

module.exports = { AgentWorkerManager };
