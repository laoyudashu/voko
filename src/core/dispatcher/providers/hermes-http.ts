const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const { HermesApiClient } = require('../../adapters/hermes-api-client');
const { getHermesProfilePathCandidates } = require('../../hermes-paths');
const { resolveHermesCommand } = require('../hermes-command');
const { PushProvider } = require('../base-provider');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
const deliveryBus = require('../../lite-bus');
import type { ChildProcess } from 'child_process';
import type {
  HermesApiClientOptions,
  HermesSteerResult,
} from '../../adapters/hermes-api-client';
import type { AgentMeta, ProviderSteerMetadata, PushPayload } from '../types';

interface ProfileConnection {
  port?: number;
  apiKey?: string;
  configPath?: string;
}

interface HermesHttpOptions extends HermesApiClientOptions {
  profiles?: Record<string, { port?: number; apiKey?: string }>;
  profileConfigLoader?: (profileId: string) => ProfileConnection | ProfileConnection[] | null;
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
  _inflightTurns: Map<string, Promise<void>>;

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
    this._authStates = new Map();
    this._selectedConfigPaths = new Map();
    this.connectedAgents = null;
    this._gatewayChildren = null;
    this._inflightTurns = new Map();
    for (const profileId of Object.keys(this.options.profiles || {})) {
      this._refreshProfileConnection(profileId);
    }
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
    const previousConnected = this.connected;
    const previousAgents = this.connectedAgents ? new Set(this.connectedAgents) : null;
    this.connectedAgents = new Set();
    const profilePorts = Object.keys(this.options.profiles || {});
    let anyOk = false;
    if (profilePorts.length > 0) {
      for (const agentId of profilePorts) {
        const ok = await this._authenticateCurrentProfile(agentId);
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
      const agentCount = this.connectedAgents ? this.connectedAgents.size : (anyOk ? 1 : 0);
      this.addLog(anyOk ? `🟢 健康检查通过 (${agentCount} 个 Agent 在线)` : '🔴 健康检查失败（所有 Gateway 离线）');
    }
    if (profilePorts.length > 0) {
      const currentAgents = this.connectedAgents || new Set<string>();
      for (const profileId of new Set([...(previousAgents || []), ...currentAgents])) {
        const before = previousAgents?.has(profileId) || false;
        const available = currentAgents.has(profileId);
        if (before !== available) {
          for (const agentId of this._agentsForProfile(profileId)) {
            this.notifyAvailability({ backendType: 'hermes', mode: 'http', agentId, available, reason: available ? 'profile-ready' : 'profile-unavailable' });
          }
        }
      }
    } else if (previousConnected !== anyOk) {
      this.notifyAvailability({ backendType: 'hermes', mode: 'http', available: anyOk, reason: anyOk ? 'gateway-ready' : 'gateway-unavailable' });
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

  _readProfileConnections(profileId: string): ProfileConnection[] {
    if (typeof this.options.profileConfigLoader === 'function') {
      const loaded = this.options.profileConfigLoader(profileId);
      return (Array.isArray(loaded) ? loaded : loaded ? [loaded] : []).filter(profile => !!profile?.apiKey);
    }
    const profiles: ProfileConnection[] = [];
    for (const configPath of getHermesProfilePathCandidates(profileId, 'config.yaml')) {
      try {
        const yaml = fs.readFileSync(configPath, 'utf8');
        const block = yaml.match(/^\s{2}api_server:\s*\r?\n((?:\s{4,}.*(?:\r?\n|$))*)/m)?.[1] || '';
        const key = block.match(/^\s+key:\s*([^\r\n#]+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
        const port = Number(block.match(/^\s+port:\s*(\d+)/m)?.[1]);
        if (key) profiles.push({
          ...(Number.isSafeInteger(port) && port > 0 ? { port } : {}),
          apiKey: key,
          configPath,
        });
      } catch (_) {}
    }
    return profiles.filter((profile, index, all) => all.findIndex(other => other.port === profile.port && other.apiKey === profile.apiKey) === index);
  }

  _persistProfileConnection(profileId: string, profile: ProfileConnection): void {
    try {
      const row = this.db?.prepare('SELECT data FROM config WHERE type=?').get('hermes_config');
      const cfg = row?.data ? JSON.parse(row.data) : {};
      cfg.profiles = cfg.profiles || {};
      cfg.profiles[profileId] = { ...(cfg.profiles[profileId] || {}), ...profile };
      this.db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
        .run('hermes_config', JSON.stringify(cfg), Date.now());
    } catch (_) {}
  }

  _refreshProfileConnection(profileId: string): boolean {
    const profile = this._readProfileConnections(profileId)[0];
    if (!profile?.apiKey) return false;
    this.options.profiles = this.options.profiles || {};
    this.options.profiles[profileId] = { ...(this.options.profiles[profileId] || {}), ...profile };
    this.client?.setProfile(profileId, profile);
    return true;
  }

  async _selectAuthenticatedProfileConnection(profileId: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const current = this.options.profiles?.[profileId];
    const candidates: ProfileConnection[] = this._readProfileConnections(profileId);
    if (current?.apiKey) candidates.unshift(current);
    const unique = candidates.filter((profile, index, all) => all.findIndex(other => other.port === profile.port && other.apiKey === profile.apiKey) === index);
    for (const profile of unique) {
      if (!profile.apiKey) continue;
      client.setProfile(profileId, profile);
      if (await client.authenticate(profileId)) {
        const previousPath = this._selectedConfigPaths.get(profileId);
        this.options.profiles = this.options.profiles || {};
        this.options.profiles[profileId] = { ...(this.options.profiles[profileId] || {}), ...profile };
        if (profile.configPath) {
          this._selectedConfigPaths.set(profileId, profile.configPath);
          if (previousPath !== profile.configPath) {
            this.addLog(`profile=${profileId} 已选用配置 ${profile.configPath} port=${profile.port || this.options.port || DEFAULT_PORT}`);
          }
        }
        this._persistProfileConnection(profileId, profile);
        this._authStates.set(profileId, true);
        return true;
      }
    }
    if (current) client.setProfile(profileId, current);
    this._selectedConfigPaths.delete(profileId);
    this._authStates.set(profileId, false);
    return false;
  }

  async _authenticateCurrentProfile(profileId: string): Promise<boolean> {
    const profile = this.options.profiles?.[profileId];
    if (!this.client || !profile?.apiKey) {
      this._authStates.set(profileId, false);
      return false;
    }
    this.client.setProfile(profileId, profile);
    const ok = await this.client.authenticate(profileId);
    this._authStates.set(profileId, ok);
    return ok;
  }

  isProfileReady(agentId: string): boolean {
    const profileId = this._profileForAgent(agentId);
    if (!profileId) return false;
    const profile = this.options.profiles?.[profileId];
    const reachable = this.connectedAgents === null || this.connectedAgents.has(profileId);
    return reachable && !!(profile?.apiKey || this.options.apiKey) && this._authStates.get(profileId) !== false;
  }

  /**
   * 确保 Hermes gateway 在运行，如未运行则自动启动
   */
  async _ensureGatewayRunning(profileId?: string): Promise<boolean> {
    if (!profileId) {
      this.addLog('Hermes HTTP 不可用：未绑定 profile，跳过 gateway 启动');
      return false;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
      this.addLog('Hermes HTTP 不可用：拒绝将 Agent UUID 当作 profile');
      return false;
    }
    if (!this.options.profiles?.[profileId]) {
      this.addLog(`Hermes HTTP 不可用：未找到已配置 profile=${profileId}`);
      return false;
    }
    // 检查 API Key 是否已配置
    if (!this.options.profiles?.[profileId]?.apiKey && !this.options?.apiKey) {
      this.addLog(`❌ API Key 未配置，请先到「设置 → 网关连接管理 → Hermes 连接管理」中点击「一键配置」`);
      return false;
    }
    const client = this.client;
    if (!client) return false;
    const port = client._agentPort(profileId);
    if (this._authStates.get(profileId) === true
      && (this.connectedAgents === null || this.connectedAgents.has(profileId))) {
      return true;
    }
    // 先检查是否已经在运行
    const alreadyRunning = await this._selectAuthenticatedProfileConnection(profileId);
    if (alreadyRunning) {
      this.connectedAgents?.add(profileId);
      if (!this.connected) {
        this.connected = true;
        client.connected = true;
        this.addLog(`🟢 Gateway 已连接 ${profileId}`);
        this.emit('status', { connected: true, enabled: this.enabled });
      }
      return true;
    }
    this.addLog(`🔧 gateway 未运行，启动 profile=${profileId} port=${port}...`);
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      const child = spawn(resolveHermesCommand(), ['--profile', profileId, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: true, env: cleanEnv
      });
      child.on('error', (err: Error) => {
        this.addLog(`❌ gateway 进程启动失败 (${profileId}): ${err.message}`);
      });
      child.unref();
      // 记录 child，供 stop() 清理 gateway，避免 Lite/退出后 detached 进程泄漏
      if (!this._gatewayChildren) this._gatewayChildren = new Map<string, ChildProcess>();
      this._gatewayChildren.set(profileId, child);
      // 等待就绪（最多 30s）
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        const ok = await this._selectAuthenticatedProfileConnection(profileId);
        if (ok) {
          this.connectedAgents?.add(profileId);
          this.connected = true;
          client.connected = true;
          this.addLog(`✅ gateway 已就绪 ${profileId} port=${port}`);
          this.emit('status', { connected: true, enabled: this.enabled });
          return true;
        }
      }
      this.addLog(`❌ gateway 启动超时 ${profileId}`);
      return false;
    } catch (e) {
      this.addLog(`❌ gateway 启动失败 ${profileId}: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * 强制重启 gateway（--replace 替换旧实例），用于 401 后重载 config.yaml 里的 key。
   * 与 _ensureGatewayRunning 不同：跳过 ping 早返回，无条件 spawn。
   */
  async _restartGateway(profileId: string): Promise<boolean> {
    if (!profileId) return false;
    const client = this.client;
    if (!client) return false;
    this.addLog(`🔄 401: 强制重启 gateway ${profileId}（重载 config.yaml 的 key）`);
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      const child = spawn(resolveHermesCommand(), ['--profile', profileId, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: true, env: cleanEnv
      });
      child.on('error', (err: Error) => this.addLog(`❌ 重启 spawn 失败 (${profileId}): ${err.message}`));
      child.unref();
      if (!this._gatewayChildren) this._gatewayChildren = new Map<string, ChildProcess>();
      this._gatewayChildren.set(profileId, child);
    } catch (e) {
      this.addLog(`❌ 重启 spawn 异常 (${profileId}): ${errorMessage(e)}`);
      return false;
    }
    for (let i = 0; i < 15; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      if (await this._selectAuthenticatedProfileConnection(profileId)) {
        this.connectedAgents?.add(profileId);
        this.connected = true;
        client.connected = true;
        this.addLog(`✅ gateway 重启就绪 ${profileId}`);
        return true;
      }
    }
    this.addLog(`❌ gateway 重启超时 ${profileId}`);
    return false;
  }

  /** 401 自动重启节流：首次返回 true 并标记，后续返回 false（每 agent 进程内最多 1 次）。 */
  _mark401Restart(agentId: string): boolean {
    if (this._restartedFor401.has(agentId)) return false;
    this._restartedFor401.add(agentId);
    return true;
  }

  _profileForAgent(agentId: string): string | null {
    if (!agentId) return null;
    try {
      const row = this.db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'hermes');
      const profileId = String(row?.backend_instance_id || '').trim();
      return profileId || null;
    } catch (_) {
      return null;
    }
  }

  _agentsForProfile(profileId: string): string[] {
    try {
      const rows = this.db?.prepare(
        "SELECT agent_id, backend_instance_id FROM agents WHERE backend_type='hermes'"
      ).all() as Array<{ agent_id?: string; backend_instance_id?: string }> | undefined;
      const matches = (rows || [])
        .filter(row => String(row.backend_instance_id || '').trim() === profileId)
        .map(row => String(row.agent_id || '').trim())
        .filter(Boolean);
      return matches;
    } catch (_) {
      return [];
    }
  }

  /**
   * 发送访客消息到 Hermes agent（走 API Server）
   * sessionKey 格式: hermes:{agentId}:{visitorId}
   */
  _deliveryKey(agentId: string, channelType: number, channelId: string, turnId: string): string {
    return `${agentId}::${channelType === 2 ? 2 : 1}::${channelId}::${turnId}`;
  }

  _emitDeliveryStatus(input: {
    agentId: string;
    visitorId: string;
    channelId?: string | null;
    channelType?: number | null;
    messageId?: string | null;
    turnId?: string | null;
    status: 'processing' | 'completed' | 'pending' | 'failed' | 'deduplicated';
    elapsedMs?: number;
  }): void {
    const data = {
      provider: 'hermes-http',
      agentId: input.agentId,
      visitorId: input.visitorId,
      channelId: input.channelId || input.visitorId,
      channelType: input.channelType === 2 ? 2 : 1,
      messageId: input.messageId || null,
      turnId: input.turnId || null,
      status: input.status,
      elapsedMs: Number.isFinite(input.elapsedMs) ? Math.max(0, Number(input.elapsedMs)) : 0,
      timestamp: Date.now(),
    };
    this.emit('delivery.status', data);
    try { deliveryBus.emit('agent-delivery:status', data); } catch (_) {}
  }

  /**
   * Public wrapper that makes the long-running HTTP turn observable and
   * coalesces duplicate submissions carrying the same inbound message/turn ID.
   * A timeout is reported as pending; it is intentionally not retried here.
   */
  async sendToSession(
    sessionKey: string,
    message: string,
    extraData: Partial<PushPayload> | null = null,
  ): Promise<void> {
    const parts = sessionKey.split(':');
    const agentId = parts[1] || '';
    const visitorId = parts.slice(2).join(':');
    const channelType = extraData?.channelType === 2 ? 2 : 1;
    const channelId = String(extraData?.channelId || (channelType === 2 ? visitorId.replace(/^group:/, '') : visitorId));
    const turnId = String(extraData?.turnId || extraData?.messageId || '');
    const key = turnId ? this._deliveryKey(agentId, channelType, channelId, turnId) : null;
    const existing = key ? this._inflightTurns.get(key) : null;
    if (existing) {
      this._emitDeliveryStatus({ agentId, visitorId, channelId, channelType, messageId: extraData?.messageId, turnId, status: 'deduplicated' });
      return existing;
    }

    const startedAt = Date.now();
    this._emitDeliveryStatus({ agentId, visitorId, channelId, channelType, messageId: extraData?.messageId, turnId, status: 'processing' });
    const run = this._sendToSession(sessionKey, message, extraData)
      .then(() => {
        this._emitDeliveryStatus({ agentId, visitorId, channelId, channelType, messageId: extraData?.messageId, turnId, status: 'completed', elapsedMs: Date.now() - startedAt });
      })
      .catch((error: unknown) => {
        const detail = errorMessage(error);
        const pending = /timeout|timed out|超时|socket hang up|ECONNRESET/i.test(detail);
        this._emitDeliveryStatus({ agentId, visitorId, channelId, channelType, messageId: extraData?.messageId, turnId, status: pending ? 'pending' : 'failed', elapsedMs: Date.now() - startedAt });
        throw error;
      })
      .finally(() => {
        if (key && this._inflightTurns.get(key) === run) this._inflightTurns.delete(key);
      });
    if (key) this._inflightTurns.set(key, run);
    return run;
  }

  async _sendToSession(
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
    if (!profileId) {
      const error = new Error('Hermes HTTP unavailable: agent is not bound to a Hermes profile');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
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
    const gatewayReady = await this._ensureGatewayRunning(profileId);
    if (!gatewayReady || !this.connected || !this.client) throw new Error(`Hermes gateway is unavailable for profile ${profileId}`);

    try {
      const result = await this.client.chat(profileId, sessionKey, visitorId, structuredMsg);
      this._authStates.set(profileId, true);
      const replyLen = (result.reply || '').length;
      this.addLog(`📥 收到回复 ${agentId} (${replyLen} 字)`);
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
      // 401 优先重新读取该 profile 的独立 key；仅刷新失败时才重启 gateway。
      if (message.includes('HTTP 401')) {
        this._authStates.set(profileId, false);
        if (await this._selectAuthenticatedProfileConnection(profileId)) {
          try {
            const result = await this.client.chat(profileId, sessionKey, visitorId, structuredMsg);
            this._authStates.set(profileId, true);
            this.addLog(`📥 收到回复 ${agentId} (刷新 profile key 后, ${(result.reply || '').length} 字)`);
            this.emit('agent.reply', { agentId, visitorId, content: result.reply, sessionKey, turnId, replyId: result.runId || turnId });
            return;
          } catch (retryErr) { this.addLog(`❌ 刷新 profile key 后仍 chat 失败 ${agentId}: ${errorMessage(retryErr)}`); }
        }
      }
      if (message.includes('HTTP 401') && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            const result = await this.client.chat(profileId, sessionKey, visitorId, structuredMsg);
            this._authStates.set(profileId, true);
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
          const result = await this.client.chat(profileId, sessionKey, visitorId, structuredMsg);
          const replyLen2 = (result.reply || '').length;
          this.addLog(`📥 收到回复 ${agentId} (重试, ${replyLen2} 字)`);
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
    metadata?: ProviderSteerMetadata,
  ): Promise<HermesSteerResult | null | undefined> {
    const profileId = this._profileForAgent(agentId);
    if (!profileId) {
      const error = new Error('Hermes HTTP unavailable: agent is not bound to a Hermes profile');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    const boundSession = metadata?.providerBinding?.providerType === 'hermes'
      && metadata.providerBinding.providerInstanceId === profileId
      ? metadata.providerBinding.nativeSessionId
      : null;
    const sessionKey = boundSession || `hermes:${agentId}:${visitorId}`;
    const turnId = String(metadata?.turnId || `hermes-steer-${Date.now()}`);
    this.addLog(`📝 注入系统消息 ${agentId}`);

    // 自动启动 gateway
    const justStarted = !this.connected;
    const gatewayReady = await this._ensureGatewayRunning(profileId);
    if (!gatewayReady || !this.connected || !this.client) throw new Error(`Hermes gateway is unavailable for profile ${profileId}`);

    // hermes steer 本身不 emit agent.reply（其 chat 才 emit），手动补偿以走 onAgentReply → handleAgentReply
    const emitReply = (result: HermesSteerResult): void => {
      if (result?.output && typeof this.emit === 'function') {
        this.emit('agent.reply', { agentId, visitorId, content: result.output, sessionKey, turnId, replyId: turnId });
      }
    };

    try {
      const result = await this.client.steer(profileId, sessionKey, visitorId, content);
      this._authStates.set(profileId, true);
      this.addLog(`✅ steer 完成 ${agentId} (回复 ${(result.output || '').length} 字)`);
      emitReply(result);
      return result;
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes('HTTP 401')) {
        this._authStates.set(profileId, false);
        if (await this._selectAuthenticatedProfileConnection(profileId)) {
          try {
            const result = await this.client.steer(profileId, sessionKey, visitorId, content);
            this._authStates.set(profileId, true);
            this.addLog(`✅ steer 完成 ${agentId} (刷新 profile key 后)`);
            emitReply(result);
            return result;
          } catch (retryErr) { this.addLog(`❌ 刷新 profile key 后 steer 仍失败 ${agentId}: ${errorMessage(retryErr)}`); }
        }
      }
      if (message.includes('HTTP 401') && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            const result = await this.client.steer(profileId, sessionKey, visitorId, content);
            this._authStates.set(profileId, true);
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
          const result = await this.client.steer(profileId, sessionKey, visitorId, content);
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
    const affectedAgents = this.connectedAgents ? [...this.connectedAgents] : [];
    if (affectedAgents.length) {
      for (const profileId of affectedAgents) {
        for (const agentId of this._agentsForProfile(profileId)) {
          this.notifyAvailability({ backendType: 'hermes', mode: 'http', agentId, available: false, reason: 'provider-stopped' });
        }
      }
    } else {
      this.notifyAvailability({ backendType: 'hermes', mode: 'http', available: false, reason: 'provider-stopped' });
    }
    this._destroyed = true;
    this.enabled = false;
    this.connected = false;
    this._inflightTurns.clear();
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
  isAvailable(agentId: string): boolean {
    return this.isProfileReady(agentId);
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
    if (!canResumeBinding && profileId && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId: bindingChannelId, channelType: bindingChannelType,
        providerType: 'hermes', providerInstanceId: profileId,
        nativeSessionId: sessionKey, deliveryMode: 'http',
        adapterType: 'hermes-http', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }
    const prompt = buildConversationDeliveryPrompt(this.db, payload, canResumeBinding);
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
