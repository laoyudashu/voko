import { execFileSync } from 'node:child_process';
import type { DatabaseLike } from '../types/database';

export type SandboxPlatform = 'win32' | 'linux' | 'darwin';
export type SandboxSupport = 'enforced' | 'supported_not_enabled' | 'unsupported' | 'unknown' | 'not_applicable';
export type SandboxVerification = 'static' | 'simulated' | 'windows_real' | 'linux_real' | 'macos_real';
export type SandboxFailurePolicy = 'required' | 'best_effort' | 'report_only';
export type ProviderVersionSource = 'command' | 'runtime' | 'protocol' | 'config' | 'unknown';
export type ProviderVersionState = 'unknown' | 'known_unverified' | 'verified';

/** Increment when the meaning of a sandbox policy or its dimensions changes. */
export const SANDBOX_POLICY_REVISION = 1;

export interface ProviderVersionProbe {
  version: string | null;
  source: ProviderVersionSource;
  observedAt: string;
  result: 'known' | 'unknown';
  errorCode?: 'not_found' | 'timeout' | 'failed' | 'invalid_version';
}

export interface ProviderSandboxDimensions {
  filesystem: 'blocked' | 'read_only' | 'workspace_scoped' | 'sandbox_scoped' | 'host_unrestricted' | 'unknown' | 'not_applicable';
  network: 'blocked' | 'allowlisted' | 'proxied' | 'unrestricted' | 'unknown' | 'not_applicable';
  commandExecution: 'disabled' | 'approval_required' | 'sandboxed' | 'unrestricted' | 'unknown' | 'not_applicable';
  workingDirectory: 'isolated_temp' | 'agent_workspace' | 'provider_managed' | 'container_workspace' | 'unknown' | 'not_applicable';
  humanApproval: 'denied' | 'interactive' | 'delegated' | 'unavailable' | 'unknown' | 'not_applicable';
}

export interface ProviderSandboxPolicy {
  id: string;
  platforms: SandboxPlatform[];
  support: SandboxSupport;
  failurePolicy: SandboxFailurePolicy;
  verification: SandboxVerification[];
  evidence: Array<'official_flag' | 'official_config' | 'protocol_enforcement' | 'os_sandbox' | 'voko_wrapper' | 'inherited_provider'>;
  dimensions: ProviderSandboxDimensions;
  requiresRuntime?: 'docker_or_podman' | 'macos_seatbelt_or_container';
  reasonCode?: string;
}

function extractProviderVersion(output: string): string | null {
  // Keep only a semver-like token; never return the command output itself.
  const match = String(output || '').match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] || null;
}

/**
 * Read a Provider version without invoking a model or a shell. This is deliberately
 * bounded and returns only a normalized version/error code, never stdout/stderr.
 */
