import crypto from 'node:crypto';
import fs from 'node:fs';
import { getProviderSecurityControls } from './provider-security-policy';

export const PROVIDER_CAPABILITY_ADAPTER_REVISION = 3;
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
  nodeVersion?: string | null;
  versionSource?: string | null;
  callCompatibility?: string | null;
  securityVerification?: string | null;
  securityDiagnostic?: { stage: string; exitCode: number | null; message: string; timedOut: boolean } | null;
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
  'hermes-cli': 'hermes', 'hermes-http': 'hermes', 'claude-cli': 'claude-code',
  'codex-cli': 'codex', 'qwen-cli': 'qwen-code',
  'opencode-acp': 'opencode', 'opencode-attach': 'opencode', 'opencode-cli': 'opencode',
  'grok-cli': 'grok', 'aider-cli': 'aider', 'goose-cli': 'goose', 'goose-acp': 'goose',
  'workbuddy-http': 'workbuddy', 'qwen-office-cli': 'qwen-office', 'dumate-http': 'dumate',
  'zeroclaw-ws': 'zeroclaw', 'zeroclaw-acp': 'zeroclaw', 'zeroclaw-cli': 'zeroclaw',
  'openclaw-ws': 'openclaw', 'openclaw-cli': 'openclaw',
  'github-copilot-acp': 'github-copilot', 'github-copilot-cli': 'github-copilot',
  'cursor-acp': 'cursor', 'cursor-cli': 'cursor', 'cline-acp': 'cline', 'cline-cli': 'cline',
  'codebuddy-acp': 'codebuddy', 'traecli-acp': 'codebuddy', 'kiro-cli': 'kiro',
  'gemini-cli': 'gemini', 'pi-cli': 'pi', 'reasonix-cli': 'reasonix',
  'deepseek-harness-http': 'deepseek-harness', 'deepseek-harness-cli': 'deepseek-harness',
};
const DYNAMIC_CAPABILITY_TRANSPORTS = new Set(Object.keys(FAMILY));

export function isDynamicCapabilityTransport(transportId: string): boolean {
  return DYNAMIC_CAPABILITY_TRANSPORTS.has(transportId);
}
const VERIFIED_RUNTIME_RULES: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  'hermes-cli': { darwin: ['0.20.2'], linux: ['0.20.4'] },
  'claude-cli': { darwin: ['2.1.234'], linux: ['2.1.237', '2.1.259'], win32: ['2.1.235'] },
  'qwen-cli': { darwin: ['0.21.13'], linux: ['0.22.3'], win32: ['0.21.14'] },
  'goose-cli': { darwin: ['1.46.0'], linux: ['1.46.0'], win32: ['1.46.0'] },
  'opencode-cli': { darwin: ['1.18.18'], linux: ['1.18.18'], win32: ['1.18.18'] },
  'opencode-acp': { darwin: ['1.18.18'], linux: ['1.18.18'], win32: ['1.18.18'] },
  'workbuddy-http': { darwin: ['2.139.0'], win32: ['2.141.0'] },
  'qwen-office-cli': { win32: ['1.0.47','1.1.18'], darwin: ['1.1.18', '1.1.32'] },
  'dumate-http': {},
  'reasonix-cli': { darwin: ['1.27.0'], linux: ['1.29.0'], win32: ['1.29.0'] },
  'grok-cli': { darwin: ['1.0.5'], linux: ['1.0.13'], win32: ['1.0.5'] },
  'aider-cli': { darwin: ['0.86.2'], linux: ['0.86.2'], win32: ['0.86.2'] },
  'cline-cli': { win32: ['3.0.60'] },
  'cursor-cli': { win32: ['2026.08.31-4057e58'] },
  'gemini-cli': { darwin: ['0.55.1'], win32: ['0.57.0'] },
  'kiro-cli': { darwin: ['2.20.1'] },
  'github-copilot-cli': { darwin: ['1.0.80'], linux: ['1.0.80'], win32: ['1.0.80'] },
  'github-copilot-acp': { darwin: ['1.0.80'], linux: ['1.0.80'], win32: ['1.0.80'] },
  'codebuddy-acp': { darwin: ['2.139.0'], win32: ['2.141.0'] },
};

