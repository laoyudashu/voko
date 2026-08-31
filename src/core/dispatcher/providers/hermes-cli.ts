const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable, sanitizeCmdArg } = require('../../adapters/cli-spawner');
const { resolveHermesCommand } = require('../hermes-command');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { appendProviderAttachmentBoundary, stageProviderAttachments } = require('../provider-attachments');
const os = require('node:os');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, ProviderSteerMetadata, PushPayload } from '../types';

interface HermesCliOptions {
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  runCli?: typeof runCli;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Hermes resolves credentials from its selected profile.  Voko may itself be
// started with keys for other CLI Providers; passing those through can make
// Hermes silently override the profile and return an upstream 401.  Keep
// transport/runtime settings, but isolate generic model credentials.
const HERMES_GENERIC_CREDENTIAL_ENV = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY',
  'COHERE_API_KEY', 'AZURE_OPENAI_API_KEY',
];

function hermesChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of HERMES_GENERIC_CREDENTIAL_ENV) delete env[key];
  return env;
}

/**
 * Hermes CLI provider — 通过 spawn 本地 hermes CLI 通知 agent 并捕获回复。
 *
 * 改进：
 * - JSON 格式 push（type/content/visitorId/safety/sessionKey）
 * - 解析 stdout 直接获取 agent 回复，不走 HTTP API
 * - 仅在原生 session 不可恢复时使用 contextWindow 恢复历史
 */
