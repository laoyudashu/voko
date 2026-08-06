/**
 * acp-adapter.js — ACP（Agent Client Protocol）Provider
 *
 * 通过 stdio + NDJSON（JSON-RPC）与 ACP 兼容的 agent 通信。
 * VOKO 作为 ACP 客户端，agent 作为 ACP 服务端。
 *
 * 工作流：
 *   push() → 确保 agent 子进程 + ACP 连接就绪
 *          → 获取/复用 session（按 visitorId）
 *          → session.prompt(content) → 流式读取 session/update → emit agent.reply
 *
 * 与现有 openclaw-ws/hermes-http 完全隔离（backend_type 路由差异）。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable, Writable } = require('stream');
const { PushProvider } = require('../dispatcher/base-provider');
const { runCli, sanitizeCmdArg, checkCliAvailable } = require('./cli-spawner');
const { createParser } = require('./cli-parsers');
const { buildConversationRecoveryPrompt } = require('../dispatcher/conversation-context');
const { ProviderConversationBindingStore } = require('../provider-conversation-bindings');
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { DatabaseLike } from '../../types/database';
import type { RuntimeRequest, AgentRuntimeResolver, ResolvedRuntime } from '../runtime/agent-runtime-resolver';
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');
import type { AgentMeta, PushPayload, SessionMode } from '../dispatcher/types';

interface CliFallbackOptions {
  cmd: string;
  args?: string[];
  argsForPayload?: (payload: PushPayload) => string[];
  sessionIdFromLine?: (line: string) => string | null;
  adapterType?: string;
  parser?: string;
  timeout?: number;
  stdinPrompt?: boolean;
  afterRun?: (payload: PushPayload) => void;
}

export interface AcpAdapterOptions {
  name?: string;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  cliPath?: string | null;
  runtimeRequest?: RuntimeRequest;
  runtimeResolver?: AgentRuntimeResolver;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  connectTimeout?: number;
  cliFallback?: CliFallbackOptions | null;
  matchType?: string;
  bindingProviderType?: string;
  adapterType?: string;
  cwd?: string;
  sessionRequest?: (agentId: string) => Record<string, unknown>;
  connectionKey?: (agentId: string) => string;
  contextWindow?: number;
  streamFactory?: (
    agentId: string,
  ) => Promise<{ stream: unknown; close?: () => void | Promise<void> }>;
}

interface AcpSession {
  sessionId: string;
  prompt(content: string): Promise<void>;
  nextUpdate(): Promise<AcpUpdate>;
  dispose(): void;
}

interface AcpUpdate {
  kind: string;
  update?: {
    sessionUpdate?: string;
    content?: { text?: string };
  };
  notification?: {
    update?: {
      sessionUpdate?: string;
      content?: { text?: string };
    };
  };
}

interface AcpAgentContext {
  buildSession(options: { cwd: string; mcpServers: unknown[] }): { start(): Promise<AcpSession> };
  request(method: unknown, params: unknown): Promise<unknown>;
  attachSession(response: unknown): AcpSession;
}

interface AcpAgentState {
  child: ChildProcessWithoutNullStreams | null;
  transportAlive: boolean;
  transportClose: (() => void | Promise<void>) | null;
  agentCtx: AcpAgentContext | null;
  agentIds: Set<string>;
  lifecycleEpoch: number;
  sessions: Map<string, AcpSession>;
  ready: Promise<void>;
  _readyResolve: (() => void) | null;
  _shutdownResolve: (() => void) | null;
}

interface AcpAgentHealth {
  available: boolean;
  reason: string;
  changedAt: number;
}

interface AcpSdk {
  ndJsonStream(output: unknown, input: unknown): unknown;
  client(options?: { name?: string }): {
    onRequest(method: unknown, handler: (context: { params: unknown }) => unknown): {
      connectWith(
        stream: unknown,
        callback: (agentContext: AcpAgentContext) => Promise<void>,
      ): Promise<void>;
    };
    connectWith(
      stream: unknown,
      callback: (agentContext: AcpAgentContext) => Promise<void>,
    ): Promise<void>;
  };
  methods: {
    agent: { session: { load?: unknown; resume?: unknown } };
    client: { session: { requestPermission: unknown } };
  };
}

interface SessionHandleRow {
  session_handle?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 单次回复大小上限（防 agent 输出失控撑爆内存）
const MAX_REPLY_CHARS = 2 * 1024 * 1024; // 2MB

// ── ACP Adapter ───────────────────────────────────────────────────────

class AcpAdapter extends PushProvider {
  _acpSdk: AcpSdk | null;
  _adapterType: string;
  _bindingProviderType: string;
  _recoveryNeededSessions: Set<string>;
  _agentHealth: Map<string, AcpAgentHealth>;
  _recoveryPromises: Map<string, Promise<boolean>>;
  _recoveryEpoch: number;
  _providerStopped: boolean;

  /**
   * @param {object} [options]
   * @param {string} [options.name]           - 显示名称，用于日志（如 'GOOSE'、'CLAUDE'）
   * @param {object} [options.db]             - better-sqlite3 实例（session 句柄持久化用）
   * @param {string} [options.cliPath]        - 显式指定 ACP agent CLI 路径
   * @param {string[]} [options.args]         - 传给 CLI 的额外参数（如 goose 需要 ['acp']）
   * @param {object} [options.env]            - 注入子进程的额外环境变量
   * @param {number} [options.connectTimeout] - 连接超时 ms（默认 15000）
   * @param {object} [options.cliFallback]    - ACP 降级 CLI 配置。提供后 ACP 失败时自动回退。
   * @param {string}   options.cliFallback.cmd       - CLI 命令
   * @param {string[]} options.cliFallback.args      - 参数（{prompt} 替换为消息）
   * @param {string}   [options.cliFallback.parser]   - 解析器名，默认 'stream-json'
   */
  constructor(options: AcpAdapterOptions = {}) {
    super();
    this.options = options;

    // agentId → { child, agentCtx, sessions, sessionKeys, _readyResolve, _shutdownResolve }
    this._agents = new Map<string, AcpAgentState>();
    this._agentHealth = new Map<string, AcpAgentHealth>();
    this._recoveryPromises = new Map<string, Promise<boolean>>();
    this._recoveryEpoch = 0;
    this._providerStopped = false;

    // DB 引用（session 句柄持久化）
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;

    // 日志前缀（用于区分不同 ACP 实现）
    this._logPrefix = options.name || 'ACP';

    // 精确匹配 backend_type（设了就不再匹配 acp-* 通配）
    this._matchType = options.matchType || null;
    this._bindingProviderType = options.bindingProviderType || this._matchType || 'acp';
    this._adapterType = String(options.adapterType || 'acp').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'acp';

    // ACP SDK（ESM — lazy dynamic import）
    this._acpSdk = null;
    this._recoveryNeededSessions = new Set();

    // ACP 可执行文件必须由具体 provider 显式提供，不再自动探测 Claude Agent ACP。
    this._cliPath = options.cliPath || null;
    this._runtimeRequest = options.runtimeRequest || null;
    this._runtimeResolver = options.runtimeResolver || defaultAgentRuntimeResolver;
    this._resolvedRuntime = null;

    // 额外参数（如 goose acp、codex acp 等）
    this._cliArgs = options.args || [];

    // session 工作目录：默认系统临时目录，避免 agent 把 VOKO 项目根（含 node_modules）
    // 当成工作区去扫描/索引，产生巨量输出导致 OOM
    this._cwd = options.cwd || os.tmpdir();

    // ACP→CLI 优雅降级配置
    this._cliFallback = options.cliFallback || null;

    // 已经 start() 过
    this._started = false;
  }

  get priority() { return 10; }
  get capabilities() { return ['acp', 'streaming', 'session_resume']; }
  get sessionMode(): SessionMode { return 'agent-issued-id'; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    const bt = meta?.backend_type;
    if (!bt) return false;
    // 精确匹配：设了 matchType 就只匹配该值
    if (this._matchType) return bt === this._matchType;
    // 通配匹配：acp 或 acp-*
    return bt === 'acp' || (typeof bt === 'string' && bt.startsWith('acp-'));
  }

  isAvailable(agentId: string): boolean {
    if (agentId && this._agentHealth.get(agentId)?.available === false) return false;
    if (this.options.streamFactory) return true;
    if (this._runtimeRequest) return this._resolveRuntime().available;
    if (!this._cliPath) return false;
    return path.isAbsolute(this._cliPath) || this._cliPath.includes(path.sep)
      ? fs.existsSync(this._cliPath)
      : checkCliAvailable(this._cliPath);
  }

  _resolveRuntime(): ResolvedRuntime {
    this._resolvedRuntime = this._runtimeResolver.resolve(this._runtimeRequest);
    return this._resolvedRuntime;
  }

  _invalidateRuntime(): void {
    if (this._runtimeRequest) this._runtimeResolver.invalidate(this._runtimeRequest);
    this._resolvedRuntime = null;
  }

  _markAgentHealth(agentId: string, available: boolean, reason: string): void {
    if (!agentId) return;
    const previous = this._agentHealth.get(agentId);
    this._agentHealth.set(agentId, { available, reason, changedAt: Date.now() });
    if (!previous || previous.available !== available) {
      this.notifyAvailability({
        backendType: this._matchType || 'acp',
        mode: this._adapterType.includes('ws') ? 'acp_ws' : 'acp',
        agentId,
        available,
        reason,
      });
    }
  }

  _agentStateAlive(state: AcpAgentState | undefined): boolean {
    return !!state?.agentCtx
      && state.transportAlive
      && (!state.child || (!state.child.killed && state.child.exitCode === null));
  }

  _stateForAgent(agentId: string): AcpAgentState | undefined {
    const direct = this._agents.get(agentId);
    if (direct) return direct;
    for (const state of this._agents.values()) {
      if (state.agentIds?.has(agentId)) return state;
    }
    return undefined;
  }

  _connectionKey(agentId: string): string {
    return this.options.connectionKey?.(agentId) || agentId;
  }

  _stateKey(state: AcpAgentState): string | null {
    for (const [key, value] of this._agents) if (value === state) return key;
    return null;
  }

  _markStateHealth(state: AcpAgentState, fallbackAgentId: string, available: boolean, reason: string): void {
    const agentIds = new Set<string>([fallbackAgentId]);
    for (const agentId of state.agentIds || []) agentIds.add(agentId);
    for (const agentId of agentIds) this._markAgentHealth(agentId, available, reason);
  }

  async recover(agentId: string): Promise<boolean> {
    if (!agentId || !this._started || this._providerStopped) return false;
    const recoveryKey = this._connectionKey(agentId);
    const existing = this._recoveryPromises.get(recoveryKey);
    if (existing) return existing;
    const recoveryEpoch = this._recoveryEpoch;

    const recovery = (async () => {
      try {
        await this._ensureAgent(agentId, true);
        if (this._providerStopped || recoveryEpoch !== this._recoveryEpoch) return false;
        const state = this._stateForAgent(agentId);
        if (!state || !this._agentStateAlive(state)) throw new Error('ACP recovery did not produce a live process');
        this._markStateHealth(state, agentId, true, 'recovered');
        return true;
      } catch (error) {
        if (this._providerStopped || recoveryEpoch !== this._recoveryEpoch) return false;
        this._markAgentHealth(agentId, false, `recovery-failed:${errorMessage(error)}`);
        return false;
      }
    })();
    this._recoveryPromises.set(recoveryKey, recovery);
    try {
      return await recovery;
    } finally {
      if (this._recoveryPromises.get(recoveryKey) === recovery) this._recoveryPromises.delete(recoveryKey);
    }
  }

  async start() {
    if (this._providerStopped) this._agentHealth.clear();
    this._providerStopped = false;
    this._started = true;
    this.notifyAvailability({ backendType: this._matchType || 'acp', mode: this._adapterType.includes('ws') ? 'acp_ws' : 'acp', available: this.isAvailable(''), reason: 'provider-started' });
    // ACP SDK 推迟到第一次 push 时 lazy-load（ESM 动态 import）
  }

  async stop() {
    this._recoveryEpoch += 1;
    this._recoveryPromises.clear();
    this._providerStopped = true;
    for (const [agentId, state] of [...this._agents]) {
      this._disconnectAgent(agentId, state, 'provider-stopped');
    }
    this._agents.clear();
    for (const agentId of this._agentHealth.keys()) {
      this._markAgentHealth(agentId, false, 'provider-stopped');
    }
    this._started = false;
  }

  /**
   * 推送访客消息给 ACP agent。
   * ACP 连接失败且有 cliFallback 配置时，自动降级为 CLI stdout 模式。
   */
  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    if (!agentId || !fromUid || content == null) {
      throw new Error(`[${this._logPrefix}] push 参数不完整: agentId=${agentId} fromUid=${fromUid}`);
    }

    // ── 尝试 ACP 路径 ──
    if (this._cliPath || this._runtimeRequest || this.options.streamFactory) {
      try {
        await this._pushViaAcp(payload);
        return;
      } catch (err) {
        console.error(`[${this._logPrefix}] push via ACP 失败 agent=${agentId}: ${errorMessage(err)}`);
        // 有降级配置 → 继续走 CLI fallback
        if (!this._cliFallback) {
          const deliveryError = err instanceof Error ? err : new Error(String(err));
          this._emitError(payload, deliveryError);
          throw deliveryError;
        }
        console.error(`[${this._logPrefix}] 降级到 CLI stdout 模式 agent=${agentId}`);
      }
    }

    // ── CLI fallback ──
    if (this._cliFallback) {
      await this._pushViaCli(payload);
      return;
    }

    // 无 ACP 无 CLI fallback → 报错
    this._emitError(payload, new Error(`ACP agent CLI 未找到（agentId=${agentId}）`));
    const unavailable = new Error(`ACP provider unavailable for agentId=${agentId}`);
    (unavailable as any).deliveryOutcome = 'not_delivered';
    throw unavailable;
  }

  async healthCheck(): Promise<{
    ok: boolean;
    agents: Record<string, { ok: boolean; status: string }>;
  }> {
    const result: {
      ok: boolean;
      agents: Record<string, { ok: boolean; status: string }>;
    } = { ok: true, agents: {} };
    const agentIds = new Set<string>(this._agentHealth.keys());
    for (const [stateKey, state] of this._agents) {
      if (state.agentIds?.size) {
        for (const agentId of state.agentIds) agentIds.add(agentId);
      } else {
        agentIds.add(stateKey);
      }
    }
    const handledStateKeys = new Set<string>();
    for (const agentId of agentIds) {
      const state = this._stateForAgent(agentId);
      const stateKey = state ? this._stateKey(state) : null;
      if (stateKey && handledStateKeys.has(stateKey)) continue;
      if (stateKey) handledStateKeys.add(stateKey);
      const affectedAgentIds = new Set<string>(state?.agentIds || []);
      affectedAgentIds.add(agentId);
      const alive = this._agentStateAlive(state);
      if (!alive) {
        if (state) this._disconnectAgent(agentId, state, 'process-dead');
        const recovered = await this.recover(agentId);
        const status = recovered
          ? { ok: true, status: 'recovered' }
          : { ok: false, status: 'process_dead' };
        for (const affectedAgentId of affectedAgentIds) result.agents[affectedAgentId] = status;
        if (!recovered) result.ok = false;
      } else {
        for (const affectedAgentId of affectedAgentIds) {
          this._markAgentHealth(affectedAgentId, true, 'connected');
          result.agents[affectedAgentId] = { ok: true, status: 'connected' };
        }
      }
    }
    return result;
  }

  // ── ACP 路径 ──────────────────────────────────────────────────────

  /** 通过 ACP session/prompt 发送消息并流式读取回复 */
  async _pushViaAcp(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `acp-${Date.now()}`);
    const state = await this._ensureAgent(agentId);

    let session: AcpSession;
    try {
      session = await this._ensureSession(state, agentId, fromUid, payload);
      console.error(`[${this._logPrefix}:${agentId}] session 已就绪`);
    } catch (err) {
      console.error(`[${this._logPrefix}:${agentId}] session/new 失败: ${errorMessage(err)}`);
      if (!(err as any)?.deliveryOutcome) (err as any).deliveryOutcome = 'not_delivered';
      throw err;
    }

    const sessionKey = `acp:${agentId}:${fromUid}`;
    const cacheKey = Array.from(state.sessions.entries()).find(([, value]) => value === session)?.[0] || sessionKey;
    const needsRecovery = this._recoveryNeededSessions.delete(cacheKey);
    let fullContent = '';

    try {
      console.error(`[${this._logPrefix}:${agentId}] 发送 session/prompt...`);
      const promptPromise = session.prompt(
        needsRecovery
          ? this._wrapVisitorPrompt(content, payload)
          : this._wrapVisitorPrompt(content),
      );
      promptPromise.catch((err: unknown) =>
        console.error(`[${this._logPrefix}:${agentId}] session/prompt 失败: ${errorMessage(err)}`)
      );
      const promptFailure = promptPromise.then<never, null>(
        () => new Promise<never>(() => {}),
        () => null,
      );

      // prompt 立即失败时 promptPromise 已是 rejected — 但 nextUpdate() 可能
      // 永远收不到 stop（session 已失效），需要 race 两个 promise
      let stopReceived = false;

      for (;;) {
        const update = await Promise.race([
          session.nextUpdate().then((update: AcpUpdate) => update),
          promptFailure,
        ]);

        // prompt 已失败且无 stop 事件 → 提前退出
        if (update === null) {
          await promptPromise;
          break;
        }

        if (update.kind === 'stop') { stopReceived = true; break; }

        if (update.kind === 'session_update') {
          const u = update.update || update.notification?.update;
          if (!u) continue;

          const chunk = u.sessionUpdate === 'agent_message_chunk' && u.content?.text;

          if (chunk) {
            fullContent += chunk;
            // 熔断：回复失控（如 agent 扫描巨量工作区）时截断，防 OOM 撑爆进程
            if (fullContent.length > MAX_REPLY_CHARS) {
              console.error(`[${this._logPrefix}:${agentId}] 回复超过 ${MAX_REPLY_CHARS} 字符上限，截断以防 OOM`);
              fullContent = fullContent.slice(0, MAX_REPLY_CHARS) + '\n…[回复过长，已截断]';
              state.sessions.delete(cacheKey);
              try { session.dispose(); } catch {}
              this._deleteSessionHandle(agentId, fromUid); // 同步清 DB 持久化句柄，免下次 resume 失效 session
              break;
            }
            this.emit('agent.reply', {
              agentId, visitorId: fromUid,
              content: fullContent, done: false, sessionKey,
              turnId, replyId: turnId,
            });
          }
        }
      }

      if (stopReceived) await promptPromise;
    } catch (err) {
      state.sessions.delete(cacheKey);
      this._deleteSessionHandle(agentId, fromUid);
      if (!(err as any)?.deliveryOutcome) (err as any).deliveryOutcome = 'outcome_unknown';
      throw err;
    }

    this.emit('agent.reply', {
      agentId, visitorId: fromUid,
      content: fullContent, done: true, sessionKey,
      turnId, replyId: turnId,
    });
  }

  // ── CLI Fallback 路径 ─────────────────────────────────────────────

  /** 通过 spawn CLI + stdout 解析发送消息（ACP 不可用时的降级路径） */
  async _pushViaCli(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `acp-cli-${Date.now()}`);
    const fb = this._cliFallback;
    const sessionKey = `acp:${agentId}:${fromUid}`;
    let error: Error | null = null;
    let fullContent = '';
    const payloadBinding = payload.providerBinding;
    let observedSessionId = payloadBinding && payloadBinding.providerType === this._bindingProviderType
      ? payloadBinding.nativeSessionId
      : null;
    const observeSession = (line: string) => {
      if (!fb.sessionIdFromLine) return;
      try { observedSessionId = fb.sessionIdFromLine(line) || observedSessionId; } catch (_) {}
    };

    // Windows 下 {prompt} 经 cmd.exe 传多行/含元字符会被截断或注入（同 cli-adapter/hermes-cli），净化为单行；
    // 函数式 replacement 避免 String.replace 的 $ 模式展开（CODE-5）
    const rawContent = this._wrapVisitorPrompt(content, payload);
    const safeContent = process.platform === 'win32' ? sanitizeCmdArg(rawContent) : rawContent;
    const fallbackArgs = fb.argsForPayload ? fb.argsForPayload(payload) : (fb.args || []);
    const args = fallbackArgs.map((arg: string) =>
      arg.replace(/\{prompt\}/g, () => safeContent)
    );

    const parser = createParser({
      format: fb.parser || 'stream-json',
      onText: (chunk: string) => {
        fullContent += chunk;
        if (fullContent.length > MAX_REPLY_CHARS) fullContent = fullContent.slice(0, MAX_REPLY_CHARS) + '\n…[回复过长，已截断]';
        this.emit('agent.reply', {
          agentId, visitorId: fromUid,
          content: fullContent, done: false, sessionKey,
          turnId, replyId: turnId,
        });
      },
    });

    try {
      const result = await runCli({
        cmd: fb.cmd,
        args,
        tag: `acp-fallback-${agentId}`,
        timeout: fb.timeout || 120000,
        env: this.options.env,
        cwd: this._cwd,
        stdinInput: fb.stdinPrompt ? `${rawContent.replace(/\s*[\r\n]+\s*/g, ' ').trim()}\n` : undefined,
        logOutput: false,
        onStdoutLine: (line: string) => parser.handleLine(line),
        onStderrLine: observeSession,
      });

      if (fb.sessionIdFromLine) {
        for (const line of result.stdout.split(/\r?\n/)) observeSession(line);
      }
      if (result.code !== 0) error = new Error(`CLI fallback exited with code ${result.code}`);
      parser.finish();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      try { fb.afterRun?.(payload); } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (error) throw error;
    if (observedSessionId && this._bindingStore) {
      const binding = payload.providerBinding?.providerType === this._bindingProviderType
        ? payload.providerBinding
        : null;
      const channelId = binding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
      const channelType = binding?.channelType || (payload.channelType === 2 ? 2 : 1);
      if (binding && observedSessionId === binding.nativeSessionId) {
        this._bindingStore.touch(binding.id);
      } else {
        this._bindingStore.saveManaged({
          agentId,
          channelId,
          channelType,
          providerType: this._bindingProviderType,
          providerInstanceId: binding?.providerInstanceId || null,
          nativeSessionId: observedSessionId,
          deliveryMode: 'cli',
          adapterType: fb.adapterType || `${this._adapterType}-cli-fallback`,
          expectedVersion: binding?.bindingVersion ?? 0,
        });
      }
    }
    if (!fullContent.trim()) throw new Error('CLI fallback produced no reply');

    this.emit('agent.reply', {
      agentId, visitorId: fromUid,
      content: fullContent,
      done: true, sessionKey,
      turnId, replyId: turnId,
    });
  }

  /** 直接发射错误回复（无可用路径时） */
  _emitError(payload: PushPayload, err: Error): void {
    const turnId = String(payload.turnId || payload.messageId || `acp-error-${Date.now()}`);
    this.emit('agent.reply', {
      agentId: payload.agentId,
      visitorId: payload.fromUid,
      content: `[ACP Error] ${err.message}`,
      done: true,
      sessionKey: `acp:${payload.agentId}:${payload.fromUid}`,
      turnId,
      replyId: `${turnId}:error`,
      error: { code: 'acp_unavailable', message: err.message },
    });
  }

  /** Dispatcher 已统一附加安全上下文；这里只保留 ACP 消息标签。 */
  _wrapVisitorPrompt(content: string, payload?: PushPayload): string {
    if (!payload) return `【外部消息】\n${content}`;
    const prompt = buildConversationRecoveryPrompt(
      this._db,
      payload,
      this.options.contextWindow ?? 30,
    );
    return prompt === content ? `【外部消息】\n${content}` : prompt;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Lazy-load ACP SDK（ESM → CJS dynamic import） */
  async _loadSdk(): Promise<AcpSdk> {
    if (this._acpSdk) return this._acpSdk;
    this._acpSdk = await import('@agentclientprotocol/sdk') as unknown as AcpSdk;
    return this._acpSdk;
  }

  /** 确保 agent 子进程运行 + ACP 连接就绪。返回状态对象。 */
  async _ensureAgent(agentId: string, allowRecovery = false): Promise<AcpAgentState> {
    const stateKey = this._connectionKey(agentId);
    const lifecycleEpoch = this._recoveryEpoch;
    if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
      const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled before startup`);
      (cancelled as any).deliveryOutcome = 'not_delivered';
      throw cancelled;
    }
    const existing = this._agents.get(stateKey);
    const childAlive = !!existing?.child && !existing.child.killed && existing.child.exitCode === null;
    const associatedAgentIds = new Set<string>(existing?.agentIds || []);
    associatedAgentIds.add(agentId);
    if (existing && !existing.agentIds) existing.agentIds = new Set<string>();
    if (existing) existing.agentIds.add(agentId);
    if (existing && !existing.agentCtx && existing.transportAlive) {
      const timeout = this.options.connectTimeout || 15000;
      let timer: NodeJS.Timeout | null = null;
      await Promise.race([
        existing.ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
        const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled while waiting for connection`);
        (cancelled as any).deliveryOutcome = 'not_delivered';
        throw cancelled;
      }
      const existingEpochIsCurrent = existing.lifecycleEpoch == null
        || existing.lifecycleEpoch === this._recoveryEpoch;
      if (existing.agentCtx && existing.transportAlive && existingEpochIsCurrent
        && !this._providerStopped) {
        if (!allowRecovery && this._agentHealth.get(agentId)?.available === false) {
          const unavailable = new Error('[' + this._logPrefix + '] ACP process is unavailable for agentId=' + agentId);
          (unavailable as any).deliveryOutcome = 'not_delivered';
          throw unavailable;
        }
        return existing;
      }
    }
    if (existing && existing.agentCtx && (childAlive || existing.transportAlive)) {
      if (!allowRecovery && this._agentHealth.get(agentId)?.available === false) {
        const unavailable = new Error('[' + this._logPrefix + '] ACP process is unavailable for agentId=' + agentId);
        (unavailable as any).deliveryOutcome = 'not_delivered';
        throw unavailable;
      }
      return existing;
    }
    // 清理僵死状态
    if (existing) this._disconnectAgent(agentId, existing, 'reconnecting');

    if (!allowRecovery && this._agentHealth.get(agentId)?.available === false) {
      const unavailable = new Error(`[${this._logPrefix}] ACP process is unavailable for agentId=${agentId}`);
      (unavailable as any).deliveryOutcome = 'not_delivered';
      throw unavailable;
    }

    if (!this._cliPath && !this._runtimeRequest && !this.options.streamFactory) {
      throw new Error(`[${this._logPrefix}] ACP agent CLI 未配置（agentId=${agentId}）`);
    }

    console.error(`[${this._logPrefix}:${agentId}] 开始初始化 ACP 连接 (cli=${this._cliPath ? path.basename(this._cliPath) : (this._runtimeRequest?.providerId || '-')})`);
    const sdk = await this._loadSdk();
    if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
      const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled during startup`);
      (cancelled as any).deliveryOutcome = 'not_delivered';
      throw cancelled;
    }
    console.error(`[${this._logPrefix}:${agentId}] ACP SDK 已加载，准备 spawn 子进程`);

    // ── 状态容器 ──
    let readyResolve: (() => void) | null = null;

    const state: AcpAgentState = {
      child: null,
      transportAlive: true,
      transportClose: null,
      agentCtx: null,
      agentIds: associatedAgentIds,
      lifecycleEpoch,
      sessions: new Map(),       // sessionKey → ActiveSession
      ready: new Promise<void>(resolve => { readyResolve = resolve; }),
      _readyResolve: readyResolve,
      _shutdownResolve: null,
    };

    // ── Spawn ACP agent ──
    // .exe/.js 等有扩展名的直接 spawn；无扩展名但非 node_modules 路径也直接 spawn（如 goose）
    let stream: unknown;
    if (this.options.streamFactory) {
      const transport = await this.options.streamFactory(agentId);
      if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
        try { await transport.close?.(); } catch {}
        const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled before connection`);
        (cancelled as any).deliveryOutcome = 'not_delivered';
        throw cancelled;
      }
      stream = transport.stream;
      state.transportClose = transport.close || null;
    } else {
      const runtime = this._runtimeRequest ? this._resolveRuntime() : null;
      if (runtime && (!runtime.available || !runtime.executable)) {
        const unavailable = new Error(`[${this._logPrefix}] ACP runtime not found`);
        (unavailable as any).deliveryOutcome = 'not_delivered';
        throw unavailable;
      }
      const cliPath = this._cliPath as string;
      const isNodeScript = !runtime && cliPath.endsWith('.js');
      const cmd = runtime?.executable || (isNodeScript ? process.execPath : cliPath);
      const cmdArgs = runtime ? [...runtime.argvPrefix, ...this._cliArgs] : (isNodeScript ? [cliPath, ...this._cliArgs] : [...this._cliArgs]);
      console.error(`[${this._logPrefix}:${agentId}] Spawning ACP runtime: ${path.basename(cmd)}`);
      const child = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: this._cwd,
        env: {
          ...process.env,
          ...this.options.env,
          // A3: 注入 agent 回调环境变量（agent 可通过 HTTP 回调 voko）
          VOKO_API_URL: this.options.env?.VOKO_API_URL || process.env.VOKO_API_URL || '',
        },
      });
      state.child = child;
      if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
        try { child.kill(); } catch {}
        const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled after spawn`);
        (cancelled as any).deliveryOutcome = 'not_delivered';
        throw cancelled;
      }
      console.error(`[${this._logPrefix}:${agentId}] 子进程已启动 PID=${child.pid}`);

      // stderr → console（agent 诊断日志走 stderr，不影响 ACP stdout 流）
      child.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[${this._logPrefix}:${agentId}] ${msg}`);
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        state.transportAlive = false;
        const currentState = this._agents.get(stateKey);
        if (!this._providerStopped && state.lifecycleEpoch === this._recoveryEpoch
          && (!currentState || currentState === state)) {
          this._markStateHealth(state, agentId, false, 'process-exit:' + (code ?? signal ?? 'unknown'));
        }
        console.error(`[${this._logPrefix}:${agentId}] 进程退出 code=${code} signal=${signal}`);
        state.sessions.clear();
        if (this._agents.get(stateKey) === state) {
          this._agents.delete(stateKey);
        }
      });

      child.on('error', (err: Error) => {
        const currentState = this._agents.get(stateKey);
        if (this._providerStopped || state.lifecycleEpoch !== this._recoveryEpoch
          || (currentState && currentState !== state)) return;
        this._markStateHealth(state, agentId, false, 'process-error:' + err.message);
        if (/ENOENT|EACCES/i.test(String((err as any).code || err.message))) this._invalidateRuntime();
        console.error(`[${this._logPrefix}:${agentId}] 进程错误: ${err.message}`);
      });

      // ── 创建 ACP NDJSON 流（Node stream → Web stream） ──
      stream = sdk.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
    }

    // Make a pending state visible before the handshake starts. This lets stop()
    // cancel streamFactory and ACP handshakes instead of leaving an untracked
    // transport/process behind.
    this._agents.set(stateKey, state);

    // ── 客户端连接（用 connectWith 确保 initialize 握手完成） ──
    console.error(`[${this._logPrefix}:${agentId}] ACP NDJSON 流已创建，开始 connectWith...`);
    const keepAlivePromise = new Promise<void>(resolve => {
      state._shutdownResolve = resolve;
    });

    // 后台启动连接（不 await；用 state.ready 等首次就绪）
    const client = sdk.client({ name: 'voko-lite' });
    client.onRequest(sdk.methods.client.session.requestPermission, () => {
      console.warn(`[${this._logPrefix}:${agentId}] ACP tool permission denied by default`);
      return { outcome: { outcome: 'cancelled' } };
    }).connectWith(stream, async (agentCtx: AcpAgentContext) => {
      const currentState = this._agents.get(stateKey);
      if ((currentState && currentState !== state) || state.lifecycleEpoch !== this._recoveryEpoch || this._providerStopped) return;
      console.error(`[${this._logPrefix}:${agentId}] ACP 连接已建立 (initialize 完成)`);
      state.agentCtx = agentCtx;
      this._markStateHealth(state, agentId, true, 'connected');
      if (state._readyResolve) {
        state._readyResolve();
        state._readyResolve = null;
      }
      await keepAlivePromise;
    }).catch((err: unknown) => {
      state.transportAlive = false;
      const currentState = this._agents.get(stateKey);
      if ((currentState && currentState !== state) || state.lifecycleEpoch !== this._recoveryEpoch) return;
      this._markStateHealth(state, agentId, false, 'connection-error:' + errorMessage(err));
      console.error(`[${this._logPrefix}:${agentId}] 连接异常: ${errorMessage(err)}`);
      if (state._readyResolve) {
        state._readyResolve();
        state._readyResolve = null;
      }
      if (this._agents.get(stateKey) === state) this._agents.delete(stateKey);
    });

    // ── 等待连接就绪（超时保护） ──
    const timeout = this.options.connectTimeout || 15000;
    console.error(`[${this._logPrefix}:${agentId}] 等待 ACP 连接就绪（超时 ${timeout}ms）...`);
    let readyTimer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        state.ready,
        new Promise<never>((_, reject) =>
          readyTimer = setTimeout(
            () => reject(new Error(`[${this._logPrefix}] ${agentId} 连接超时 (${timeout}ms)`)),
            timeout,
          )
        ),
      ]);
    } catch (error) {
      if (this._agents.get(stateKey) === state) this._agents.delete(stateKey);
      this._disconnectAgent(agentId, state, 'connection-failed');
      throw error;
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }

    if (this._providerStopped || lifecycleEpoch !== this._recoveryEpoch) {
      if (this._agents.get(stateKey) === state) this._agents.delete(stateKey);
      this._disconnectAgent(agentId, state, 'recovery-cancelled');
      const cancelled = new Error(`[${this._logPrefix}] ACP recovery cancelled before ready`);
      (cancelled as any).deliveryOutcome = 'not_delivered';
      throw cancelled;
    }
    if (!state.agentCtx) {
      throw new Error(`[${this._logPrefix}] ${agentId} 连接初始化失败（agentCtx 未就绪）`);
    }
    if (this._agents.get(stateKey) !== state) this._agents.set(stateKey, state);
    console.error(`[${this._logPrefix}:${agentId}] ACP 连接就绪 (PID=${state.child?.pid})`);
    return state;
  }

  /** 获取或创建 session（按 visitor 复用，支持 DB 持久化 + resume） */
  async _ensureSession(
    state: AcpAgentState,
    agentId: string,
    visitorId: string,
    payload: PushPayload,
  ): Promise<AcpSession> {
    const channelId = payload.providerBinding?.channelId || payload.channelId || visitorId.replace(/^group:/, '');
    const channelType = payload.providerBinding?.channelType || (payload.channelType === 2 ? 2 : 1);
    let binding = payload.providerBinding?.providerType === this._bindingProviderType
      ? payload.providerBinding
      : null;
    if (!binding && this._bindingStore) {
      binding = this._bindingStore.getByAdapter(agentId, channelId, channelType, this._adapterType)
        || this._bindingStore.importLegacy({
          agentId,
          channelId,
          channelType,
          providerType: this._bindingProviderType,
          deliveryMode: this._adapterType.includes('ws') ? 'acp_ws' : 'acp',
          adapterType: this._adapterType,
          legacyVisitorId: visitorId,
        });
    }
    const handle = binding?.nativeSessionId || null;
    const sessionKey = `acp:${agentId}:${channelType}:${channelId}:${handle || 'managed'}`;
    // 1. 内存缓存命中
    const existing = state.sessions.get(sessionKey);
    if (existing) return existing;

    // 2. 尝试从 DB 句柄恢复 session
    if (handle) {
      try {
        const session = await this._resumeSession(state, handle);
        if (session) {
          state.sessions.set(sessionKey, session);
          this._bindingStore?.saveManaged({
            agentId,
            channelId,
            channelType,
            providerType: this._bindingProviderType,
            providerInstanceId: binding?.providerInstanceId || null,
            nativeSessionId: session.sessionId,
            deliveryMode: this._adapterType.includes('ws') ? 'acp_ws' : 'acp',
            adapterType: this._adapterType,
            expectedVersion: binding?.bindingVersion ?? 0,
          });
          return session;
        }
      } catch (err) {
        console.error(`[${this._logPrefix}] session resume 失败 agent=${agentId} visitor=${visitorId}: ${errorMessage(err)}`);
      }
      // resume 失败 → 清除失效句柄
      if (binding?.id) this._bindingStore?.markStale(binding.id);
      this._deleteSessionHandle(agentId, visitorId);
    }

    // 3. 创建新 session
    const agentCtx = state.agentCtx;
    if (!agentCtx) throw new Error(`[${this._logPrefix}] ACP agent context 未就绪`);
    const session = await agentCtx.buildSession({
      cwd: this._cwd,
      mcpServers: [],
      ...(this.options.sessionRequest?.(agentId) || {}),
    }).start();

    // 4. 持久化 session 句柄
    const saved = this._bindingStore?.saveManaged({
      agentId,
      channelId,
      channelType,
      providerType: this._bindingProviderType,
      providerInstanceId: binding?.providerInstanceId || null,
      nativeSessionId: session.sessionId,
      deliveryMode: this._adapterType.includes('ws') ? 'acp_ws' : 'acp',
      adapterType: this._adapterType,
      expectedVersion: binding?.bindingVersion ?? 0,
    });

    state.sessions.set(sessionKey, session);
    if (saved?.nativeSessionId) {
      state.sessions.set(`acp:${agentId}:${channelType}:${channelId}:${saved.nativeSessionId}`, session);
    }
    this._recoveryNeededSessions.add(sessionKey);
    return session;
  }

  /** 持久化 session 句柄到 DB */
  _saveSessionHandle(agentId: string, visitorId: string, sessionId: string): void {
    if (!this._db) return;
    try {
      this._db.prepare(
        `INSERT OR REPLACE INTO agent_session_handles (agent_id, visitor_id, adapter_type, session_handle, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(agentId, visitorId, this._adapterType, sessionId, Date.now());
    } catch (err) {
      console.error(`[${this._logPrefix}] 保存 session 句柄失败: ${errorMessage(err)}`);
    }
  }

  /** 从 DB 读取持久化的 session 句柄 */
  _loadSessionHandle(agentId: string, visitorId: string): string | null {
    if (!this._db) return null;
    try {
      const row = this._db.prepare(
        `SELECT session_handle FROM agent_session_handles WHERE agent_id=? AND visitor_id=? AND adapter_type=?`
      ).get(agentId, visitorId, this._adapterType) as SessionHandleRow | undefined;
      return row?.session_handle || null;
    } catch {
      return null;
    }
  }

  /** 删除 session 句柄（session 失效时） */
  _deleteSessionHandle(agentId: string, visitorId: string): void {
    if (!this._db) return;
    try {
      this._db.prepare(
        `DELETE FROM agent_session_handles WHERE agent_id=? AND visitor_id=? AND adapter_type=?`
      ).run(agentId, visitorId, this._adapterType);
    } catch {}
  }

  /**
   * 尝试恢复 ACP session。
   * 调用 ACP session/resume 方法，用 attachSession 包装返回 ActiveSession。
   */
  async _resumeSession(state: AcpAgentState, sessionId: string): Promise<AcpSession> {
    const sdk = await this._loadSdk();
    const agentCtx = state.agentCtx;
    if (!agentCtx) throw new Error(`[${this._logPrefix}] ACP agent context 未就绪`);
    const params = { sessionId, cwd: this._cwd, mcpServers: [] };
    let response: unknown;
    const loadMethod = sdk.methods.agent.session.load;
    try {
      if (!loadMethod) throw Object.assign(new Error('standard ACP loadSession unavailable'), { code: -32601 });
      response = await agentCtx.request(loadMethod, params);
    } catch (error: any) {
      const methodMissing = Number(error?.code) === -32601
        || /method not found|loadSession unavailable/i.test(errorMessage(error));
      const resumeMethod = sdk.methods.agent.session.resume;
      if (!methodMissing || !resumeMethod) throw error;
      response = await agentCtx.request(resumeMethod, params);
    }
    // attachSession 将 session/resume 响应包装为 ActiveSession
    const responseWithSessionId = response && typeof response === 'object'
      ? { ...(response as Record<string, unknown>), sessionId: (response as any).sessionId || sessionId }
      : { sessionId };
    const session = agentCtx.attachSession(responseWithSessionId);
    // ZeroClaw's resume extension returns an empty object on success, so the
    // requested, already-validated ID is supplied above for the SDK router.
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId.trim()) {
      try { session?.dispose(); } catch {}
      throw new Error('ACP loadSession did not return a valid session ID');
    }
    return session;
  }

  /** 断开 agent 连接，清理资源 */
  _disconnectAgent(agentId: string, state: AcpAgentState, reason = 'disconnected'): void {
    try {
      this._markStateHealth(state, agentId, false, reason);
      if (state._readyResolve) {
        state._readyResolve();
        state._readyResolve = null;
      }
      // 1. 信号 keepAlive 结束 → connectWith callback 退出 → SDK 清理连接
      if (state._shutdownResolve) {
        state._shutdownResolve();
        state._shutdownResolve = null;
      }
      // 2. dispose sessions
      for (const session of state.sessions.values()) {
        try { session.dispose(); } catch {}
      }
      state.sessions.clear();
      // 3. kill 子进程
      if (state.child && !state.child.killed) {
        state.child.kill();
      }
      state.transportAlive = false;
      if (state.transportClose) {
        void Promise.resolve(state.transportClose()).catch(() => {});
        state.transportClose = null;
      }
    } catch (err) {
      console.error(`[${this._logPrefix}] 清理 agent=${agentId} 失败: ${errorMessage(err)}`);
    }
  }
}

module.exports = { AcpAdapter };
