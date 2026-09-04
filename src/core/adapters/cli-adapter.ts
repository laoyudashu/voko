/**
 * cli-adapter.js — 通用 CLI stdout PushProvider
 *
 * 基于 cli-spawner + cli-parsers 的 PushProvider，支持多种 CLI 输出格式。
 * 适用于「不支持 ACP 但可通过 stdout 回复」的 agent。
 *
 * 与 openclaw-cli/hermes-cli（fire-and-forget 通知模式）不同，
 * 本 adapter 关注「spawn → stdout 解析 → emit agent.reply」完整链路。
 *
 * 用法（在 index.js 注册时）：
 *   providers['cli-claude'] = new CliAdapter({
 *     name: 'claude',
 *     cmd: 'claude',
 *     args: ['-p', '{prompt}', '--output-format', 'stream-json', '--include-partial-messages'],
 *     parser: 'stream-json',
 *     matchType: 'cli-claude',
 *   });
 *
 * {prompt} 占位符在 push 时替换为实际访客消息。
 */

const { PushProvider } = require('../dispatcher/base-provider');
const path = require('path');
const os = require('os');
const { runCli, checkCliAvailable, classifyCliFailure, killTree, sanitizeCliDiagnostic,
  sanitizeCmdArg } = require('./cli-spawner');
const { createParser } = require('./cli-parsers');
const { ProviderConversationBindingStore } = require('../provider-conversation-bindings');
const { AgentIdentityBindingStore } = require('../provider-agent-identity');
const { normalizeProviderFamily } = require('../provider-routing');
const { appendProviderAttachmentBoundary, stageProviderAttachments,
  cleanupExpiredProviderAttachmentStaging } = require('../dispatcher/provider-attachments');
import type { DatabaseLike } from '../../types/database';
import type { AgentMeta, ProviderDeliveryReceipt, ProviderSteerMetadata, PushPayload } from '../dispatcher/types';
import type { RuntimeRequest, AgentRuntimeResolver, ResolvedRuntime } from '../runtime/agent-runtime-resolver';
import { applyProviderSecurityArgs } from '../provider-security-policy';
const { withRuntimePath } = require('../runtime/agent-runtime-resolver');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');

export interface CliAdapterOptions {
  name: string;
  cmd: string;
  args?: string[];
  parser?: string;
  parserOpts?: Record<string, unknown>;
  matchType: string;
  priority?: number;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  promptTemplate?: string;
  requireOutput?: boolean;
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  cwd?: string;
  adapterType?: string;
  bindingProviderType?: string;
  runtimeRequest?: RuntimeRequest;
  runtimeResolver?: AgentRuntimeResolver;
  argsForSession?: (sessionId: string | null, isNew: boolean) => string[];
  instanceArgs?: (instanceId: string) => { args: string[]; position?: 'before' | 'after' };
  createManagedSessionId?: () => string | null;
  acceptsBinding?: (binding: any, agentId: string) => boolean;
  preparePrompt?: (prompt: string, context: {
    agentId: string;
    fromUid: string;
    nativeSessionId: string | null;
    configuredArgs: string[];
    payload: PushPayload;
  }) => {
    args: string[];
    useStdin?: boolean;
    stdinInput?: string;
    cleanup?: () => void;
  };
  requireSessionId?: boolean;
  classifyResult?: (result: { stdout: string; stderr: string; code: number | null }) => 'not_delivered' | 'rejected' | 'outcome_unknown' | null;
  prepareInvocation?: (payload: PushPayload, prompt: string) => {
    args: string[];
    stdinInput?: string;
    afterRun?: () => void;
  };
  sessionIdFromLine?: (line: string) => string | null;
  resolveSessionIdAfterRun?: (context: {
    agentId: string;
    fromUid: string;
    startedAt: number;
    cwd: string;
  }) => Promise<string | null> | string | null;
  sessionPersistence?: 'transport' | 'dispatcher';
}