// Native controls are exposed only where this adapter revision has a tested
// invocation mapping. Delivery readiness alone proves that a message round-trip
// works; it does not make every control definition valid for that transport.
const VERIFIED_NATIVE_CONTROLS: Record<string, string[]> = {
  'pi-cli': ['executionMode'],
  'reasonix-cli': ['executionMode'],
  'grok-cli': ['executionMode'],
  'aider-cli': ['executionMode'],
  'cline-cli': ['executionMode'],
  'cursor-cli': ['executionMode'],
  'gemini-cli': ['executionMode'],
  'kiro-cli': ['executionMode'],
  'github-copilot-cli': ['executionMode'],
  'github-copilot-acp': ['executionMode'],
  'codebuddy-acp': ['executionMode'],
  'traecli-acp': ['executionMode'],
  'hermes-cli': ['toolProfile', 'safeMode', 'approvalMode', 'acceptHooks'],
  'claude-cli': ['toolAccess', 'browser', 'permissionMode', 'customizations'],
  'codex-cli': ['sandboxMode'],
  'qwen-cli': ['executionMode'],
  'goose-cli': ['extensionProfile'],
  'opencode-cli': ['executionMode', 'pluginMode', 'approvalMode'],
  'opencode-acp': ['executionMode', 'pluginMode', 'permissionCallback'],
  'opencode-attach': ['loopbackServer'],
  'workbuddy-http': ['dataFileAccess', 'permissionMode', 'sessionPersistence', 'mcpProfile'],
  'qwen-office-cli': ['sessionPersistence', 'permissionMode', 'toolAccess', 'mcpProfile'],
  'dumate-http': ['sessionPersistence', 'isolatedDataRoot', 'loopbackOnly'],
};

