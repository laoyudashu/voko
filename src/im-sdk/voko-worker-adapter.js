'use strict';

const { EventEmitter } = require('node:events');
const { VokoIMHubPool } = require('./hub-pool');
const { ChannelType, ContentType, encodeContent } = require('./messages');

class VokoWorkerAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pool = options.pool || new VokoIMHubPool(options);
    this.configs = new Map();
    this.statuses = new Map();
    this.recoveryDelayMs = options.recoveryDelayMs ?? 45_000;
    this.recoveryTimers = new Map();
    this.on('error', () => {});
    for (const event of ['connect', 'disconnect', 'reconnecting', 'reconnectExhausted', 'kicked', 'error', 'message', 'sent', 'pong', 'event', 'ackTimeout', 'quarantined']) {
      this.pool.on(event, (payload) => this._forward(event, payload));
    }
  }

  _forward(event, payload) {
    const { agentId, data } = payload;
    if (event === 'connect') this._clearRecovery(agentId);
    if (event === 'disconnect') {
      console.warn(`[IM 连接] agent=${agentId} disconnected code=${data?.code ?? '-'} reason=${String(data?.reason || '-').slice(0, 160)}`);
    } else if (event === 'reconnecting') {
      console.warn(`[IM 连接] agent=${agentId} reconnecting attempt=${data?.attempt ?? '-'} delay=${data?.delay ?? '-'}ms`);
    } else if (event === 'reconnectExhausted') {
      console.error(`[IM 连接] agent=${agentId} reconnect exhausted attempts=${data?.attempts ?? '-'}`);
    } else if (event === 'error') {
      console.warn(`[IM 连接] agent=${agentId} error=${String(data?.message || data || 'unknown').slice(0, 160)}`);
    }
    if (event === 'connect') this.statuses.set(agentId, 'connected');
    else if (event === 'reconnecting') this.statuses.set(agentId, 'connecting');
    else if (event === 'disconnect' && this.statuses.get(agentId) !== 'kicked') this.statuses.set(agentId, 'disconnected');
    else if (event === 'kicked') this.statuses.set(agentId, 'kicked');
    else if (event === 'reconnectExhausted') this.statuses.set(agentId, 'connect_fail');
    if (event === 'disconnect') this._scheduleRecovery(agentId);
    this.emit(event, { agentId, data });
    if (event === 'message') this.emit('worker.message', { agentId, data: this._normalizeMessage(data) });
    if (event === 'sent') this.emit('worker.sent', { agentId, localMsgId: data.clientMsgNo, messageId: data.messageId, messageSeq: data.messageSeq, clientMsgNo: data.clientMsgNo, success: data.reasonCode === 1 });
    if (event === 'pong') this.emit('worker.pong', { agentId, connected: true, statusCode: 1 });
    if (event === 'error') this.emit('worker.error', { agentId, error: data });
    if (event === 'event') this.emit('worker.event', { agentId, data });
    if (event === 'ackTimeout') this.emit('worker.ackTimeout', { agentId, data });
    if (event === 'quarantined') this.emit('worker.quarantined', { agentId, data });
    if (['connect', 'disconnect', 'reconnecting', 'reconnectExhausted', 'kicked'].includes(event)) {
      const status = this.statuses.get(agentId);
      const statusCode = { disconnected: 0, connected: 1, connecting: 2, connect_fail: 3, kicked: 4 }[status];
      this.emit('worker.status', { agentId, status, statusCode, data });
    }
  }

  _clearRecovery(agentId) {
    const timer = this.recoveryTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.recoveryTimers.delete(agentId);
  }

  _scheduleRecovery(agentId) {
    if (!this.configs.has(agentId) || this.recoveryTimers.has(agentId)) return;
    const timer = setTimeout(async () => {
      this.recoveryTimers.delete(agentId);
      if (!this.configs.has(agentId) || this.statuses.get(agentId) === 'connected') return;
      const config = this.configs.get(agentId);
      console.warn(`[IM 连接] agent=${agentId} watchdog restarting stalled connection`);
      try { await this.restart(agentId, config); }
      catch (error) {
        console.warn(`[IM 连接] agent=${agentId} watchdog restart failed: ${String(error?.message || error).slice(0, 160)}`);
        this._scheduleRecovery(agentId);
      }
    }, this.recoveryDelayMs);
    timer.unref?.();
    this.recoveryTimers.set(agentId, timer);
  }

  _normalizeMessage(message) {
    const payload = message.content?.contentObj || message.content || {};
    const contentType = Number(message.contentType || payload.type || 0);
    let content = '';
    if (contentType === 13 && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      let envelope = payload;
      const keys = Object.keys(payload);
      if (typeof payload.content === 'string' && keys.every((key) => key === 'type' || key === 'content')) {
        try {
          const parsed = JSON.parse(payload.content);
          if (parsed && !Array.isArray(parsed) && parsed.version === 'voko.e2ee/2') envelope = parsed;
        } catch {}
      }
      envelope = { ...envelope };
      delete envelope.type;
      content = JSON.stringify(envelope);
    } else if (contentType === ContentType.File) {
      content = JSON.stringify({ name: payload.name || payload.fileName || '', url: payload.url || '', size: payload.size || 0, type: payload.mime || payload.mimeType || payload.fileType || '' });
    } else if (contentType === ContentType.Text) content = payload.content || payload.text || '';
    else if (contentType === ContentType.Image) content = payload.url || '';
    else content = typeof payload === 'string' ? payload : (payload.content || payload.url || JSON.stringify(payload));
    const normalized = {
      fromUid: message.fromUid || message.fromUID,
      toUid: message.toUid || message.toUID,
      channelId: message.channelId || message.channelID,
      channelType: message.channelType || message.channel?.channelType || 1,
      content,
      contentType,
      messageId: message.messageId || message.messageID,
      timestamp: message.timestamp,
      messageSeq: message.messageSeq,
      clientMsgNo: message.clientMsgNo,
      noPersist: message.header?.noPersist ? 1 : 0,
      redDot: message.header?.reddot ? 1 : 0,
      syncOnce: message.header?.syncOnce ? 1 : 0,
      mention: payload.mention || null,
      _voko: payload._voko && Number(payload._voko.protocolVersion) === 1 ? {
        protocolVersion: 1,
        routeId: typeof payload._voko.routeId === 'string' ? payload._voko.routeId : undefined,
        replyToRouteId: typeof payload._voko.replyToRouteId === 'string' ? payload._voko.replyToRouteId : undefined,
        conversationKey: typeof payload._voko.conversationKey === 'string' ? payload._voko.conversationKey : undefined,
        conversationStart: payload._voko.conversationStart === true ? true : undefined,
        conversationDisposition: ['created', 'reused'].includes(payload._voko.conversationDisposition)
          ? payload._voko.conversationDisposition : undefined,
        canonicalConversationKey: typeof payload._voko.canonicalConversationKey === 'string'
          ? payload._voko.canonicalConversationKey : undefined,
        ...(['new_topic', 'automatic_reply', 'explicit_reply'].includes(payload._voko.a2aDisposition)
          ? { a2aDisposition: payload._voko.a2aDisposition } : {}),
        ...(payload._voko.turnReceiptRequest?.version === 1
          ? { turnReceiptRequest: { version: 1 } } : {}),
        ...(payload._voko.turnReceipt?.version === 1
          ? { turnReceipt: payload._voko.turnReceipt } : {}),
      } : null,
    };
    if (typeof message.ack === 'function') normalized.ack = message.ack;
    if (typeof message.nack === 'function') normalized.nack = message.nack;
    return normalized;
  }

  async start(agentId, config) {
    if (this.pool.get(agentId)) return this.getStatus(agentId);
    this.configs.set(agentId, { ...config });
    this.statuses.set(agentId, 'connecting');
    this.emit('worker.status', { agentId, status: 'connecting', statusCode: 2 });
    try {
      await this.pool.add(agentId, config);
      return this.getStatus(agentId);
    } catch (error) {
      this.configs.delete(agentId);
      this.statuses.set(agentId, 'connect_fail');
      this.emit('worker.status', { agentId, status: 'connect_fail', statusCode: 3, error });
      throw error;
    }
  }

  stop(agentId) {
    this._clearRecovery(agentId);
    const removed = this.pool.remove(agentId);
    this.configs.delete(agentId);
    this.statuses.delete(agentId);
    return removed;
  }

  async restart(agentId, config) {
    const next = config || this.configs.get(agentId);
    if (!next) throw new Error(`Unknown Agent: ${agentId}`);
    this.stop(agentId);
    return this.start(agentId, next);
  }

  isRunning(agentId) { return !!this.pool.get(agentId); }
  getStatus(agentId) {
    const client = this.pool.get(agentId);
    return { connected: this.statuses.get(agentId) === 'connected', uid: client?.options?.uid || this.configs.get(agentId)?.uid || null, status: this.statuses.get(agentId) || 'unknown' };
  }

  async deliver(agentId, channelId, content, messageType = 'text', channelType = ChannelType.Person, mentions = null, localMsgId, metadata = null) {
    const options = { mention: mentions || undefined, clientMsgNo: localMsgId || undefined, _voko: metadata?._voko || undefined };
    try {
      let result;
      if (messageType === 'image') result = await this.pool.sendImage(agentId, channelId, channelType, content, options);
      else if (messageType === 'file') {
        let file;
        try { file = typeof content === 'string' ? JSON.parse(content) : content; }
        catch { file = { url: String(content || '') }; }
        result = await this.pool.sendFile(agentId, channelId, channelType, file, options);
      } else result = await this.pool.sendText(agentId, channelId, channelType, String(content || ''), options);
      return { success: true, messageId: result.messageId, messageSeq: result.messageSeq, clientMsgNo: result.clientMsgNo };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: error?.code, retryable: error?.retryable, outcomeUnknown: error?.outcomeUnknown, reasonCode: error?.reasonCode, messageId: localMsgId };
    }
  }

  send(agentId, request) {
    return this.deliver(agentId, request.channelId, request.content, request.messageType, request.channelType, request.mentions, request.localMsgId, request.metadata);
  }

  async deliverEncrypted(agentId, channelId, envelope, localMsgId) {
    try {
      const parsedEnvelope = JSON.parse(String(envelope || ''))
      if (!parsedEnvelope || parsedEnvelope.version !== 'voko.e2ee/2') {
        throw new Error('E2EE_REPLY_ENVELOPE_INVALID')
      }
      const result = await this.pool.sendRaw(agentId, channelId, ChannelType.Person,
        encodeContent(13, parsedEnvelope), { clientMsgNo: localMsgId || undefined });
      return { success: true, messageId: result.messageId, messageSeq: result.messageSeq, clientMsgNo: result.clientMsgNo };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error),
        code: error?.code, outcomeUnknown: error?.outcomeUnknown };
    }
  }

  disconnectAll() {
    this.pool.disconnectAll();
    this.configs.clear();
    this.statuses.clear();
  }
}

module.exports = { VokoWorkerAdapter, ContentType };