export type CliProviderOptions = Pick<CliAdapterOptions, 'contextWindow' | 'db' | 'cwd' | 'sessionPersistence'>;

interface ContextMessage {
  content: string;
  is_me: number;
  timestamp: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCliConfigurationUnavailable(detail: string): boolean {
  return /not (?:logged|signed) in|login required|authentication required|invalid (?:api[- ]?key|token)|api[- ]?key (?:is )?(?:invalid|missing|expired)/i.test(detail);
}

const MAX_REPLY_CHARS = 2 * 1024 * 1024; // 单次回复字符上限，防 agent 输出失控撑爆内存

class CliAdapter extends PushProvider {
  /**
   * @param {object}   opts
   * @param {string}   opts.name            - 显示名（用于日志）
   * @param {string}   opts.cmd             - CLI 命令或路径
   * @param {string[]} [opts.args]          - 参数，{prompt} 会被替换为访客消息
   * @param {string}   [opts.parser='raw']  - 解析器名（stream-json / jsonl / raw / silent）
   * @param {object}   [opts.parserOpts]    - 解析器选项
   * @param {string}   opts.matchType       - match 匹配的 backend_type
   * @param {number}   [opts.priority=1]    - 优先级
   * @param {number}   [opts.timeout=120000]- 超时 ms
   * @param {object}   [opts.env]           - 额外环境变量
   * @param {string}   [opts.promptTemplate]- 自定义 prompt 模板，{prompt} 替换
   */
  constructor(opts: CliAdapterOptions) {
    super();
    this._name = opts.name || 'cli';
    this._cmd = opts.cmd;
    this._args = opts.args || [];
    this._parserName = opts.parser || 'raw';
    this._parserOpts = opts.parserOpts || {};
    this._matchType = opts.matchType;
    this._priority = opts.priority ?? 1;
    this._timeout = opts.timeout ?? 120000;
    this._env = opts.env;
    this._promptTemplate = opts.promptTemplate;
    this._requireOutput = !!opts.requireOutput;

    this._contextWindow = opts.contextWindow ?? 0;
    this._db = opts.db || null;
    this._cwd = opts.cwd || null;
    cleanupExpiredProviderAttachmentStaging(path.join(path.resolve(this._cwd || os.tmpdir()), 'voko-provider-attachments'));
    this._adapterType = String(opts.adapterType || opts.matchType || opts.name || 'cli').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
    this._bindingProviderType = normalizeProviderFamily(opts.bindingProviderType || opts.matchType || opts.name || '');
    this._runtimeRequest = opts.runtimeRequest || (process.platform === 'win32' ? null : {
      providerId: this._adapterType,
      mode: 'cli',
      candidates: [{ kind: path.isAbsolute(this._cmd) ? 'explicit' : 'native',
        ...(path.isAbsolute(this._cmd) ? { path: this._cmd } : { command: this._cmd }) }],
    });
    this._runtimeResolver = opts.runtimeResolver || defaultAgentRuntimeResolver;
    this._argsForSession = opts.argsForSession || null;
    this._instanceArgs = opts.instanceArgs || null;
    this._createManagedSessionId = opts.createManagedSessionId || null;
    this._acceptsBinding = opts.acceptsBinding || null;
    this._preparePrompt = opts.preparePrompt || null;
    this._requireOutput = !!opts.requireOutput;
    this._requireSessionId = !!opts.requireSessionId;
    this._classifyResult = opts.classifyResult || null;
    this._prepareInvocation = opts.prepareInvocation || null;
    this._sessionIdFromLine = opts.sessionIdFromLine || null;
    this._resolveSessionIdAfterRun = opts.resolveSessionIdAfterRun || null;
    this._bindingStore = opts.sessionPersistence !== 'dispatcher'
      && opts.db && typeof (opts.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(opts.db as any)
      : null;
    this._sessionPersistence = opts.sessionPersistence || 'transport';
    this._identityBindings = opts.db && typeof (opts.db as any).exec === 'function'
      ? new AgentIdentityBindingStore(opts.db as any)
      : null;
    this._available = null;
  }

  get priority() { return this._priority; }
  getTurnTimeoutMs(): number { return this._timeout; }
  get capabilities() { return ['streaming']; }

  useDispatcherSessionPersistence(): void {
    this._sessionPersistence = 'dispatcher';
    this._bindingStore = null;
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === this._matchType;
  }

  acceptsBinding(binding: any, agentId = ''): boolean {
    if (this._acceptsBinding) return !!this._acceptsBinding(binding, agentId);
    return binding?.providerType === this._bindingProviderType
      && binding.adapterType === this._adapterType
      && binding.deliveryMode === 'cli';
  }

  _instanceForAgent(agentId: string): string | null {
    if (!this._instanceArgs || !this._db) return null;
    try {
      const row = this._db.prepare('SELECT backend_type, backend_instance_id FROM agents WHERE agent_id=? LIMIT 1')
        .get(agentId) as { backend_type?: string; backend_instance_id?: string | null } | undefined;
      if (row?.backend_type !== this._matchType) return null;
      return String(row?.backend_instance_id || '').trim() || null;
    } catch (_) { return null; }
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = this._runtimeRequest ? this._resolveRuntime().available : checkCliAvailable(this._cmd);
    return this._available;
  }

  /** Force the next health check to resolve the executable again instead of
   * reusing a stale provider/runtime cache. The dispatcher calls this before a
   * manual delivery-channel refresh and then invalidates the selected route. */
  refreshRuntime(): void {
    if (this._runtimeRequest) this._runtimeResolver.invalidate(this._runtimeRequest);
    this._available = null;
  }

  /** Model-backed isolated probe. Catalog capability gating decides which subclasses may expose it. */
  async runLoopbackTest(agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) return { ok: false, code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) return { ok: false, code: 'LOOPBACK_CHALLENGE_INVALID' };
    const prompt = `VOKO isolated loopback test. Do not use tools or modify files. Reply with exactly: ${challenge}`;
    const configuredArgs = this._argsForSession ? this._argsForSession(null, true) : this._args;
    const payload = { agentId, fromUid: `loopback-${challenge}`, content: prompt,
      messageId: challenge, turnId: challenge, channelId: `loopback-${challenge}`, channelType: 1 } as PushPayload;
    const preparedInvocation = this._prepareInvocation?.(payload, prompt) || null;
    const invocationArgs = preparedInvocation?.args || configuredArgs;
    let useStdin = preparedInvocation ? preparedInvocation.stdinInput !== undefined : !invocationArgs.includes('{prompt}');
    let stdinInput: string | undefined = useStdin ? prompt : undefined;
    let cleanupPrompt: (() => void) | null = null;
    let args: string[];
    if (this._preparePrompt) {
      const prepared = this._preparePrompt(prompt, { agentId, fromUid: payload.fromUid,
        nativeSessionId: null, configuredArgs: [...configuredArgs], payload });
      args = [...(prepared.args || [])].map((arg: string) => arg.replace('{prompt}', () => prompt));
      useStdin = prepared.useStdin ?? !args.includes('{prompt}');
      stdinInput = prepared.stdinInput ?? (useStdin ? prompt : undefined);
      cleanupPrompt = prepared.cleanup || null;
    } else {
      args = useStdin ? [...invocationArgs] : invocationArgs.map((arg: string) => arg.replace('{prompt}', () => prompt));
    }
    const runtime = this._runtimeRequest ? this._resolveRuntime() : null;
    if (runtime && (!runtime.available || !runtime.executable)) return { ok: false, code: 'LOOPBACK_RUNTIME_UNAVAILABLE' };
    const cmd = runtime?.available && runtime.executable ? runtime.executable : this._cmd;
    if (runtime?.available) args.unshift(...runtime.argvPrefix);
    let reply = '';
    const parser = createParser({ format: this._parserName, parserOpts: this._parserOpts,
      onText: (text: string) => { reply += text; }, onDone: () => {} });
    try {
      const result = await runCli({ cmd, args, stdinInput: preparedInvocation?.stdinInput ?? stdinInput,
        cwd: this._cwd || undefined, tag: `${this._name}-loopback`, timeout: this._timeout,
        env: withRuntimePath({ ...this._env }, runtime), logOutput: false,
        onStdoutLine: (line: string) => parser.handleLine(line) });
      parser.finish();
      const matched = result.code === 0 && reply.trim() === challenge;
      return { ok: matched, challengeMatched: matched, status: matched ? 'loopback_verified' : 'failed',
        detail: matched ? `${this._name} CLI loopback verified` : `${this._name} CLI did not return the exact challenge` };
    } finally {
      try { cleanupPrompt?.(); } catch (_) {}
      try { preparedInvocation?.afterRun?.(); } catch (_) {}
    }
  }

