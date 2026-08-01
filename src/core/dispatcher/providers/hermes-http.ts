const { spawn, execFileSync } = require('child_process');
const { HermesApiClient } = require('../../adapters/hermes-api-client');
const { PushProvider } = require('../base-provider');
const { buildConversationRecoveryPrompt } = require('../conversation-context');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
import type { ChildProcess } from 'child_process';
import type {
  HermesApiClientOptions,
  HermesSteerResult,
} from '../../adapters/hermes-api-client';
import type { AgentMeta, PushPayload } from '../types';

interface HermesHttpOptions extends HermesApiClientOptions {
  profiles?: Record<string, { port?: number }>;
}

interface HermesStatus {
  connected: boolean;
  enabled: boolean;
  clientReady: boolean;
  logs: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;

/**
 * Hermes HTTP Provider — voko 与 Hermes Agent API Server 之间的 push 通道
 *
 * 职责：
 *  - 管理 HermesApiClient 生命周期
 *  - 提供 push()/sendToSession()/steer() 接口（PushProvider + 兼容旧调用）
 *  - 转发 agent.reply 事件
 *
 * 通过 HTTP 与 hermes-agent 原生 API Server 通信，取代旧版 TCP Bridge。
 * gateway 进程的 spawn（_ensureGatewayRunning）收敛在本 provider 内。
 */
class HermesHttpProvider extends PushProvider {
  client: InstanceType<typeof HermesApiClient> | null;
  connectedAgents: Set<string> | null;
  _gatewayChildren: Map<string, ChildProcess> | null;

  constructor(database: unknown, mainWindow: unknown, options: HermesHttpOptions = {}) {
    super();
    this.db = database;
    this._bindingStore = database && typeof (database as any).exec === 'function'
      ? new ProviderConversationBindingStore(database as any)
      : null;
    this.mainWindow = mainWindow;
    this.options = options;
    this.enabled = false;
    this.connected = false;
    this.client = null;
    this._destroyed = false;
    this.logs = [];
    this.maxLogSize = 200;
    // 401 自动重启节流：记录因 401 已重启过的 agentId，每进程内最多 1 次，防循环
    this._restartedFor401 = new Set();
    this.connectedAgents = null;
    this._gatewayChildren = null;
    this._recoveryWarmedSessions = new Set();
  }

  addLog(msg: string): void {
    const entry = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogSize) this.logs.shift();
    console.log(`[HermesHandler] ${msg}`);
  }

  /**
   * 启用/停用 Hermes API 客户端
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.client) {
      this.addLog('🚀 Hermes Handler 初始化中...');
      this._initClient().catch((err: unknown) => {
        this.addLog(`❌ 客户端初始化失败: ${errorMessage(err)}`);
        this.connected = false;
        this.emit('status', { connected: false, enabled: true });
      });
    } else if (!enabled && this.client) {
      this.addLog('⏹ Hermes Handler 已停用');
      this.destroy();
    }
  }

  async _initClient(): Promise<void> {
    this.client = new HermesApiClient({
      host: this.options.host || DEFAULT_HOST,
      port: this.options.port || DEFAULT_PORT,
      apiKey: this.options.apiKey || '',
      profiles: this.options.profiles || {}
    });

    const profileCount = Object.keys(this.options.profiles || {}).length;
    this.addLog(`🔌 Hermes API 客户端已创建 (${profileCount} 个 profile)`);

    this.client.on('ready', () => {
      this.connected = true;
      this.addLog('✅ Hermes API 客户端已就绪');
      this.emit('status', { connected: true, enabled: this.enabled });
    });

    this.client.on('status', ({ connected }: { connected: boolean }) => {
      this.connected = connected;
      this.addLog(connected ? '🟢 Gateway 已连接' : '🔴 Gateway 已断开');
      this.emit('status', { connected, enabled: this.enabled });
    });

  }

  /**
   * 健康检查（由外部 60s 定时器驱动）
   * 逐个检查所有已配置的 agent gateway HTTP 端口，记录可达的 agentId
   */
  async healthCheck(): Promise<void> {
    if (!this.client) return;
    this.connectedAgents = new Set();
    const profilePorts = Object.keys(this.options.profiles || {});
    let anyOk = false;
    if (profilePorts.length > 0) {
      for (const agentId of profilePorts) {
        let ok = await this.client.ping(agentId);
        if (ok) {
          anyOk = true;
          this.connectedAgents.add(agentId);
        }
      }
    } else {
      anyOk = await this.client.ping();
      if (anyOk) this.connectedAgents = null;
    }
    if (anyOk !== this.client.connected) {
      this.client.connected = anyOk;
      this.emit('status', { connected: anyOk, enabled: this.enabled });
    }
    if (anyOk !== this.connected) {
      this.connected = anyOk;
      if (!anyOk) this._recoveryWarmedSessions.clear();
      const agentCount = this.connectedAgents ? this.connectedAgents.size : (anyOk ? 1 : 0);
      this.addLog(anyOk ? `🟢 健康检查通过 (${agentCount} 个 Agent 在线)` : '🔴 健康检查失败（所有 Gateway 离线）');
    }
  }