class HermesCliProvider extends PushProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow=0] - session 恢复失败时注入的历史条数
   * @param {object} [options.db] - better-sqlite3 实例
   */
  constructor(options: HermesCliOptions = {}) {
    super();
    this._contextWindow = options.contextWindow ?? 0;
    this._db = options.db || null;
    this._available = null;
    this._command = resolveHermesCommand();
    this._runCli = options.runCli || runCli;
    this._queues = new Map();
  }

  get priority() { return 1; }
  getTurnTimeoutMs(): number { return 120_000; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'hermes';
  }

  isAvailable(agentId: string): boolean {
    if (!this._instanceForAgent(agentId)) return false;
    if (this._available !== null) return this._available;
    this._available = checkCliAvailable(this._command);
    return this._available;
  }

  _instanceForAgent(agentId: string): string | null {
    if (!agentId) return null;
    try {
      const row = this._db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'hermes');
      const profileId = String(row?.backend_instance_id || '').trim();
      return profileId || null;
    } catch (_) {
      return null;
    }
  }

  _failureKind(error: unknown): 'approval_required' | 'auth_required' | 'timeout' | 'execution_failed' {
    if (String((error as any)?.code || '') === 'PROVIDER_AUTH_REQUIRED') return 'auth_required';
    const message = errorMessage(error);
    if (/pending[_ ]approval|approval.*(?:pending|required)|等待授权/i.test(message)) return 'approval_required';
    if (/超时|timed?\s*out|timeout/i.test(message)) return 'timeout';
    return 'execution_failed';
  }

  _enqueue(profileId: string, task: () => Promise<void>, context?: { agentId?: string; turnId?: string; sourceMessageIds?: readonly string[]; attachmentCount?: number }): void {
    const previous = this._queues.get(profileId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      console.error(`[HermesCli] queue_start agent=${context?.agentId || '-'} turn=${context?.turnId || '-'} profile=${profileId} messages=${context?.sourceMessageIds?.length || 1} attachments=${context?.attachmentCount || 0}`);
      await task();
      console.error(`[HermesCli] queue_finish agent=${context?.agentId || '-'} turn=${context?.turnId || '-'} profile=${profileId}`);
    }).catch((error: unknown) => {
      const kind = this._failureKind(error);
      const labels = { approval_required: '等待工具授权', auth_required: '认证失效', timeout: '执行超时', execution_failed: '执行失败' };
      console.error(`[HermesCli] ${labels[kind]} profile=${profileId}: ${errorMessage(error)}`);
      this.emit('delivery.error', { provider: 'hermes-cli', profileId, kind, error: errorMessage(error),
        ...((error as any)?.code ? { errorCode: String((error as any).code) } : {}),
        agentId: context?.agentId, turnId: context?.turnId, sourceMessageIds: context?.sourceMessageIds });
    }).finally(() => {
      if (this._queues.get(profileId) === current) this._queues.delete(profileId);
    });
    this._queues.set(profileId, current);
  }

  async waitForIdle(profileId?: string): Promise<void> {
    if (profileId) await (this._queues.get(profileId) || Promise.resolve());
    else await Promise.all(Array.from(this._queues.values()));
  }

  async push(payload: PushPayload): Promise<{
    accepted: true;
    queued: true;
    nativeSessionId: string;
    providerInstanceId: string;
    deliveryMode: 'cli';
    adapterType: 'hermes-cli';
  }> {
    const profileId = this._instanceForAgent(payload.agentId);
    if (!profileId) {
      const error = new Error('Hermes CLI unavailable: agent is not bound to a Hermes profile');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    if ((payload as any).executionScope === 'a2a_mailbox') {
      const error = new Error('Hermes CLI cannot restore an exact native A2A session');
      (error as any).deliveryOutcome = 'not_delivered';
      (error as any).code = 'PROVIDER_EXACT_SESSION_UNAVAILABLE';
      throw error;
    }
    const turnId = String(payload.turnId || payload.messageId || '');
    this._enqueue(profileId, () => this._runPush(payload), { agentId: payload.agentId, turnId,
      sourceMessageIds: payload.sourceMessageIds, attachmentCount: payload.attachments?.length || 0 });
    console.error(`[HermesCli] 已进入后台队列 agent=${payload.agentId} profile=${profileId}`);
    return {
      accepted: true,
      queued: true,
      nativeSessionId: `hermes:${payload.agentId}:${String((payload as any).sessionScopeId || payload.fromUid)}`,
      providerInstanceId: profileId,
      deliveryMode: 'cli',
      adapterType: 'hermes-cli',
    };
  }

  async _runPush(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `hermes-cli-${Date.now()}`);
    const profileId = this._instanceForAgent(agentId);
    if (!profileId) throw new Error('Hermes CLI unavailable: agent is not bound to a Hermes profile');
    // `hermes -z` has no native-session argument. Keep the binding only as a
    // correlation label and restore bounded VOKO history on every CLI turn.
    const hasBindingLabel = payload.providerBinding?.providerType === 'hermes'
      && payload.providerBinding.providerInstanceId === profileId
      && /^hermes:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionIdentity = String((payload as any).sessionScopeId || fromUid);
    const sessionKey = hasBindingLabel
      ? payload.providerBinding!.nativeSessionId
      : `hermes:${agentId}:${sessionIdentity}`;
    const staged = stageProviderAttachments(payload, { cwd: os.tmpdir(), agentId, turnId });
    const effectivePayload = staged.attachments.length ? { ...payload, attachments: staged.attachments } : payload;
    const deliveryContent = appendProviderAttachmentBoundary(buildConversationDeliveryPrompt(
      this._db, effectivePayload, false, this._contextWindow,
    ), effectivePayload);
    const notification = _buildNotification(agentId, fromUid, deliveryContent);
    // Windows 下 -z 经 cmd.exe 传多行/含元字符的 notification 会被截断或注入，净化为单行
    const safeNotification = process.platform === 'win32' ? sanitizeCmdArg(notification) : notification;
    console.error(`[HermesCli] push agent=${agentId} visitor=${fromUid} session=selected`);

    let approvalPending = false;
    const observe = (line: string) => { if (/pending[_ ]approval|approval.*(?:pending|required)/i.test(line)) approvalPending = true; };
    try {
      const policy = payload.providerSecurityPolicy?.transportId === 'hermes-cli'
        ? payload.providerSecurityPolicy.config
        : { toolProfile: 'default', safeMode: 'disabled', approvalMode: 'required', acceptHooks: 'disabled' };
      const args = ['--profile', profileId, 'chat', '-q', safeNotification, '-Q', '--source', 'tool'];
      if (policy?.toolProfile === 'safe') args.push('--toolsets', 'safe');
      if (policy?.safeMode !== 'disabled') args.push('--safe-mode');
      if (policy?.approvalMode === 'bypass') args.push('--yolo');
      if (policy?.acceptHooks === 'enabled') args.push('--accept-hooks');
      const result = await this._runCli({
        cmd: this._command,
        args,
        tag: 'hermes-cli',
        timeout: 120000,
        env: hermesChildEnv(),
        envUnset: HERMES_GENERIC_CREDENTIAL_ENV,
        logOutput: false,
        onStdoutLine: observe,
        onStderrLine: observe,
      });

      if (result.code === 0) {
        const replyText = _extractReply(result.stdout);
        if (replyText && _isUpstreamAuthErrorReply(replyText)) {
          const error: any = new Error('Hermes authentication required');
          error.code = 'PROVIDER_AUTH_REQUIRED';
          throw error;
        }
        if (replyText && !_isUpstreamErrorReply(replyText)) {
          this.emit('agent.reply', {
            agentId, visitorId: fromUid,
            content: replyText, done: true,
            sessionKey,
            turnId, replyId: turnId,
          });
          console.error(`[HermesCli] push OK agent=${agentId} reply=${replyText.length}chars`);
        } else {
          throw new Error('Hermes returned no reply text');
        }
      } else {
        const detail = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (approvalPending || /pending[_ ]approval|approval.*(?:pending|required)/i.test(detail)) {
          throw new Error('Hermes pending approval');
        }
        throw new Error(`Hermes exited with code ${result.code}`);
      }
    } catch (err) {
      if (/ENOENT|not found/i.test(errorMessage(err))) {
        this._available = false;
        this.notifyAvailability({ backendType: 'hermes', mode: 'cli', agentId, available: false, reason: 'cli-not-found' });
      }
      if (approvalPending) throw new Error('Hermes pending approval');
      throw err;
    } finally {
      staged.cleanup();
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: ProviderSteerMetadata): Promise<{ queued: true }> {
    const profileId = this._instanceForAgent(agentId);
    if (!profileId) {
      const error = new Error('Hermes CLI unavailable: agent is not bound to a Hermes profile');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    this._enqueue(profileId, () => this._runSteer(agentId, visitorId, content, metadata));
    console.error(`[HermesCli] steer 已进入后台队列 agent=${agentId} profile=${profileId}`);
    return { queued: true };
  }

  async _runSteer(agentId: string, visitorId: string, content: string, metadata?: ProviderSteerMetadata): Promise<void> {
    const profileId = this._instanceForAgent(agentId);
    if (!profileId) throw new Error('Hermes CLI unavailable: agent is not bound to a Hermes profile');
    const sessionKey = metadata?.providerBinding?.providerType === 'hermes'
      && metadata.providerBinding.providerInstanceId === profileId
      ? metadata.providerBinding.nativeSessionId
      : `hermes:${agentId}:${visitorId}`;
    const turnId = String(metadata?.turnId || `hermes-cli-steer-${Date.now()}`);
    console.error(`[HermesCli] steer agent=${agentId} visitor=${visitorId}`);
    const notification = JSON.stringify({
      type: 'voko_owner_message',
      visitorId,
      sessionKey,
      content,
      safety: '此消息来自主人（可信任）。请按主人要求执行。',
    });
    let approvalPending = false;
    const observe = (line: string) => { if (/pending[_ ]approval|approval.*(?:pending|required)/i.test(line)) approvalPending = true; };
    try {
      const result = await this._runCli({
        cmd: this._command,
        args: ['--profile', profileId, '-z', notification],
        tag: 'hermes-cli',
        timeout: 120000,
        env: hermesChildEnv(),
        envUnset: HERMES_GENERIC_CREDENTIAL_ENV,
        logOutput: false,
        onStdoutLine: observe,
        onStderrLine: observe,
      });
      const replyText = _extractReply(result.stdout);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.error(`[HermesCli] steer OK agent=${agentId} reply=${replyText.length}chars`);
      } else {
        console.error(`[HermesCli] steer OK agent=${agentId}`);
      }
    } catch (err) {
      if (approvalPending) throw new Error('Hermes pending approval');
      throw err;
    }
  }

  async runLoopbackTest(agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    }
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CHALLENGE_INVALID' };
    }
    const profileId = this._instanceForAgent(agentId);
    if (!profileId) {
      return { ok: false, status: 'configuration_required', code: 'HERMES_PROFILE_REQUIRED' };
    }
    const result = await this._runCli({
      cmd: this._command,
      args: ['--profile', profileId, '-z', `VOKO local loopback test. Do not use tools. Reply with exactly: ${challenge}`],
      tag: 'hermes-cli-loopback',
      timeout: 120000,
      env: hermesChildEnv(),
      envUnset: HERMES_GENERIC_CREDENTIAL_ENV,
      logOutput: false,
    });
    const reply = _extractReply(result.stdout) || '';
    const matched = result.code === 0 && reply.includes(challenge);
    return {
      ok: matched,
      status: matched ? 'loopback_verified' : 'failed',
      challengeMatched: matched,
      detail: matched ? 'Hermes CLI loopback verified' : 'Hermes did not return the expected challenge',
    };
  }

  start() { this._refreshAvailability(); }
  stop() {
    if (this._available === true) this.notifyAvailability({ backendType: 'hermes', mode: 'cli', available: false, reason: 'provider-stopped' });
    this._available = false;
  }
  healthCheck() { this._refreshAvailability(); }

  _refreshAvailability() {
    const previous = this._available;
    this._available = checkCliAvailable(this._command);
    if (previous !== this._available) this.notifyAvailability({ backendType: 'hermes', mode: 'cli', available: this._available, reason: this._available ? 'cli-detected' : 'cli-not-found' });
  }
}