  _resolveRuntime(): ResolvedRuntime {
    return this._runtimeResolver.resolve(this._runtimeRequest);
  }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    const { agentId, fromUid, messageId } = payload;
    const turnId = String(payload.turnId || messageId || `cli-${Date.now()}`);
    const staged = stageProviderAttachments(payload, { cwd: this._cwd || undefined, agentId, turnId });
    const effectivePayload = staged.attachments.length ? { ...payload, attachments: staged.attachments } : payload;
    const content = appendProviderAttachmentBoundary(payload.content, effectivePayload);
    if (!(payload as any).__vokoManagedRetry) {
      this.notifyProviderEvent({ type: 'accepted', agentId, messageId, turnId, terminal: false });
    }
    const sessionIdentity = String((payload as any).sessionScopeId || fromUid);
    const sessionKey = `cli:${agentId}:${sessionIdentity}`;
    const binding = this.acceptsBinding(payload.providerBinding, agentId)
      ? payload.providerBinding
      : null;
    let nativeSessionId = binding?.nativeSessionId || null;
    let newManagedSession = false;
    if (!nativeSessionId && this._createManagedSessionId) {
      nativeSessionId = this._createManagedSessionId();
      newManagedSession = !!nativeSessionId;
    }

    // 取上下文
    let contextMsgs: ContextMessage[] = [];
    if (!nativeSessionId && this._contextWindow > 0 && this._db) {
      try {
        contextMsgs = (this._db.prepare(
          `SELECT content, is_me, timestamp FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ?`
        ).all(fromUid, agentId, this._contextWindow) as ContextMessage[]).reverse();
      } catch (_) {}
    }

