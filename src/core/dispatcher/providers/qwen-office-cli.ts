const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const { runCli } = require('../../adapters/cli-spawner');
const { createParser } = require('../../adapters/cli-parsers');
const { withRuntimePath } = require('../../runtime/agent-runtime-resolver');
const { resolveQwenOfficeCommand, qwenOfficeRuntimeRequest, getQwenOfficeReadiness, refreshQwenOfficeReadiness,
  invalidateQwenOfficeReadiness } = require('../qwen-office-command');
const { resolveQwenOfficeAgentTarget } = require('../qwen-office-agents');
import type { CliProviderOptions } from '../../adapters/cli-adapter';
import type { ProviderDeliveryReceipt, PushPayload } from '../types';
import type { QwenOfficeAgentTarget } from '../qwen-office-agents';

type ResolveAgentTarget = (id: unknown) => QwenOfficeAgentTarget | null;
type QwenOfficeCliProviderOptions = CliProviderOptions & {
  binPath?: string;
  resolveAgentTarget?: ResolveAgentTarget;
};

function deliveryError(message: string): Error {
  const error: any = new Error(message);
  error.deliveryOutcome = 'not_delivered';
  return error;
}

function classifyQwenOfficeDeliveryFailure(detail: unknown): { code: string; verificationStatus: string } {
  const text = String(detail || '').toLowerCase();
  if (/credit usage limit|quota|insufficient credits|额度|配额|资源包.*不足/.test(text)) {
    return { code: 'QWEN_OFFICE_QUOTA_EXHAUSTED', verificationStatus: 'quota_exhausted' };
  }
  if (/timed?\s*out|timeout|etimedout|超时/.test(text)) {
    return { code: 'QWEN_OFFICE_TIMEOUT', verificationStatus: 'timeout' };
  }
  if (/not logged in|unauthorized|authentication|login required|未登录|登录.*失效/.test(text)) {
    return { code: 'QWEN_OFFICE_LOGIN_FAILED', verificationStatus: 'login_failed' };
  }
  return { code: 'QWEN_OFFICE_DELIVERY_FAILED', verificationStatus: 'failed' };
}

/**
 * QwenWork's bundled qoderclicn stream-json transport.  Tool access and
 * permission prompts stay disabled for unattended VOKO messages.
 */
class QwenOfficeCliProvider extends CliAdapter {
  private readonly _resolveAgentTarget: ResolveAgentTarget;
  private readonly _verification = new Map<string, { status: string; code: string; detail: string; verifiedAt?: number }>();

