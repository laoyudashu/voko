'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { generateKeyPair, sharedKey } = require('curve25519-js');
const { Md5 } = require('md5-typescript');
const { BinaryProtocol, PacketType } = require('./protocol');
const { CryptoContext } = require('./crypto-context');
const { ContentType, encodeContent, decodeContent } = require('./messages');
const { VokoIMError, VokoIMSendError, VokoIMProtocolError } = require('./errors');

const ConnectionState = Object.freeze({
  Idle: 'idle', Connecting: 'connecting', Connected: 'connected',
  Reconnecting: 'reconnecting', Disconnected: 'disconnected', Failed: 'failed',
});

class VokoIMClient extends EventEmitter {
  constructor(options) {
    super();
    if (!options?.uid || !options?.token || !options?.serverUrl) throw new Error('uid, token and serverUrl are required');
    this.options = {
      protocolVersion: 5, deviceFlag: 1, heartbeatInterval: 60_000,
      heartbeatTimeout: 15_000, connectTimeout: 10_000, autoReconnect: true,
      reconnectMinDelay: 1_000, reconnectMaxDelay: 30_000, reconnectJitter: 0.2,
      maxReconnectAttempts: Infinity, maxPacketBytes: 25 * 1024 * 1024,
      maxBufferedBytes: 30 * 1024 * 1024, maxOutgoingBufferedBytes: 5 * 1024 * 1024,
      maxPendingSends: 1_000, maxReceivedIds: 10_000, ackMode: 'auto',
      maxPendingReceives: 1_000, manualAckTimeout: 30_000, maxPoisonAttempts: 3, maxPoisonIds: 1_000, poisonMessagePolicy: 'quarantine',
      maxProtocolErrors: 3, ...options,
    };
    this.cryptoContext = new CryptoContext();
    this.protocol = new BinaryProtocol(this.cryptoContext);
    this.state = ConnectionState.Idle;
    this.ws = null;
    this.buffer = Buffer.alloc(0);
    this.socketGeneration = 0;
    this.privateKey = null;
    this.crypto = { aesKey: null, aesIV: null };
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.manualClose = false;
    this.connectPromise = null;
    this.stats = { connects: 0, disconnects: 0, reconnects: 0, pings: 0, pongs: 0, packets: 0, errors: 0, protocolErrors: 0, backpressureRejects: 0, quarantined: 0 };
    this.clientSeq = 0;
    this.pendingSends = new Map();
    this.pendingReceives = new Map();
    this.receivedIds = new Set();
    this.poisonAttempts = new Map();
    this.consecutiveProtocolErrors = 0;
  }