    const contextPrompt = (payload as any).__ownerRaw === true ? content : _buildContextPrompt(agentId, fromUid, content, contextMsgs);
    const prompt = this._promptTemplate
      ? this._promptTemplate.replace('{prompt}', () => contextPrompt)
      : contextPrompt;

    // 构造参数：args 含 {prompt} 占位则替换；否则 prompt 经 stdin 传入
    // （避开 Windows cmd.exe 对含换行多行命令行参数的破坏）
    let configuredArgs = this._argsForSession
      ? this._argsForSession(nativeSessionId, newManagedSession)
      : this._args;
    const configuredInstanceId = this._instanceForAgent(agentId);
    if (this._instanceArgs && configuredInstanceId) {
      try {
        const scoped = this._instanceArgs(configuredInstanceId);
        configuredArgs = scoped.position === 'before'
          ? [...scoped.args, ...configuredArgs]
          : [...configuredArgs, ...scoped.args];
      } catch (_) {}
    }
    configuredArgs = applyProviderSecurityArgs(configuredArgs, effectivePayload);
    const preparedInvocation = this._prepareInvocation?.(effectivePayload, prompt) || null;
    const invocationArgs = preparedInvocation?.args || configuredArgs;
    let useStdin = preparedInvocation
      ? preparedInvocation.stdinInput !== undefined
      : !invocationArgs.includes('{prompt}');
    // Windows 下 {prompt} 经命令行参数传入时须净化 cmd.exe 元字符，否则访客
    // 消息中的 " 会断裂 cmd 引号、&|<> 充当命令分隔/重定向 → 任意命令执行 (RCE)，
    // 换行会截断命令行。用函数式 replacement 避免 String.replace 对 $ 模式的展开。
    const safePrompt = process.platform === 'win32' ? sanitizeCmdArg(prompt) : prompt;
    let stdinInput: string | undefined = useStdin ? prompt : undefined;
    let cleanupPrompt: (() => void) | null = null;
    let args: string[];
    if (this._preparePrompt) {
      const prepared = this._preparePrompt(prompt, {
        agentId,
        fromUid,
        nativeSessionId,
        configuredArgs: [...configuredArgs],
        payload: effectivePayload,
      });
      args = [...(prepared.args || [])].map((a: string) => a.replace('{prompt}', () => safePrompt));
      useStdin = prepared.useStdin ?? !args.includes('{prompt}');
      stdinInput = prepared.stdinInput ?? (useStdin ? prompt : undefined);
      cleanupPrompt = prepared.cleanup || null;
    } else {
    args = useStdin
      ? [...invocationArgs]
      : invocationArgs.map((a: string) => a.replace('{prompt}', () => safePrompt));
    }
    const runtime = this._runtimeRequest ? this._resolveRuntime() : null;
    if (runtime && (!runtime.available || !runtime.executable)) {
      staged.cleanup();
      const unavailable = new Error(`${this._name} runtime not found`);
      (unavailable as any).deliveryOutcome = 'not_delivered';
      throw unavailable;
    }
    const cmd = runtime?.available && runtime.executable ? runtime.executable : this._cmd;
    if (runtime?.available) args.unshift(...runtime.argvPrefix);