  constructor(options: QwenOfficeCliProviderOptions = {}) {
    const configuredCommand = String(options.binPath || '').trim();
    const command = configuredCommand || resolveQwenOfficeCommand();
    const resolveAgentTarget = options.resolveAgentTarget || resolveQwenOfficeAgentTarget;
    const baseArgs = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-mode', 'dont_ask',
      '--tools', '',
    ];
    super({
      name: 'QWEN OFFICE CLI',
      cmd: command,
      runtimeRequest: qwenOfficeRuntimeRequest('cli', process.env, process.platform, command),
      args: baseArgs,
      parser: 'gemini-stream-json',
      matchType: 'qwen-office',
      priority: 1,
      timeout: 180000,
      adapterType: 'qwen-office-cli',
      bindingProviderType: 'qwen-office',
      instanceArgs: (instanceId: string) => {
        const target = resolveAgentTarget(instanceId);
        return { args: target ? ['--cwd', target.workspaceRoot, '--plugin-dir', target.pluginRoot] : [], position: 'before' };
      },
      argsForSession: (sessionId: string | null) => [
        ...baseArgs,
        ...(sessionId ? ['--resume', sessionId] : []),
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          const id = event?.session_id || event?.sessionId;
          return typeof id === 'string' && id.trim() ? id : null;
        } catch { return null; }
      },
      preparePrompt: (prompt: string, context: { configuredArgs: string[]; payload: PushPayload }) => ({
        args: context.payload.providerSecurityPolicy?.config.sessionPersistence === 'ephemeral'
          ? [...context.configuredArgs.filter((_value, index, all) => all[index - 1] !== '--resume' && _value !== '--resume'), '--no-session-persistence']
          : [...context.configuredArgs],
        useStdin: true,
        stdinInput: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        }),
      }),
      env: { NO_COLOR: '1' },
      promptTemplate: '这是来自 VOKO 的外部访客消息。只允许安全的文字回复，不得执行工具、修改文件或运行命令。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
      sessionPersistence: options.sessionPersistence,
    });
    this._resolveAgentTarget = resolveAgentTarget;
  }

  acceptsBinding(binding: any, agentId = ''): boolean {
    const configuredInstance = this._instanceForAgent(agentId) || '';
    const boundInstance = String(binding?.providerInstanceId || '').trim();
    return binding?.providerType === 'qwen-office'
      && binding.adapterType === 'qwen-office-cli'
      && binding.deliveryMode === 'cli'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0
      && boundInstance === configuredInstance;
  }

  isAvailable(agentId: string): boolean {
    if (!super.isAvailable(agentId)) return false;
    if (!getQwenOfficeReadiness(this._cmd).ready) return false;
    const instanceId = this._instanceForAgent(agentId);
    return !instanceId || !!this._resolveAgentTarget(instanceId);
  }

  getDeliveryReadiness(agentId = ''): Record<string, unknown> {
    const readiness = getQwenOfficeReadiness(this._cmd);
    const verification = this._verification.get(String(agentId || ''));
    const automaticReady = readiness.ready && verification?.status === 'loopback_verified';
    return {
      ready: readiness.ready,
      automaticReady,
      installed: readiness.executable,
      authenticationStatus: readiness.loggedIn ? 'verified' : 'unverified',
      reason: readiness.reason,
      verificationStatus: verification?.status || 'unverified',
      ...(verification?.code ? { verificationCode: verification.code } : {}),
      ...(verification?.verifiedAt ? { verifiedAt: verification.verifiedAt } : {}),
      ...(verification?.detail ? { verificationDetail: verification.detail } : {}),
      ...(readiness.exitCode !== undefined ? { exitCode: readiness.exitCode } : {}),
      ...(readiness.detail ? { detail: readiness.detail } : {}),
      ...(readiness.attempts !== undefined ? { attempts: readiness.attempts } : {}),
    };
  }

  getSecurityControlEvidence(agentId = ''): Record<string, unknown> {
    const observed = (this as any).getProviderVersion?.();
    return { transportId: 'qwen-office-cli', platform: process.platform, runtimeVersion: observed?.version || null,
      versionVerified: Boolean(observed?.version && observed?.result === 'known'), versionSource: observed?.source || 'unknown',
      contract: 'cli_args_empty_tools_and_session_persistence',
      readiness: this.getDeliveryReadiness(agentId) };
  }

  refreshRuntime(): void {
    super.refreshRuntime();
    invalidateQwenOfficeReadiness(this._cmd);
  }

  async refreshDeliveryReadiness(): Promise<Record<string, unknown>> {
    return refreshQwenOfficeReadiness(this._cmd);
  }

  async preflightDelivery(agentId: string): Promise<Record<string, unknown>> {
    await refreshQwenOfficeReadiness(this._cmd);
    const base = await super.preflightDelivery(agentId);
    if (base.ok !== true) return base;
    const instanceId = this._instanceForAgent(agentId);
    if (instanceId && !this._resolveAgentTarget(instanceId)) {
      return { ok: false, status: 'unavailable', sideEffects: false, code: 'QWEN_OFFICE_EXPERT_KIT_UNAVAILABLE' };
    }
    return { ...base, ...(instanceId ? { providerInstanceId: instanceId, routing: 'cwd+plugin-dir' } : {}) };
  }

  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    if (!binding || !this.acceptsBinding(binding, agentId)) return false;
    const instanceId = this._instanceForAgent(agentId);
    if (instanceId && !this._resolveAgentTarget(instanceId)) return false;
    return super.canRestoreExactSession(binding, agentId);
  }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    const readiness = await refreshQwenOfficeReadiness(this._cmd);
    if (!readiness.ready) throw deliveryError(readiness.detail || readiness.reason);
    const instanceId = this._instanceForAgent(payload.agentId) || '';
    const boundInstance = String(payload.providerBinding?.providerInstanceId || '').trim();
    if (boundInstance && boundInstance !== instanceId) {
      throw deliveryError('QwenWork expert-kit binding is stale');
    }
    if (instanceId && !this._resolveAgentTarget(instanceId)) {
      throw deliveryError('Bound QwenWork expert kit is unavailable');
    }
    try {
      const effectivePayload = payload.providerSecurityPolicy?.config.sessionPersistence === 'ephemeral'
        ? { ...payload, providerBinding: null } : payload;
      const receipt = await super.push(effectivePayload);
      this._verification.set(payload.agentId, {
        status: 'loopback_verified', code: 'QWEN_OFFICE_DELIVERY_VERIFIED', detail: 'QwenWork CLI delivery verified', verifiedAt: Date.now(),
      });
      return receipt;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || '');
      const classified = classifyQwenOfficeDeliveryFailure(detail);
      this._verification.set(payload.agentId, { status: classified.verificationStatus, code: classified.code, detail });
      if (error && typeof error === 'object') (error as { code?: string }).code = classified.code;
      throw error;
    }
  }

  async runLoopbackTest(_agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    }
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CHALLENGE_INVALID' };
    }
    const runtime = this._resolveRuntime();
    if (!runtime.available || !runtime.executable) {
      return { ok: false, status: 'unavailable', code: 'QWEN_OFFICE_CLI_UNAVAILABLE', detail: runtime.reason || 'QwenWork CLI is unavailable' };
    }
    const instanceId = this._instanceForAgent(_agentId);
    const target = instanceId ? this._resolveAgentTarget(instanceId) : null;
    if (instanceId && !target) {
      return { ok: false, status: 'unavailable', code: 'QWEN_OFFICE_EXPERT_KIT_UNAVAILABLE' };
    }

    let reply = '';
    const parser = createParser({
      format: 'gemini-stream-json',
      onText: (text: string) => { reply += text; },
      onDone: () => {},
    });
    const prompt = `VOKO local loopback test. Do not use tools. Reply with exactly: ${challenge}`;
    const result = await runCli({
      cmd: runtime.executable,
      args: [
        ...runtime.argvPrefix,
        ...(target ? ['--cwd', target.workspaceRoot, '--plugin-dir', target.pluginRoot] : []),
        ...this._args,
      ],
      stdinInput: JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }),
      cwd: target?.workspaceRoot || this._cwd || os.tmpdir(),
      env: withRuntimePath({ ...this._env }, runtime),
      tag: 'qwen-office-cli-loopback',
      timeout: 120000,
      logOutput: false,
      onStdoutLine: (line: string) => parser.handleLine(line),
    });
    parser.finish();
    const matched = result.code === 0 && reply.trim() === challenge;
    const rawDetail = result.stderr.trim() || reply.trim() || 'QwenWork CLI did not return the expected challenge';
    const failure = classifyQwenOfficeDeliveryFailure(rawDetail);
    const classified = matched
      ? { code: 'QWEN_OFFICE_LOOPBACK_VERIFIED', verificationStatus: 'loopback_verified' }
      : (failure.code !== 'QWEN_OFFICE_DELIVERY_FAILED' ? failure
        : result.code === 0 && reply.trim() ? { code: 'QWEN_OFFICE_REPLY_PARSE_FAILED', verificationStatus: 'parse_failed' }
          : failure);
    this._verification.set(String(_agentId || ''), {
      status: classified.verificationStatus,
      code: classified.code,
      detail: matched ? 'QwenWork CLI loopback verified' : rawDetail,
      ...(matched ? { verifiedAt: Date.now() } : {}),
    });
    if (!matched) console.warn(`[QwenOfficeDelivery] code=${classified.code} detail=${rawDetail.slice(0, 300)}`);
    return {
      ok: matched,
      status: matched ? 'loopback_verified' : 'failed',
      challengeMatched: matched,
      code: classified.code,
      detail: matched
        ? 'QwenWork CLI loopback verified'
        : rawDetail,
    };
  }
}

module.exports = { QwenOfficeCliProvider, classifyQwenOfficeDeliveryFailure };
