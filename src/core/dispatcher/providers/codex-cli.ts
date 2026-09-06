/**
 * codex-cli.js — OpenAI Codex CLI Provider
 *
 * 通过 codex exec 非交互模式发送消息，解析 NDJSON 流式回复。
 *
 * backend_type: 'codex'
 *
 * Codex CLI 参考：
 *   codex exec --json                  — NDJSON 事件流
 *   末尾的 - 表示从 stdin 读取 prompt
 *
 * 输出格式（NDJSON ThreadEvent）：
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';
import type { PushPayload } from '../types';
import type { CodexCompatibility } from '../codex-command';
import { inspectCodexRuntime, probeCodexCompatibility } from '../codex-command';
import { snapshotFromProvider } from '../../provider-capability';

class CodexCliProvider extends CliAdapter {
  private compatibility: { fingerprint: string; value: CodexCompatibility; expiresAt: number } | null = null;
  private compatibilityProbe: { fingerprint: string; promise: Promise<void> } | null = null;

  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CODEX CLI',
      cmd: 'codex',
      // Read-only limits writes; it still permits commands and broad host reads.
      args: ['--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
      adapterType: 'codex-cli',
      argsForSession: (sessionId: string | null) => sessionId
        ? ['--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '-']
        : ['--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
      instanceArgs: (instanceId: string) => ({ args: ['--profile', instanceId], position: 'before' }),
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          return String(event.thread_id || event.threadId || event.thread?.id || '').trim() || null;
        } catch (_) { return null; }
      },
      parser: 'codex-jsonl',
      matchType: 'codex',
      priority: 1,
      timeout: 300000,
      runtimeRequest: { providerId: 'codex-cli', mode: 'cli', candidates: [
        { kind: 'node-package-bin', command: 'codex', packageName: '@openai/codex', binName: 'codex' },
        { kind: 'native', command: 'codex' },
      ] },
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  _resolveRuntime(): any {
    // Follow PATH/symlink upgrades immediately, including same-version replacements.
    this._runtimeResolver.invalidate(this._runtimeRequest);
    return inspectCodexRuntime(super._resolveRuntime());
  }

  getSecurityControlEvidence(): any {
    const runtime = this._resolveRuntime();
    const cached = this.compatibility;
    const current = cached && cached.fingerprint === runtime.fingerprint
      && cached.expiresAt > Date.now() ? cached.value : null;
    return { runtimeVersion: current?.runtimeVersion || null, frameworkVersion: current?.runtimeVersion || null,
      versionSource: 'resolved_cli', nodeVersion: runtime.runtimeKind === 'node-script' ? process.version : null,
      callCompatibility: current?.callCompatibility || 'unverified',
      securityVerification: current?.reason || 'CODEX_RUNTIME_NOT_PROBED',
      controlEvidence: current?.sandboxVerified ? { sandboxMode: { testKind: 'isolated_sandbox_canary' } } : {} };
  }

  getProviderVersion(): any {
    const evidence = this.getSecurityControlEvidence();
    return { version: evidence.runtimeVersion, source: 'resolved_cli',
      result: evidence.runtimeVersion ? 'known' : 'unknown' };
  }

  async refreshSecurityControlEvidence(_agentId = '', options = { force: true }): Promise<void> {
    const runtime = this._resolveRuntime();
    const cached = this.compatibility;
    if (!options.force && cached?.fingerprint === runtime.fingerprint && cached && cached.expiresAt > Date.now()) return;
    const pending = this.compatibilityProbe;
    if (pending && pending.fingerprint === runtime.fingerprint) return pending.promise;
    const promise = (async () => {
      const value = await probeCodexCompatibility(runtime);
      if (this._resolveRuntime().fingerprint !== runtime.fingerprint) return;
      this.compatibility = { fingerprint: runtime.fingerprint, value,
        expiresAt: Date.now() + (value.sandboxVerified ? 24 * 60 * 60 * 1000 : 30_000) };
    })();
    this.compatibilityProbe = { fingerprint: runtime.fingerprint, promise };
    try { await promise; }
    finally { if (this.compatibilityProbe?.promise === promise) this.compatibilityProbe = null; }
  }

  async push(payload: PushPayload): Promise<any> {
    let evidence = this.getSecurityControlEvidence();
    if (evidence.securityVerification === 'CODEX_RUNTIME_NOT_PROBED') {
      await this.refreshSecurityControlEvidence();
      evidence = this.getSecurityControlEvidence();
    }
    if (!evidence.controlEvidence.sandboxMode) throw Object.assign(new Error(evidence.securityVerification),
      { code: evidence.securityVerification, deliveryOutcome: 'not_delivered' });
    const expected = payload.providerSecurityPolicy?.runtimeFingerprint;
    if (expected && expected !== snapshotFromProvider(this, 'codex-cli', payload.agentId).runtimeFingerprint) {
      throw Object.assign(new Error('Codex runtime changed after policy resolution'),
        { code: 'PROVIDER_CAPABILITY_CONFLICT', deliveryOutcome: 'not_delivered' });
    }
    payload.assertSubmissionCurrent?.();
    return super.push(payload);
  }
}

module.exports = { CodexCliProvider };