export function probeProviderVersion(command: string | null | undefined, options: {
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): ProviderVersionProbe {
  const observedAt = new Date().toISOString();
  const target = String(command || '').trim();
  if (!target || target.includes('\0')) {
    return { version: null, source: 'unknown', observedAt, result: 'unknown', errorCode: 'failed' };
  }
  try {
    const output = execFileSync(target, options.args || ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: Math.max(250, Math.min(Number(options.timeoutMs || 1500), 5000)),
      maxBuffer: 16 * 1024,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    const version = extractProviderVersion(String(output));
    return version
      ? { version, source: 'command', observedAt, result: 'known' }
      : { version: null, source: 'unknown', observedAt, result: 'unknown', errorCode: 'invalid_version' };
  } catch (error: any) {
    const timedOut = error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM';
    const notFound = error?.code === 'ENOENT';
    return {
      version: null,
      source: 'unknown',
      observedAt,
      result: 'unknown',
      errorCode: timedOut ? 'timeout' : notFound ? 'not_found' : 'failed',
    };
  }
}

export interface ProviderSandboxRollout {
  enabled: boolean;
  mode: 'observe' | 'enforce';
  providerFamilies: string[];
  transportIds: string[];
  platforms: SandboxPlatform[];
  killedByEnvironment: boolean;
}

const ALL_PLATFORMS: SandboxPlatform[] = ['win32', 'linux', 'darwin'];
const UNKNOWN: ProviderSandboxDimensions = {
  filesystem: 'unknown', network: 'unknown', commandExecution: 'unknown',
  workingDirectory: 'isolated_temp', humanApproval: 'unavailable',
};

const POLICIES: Record<string, ProviderSandboxPolicy> = {
  'cli-unverified': {
    id: 'cli-unverified', platforms: ALL_PLATFORMS, support: 'unknown', failurePolicy: 'report_only',
    verification: ['static'], evidence: ['inherited_provider'], dimensions: UNKNOWN,
    reasonCode: 'UNVERIFIED_CAPABILITY',
  },
  'acp-deny-permission': {
    id: 'acp-deny-permission', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['simulated'], evidence: ['protocol_enforcement'], dimensions: {
      ...UNKNOWN, humanApproval: 'denied', workingDirectory: 'isolated_temp',
    }, reasonCode: 'ACP_PROCESS_ISOLATION_UNKNOWN',
  },
  'provider-managed-local': {
    id: 'provider-managed-local', platforms: ALL_PLATFORMS, support: 'unknown', failurePolicy: 'report_only',
    verification: ['static'], evidence: ['inherited_provider'], dimensions: {
      ...UNKNOWN, workingDirectory: 'provider_managed',
    }, reasonCode: 'PROVIDER_MANAGED_PROCESS',
  },
  'codex-readonly': {
    id: 'codex-readonly', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'read_only', network: 'blocked', commandExecution: 'sandboxed',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    },
  },
  'claude-plan-no-tools': {
    id: 'claude-plan-no-tools', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'blocked', network: 'blocked', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    },
  },
  'qwen-plan-no-tools': {
    id: 'qwen-plan-no-tools', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'blocked', network: 'blocked', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    },
  },
  'pi-no-tools': {
    id: 'pi-no-tools', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'blocked', network: 'blocked', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    },
  },
  'aider-dry-run': {
    id: 'aider-dry-run', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'read_only', network: 'unknown', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'unavailable',
    }, reasonCode: 'NETWORK_POLICY_NOT_VERIFIED',
  },
  'cursor-plan': {
    id: 'cursor-plan', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'read_only', network: 'unknown', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    }, reasonCode: 'NETWORK_POLICY_NOT_VERIFIED',
  },
  'grok-plan-no-tools': {
    id: 'grok-plan-no-tools', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'blocked', network: 'blocked', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    },
  },
  'cline-command-deny': {
    id: 'cline-command-deny', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['simulated'], evidence: ['official_config'], dimensions: {
      filesystem: 'unknown', network: 'unknown', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    }, reasonCode: 'FILESYSTEM_AND_NETWORK_UNKNOWN',
  },
  'copilot-restricted': {
    id: 'copilot-restricted', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag'], dimensions: {
      filesystem: 'read_only', network: 'unknown', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    }, reasonCode: 'NETWORK_POLICY_NOT_VERIFIED',
  },
  'openhands-wrapper': {
    id: 'openhands-wrapper', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'best_effort',
    verification: ['linux_real', 'simulated'], evidence: ['voko_wrapper'], dimensions: {
      filesystem: 'blocked', network: 'unknown', commandExecution: 'disabled',
      workingDirectory: 'isolated_temp', humanApproval: 'denied',
    }, reasonCode: 'NOT_OS_SANDBOX',
  },
  'gemini-container': {
    id: 'gemini-container', platforms: ALL_PLATFORMS, support: 'enforced', failurePolicy: 'required',
    verification: ['windows_real', 'linux_real', 'static'], evidence: ['official_flag', 'os_sandbox'],
    requiresRuntime: 'docker_or_podman', dimensions: {
      filesystem: 'sandbox_scoped', network: 'unrestricted', commandExecution: 'sandboxed',
      workingDirectory: 'container_workspace', humanApproval: 'denied',
    }, reasonCode: 'NETWORK_UNRESTRICTED',
  },
};

export function getProviderSandboxPolicy(policyId: string | null | undefined, platform: NodeJS.Platform = process.platform): ProviderSandboxPolicy | null {
  const policy = POLICIES[String(policyId || '')];
  if (!policy || !policy.platforms.includes(platform as SandboxPlatform)) return null;
  return { ...policy, platforms: [...policy.platforms], verification: [...policy.verification],
    evidence: [...policy.evidence], dimensions: { ...policy.dimensions } };
}

function cleanList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

export function getProviderSandboxRollout(db?: Pick<DatabaseLike, 'prepare'> | null, env: NodeJS.ProcessEnv = process.env): ProviderSandboxRollout {
  if (/^(0|false|no|off)$/i.test(String(env.VOKO_PROVIDER_SANDBOX || ''))) {
    return { enabled: false, mode: 'observe', providerFamilies: [], transportIds: [], platforms: [], killedByEnvironment: true };
  }
  let parsed: any = null;
  try {
    const row = db?.prepare('SELECT data FROM config WHERE type=? LIMIT 1').get('feature:provider_sandbox_rollout_v1') as { data?: string } | undefined;
    if (row?.data) parsed = JSON.parse(row.data);
  } catch (_) {}
  return {
    enabled: parsed?.enabled === true,
    mode: parsed?.mode === 'enforce' ? 'enforce' : 'observe',
    providerFamilies: cleanList(parsed?.providerFamilies),
    transportIds: cleanList(parsed?.transportIds),
    platforms: cleanList(parsed?.platforms).filter(item => ALL_PLATFORMS.includes(item as SandboxPlatform)) as SandboxPlatform[],
    killedByEnvironment: false,
  };
}

