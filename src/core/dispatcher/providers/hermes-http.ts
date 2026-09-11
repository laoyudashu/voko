const { spawn, execFileSync } = require('child_process');
const os = require('os');
const { HermesApiClient } = require('../../adapters/hermes-api-client');
const { getHermesProfilePathCandidates } = require('../../hermes-paths');
const { readHermesGatewayConfig, hermesGatewayConnections } = require('../../hermes-gateway-config');
const { sanitizeCliDiagnostic } = require('../../adapters/cli-spawner');
const { resolveHermesCommand } = require('../hermes-command');
const { PushProvider } = require('../base-provider');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { appendProviderAttachmentBoundary, stageProviderAttachments } = require('../provider-attachments');
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
  connectionSource?: string;
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
  hasApiKey: boolean;
  profiles: Record<string, { profileId: string; port: number; hasApiKey: boolean; connected: boolean; ready: boolean }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notDeliveredError(message: string): Error {
  const error = new Error(message);
  (error as any).deliveryOutcome = 'not_delivered';
  return error;
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
  _gatewayStarts: Map<string, Promise<boolean>>;
  _authChecks: Map<string, symbol>;
  _lifecycleGeneration: number;

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
    this._gatewayStarts = new Map();
    this._authChecks = new Map();
    this._lifecycleGeneration = 0;
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
    if (enabled) this._destroyed = false;
    if (enabled && !this.client) {
      this.addLog('🚀 Hermes Handler 初始化中...');
      this._initClient().catch((err: unknown) => {
        this.addLog(`❌ 客户端初始化失败: ${errorMessage(err)}`);
        this.connected = false;
        this.emit('status', { connected: false, enabled: true });
      });
    } else if (!enabled && this.client) {
      this.addLog('⏹ Hermes Handler 已停用');
      void this.stop();
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
    const client = this.client;
    const generation = this._lifecycleGeneration;
    if (!client || this._destroyed) return;
    const previousConnected = this.connected;
    const previousAgents = this.connectedAgents ? new Set(this.connectedAgents) : null;
    const profilePorts = Object.keys(this.options.profiles || {});
    for (const agentId of profilePorts) {
      await this._authenticateCurrentProfile(agentId);
      if (!this._isCurrentClient(client, generation)) return;
    }
    // Use the latest committed results, not this health call's potentially stale snapshot.
    this.connectedAgents = new Set(Object.keys(this.options.profiles || {}).filter(id => this._authStates.get(id) === true));
    const anyOk = this.connectedAgents.size > 0;
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
    const profiles = Object.fromEntries(Object.keys(this.options.profiles || {}).map(id => [id, this.getProfileStatus(id)]));
    return {
      connected: this.connected,
      enabled: this.enabled,
      clientReady: this.client?.connected || false,
      logs: this.logs.slice(),
      hasApiKey: Object.values(profiles).some(profile => profile.hasApiKey),
      profiles,
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
        const config = readHermesGatewayConfig(configPath);
        profiles.push(...hermesGatewayConnections(config).filter((connection: ProfileConnection) => !!connection.apiKey));
      } catch (error: any) {
        if (String(error.message).startsWith('HERMES_ENV_')) {
          const detail = `profile=${profileId}: ${error.message}`;
          if (!this.logs.some((line: string) => line.includes(detail))) this.addLog(detail);
        }
      }
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

  _isCurrentClient(client: typeof this.client, generation: number): boolean {
    return !!client && !this._destroyed && this.client === client && generation === this._lifecycleGeneration;
  }

  _assertCurrentResponse(client: typeof this.client, generation: number): void {
    if (!this._isCurrentClient(client, generation)) {
      // Submission already happened: dropping a stale reply must neither complete
      // the turn nor allow the dispatcher to submit the same work elsewhere.
      throw Object.assign(new Error('Hermes provider changed after submission; reply was not delivered'), {
        code: 'HERMES_RESPONSE_LIFECYCLE_CHANGED', deliveryOutcome: 'outcome_unknown',
      });
    }
  }

  _assertCurrentClient(client: typeof this.client, generation: number, profileId: string): void {
    if (!this._isCurrentClient(client, generation)) throw notDeliveredError('Hermes provider stopped before submission');
    if (this._profileConnectionConflict(profileId, this.options.profiles?.[profileId] || {}, false)) {
      throw notDeliveredError('HERMES_PROFILE_ROUTE_AMBIGUOUS: 所选连接无法区分不同 profile');
    }
  }

  _profileConnectionCandidates(profileId: string): ProfileConnection[] {
    const current = this.options.profiles?.[profileId];
    const candidates = this._readProfileConnections(profileId);
    if (current && (current.apiKey || this.options.apiKey)) candidates.unshift({ ...current, apiKey: current.apiKey || this.options.apiKey });
    return candidates.map(candidate => ({ ...candidate, port: candidate.port || this.options.port || DEFAULT_PORT }))
      .filter((candidate, index, all) => candidate.apiKey && all.findIndex(other => other.port === candidate.port && other.apiKey === candidate.apiKey) === index);
  }

  /** All profiles use this provider's host. Equal endpoint AND credential cannot select two different profiles. */
  _profileConnectionConflict(profileId: string, connection: ProfileConnection, includeCandidates = true): string | null {
    const port = connection.port || this.options.port || DEFAULT_PORT;
    const apiKey = connection.apiKey || this.options.apiKey;
    if (!apiKey) return null;
    for (const otherId of Object.keys(this.options.profiles || {})) {
      if (otherId === profileId) continue;
      const current: ProfileConnection = this.options.profiles[otherId];
      const candidates = includeCandidates ? [current, ...this._readProfileConnections(otherId)] : [current];
      if (candidates.some(other => (other.port || this.options.port || DEFAULT_PORT) === port
        && (other.apiKey || this.options.apiKey) === apiKey)) return otherId;
    }
    return null;
  }

  _beginAuthCheck(profileId: string) {
    const check = Symbol(profileId), client = this.client, generation = this._lifecycleGeneration;
    this._authChecks.set(profileId, check);
    return () => this._isCurrentClient(client, generation) && this._authChecks.get(profileId) === check;
  }

  _invalidateProfile(profileId: string): void {
    const wasReady = this._authStates.get(profileId) === true && this.connectedAgents?.has(profileId) === true;
    this._authChecks.delete(profileId);
    this._authStates.set(profileId, false);
    this.connectedAgents?.delete(profileId);
    this.connected = !!this.connectedAgents?.size;
    if (this.client) this.client.connected = this.connected;
    if (wasReady) {
      this.emit('status', { connected: this.connected, enabled: this.enabled });
      for (const agentId of this._agentsForProfile(profileId)) {
        this.notifyAvailability({ backendType: 'hermes', mode: 'http', agentId, available: false, reason: 'profile-unavailable' });
      }
    }
  }

  async reconnectProfile(profileId: string): Promise<boolean> {
    await this._authenticateCurrentProfile(profileId);
    return this._ensureGatewayRunning(profileId);
  }

  async _selectAuthenticatedProfileConnection(profileId: string): Promise<boolean> {
    const client = this.client;
    if (!client || this._destroyed) return false;
    const isCurrent = this._beginAuthCheck(profileId);
    for (const profile of this._profileConnectionCandidates(profileId)) {
      const conflict = this._profileConnectionConflict(profileId, profile);
      if (conflict) {
        const detail = `HERMES_PROFILE_ROUTE_AMBIGUOUS: profile=${profileId} 与 ${conflict} 的端点和凭据相同 (port=${profile.port}, source=${profile.connectionSource || 'configured'})`;
        if (!this.logs.some((line: string) => line.includes(detail))) this.addLog(detail);
        continue;
      }
      const authenticated = await client.authenticate(profileId, profile);
      if (!isCurrent()) return false;
      if (authenticated) {
        const previousPath = this._selectedConfigPaths.get(profileId);
        this.options.profiles = this.options.profiles || {};
        this.options.profiles[profileId] = profile;
        client.setProfile(profileId, profile);
        if (profile.configPath) {
          this._selectedConfigPaths.set(profileId, profile.configPath);
          if (previousPath !== profile.configPath) {
            this.addLog(`profile=${profileId} 已选用配置 ${profile.configPath} port=${profile.port} source=${profile.connectionSource || 'yaml'}`);
          }
        }
        this._persistProfileConnection(profileId, profile);
        this._authStates.set(profileId, true);
        return true;
      }
    }
    this._selectedConfigPaths.delete(profileId);
    this._invalidateProfile(profileId);
    return false;
  }

  async _authenticateCurrentProfile(profileId: string): Promise<boolean> {
    const starting = this._gatewayStarts.get(profileId);
    if (starting) return starting;
    const profile = this.options.profiles?.[profileId];
    const client = this.client;
    const isCurrent = this._beginAuthCheck(profileId);
    if (!client || this._destroyed || !(profile?.apiKey || this.options.apiKey)) {
      this._authStates.set(profileId, false);
      return false;
    }
    const connection = { ...profile, port: profile?.port || this.options.port || DEFAULT_PORT,
      apiKey: profile?.apiKey || this.options.apiKey };
    if (this._profileConnectionConflict(profileId, connection)) { this._invalidateProfile(profileId); return false; }
    const ok = await client.authenticate(profileId, connection);
    if (!isCurrent()) return false;
    if (ok) this._authStates.set(profileId, true); else this._invalidateProfile(profileId);
    return ok;
  }

  isProfileReady(agentId: string): boolean {
    if (this._destroyed) return false;
    const profileId = this._profileForAgent(agentId);
    if (!profileId) return false;
    const profile = this.options.profiles?.[profileId];
    const reachable = this.connectedAgents === null || this.connectedAgents.has(profileId);
    return reachable && !!(profile?.apiKey || this.options.apiKey) && this._authStates.get(profileId) !== false
      && !this._profileConnectionConflict(profileId, profile || {}, false);
  }

  /** UI/configuration readiness requires authenticated evidence for this exact profile. */
  getProfileStatus(profileId: string) {
    const profile = this.options.profiles?.[profileId];
    const hasApiKey = !!(profile && (profile.apiKey || this.options.apiKey));
    const connected = !this._destroyed && !!this.client && this.connectedAgents?.has(profileId) === true
      && this._authStates.get(profileId) === true;
    const unambiguous = !this._profileConnectionConflict(profileId, profile || {}, false);
    return { profileId, port: profile?.port || this.options.port || DEFAULT_PORT,
      hasApiKey, connected: connected && unambiguous, ready: hasApiKey && connected && unambiguous };
  }

  /**
   * Start one owned gateway and retain bounded diagnostics for readiness checks.
   */
  _launchGateway(profileId: string) {
    const child: ChildProcess = spawn(resolveHermesCommand(), ['--profile', profileId, 'gateway', 'run', '--replace'], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' },
    });
    let stderr = '', failure = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on('error', (error: Error) => { failure = sanitizeCliDiagnostic(error.message); });
    child.on('close', (code, signal) => {
      failure ||= sanitizeCliDiagnostic(`exit=${code} signal=${signal || 'none'}: ${stderr}`);
      if (this._gatewayChildren?.get(profileId) === child) {
        this._gatewayChildren.delete(profileId);
        this._invalidateProfile(profileId);
      }
    });
    child.unref();
    (child.stderr as any)?.unref?.();
    if (!this._gatewayChildren) this._gatewayChildren = new Map<string, ChildProcess>();
    this._gatewayChildren.set(profileId, child);
    return { failure: () => failure || (child.exitCode !== null || child.signalCode
      ? sanitizeCliDiagnostic(`exit=${child.exitCode} signal=${child.signalCode || 'none'}: ${stderr}`) : null) };
  }

  async _ensureGatewayRunning(profileId?: string, forceRestart = false): Promise<boolean> {
    if (this._destroyed || !profileId || !this.options.profiles?.[profileId]
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
      this.addLog('Hermes HTTP 不可用：处理器已停止或未绑定有效 profile');
      return false;
    }
    if (!(this.options.profiles[profileId].apiKey || this.options.apiKey) || !this.client) return false;
    const pending = this._gatewayStarts.get(profileId);
    if (pending) return pending;
    const operation = this._startGateway(profileId, forceRestart);
    this._gatewayStarts.set(profileId, operation);
    try { return await operation; }
    finally { if (this._gatewayStarts.get(profileId) === operation) this._gatewayStarts.delete(profileId); }
  }

  async _startGateway(profileId: string, forceRestart: boolean): Promise<boolean> {
    const client = this.client!;
    const generation = this._lifecycleGeneration;
    const current = () => !this._destroyed && this.client === client && generation === this._lifecycleGeneration;
    const ready = () => {
      if (!current()) return false;
      if (!this.connectedAgents) this.connectedAgents = new Set();
      this.connectedAgents.add(profileId);
      this._authStates.set(profileId, true);
      this.connected = client.connected = true;
      this.emit('status', { connected: true, enabled: this.enabled });
      return true;
    };
    if (!forceRestart && this._authStates.get(profileId) === true
      && (this.connectedAgents === null || this.connectedAgents.has(profileId))
      && !this._profileConnectionConflict(profileId, this.options.profiles?.[profileId] || {}, false)) return ready();
    try {
      if (!forceRestart) {
        const authenticated = await this._selectAuthenticatedProfileConnection(profileId);
        if (!current()) return false;
        if (authenticated) return ready();
      }
      if (!current()) return false;
      // A cached/authenticated alternative does not change the native launch environment.
      const launchConnection = this._readProfileConnections(profileId)[0] || this.options.profiles[profileId];
      const launchConflict = this._profileConnectionConflict(profileId, launchConnection);
      if (launchConflict) {
        this.addLog('HERMES_PROFILE_ROUTE_AMBIGUOUS: 未启动 gateway profile=' + profileId
          + ' conflict=' + launchConflict + ' port=' + (launchConnection.port || this.options.port || DEFAULT_PORT)
          + ' source=' + (launchConnection.connectionSource || 'configured'));
        this._invalidateProfile(profileId);
        return false;
      }
      this.addLog(`🔧 gateway ${forceRestart ? '重启' : '启动'} profile=${profileId} port=${client._agentPort(profileId)}...`);
      const startup = this._launchGateway(profileId);
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        if (!current()) return false;
        const failure = startup.failure();
        if (failure) { this.addLog(`❌ gateway 启动失败 ${profileId}: ${failure}`); return false; }
        const authenticated = await this._selectAuthenticatedProfileConnection(profileId);
        if (!current()) return false;
        if (authenticated) {
          this.addLog(`✅ gateway 已就绪 ${profileId} port=${client._agentPort(profileId)}`);
          return ready();
        }
      }
      this.addLog(`❌ gateway 启动超时 ${profileId}`);
      return false;
    } catch (error) {
      this.addLog(`❌ gateway 启动失败 ${profileId}: ${sanitizeCliDiagnostic(errorMessage(error))}`);
      return false;
    }
  }

  /** 401 recovery shares the same per-profile startup and cancellation boundary. */
  async _restartGateway(profileId: string): Promise<boolean> {
    return this._ensureGatewayRunning(profileId, true);
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
        const pending = (error as any)?.deliveryOutcome === 'outcome_unknown'
          || (error as any)?.code === 'ECONNRESET' || /timeout|timed out|超时|socket hang up|ECONNRESET/i.test(detail);
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
    const generation = this._lifecycleGeneration;
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
    const gatewayReady = await this._ensureGatewayRunning(profileId);
    if (!gatewayReady || !this.connected || !this.client) {
      throw notDeliveredError(`Hermes gateway is unavailable for profile ${profileId}`);
    }
    const client = this.client;

    try {
      await extraData?.assertSubmissionCurrent?.();
      this._assertCurrentClient(client, generation, profileId);
      const result = await client.chat(profileId, sessionKey, visitorId, structuredMsg);
      this._assertCurrentResponse(client, generation);
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
      if (!this._isCurrentClient(client, generation)) throw err;
      const message = errorMessage(err);
      // 401 优先重新读取该 profile 的独立 key；仅刷新失败时才重启 gateway。
      if ((err as any)?.statusCode === 401) {
        this._authStates.set(profileId, false);
        if (await this._selectAuthenticatedProfileConnection(profileId)) {
          try {
            await extraData?.assertSubmissionCurrent?.();
            this._assertCurrentClient(client, generation, profileId);
            const result = await client.chat(profileId, sessionKey, visitorId, structuredMsg);
            this._assertCurrentResponse(client, generation);
            this._authStates.set(profileId, true);
            this.addLog(`📥 收到回复 ${agentId} (刷新 profile key 后, ${(result.reply || '').length} 字)`);
            this.emit('agent.reply', { agentId, visitorId, content: result.reply, sessionKey, turnId, replyId: result.runId || turnId });
            return;
          } catch (retryErr) {
            this.addLog(`❌ 刷新 profile key 后仍 chat 失败 ${agentId}: ${errorMessage(retryErr)}`);
            if ((retryErr as any)?.statusCode === 401) (retryErr as any).deliveryOutcome = 'not_delivered';
            throw retryErr;
          }
        }
      }
      if ((err as any)?.statusCode === 401 && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            await extraData?.assertSubmissionCurrent?.();
            this._assertCurrentClient(client, generation, profileId);
            const result = await client.chat(profileId, sessionKey, visitorId, structuredMsg);
            this._assertCurrentResponse(client, generation);
            this._authStates.set(profileId, true);
            this.addLog(`📥 收到回复 ${agentId} (401 重启后, ${(result.reply || '').length} 字)`);
            this.emit('agent.reply', { agentId, visitorId, content: result.reply, sessionKey, turnId, replyId: result.runId || turnId });
            return;
          } catch (retryErr) {
            this.addLog(`❌ 重启后仍 chat 失败 ${agentId}: ${errorMessage(retryErr)}`);
            if ((retryErr as any)?.statusCode === 401) (retryErr as any).deliveryOutcome = 'not_delivered';
            throw retryErr;
          }
        }
        throw notDeliveredError('Hermes gateway authentication failed');
      }
      if ((err as any)?.statusCode === 401) (err as any).deliveryOutcome = 'not_delivered';
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
    const generation = this._lifecycleGeneration;
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
    const gatewayReady = await this._ensureGatewayRunning(profileId);
    if (!gatewayReady || !this.connected || !this.client) {
      throw notDeliveredError(`Hermes gateway is unavailable for profile ${profileId}`);
    }

    const client = this.client;
    // hermes steer 本身不 emit agent.reply（其 chat 才 emit），手动补偿以走 onAgentReply → handleAgentReply
    const emitReply = (result: HermesSteerResult): void => {
      if (result?.output && typeof this.emit === 'function') {
        this.emit('agent.reply', { agentId, visitorId, content: result.output, sessionKey, turnId, replyId: turnId });
      }
    };

    try {
      this._assertCurrentClient(client, generation, profileId);
      const result = await client.steer(profileId, sessionKey, visitorId, content);
      this._assertCurrentResponse(client, generation);
      this._authStates.set(profileId, true);
      this.addLog(`✅ steer 完成 ${agentId} (回复 ${(result.output || '').length} 字)`);
      emitReply(result);
      return result;
    } catch (err) {
      if (!this._isCurrentClient(client, generation)) throw err;
      const message = errorMessage(err);
      if ((err as any)?.statusCode === 401) {
        this._authStates.set(profileId, false);
        if (await this._selectAuthenticatedProfileConnection(profileId)) {
          try {
            this._assertCurrentClient(client, generation, profileId);
            const result = await client.steer(profileId, sessionKey, visitorId, content);
            this._assertCurrentResponse(client, generation);
            this._authStates.set(profileId, true);
            this.addLog(`✅ steer 完成 ${agentId} (刷新 profile key 后)`);
            emitReply(result);
            return result;
          } catch (retryErr) {
            this.addLog(`❌ 刷新 profile key 后 steer 仍失败 ${agentId}: ${errorMessage(retryErr)}`);
            if ((retryErr as any)?.statusCode === 401) (retryErr as any).deliveryOutcome = 'not_delivered';
            throw retryErr;
          }
        }
      }
      if ((err as any)?.statusCode === 401 && this._mark401Restart(profileId)) {
        if (await this._restartGateway(profileId)) {
          try {
            this._assertCurrentClient(client, generation, profileId);
            const result = await client.steer(profileId, sessionKey, visitorId, content);
            this._assertCurrentResponse(client, generation);
            this._authStates.set(profileId, true);
            this.addLog(`✅ steer 完成 ${agentId} (401 重启后)`);
            emitReply(result);
            return result;
          } catch (retryErr) {
            this.addLog(`❌ 重启后 steer 仍失败 ${agentId}: ${errorMessage(retryErr)}`);
            if ((retryErr as any)?.statusCode === 401) (retryErr as any).deliveryOutcome = 'not_delivered';
            throw retryErr;
          }
        }
        throw notDeliveredError('Hermes gateway authentication failed');
      }
      if ((err as any)?.statusCode === 401) (err as any).deliveryOutcome = 'not_delivered';
      this.addLog(`❌ steer 失败 ${agentId}: ${message}`);
      throw err;
    }
  }

  /**
   * 清理资源
   */
  async destroy(preserveListeners = false): Promise<void> {
    this._destroyed = true;
    this._lifecycleGeneration++;
    this._gatewayStarts.clear();
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
    this.enabled = false;
    this.connected = false;
    this.connectedAgents = new Set();
    this._authStates.clear();
    this._authChecks.clear();
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
    if (!preserveListeners) this.removeAllListeners();
  }

  // ─────────────────────────────────────────────
  // PushProvider 接口补充（healthCheck / steer 已存在）
  // ─────────────────────────────────────────────

  /** 长连接通道：路由优先级高于 CLI 兜底（数大优先）。 */
  get priority() { return 10; }
  getTurnTimeoutMs(): number { return 120_000; }

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

  acceptsBinding(binding: PushPayload['providerBinding'], agentId: string): boolean {
    const profileId = this._profileForAgent(agentId);
    return !!profileId
      && binding?.providerType === 'hermes'
      && binding.providerInstanceId === profileId
      && binding.adapterType === 'hermes-http'
      && binding.deliveryMode === 'http'
      && new RegExp(`^hermes:${agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(binding.nativeSessionId);
  }

  /** Pure capability check: no gateway start, model call or session creation. */
  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    return this.isAvailable(agentId)
      && binding?.nativeSessionNamespace === 'hermes-http'
      && binding.restoreCompatibilityGroup === 'hermes-http'
      && this.acceptsBinding(binding, agentId);
  }

  /** 建立连接：启用 HermesApiClient（gateway 按需在 sendToSession/steer 内 spawn）。 */
  async start() {
    this.setEnabled(true);
  }

  async stop() {
    try { await this.destroy(true); } catch (_) {}
  }

  /** 推送一条访客消息（构造 sessionKey 后走 sendToSession）。 */
  async push(payload: PushPayload): Promise<unknown> {
    const { agentId, fromUid, senderUid, content, channelId, channelType, contentType, messageId, turnId, timestamp } = payload;
    const profileId = this._profileForAgent(agentId);
    const sessionIdentity = String((payload as any).sessionScopeId || fromUid);
    const canResumeBinding = this.acceptsBinding(payload.providerBinding, agentId);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : `hermes:${agentId}:${sessionIdentity}`;
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
    const providerTurnId = String(turnId || messageId || `hermes-http-${Date.now()}`);
    const staged = stageProviderAttachments(payload, { cwd: os.tmpdir(), agentId, turnId: providerTurnId });
    const effectivePayload = staged.attachments.length ? { ...payload, attachments: staged.attachments } : payload;
    const prompt = appendProviderAttachmentBoundary(
      buildConversationDeliveryPrompt(this.db, effectivePayload, canResumeBinding), effectivePayload);
    try {
      await this.sendToSession(sessionKey, prompt, { senderUid, channelId, channelType, contentType, messageId, turnId, timestamp, assertSubmissionCurrent: payload.assertSubmissionCurrent });
      return { nativeSessionId: sessionKey, providerInstanceId: profileId,
        deliveryMode: 'http', adapterType: 'hermes-http',
        attachmentDelivery: { transportDelivered: staged.attachments.length > 0,
          attachmentAccessed: null, contentUnderstood: null,
          mode: staged.attachments.length ? 'staged_path' : 'none' } };
    } finally {
      staged.cleanup();
    }
  }

  async runLoopbackTest(agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) return { ok: false, code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) return { ok: false, code: 'LOOPBACK_CHALLENGE_INVALID' };
    const profileId = this._profileForAgent(agentId);
    if (!profileId || !(await this._ensureGatewayRunning(profileId)) || !this.client) {
      return { ok: false, code: 'LOOPBACK_RUNTIME_UNAVAILABLE' };
    }
    const visitorId = `loopback-${challenge}`;
    const sessionKey = `hermes:${agentId}:${visitorId}`;
    const structured = JSON.stringify({ type: 'message',
      content: `VOKO isolated loopback test. Do not use tools. Reply with exactly: ${challenge}`,
      fromUid: visitorId, channelId: visitorId, channelType: 1, contentType: 1,
      messageId: challenge, timestamp: Math.floor(Date.now() / 1000) });
    const result = await this.client.chat(profileId, sessionKey, visitorId, structured);
    const matched = String(result.reply || '').trim() === challenge;
    return { ok: matched, challengeMatched: matched, status: matched ? 'loopback_verified' : 'failed',
      detail: matched ? 'Hermes HTTP loopback verified' : 'Hermes HTTP did not return the exact challenge',
      loopbackSessionId: sessionKey };
  }

  useDispatcherSessionPersistence(): void { this._bindingStore = null; }
}

/** 杀进程树：Windows taskkill /F /T，Unix 进程组 SIGKILL。用于清理 detached 的 gateway 子进程。 */
function _killTree(pid?: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore', timeout: 3000, windowsHide: true,
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) {}
}

module.exports = HermesHttpProvider;