  /**
   * 获取状态
   */
  getStatus(): HermesStatus {
    return {
      connected: this.connected,
      enabled: this.enabled,
      clientReady: this.client?.connected || false,
      logs: this.logs.slice()
    };
  }

  /**
   * 确保 Hermes gateway 在运行，如未运行则自动启动
   */
  async _ensureGatewayRunning(agentId: string): Promise<boolean> {
    // 检查 API Key 是否已配置
    if (!this.options?.apiKey) {
      this.addLog(`❌ API Key 未配置，请先到「设置 → 网关连接管理 → Hermes 连接管理」中点击「一键配置」`);
      return false;
    }
    const client = this.client;
    if (!client) return false;
    const port = client._agentPort(agentId);
    // 先检查是否已经在运行
    const alreadyRunning = await client.ping(agentId);
    if (alreadyRunning) {
      if (!this.connected) {
        this.connected = true;
        client.connected = true;
        this.addLog(`🟢 Gateway 已连接 ${agentId}`);
        this.emit('status', { connected: true, enabled: this.enabled });
      }
      return true;
    }
    this.addLog(`🔧 gateway 未运行，启动 profile=${agentId} port=${port}...`);
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      const child = spawn('hermes', ['--profile', agentId, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: true, env: cleanEnv
      });
      child.on('error', (err: Error) => {
        this.addLog(`❌ gateway 进程启动失败 (${agentId}): ${err.message}`);
      });
      child.unref();
      // 记录 child，供 stop() 清理 gateway，避免 Lite/退出后 detached 进程泄漏
      if (!this._gatewayChildren) this._gatewayChildren = new Map<string, ChildProcess>();
      this._gatewayChildren.set(agentId, child);
      // 等待就绪（最多 30s）
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        const ok = await client.ping(agentId);
        if (ok) {
          this.connected = true;
          client.connected = true;
          this.addLog(`✅ gateway 已就绪 ${agentId} port=${port}`);
          this.emit('status', { connected: true, enabled: this.enabled });
          return true;
        }
      }
      this.addLog(`❌ gateway 启动超时 ${agentId}`);
      return false;
    } catch (e) {
      this.addLog(`❌ gateway 启动失败 ${agentId}: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * 强制重启 gateway（--replace 替换旧实例），用于 401 后重载 config.yaml 里的 key。
   * 与 _ensureGatewayRunning 不同：跳过 ping 早返回，无条件 spawn。
   */
  async _restartGateway(agentId: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    this.addLog(`🔄 401: 强制重启 gateway ${agentId}（重载 config.yaml 的 key）`);
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      const child = spawn('hermes', ['--profile', agentId, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: true, env: cleanEnv
      });
      child.on('error', (err: Error) => this.addLog(`❌ 重启 spawn 失败 (${agentId}): ${err.message}`));
      child.unref();
      if (!this._gatewayChildren) this._gatewayChildren = new Map<string, ChildProcess>();
      this._gatewayChildren.set(agentId, child);
    } catch (e) {
      this.addLog(`❌ 重启 spawn 异常 (${agentId}): ${errorMessage(e)}`);
      return false;
    }
    for (let i = 0; i < 15; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      if (await client.ping(agentId)) {
        this.connected = true;
        client.connected = true;
        this.addLog(`✅ gateway 重启就绪 ${agentId}`);
        return true;
      }
    }
    this.addLog(`❌ gateway 重启超时 ${agentId}`);
    return false;
  }

  /** 401 自动重启节流：首次返回 true 并标记，后续返回 false（每 agent 进程内最多 1 次）。 */
  _mark401Restart(agentId: string): boolean {
    if (this._restartedFor401.has(agentId)) return false;
    this._restartedFor401.add(agentId);
    return true;
  }

  _profileForAgent(agentId: string): string {
    try {
      const row = this.db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'hermes');
      return String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {
      return agentId;
    }
  }

  /**
   * 发送访客消息到 Hermes agent（走 API Server）
   * sessionKey 格式: hermes:{agentId}:{visitorId}
   */
  async sendToSession(
    sessionKey: string,
    message: string,
    extraData: Partial<PushPayload> | null = null,
  ): Promise<void> {
    const parts = sessionKey.split(':');
    if (parts.length < 3 || parts[0] !== 'hermes') {
      throw new Error('无效的 Hermes session');
    }
    const agentId = parts[1]!;
    const visitorId = parts.slice(2).join(':');
    const profileId = this._profileForAgent(agentId);
    const turnId = String(extraData?.turnId || extraData?.messageId || `hermes-${Date.now()}`);

    this.addLog(`📤 转发消息 ${agentId} (visitor=${visitorId.substring(0, 12)}...)`);

    // 构造结构化 JSON
    const structuredMsg = JSON.stringify({
      type: 'message',
      content: message,
      fromUid: extraData?.senderUid || visitorId,
      channelId: extraData?.channelId || visitorId,
      channelType: extraData?.channelType ?? 1,
      contentType: extraData?.contentType ?? 1,
      messageId: extraData?.messageId || '',
      timestamp: extraData?.timestamp || Math.floor(Date.now() / 1000)
    });

    // 自动启动 gateway
    const justStarted = !this.connected;
    await this._ensureGatewayRunning(profileId);
    if (!this.connected || !this.client) throw new Error(`Hermes gateway is unavailable for profile ${profileId}`);

    try {
      const result = await this.client.chat(profileId, visitorId, structuredMsg);
      const replyLen = (result.reply || '').length;
      const replyPreview = (result.reply || '').substring(0, 120).replace(/\n/g, '\\n');
      this.addLog(`📥 收到回复 ${agentId} (${replyLen} 字) 内容="${replyPreview}"`);
      console.log(`[HermesHandler] 完整回复 ${agentId}:`, result.reply);
      this.emit('agent.reply', {
        agentId,
        visitorId,
        content: result.reply,
        sessionKey,
        turnId,
        replyId: result.runId || turnId,
      });
    } catch (err) {
      const message = errorMessage(err);
      // 401: gateway 用的旧 key 与 config.yaml/client 新 key 不匹配（常见于一键配置后未重启）。
      // 强制 --replace 重启 gateway 重载 key，再重试一次；每 agent 进程内仅一次，防循环。
      if (message.includes('HTTP 401') && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            const result = await this.client.chat(profileId, visitorId, structuredMsg);
            this.addLog(`📥 收到回复 ${agentId} (401 重启后, ${(result.reply || '').length} 字)`);
            this.emit('agent.reply', { agentId, visitorId, content: result.reply, sessionKey, turnId, replyId: result.runId || turnId });
            return;
          } catch (retryErr) { this.addLog(`❌ 重启后仍 chat 失败 ${agentId}: ${errorMessage(retryErr)}`); }
        }
        throw new Error('Hermes gateway authentication failed');
      }
      // 刚启动的 gateway 可能因 --replace 切换窗口而短暂不可用，等 2s 重试
      if (justStarted && (message.includes('ECONNRESET') || message.includes('ECONNREFUSED'))) {
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
        try {
          const result = await this.client.chat(profileId, visitorId, structuredMsg);
          const replyLen2 = (result.reply || '').length;
          const replyPrev2 = (result.reply || '').substring(0, 120).replace(/\n/g, '\\n');
          this.addLog(`📥 收到回复 ${agentId} (重试, ${replyLen2} 字) 内容="${replyPrev2}"`);
          console.log(`[HermesHandler] 完整回复(重试) ${agentId}:`, result.reply);
          this.emit('agent.reply', { agentId, visitorId, content: result.reply, sessionKey, turnId, replyId: result.runId || turnId });
          return;
        } catch (retryErr) {}
      }
      this.addLog(`❌ chat 失败 ${agentId}: ${message}`);
      throw err;
    }
  }

  /**
   * 注入系统消息到 Hermes agent 会话（走 API Server）
   * 用于支付通知、主人回复等场景
   */
  async steer(
    agentId: string,
    visitorId: string,
    content: string,
    metadata?: { turnId?: string },
  ): Promise<HermesSteerResult | null | undefined> {
    const sessionKey = `hermes:${agentId}:${visitorId}`;
    const profileId = this._profileForAgent(agentId);
    const turnId = String(metadata?.turnId || `hermes-steer-${Date.now()}`);
    this.addLog(`📝 注入系统消息 ${agentId}`);

    // 自动启动 gateway
    const justStarted = !this.connected;
    await this._ensureGatewayRunning(profileId);
    if (!this.connected || !this.client) throw new Error(`Hermes gateway is unavailable for profile ${profileId}`);

    // hermes steer 本身不 emit agent.reply（其 chat 才 emit），手动补偿以走 onAgentReply → handleAgentReply
    const emitReply = (result: HermesSteerResult): void => {
      if (result?.output && typeof this.emit === 'function') {
        this.emit('agent.reply', { agentId, visitorId, content: result.output, sessionKey, turnId, replyId: turnId });
      }
    };

    try {
      const result = await this.client.steer(profileId, visitorId, content);
      this.addLog(`✅ steer 完成 ${agentId} (回复 ${(result.output || '').length} 字)`);
      emitReply(result);
      return result;
    } catch (err) {
      const message = errorMessage(err);
      // 401: 同 sendToSession，强制重启 gateway 重载 key 后重试一次。
      if (message.includes('HTTP 401') && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            const result = await this.client.steer(profileId, visitorId, content);
            this.addLog(`✅ steer 完成 ${agentId} (401 重启后)`);
            emitReply(result);
            return result;
          } catch (retryErr) { this.addLog(`❌ 重启后 steer 仍失败 ${agentId}: ${errorMessage(retryErr)}`); }
        }
        throw new Error('Hermes gateway authentication failed');
      }
      if (justStarted && (message.includes('ECONNRESET') || message.includes('ECONNREFUSED'))) {
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
        try {
          const result = await this.client.steer(profileId, visitorId, content);
          this.addLog(`✅ steer 完成 ${agentId} (重试)`);
          emitReply(result);
          return result;
        } catch (retryErr) {}
      }
      this.addLog(`❌ steer 失败 ${agentId}: ${message}`);
      throw err;
    }
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    this._destroyed = true;
    this.enabled = false;
    this.connected = false;
    // kill detached gateway 子进程，避免直接调 destroy（非经 stop）时泄漏：占端口/读旧 key
    if (this._gatewayChildren) {
      for (const child of this._gatewayChildren.values()) {
        try { if (child.pid) _killTree(child.pid); } catch (_) {}
      }
      this._gatewayChildren.clear();
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.removeAllListeners();
  }

  // ─────────────────────────────────────────────
  // PushProvider 接口补充（healthCheck / steer 已存在）
  // ─────────────────────────────────────────────

  /** 长连接通道：路由优先级高于 CLI 兜底（数大优先）。 */
  get priority() { return 10; }

  /** 归属判断：backend_type 为 hermes 的 agent 归本 provider。 */
  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'hermes';
  }

  /** 就绪判断：hermes 的 sendToSession 会按需 _ensureGatewayRunning（spawn gateway），
   *  故只要有 apiKey 即视为可 push（避免启动初期 connectedAgents 未填充导致误留库）。
   *  无 apiKey 时无法 spawn/push，dispatcher 将留库等 agent pull。 */
  isAvailable(_agentId: string): boolean {
    return !!this.options?.apiKey;
  }

  /** 建立连接：启用 HermesApiClient（gateway 按需在 sendToSession/steer 内 spawn）。 */
  async start() {
    this.setEnabled(true);
  }

  async stop() {
    // 停掉本 provider 自己 spawn 的 gateway 进程（detached，不随 Lite 退出而死，否则泄漏）
    if (this._gatewayChildren) {
      for (const child of this._gatewayChildren.values()) {
        try { _killTree(child.pid); } catch (_) {}
      }
      this._gatewayChildren.clear();
    }
    try { await this.destroy(); } catch (_) {}
  }

  /** 推送一条访客消息（构造 sessionKey 后走 sendToSession）。 */
  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, senderUid, content, channelId, channelType, contentType, messageId, turnId, timestamp } = payload;
    const canResumeBinding = payload.providerBinding?.providerType === 'hermes'
      && /^hermes:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : `hermes:${agentId}:${fromUid}`;
    const profileId = this._profileForAgent(agentId);
    const bindingChannelId = payload.providerBinding?.channelId || channelId || fromUid.replace(/^group:/, '');
    const bindingChannelType = payload.providerBinding?.channelType || (channelType === 2 ? 2 : 1);
    if (!canResumeBinding && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId: bindingChannelId, channelType: bindingChannelType,
        providerType: 'hermes', providerInstanceId: profileId,
        nativeSessionId: sessionKey, deliveryMode: 'http',
        adapterType: 'hermes-http', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }
    const prompt = this._recoveryWarmedSessions.has(sessionKey)
      ? content
      : buildConversationRecoveryPrompt(this.db, payload);
    this._recoveryWarmedSessions.add(sessionKey);
    return this.sendToSession(sessionKey, prompt, { senderUid, channelId, channelType, contentType, messageId, turnId, timestamp });
  }
}

/** 杀进程树：Windows taskkill /F /T，Unix 进程组 SIGKILL。用于清理 detached 的 gateway 子进程。 */
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

module.exports = HermesHttpProvider;