    let fullContent = '';
    let error: Error | null = null;
    let exitCode: number | null = null;
    let observedSessionId = nativeSessionId;
    const observeSession = (line: string) => {
      if (!this._sessionIdFromLine) return;
      try { observedSessionId = this._sessionIdFromLine(line) || observedSessionId; } catch (_) {}
    };

    // 创建解析器
    const parser = createParser({
      format: this._parserName,
      parserOpts: this._parserOpts,
      onText: (chunk: string) => {
        fullContent += chunk;
        if (fullContent.length > MAX_REPLY_CHARS) fullContent = fullContent.slice(0, MAX_REPLY_CHARS) + '\n…[回复过长，已截断]';
      },
      onDone: () => {
        // silent 模式下由 finish() 触发
      },
    });

    const runStartedAt = Date.now();
    try {
      const result = await runCli({
        cmd,
        args,
        stdinInput: preparedInvocation?.stdinInput ?? stdinInput,
        cwd: this._cwd || undefined,
        tag: this._name,
        timeout: this._timeout,
        env: withRuntimePath({
          ...this._env,
          ...(nativeSessionId ? {
            VOKO_CALLER_PROVIDER: this._bindingProviderType,
            VOKO_CALLER_INSTANCE: binding?.providerInstanceId || '',
            VOKO_CALLER_SESSION_ID: nativeSessionId,
            VOKO_CALLER_EVIDENCE: 'voko_created',
          } : {}),
        }, runtime),
        logOutput: false,
        onStdoutLine: (line: string) => {
          observeSession(line);
          parser.handleLine(line);
        },
        onStderrLine: (line: string) => {
          observeSession(line);
        },
      });

      exitCode = result.code;

      if (!observedSessionId && exitCode === 0 && this._resolveSessionIdAfterRun) {
        try {
          observedSessionId = await this._resolveSessionIdAfterRun({
            agentId,
            fromUid,
            startedAt: runStartedAt,
            cwd: this._cwd || process.cwd(),
          });
        } catch (_) {}
      }

      // silent 模式：不解析，进程退出即完成
      if (this._parserName === 'silent') {
        parser.finish();
      }

      if (exitCode !== 0) {
        const cliFailureDetail = `${result.stdout || ''}\n${result.stderr || ''}`;
        error = new Error(`${this._name} 退出 code=${exitCode}`);
        (error as any).deliveryOutcome = this._classifyResult?.(result) || classifyCliFailure(result);
        (error as any).code = /quota|credit|额度|配额/i.test(cliFailureDetail)
          ? 'PROVIDER_QUOTA_EXHAUSTED'
          : /login|auth|unauthorized|未登录|登录/i.test(cliFailureDetail)
            ? 'PROVIDER_AUTH_REQUIRED' : 'PROVIDER_CLI_EXIT';
        (error as any).exitCode = exitCode;
        (error as any).retryable = false;
        (error as any).diagnostic = sanitizeCliDiagnostic(result.stderr) || 'no_stderr';
        console.error(`[${this._name}] cli_failure code=${(error as any).code} exitCode=${exitCode} `+
          `retryable=false detail=${(error as any).diagnostic}`);
        if ((error as any).deliveryOutcome === 'not_delivered' && isCliConfigurationUnavailable(cliFailureDetail)) {
          this._available = false;
          this.notifyAvailability({ backendType: this._matchType, mode: 'cli', agentId,
            available: false, reason: 'cli-auth-required' });
        }
      } else if (parser.error) {
        error = new Error(parser.error);
        (error as any).deliveryOutcome = 'rejected';
      } else if (this._requireOutput && !fullContent.trim()) {
        error = new Error(`${this._name} produced no reply`);
        (error as any).deliveryOutcome = 'outcome_unknown';
      } else if (this._requireSessionId && !observedSessionId) {
        error = new Error(`${this._name} produced no native session id`);
        (error as any).deliveryOutcome = 'outcome_unknown';
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      if ((error as any).code === 'PROVIDER_TIMEOUT') {
        (error as any).deliveryOutcome = 'outcome_unknown';
        (error as any).retryable = true;
        (error as any).diagnostic = sanitizeCliDiagnostic(error.message);
      }
      if (/ENOENT|EACCES|not found|permission denied/i.test(String((error as any).code || error.message))) {
        if (this._runtimeRequest) this._runtimeResolver.invalidate(this._runtimeRequest);
        (error as any).deliveryOutcome = 'not_delivered';
        if (this._available !== false) {
          this._available = false;
          this.notifyAvailability({ backendType: this._matchType, mode: 'cli', agentId, available: false, reason: 'cli-not-found' });
        }
      }
      console.error(`[${this._name}] push 失败: ${errorMessage(err)}`);
    }

    try { cleanupPrompt?.(); } catch (_) {}
    try { preparedInvocation?.afterRun?.(); } catch (cleanupError) {
      if (!error) error = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    }
    staged.cleanup();

    if (error && binding && this._sessionPersistence === 'transport' && !binding.strictSessionRoute
      && (error as any).deliveryOutcome === 'not_delivered' && !(payload as any).__vokoManagedRetry) {
      try { this._bindingStore?.markStale(binding.id); } catch (_) {}
      return this.push({ ...payload, providerBinding: null, __vokoManagedRetry: true });
    }

    if (!error && observedSessionId && this._bindingStore) {
      const channelId = binding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
      const channelType = binding?.channelType || (payload.channelType === 2 ? 2 : 1);
      // Always persist the active delivery metadata.  A CLI fallback may be
      // resuming the same native session that ACP owns; `touch()` alone would
      // leave the binding labelled as ACP and make the route cache stale.
      // saveManaged keeps the native ID unchanged while atomically switching
      // deliveryMode/adapterType when the protocol changes.
      this._bindingStore.saveManaged({
        agentId,
        channelId,
        channelType,
        providerType: this._matchType,
        providerInstanceId: configuredInstanceId || binding?.providerInstanceId || null,
        nativeSessionId: observedSessionId,
        deliveryMode: 'cli',
        adapterType: this._adapterType,
        expectedVersion: binding?.bindingVersion ?? 0,
      });
      try {
        this._identityBindings?.bind({
          agentId,
          providerFamily: this._bindingProviderType,
          providerInstanceKey: configuredInstanceId || binding?.providerInstanceId || '',
          nativeSessionId: observedSessionId,
          evidenceType: 'voko_created',
        });
      } catch (_) {}
    }

    if (error) {
      this.notifyProviderEvent({ type: 'failed', agentId, messageId, turnId, terminal: true,
        payload: { outcome: (error as any).deliveryOutcome || 'outcome_unknown' } });
      throw error;
    }
    this.emit('agent.reply', {
      agentId, visitorId: fromUid,
      content: fullContent,
      done: true,
      sessionKey,
      turnId,
      replyId: turnId,
    });
    const receipt = {
      nativeSessionId: observedSessionId,
      providerInstanceId: configuredInstanceId || binding?.providerInstanceId || null,
      deliveryMode: 'cli',
      adapterType: this._adapterType,
      attachmentDelivery: { transportDelivered: true, attachmentAccessed: null, contentUnderstood: null,
        mode: staged.attachments.length ? 'staged_path' as const : 'none' as const },
    };
    this.notifyProviderEvent({ type: 'completed', agentId, messageId, turnId,
      nativeSessionId: observedSessionId, terminal: true,
      payload: { attachmentDelivery: receipt.attachmentDelivery } });
    return receipt;
  }

