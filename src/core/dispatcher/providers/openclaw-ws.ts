const WebSocket = require('ws');
const { getPublicKeyAsync, signAsync, utils } = require('@noble/ed25519');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bus = require('../../lite-bus');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
import type { AgentMeta, PushPayload } from '../types';

type ProtocolMessage = Record<string, any>; // OpenClaw gateway 的动态 JSON 协议边界
type EventHandler = (message?: any) => void;
const LEGACY_FINAL_SETTLE_MS = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectWindowsOpenclawCommand(
  whereOutput: string,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): { cmd: string; shell: boolean } | null {
  const candidates = String(whereOutput || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate))
    || candidates.find((candidate) => /\.exe$/i.test(candidate));
  if (preferred) {
    return { cmd: preferred, shell: /\.(cmd|bat)$/i.test(preferred) };
  }
  const first = candidates[0];
  if (!first) return null;
  if (!path.extname(first) && existsSync(first + '.cmd')) {
    return { cmd: first + '.cmd', shell: true };
  }
  return { cmd: first, shell: false };
}

/**
 * OpenClaw WebSocket 处理器
 * 使用 WebSocket + Ed25519 设备认证与 OpenClaw Gateway 通信
 *
 * 特性：
 * - 自动检测配置文件变化，动态更新 token
 * - 连接断开后自动重连
 * - 消息队列，离线时缓存消息
 * - 连接状态监控
 */
class OpenClawWsProvider {
  [key: string]: any;

  constructor(database: unknown, mainWindow: unknown) {
    this.db = database;
    this._bindingStore = database && typeof (database as any).exec === 'function'
      ? new ProviderConversationBindingStore(database as any)
      : null;
    this.mainWindow = mainWindow;
    this._availabilityGeneration = 0;

    // Gateway 配置
    this.gatewayUrl = 'ws://127.0.0.1:18789';
    this.authToken = null;
    this.gatewayPort = 18789;

    // 状态控制
    this.enabled = false;
    this.processingChannels = new Set();

    // WebSocket 连接
    this.ws = null;
    this.sessionId = null;
    this._protocolVer = 4; // 默认 v4（老网关）；网关 mismatch 时降级 v3（OpenClaw 2026.3.x）
    this._gatewayMethods = [];
    this._gatewayEvents = [];
    this._replyProtocol = null; // 'chat' | 'session.message'；无能力声明时保持兼容探测
    this.device = null;
    this.connected = false;
    this.connecting = false;

    // 消息队列（离线时缓存）
    this.messageQueue = [];
    this.maxQueueSize = 100;

    // Gateway 启动互斥锁（防止重复启动）
    this._gatewayStarting = false;

    // 重连配置
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000; // 初始重连延迟 2 秒
    this.maxReconnectDelay = 30000; // 最大重连延迟 30 秒
    this.reconnectTimer = null;

    // 日志缓冲区
    this.logs = [];
    this.maxLogSize = 200;

    // 配置文件监控
    this.configPath = path.join(
      os.homedir(),
      '.openclaw',
      'openclaw.json'
    );
    this.configWatcher = null;
    this.lastConfigMtime = 0;

    // 当前回复处理（按 visitorId 隔离）
    this.pendingReplies = new Map();  // {visitorId: {currentReply, replyResolve, timeout}}

    // 事件监听器
    this.eventListeners = new Map();  // {eventName: [handler]}

    // 订阅状态追踪
    this.subscribedSessions = new Set();  // 已成功订阅的 session key
    this.pendingSubscriptions = new Map();  // 待确认的订阅请求 {sessionKey: {timestamp, id}}
    this._sessionSendChains = new Map(); // sessionKey -> 顺序发送链，订阅中的同 session 消息共享结果
    this._caseMap = new Map();  // gateway 转小写后的 key → 原始大小写 key
    this._processedMsgs = new Map();  // 已处理 final 消息去重 key → timestamp
    this._chatFinalSessions = new Map();  // 新版 chat final 到达时间，抑制同轮旧版事件
    this._legacyReplyTimers = new Map();  // 旧版 final 短暂延迟，优先采用新版完整回复
    this._sessionTurns = new Map();  // sessionKey → 当前入站 turn 身份
    this._vokoAgentBySession = new Map(); // OpenClaw 实例 session → VOKO agentId

    // 初始化
    this.loadConfig();
    this.startConfigWatcher();
  }