/**
 * 从 hermes CLI stdout 提取 agent 回复文本。
 * Hermes 的 stdout 可能包含日志头，取第一个非空的正文段落作为回复。
 */
function _extractReply(stdout: string): string | null {
  if (!stdout) return null;
  const lines = stdout.split('\n').map((line: string) => line.trim()).filter(Boolean);
  // 跳过明显的日志/元数据行
  const contentLines = lines.filter((line: string) =>
    !line.startsWith('[') &&
    !line.startsWith('{') &&
    !line.startsWith('收到') &&
    !line.startsWith('---') &&
    line.length > 2
  );
  if (contentLines.length > 0) return contentLines.join('\n').trim();
  // 兜底：取全部非空行的前 500 字
  return lines.join('\n').trim().slice(0, 500);
}

function _isUpstreamErrorReply(reply: string): boolean {
  return /^(?:http\s+[45]\d{2}\b|(?:authentication|authorization)\s+(?:error|required|failed)|(?:invalid|missing)\s+(?:api[ _-]?key|authentication))/i.test(reply.trim());
}

function _isUpstreamAuthErrorReply(reply: string): boolean {
  return /(?:http\s+401\b|missing\s+authentication\s+header|authentication\s+(?:required|failed|error)|unauthori[sz]ed|invalid\s+(?:api[ _-]?key|authentication))/i
    .test(reply.trim());
}

function _buildNotification(
  agentId: string,
  fromUid: string,
  content: string,
): string {
  let msg = `【访客消息】\n访客：${fromUid}\n消息：${content}`;
  msg += `\n\n当前 session: hermes:${agentId}:${fromUid}`;

  return msg;
}

module.exports = HermesCliProvider;