  /** Dedicated owner driver hook. Subclasses must opt in explicitly. */
  protected pushOwnerRaw(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    return this.push({ ...payload, __ownerRaw: true } as PushPayload);
  }

  async steer(
    agentId: string,
    visitorId: string,
    content: string,
    metadata?: ProviderSteerMetadata,
  ): Promise<unknown> {
    // owner intervention：走同样的 push 路径
    const messageId = metadata?.turnId || `steer-${Date.now()}`;
    const channelType = metadata?.channelType === 2 || visitorId.startsWith('group:') ? 2 : 1;
    const channelId = metadata?.channelId || visitorId.replace(/^group:/, '');
    return this.push({
      agentId,
      fromUid: channelType === 2 ? `group:${channelId}` : visitorId,
      content,
      messageId,
      turnId: messageId,
      channelId,
      channelType,
      providerBinding: metadata?.providerBinding || null,
      timestamp: Date.now(),
    });
  }

  start() { this._refreshAvailability(); }
  stop() {
    if (this._available === true) this.notifyAvailability({ backendType: this._matchType, mode: 'cli', available: false, reason: 'provider-stopped' });
    this._available = false;
  }
  healthCheck() { this._refreshAvailability(); }

  _refreshAvailability() {
    const previous = this._available;
    this._available = this._runtimeRequest ? this._resolveRuntime().available : checkCliAvailable(this._cmd);
    if (previous !== this._available) {
      this.notifyAvailability({ backendType: this._matchType, mode: 'cli', available: this._available, reason: this._available ? 'cli-detected' : 'cli-not-found' });
    }
  }
}

function _buildContextPrompt(
  agentId: string,
  fromUid: string,
  content: string,
  contextMsgs: ContextMessage[],
): string {
  let msg = `session: cli:${agentId}:${fromUid}\n\n【访客最新消息】\n${content}`;

  if (contextMsgs && contextMsgs.length > 0) {
    msg += `\n\n【最近对话】\n${contextMsgs.map((m: ContextMessage, i: number) => {
      const role = m.is_me >= 1 ? 'Agent' : '访客';
      return `[${i + 1}] ${role}: ${m.content}`;
    }).join('\n')}`;
  }

  return msg;
}

module.exports = { CliAdapter };