export function hasNativeCapabilityControls(transportId: string): boolean {
  return (VERIFIED_NATIVE_CONTROLS[transportId] || []).length > 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function runtimeIdentity(provider: any, transportId: string, agentId: string): { fingerprint: string; available: boolean } {
  let runtime: any = null;
  try { runtime = provider?._resolveRuntime?.(agentId) || null; } catch (_) {}
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
  const raw = `${runtime?.fingerprint || ''}\0${transportId}\0${executable}\0${statIdentity}\0${prefixStats.join('\0')}\0${process.platform}\0${process.arch}`;
  return { fingerprint: digest(raw), available: runtime?.available !== false
    && Boolean(executable || provider?.isAvailable?.(agentId)) };
}

function boundaryFor(transportId: string, controlId: string): 'enforced' | 'not_enforced' | 'unknown' {
  if (transportId === 'workbuddy-http' && controlId === 'dataFileAccess') return 'not_enforced';
  if (transportId === 'dumate-http' && ['sessionPersistence', 'additionalPrompt', 'isolatedDataRoot', 'loopbackOnly'].includes(controlId)) return 'enforced';
  if (controlId === 'additionalPrompt') return 'enforced';
  return 'unknown';
}

export function snapshotFromProvider(provider: any, transportId: string, agentId: string): ProviderCapabilitySnapshot {
  const now = Date.now();
  const identity = runtimeIdentity(provider, transportId, agentId);
  let evidence: any = null;
  try { evidence = provider?.getSecurityControlEvidence?.(agentId) || null; } catch (_) {}
  if (!evidence) evidence = {};
  if (transportId !== 'codex-cli' && (!evidence.runtimeVersion || !evidence.frameworkVersion)) {
    try {
      const version = provider?.getProviderVersion?.() || null;
      if (!evidence.runtimeVersion && version?.version) evidence.runtimeVersion = version.version;
      if (!evidence.frameworkVersion && version?.version) evidence.frameworkVersion = version.version;
      if (!evidence.versionSource && version?.source) evidence.versionSource = version.source;
    } catch (_) {}
  }
  if (!evidence.readiness) {
    try { evidence.readiness = provider?.getDeliveryReadiness?.(agentId) || null; } catch (_) {}
  }
  const runtimeVersion = String(evidence?.runtimeVersion || '').trim() || null;
  const frameworkVersion = String(evidence?.frameworkVersion || '').trim() || null;
  const definitions = getProviderSecurityControls(transportId);
  const readinessVerified = evidence?.readiness?.verificationStatus === 'loopback_verified';
  const versionRuleMatched = Boolean(process.arch === 'arm64' && runtimeVersion
    && VERIFIED_RUNTIME_RULES[transportId]?.[process.platform]?.includes(runtimeVersion));
  const explicitControlEvidence = evidence?.controlEvidence && typeof evidence.controlEvidence === 'object'
    ? evidence.controlEvidence : {};
  const verifiedNativeControls = new Set(VERIFIED_NATIVE_CONTROLS[transportId] || []);
  const codexContractVerified = transportId === 'codex-cli'
    && evidence.callCompatibility === 'parameters_checked' && Boolean(explicitControlEvidence.sandboxMode);
  const codexProbeFailed = transportId === 'codex-cli' && evidence.securityVerification
    && evidence.securityVerification !== 'CODEX_RUNTIME_NOT_PROBED' && !codexContractVerified;
  const supportedControls: ProviderCapabilitySnapshot['supportedControls'] = Object.fromEntries(definitions
    .filter(item => item.enforcement !== 'unsupported'
      && (item.enforcement === 'voko_enforced'
        || (verifiedNativeControls.has(item.id) && (versionRuleMatched || explicitControlEvidence[item.id]))))
    .map(item => [item.id, {
    values: (item.values || []).map(value => value.value), enforcement: item.enforcement,
    boundary: boundaryFor(transportId, item.id),
    evidence: explicitControlEvidence[item.id] ? 'real_test' as const
      : item.enforcement === 'voko_enforced' || transportId === 'dumate-http'
        ? 'protocol_verified' as const : 'static_documented' as const,
  }]));
  if (codexProbeFailed && runtimeVersion && identity.available) {
    // Omitting VOKO's sandbox override does not require a working restrictive
    // sandbox. Offer only that explicit choice; do not certify the failed modes.
    supportedControls.sandboxMode = { values: ['native'], enforcement: 'voko_enforced',
      boundary: 'not_enforced', evidence: 'protocol_verified' };
  }
  const evidenceState: ProviderCapabilityEvidenceState = identity.available
    ? codexProbeFailed ? 'failed' : readinessVerified ? 'verified'
      : versionRuleMatched || codexContractVerified ? 'static_compatible' : 'unknown' : 'failed';
  const matchedRuleId = versionRuleMatched && runtimeVersion
    ? `${transportId}-${process.platform}-${runtimeVersion}-r${PROVIDER_CAPABILITY_ADAPTER_REVISION}`
    : codexContractVerified ? `codex-cli-sandbox-canary-v1-${process.platform}` : null;
  const base = {
    providerFamily: FAMILY[transportId] || transportId, transportId, platform: process.platform, arch: process.arch,
    frameworkVersion, runtimeVersion, runtimeFingerprint: identity.fingerprint,
    ...{
      nodeVersion: evidence.nodeVersion || null, versionSource: evidence.versionSource || null,
      callCompatibility: evidence.callCompatibility || 'unverified',
    },
    ...(transportId === 'codex-cli' ? { securityVerification: evidence.securityVerification || 'CODEX_RUNTIME_NOT_PROBED',
      securityDiagnostic: evidence.securityDiagnostic || null } : {}),
    protocolVersion: evidence.protocolVersion ? String(evidence.protocolVersion) : null, matchedRuleId, adapterRevision: PROVIDER_CAPABILITY_ADAPTER_REVISION,
    evidenceState, supportedControls, observedAt: now, expiresAt: now + PROVIDER_CAPABILITY_TTL_MS,
  };
  const { observedAt, expiresAt, securityDiagnostic, ...semantic } = base;
  return { ...base, capabilityDigest: digest(semantic) };
}

export interface RedactedInvocationSegment {
  text: string;
  risk: 'low'|'medium'|'high';
  changed?: boolean;
  change?: 'added'|'removed'|'unchanged';
  sourceControl?: string;
  enforcement?: 'voko_enforced'|'provider_enforced'|'unsupported';
}

export function redactedInvocation(transportId: string, config: Record<string, string>): RedactedInvocationSegment[] {
  if (Object.prototype.hasOwnProperty.call(config, 'executionMode') && !transportId.startsWith('opencode-')) return [
    { text: transportId, risk: 'low' },
    { text: config.executionMode === 'native' ? '遵循 Provider 原生配置；不追加 VOKO 限制或自动批准参数' : '使用该传输的默认原生限制参数',
      risk: config.executionMode === 'native' ? 'high' : 'low', sourceControl: 'executionMode', enforcement: 'provider_enforced' },
  ];
  if (transportId === 'workbuddy-http') return [
    { text: `codebuddy --serve --host 127.0.0.1 --permission-mode ${config.permissionMode || 'dontAsk'}`, risk: config.permissionMode === 'bypassPermissions' ? 'high' : 'medium' },
    ...(['read_write', 'default'].includes(config.dataFileAccess)
      ? [{ text: config.dataFileAccess === 'default' ? '--tools default' : '--tools Read,Write,Edit', risk: 'high' as const }]
      : config.dataFileAccess === 'read'
      ? [{ text: '--tools Read', risk: 'high' as const }, { text: '--allowedTools Read(<绑定文件>)（仅自动审批，非路径隔离）', risk: 'high' as const }]
      : [{ text: '--tools <空列表>', risk: 'low' as const }]),
    ...(config.sessionPersistence === 'ephemeral' ? [{ text: '--no-session-persistence', risk: 'low' as const }] : []),
    { text: config.mcpProfile === 'user' ? '加载用户 MCP 配置' : '--strict-mcp-config', risk: config.mcpProfile === 'user' ? 'high' : 'low' },
  ];
  if (transportId === 'qwen-office-cli') return [
    { text: 'qoderclicn --print --permission-mode', risk: 'low' },
    { text: config.permissionMode || 'dont_ask', risk: config.permissionMode === 'bypass_permissions' ? 'high' : 'low',
      sourceControl: 'permissionMode' },
    { text: config.toolAccess === 'default' ? '--tools default' : config.toolAccess === 'read_only' ? '--tools Read,Grep,Glob' : '--tools <空列表>',
      risk: config.toolAccess === 'default' ? 'high' : config.toolAccess === 'read_only' ? 'medium' : 'low',
      sourceControl: 'toolAccess' },
  ];
  if (transportId === 'dumate-http') return [
    { text: 'POST /session/<sessionId>/prompt_async', risk: 'low' },
    { text: config.sessionPersistence === 'ephemeral' ? '每条消息新建 Session' : '复用当前访客 Session',
      risk: config.sessionPersistence === 'ephemeral' ? 'low' : 'medium' },
  ];
  if (transportId === 'hermes-cli') return [
    { text: 'hermes --profile <当前 Profile> chat -q <访客消息> -Q --source tool', risk: 'low' },
    ...(config.toolProfile === 'safe' ? [{ text: '--toolsets safe', risk: 'medium' as const, sourceControl: 'toolProfile', enforcement: 'provider_enforced' as const }] : []),
    ...(config.safeMode !== 'disabled' ? [{ text: '--safe-mode', risk: 'medium' as const, sourceControl: 'safeMode', enforcement: 'provider_enforced' as const }] : []),
    ...(config.approvalMode === 'bypass' ? [{ text: '--yolo', risk: 'high' as const, sourceControl: 'approvalMode', enforcement: 'provider_enforced' as const }] : []),
    ...(config.acceptHooks === 'enabled' ? [{ text: '--accept-hooks', risk: 'high' as const, sourceControl: 'acceptHooks', enforcement: 'provider_enforced' as const }] : []),
  ];
  if (transportId === 'claude-cli') return [
    { text: `claude -p <访客消息> --permission-mode ${config.permissionMode || 'plan'}`, risk: config.permissionMode === 'bypassPermissions' ? 'high' : 'low', sourceControl: 'permissionMode', enforcement: 'provider_enforced' },
    { text: config.customizations === 'default' ? '使用原生配置' : '--bare --safe-mode --strict-mcp-config --disable-slash-commands', risk: config.customizations === 'default' ? 'high' : 'low', sourceControl: 'customizations', enforcement: 'provider_enforced' },
    { text: config.toolAccess === 'default' ? '--tools default' : config.toolAccess === 'read_only' ? '--tools Read,Grep,Glob' : '--tools <空列表>', risk: config.toolAccess && config.toolAccess !== 'none' ? 'high' : 'low', sourceControl: 'toolAccess', enforcement: 'provider_enforced' },
    { text: config.browser === 'enabled' ? '--chrome' : '--no-chrome', risk: config.browser === 'enabled' ? 'high' : 'low', sourceControl: 'browser', enforcement: 'provider_enforced' },
  ];
  if (transportId === 'codex-cli') return [
    { text: 'codex --ask-for-approval never exec', risk: 'low' },
    { text: config.sandboxMode === 'native' ? '不追加 --sandbox，遵循原生配置' : config.sandboxMode === 'workspace_write' ? '--sandbox workspace-write' : '--sandbox read-only', risk: config.sandboxMode !== 'read_only' ? 'high' : 'medium', sourceControl: 'sandboxMode', enforcement: 'provider_enforced' },
  ];
  if (transportId === 'goose-cli') return [{ text: 'goose run', risk: 'low' },
    { text: config.extensionProfile === 'disabled' ? '--no-profile' : '<默认扩展>', risk: config.extensionProfile === 'disabled' ? 'low' : 'high', sourceControl: 'extensionProfile', enforcement: 'provider_enforced' }];
  if (transportId === 'opencode-cli') return [
    { text: config.executionMode === 'native' ? '使用原生工具权限配置' : 'OPENCODE_CONFIG_CONTENT: permission deny', risk: config.executionMode === 'native' ? 'high' : 'low', sourceControl: 'executionMode', enforcement: 'provider_enforced' },
    { text: 'opencode run --format json <访客消息>', risk: 'low' },
    ...(config.pluginMode === 'isolated' ? [{ text: '--pure', risk: 'low' as const, sourceControl: 'pluginMode', enforcement: 'provider_enforced' as const }] : []),
    ...(config.approvalMode === 'auto' ? [{ text: '--auto', risk: 'high' as const, sourceControl: 'approvalMode', enforcement: 'provider_enforced' as const }] : []),
  ];
  if (transportId === 'opencode-acp') return [
    { text: config.executionMode === 'native' ? '使用原生工具权限配置' : 'OPENCODE_CONFIG_CONTENT: permission deny', risk: config.executionMode === 'native' ? 'high' : 'low', sourceControl: 'executionMode', enforcement: 'provider_enforced' },
    { text: 'opencode acp', risk: 'low' },
    ...(config.pluginMode === 'isolated' ? [{ text: '--pure', risk: 'low' as const, sourceControl: 'pluginMode', enforcement: 'provider_enforced' as const }] : []),
    { text: 'ACP permission request -> denied', risk: 'low', sourceControl: 'permissionCallback', enforcement: 'voko_enforced' },
  ];
  if (transportId === 'opencode-attach') return [
    { text: 'POST http://127.0.0.1:<随机端口>/session/<id>/prompt_async', risk: 'low' },
    { text: 'Basic Auth <随机凭据>', risk: 'low', sourceControl: 'loopbackServer', enforcement: 'voko_enforced' },
  ];
  if (transportId === 'qwen-cli') return [{ text: 'qwen <访客消息>', risk: 'low' },
    { text: '工具执行预算：0', risk: 'low', sourceControl: 'tools', enforcement: 'provider_enforced' }];
  return [{ text: `${transportId} <访客消息>`, risk: 'low' },
    { text: '仅追加访客安全提示语；无已验证的原生权限参数', risk: 'medium', sourceControl: 'additionalPrompt', enforcement: 'voko_enforced' }];
}
