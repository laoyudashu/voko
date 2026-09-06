const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable, classifyCliFailure, sanitizeCmdArg } = require('../../adapters/cli-spawner');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { appendProviderAttachmentBoundary, stageProviderAttachments } = require('../provider-attachments');
const os = require('node:os');
const { buildOpenClawSessionKey } = require('../openclaw-session');
const { resolveOpenClawRuntime, runtimeSpawnOptions, inspectOpenClawRuntime, openClawPaths, acquireOpenClawState } = require('../openclaw-command');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, ProviderSteerMetadata, PushPayload } from '../types';

interface OpenClawCliOptions {
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
}

interface OpenClawPayload {
  text?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * OpenClaw CLI 兜底 provider
 *
 * 长连接（openclaw-ws）不可用时，通过 spawn 本地 openclaw CLI 通知 agent。
 *
 * 改进：
 * - 仅在原生 session 不可恢复时，从 DB 注入一次有限历史
 * - 通过 --json 解析 stdout 直接获取 agent 回复，不走 send_message
 * - 保留 get_chat_history 指令供 agent 按需 fetch 更早历史
 */
class OpenClawCliProvider extends PushProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow=0] - session 恢复失败时注入的历史条数
   * @param {object} [options.db] - better-sqlite3 实例（contextWindow>0 时需要）
   */
  constructor(options: OpenClawCliOptions = {}) {
    super();
    this._contextWindow = options.contextWindow ?? 0;
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;
    this._available = null;
    this._runtime = null;
    this._isWin = process.platform === 'win32';
    this._queueAbort = new AbortController();
  }

  /** CLI 兜底通道：长连接不通时才用，优先级低。 */
  get priority() { return 1; }
  getTurnTimeoutMs(): number { return 120_000; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'openclaw';
  }

  isAvailable(agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._runtime = resolveOpenClawRuntime('cli');
    this._available = this._runtime.available || (this._isWin && checkCliAvailable('openclaw'));
    return this._available;
  }

  _instanceForAgent(agentId: string): string {
    try {
      const row = this._db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'openclaw');
      return String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {
      return agentId;
    }
  }

  _resolveRuntime(agentId = ''): any {
    this._runtime = inspectOpenClawRuntime(resolveOpenClawRuntime('cli'), this._instanceForAgent(agentId));
    return this._runtime;
  }

  getProviderVersion(): any {
    const runtime = this._resolveRuntime();
    return { version: runtime.frameworkVersion, source: 'package', result: runtime.frameworkVersion ? 'known' : 'unknown' };
  }

  getSecurityControlEvidence(agentId: string): any {
    const runtime = this._resolveRuntime(agentId);
    return { frameworkVersion: runtime.frameworkVersion, runtimeVersion: runtime.runtimeVersion,
      nodeVersion: process.version, versionSource: 'package', nativePermissions: 'unsupported',
      callCompatibility: runtime.available && ['2026.6.1', '2026.7.1-2', '2026.9.2'].includes(runtime.frameworkVersion)
        ? 'documented_contract' : runtime.available && this._localContractFingerprint === inspectOpenClawRuntime(runtime).fingerprint
          ? 'parameters_checked' : 'unverified' };
  }

  async _ensureLocalContract(runtime: any, paths: { stateDir: string; configPath: string }): Promise<void> {
    const identity = inspectOpenClawRuntime(runtime);
    if (['2026.6.1', '2026.7.1-2', '2026.9.2'].includes(identity.frameworkVersion)) return;
    if (this._localContractFingerprint === identity.fingerprint) return;
    const spawn = runtimeSpawnOptions(runtime);
    let result;
    try {
      result = await runCli({ cmd: spawn.cmd, args: [...spawn.prefixArgs, 'agent', '--help'],
        env: { ...spawn.env, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.configPath },
        timeout: 15000, tag: 'openclaw-contract', logOutput: false });
    } catch (_) { /* This probe contains no user task. */ }
    const output = String(result?.stdout || '');
    if (result?.code !== 0 || !['--agent', '--session-key', '--message', '--local', '--json'].every(flag => output.includes(flag))) {
      throw Object.assign(new Error('OPENCLAW_CLI_CONTRACT_UNVERIFIED: agent CLI contract could not be confirmed'),
        { code: 'OPENCLAW_CLI_CONTRACT_UNVERIFIED', deliveryOutcome: 'not_delivered' });
    }
    this._localContractFingerprint = identity.fingerprint;
  }

  async push(payload: PushPayload): Promise<unknown> {
    const paths = openClawPaths();
    const release = await acquireOpenClawState(paths.stateDir, this._queueAbort.signal);
    try { payload.assertSubmissionCurrent?.(); return await this._pushLocal(payload, paths); } finally { release(); }
  }

  async _pushLocal(payload: PushPayload, paths: { stateDir: string; configPath: string }): Promise<unknown> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `openclaw-cli-${Date.now()}`);
    const targetAgentId = this._instanceForAgent(agentId);
    const canResumeBinding = payload.providerBinding?.providerType === 'openclaw'
      && payload.providerBinding.providerInstanceId === targetAgentId
      && /^agent:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionIdentity = String((payload as any).sessionScopeId || fromUid);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : buildOpenClawSessionKey(targetAgentId, agentId, sessionIdentity);
    const channelId = payload.providerBinding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
    const channelType = payload.providerBinding?.channelType || (payload.channelType === 2 ? 2 : 1);
    if (!canResumeBinding && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId, channelType, providerType: 'openclaw',
        providerInstanceId: targetAgentId, nativeSessionId: sessionKey,
        deliveryMode: 'cli', adapterType: 'openclaw-cli', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }

    const staged = stageProviderAttachments(payload, { cwd: os.tmpdir(), agentId, turnId });
    const effectivePayload = staged.attachments.length ? { ...payload, attachments: staged.attachments } : payload;
    const deliveryContent = appendProviderAttachmentBoundary(buildConversationDeliveryPrompt(
      this._db, effectivePayload, canResumeBinding, this._contextWindow,
    ), effectivePayload);
    console.debug(`[OpenClawCli] push agent=${agentId} visitor=${fromUid} session=${canResumeBinding ? 'resume' : 'new-or-recovery'}`);

    const notification = _buildNotification(agentId, fromUid, deliveryContent, sessionKey);
    // Windows 下 --message 经 cmd.exe 传多行/含元字符 notification 会被截断或注入，净化为单行
    const safeNotification = this._isWin ? sanitizeCmdArg(notification) : notification;
    const runtime = resolveOpenClawRuntime('cli');
    if (!runtime.available) {
      staged.cleanup();
      const error = new Error('找不到可用的 OpenClaw CLI 运行入口');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    this._runtime = runtime;
    const spawnOptions = runtimeSpawnOptions(runtime);

    try {
      await this._ensureLocalContract(runtime, paths);
      payload.assertSubmissionCurrent?.();
      if (this._queueAbort.signal.aborted) throw Object.assign(new Error('OPENCLAW_LOCAL_QUEUE_CANCELLED'), { deliveryOutcome: 'not_delivered' });
      const result = await runCli({
        cmd: spawnOptions.cmd,
        args: [...spawnOptions.prefixArgs, 'agent', '--agent', targetAgentId, '--session-key', sessionKey, '--message', safeNotification, '--local', '--json'],
        env: { ...spawnOptions.env, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.configPath },
        tag: 'openclaw-cli',
        timeout: 120000,
        logOutput: false,
      });
      const replyText = successfulReply(result);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId: fromUid,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.log(`[OpenClawCli] push OK agent=${agentId} reply=${replyText.length}chars`);
      }
      return { nativeSessionId: sessionKey, providerInstanceId: targetAgentId,
        deliveryMode: 'cli', adapterType: 'openclaw-cli',
        attachmentDelivery: { transportDelivered: staged.attachments.length > 0,
          attachmentAccessed: null, contentUnderstood: null,
          mode: staged.attachments.length ? 'staged_path' : 'none' } };
    } catch (err) {
      console.error(`[OpenClawCli] push 失败 agent=${agentId}: ${errorMessage(err)}`);
      if ((err as any)?.cliExecutionStarted === false && (err as any)?.deliveryOutcome === 'not_delivered') {
        this._available = false;
        this._runtime = null;
        this.notifyAvailability({ backendType: 'openclaw', mode: 'cli', agentId, available: false, reason: errorMessage(err) });
      }
      throw err;
    } finally {
      staged.cleanup();
    }
  }

  useDispatcherSessionPersistence(): void { this._bindingStore = null; }

  async steer(agentId: string, visitorId: string, content: string, metadata?: ProviderSteerMetadata): Promise<null> {
    const paths = openClawPaths();
    const release = await acquireOpenClawState(paths.stateDir, this._queueAbort.signal);
    try { return await this._steerLocal(agentId, visitorId, content, paths, metadata); } finally { release(); }
  }

  async _steerLocal(agentId: string, visitorId: string, content: string,
    paths: { stateDir: string; configPath: string }, metadata?: ProviderSteerMetadata): Promise<null> {
    const targetAgentId = this._instanceForAgent(agentId);
    const binding = metadata?.providerBinding;
    const sessionKey = binding?.providerType === 'openclaw'
      && binding.providerInstanceId === targetAgentId
      ? binding.nativeSessionId
      : buildOpenClawSessionKey(targetAgentId, agentId, visitorId);
    const turnId = String(metadata?.turnId || `openclaw-cli-steer-${Date.now()}`);
    console.debug(`[OpenClawCli] steer agent=${agentId} visitor=${visitorId} session=selected`);
    const notification = JSON.stringify({
      type: 'voko_owner_message',
      visitorId,
      sessionKey,
      content,
      safety: '此消息来自主人（可信任）。请按主人要求执行。',
    });
    const runtime = resolveOpenClawRuntime('cli');
    if (!runtime.available) throw Object.assign(new Error('OpenClaw CLI unavailable'), { deliveryOutcome: 'not_delivered' });
    const spawnOptions = runtimeSpawnOptions(runtime);
    try {
      await this._ensureLocalContract(runtime, paths);
      if (this._queueAbort.signal.aborted) throw Object.assign(new Error('OPENCLAW_LOCAL_QUEUE_CANCELLED'), { deliveryOutcome: 'not_delivered' });
      const result = await runCli({
        cmd: spawnOptions.cmd,
        args: [...spawnOptions.prefixArgs, 'agent', '--agent', targetAgentId, '--session-key', sessionKey, '--message', notification, '--local', '--json'],
        env: { ...spawnOptions.env, OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.configPath },
        tag: 'openclaw-cli',
        timeout: 120000,
        logOutput: false,
      });
      const replyText = successfulReply(result);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.log(`[OpenClawCli] steer OK agent=${agentId} reply=${replyText.length}chars`);
      }
    } catch (err) {
      console.error(`[OpenClawCli] steer 失败 agent=${agentId}: ${errorMessage(err)}`);
      if ((err as any)?.cliExecutionStarted === false && (err as any)?.deliveryOutcome === 'not_delivered') {
        this._available = false;
        this._runtime = null;
        this.notifyAvailability({ backendType: 'openclaw', mode: 'cli', agentId, available: false, reason: errorMessage(err) });
      }
      throw err;
    }
    return null;
  }

  start() { this._queueAbort = new AbortController(); this._refreshAvailability(); }
  stop() {
    this._queueAbort.abort();
    if (this._available === true) {
      this.notifyAvailability({ backendType: 'openclaw', mode: 'cli', available: false, reason: 'provider stopped' });
    }
    this._available = false;
  }
  healthCheck() { this._refreshAvailability(); }
  _refreshAvailability() {
    const previous = this._available;
    this._runtime = resolveOpenClawRuntime('cli');
    this._available = this._runtime.available || (this._isWin && checkCliAvailable('openclaw'));
    if (previous !== this._available) this.notifyAvailability({ backendType: 'openclaw', mode: 'cli', available: this._available, reason: this._available ? 'cli-detected' : 'cli-not-found' });
  }
}

