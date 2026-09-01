import crypto from 'node:crypto';
import fs from 'node:fs';
import { getProviderSecurityControls } from './provider-security-policy';

export const PROVIDER_CAPABILITY_ADAPTER_REVISION = 1;
export const PROVIDER_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export type ProviderCapabilityEvidenceState = 'verified' | 'static_compatible' | 'stale_verified'
  | 'changed_unverified' | 'unknown' | 'failed';

export interface ProviderCapabilitySnapshot {
  providerFamily: string;
  transportId: string;
  platform: NodeJS.Platform;
  arch: string;
  frameworkVersion: string | null;
  runtimeVersion: string | null;
  runtimeFingerprint: string;
  protocolVersion: string | null;
  matchedRuleId: string | null;
  adapterRevision: number;
  evidenceState: ProviderCapabilityEvidenceState;
  supportedControls: Record<string, {
    values: string[];
    enforcement: 'voko_enforced' | 'provider_enforced' | 'unsupported';
    boundary: 'enforced' | 'not_enforced' | 'unknown';
    evidence: 'real_test' | 'protocol_verified' | 'static_documented';
  }>;
  capabilityDigest: string;
  observedAt: number;
  expiresAt: number;
}

const FAMILY: Record<string, string> = {
  'workbuddy-http': 'workbuddy', 'qwen-office-cli': 'qwen-office', 'dumate-http': 'dumate',
};
const DYNAMIC_CAPABILITY_TRANSPORTS = new Set(Object.keys(FAMILY));

export function isDynamicCapabilityTransport(transportId: string): boolean {
  return DYNAMIC_CAPABILITY_TRANSPORTS.has(transportId);
}
const VERIFIED_RUNTIME_RULES: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  'workbuddy-http': { darwin: ['2.139.0'], win32: ['2.141.0'] },
  'qwen-office-cli': { win32: ['1.0.47','1.1.18'], darwin: ['1.1.18'] },
  'dumate-http': {},
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function runtimeIdentity(provider: any, transportId: string): { fingerprint: string; available: boolean } {
  let runtime: any = null;
  try { runtime = provider?._resolveRuntime?.() || null; } catch (_) {}
  const executable = String(runtime?.canonicalPath || runtime?.executable || provider?._cmd || '').trim();
  let statIdentity = '';
  if (executable) {
    try {
      const stat = fs.statSync(executable);
      statIdentity = `${stat.size}:${stat.mtimeMs}`;
    } catch (_) {}
  }
  const prefixes = Array.isArray(runtime?.argvPrefix) ? runtime.argvPrefix.map(String) : [];
  const prefixStats = prefixes.map((candidate: string) => {
    try { const stat = fs.statSync(candidate); return `${candidate}:${stat.size}:${stat.mtimeMs}`; } catch (_) { return candidate; }
  });
  const raw = runtime?.fingerprint || `${transportId}\0${executable}\0${statIdentity}\0${prefixStats.join('\0')}\0${process.platform}\0${process.arch}`;
  return { fingerprint: digest(raw), available: runtime?.available !== false && Boolean(executable || provider?.isAvailable?.('')) };
}

function boundaryFor(transportId: string, controlId: string): 'enforced' | 'not_enforced' | 'unknown' {
  if (transportId === 'workbuddy-http' && controlId === 'dataFileAccess') return 'not_enforced';
  if (transportId === 'dumate-http' && ['sessionPersistence', 'additionalPrompt', 'isolatedDataRoot', 'loopbackOnly'].includes(controlId)) return 'enforced';
  if (controlId === 'additionalPrompt') return 'enforced';
  return 'unknown';
}