export function evaluateProviderSandbox(input: {
  db?: Pick<DatabaseLike, 'prepare'> | null;
  providerFamily: string;
  transportId: string;
  policyId?: string | null;
  platform?: NodeJS.Platform;
  providerVersion?: string | null;
  providerVersionSource?: ProviderVersionSource;
  providerVersionObservedAt?: string | null;
  providerVersionProbe?: Pick<ProviderVersionProbe, 'result' | 'errorCode'> | null;
  providerVersionVerified?: boolean;
  runtimeAvailable?: boolean | null;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const platform = input.platform || process.platform;
  const policy = getProviderSandboxPolicy(input.policyId, platform);
  const rollout = getProviderSandboxRollout(input.db, input.env);
  const versionState: ProviderVersionState = input.providerVersion && input.providerVersionVerified === true
    ? 'verified' : input.providerVersion ? 'known_unverified' : 'unknown';
  if (!policy) return { provider: input.providerFamily, transport: input.transportId, platform,
    policyId: input.policyId || null, effective: false, status: 'unknown', degradedReason: 'POLICY_NOT_DEFINED',
    safetyProfile: { id: input.policyId || null, revision: SANDBOX_POLICY_REVISION,
      providerVersion: input.providerVersion || null, versionSource: input.providerVersionSource || 'unknown',
      observedAt: input.providerVersionObservedAt || null, versionVerified: versionState === 'verified',
      probe: input.providerVersionProbe ? { ...input.providerVersionProbe } : null },
    versionState };
  const selected = rollout.enabled
    && (!rollout.providerFamilies.length || rollout.providerFamilies.includes(input.providerFamily))
    && (!rollout.transportIds.length || rollout.transportIds.includes(input.transportId))
    && (!rollout.platforms.length || rollout.platforms.includes(platform as SandboxPlatform));
  const runtimeMissing = policy.requiresRuntime && input.runtimeAvailable === false;
  const runtimeUnchecked = policy.requiresRuntime && input.runtimeAvailable == null;
  const baseline = policy.support === 'enforced';
  const effective = baseline && !runtimeMissing && !runtimeUnchecked;
  let status = effective
    ? (policy.reasonCode ? 'partially_enforced' : 'verified_and_enforced')
    : policy.support === 'unknown' ? 'legacy_unchanged' : 'supported_not_enabled';
  let degradedReason = policy.reasonCode || null;
  if (rollout.killedByEnvironment) status = baseline ? 'legacy_enforced_kill_switch' : 'legacy_unchanged';
  else if (runtimeMissing) { status = 'sandbox_runtime_missing'; degradedReason = 'SANDBOX_RUNTIME_UNAVAILABLE'; }
  else if (runtimeUnchecked) { status = 'sandbox_runtime_unchecked'; degradedReason = 'SANDBOX_RUNTIME_NOT_PROBED'; }
  else if (selected && rollout.mode === 'observe') status = effective
    ? (policy.reasonCode ? 'partially_enforced' : 'verified_and_enforced') : 'would_apply';
  else if (selected && rollout.mode === 'enforce' && !effective) status = 'legacy_unchanged';
  // The flags may be present, but without the actual Provider version we cannot
  // claim that this exact binary honors the tested parameters.
  if (effective && versionState !== 'verified' && !policy.reasonCode && status === 'verified_and_enforced') {
    status = 'provider_version_unverified';
    degradedReason = versionState === 'unknown' ? 'PROVIDER_VERSION_UNKNOWN' : 'PROVIDER_VERSION_NOT_VERIFIED';
  }
  return {
    provider: input.providerFamily, transport: input.transportId, platform,
    providerVersion: input.providerVersion || null,
    providerVersionSource: input.providerVersion ? (input.providerVersionSource || 'command') : 'unknown',
    providerVersionObservedAt: input.providerVersionObservedAt || null,
    versionState,
    safetyProfile: { id: policy.id, revision: SANDBOX_POLICY_REVISION,
      providerVersion: input.providerVersion || null,
      versionSource: input.providerVersion ? (input.providerVersionSource || 'command') : 'unknown',
      observedAt: input.providerVersionObservedAt || null, versionVerified: versionState === 'verified',
      probe: input.providerVersionProbe ? { ...input.providerVersionProbe } : null },
    providerVersionProbe: input.providerVersionProbe ? { ...input.providerVersionProbe } : null,
    rolloutMode: rollout.enabled ? rollout.mode : 'off', rolloutSelected: selected,
    policyId: policy.id, effective, status, support: policy.support, failurePolicy: policy.failurePolicy,
    coverage: policy.reasonCode ? 'partial' : effective ? 'full' : 'unknown',
    dimensions: { ...policy.dimensions }, verification: [...policy.verification], evidence: [...policy.evidence],
    degradedReason, restartRequired: false,
  };
}

export function listProviderSandboxPolicies(): ProviderSandboxPolicy[] {
  return Object.values(POLICIES).map(policy => ({ ...policy, platforms: [...policy.platforms],
    verification: [...policy.verification], evidence: [...policy.evidence], dimensions: { ...policy.dimensions } }));
}

module.exports = { getProviderSandboxPolicy, getProviderSandboxRollout, evaluateProviderSandbox,
  listProviderSandboxPolicies, probeProviderVersion, SANDBOX_POLICY_REVISION };