/**
 * 从 openclaw --json stdout 提取 agent 回复文本。
 * JSON 格式: { "payloads": [{ "text": "回复内容", "mediaUrl": null }], "meta": {...} }
 */
function successfulReply(result: any): string {
  if (result.code !== 0) {
    throw Object.assign(new Error(`OpenClaw exited with code ${result.code}`), { deliveryOutcome: classifyCliFailure(result) });
  }
  const text = _extractReply(result.stdout);
  if (!text) throw Object.assign(new Error('OpenClaw returned no reply text'), { deliveryOutcome: 'outcome_unknown' });
  return text;
}

function _extractReply(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { payloads?: OpenClawPayload[] };
    if (Array.isArray(parsed.payloads) && parsed.payloads.length > 0) {
      for (const p of parsed.payloads) {
        if (p && typeof p.text === 'string' && p.text.trim().length > 0) {
          return p.text.trim();
        }
      }
    }
  } catch {}
  return null;
}

function _buildNotification(
  agentId: string,
  fromUid: string,
  content: string,
  sessionKey?: string,
): string {
  let msg = `【访客消息】\n访客：${fromUid}\n消息：${content}`;
  msg += `\n\n当前 session: ${sessionKey || `agent:${agentId}:${fromUid}`}`;
  return msg;
}

module.exports = OpenClawCliProvider;