  connect() {
    if (this.state === ConnectionState.Connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.manualClose = false;
    this.connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._open();
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  _open() {
    clearTimeout(this.connectTimeoutTimer);
    this._setState(this.reconnectAttempt ? ConnectionState.Reconnecting : ConnectionState.Connecting);
    this.buffer = Buffer.alloc(0);
    const generation = ++this.socketGeneration;
    const ws = this.options.webSocketFactory ? this.options.webSocketFactory(this.options.serverUrl) : new WebSocket(this.options.serverUrl);
    this.ws = ws;
    const timeout = setTimeout(() => { if (this._isCurrentSocket(ws, generation)) this._failConnect(new Error('Connection authentication timeout')); }, this.options.connectTimeout);
    this.connectTimeoutTimer = timeout;
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => { if (!this._isCurrentSocket(ws, generation)) return; this.emit('diagnostic', 'socket-open'); this._authenticate(); });
    ws.on('message', (data) => { if (this._isCurrentSocket(ws, generation)) this._receive(data); });
    ws.once('error', (error) => { if (this._isCurrentSocket(ws, generation)) this._onError(error); });
    ws.once('close', (code, reason) => { if (this._isCurrentSocket(ws, generation)) this._onClose(code, reason.toString(), ws, generation); });
  }

  _isCurrentSocket(ws, generation) { return this.ws === ws && this.socketGeneration === generation; }

  _authenticate() {
    const seed = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
    const keyPair = generateKeyPair(Uint8Array.from(seed));
    this.privateKey = keyPair.private;
    const packet = {
      type: PacketType.CONNECT,
      clientKey: Buffer.from(keyPair.public).toString('base64'),
      version: this.options.protocolVersion,
      deviceFlag: this.options.deviceFlag,
      deviceId: `${this.options.deviceId || randomUUID().replaceAll('-', '')}V`,
      clientTimestamp: Date.now(), uid: this.options.uid, token: this.options.token,
    };
    this._sendPacket(packet);
    this.emit('diagnostic', 'connect-packet-sent');
  }

  _receive(chunk) {
    const bytes = Buffer.from(chunk);
    if (this.buffer.length + bytes.length > this.options.maxBufferedBytes) return this._protocolFailure(new VokoIMProtocolError('Receive buffer limit exceeded', { code: 'BUFFER_LIMIT' }));
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    while (this.buffer.length) {
      const size = this._packetSize(this.buffer);
      if (size === null || this.buffer.length < size) return;
      const packetBytes = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      try {
        const packet = this.protocol.decode(packetBytes);
        this.emit('diagnostic', `packet-${packet.type}`);
        this.stats.packets += 1;
        this._handlePacket(packet);
        this.consecutiveProtocolErrors = 0;
      } catch (error) {
        if (this._connectReject) this._failConnect(error);
        else {
          this._protocolFailure(error);
        }
        return;
      }
    }
  }

  _packetSize(data) {
    if (!data.length) return null;
    if ([PacketType.PING, PacketType.PONG].includes(data[0] >> 4)) return 1;
    let multiplier = 1;
    let remaining = 0;
    let position = 1;
    let digit;
    do {
      if (position >= data.length) return null;
      digit = data[position++];
      remaining += (digit & 127) * multiplier;
      multiplier *= 128;
      if (multiplier > 128 ** 4) throw new Error('Malformed remaining length');
    } while (digit & 128);
    const size = position + remaining;
    if (size > this.options.maxPacketBytes) throw new VokoIMProtocolError(`Packet exceeds ${this.options.maxPacketBytes} bytes`, { code: 'PACKET_TOO_LARGE', packetBytes: size });
    return size;
  }

  _protocolFailure(error) {
    this.consecutiveProtocolErrors += 1;
    this.stats.protocolErrors += 1;
    this._onError(error instanceof Error ? error : new VokoIMProtocolError(String(error)));
    if (this.consecutiveProtocolErrors >= this.options.maxProtocolErrors) this.manualClose = true;
    this.ws?.close(1002, 'Protocol error');
  }

  _handlePacket(packet) {
    if (packet.type === PacketType.CONNACK) return this._handleConnack(packet);
    if (packet.type === PacketType.PONG) {
      this.stats.pongs += 1;
      clearTimeout(this.pongTimer);
      this.emit('pong');
      return;
    }
    if (packet.type === PacketType.PING) { this._sendPacket({ type: PacketType.PONG }); return; }
    if (packet.type === PacketType.DISCONNECT) {
      this.manualClose = true;
      this.emit('kicked', packet);
      this.ws?.close();
      return;
    }
    if (packet.type === PacketType.SENDACK) return this._handleSendack(packet);
    if (packet.type === PacketType.RECV) return this._handleRecv(packet);
    if (packet.type === PacketType.EVENT) { this.emit('event', { id: packet.id, eventType: packet.eventType, timestamp: packet.timestamp, data: packet.data }); return; }
    this.emit('packet', packet);
  }

  _handleConnack(packet) {
    this.emit('diagnostic', `connack-${packet.reasonCode}`);
    clearTimeout(this.connectTimeoutTimer);
    if (packet.reasonCode !== 1) {
      return this._failConnect(new VokoIMError(`Authentication failed, reasonCode=${packet.reasonCode}`, 'AUTH_FAILED', { reasonCode: packet.reasonCode, retryable: false }));
    }
    const serverKey = Uint8Array.from(Buffer.from(packet.serverKey, 'base64'));
    const secret = sharedKey(this.privateKey, serverKey);
    const key = Md5.init(Buffer.from(secret).toString('base64'));
    this.crypto = { aesKey: key.slice(0, 16), aesIV: (packet.salt || '').slice(0, 16) };
    this.cryptoContext.configure(this.crypto.aesKey, this.crypto.aesIV);
    this.reconnectAttempt = 0;
    this.stats.connects += 1;
    this._setState(ConnectionState.Connected);
    this._startHeartbeat();
    this._connectResolve?.();
    this._connectResolve = null;
    this._connectReject = null;
    this.emit('connect', { nodeId: packet.nodeId?.toString(), serverVersion: packet.serverVersion });
  }

  _startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== ConnectionState.Connected) return;
      try { this._sendPacket({ type: PacketType.PING }); }
      catch (error) { this._onError(error); this.ws?.terminate(); return; }
      this.stats.pings += 1;
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this._onError(new Error('Heartbeat timeout'));
        this.ws?.terminate();
      }, this.options.heartbeatTimeout);
    }, this.options.heartbeatInterval);
  }

  _sendPacket(packet) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    const encoded = this.protocol.encode(packet);
    if (encoded.length > this.options.maxPacketBytes) throw new VokoIMProtocolError(`Outgoing packet exceeds ${this.options.maxPacketBytes} bytes`, { code: 'PACKET_TOO_LARGE', packetBytes: encoded.length });
    if ((this.ws.bufferedAmount || 0) + encoded.length > this.options.maxOutgoingBufferedBytes) {
      this.stats.backpressureRejects += 1;
      throw new VokoIMSendError('WebSocket send buffer limit exceeded', { code: 'BACKPRESSURE', retryable: true, bufferedAmount: this.ws.bufferedAmount || 0 });
    }
    this.ws.send(encoded);
  }

  _handleSendack(packet) {
    const pending = this.pendingSends.get(packet.clientSeq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSends.delete(packet.clientSeq);
    const result = { messageId: packet.messageId.toString(), messageSeq: packet.messageSeq, clientSeq: packet.clientSeq, clientMsgNo: pending.clientMsgNo, reasonCode: packet.reasonCode };
    if (packet.reasonCode === 1) pending.resolve(result);
    else pending.reject(new VokoIMSendError(`Send failed, reasonCode=${packet.reasonCode}`, { reasonCode: packet.reasonCode, clientMsgNo: pending.clientMsgNo, channelId: pending.channelId, retryable: false }));
    this.emit('sent', result);
  }

  _handleRecv(packet) {
    const messageId = packet.messageId.toString();
    if (this.receivedIds.has(messageId)) { this._sendRecvAck(packet); return; }
    if (this.pendingReceives.has(messageId)) return;
    if (this.pendingReceives.size >= this.options.maxPendingReceives) {
      this._protocolFailure(new VokoIMProtocolError('Pending receive limit exceeded', { code: 'RECEIVE_BACKPRESSURE' }));
      return;
    }
    let payload;
    let content;
    try {
      const encryptedText = Buffer.from(packet.encryptedPayload).toString('utf8');
      const verify = `${packet.messageId}${packet.messageSeq}${packet.clientMsgNo}${packet.timestamp}${packet.fromUid || ''}${packet.channelId || ''}${packet.channelType}${encryptedText}`;
      const actualKey = Md5.init(this.cryptoContext.encryptString(verify));
      if (actualKey !== packet.msgKey) throw new VokoIMProtocolError(`Invalid message key for message ${messageId}`, { code: 'INVALID_MSG_KEY', messageId });
      payload = this.cryptoContext.decryptBytes(packet.encryptedPayload);
      content = decodeContent(payload);
    } catch (error) { this._handlePoison(packet, error); return; }

    const ack = () => this.ackMessage(messageId);
    const nack = (error) => this.nackMessage(messageId, error);
    const timer = this.options.ackMode === 'manual' ? setTimeout(() => {
      this.emit('ackTimeout', { messageId, messageSeq: packet.messageSeq });
    }, this.options.manualAckTimeout) : null;
    this.pendingReceives.set(messageId, { packet, timer });
    const message = {
      ...packet, messageId, messageID: messageId, fromUID: packet.fromUid, toUID: this.options.uid,
      channelID: packet.channelId, channel: { channelID: packet.channelId, channelType: packet.channelType },
      contentType: content.type || 0, header: { noPersist: packet.noPersist, reddot: packet.reddot, syncOnce: packet.syncOnce },
      payload, content: { ...content, contentObj: content }, ack, nack,
    };
    this.emit('message', message);
    if (this.options.ackMode !== 'manual') ack();
  }

  _sendRecvAck(packet) {
    this._sendPacket({ type: PacketType.RECVACK, messageId: packet.messageId, messageSeq: packet.messageSeq, noPersist: packet.noPersist, syncOnce: packet.syncOnce, reddot: packet.reddot });
  }

  ackMessage(messageId) {
    const key = String(messageId);
    const pending = this.pendingReceives.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._sendRecvAck(pending.packet);
    this.pendingReceives.delete(key);
    this.receivedIds.add(key);
    if (this.receivedIds.size > this.options.maxReceivedIds) this.receivedIds.delete(this.receivedIds.values().next().value);
    return true;
  }

  nackMessage(messageId, error) {
    const key = String(messageId);
    const pending = this.pendingReceives.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingReceives.delete(key);
    this._onError(error instanceof Error ? error : new Error(error || `Message ${key} was not persisted`));
    this.ws?.close(1011, 'Message persistence failed');
    return true;
  }

  _handlePoison(packet, error) {
    const messageId = packet.messageId.toString();
    const attempts = (this.poisonAttempts.get(messageId) || 0) + 1;
    this.poisonAttempts.set(messageId, attempts);
    if (this.poisonAttempts.size > this.options.maxPoisonIds) this.poisonAttempts.delete(this.poisonAttempts.keys().next().value);
    this._onError(error);
    if (attempts >= this.options.maxPoisonAttempts && this.options.poisonMessagePolicy === 'quarantine') {
      this.stats.quarantined += 1;
      this.poisonAttempts.delete(messageId);
      this._sendRecvAck(packet);
      this.receivedIds.add(messageId);
      this.emit('quarantined', { messageId, messageSeq: packet.messageSeq, attempts, code: error.code || 'INVALID_MESSAGE' });
      return;
    }
    this.ws?.close(1002, 'Invalid message');
  }

  sendRaw(channelId, channelType, payload, options = {}) {
    if (this.state !== ConnectionState.Connected) return Promise.reject(new VokoIMSendError('Client is not connected', { code: 'NOT_CONNECTED', retryable: true }));
    if (!channelId || !Number.isInteger(channelType)) return Promise.reject(new VokoIMSendError('channelId and integer channelType are required', { code: 'INVALID_ARGUMENT', retryable: false }));
    if (!(payload instanceof Uint8Array) && !Buffer.isBuffer(payload)) return Promise.reject(new VokoIMSendError('payload must be bytes', { code: 'INVALID_ARGUMENT', retryable: false }));
    if (payload.length > this.options.maxPacketBytes) return Promise.reject(new VokoIMSendError('Payload is too large', { code: 'PACKET_TOO_LARGE', retryable: false }));
    if (this.pendingSends.size >= this.options.maxPendingSends) {
      this.stats.backpressureRejects += 1;
      return Promise.reject(new VokoIMSendError('Pending send limit exceeded', { code: 'BACKPRESSURE', retryable: true }));
    }
    let clientSeq;
    do { this.clientSeq = this.clientSeq >= 0x7fffffff ? 1 : this.clientSeq + 1; clientSeq = this.clientSeq; } while (this.pendingSends.has(clientSeq));
    const clientMsgNo = options.clientMsgNo || `${randomUUID().replaceAll('-', '')}_${options.deviceId || 0}_3`;
    const packet = {
      type: PacketType.SEND, setting: options.setting || 0, reddot: options.reddot !== false,
      noPersist: !!options.noPersist, clientSeq, clientMsgNo, channelId, channelType,
      expire: options.expire || 0, topic: options.topic, payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingSends.delete(clientSeq); reject(new VokoIMSendError(`Send ACK timeout, clientSeq=${clientSeq}`, { code: 'SEND_ACK_TIMEOUT', retryable: true, outcomeUnknown: true, clientMsgNo, channelId })); }, options.timeout || 15_000);
      this.pendingSends.set(clientSeq, { resolve, reject, timer, clientMsgNo, channelId });
      try { this._sendPacket(packet); } catch (error) { clearTimeout(timer); this.pendingSends.delete(clientSeq); reject(error); }
    });
  }

  sendText(channelId, channelType, text, options = {}) {
    return this.sendRaw(channelId, channelType, encodeContent(ContentType.Text, { content: text || '' }, options.mention), options);
  }

  sendImage(channelId, channelType, image, options = {}) {
    const value = typeof image === 'string' ? { url: image } : image;
    return this.sendRaw(channelId, channelType, encodeContent(ContentType.Image, { url: value.url || '', width: value.width || 0, height: value.height || 0 }, options.mention), options);
  }

  sendFile(channelId, channelType, file, options = {}) {
    return this.sendRaw(channelId, channelType, encodeContent(ContentType.File, { url: file.url || '', name: file.name || '', size: file.size || 0, mime: file.type || file.mime || '' }, options.mention), options);
  }

  _failConnect(error) {
    clearTimeout(this.connectTimeoutTimer);
    this._connectReject?.(error);
    this._connectResolve = null;
    this._connectReject = null;
    this._onError(error);
    this.manualClose = true;
    this.ws?.close();
  }

  _onError(error) {
    this.stats.errors += 1;
    this.emit('error', error instanceof Error ? error : new Error(String(error)));
  }

  _onClose(code, reason) {
    clearTimeout(this.connectTimeoutTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongTimer);
    this.ws = null;
    this.stats.disconnects += 1;
    this._setState(ConnectionState.Disconnected);
    this.emit('disconnect', { code, reason });
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VokoIMSendError(`Connection closed before SENDACK, code=${code}`, { code: 'CONNECTION_CLOSED', retryable: true, outcomeUnknown: true, clientMsgNo: pending.clientMsgNo, channelId: pending.channelId }));
    }
    this.pendingSends.clear();
    for (const pending of this.pendingReceives.values()) clearTimeout(pending.timer);
    this.pendingReceives.clear();
    if (this._connectReject) {
      const reject = this._connectReject;
      this._connectResolve = null;
      this._connectReject = null;
      this.manualClose = true;
      reject(new Error(`Connection closed before authentication, code=${code}`));
      return;
    }
    if (!this.manualClose && this.options.autoReconnect) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > this.options.maxReconnectAttempts) {
      this.manualClose = true;
      this._setState(ConnectionState.Failed);
      this.emit('reconnectExhausted', { attempts: this.reconnectAttempt - 1 });
      return;
    }
    this.stats.reconnects += 1;
    const base = Math.min(this.options.reconnectMinDelay * (2 ** (this.reconnectAttempt - 1)), this.options.reconnectMaxDelay);
    const jitter = Math.max(0, Math.min(1, this.options.reconnectJitter));
    const delay = Math.max(0, Math.round(base * (1 - jitter + Math.random() * jitter * 2)));
    this.reconnectTimer = setTimeout(() => this._open(), delay);
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delay });
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.connectTimeoutTimer);
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
    for (const pending of this.pendingSends.values()) { clearTimeout(pending.timer); pending.reject(new VokoIMSendError('Client disconnected', { code: 'DISCONNECTED', retryable: true, outcomeUnknown: true, clientMsgNo: pending.clientMsgNo, channelId: pending.channelId })); }
    this.pendingSends.clear();
    for (const pending of this.pendingReceives.values()) clearTimeout(pending.timer);
    this.pendingReceives.clear();
    this.poisonAttempts.clear();
    this.receivedIds.clear();
    this._setState(ConnectionState.Disconnected);
  }
}

module.exports = { VokoIMClient, ConnectionState };