  /**
   * 加载 OpenClaw 配置文件
   */
  loadConfig(): boolean {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.lastConfigMtime = fs.statSync(this.configPath).mtimeMs;

        const newPort = config.gateway?.port || 18789;
        const newToken = config.gateway?.auth?.token || null;
        const newUrl = `ws://127.0.0.1:${newPort}`;

        // 检测配置变化
        const portChanged = this.gatewayPort !== newPort;
        const tokenChanged = this.authToken !== newToken;
        const urlChanged = this.gatewayUrl !== newUrl;

        if (portChanged || tokenChanged || urlChanged) {
          console.log('[OpenClaw WS] 配置更新:');
          if (portChanged) console.log(`  - Port: ${this.gatewayPort} → ${newPort}`);
          if (tokenChanged) console.log(`  - Token: ${this.authToken ? '已设置' : '未设置'} → ${newToken ? '已设置' : '未设置'}`);
          if (urlChanged) console.log(`  - URL: ${this.gatewayUrl} → ${newUrl}`);

          this.gatewayPort = newPort;
          this.authToken = newToken;
          this.gatewayUrl = newUrl;

          // 如果已连接，需要重新连接以应用新配置
          if (this.connected || this.connecting) {
            console.log('[OpenClaw WS] 配置变化，触发重新连接...');
            this.disconnect();
            this._ensureGatewayRunning().catch((err: unknown) => {
              console.error('[OpenClaw WS] 配置变化后启动 Gateway 失败:', errorMessage(err));
            });
            this.scheduleReconnect(100); // 100ms 后重连
          }
        } else {
          console.log('[OpenClaw WS] 配置检查完成，无变化');
        }

        return true;
      } else {
        console.warn('[OpenClaw WS] 配置文件不存在:', this.configPath);
        return false;
      }
    } catch (err) {
      console.error('[OpenClaw WS] 加载配置失败:', errorMessage(err));
      return false;
    }
  }

  /**
   * 启动配置文件监控（使用轮询方式，更可靠）
   */
  startConfigWatcher(): void {
    // 每 5 秒检查一次配置文件变化
    this.configWatcher = setInterval(() => {
      try {
        if (fs.existsSync(this.configPath)) {
          const stats = fs.statSync(this.configPath);
          if (stats.mtimeMs > this.lastConfigMtime) {
            console.log('[OpenClaw WS] 检测到配置文件变化，重新加载...');
            this.loadConfig();
          }
        }
      } catch (err) {
        console.error('[OpenClaw WS] 检查配置失败:', errorMessage(err));
      }
    }, 5000);

    console.log('[OpenClaw WS] 配置文件监控已启动');
  }

  /**
   * 停止配置文件监控
   */
  stopConfigWatcher(): void {
    if (this.configWatcher) {
      clearInterval(this.configWatcher);
      this.configWatcher = null;
      console.log('[OpenClaw WS] 配置文件监控已停止');
    }
  }

  /**
   * 设置启用/禁用状态
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log('[OpenClaw WS] 自动回复:', enabled ? '已启用' : '已禁用');

    if (enabled) {
      if (!this.connected && !this.connecting) {
        this.connect();
      }
    } else {
      this.disconnect();
    }
  }

  /**
   * 获取连接状态
   */
  getStatus() {
    return {
      connected: this.connected,
      connecting: this.connecting,
      enabled: this.enabled,
      queueSize: this.messageQueue.length,
      gatewayUrl: this.gatewayUrl,
      authToken: this.authToken,
      reconnectAttempts: this.reconnectAttempts,
      deviceId: this.device?.deviceId || null,
      devicePublicKey: this.device?.publicKey || null,
      gatewayPort: this.gatewayPort,
      sessionId: this.sessionId,
      subscribedSessions: Array.from(this.subscribedSessions || []),
      pendingSubscriptions: Array.from(this.pendingSubscriptions?.keys() || []),
      maxReconnectAttempts: this.maxReconnectAttempts,
      reconnectDelay: this.reconnectDelay,
      maxReconnectDelay: this.maxReconnectDelay,
      logs: this.logs.slice(),
      hasToken: !!this.authToken
    };
  }

  _supportsSessionSubscribe(): boolean {
    // features 为空（老网关未上报 capabilities）→ 默认支持 subscribe；
    // features 非空 → 看是否含该 method（OpenClaw 2026.3.x 无 subscribe API，走直连 chat.send）
    if (!this._gatewayMethods.length) return true;
    return this._gatewayMethods.includes('sessions.messages.subscribe');
  }

  _sessionDefaultsFromHello(payload: ProtocolMessage): ProtocolMessage | null {
    return payload?.sessionDefaults || payload?.snapshot?.sessionDefaults || null;
  }

  _extractAssistantText(rawContent: unknown): string {
    let text = '';
    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (item.type === 'text' && item.text) text += item.text;
      }
    } else if (typeof rawContent === 'string') {
      text = rawContent;
    }
    return text;
  }

  _resolveSessionKey(sessionKey: string): string {
    if (!sessionKey) return sessionKey;
    const lower = sessionKey.toLowerCase();
    return this._caseMap.get(lower) || sessionKey;
  }

  _parseAgentSessionKey(sessionKey: string): { agentId: string | null; visitorId: string | null } {
    const agentMatch = sessionKey.match(/^agent:([^:]+):(.+)$/);
    if (!agentMatch) return { agentId: null, visitorId: null };
    return {
      agentId: this._vokoAgentBySession.get(sessionKey.toLowerCase()) || agentMatch[1],
      visitorId: agentMatch[2],
    };
  }

  _replyIdentity(msg: ProtocolMessage, sessionKey: string): { turnId?: string; replyId?: string } {
    const payload = msg?.payload || {};
    const innerMsg = payload.message || {};
    const resolvedKey = this._resolveSessionKey(sessionKey);
    const tracked = this._sessionTurns.get(resolvedKey.toLowerCase());
    // 优先使用发送侧绑定的原始入站 messageId；后端 runId 可能因工具调用分段而变化。
    const turnId = tracked?.turnId || payload.turnId || payload.runId || payload.requestId;
    const replyId = innerMsg.id || innerMsg.messageId || payload.replyId || payload.messageId || payload.runId || turnId;
    return {
      ...(turnId ? { turnId: String(turnId) } : {}),
      ...(replyId ? { replyId: String(replyId) } : {}),
    };
  }

  _emitAgentReplyFromSession(
    sessionKey: string,
    text: string,
    identity: { turnId?: string; replyId?: string } = {},
  ): void {
    const resolvedKey = this._resolveSessionKey(sessionKey);
    const { agentId, visitorId } = this._parseAgentSessionKey(resolvedKey);
    if (!text.trim()) return;
    const dedupKey = (resolvedKey || '') + ':' + text.substring(0, 100);
    const lastTime = this._processedMsgs.get(dedupKey);
    if (lastTime && Date.now() - lastTime < 30000) return;
    this._processedMsgs.set(dedupKey, Date.now());
    console.log(`[OpenClaw WS] ✅ 收到完整回复 visitorId=${visitorId}`);
    this.emit('agent.reply', { agentId, visitorId, content: text, sessionKey: resolvedKey, ...identity });
  }

  _isSameLogicalReply(first: string, second: string): boolean {
    const a = first.trim();
    const b = second.trim();
    if (!a || !b) return false;
    if (a === b) return true;
    return Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a));
  }

  _handleChatEvent(msg: ProtocolMessage): void {
    const payload = msg.payload || {};
    if (payload.state !== 'final') return;
    const innerMsg = payload.message;
    if (!innerMsg || innerMsg.role !== 'assistant') return;
    const sessionKey = this._resolveSessionKey(payload.sessionKey || '');
    const text = this._extractAssistantText(innerMsg.content || []);
    const identity = this._replyIdentity(msg, sessionKey);
    const legacyReply = this._legacyReplyTimers.get(sessionKey);
    if (legacyReply && this._isSameLogicalReply(legacyReply.text, text)) {
      clearTimeout(legacyReply.timer);
      this._legacyReplyTimers.delete(sessionKey);
    }
    this._chatFinalSessions.set(sessionKey, { text, timestamp: Date.now() });
    this._emitAgentReplyFromSession(sessionKey, text, identity);
  }

  _scheduleLegacyAgentReply(
    sessionKey: string,
    text: string,
    identity: { turnId?: string; replyId?: string } = {},
  ): void {
    const resolvedKey = this._resolveSessionKey(sessionKey);
    const chatFinal = this._chatFinalSessions.get(resolvedKey);
    if (chatFinal
      && Date.now() - chatFinal.timestamp < 30000
      && this._isSameLogicalReply(chatFinal.text, text)) return;

    const previousReply = this._legacyReplyTimers.get(resolvedKey);
    if (previousReply) clearTimeout(previousReply.timer);
    const timer = setTimeout(() => {
      this._legacyReplyTimers.delete(resolvedKey);
      const latestChatFinal = this._chatFinalSessions.get(resolvedKey);
      if (latestChatFinal
        && Date.now() - latestChatFinal.timestamp < 30000
        && this._isSameLogicalReply(latestChatFinal.text, text)) return;
      this._emitAgentReplyFromSession(resolvedKey, text, identity);
    }, LEGACY_FINAL_SETTLE_MS);
    this._legacyReplyTimers.set(resolvedKey, { timer, text, identity });
  }

  /**
   * 根据平台解析 openclaw 命令，返回 { cmd, args, shell }
   * Windows: 直接找 node.exe + openclaw.mjs 入口文件，绕过 .cmd 避免弹窗
   * macOS/Linux: which 查找 openclaw 可执行文件
   */
  _resolveOpenclawCmd(): { cmd: string; args: string[]; shell: boolean } {
    if (process.platform === 'win32') {
      // Windows: 直接用 node + openclaw.mjs 入口运行，绕过 .cmd 文件的 title %COMSPEC% 弹窗
      const npmDir = path.join(process.env.APPDATA || '', 'npm');
      const entryPoint = path.join(npmDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      if (require('fs').existsSync(entryPoint)) {
        const nodePath = path.join(npmDir, 'node.exe');
        if (require('fs').existsSync(nodePath)) {
          return { cmd: nodePath, args: [entryPoint, 'gateway', 'run', '--force'], shell: false };
        }
        // npm 目录下没有 node.exe，用系统 PATH 中的 node
        return { cmd: 'node', args: [entryPoint, 'gateway', 'run', '--force'], shell: false };
      }
      // 兜底：走 .cmd 文件
      const cmdPath = path.join(npmDir, 'openclaw.cmd');
      if (require('fs').existsSync(cmdPath)) return { cmd: cmdPath, args: ['gateway', 'run', '--force'], shell: true };
      try {
        const result = require('child_process').execSync('where openclaw', { encoding: 'utf8', timeout: 5000, shell: true, windowsHide: true });
        const resolved = selectWindowsOpenclawCommand(result);
        if (resolved) return { ...resolved, args: ['gateway', 'run', '--force'] };
      } catch {}
    } else {
      // macOS/Linux
      try {
        const result = require('child_process').execSync('which openclaw', { encoding: 'utf8', timeout: 5000 });
        if (result.trim()) return { cmd: result.trim(), args: ['gateway', 'run', '--force'], shell: false };
      } catch {}
    }
    // 终极兜底
    const isWin = process.platform === 'win32';
    return { cmd: isWin ? 'openclaw.cmd' : 'openclaw', args: ['gateway', 'run', '--force'], shell: isWin };
  }

  /**
   * 检测并确保 OpenClaw Gateway 正在运行
   * 如果 gateway 未运行，自动尝试启动
   * @returns {Promise<boolean>} gateway 是否已就绪
   */
  async _ensureGatewayRunning(): Promise<boolean> {
    const { spawn, execFileSync } = require('child_process');

    // 已连上就不需要操作
    if (this.connected) return true;
    // 已经在启动中，防止重复启动
    if (this._gatewayStarting) return false;
    this._gatewayStarting = true;

    try {
      // 先检查 gateway 是否已在运行
      try {
        const http = require('http');
        await new Promise<boolean>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${this.gatewayPort}/health`, (res: import('http').IncomingMessage) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', reject);
          req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        console.log(`[OpenClaw WS] Gateway 已在运行 (port=${this.gatewayPort})`);
        return true;
      } catch {
        console.log(`[OpenClaw WS] Gateway 未运行，尝试启动 (port=${this.gatewayPort})...`);
      }

      // 启动 gateway 进程
      const started = await new Promise<boolean>((resolve) => {
        const { cmd, args, shell } = this._resolveOpenclawCmd();
        let child;
        try {
          child = spawn(cmd, args, {
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
            shell,
            // Windows: 直接 spawn node 时不创建控制台窗口
            ...(process.platform === 'win32' && !shell ? { creationFlags: 0x08000000 } : {}),
          });
          child.unref();
          this._gatewayChild = child;  // 记录，供 stop() 清理，避免 detached gateway 泄漏
          child.on('error', (err: Error) => {
            console.error('[OpenClaw WS] 无法启动 openclaw 进程:', err.message);
            resolve(false);
          });
        } catch (err) {
          console.error('[OpenClaw WS] 无法启动 openclaw 进程:', errorMessage(err));
          resolve(false);
          return;
        }

        // 等待最多 15 秒，每秒检测 gateway 是否就绪
        let waited = 0;
        const interval = setInterval(async () => {
          waited++;
          try {
            const http = require('http');
            await new Promise<boolean>((resolve, reject) => {
              const req = http.get(`http://127.0.0.1:${this.gatewayPort}/health`, (res: import('http').IncomingMessage) => {
                resolve(res.statusCode === 200);
              });
              req.on('error', reject);
              req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            clearInterval(interval);
            clearTimeout(timeout);
            console.log(`[OpenClaw WS] Gateway 启动成功 (${waited}s)`);
            resolve(true);
          } catch {
            if (waited >= 15) {
              clearInterval(interval);
              clearTimeout(timeout);
              console.error(`[OpenClaw WS] Gateway 启动超时 (15s)`);
              resolve(false);
            }
          }
        }, 1000);

        const timeout = setTimeout(() => {
          clearInterval(interval);
          resolve(false);
        }, 16000);
      });

      return started;
    } finally {
      this._gatewayStarting = false;
    }
  }

  addLog(msg: string): void {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogSize) {
      this.logs.shift();
    }
    console.log(`[OpenClaw WS] ${msg}`);
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
  }

  off(event: string, handler: EventHandler): void {
    if (!this.eventListeners.has(event)) return;
    const handlers = this.eventListeners.get(event);
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  emit(event: string, msg?: any): void {
    if (!this.eventListeners.has(event)) return;
    this.eventListeners.get(event).forEach((handler: EventHandler) => handler(msg));
  }

  _notifyAvailability(available: boolean, reason: string): void {
    this._availabilityGeneration += 1;
    this.emit('availability', {
      providerId: 'openclaw-ws',
      backendType: 'openclaw',
      mode: 'websocket',
      operations: ['push', 'steer'],
      available,
      reason,
      generation: this._availabilityGeneration,
    });
  }

  // ============ 设备身份 ============

  /**
   * 生成设备身份
   */
  async createDeviceIdentity() {
    // 生成 32 字节私钥种子 (@noble/ed25519 格式)
    const privateKey = utils.randomSecretKey();
    const publicKey = await getPublicKeyAsync(privateKey);

    // deviceId = SHA256(publicKey) in hex
    const hash = crypto.createHash('sha256').update(Buffer.from(publicKey)).digest();
    const deviceId = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

    return {
      deviceId,
      publicKey: this.base64UrlEncode(publicKey),
      privateKey: this.base64UrlEncode(privateKey)  // base64 encode 存储
    };
  }

  base64UrlEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
  }

  base64UrlDecode(input: string): Uint8Array {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }

  generateId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // ============ 认证 ============

  /**
   * 构建认证 payload
   */
  buildAuthPayload(params: {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce: string;
  }): string {
    return [
      'v2',
      params.deviceId,
      params.clientId,
      params.clientMode,
      params.role,
      params.scopes.join(','),
      String(params.signedAtMs),
      params.token ?? '',
      params.nonce,
    ].join('|');
  }

  /**
   * 签名 payload
   */
  async signPayload(privateKeyBase64Url: string, payload: string): Promise<string> {
    const key = this.base64UrlDecode(privateKeyBase64Url);
    const data = new TextEncoder().encode(payload);
    const sig = await signAsync(data, key);
    return this.base64UrlEncode(sig);
  }

  // ============ WebSocket 连接管理 ============

  /**
   * 连接 WebSocket
   */
  async connect() {
    if (this.connecting || this.connected) {
      console.log('[OpenClaw WS] 已经在连接中或已连接');
      return;
    }

    if (!this.authToken) {
      console.error('[OpenClaw WS] 无法连接: 没有有效的 auth token，请先配置 OpenClaw Gateway');
      return;
    }

    this.connecting = true;
    console.log('[OpenClaw WS] 正在连接:', this.gatewayUrl);

    return new Promise<void>((resolve, reject) => {
      // 连接超时处理
      const connectionTimeout = setTimeout(() => {
        if (!this.connected) {
          this._notifyAvailability(false, 'connect-timeout');
          this.addLog('❌ 连接超时');
          this.connecting = false;
          this.ws?.close();
          this.scheduleReconnect();
          reject(new Error('连接超时'));
        }
      }, 30000);

      try {
        this.ws = new WebSocket(this.gatewayUrl);
      } catch (err) {
        console.error('[OpenClaw WS] 创建 WebSocket 失败:', errorMessage(err));
        this.connecting = false;
        clearTimeout(connectionTimeout);
        this.scheduleReconnect();
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        console.log('[OpenClaw WS] ✅ WebSocket 已连接，等待认证...');
        this.addLog('🔌 WebSocket 已连接，等待认证...');
      });

      this.ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          // 噪音事件只打印到控制台，不写入日志缓冲区
          const hideEvents = ['event health', 'event tick', 'event agent', 'event chat', 'res'];
          const eventStr = msg.type + ' ' + (msg.event || msg.method || '');
          const isNoise = hideEvents.some((eventName: string) => eventStr.includes(eventName));
          if (!isNoise) {
            console.log('[OpenClaw WS] 📩 收到:', msg.type, msg.event || msg.method || msg.payload?.type);
            this.addLog(`📩 收到: ${msg.type} ${msg.event || msg.method || msg.payload?.type || ''}`);
          }

          await this.handleMessage(msg, resolve, connectionTimeout);
        } catch (e) {
          console.error('[OpenClaw WS] 解析消息失败:', errorMessage(e), data.toString().substring(0, 200));
        }
      });

      this.ws.on('error', (err: Error) => {
        this._notifyAvailability(false, `socket-error:${err.message}`);
        console.error('[OpenClaw WS] ❌ 连接错误:', err.message);
        this.connecting = false;
        clearTimeout(connectionTimeout);
        this.scheduleReconnect();
        reject(err);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[OpenClaw WS] 🔌 连接关闭 (code: ${code}, reason: ${reason || '无'})`);
      this.addLog(`🔌 连接关闭 (code: ${code}, reason: ${reason || '无'})`);
        this.connected = false;
        this._notifyAvailability(false, `socket-close:${code}`);
        this.connecting = false;
        this.ws = null;
        // 断线后订阅状态失效；不清除会导致新消息永远卡在「订阅中」
        this.subscribedSessions.clear();
        this._rejectPendingSubscriptions(new Error('OpenClaw WebSocket closed'));

        // 如果启用了自动回复，尝试重连
        if (this.enabled) {
          this.scheduleReconnect();
        }
      });
    }).catch((err: unknown) => {
      // Promise 被拒绝时的处理已在上面完成
      console.log('[OpenClaw WS] 连接 Promise 被拒绝:', err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * 处理收到的消息
   */
  async handleMessage(
    msg: ProtocolMessage,
    resolve: (() => void) | undefined,
    connectionTimeout: NodeJS.Timeout,
  ): Promise<void> {
    // 处理连接挑战
    const nonce = msg.payload?.nonce;
    // This is explicit protocol dispatch, not an authorization bypass; constrain the challenge payload before signing.
    if (msg.type === 'event' && msg.event === 'connect.challenge' && typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 512) {
      console.log('[OpenClaw WS] 🔐 收到认证挑战');

      try {
        this.device = await this.createDeviceIdentity();

        const signedAtMs = Date.now();
        const payload = this.buildAuthPayload({
          deviceId: this.device.deviceId,
          clientId: 'cli',
          clientMode: 'cli',
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          signedAtMs,
          token: this.authToken,
          nonce
        });

        const signature = await this.signPayload(this.device.privateKey, payload);

        this.send({
          type: 'req',
          id: this.generateId(),
          method: 'connect',
          params: {
            minProtocol: this._protocolVer,
            maxProtocol: this._protocolVer,
            client: {
              id: 'cli',
              version: '1.0.0',
              platform: 'windows',
              mode: 'cli'
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
            auth: { token: this.authToken },
            device: {
              id: this.device.deviceId,
              publicKey: this.device.publicKey,
              signature: signature,
              signedAt: signedAtMs,
              nonce: msg.payload.nonce
            },
            locale: 'zh-CN',
            userAgent: 'voko-im-websocket/1.0'
          }
        });
      } catch (err) {
        console.error('[OpenClaw WS] 认证挑战处理失败:', errorMessage(err));
        this.ws?.close();
      }
    }

    // 处理 connect 认证响应：连接后首个 res.ok 即认证成功（!this.connected 门控，
    // 老网关 ack 与 2026.3.x 的 hello-ok 都认；连上后 subscribe/chat 的 res.ok 不再误触发）
    if (msg.type === 'res' && msg.ok && !this.connected) {
      const wasConnected = this.connected; // 记录重连前状态
      const hadSubscribed = this.subscribedSessions.size;
      const wasReconnecting = this.reconnectAttempts > 0; // 是否在重连中
      console.log('[OpenClaw WS] ✅ 认证成功 wasConnected=' + wasConnected + ' hadSubscribed=' + hadSubscribed + ' wasReconnecting=' + wasReconnecting);
      this.addLog('✅ 认证成功');
      this.connected = true;
      this.connecting = false;
      this.emit('connected');
      this._notifyAvailability(true, 'authenticated');
      this._gatewayMethods = msg.payload?.features?.methods || [];
      this._gatewayEvents = msg.payload?.features?.events || [];
      const gatewayEvents = this._gatewayEvents.map((event: unknown) => String(event).toLowerCase());
      this._replyProtocol = gatewayEvents.includes('chat')
        ? 'chat'
        : (gatewayEvents.includes('session.message') ? 'session.message' : null);
      if (msg.payload?.protocol) this._protocolVer = msg.payload.protocol;
      const sessionDefaults = this._sessionDefaultsFromHello(msg.payload);
      this.sessionId = sessionDefaults?.mainSessionKey || 'agent:main:main';
      this.reconnectAttempts = 0; // 重置重连计数

      console.log(`[OpenClaw WS] 认证完成 protocol=${this._protocolVer} subscribe=${this._supportsSessionSubscribe()} replyEvent=${this._replyProtocol || 'auto'} pending=${this.pendingSubscriptions.size}`);

      clearTimeout(connectionTimeout);

      // Gateway 重连后，清除所有订阅状态
      // 只有在真正重连场景下（有重连计数且认证前已订阅）才需要清除
      // 防止首次连接时错误清除订阅状态
      if (wasReconnecting && wasConnected && hadSubscribed > 0) {
        console.log(`[OpenClaw WS] 🔄 重连后清除 ${hadSubscribed} 个旧订阅状态`);
        this.subscribedSessions.clear();
      }

      // 发送队列中的消息
      this.processMessageQueue();

      if (resolve) resolve();
    }

    // 处理认证失败
    if (msg.type === 'res' && !msg.ok && msg.error) {
      console.error('[OpenClaw WS] ❌ 认证失败:', msg.error.message);
      this.addLog(`❌ 认证失败: ${msg.error.message}`);

      // 如果是 token 无效，尝试重新加载配置
      if (msg.error.message?.includes('token') || msg.error.code === 'UNAUTHORIZED') {
        console.log('[OpenClaw WS] Token 可能已过期，尝试重新加载配置...');
        this.loadConfig();
      }

      // 协议版本不匹配 → 降级到 v3 重试
      if (msg.error.message?.includes('protocol')) {
        clearTimeout(connectionTimeout);
        if (this._protocolVer === 4) {
          this._protocolVer = 3;
          console.log('[OpenClaw WS] 协议版本不匹配，降级到 v3 重试...');
          this.addLog('⬇️ 协议版本不匹配，降级到 v3');
          this.ws?.close();
          this.connecting = false;
          this.scheduleReconnect(100);
        } else {
          console.error('[OpenClaw WS] v3 也不匹配，停止重试');
          this.addLog('❌ 协议版本不兼容');
        }
      }
    }

    // 处理订阅响应
    // 注意: msg.id 可能与发送时不一致,改用 payload.key 匹配
    if (msg.type === 'res') {
      const hasSubscribed = msg.payload?.subscribed !== undefined;
      const hasKey = !!msg.payload?.key;

      if (hasSubscribed && hasKey) {
        const key = String(msg.payload.key || '').toLowerCase();
        const subscribed = msg.payload.subscribed;

        if (this.pendingSubscriptions.has(key)) {
          const pending = this.pendingSubscriptions.get(key);
          const elapsed = Date.now() - pending.timestamp;
          this.pendingSubscriptions.delete(key);
          if (pending.timeout) clearTimeout(pending.timeout);

          if (subscribed) {
            this.subscribedSessions.add(key);
            console.log(`[OpenClaw WS] ✅ 订阅成功 耗时=${elapsed}ms`);
            pending.resolve?.();
          } else {
            console.log(`[OpenClaw WS] ❌ 订阅失败 耗时=${elapsed}ms`);
            pending.reject?.(new Error(`OpenClaw session subscription failed: ${key}`));
          }
          // 订阅完成后处理排队消息
          this.processMessageQueue();
        }
      } else if (msg.payload?.type !== 'hello-ok') {
        console.log(`[OpenClaw WS] 📩 收到 res id=${msg.id} type=${msg.payload?.type || 'unknown'}`);
      }
    }

    // OpenClaw 2026.3+：助手回复走 chat 事件（state=final）
    if (msg.type === 'event' && msg.event === 'chat') {
      if (this._replyProtocol !== 'session.message') this._handleChatEvent(msg);
    }

    // 处理助手回复（流式，旧版 session.message）
    if (msg.type === 'event' && msg.event === 'session.message') {
      // 始终保留内部兼容事件（连接自检等仍使用）；是否形成业务回复由握手能力决定。
      this.emit('session.message', msg);
      if (this._replyProtocol === 'chat') return;

      // payload 结构: {sessionKey, message: {role, content, done}, ...}
      const innerMsg = msg.payload?.message;
      if (!innerMsg) return;

      let sessionKey = msg.payload.sessionKey || '';
      // 解码：gateway 返回的 key 是全小写的，还原为原始大小写
      if (sessionKey && this._caseMap.has(sessionKey)) {
        sessionKey = this._caseMap.get(sessionKey);
      }
      const role = innerMsg.role;
      const rawContent = innerMsg.content || [];
      const isFinal = innerMsg.stopReason === 'stop';

      // 从 sessionKey 提取 visitorId 和 agentId
      // 格式: agent:{agentId}:{visitorId}
      const parsedSession = this._parseAgentSessionKey(sessionKey);
      let visitorId = parsedSession.visitorId;
      let agentId = parsedSession.agentId;

      if (role === 'assistant') {
        // 只提取 type="text" 的内容，过滤掉 thinking
        let text = '';
        if (Array.isArray(rawContent)) {
          for (const item of rawContent) {
            if (item.type === 'text' && item.text) {
              text += item.text;
            }
          }
        } else if (typeof rawContent === 'string') {
          text = rawContent;
        }

        // 获取该 visitor 的 pending reply 状态
        const pending = visitorId ? this.pendingReplies.get(visitorId) : null;

        if (text) {
          if (pending) {
            pending.currentReply += text;
          }
        }

        if (isFinal) {
          const finalReply = pending ? pending.currentReply : text;
          console.log(`[OpenClaw WS] ✅ 收到完整回复 visitorId=${visitorId}`);

          // 不再直接发送回复到访客，只存储到 pending 状态等待后续处理
          // 清理 pending reply 状态
          if (pending) {
            clearTimeout(pending.timeout);
            if (pending.replyResolve) {
              pending.replyResolve(finalReply);
            }
            this.pendingReplies.delete(visitorId);
          }

          // 新网关可能紧接着发送同一轮 chat final。短暂等待，优先采用其完整回复。
          this._scheduleLegacyAgentReply(
            sessionKey,
            finalReply,
            this._replyIdentity(msg, sessionKey),
          );
        }
      }
    }

    // 处理错误
    if (msg.type === 'res' && !msg.ok && msg.error) {
      console.error('[OpenClaw WS] ❌ 错误:', msg.error.code, msg.error.message);
    }
  }

  /**
   * 发送消息到 WebSocket
   */
  send(msg: ProtocolMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const data = JSON.stringify(msg);
        this.ws.send(data);
        // chat.send 的详细日志在 sendChatSend 中，这里只记录其他方法
        if (msg.method !== 'chat.send') {
          console.log('[OpenClaw WS] 📤 发送:', msg.type, msg.method || msg.event);
        }
      } catch (err) {
        console.error('[OpenClaw WS] 发送失败:', errorMessage(err));
      }
    } else {
      try { console.error("[OpenClaw WS] ❌ WebSocket 未连接，无法发送消息"); } catch (_) {}
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    const wasAvailable = this.connected || this.connecting;
    // 取消重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // 正常关闭，不触发重连
      this.ws.removeAllListeners('close');
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    if (wasAvailable) this._notifyAvailability(false, 'provider-disconnected');

    // 清理订阅状态
    this.subscribedSessions.clear();
    this._rejectPendingSubscriptions(new Error('OpenClaw WebSocket disconnected'));
    this._sessionSendChains.clear();
    this._caseMap.clear();
    for (const reply of this._legacyReplyTimers.values()) clearTimeout(reply.timer);
    this._legacyReplyTimers.clear();
    this._chatFinalSessions.clear();
    this._sessionTurns.clear();
    this._replyProtocol = null;

    // 清理 pending replies
    for (const [visitorId, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
    }
    this.pendingReplies.clear();

    console.log('[OpenClaw WS] 已断开连接');
  }

  /**
   * 计划重连
   */
  scheduleReconnect(delay: number | null = null): void {
    if (this.reconnectTimer) {
      return; // 已经在计划重连
    }

    if (!this.enabled) {
      console.log('[OpenClaw WS] 已禁用，取消重连');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[OpenClaw WS] 重连次数超过限制 (${this.maxReconnectAttempts})，停止重连`);
      this.addLog(`❌ 重连次数超过限制，停止重连`);
      return;
    }

    this.reconnectAttempts++;

    // 计算重连延迟（指数退避）
    const actualDelay = delay !== null ? delay : Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`[OpenClaw WS] 计划 ${actualDelay}ms 后重连 (尝试 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.addLog(`⏳ 计划 ${actualDelay}ms 后重连 (第${this.reconnectAttempts}次)`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && !this.connected && !this.connecting) {
        console.log('[OpenClaw WS] 执行重连...');
        this.addLog('🔄 执行重连...');
        this.connect().catch((err: unknown) => {
          console.error('[OpenClaw WS] 重连失败:', err instanceof Error ? err.message : String(err));
        });
      }
    }, actualDelay);
  }

  // ============ 消息处理 ============

  /**
   * 发送聊天消息到 OpenClaw（按 visitorId 隔离 pending reply）
   */
  async sendMessage(message: string, visitorId = 'default', timeoutMs = 60000): Promise<string> {
    if (!this.connected) {
      console.log('[OpenClaw WS] 未连接，尝试连接...');
      try {
        await this.connect();
      } catch (err) {
        console.error('[OpenClaw WS] 连接失败，消息进入队列:', errorMessage(err));
        this.queueMessage(message);
        throw new Error('WebSocket 未连接，消息已缓存');
      }
    }

    return new Promise<string>((resolve) => {
      // 按 visitorId 存储 pending reply 状态
      this.pendingReplies.set(visitorId, {
        replyResolve: resolve,
        currentReply: '',
        timeout: setTimeout(() => {
          const pending = this.pendingReplies.get(visitorId);
          if (pending?.replyResolve) {
            console.log('[OpenClaw WS] 等待回复超时 visitor=' + visitorId);
            pending.replyResolve(pending.currentReply || '收到你的消息');
            this.pendingReplies.delete(visitorId);
          }
        }, timeoutMs)
      });

      this.send({
        type: 'req',
        id: this.generateId(),
        method: 'chat.send',
        params: {
          sessionKey: this.sessionId || 'agent:main:main',
          message: message,
          deliver: false,
          idempotencyKey: this.generateId()
        }
      });
    });
  }

  /**
   * 清除超时的订阅 pending（断线/网关无响应时避免永久卡住）
   */
  _evictStalePendingSubscriptions(maxAgeMs = 30000): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingSubscriptions) {
      if (now - pending.timestamp > maxAgeMs) {
        console.warn('[OpenClaw WS] 清除过期订阅');
        this.pendingSubscriptions.delete(key);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject?.(new Error('OpenClaw session subscription timeout'));
      }
    }
  }

  _rejectPendingSubscriptions(error: Error): void {
    for (const pending of this.pendingSubscriptions.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject?.(error);
    }
    this.pendingSubscriptions.clear();
  }

  /**
   * 将消息加入队列（离线缓存）
   */
  queueMessage(item: string | ProtocolMessage): void {
    // 支持简单消息或带类型的对象
    const message = typeof item === 'string' ? item : item.message;
    const type = typeof item === 'string' ? 'simple' : (item.type || 'simple');
    const details: ProtocolMessage = typeof item === 'string' ? {} : item;

    if (this.messageQueue.length >= this.maxQueueSize) {
      console.warn('[OpenClaw WS] 消息队列已满，丢弃最旧的消息');
      this.messageQueue.shift();
    }
    this.messageQueue.push({
      type,
      message,
      sessionKey: details.sessionKey,
      extraData: details.extraData || null,
      timestamp: details.timestamp || Date.now(),
      onSent: details.onSent || null,
    });
    console.log('[OpenClaw WS] 消息已加入队列 type=' + type + ' 当前队列大小:', this.messageQueue.length);
  }

  /**
   * 处理队列中的消息
   */
  async processMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) return;

    console.log('[OpenClaw WS] 处理队列中的', this.messageQueue.length, '条消息');

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const item of queue) {
      try {
        // 跳过超过 5 分钟的消息
        if (Date.now() - item.timestamp > 5 * 60 * 1000) {
          console.log('[OpenClaw WS] 跳过过期消息');
          continue;
        }

        if (item.type === 'sendToSession') {
          // 处理 sendToSession 类型的消息
          console.log('[OpenClaw WS] 处理队列中的 sendToSession');
          this.sendToSession(item.sessionKey, item.message, item.extraData).then(() => {
            if (item.onSent) item.onSent();
          });
        } else {
          // 处理简单消息
          const reply = await this.sendMessage(item.message);
          console.log('[OpenClaw WS] 队列消息处理完成:', reply?.substring(0, 50));
        }
      } catch (err) {
        console.error('[OpenClaw WS] 队列消息处理失败:', errorMessage(err));
      }
    }
  }

  // ============ 工具方法 ============

  // 从 _caseMap 还原原始大小写的 visitorId
  getOriginalVisitorId(lowercaseId: string, agentId: string): string | null {
    if (!lowercaseId || !agentId) return null;
    const lowerKey = `agent:${agentId}:${lowercaseId.toLowerCase()}`;
    const original = this._caseMap.get(lowerKey);
    if (original) {
      const parts = original.split(':');
      return parts[parts.length - 1] || null;
    }
    return null;
  }

  // 向 _caseMap 添加大小写映射（供 main.js 在消息到达时预填充）
  setCaseMapEntry(agentId: string, originalVisitorId: string): void {
    if (!agentId || !originalVisitorId) return;
    const originalKey = `agent:${agentId}:${originalVisitorId}`;
    const lowerKey = originalKey.toLowerCase();
    if (originalKey !== lowerKey) {
      this._caseMap.set(lowerKey, originalKey);
    }
  }

  // 从 sessionKey 提取 visitorId
  extractVisitorId(sessionKey: string): string | undefined {
    // agent:gym:http:visitor:sess_visitor123 → sess_visitor123
    const parts = sessionKey.split(':');
    return parts[parts.length - 1];
  }

  /**
   * 发送消息到指定 session（不等待回复，用于转发到 gym agent）
   * 发送前先订阅该 session，订阅成功后再发送
   */
  sendToSession(
    sessionKey: string,
    message: string,
    extraData: Partial<PushPayload> | null = null,
  ): Promise<void> {
    const originalKey = sessionKey;
    sessionKey = sessionKey.toLowerCase();
    if (originalKey !== sessionKey) this._caseMap.set(sessionKey, originalKey);

    const send = () => this._sendToSessionNow(sessionKey, message, extraData);
    const previous = this._sessionSendChains.get(sessionKey);
    const operation = previous ? previous.then(send) : send();
    const chain = operation.finally(() => {
      if (this._sessionSendChains.get(sessionKey) === chain) this._sessionSendChains.delete(sessionKey);
    });
    // 保留 rejection 供同 session 排队消息共享，同时避免内部链产生未处理 rejection 警告。
    chain.catch(() => {});
    this._sessionSendChains.set(sessionKey, chain);
    return operation;
  }

  async _sendToSessionNow(
    sessionKey: string,
    message: string,
    extraData: Partial<PushPayload> | null,
  ): Promise<void> {
    const now = Date.now();
    console.log(`[OpenClaw WS] 🚀 sendToSession t=${now}`);
    this._evictStalePendingSubscriptions();
    if (!this._supportsSessionSubscribe()) {
      if (!this.connected || this.connecting) throw new Error('OpenClaw WebSocket unavailable');
      this.subscribedSessions.add(sessionKey);
      this.sendChatSend(sessionKey, message, extraData, now);
      return;
    }
    if (!this.subscribedSessions.has(sessionKey)) await this._subscribeSession(sessionKey);
    this.sendChatSend(sessionKey, message, extraData, Date.now());
  }

  _subscribeSession(sessionKey: string): Promise<void> {
    if (this.subscribedSessions.has(sessionKey)) return Promise.resolve();
    const existing = this.pendingSubscriptions.get(sessionKey);
    if (existing?.promise) return existing.promise;
    if (!this.connected || this.connecting) return Promise.reject(new Error('OpenClaw WebSocket unavailable'));

    const now = Date.now();
    const reqId = this.generateId();
    let pending: any;
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingSubscriptions.get(sessionKey) !== pending) return;
        this.pendingSubscriptions.delete(sessionKey);
        reject(new Error('OpenClaw session subscription timeout'));
      }, 30000);
      pending = { timestamp: now, id: reqId, resolve, reject, timeout, promise: null };
      this.pendingSubscriptions.set(sessionKey, pending);
      this.send({
        type: 'req', id: reqId, method: 'sessions.messages.subscribe', params: { key: sessionKey }
      });
    });
    pending.promise = promise;
    return promise;
  }

  /**
   * 发送 chat.send 消息（结构化 JSON 格式）
   */
  sendChatSend(
    sessionKey: string,
    message: string,
    extraData: Partial<PushPayload> | null = null,
    sendTimestamp?: number,
  ): void {
    // 格式: agent:{agentId}:{visitorId}
    let visitorId = null;
    const agentMatch = sessionKey.match(/^agent:([^:]+):(.+)$/);
    if (agentMatch) {
      visitorId = agentMatch[2];
    }
    const turnId = String(extraData?.turnId || extraData?.messageId || this.generateId());
    this._sessionTurns.set(this._resolveSessionKey(sessionKey).toLowerCase(), {
      turnId,
      timestamp: Date.now(),
    });
    if (this._sessionTurns.size > 1000) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [key, tracked] of this._sessionTurns) {
        if (tracked.timestamp < cutoff) this._sessionTurns.delete(key);
      }
    }
    // 构造结构化 JSON（去掉 untrusted 标记）
    const structuredMsg = JSON.stringify({
      type: 'message',
      content: message,
      fromUid: extraData?.senderUid || visitorId || '',
      channelId: extraData?.channelId || visitorId || '',
      channelType: extraData?.channelType ?? 1,
      contentType: extraData?.contentType ?? 1,
      messageId: extraData?.messageId || '',
      timestamp: extraData?.timestamp || Math.floor((sendTimestamp || Date.now()) / 1000)
    });
    console.log(`[OpenClaw WS] 📤 发送 chat.send visitorId=${visitorId} t=${sendTimestamp}`);

    this.send({
      type: 'req',
      id: this.generateId(),
      method: 'chat.send',
      params: {
        sessionKey: sessionKey,
        message: structuredMsg,
        deliver: false,
        idempotencyKey: this.generateId()
      }
    });
  }

  /**
   * 销毁处理器（清理资源）
   */
  destroy(): void {
    console.log('[OpenClaw WS] 正在释放资源...');
    this.stopConfigWatcher();
    this.disconnect();
    this.messageQueue = [];
  }

  /**
   * 测试到 main agent 的连接
   */
  testMainAgent(): Promise<ProtocolMessage> {
    return new Promise<ProtocolMessage>((resolve) => {
      const testSessionKey = 'agent:main:main';
      const testMessage = '[VOKO连接测试] 这是一条来自VOKO的WS连接测试消息，如果正常收到，请回复：已正常接收VOKO消息';
      this.addLog(`🧪 发送测试消息到 ${testSessionKey}...`);
      this.addLog(`📤 发送内容: ${testMessage}`);

      if (!this.connected) {
        this.addLog('❌ 未连接，无法发送测试消息');
        resolve({ success: false, error: '未连接' });
        return;
      }

      let gotEcho = false;
      const sendTime = Date.now();
      const handler = (msg: ProtocolMessage) => {
        if (msg.type === 'event' && msg.event === 'session.message') {
          const innerMsg = msg.payload?.message;
          if (!innerMsg) return;
          const rawContent = innerMsg.content || [];
          let text = '';
          if (Array.isArray(rawContent)) {
            for (const item of rawContent) {
              if (item.type === 'text' && item.text) text += item.text;
            }
          } else if (typeof rawContent === 'string') {
            text = rawContent;
          }
          if (!text) return;
          // 跳过第一次回显，只处理真正的回复
          if (text.includes('[VOKO连接测试]')) {
            gotEcho = true;
            return;
          }
          const cleanText = text.replace(/\n/g, ' ').trim();
          const elapsed = Math.round((Date.now() - sendTime) / 1000);
          this.addLog(`🤖 Agent回复: ${cleanText}（耗时${elapsed}秒）`);
          this.off('session.message', handler);
          clearTimeout(timer);
          resolve({ success: true, reply: text, elapsed });
        }
      };
      this.on('session.message', handler);

      const timer = setTimeout(() => {
        this.off('session.message', handler);
        this.addLog('⏰ 测试超时（60秒内无回复）');
        resolve({ success: false, error: '超时' });
      }, 60000);

      this.sendToSession(testSessionKey, testMessage).catch((err: unknown) => {
        clearTimeout(timer);
        this.off('session.message', handler);
        const message = err instanceof Error ? err.message : String(err);
        this.addLog(`❌ 测试失败: ${message}`);
        resolve({ success: false, error: message });
      });
    });
  }

  // ─────────────────────────────────────────────
  // PushProvider 接口（供 dispatcher 统一调度）
  // 本类自带事件机制（eventListeners Map），故不继承 PushProvider，仅实现接口（duck typing）。
  // ─────────────────────────────────────────────

  /** 长连接通道：路由优先级高于 CLI 兜底（数大优先）。 */
  get priority() { return 10; }

  /** 归属判断：backend_type 为 openclaw 的 agent 归本 provider。 */
  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'openclaw';
  }

  /** 就绪判断：push 通道是否就绪（WS 已连接；openclaw 为全局单连接，与 agentId 无关）。 */
  isAvailable(_agentId: string): boolean {
    return !!this.connected;
  }

  /** 建立连接：确保 gateway 运行 + setEnabled 开启 WS（幂等）。 */
  async start() {
    try {
      const running = await this._ensureGatewayRunning();
      if (!running) console.warn('[OpenClaw WS] provider.start: Gateway 启动失败');
      this.setEnabled(true);
    } catch (e) { console.error('[OpenClaw WS] provider.start 失败:', errorMessage(e)); }
  }

  async stop() {
    if (this._gatewayChild) {
      try { _killTree(this._gatewayChild.pid); } catch (_) {}
      this._gatewayChild = null;
    }
    try { this.destroy(); } catch (_) {}
  }

  /** 推送一条访客消息（构造 sessionKey 后走 sendToSession）。 */
  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, senderUid, content, channelId, channelType, contentType, messageId, turnId, timestamp } = payload;
    let targetAgentId = agentId;
    try {
      const row = this.db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'openclaw');
      targetAgentId = String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {}
    const canResumeBinding = payload.providerBinding?.providerType === 'openclaw'
      && /^agent:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : `agent:${targetAgentId}:${fromUid}`;
    const bindingChannelId = payload.providerBinding?.channelId || channelId || fromUid.replace(/^group:/, '');
    const bindingChannelType = payload.providerBinding?.channelType || (channelType === 2 ? 2 : 1);
    if (!canResumeBinding && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId: bindingChannelId, channelType: bindingChannelType,
        providerType: 'openclaw', providerInstanceId: targetAgentId,
        nativeSessionId: sessionKey, deliveryMode: 'websocket',
        adapterType: 'openclaw-ws', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }
    this._vokoAgentBySession.set(sessionKey.toLowerCase(), agentId);
    const prompt = buildConversationDeliveryPrompt(this.db, payload, canResumeBinding);
    return this.sendToSession(sessionKey, prompt, { senderUid, channelId, channelType, contentType, messageId, turnId, timestamp });
  }

  /** 注入系统消息（openclaw 无独立 steer，走 sendToSession）。 */
  async steer(
    agentId: string,
    visitorId: string,
    content: string,
    metadata?: { turnId?: string },
  ): Promise<void> {
    let targetAgentId = agentId;
    try {
      const row = this.db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'openclaw');
      targetAgentId = String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {}
    const sessionKey = `agent:${targetAgentId}:${visitorId}`;
    this._vokoAgentBySession.set(sessionKey.toLowerCase(), agentId);
    return this.sendToSession(sessionKey, content, { turnId: metadata?.turnId });
  }

  /** 自检 + 重连（替代 index.js 散落的 openclaw 心跳恢复逻辑）。 */
  async healthCheck() {
    const st: ProtocolMessage = (typeof this.getStatus === 'function' ? this.getStatus() : {}) || {};
    if (!st.connected && !st.connecting && typeof this._ensureGatewayRunning === 'function') {
      try { await this._ensureGatewayRunning(); } catch (_) {}
    }
  }
}

/** 杀进程树：Windows taskkill /F /T，Unix 进程组 SIGKILL。清理 detached 的 gateway 子进程。 */
function _killTree(pid?: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 3000 });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) {}
}

module.exports = OpenClawWsProvider;
module.exports.selectWindowsOpenclawCommand = selectWindowsOpenclawCommand;
