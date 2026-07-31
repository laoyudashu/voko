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
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { DatabaseLike } from '../../types/database';
import type { AgentMeta, PushPayload, SessionMode } from '../dispatcher/types';

interface CliFallbackOptions {
  cmd: string;
  args?: string[];
  parser?: string;
  timeout?: number;
}

export interface AcpAdapterOptions {
  name?: string;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  cliPath?: string | null;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  connectTimeout?: number;
  cliFallback?: CliFallbackOptions | null;
  matchType?: string;
  adapterType?: string;
  cwd?: string;
  sessionRequest?: (agentId: string) => Record<string, unknown>;
  connectionKey?: (agentId: string) => string;
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
  sessions: Map<string, AcpSession>;
  ready: Promise<void>;
  _readyResolve: (() => void) | null;
  _shutdownResolve: (() => void) | null;
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
    agent: { session: { resume: unknown } };
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

    // DB 引用（session 句柄持久化）
    this._db = options.db || null;

    // 日志前缀（用于区分不同 ACP 实现）
    this._logPrefix = options.name || 'ACP';

    // 精确匹配 backend_type（设了就不再匹配 acp-* 通配）
    this._matchType = options.matchType || null;
    this._adapterType = String(options.adapterType || 'acp').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'acp';

    // ACP SDK（ESM — lazy dynamic import）
    this._acpSdk = null;

    // ACP 可执行文件必须由具体 provider 显式提供，不再自动探测 Claude Agent ACP。
    this._cliPath = options.cliPath || null;

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

  isAvailable(_agentId: string): boolean {
    if (this.options.streamFactory) return true;
    if (!this._cliPath) return false;
    return path.isAbsolute(this._cliPath) || this._cliPath.includes(path.sep)
      ? fs.existsSync(this._cliPath)
      : checkCliAvailable(this._cliPath);
  }

  async start() {
    this._started = true;
    // ACP SDK 推迟到第一次 push 时 lazy-load（ESM 动态 import）
  }