export function snapshotFromProvider(provider: any, transportId: string, agentId: string): ProviderCapabilitySnapshot {
  const now = Date.now();
  const identity = runtimeIdentity(provider, transportId);
  let evidence: any = null;
  try { evidence = provider?.getSecurityControlEvidence?.(agentId) || null; } catch (_) {}
  const runtimeVersion = String(evidence?.runtimeVersion || '').trim() || null;
  const frameworkVersion = String(evidence?.frameworkVersion || '').trim() || null;
  const definitions = getProviderSecurityControls(transportId);
  const readinessVerified = evidence?.readiness?.verificationStatus === 'loopback_verified';
  const versionRuleMatched = Boolean(runtimeVersion
    && VERIFIED_RUNTIME_RULES[transportId]?.[process.platform]?.includes(runtimeVersion));
  const providerParametersVerified = readinessVerified || versionRuleMatched;
  const supportedControls: ProviderCapabilitySnapshot['supportedControls'] = Object.fromEntries(definitions
    .filter(item => item.enforcement !== 'unsupported'
      && (item.enforcement === 'voko_enforced' || providerParametersVerified))
    .map(item => [item.id, {
    values: (item.values || []).map(value => value.value), enforcement: item.enforcement,
    boundary: boundaryFor(transportId, item.id),
    evidence: transportId === 'dumate-http' ? 'protocol_verified' as const : 'static_documented' as const,
  }]));
  const evidenceState: ProviderCapabilityEvidenceState = identity.available
    ? readinessVerified ? 'verified' : versionRuleMatched ? 'static_compatible' : 'unknown' : 'failed';
  const matchedRuleId = versionRuleMatched && runtimeVersion
    ? `${transportId}-${process.platform}-${runtimeVersion}-r${PROVIDER_CAPABILITY_ADAPTER_REVISION}` : null;
  const base = {
    providerFamily: FAMILY[transportId] || transportId, transportId, platform: process.platform, arch: process.arch,
    frameworkVersion, runtimeVersion, runtimeFingerprint: identity.fingerprint,
    protocolVersion: null, matchedRuleId, adapterRevision: PROVIDER_CAPABILITY_ADAPTER_REVISION,
    evidenceState, supportedControls, observedAt: now, expiresAt: now + PROVIDER_CAPABILITY_TTL_MS,
  };
  return { ...base, capabilityDigest: digest(base) };
}

export function redactedInvocation(transportId: string, config: Record<string, string>): Array<{ text: string; risk: 'low'|'medium'|'high' }> {
  if (transportId === 'workbuddy-http') return [
    { text: 'codebuddy --serve --host 127.0.0.1 --permission-mode dontAsk', risk: 'medium' },
    ...(config.dataFileAccess === 'read'
      ? [{ text: '--tools Read', risk: 'high' as const }, { text: '--allowedTools Read(<绑定文件>)（仅自动审批，非路径隔离）', risk: 'high' as const }]
      : [{ text: '--tools <空列表>', risk: 'low' as const }]),
    ...(config.sessionPersistence === 'ephemeral' ? [{ text: '--no-session-persistence', risk: 'low' as const }] : []),
    { text: config.mcpProfile === 'user' ? '加载用户 MCP 配置' : '--strict-mcp-config', risk: config.mcpProfile === 'user' ? 'high' : 'low' },
  ];
  if (transportId === 'qwen-office-cli') return [
    { text: 'qoderclicn --print --permission-mode', risk: 'low' },
    { text: config.permissionMode || 'dont_ask', risk: config.permissionMode === 'bypass_permissions' ? 'high' : 'low' },
    { text: config.toolAccess === 'default' ? '--tools default' : config.toolAccess === 'read_only' ? '--tools Read,Grep,Glob' : '--tools <空列表>',
      risk: config.toolAccess === 'default' ? 'high' : config.toolAccess === 'read_only' ? 'medium' : 'low' },
  ];
  if (transportId === 'dumate-http') return [
    { text: 'POST /session/<sessionId>/prompt_async', risk: 'low' },
    { text: config.sessionPersistence === 'ephemeral' ? '每条消息新建 Session' : '复用当前访客 Session',
      risk: config.sessionPersistence === 'ephemeral' ? 'low' : 'medium' },
  ];
  return [];
}