  async stop() {
    for (const [agentId, state] of this._agents) {
      this._disconnectAgent(agentId, state);
    }
    this._agents.clear();
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
    if (this._cliPath || this.options.streamFactory) {
      try {
        await this._pushViaAcp(payload);
        return;
      } catch (err) {
        console.error(`[${this._logPrefix}] push via ACP 失败 agent=${agentId}: ${errorMessage(err)}`);
        // 有降级配置 → 继续走 CLI fallback
        if (!this._cliFallback) {
          this._emitError(
            payload,
            err instanceof Error ? err : new Error(String(err)),
          );
          return;
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
  }

  async healthCheck(): Promise<{
    ok: boolean;
    agents: Record<string, { ok: boolean; status: string }>;
  }> {
    const result: {
      ok: boolean;
      agents: Record<string, { ok: boolean; status: string }>;
    } = { ok: true, agents: {} };
    for (const [agentId, state] of this._agents) {
      const alive = state.transportAlive
        && (!state.child || (!state.child.killed && state.child.exitCode === null));
      if (!alive) {
        this._disconnectAgent(agentId, state);
        result.agents[agentId] = { ok: false, status: 'process_dead' };
        result.ok = false;
      } else {
        result.agents[agentId] = { ok: true, status: 'connected' };
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
      session = await this._ensureSession(state, agentId, fromUid);
      console.error(`[${this._logPrefix}:${agentId}] session 创建成功 (sessionId=${session.sessionId})`);
    } catch (err) {
      console.error(`[${this._logPrefix}:${agentId}] session/new 失败: ${errorMessage(err)}`);
      throw err;
    }

    const sessionKey = `acp:${agentId}:${fromUid}`;
    let fullContent = '';

    try {
      console.error(`[${this._logPrefix}:${agentId}] 发送 session/prompt...`);
      const promptPromise = session.prompt(this._wrapVisitorPrompt(content));
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
          try { await promptPromise; } catch {}
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
              state.sessions.delete(sessionKey);
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
      state.sessions.delete(sessionKey);
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

    // Windows 下 {prompt} 经 cmd.exe 传多行/含元字符会被截断或注入（同 cli-adapter/hermes-cli），净化为单行；
    // 函数式 replacement 避免 String.replace 的 $ 模式展开（CODE-5）
    const rawContent = this._wrapVisitorPrompt(content);
    const safeContent = process.platform === 'win32' ? sanitizeCmdArg(rawContent) : rawContent;
    const args = (fb.args || []).map((arg: string) =>
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
        onStdoutLine: (line: string) => parser.handleLine(line),
      });

      if (result.code !== 0) {
        error = new Error(`CLI fallback 退出 code=${result.code}`);
      }
      parser.finish();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }

    this.emit('agent.reply', {
      agentId, visitorId: fromUid,
      content: fullContent || (error ? `[CLI Fallback Error] ${error.message}` : ''),
      done: true, sessionKey,
      turnId, replyId: turnId,
      error: error ? { code: 'cli_fallback_failed', message: error.message } : undefined,
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
  _wrapVisitorPrompt(content: string): string {
    return `【外部消息】\n${content}`;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Lazy-load ACP SDK（ESM → CJS dynamic import） */
  async _loadSdk(): Promise<AcpSdk> {
    if (this._acpSdk) return this._acpSdk;
    this._acpSdk = await import('@agentclientprotocol/sdk') as unknown as AcpSdk;
    return this._acpSdk;
  }

  /** 确保 agent 子进程运行 + ACP 连接就绪。返回状态对象。 */
  async _ensureAgent(agentId: string): Promise<AcpAgentState> {
    const stateKey = this.options.connectionKey?.(agentId) || agentId;
    const existing = this._agents.get(stateKey);
    const childAlive = !!existing?.child && !existing.child.killed && existing.child.exitCode === null;
    if (existing && existing.agentCtx && (childAlive || existing.transportAlive)) {
      return existing;
    }
    // 清理僵死状态
    if (existing) this._disconnectAgent(agentId, existing);

    if (!this._cliPath && !this.options.streamFactory) {
      throw new Error(`[${this._logPrefix}] ACP agent CLI 未配置（agentId=${agentId}）`);
    }

    console.error(`[${this._logPrefix}:${agentId}] 开始初始化 ACP 连接 (cliPath=${this._cliPath})`);
    const sdk = await this._loadSdk();
    console.error(`[${this._logPrefix}:${agentId}] ACP SDK 已加载，准备 spawn 子进程`);

    // ── 状态容器 ──
    let readyResolve: (() => void) | null = null;

    const state: AcpAgentState = {
      child: null,
      transportAlive: true,
      transportClose: null,
      agentCtx: null,
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
      stream = transport.stream;
      state.transportClose = transport.close || null;
    } else {
      const cliPath = this._cliPath as string;
      const isNodeScript = cliPath.endsWith('.js');
      const cmd = isNodeScript ? process.execPath : cliPath;
      const cmdArgs = isNodeScript ? [cliPath, ...this._cliArgs] : [...this._cliArgs];
      console.error(`[${this._logPrefix}:${agentId}] Spawning: ${cmd} ${cmdArgs.join(' ')}`);
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
      console.error(`[${this._logPrefix}:${agentId}] 子进程已启动 PID=${child.pid}`);

      // stderr → console（agent 诊断日志走 stderr，不影响 ACP stdout 流）
      child.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[${this._logPrefix}:${agentId}] ${msg}`);
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        state.transportAlive = false;
        console.error(`[${this._logPrefix}:${agentId}] 进程退出 code=${code} signal=${signal}`);
        state.sessions.clear();
        if (this._agents.get(stateKey) === state) {
          this._agents.delete(stateKey);
        }
      });

      child.on('error', (err: Error) => {
        console.error(`[${this._logPrefix}:${agentId}] 进程错误: ${err.message}`);
      });

      // ── 创建 ACP NDJSON 流（Node stream → Web stream） ──
      stream = sdk.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
    }

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
      console.error(`[${this._logPrefix}:${agentId}] ACP 连接已建立 (initialize 完成)`);
      state.agentCtx = agentCtx;
      if (state._readyResolve) {
        state._readyResolve();
        state._readyResolve = null;
      }
      await keepAlivePromise;
    }).catch((err: unknown) => {
      state.transportAlive = false;
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
    await Promise.race([
      state.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${this._logPrefix}] ${agentId} 连接超时 (${timeout}ms)`)), timeout)
      ),
    ]);

    if (!state.agentCtx) {
      throw new Error(`[${this._logPrefix}] ${agentId} 连接初始化失败（agentCtx 未就绪）`);
    }

    this._agents.set(stateKey, state);
    console.error(`[${this._logPrefix}:${agentId}] ACP 连接就绪 (PID=${state.child?.pid})`);
    return state;
  }

  /** 获取或创建 session（按 visitor 复用，支持 DB 持久化 + resume） */
  async _ensureSession(
    state: AcpAgentState,
    agentId: string,
    visitorId: string,
  ): Promise<AcpSession> {
    const sessionKey = `acp:${agentId}:${visitorId}`;
    // 1. 内存缓存命中
    const existing = state.sessions.get(sessionKey);
    if (existing) return existing;

    // 2. 尝试从 DB 句柄恢复 session
    const handle = this._loadSessionHandle(agentId, visitorId);
    if (handle) {
      try {
        const session = await this._resumeSession(state, handle);
        if (session) {
          state.sessions.set(sessionKey, session);
          return session;
        }
      } catch (err) {
        console.error(`[${this._logPrefix}] session resume 失败 agent=${agentId} visitor=${visitorId}: ${errorMessage(err)}`);
      }
      // resume 失败 → 清除失效句柄
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
    this._saveSessionHandle(agentId, visitorId, session.sessionId);

    state.sessions.set(sessionKey, session);
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
    const response = await agentCtx.request(sdk.methods.agent.session.resume, {
      sessionId,
      cwd: this._cwd,
      mcpServers: [],
    });
    // attachSession 将 session/resume 响应包装为 ActiveSession
    return agentCtx.attachSession(response);
  }

  /** 断开 agent 连接，清理资源 */
  _disconnectAgent(agentId: string, state: AcpAgentState): void {
    try {
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
